import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createFridayDeepLinkApplyService } from "../../../../src/api/runtime/friday-deep-link-apply-service.js";
import { createFridayMcpConfigStore } from "../../../../src/agent/mcp/friday-mcp-config-store.js";
import { isForbiddenEnvVar, isSecretShapedEnvKey } from "../../../../src/agent/mcp/friday-mcp-adapter.js";
import {
  createFridayMutatingActionGate,
  signFridayCanonicalApproval,
  type FridayMutatingActionGate,
  type FridayMutatingActionRequest,
} from "../../../../src/security/friday-mutating-action-gate.js";
import type { FridayDeepLinkPayload } from "../../../../src/deeplink/friday-deeplink-types.js";
import type { FridayDeepLinkApplyOptions } from "../../../../src/api/runtime/friday-deep-link-apply-service.js";
import type { FridayProviderService } from "#providers";
import type { FridayWorkflowCrudService, FridayWorkflowBuilderImportExportService } from "#workflows";

const NOW = "2026-05-14T00:00:00.000Z";
const TOKEN_SECRET = "test-secret"; // pragma: allowlist secret

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `friday-mcp-apply-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function makeProviderService(): FridayProviderService {
  return {
    listProviders: vi.fn(async () => []),
    getProvider: vi.fn(async () => null),
    createProvider: vi.fn(async () => ({} as never)),
    updateProvider: vi.fn(async () => ({} as never)),
    deleteProvider: vi.fn(async () => undefined),
    validateProvider: vi.fn(async () => ({} as never)),
    getRoutingConfig: vi.fn(async () => ({ defaultProviderId: "", fallbackProviderIds: [] })),
    setRoutingConfig: vi.fn(async () => ({ defaultProviderId: "", fallbackProviderIds: [] })),
    runWithFallback: vi.fn(async () => ({ result: null, route: null, attempts: [] } as never)),
    resolveRoute: vi.fn(async () => null),
    recordUsage: vi.fn(async () => undefined),
    getProviderDoctorReport: vi.fn(async () => ({} as never)),
    getProviderUsageSummary: vi.fn(async () => ({} as never)),
    getProviderRoutingExplainReport: vi.fn(async () => ({} as never)),
    initiateAnthropicOAuth: vi.fn(async () => ({} as never)),
    completeAnthropicOAuthCallback: vi.fn(async () => ({} as never)),
    listAuthProfiles: vi.fn(async () => []),
    activateAuthProfile: vi.fn(async () => ({} as never)),
    getLlmBudgetConfig: vi.fn(async () => null),
    setLlmBudgetConfig: vi.fn(async () => ({} as never)),
    getLlmBudgetStatus: vi.fn(async () => ({} as never)),
    getProviderHealthSnapshot: vi.fn(async () => []),
    pinRoute: vi.fn(async () => undefined),
    clearRoutePenalty: vi.fn(async () => false),
    clearRoutePenaltyByProvider: vi.fn(async () => 0),
    clearRoutePenaltyForUser: vi.fn(async () => 0),
    clearProviderRoutePenalty: vi.fn(async () => false),
    listProviderTemplates: vi.fn(async () => []),
    getProviderTemplate: vi.fn(async () => null),
    detectProviders: vi.fn(async () => ({} as never)),
    initiateOpenAiCodexDeviceAuth: vi.fn(async () => ({} as never)),
    completeOpenAiCodexDeviceAuth: vi.fn(async () => ({} as never)),
  };
}

function makeWorkflowDeps() {
  return {
    workflowImportExport: { importBundle: vi.fn() } as unknown as Pick<FridayWorkflowBuilderImportExportService, "importBundle">,
    workflowCrud: {
      createWorkflow: vi.fn(() => ({ id: "wf-1" })),
      archiveWorkflow: vi.fn(),
    } as unknown as Pick<FridayWorkflowCrudService, "createWorkflow" | "archiveWorkflow">,
  };
}

function makeGate(): FridayMutatingActionGate {
  return createFridayMutatingActionGate({
    nowIso: () => NOW,
    ticketIdGenerator: () => "ticket-mcp-1",
    approvalSignatureSecret: TOKEN_SECRET,
    requireApprovalSignature: true,
  });
}

function makeMcpPayload(overrides: Partial<NonNullable<FridayDeepLinkPayload["mcpServer"]>> = {}): FridayDeepLinkPayload {
  return {
    version: 1,
    type: "mcp-server",
    label: "Test MCP Server",
    mcpServer: {
      name: "test-echo",
      transport: "stdio",
      command: "node",
      args: ["test/fixtures/mcp-echo-server.mjs"],
      ...overrides,
    },
  };
}

function createService(opts?: { stateDir?: string; gate?: FridayMutatingActionGate }) {
  const wfDeps = makeWorkflowDeps();
  return createFridayDeepLinkApplyService({
    idGenerator: () => "test-id-123",
    nowIso: () => NOW,
    providerService: makeProviderService(),
    ...wfDeps,
    mcpConfigStore: opts?.stateDir ? createFridayMcpConfigStore(opts.stateDir) : undefined,
    canonicalMutationGate: opts?.gate,
  });
}

function buildMcpInstallActionRequest(serverName: string): FridayMutatingActionRequest {
  const serverId = serverName.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "mcp-test-id-1";
  return {
    action: "mcp.deeplink.install_server",
    actor: { kind: "api", id: "api:deeplink", principalId: "api:deeplink" },
    surface: "api:/v1/deeplink/apply",
    resource: { type: "mcp_server_config", id: `mcp-server:${serverId}` },
    mutating: true,
    risk: "high",
    parameters: { transport: "stdio", serverName },
    localClaims: [{
      guardId: "mcp_install_lifecycle_guard",
      decision: "requires_approval",
      reason: "MCP server installation requires explicit approval before persisting configuration.",
    }],
  };
}

function signMcpApproval(gate: FridayMutatingActionGate, serverName: string) {
  const request = buildMcpInstallActionRequest(serverName);
  const preEval = gate.evaluate(request);
  return signFridayCanonicalApproval(
    {
      actionDigest: preEval.actionDigest,
      decision: "approved",
      decidedByPrincipalId: "user-1",
      approvalId: "mcp-approval-1",
      expiresAt: "2026-05-15T00:00:00.000Z",
    },
    TOKEN_SECRET,
  );
}

describe("isSecretShapedEnvKey", () => {
  it("rejects keys containing SECRET", () => {
    expect(isSecretShapedEnvKey("MY_SECRET_KEY")).toBe(true);
    expect(isSecretShapedEnvKey("secret_value")).toBe(true);
  });

  it("rejects keys containing TOKEN", () => {
    expect(isSecretShapedEnvKey("API_TOKEN")).toBe(true);
    expect(isSecretShapedEnvKey("access_token")).toBe(true);
  });

  it("rejects keys containing KEY", () => {
    expect(isSecretShapedEnvKey("API_KEY")).toBe(true);
    expect(isSecretShapedEnvKey("encryption_key")).toBe(true);
  });

  it("rejects keys containing PASSWORD", () => {
    expect(isSecretShapedEnvKey("DB_PASSWORD")).toBe(true);
  });

  it("rejects keys containing CREDENTIAL", () => {
    expect(isSecretShapedEnvKey("AWS_CREDENTIAL")).toBe(true);
  });

  it("accepts safe keys", () => {
    expect(isSecretShapedEnvKey("HOME")).toBe(false);
    expect(isSecretShapedEnvKey("PATH")).toBe(false);
    expect(isSecretShapedEnvKey("LANG")).toBe(false);
    expect(isSecretShapedEnvKey("MY_CONFIG")).toBe(false);
  });
});

describe("isForbiddenEnvVar", () => {
  it("rejects NODE_OPTIONS", () => {
    expect(isForbiddenEnvVar("NODE_OPTIONS")).toBe(true);
  });

  it("rejects LD_PRELOAD", () => {
    expect(isForbiddenEnvVar("LD_PRELOAD")).toBe(true);
  });

  it("rejects DYLD_ prefixed vars", () => {
    expect(isForbiddenEnvVar("DYLD_INSERT_LIBRARIES")).toBe(true);
  });

  it("accepts safe vars", () => {
    expect(isForbiddenEnvVar("HOME")).toBe(false);
    expect(isForbiddenEnvVar("PATH")).toBe(false);
  });
});

describe("MCP deeplink apply", () => {
  it("returns applied:false for sse transport", async () => {
    const service = createService({ stateDir: testDir, gate: makeGate() });
    const result = await service.apply(makeMcpPayload({ transport: "sse" }));
    expect(result.applied).toBe(false);
    expect(result.message).toContain("sse");
    expect(result.message).toContain("not supported");
  });

  it("returns applied:false for streamable-http transport", async () => {
    const service = createService({ stateDir: testDir, gate: makeGate() });
    const result = await service.apply(makeMcpPayload({ transport: "streamable-http" }));
    expect(result.applied).toBe(false);
    expect(result.message).toContain("streamable-http");
  });

  it("throws VALIDATION_FAILED when mcpServer is missing", async () => {
    const service = createService({ stateDir: testDir, gate: makeGate() });
    const payload: FridayDeepLinkPayload = {
      version: 1,
      type: "mcp-server",
      label: "No server data",
    };
    await expect(service.apply(payload)).rejects.toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });

  it("throws VALIDATION_FAILED when command is missing for stdio", async () => {
    const service = createService({ stateDir: testDir, gate: makeGate() });
    await expect(service.apply(makeMcpPayload({ command: undefined }))).rejects.toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });

  it("throws MCP_ENV_REJECTED for forbidden env vars", async () => {
    const service = createService({ stateDir: testDir, gate: makeGate() });
    await expect(
      service.apply(makeMcpPayload({ env: { NODE_OPTIONS: "--require evil" } })),
    ).rejects.toThrow(
      expect.objectContaining({ code: "MCP_ENV_REJECTED" }),
    );
  });

  it("throws MCP_ENV_REJECTED for secret-shaped env keys", async () => {
    const service = createService({ stateDir: testDir, gate: makeGate() });
    await expect(
      service.apply(makeMcpPayload({ env: { MY_SECRET_KEY: "value" } })),
    ).rejects.toThrow(
      expect.objectContaining({ code: "MCP_ENV_REJECTED" }),
    );
  });

  it("returns applied:false when mcpConfigStore is unavailable", async () => {
    const service = createService({ gate: makeGate() });
    const result = await service.apply(makeMcpPayload());
    expect(result.applied).toBe(false);
    expect(result.message).toContain("config store");
  });

  it("throws MCP_INSTALL_CANONICAL_GATE_UNAVAILABLE when gate is missing", async () => {
    const service = createService({ stateDir: testDir });
    await expect(service.apply(makeMcpPayload())).rejects.toThrow(
      expect.objectContaining({ code: "MCP_INSTALL_CANONICAL_GATE_UNAVAILABLE" }),
    );
  });

  it("throws CANONICAL_APPROVAL_REQUIRED when approval is not provided", async () => {
    const gate = makeGate();
    const service = createService({ stateDir: testDir, gate });
    await expect(service.apply(makeMcpPayload())).rejects.toThrow(
      expect.objectContaining({ code: "CANONICAL_APPROVAL_REQUIRED" }),
    );
  });

  it("persists config and returns applied:true with valid approval", async () => {
    const gate = makeGate();
    const service = createService({ stateDir: testDir, gate });
    const store = createFridayMcpConfigStore(testDir);
    const approval = signMcpApproval(gate, "test-echo");

    const result = await service.apply(makeMcpPayload(), { canonicalApproval: approval });
    expect(result.applied).toBe(true);
    expect(result.resourceType).toBe("mcp-server");
    expect(result.resourceId).toBeDefined();

    const persisted = store.load();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.id).toBe(result.resourceId);
    expect(persisted[0]!.transport).toBe("stdio");
    expect(persisted[0]!.command).toBe("node");
  });

  it("does not persist config when approval is missing", async () => {
    const gate = makeGate();
    const service = createService({ stateDir: testDir, gate });
    const store = createFridayMcpConfigStore(testDir);

    await expect(service.apply(makeMcpPayload())).rejects.toThrow(
      expect.objectContaining({ code: "CANONICAL_APPROVAL_REQUIRED" }),
    );
    expect(store.load()).toHaveLength(0);
  });

  it("does not persist secret-shaped env values", async () => {
    const gate = makeGate();
    const service = createService({ stateDir: testDir, gate });
    await expect(
      service.apply(makeMcpPayload({ env: { API_TOKEN: "secret123" } })),
    ).rejects.toThrow(
      expect.objectContaining({ code: "MCP_ENV_REJECTED" }),
    );

    const store = createFridayMcpConfigStore(testDir);
    expect(store.load()).toHaveLength(0);
  });

  it("accepts safe env vars in MCP config with valid approval", async () => {
    const gate = makeGate();
    const service = createService({ stateDir: testDir, gate });
    const approval = signMcpApproval(gate, "test-echo");

    const result = await service.apply(
      makeMcpPayload({ env: { MY_CONFIG: "safe-value" } }),
      { canonicalApproval: approval },
    );
    expect(result.applied).toBe(true);

    const store = createFridayMcpConfigStore(testDir);
    const persisted = store.load();
    expect(persisted[0]!.env).toEqual({ MY_CONFIG: "safe-value" });
  });

  it("sanitizes server id from name with valid approval", async () => {
    const gate = makeGate();
    const service = createService({ stateDir: testDir, gate });
    const approval = signMcpApproval(gate, "My Server! @#$");

    const result = await service.apply(
      makeMcpPayload({ name: "My Server! @#$" }),
      { canonicalApproval: approval },
    );
    expect(result.applied).toBe(true);
    expect(result.resourceId).toMatch(/^[a-z0-9._-]+$/);
  });

  it("includes doctor status in the result message", async () => {
    const gate = makeGate();
    const service = createService({ stateDir: testDir, gate });
    const approval = signMcpApproval(gate, "test-echo");

    const result = await service.apply(makeMcpPayload(), { canonicalApproval: approval });
    expect(result.applied).toBe(true);
    expect(result.message).toBeDefined();
    expect(typeof result.message).toBe("string");
  });
});
