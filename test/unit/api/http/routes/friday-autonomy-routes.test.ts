import { describe, expect, it, vi } from "vitest";

import { createFridayAutonomyRoutes } from "../../../../../src/api/http/routes/friday-autonomy-routes.js";
import {
  createFridaySkillLifecycleCanaryInputDigest,
  createFridaySkillLifecycleMutatingActionRequest,
} from "../../../../../src/autonomy/services/friday-skill-upgrade-lifecycle-service.js";
import {
  createFridayProviderProfileLifecycleMutatingActionRequest,
} from "../../../../../src/autonomy/services/friday-provider-profile-upgrade-lifecycle-service.js";
import {
  createFridayMcpServerLifecycleMutatingActionRequest,
} from "../../../../../src/autonomy/services/friday-mcp-server-upgrade-lifecycle-service.js";
import {
  createFridayPluginLifecycleMutatingActionRequest,
} from "../../../../../src/autonomy/services/friday-plugin-upgrade-lifecycle-service.js";
import {
  createFridayChannelAdapterLifecycleMutatingActionRequest,
} from "../../../../../src/autonomy/services/friday-channel-adapter-upgrade-lifecycle-service.js";
import {
  createFridayMutatingActionDigest,
  createFridayMutatingActionGate,
  type FridayCanonicalApprovalResolution,
} from "../../../../../src/security/friday-mutating-action-gate.js";

const principal = {
  principalType: "user" as const,
  principalId: "user-1",
  userId: "user-1",
  role: "admin" as const,
  scopes: ["hub.admin"] as const,
};
const PROVIDER_PLAN_DIGEST = "provider-plan-1";
const MCP_PLAN_DIGEST = "mcp-plan-1";
const PLUGIN_PLAN_DIGEST = "plugin-plan-1";
const CHANNEL_PLAN_DIGEST = "channel-plan-1";

function makeContext(body: Record<string, unknown>) {
  return {
    requestId: "req-1",
    receivedAt: "2026-05-07T18:00:00.000Z",
    params: { skillId: "skill-1" },
    query: {},
    body,
    headers: {},
    principal,
  };
}

function makeProviderContext(body: Record<string, unknown>) {
  return {
    requestId: "req-1",
    receivedAt: "2026-05-07T18:00:00.000Z",
    params: { providerId: "provider-1" },
    query: {},
    body,
    headers: {},
    principal,
  };
}

function makeMcpContext(body: Record<string, unknown>) {
  return {
    requestId: "req-1",
    receivedAt: "2026-05-07T18:00:00.000Z",
    params: { serverId: "mcp-1" },
    query: {},
    body,
    headers: {},
    principal,
  };
}

function makePluginContext(body: Record<string, unknown>) {
  return {
    requestId: "req-1",
    receivedAt: "2026-05-07T18:00:00.000Z",
    params: { pluginId: "plugin-1" },
    query: {},
    body,
    headers: {},
    principal,
  };
}

function makeChannelContext(body: Record<string, unknown>) {
  return {
    requestId: "req-1",
    receivedAt: "2026-05-07T18:00:00.000Z",
    params: { channelKind: "webchat" },
    query: {},
    body,
    headers: {},
    principal,
  };
}

function makeApproval(input: {
  action: "shadow" | "canary" | "promote" | "rollback";
  candidateId: string;
  runtimeVersion?: string;
  planDigest?: string;
  canaryInput?: Record<string, unknown>;
}): FridayCanonicalApprovalResolution {
  const rollback = input.action === "rollback"
    ? { planned: true, planDigest: input.planDigest, actions: ["skills.lifecycle.promote"] }
    : undefined;
  const request = createFridaySkillLifecycleMutatingActionRequest({
    action: input.action,
    skillId: "skill-1",
    candidateId: input.candidateId,
    shadowVersionId: input.candidateId,
    runtimeVersion: input.runtimeVersion ?? "runtime-v1",
    actor: {
      kind: "user",
      id: "user-1",
      principalId: "user-1",
    },
    surface: `api:/v1/autonomy/skills/${input.action}`,
    planDigest: input.planDigest,
    rollback,
    canaryInputDigest: input.action === "canary"
      ? createFridaySkillLifecycleCanaryInputDigest(input.canaryInput)
      : undefined,
  });
  return {
    decision: "approved",
    approvalId: `${input.action}-approval`,
    decidedByPrincipalId: "user-1",
    actionDigest: createFridayMutatingActionDigest(request),
    expiresAt: "2026-05-07T19:00:00.000Z",
  };
}

function makeProviderApproval(input: {
  action: "shadow" | "canary" | "promote" | "rollback";
  shadowVersionId?: string;
  runtimeVersion?: string;
  planDigest?: string;
}): FridayCanonicalApprovalResolution {
  const planDigest = input.planDigest ?? PROVIDER_PLAN_DIGEST;
  const request = createFridayProviderProfileLifecycleMutatingActionRequest({
    action: input.action,
    providerId: "provider-1",
    shadowVersionId: input.shadowVersionId ?? "provider-1@shadow",
    runtimeVersion: input.runtimeVersion ?? "runtime-v1",
    actor: {
      kind: "user",
      id: "user-1",
      principalId: "user-1",
    },
    surface: `api:/v1/autonomy/providers/${input.action}`,
    planDigest,
    rollback: input.action === "rollback"
      ? { planned: true, planDigest, actions: ["providers.lifecycle.promote"] }
      : undefined,
  });
  return {
    decision: "approved",
    approvalId: `provider-${input.action}-approval`,
    decidedByPrincipalId: "user-1",
    actionDigest: createFridayMutatingActionDigest(request),
    expiresAt: "2026-05-07T19:00:00.000Z",
  };
}

function makeMcpApproval(input: {
  action: "shadow" | "canary" | "promote" | "rollback";
  shadowVersionId?: string;
  runtimeVersion?: string;
  planDigest?: string;
}): FridayCanonicalApprovalResolution {
  const planDigest = input.planDigest ?? MCP_PLAN_DIGEST;
  const request = createFridayMcpServerLifecycleMutatingActionRequest({
    action: input.action,
    serverId: "mcp-1",
    shadowVersionId: input.shadowVersionId ?? "mcp-1@shadow",
    runtimeVersion: input.runtimeVersion ?? "runtime-v1",
    actor: {
      kind: "user",
      id: "user-1",
      principalId: "user-1",
    },
    surface: `api:/v1/autonomy/mcp-servers/${input.action}`,
    planDigest,
    rollback: input.action === "rollback"
      ? { planned: true, planDigest, actions: ["mcp_servers.lifecycle.promote"] }
      : undefined,
  });
  return {
    decision: "approved",
    approvalId: `mcp-${input.action}-approval`,
    decidedByPrincipalId: "user-1",
    actionDigest: createFridayMutatingActionDigest(request),
    expiresAt: "2026-05-07T19:00:00.000Z",
  };
}

function makePluginApproval(input: {
  action: "shadow" | "canary" | "promote" | "rollback";
  shadowVersionId?: string;
  runtimeVersion?: string;
  planDigest?: string;
}): FridayCanonicalApprovalResolution {
  const planDigest = input.planDigest ?? PLUGIN_PLAN_DIGEST;
  const request = createFridayPluginLifecycleMutatingActionRequest({
    action: input.action,
    pluginId: "plugin-1",
    shadowVersionId: input.shadowVersionId ?? "plugin-1@shadow",
    runtimeVersion: input.runtimeVersion ?? "runtime-v1",
    actor: {
      kind: "user",
      id: "user-1",
      principalId: "user-1",
    },
    surface: `api:/v1/autonomy/plugins/${input.action}`,
    planDigest,
    rollback: input.action === "rollback"
      ? { planned: true, planDigest, actions: ["plugins.lifecycle.promote"] }
      : undefined,
  });
  return {
    decision: "approved",
    approvalId: `plugin-${input.action}-approval`,
    decidedByPrincipalId: "user-1",
    actionDigest: createFridayMutatingActionDigest(request),
    expiresAt: "2026-05-07T19:00:00.000Z",
  };
}

function makeChannelApproval(input: {
  action: "shadow" | "canary" | "promote" | "rollback";
  shadowVersionId?: string;
  runtimeVersion?: string;
  planDigest?: string;
}): FridayCanonicalApprovalResolution {
  const planDigest = input.planDigest ?? CHANNEL_PLAN_DIGEST;
  const request = createFridayChannelAdapterLifecycleMutatingActionRequest({
    action: input.action,
    channelKind: "webchat",
    shadowVersionId: input.shadowVersionId ?? "webchat@shadow",
    runtimeVersion: input.runtimeVersion ?? "runtime-v1",
    actor: {
      kind: "user",
      id: "user-1",
      principalId: "user-1",
    },
    surface: `api:/v1/autonomy/channels/${input.action}`,
    planDigest,
    rollback: input.action === "rollback"
      ? { planned: true, planDigest, actions: ["channel_adapters.lifecycle.promote"] }
      : undefined,
  });
  return {
    decision: "approved",
    approvalId: `channel-${input.action}-approval`,
    decidedByPrincipalId: "user-1",
    actionDigest: createFridayMutatingActionDigest(request),
    expiresAt: "2026-05-07T19:00:00.000Z",
  };
}

function createRoutes() {
  const evidence = {
    candidateId: "candidate-1",
    events: [{ type: "shadow", at: "2026-05-07T18:00:00.000Z" }],
  };
  const registerShadow = vi.fn(async () => ({
    skillId: "skill-1",
    status: "not_installed",
    tags: [],
  }));
  const recordCanary = vi.fn(async () => ({
    skillId: "skill-1",
    status: "not_installed",
    tags: [],
  }));
  const routes = createFridayAutonomyRoutes({
    canonicalMutationGate: createFridayMutatingActionGate({
      nowIso: () => "2026-05-07T18:00:00.000Z",
      ticketIdGenerator: () => "ticket-1",
    }),
    listUpgradeStatus: () => ({ items: [] }),
    skillActions: {
      registerShadow,
      recordCanary,
      promote: vi.fn(async () => ({ skillId: "skill-1", status: "installed", tags: [] })),
      rollback: vi.fn(async () => ({ skillId: "skill-1", status: "not_installed", tags: [] })),
      getStatus: () => null,
      getEvidence: vi.fn(() => evidence),
    },
  });
  return { routes, registerShadow, recordCanary };
}

function createProviderRoutes() {
  const evidence = {
    providerId: "provider-1",
    stage: "shadow",
    canarySuccessCount: 0,
    canaryFailureCount: 0,
  };
  const registerShadow = vi.fn(async () => ({
    id: "provider-1",
    kind: "anthropic",
    name: "Anthropic",
    enabled: true,
    promotionChannel: "shadow",
    compatibilityStatus: "adaptation_required",
    shadowVersionId: "provider-1@shadow",
    config: { validation: { status: "ok" } },
  }));
  const recordCanary = vi.fn(async () => ({
    id: "provider-1",
    kind: "anthropic",
    name: "Anthropic",
    enabled: true,
    promotionChannel: "canary",
    compatibilityStatus: "compatible",
    shadowVersionId: "provider-1@shadow",
    config: { validation: { status: "ok" } },
    canaryStats: {
      sampleSize: 1,
      successCount: 1,
      failureCount: 0,
      rollbackCount: 0,
    },
  }));
  const routes = createFridayAutonomyRoutes({
    listUpgradeStatus: () => ({ items: [] }),
    providerProfileActions: {
      registerShadow,
      recordCanary,
      promote: vi.fn(async () => ({
        id: "provider-1",
        kind: "anthropic",
        name: "Anthropic",
        enabled: true,
        promotionChannel: "active",
        compatibilityStatus: "compatible",
        config: { validation: { status: "ok" } },
      })),
      rollback: vi.fn(async () => ({
        id: "provider-1",
        kind: "anthropic",
        name: "Anthropic",
        enabled: true,
        promotionChannel: "rolled_back",
        compatibilityStatus: "adaptation_required",
        config: { validation: { status: "ok" } },
      })),
      getStatus: () => null,
      getEvidence: vi.fn(() => evidence),
    },
  });
  return { routes, registerShadow, recordCanary };
}

function createMcpRoutes() {
  const evidence = {
    serverId: "mcp-1",
    stage: "shadow",
    canarySuccessCount: 0,
    canaryFailureCount: 0,
  };
  const registerShadow = vi.fn(async () => undefined);
  const recordCanary = vi.fn(async () => undefined);
  const routes = createFridayAutonomyRoutes({
    listUpgradeStatus: () => ({ items: [] }),
    mcpServerActions: {
      registerShadow,
      recordCanary,
      promote: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      getStatus: () => ({
        kind: "mcp_server",
        id: "mcp-1",
        displayName: "mcp-1",
        status: "configured",
        compatibilityStatus: "compatible",
        promotionChannel: "shadow",
        recordedCompatibilityStatus: "compatible",
        derivedCompatibilityStatus: "compatible",
        requiresAdaptation: false,
        statusDrift: false,
        findings: [],
        strategy: "noop",
        nextStage: "promoted",
        reasons: [],
      }),
      getEvidence: vi.fn(() => evidence),
    },
  });
  return { routes, registerShadow, recordCanary };
}

function createPluginRoutes() {
  const evidence = {
    pluginId: "plugin-1",
    stage: "shadow",
    canarySuccessCount: 0,
    canaryFailureCount: 0,
  };
  const registerShadow = vi.fn(async () => ({
    id: "plugin-1",
    name: "Plugin",
    description: "Plugin",
    version: "1.0.0",
    source: "local",
    status: "installed",
    enabled: false,
    trustMode: "trust_on_install",
    installPath: "/tmp/plugin",
    kinds: ["skill"],
    manifest: {
      schemaVersion: "1.0",
      id: "plugin-1",
      version: "1.0.0",
      name: "Plugin",
      description: "Plugin",
      kinds: ["skill"],
      entrypoints: { skill: "./dist/index.js" },
      permissions: { grants: [], promptOn: [] },
      compatibility: { minHubVersion: "0.1.0", apiVersion: "1" },
    },
    signatureAlgorithm: null,
    signatureKeyId: null,
    signatureValue: null,
    signatureVerified: true,
    trustedFingerprintSha256: "abc",
    promotionChannel: "shadow",
    compatibilityStatus: "adaptation_required",
    shadowVersionId: "plugin-1@shadow",
    installedAt: "2026-05-07T18:00:00.000Z",
    updatedAt: "2026-05-07T18:00:00.000Z",
    lastErrorCode: null,
    lastErrorMessage: null,
  }));
  const recordCanary = vi.fn(async () => ({
    ...(await registerShadow()),
    promotionChannel: "canary",
    compatibilityStatus: "compatible",
    canaryStats: {
      sampleSize: 1,
      successCount: 1,
      failureCount: 0,
      rollbackCount: 0,
    },
  }));
  const reviewEnable = vi.fn(async () => ({
    ...(await registerShadow()),
    status: "running",
    enabled: true,
    promotionChannel: "active",
    compatibilityStatus: "compatible",
  }));
  const routes = createFridayAutonomyRoutes({
    listUpgradeStatus: () => ({ items: [] }),
    pluginActions: {
      registerShadow,
      recordCanary,
      promote: vi.fn(async () => ({
        ...(await registerShadow()),
        status: "running",
        enabled: true,
        promotionChannel: "active",
        compatibilityStatus: "compatible",
      })),
      rollback: vi.fn(async () => ({
        ...(await registerShadow()),
        status: "installed",
        enabled: false,
        promotionChannel: "rolled_back",
        compatibilityStatus: "adaptation_required",
      })),
      reviewEnable,
      getStatus: () => null,
      getEvidence: vi.fn(() => evidence),
    },
  });
  return { routes, registerShadow, recordCanary, reviewEnable };
}

function createChannelRoutes() {
  const evidence = {
    channelKind: "webchat",
    stage: "shadow",
    canarySuccessCount: 0,
    canaryFailureCount: 0,
  };
  const registerShadow = vi.fn(async () => undefined);
  const recordCanary = vi.fn(async () => undefined);
  const routes = createFridayAutonomyRoutes({
    listUpgradeStatus: () => ({ items: [] }),
    channelAdapterActions: {
      registerShadow,
      recordCanary,
      promote: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      getStatus: () => ({
        kind: "channel_adapter",
        id: "webchat",
        displayName: "webchat",
        status: "connected",
        compatibilityStatus: "compatible",
        promotionChannel: "shadow",
        recordedCompatibilityStatus: "compatible",
        derivedCompatibilityStatus: "compatible",
        requiresAdaptation: false,
        statusDrift: false,
        findings: [],
        strategy: "noop",
        nextStage: "promoted",
        reasons: [],
        details: {
          running: true,
          credentialStatus: "unknown",
          authMode: "none",
        },
      }),
      getEvidence: vi.fn(() => evidence),
    },
  });
  return { routes, registerShadow, recordCanary };
}

describe("createFridayAutonomyRoutes skill lifecycle approval", () => {
  it("requires canonical approval before shadow can mutate", async () => {
    const { routes, registerShadow } = createRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.skills.shadow")!;

    await expect(route.handler(makeContext({
      candidateId: "candidate-1",
      runtimeVersion: "runtime-v1",
    }))).rejects.toMatchObject({ code: "CANONICAL_APPROVAL_REQUIRED" });

    expect(registerShadow).not.toHaveBeenCalled();
  });

  it("passes canonical approval metadata into the shadow action and returns persisted evidence", async () => {
    const { routes, registerShadow } = createRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.skills.shadow")!;

    const result = await route.handler(makeContext({
      candidateId: "candidate-1",
      runtimeVersion: "runtime-v1",
      canonicalApproval: makeApproval({ action: "shadow", candidateId: "candidate-1" }),
    }));

    expect(registerShadow).toHaveBeenCalledWith(expect.objectContaining({
      skillId: "skill-1",
      candidateId: "candidate-1",
      canonicalApproval: expect.objectContaining({ approvalId: "shadow-approval" }),
      actor: expect.objectContaining({ principalId: "user-1" }),
      surface: "api:/v1/autonomy/skills/shadow",
    }));
    expect(result).toHaveProperty("evidence.events.0.type", "shadow");
  });

  it("rejects caller-supplied skill canary success because canary proof must run internally", async () => {
    const { routes, recordCanary } = createRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.skills.canary")!;

    await expect(route.handler(makeContext({
      candidateId: "candidate-1",
      runtimeVersion: "runtime-v1",
      success: true,
      canonicalApproval: makeApproval({ action: "canary", candidateId: "candidate-1" }),
    }))).rejects.toMatchObject({ code: "SKILL_CANARY_RUNTIME_PROOF_REQUIRED" });

    expect(recordCanary).not.toHaveBeenCalled();
  });
});

describe("createFridayAutonomyRoutes provider lifecycle approval", () => {
  it("requires canonical approval before provider shadow can mutate", async () => {
    const { routes, registerShadow } = createProviderRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.providers.shadow")!;

    await expect(route.handler(makeProviderContext({
      shadowVersionId: "provider-1@shadow",
      runtimeVersion: "runtime-v1",
      planDigest: PROVIDER_PLAN_DIGEST,
    }))).rejects.toMatchObject({ code: "CANONICAL_APPROVAL_REQUIRED" });

    expect(registerShadow).not.toHaveBeenCalled();
  });

  it("passes canonical approval metadata into provider shadow and returns evidence", async () => {
    const { routes, registerShadow } = createProviderRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.providers.shadow")!;

    const result = await route.handler(makeProviderContext({
      shadowVersionId: "provider-1@shadow",
      runtimeVersion: "runtime-v1",
      planDigest: PROVIDER_PLAN_DIGEST,
      canonicalApproval: makeProviderApproval({ action: "shadow" }),
    }));

    expect(registerShadow).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "provider-1",
      shadowVersionId: "provider-1@shadow",
      canonicalApproval: expect.objectContaining({ approvalId: "provider-shadow-approval" }),
      actor: expect.objectContaining({ principalId: "user-1" }),
      surface: "api:/v1/autonomy/providers/shadow",
      planDigest: PROVIDER_PLAN_DIGEST,
    }));
    expect(result).toHaveProperty("evidence.stage", "shadow");
  });

  it("rejects caller-supplied provider canary success because validation must run internally", async () => {
    const { routes, recordCanary } = createProviderRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.providers.canary")!;

    await expect(route.handler(makeProviderContext({
      runtimeVersion: "runtime-v1",
      success: true,
      planDigest: PROVIDER_PLAN_DIGEST,
      canonicalApproval: makeProviderApproval({ action: "canary" }),
    }))).rejects.toMatchObject({ code: "PROVIDER_CANARY_RUNTIME_PROOF_REQUIRED" });

    expect(recordCanary).not.toHaveBeenCalled();
  });

  it("passes principal tenant context into provider canary validation", async () => {
    const { routes, recordCanary } = createProviderRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.providers.canary")!;

    await route.handler(makeProviderContext({
      runtimeVersion: "runtime-v1",
      planDigest: PROVIDER_PLAN_DIGEST,
      canonicalApproval: makeProviderApproval({ action: "canary" }),
    }));

    expect(recordCanary).toHaveBeenCalledWith(expect.objectContaining({
      tenantContext: {
        hubId: "user-1",
        userId: "user-1",
      },
    }));
  });
});

describe("createFridayAutonomyRoutes MCP lifecycle approval", () => {
  it("requires canonical approval before MCP shadow can mutate", async () => {
    const { routes, registerShadow } = createMcpRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.mcp.servers.shadow")!;

    await expect(route.handler(makeMcpContext({
      shadowVersionId: "mcp-1@shadow",
      runtimeVersion: "runtime-v1",
      planDigest: MCP_PLAN_DIGEST,
    }))).rejects.toMatchObject({ code: "CANONICAL_APPROVAL_REQUIRED" });

    expect(registerShadow).not.toHaveBeenCalled();
  });

  it("passes canonical approval metadata into MCP shadow and returns evidence", async () => {
    const { routes, registerShadow } = createMcpRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.mcp.servers.shadow")!;

    const result = await route.handler(makeMcpContext({
      shadowVersionId: "mcp-1@shadow",
      runtimeVersion: "runtime-v1",
      planDigest: MCP_PLAN_DIGEST,
      canonicalApproval: makeMcpApproval({ action: "shadow" }),
    }));

    expect(registerShadow).toHaveBeenCalledWith(expect.objectContaining({
      serverId: "mcp-1",
      shadowVersionId: "mcp-1@shadow",
      canonicalApproval: expect.objectContaining({ approvalId: "mcp-shadow-approval" }),
      actor: expect.objectContaining({ principalId: "user-1" }),
      surface: "api:/v1/autonomy/mcp-servers/shadow",
      planDigest: MCP_PLAN_DIGEST,
    }));
    expect(result).toHaveProperty("evidence.stage", "shadow");
  });

  it("rejects caller-supplied MCP canary success because proof must run internally", async () => {
    const { routes, recordCanary } = createMcpRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.mcp.servers.canary")!;

    await expect(route.handler(makeMcpContext({
      runtimeVersion: "runtime-v1",
      success: true,
      planDigest: MCP_PLAN_DIGEST,
      canonicalApproval: makeMcpApproval({ action: "canary" }),
    }))).rejects.toMatchObject({ code: "MCP_SERVER_CANARY_RUNTIME_PROOF_REQUIRED" });

    expect(recordCanary).not.toHaveBeenCalled();
  });
});

describe("createFridayAutonomyRoutes plugin lifecycle approval", () => {
  it("requires canonical approval before plugin shadow can mutate", async () => {
    const { routes, registerShadow } = createPluginRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.plugins.shadow")!;

    await expect(route.handler(makePluginContext({
      shadowVersionId: "plugin-1@shadow",
      runtimeVersion: "runtime-v1",
      planDigest: PLUGIN_PLAN_DIGEST,
    }))).rejects.toMatchObject({ code: "CANONICAL_APPROVAL_REQUIRED" });

    expect(registerShadow).not.toHaveBeenCalled();
  });

  it("passes canonical approval metadata into plugin shadow and returns evidence", async () => {
    const { routes, registerShadow } = createPluginRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.plugins.shadow")!;

    const result = await route.handler(makePluginContext({
      shadowVersionId: "plugin-1@shadow",
      runtimeVersion: "runtime-v1",
      planDigest: PLUGIN_PLAN_DIGEST,
      canonicalApproval: makePluginApproval({ action: "shadow" }),
    }));

    expect(registerShadow).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: "plugin-1",
      shadowVersionId: "plugin-1@shadow",
      canonicalApproval: expect.objectContaining({ approvalId: "plugin-shadow-approval" }),
      actor: expect.objectContaining({ principalId: "user-1" }),
      surface: "api:/v1/autonomy/plugins/shadow",
      planDigest: PLUGIN_PLAN_DIGEST,
    }));
    expect(result).toHaveProperty("evidence.stage", "shadow");
  });

  it("rejects caller-supplied plugin canary success because proof must run internally", async () => {
    const { routes, recordCanary } = createPluginRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.plugins.canary")!;

    await expect(route.handler(makePluginContext({
      runtimeVersion: "runtime-v1",
      success: true,
      planDigest: PLUGIN_PLAN_DIGEST,
      canonicalApproval: makePluginApproval({ action: "canary" }),
    }))).rejects.toMatchObject({ code: "PLUGIN_CANARY_RUNTIME_PROOF_REQUIRED" });

    expect(recordCanary).not.toHaveBeenCalled();
  });

  it("passes principal context into plugin review-enable so backend can issue canonical child approvals", async () => {
    const { routes, reviewEnable } = createPluginRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.plugins.review.enable")!;

    const result = await route.handler(makePluginContext({
      runtimeVersion: "runtime-v1",
      providerModel: "model-v1",
      idempotencyKey: "review-enable-key",
    }));

    expect(reviewEnable).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: "plugin-1",
      runtimeVersion: "runtime-v1",
      providerModel: "model-v1",
      idempotencyKey: "review-enable-key",
      actor: expect.objectContaining({ principalId: "user-1" }),
      surface: "api:/v1/autonomy/plugins/review-enable",
    }));
    expect(result).toHaveProperty("plugin.promotionChannel", "active");
    expect(result).toHaveProperty("evidence.pluginId", "plugin-1");
  });
});

describe("createFridayAutonomyRoutes channel adapter lifecycle approval", () => {
  it("requires canonical approval before channel shadow can mutate", async () => {
    const { routes, registerShadow } = createChannelRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.channels.shadow")!;

    await expect(route.handler(makeChannelContext({
      shadowVersionId: "webchat@shadow",
      runtimeVersion: "runtime-v1",
      planDigest: CHANNEL_PLAN_DIGEST,
    }))).rejects.toMatchObject({ code: "CANONICAL_APPROVAL_REQUIRED" });

    expect(registerShadow).not.toHaveBeenCalled();
  });

  it("passes canonical approval metadata into channel shadow and returns evidence", async () => {
    const { routes, registerShadow } = createChannelRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.channels.shadow")!;

    const result = await route.handler(makeChannelContext({
      shadowVersionId: "webchat@shadow",
      runtimeVersion: "runtime-v1",
      planDigest: CHANNEL_PLAN_DIGEST,
      canonicalApproval: makeChannelApproval({ action: "shadow" }),
    }));

    expect(registerShadow).toHaveBeenCalledWith(expect.objectContaining({
      channelKind: "webchat",
      shadowVersionId: "webchat@shadow",
      canonicalApproval: expect.objectContaining({ approvalId: "channel-shadow-approval" }),
      actor: expect.objectContaining({ principalId: "user-1" }),
      surface: "api:/v1/autonomy/channels/shadow",
      planDigest: CHANNEL_PLAN_DIGEST,
    }));
    expect(result).toHaveProperty("evidence.stage", "shadow");
  });

  it("rejects caller-supplied channel canary success because proof must run internally", async () => {
    const { routes, recordCanary } = createChannelRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.channels.canary")!;

    await expect(route.handler(makeChannelContext({
      runtimeVersion: "runtime-v1",
      success: true,
      planDigest: CHANNEL_PLAN_DIGEST,
      canonicalApproval: makeChannelApproval({ action: "canary" }),
    }))).rejects.toMatchObject({ code: "CHANNEL_ADAPTER_CANARY_RUNTIME_PROOF_REQUIRED" });

    expect(recordCanary).not.toHaveBeenCalled();
  });
});
