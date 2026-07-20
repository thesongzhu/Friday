import { afterEach, describe, expect, it, vi } from "vitest";

import { createFridayApiRuntime } from "#api";
import type { FridayHubConfigManagerService } from "#hub";
import type {
  FridayAutoFixRoutesDeps,
  FridayAgentLoopRoutesDeps,
  CreateFridayApiRuntimeDeps,
  FridayAuthPrincipal,
  FridayDesktopRoutesDeps,
  FridayChannelRoutesDeps,
  FridayDiagnosisRoutesDeps,
  FridayDiscoveryRoutesDeps,
  FridayMcpServerRoutesDeps,
  FridayMultiTenantSecurityRoutesDeps,
  FridayObservabilityRoutesDeps,
  FridaySatellitePairingRoutesDeps,
  FridaySatelliteRuntimeRoutesDeps,
  FridaySystemRoutesDeps,
  FridayUixRoutesDeps,
} from "#api";
import { FridayDomainError } from "#errors";
import type { FridayAgentEventEmitter, FridayAgentRuntime } from "#agent";
import type { FridayProviderService } from "#providers";
import type { FridayProviderProfile } from "#providers";
import type { FridaySqliteLayer } from "#state";
import type { FridayWorkflowRuntime } from "#workflows";
import { signFridayCanonicalApproval } from "../../../../src/security/friday-mutating-action-gate.js";
import type { FridayCanonicalApprovalResolution } from "../../../../src/security/friday-mutating-action-gate.js";
import {
  deviceOwnerPrincipalIdFor,
  generateTestDeviceKey,
  makeApprovalProof,
  makeApprovalTranscript,
} from "../../../helpers/friday-provider-approval-test-kit.js";
import { createTestDb } from "../../../helpers/friday-test-db.helper.js";

// SEC-APPROVAL-AUTHORITY-001: a single owner device for the runtime provider-gate
// tests. The Hub verifies its P-256 proof; no Hub signing key is on the approval path.
const RUNTIME_OWNER_KEY = generateTestDeviceKey();
const RUNTIME_OWNER_PRINCIPAL = deviceOwnerPrincipalIdFor(RUNTIME_OWNER_KEY);

/** A DEVICE-AUTHORED provider approval bound to `actionDigest` + the owner device. */
function runtimeDeviceApproval(actionDigest: string, approvalId: string): FridayCanonicalApprovalResolution {
  const expiresAt = "2026-02-27T01:00:00.000Z";
  const transcript = makeApprovalTranscript(RUNTIME_OWNER_KEY, {
    actionDigest,
    decidedByPrincipalId: RUNTIME_OWNER_PRINCIPAL,
    approvalId,
    expiresAt,
  });
  return {
    decision: "approved",
    approvalId,
    decidedByPrincipalId: RUNTIME_OWNER_PRINCIPAL,
    actionDigest,
    expiresAt,
    issuer: "friday_device_owner",
    deviceProof: makeApprovalProof(RUNTIME_OWNER_KEY, transcript),
  };
}

const NOW = "2026-02-27T00:00:00.000Z";
const allocatedDbs: FridaySqliteLayer[] = [];
const providerBody = {
  kind: "openai" as const,
  name: "OpenAI",
  baseUrl: "https://api.openai.com",
  authMode: "api-key" as const,
  api: "openai-completions" as const,
  supportedModels: ["gpt-4o"],
};

function sampleProviderProfile(input: Partial<FridayProviderProfile> = {}): FridayProviderProfile {
  return {
    id: "p-1",
    kind: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com",
    enabled: true,
    defaultModel: "gpt-4o",
    config: {
      api: "openai-completions",
      authMode: "api-key",
      keySource: { kind: "env-ref", envVar: "OPENAI_API_KEY" },
      supportedModels: ["gpt-4o"],
      validation: { status: "ok", checkedAt: NOW },
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...input,
  };
}

function makeMockProviderService(): FridayProviderService {
  return {
    listProviders: vi.fn(async () => []),
    getProvider: vi.fn(async () => null),
    createProvider: vi.fn(async () => sampleProviderProfile()),
    updateProvider: vi.fn(async () => ({} as never)),
    deleteProvider: vi.fn(async () => undefined),
    validateProvider: vi.fn(async () => ({ status: "ok" as const, checkedAt: NOW })),
    getRoutingConfig: vi.fn(async () => ({ defaultProviderId: "p-1", fallbackProviderIds: [] })),
    setRoutingConfig: vi.fn(async (input) => input),
    resolveRoute: vi.fn(async () => ({
      provider: {
        id: "p-1",
        kind: "openai" as const,
        name: "OpenAI",
        baseUrl: "https://api.openai.com",
        enabled: true,
        config: {
          api: "openai-completions" as const,
          authMode: "api-key" as const,
          keySource: { kind: "env-ref" as const, envVar: "OPENAI_API_KEY" },
          supportedModels: ["gpt-4o"],
          validation: { status: "ok" as const, checkedAt: NOW },
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
      model: "gpt-4o",
    })),
    runWithFallback: vi.fn(async () => ({} as never)),
  } as unknown as FridayProviderService;
}

function makeMockConfigManager(): FridayHubConfigManagerService {
  return {
    getCurrentConfig: vi.fn(async () => ({ channels: {} } as never)),
    getConfig: vi.fn(async () => ({ revision: 1, settings: {} })),
    validatePatch: vi.fn(async () => ({ valid: true, errors: [] })),
    applyPatch: vi.fn(async () => ({ revision: 2, changedKeys: ["flag"] })),
    listRevisions: vi.fn(async () => ({ items: [] })),
    revertToRevision: vi.fn(async () => ({ revision: 3, changedKeys: ["flag"], revertedFrom: 2 })),
    getSkillRegistrySettings: vi.fn(async () => ({
      workspaceDir: ".",
      bundledSkillsDir: "skills",
      managedSkillsDir: "managed-skills",
      extraSkillDirs: [],
      watchEnabled: false,
      watchDebounceMs: 300,
    })),
    getSkillSecurityProfile: vi.fn(async () => ({})),
  };
}

function makeBaseDeps(): CreateFridayApiRuntimeDeps {
  const db = createTestDb();
  allocatedDbs.push(db);
  return {
    db,
    idGenerator: () => "id-1",
    nowIso: () => NOW,
    providerService: makeMockProviderService(),
    // Test-oracle flag: the deeplink.apply provider-template tests below exercise
    // the live apply dispatch. Production wiring leaves it unset (TS-runtime retirement).
    allowTestOnlyDeepLinkExecution: true,
    tokenSecret: "test-secret", // pragma: allowlist secret
    computeChecksum: (content: string) => `checksum-${content.length}`,
    resolveSkill: () => null,
    invokeSkill: async () => ({}),
    skillLifecycle: {
      listSkills: vi.fn(() => []),
      listCatalog: vi.fn(() => ({ items: [], nextCursor: undefined, total: 0 })),
      getSkill: vi.fn(() => null),
      install: vi.fn(),
      update: vi.fn(),
      deleteSkill: vi.fn(),
      verifySkill: vi.fn(),
      validateManifest: vi.fn(() => ({ ok: true, issues: [] })),
    } as never,
  };
}

function makePrincipal(overrides: Partial<FridayAuthPrincipal> = {}): FridayAuthPrincipal {
  return {
    principalType: "user",
    principalId: "tenant-a",
    userId: "user-1",
    role: "viewer",
    scopes: ["workflow.read"],
    tokenId: "token-1",
    tokenKind: "access",
    issuedAt: NOW,
    expiresAt: NOW,
    ...overrides,
  };
}

function seedAgentRun(
  db: FridaySqliteLayer,
  input: {
    id: string;
    status?: string;
    sessionKey?: string;
    task?: string;
  },
): void {
  db.withWriteTransaction((writer) => {
    writer.prepare(
      `INSERT INTO friday_agent_runs (
        id, task, status, session_key, attempt, max_attempts, created_at,
        constraints_json, metadata_json
      ) VALUES (?, ?, ?, ?, 0, 1, ?, '{}', '{}')`,
    ).run(
      input.id,
      input.task ?? "Seeded test run",
      input.status ?? "executing",
      input.sessionKey ?? "agent:run:seeded",
      NOW,
    );
  });
}

function makeWorkflowRuntimeSpies(): {
  workflowRuntime: FridayWorkflowRuntime;
  execution: {
    startRun: ReturnType<typeof vi.fn>;
    getRun: ReturnType<typeof vi.fn>;
    cancelRun: ReturnType<typeof vi.fn>;
    retryRun: ReturnType<typeof vi.fn>;
    resumeRun: ReturnType<typeof vi.fn>;
  };
  evidence: {
    exportRunEvidence: ReturnType<typeof vi.fn>;
  };
} {
  const run = {
    id: "workflow-run-1",
    workflowId: "workflow-1",
    workflowVersionId: "version-1",
    status: "running",
    triggerType: "manual",
    startedAt: NOW,
    startedByUserId: "user-1",
  };
  const execution = {
    startRun: vi.fn(async () => run),
    getRun: vi.fn(() => run),
    getRunNodes: vi.fn(() => []),
    cancelRun: vi.fn(async () => ({ ...run, status: "cancelled" })),
    retryRun: vi.fn(async () => ({ ...run, status: "running" })),
    resumeRun: vi.fn(async () => ({ ...run, status: "running" })),
  };
  const evidence = {
    getRunEvidenceStatus: vi.fn(() => ({ state: "not_required" })),
    getRunEvidence: vi.fn(),
    listRunEvidenceExports: vi.fn(() => []),
    exportRunEvidence: vi.fn(),
    getRunEvidenceExport: vi.fn(() => null),
    downloadRunEvidenceExport: vi.fn(() => null),
  };
  const workflowRuntime = {
    execution,
    evidence,
    crud: {},
    approval: {},
    triggers: {},
  } as unknown as FridayWorkflowRuntime;
  return { workflowRuntime, execution, evidence };
}

describe("API Runtime — Extended Route Registration", () => {
  afterEach(() => {
    while (allocatedDbs.length > 0) {
      allocatedDbs.pop()!.close();
    }
  });

  it("keeps stable disabled route surfaces while leaving unrelated optional families unregistered when deps are omitted", () => {
    const runtime = createFridayApiRuntime(makeBaseDeps());
    const operationIds = runtime.routes.getRoutes().map((route) => route.operationId);

    expect(operationIds).toContain("version.get");
    expect(operationIds).toContain("tui.status.get");
    expect(operationIds).toContain("tui.jobs.list");
    expect(operationIds).toContain("secrets.list");
    expect(operationIds).toContain("skills.catalog.list");
    expect(operationIds).toContain("skills.install");
    expect(operationIds).toContain("skills.verify");
    expect(operationIds.some((id) => id.startsWith("security.tenants."))).toBe(false);
    expect(operationIds.some((id) => id.startsWith("observability."))).toBe(false);
    expect(operationIds.some((id) => id.startsWith("config."))).toBe(false);
    expect(operationIds).not.toContain("audit.logs.list");
    expect(operationIds.some((id) => id.startsWith("desktop."))).toBe(false);
    expect(operationIds).toContain("channels.webhooks.line");
    expect(operationIds).toContain("channels.webhooks.whatsapp.verify");
    expect(operationIds).toContain("channels.webhooks.whatsapp");
    expect(operationIds).toContain("channels.webhooks.telegram");
    expect(operationIds).toContain("channels.webhooks.lark");
    expect(operationIds.some((id) => id.startsWith("channels.") && !id.startsWith("channels.webhooks."))).toBe(false);
    expect(operationIds.some((id) => id.startsWith("system."))).toBe(false);
    expect(operationIds).toContain("discovery.status");
    expect(operationIds).toContain("mcp.server.rpc");
    expect(operationIds).toContain("packaging.packages.list");
    expect(operationIds.some((id) => id.startsWith("satellites."))).toBe(false);
    expect(operationIds.some((id) => id.startsWith("diagnosis."))).toBe(false);
    expect(operationIds.some((id) => id.startsWith("autofix."))).toBe(false);
    expect(operationIds.some((id) => id.startsWith("agent.loop."))).toBe(false);
    expect(operationIds.some((id) => id.startsWith("uix."))).toBe(false);
    // Phase 02a: media-understanding routes are ALWAYS registered even when
    // deps.mediaUnderstanding is omitted. Disabled deployments return 503
    // MEDIA_UNDERSTANDING_DISABLED, never 404.
    expect(operationIds).toContain("media.understanding.doctor");
    expect(operationIds).toContain("media.understanding.analyze");
    // Phase 02b: social-import route is ALWAYS registered even when
    // deps.socialImport is omitted. Disabled deployments return 503
    // SOCIAL_IMPORT_DISABLED, never 404.
    expect(operationIds).toContain("skills.social.import");
    // Mission Spine workbench route is ALWAYS registered. Disabled
    // deployments return 503 MISSION_SPINE_WORKBENCH_UNAVAILABLE, never 404 or
    // a prep snapshot pretending to be live.
    expect(operationIds).toContain("mission.spine.workbench.get");
  });

  it("registers mission.spine.workbench.get in disabled state when deps.missionSpine is omitted", async () => {
    const runtime = createFridayApiRuntime(makeBaseDeps());
    const route = runtime.routes.getRoutes().find((r) => r.operationId === "mission.spine.workbench.get");
    expect(route).toBeDefined();
    let thrown: unknown = null;
    try {
      await route!.handler({
        requestId: "req-mission-spine-workbench-disabled",
        receivedAt: NOW,
        params: {},
        query: {},
        body: null,
        headers: {},
        principal: makePrincipal({ role: "admin", scopes: ["hub.admin"] }),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FridayDomainError);
    expect((thrown as FridayDomainError).code).toBe("MISSION_SPINE_WORKBENCH_UNAVAILABLE");
    expect((thrown as FridayDomainError).httpStatus).toBe(503);
    expect((thrown as FridayDomainError).message).toMatch(/projection deps not provided/);
  });

  it("fail-closes live POST /v1/agent/runs wiring without executing the TypeScript agent runtime", async () => {
    const executeRun = vi.fn<FridayAgentRuntime["executeRun"]>().mockResolvedValue({
      runId: "run-should-not-execute",
      status: "completed",
      response: "should not execute",
      toolCallCount: 0,
      durationMs: 0,
      usageInput: 0,
      usageOutput: 0,
    });
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      agentRuntime: { executeRun },
      agentEventEmitter: {
        on: vi.fn(),
        off: vi.fn(),
        emit: vi.fn(),
      } satisfies FridayAgentEventEmitter,
    });
    const route = runtime.routes.getRoutes().find((r) => r.operationId === "agent.runs.start");
    expect(route).toBeDefined();

    let thrown: unknown = null;
    try {
      await route!.handler({
        requestId: "req-agent-run-retired",
        receivedAt: NOW,
        params: {},
        query: {},
        body: { task: "Do not execute from TypeScript" },
        headers: {},
        principal: makePrincipal({ role: "admin", scopes: ["agent.run"] }),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(FridayDomainError);
    expect((thrown as FridayDomainError).code).toBe("TS_RUNTIME_AGENT_RUNS_RETIRED");
    expect((thrown as FridayDomainError).httpStatus).toBe(503);
    expect(executeRun).not.toHaveBeenCalled();
  });

  it("fail-closes live agent run cancel wiring without aborting TypeScript controllers", async () => {
    const deps = makeBaseDeps();
    seedAgentRun(deps.db, { id: "run-control-retired-cancel", status: "executing" });
    const executeRun = vi.fn<FridayAgentRuntime["executeRun"]>();
    const rollbackRun = vi.fn<FridayAgentRuntime["rollbackRun"]>();
    const runtime = createFridayApiRuntime({
      ...deps,
      agentRuntime: {
        executeRun,
        rollbackRun,
        registerTool: vi.fn(),
        resumeStaleRunsOnBoot: vi.fn(() => 0),
        hasRollbackCheckpoint: vi.fn(() => false),
      } as unknown as FridayAgentRuntime,
      agentEventEmitter: {
        on: vi.fn(),
        off: vi.fn(),
        emit: vi.fn(),
      } satisfies FridayAgentEventEmitter,
    });
    const route = runtime.routes.getRoutes().find((r) => r.operationId === "agent.runs.cancel");
    expect(route).toBeDefined();

    let thrown: unknown = null;
    try {
      await route!.handler({
        requestId: "req-agent-run-cancel-retired",
        receivedAt: NOW,
        params: { runId: "run-control-retired-cancel" },
        query: {},
        body: {},
        headers: {},
        principal: makePrincipal({ role: "admin", scopes: ["agent.run"] }),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(FridayDomainError);
    expect((thrown as FridayDomainError).code).toBe("TS_RUNTIME_AGENT_RUN_CONTROLS_RETIRED");
    expect((thrown as FridayDomainError).httpStatus).toBe(503);
    expect((thrown as FridayDomainError).details).toMatchObject({
      classification: "fail_closed",
      replacement: "rust_owned_agent_run_control_entrypoint_required",
    });
    expect(executeRun).not.toHaveBeenCalled();
    expect(rollbackRun).not.toHaveBeenCalled();
  });

  it("fail-closes live agent run rollback wiring without calling TypeScript rollback", async () => {
    const deps = makeBaseDeps();
    seedAgentRun(deps.db, { id: "run-control-retired-rollback", status: "completed" });
    const rollbackRun = vi.fn<FridayAgentRuntime["rollbackRun"]>(() => ({
      restoredCount: 1,
      errors: [],
    }));
    const runtime = createFridayApiRuntime({
      ...deps,
      agentRuntime: {
        executeRun: vi.fn(),
        rollbackRun,
        registerTool: vi.fn(),
        resumeStaleRunsOnBoot: vi.fn(() => 0),
        hasRollbackCheckpoint: vi.fn(() => true),
      } as unknown as FridayAgentRuntime,
      agentEventEmitter: {
        on: vi.fn(),
        off: vi.fn(),
        emit: vi.fn(),
      } satisfies FridayAgentEventEmitter,
    });
    const route = runtime.routes.getRoutes().find((r) => r.operationId === "agent.runs.rollback");
    expect(route).toBeDefined();

    let thrown: unknown = null;
    try {
      await route!.handler({
        requestId: "req-agent-run-rollback-retired",
        receivedAt: NOW,
        params: { runId: "run-control-retired-rollback" },
        query: {},
        body: {},
        headers: {},
        principal: makePrincipal({ role: "admin", scopes: ["agent.run"] }),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(FridayDomainError);
    expect((thrown as FridayDomainError).code).toBe("TS_RUNTIME_AGENT_RUN_CONTROLS_RETIRED");
    expect((thrown as FridayDomainError).httpStatus).toBe(503);
    expect((thrown as FridayDomainError).details).toMatchObject({
      classification: "fail_closed",
      replacement: "rust_owned_agent_run_control_entrypoint_required",
    });
    expect(rollbackRun).not.toHaveBeenCalled();
  });

  it("fail-closes live agent automation run wiring before TypeScript automation execution", async () => {
    const executeRun = vi.fn<FridayAgentRuntime["executeRun"]>();
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      agentRuntime: {
        executeRun,
        rollbackRun: vi.fn(),
        registerTool: vi.fn(),
        resumeStaleRunsOnBoot: vi.fn(() => 0),
        hasRollbackCheckpoint: vi.fn(() => false),
      } as unknown as FridayAgentRuntime,
      agentEventEmitter: {
        on: vi.fn(),
        off: vi.fn(),
        emit: vi.fn(),
      } satisfies FridayAgentEventEmitter,
    });
    const route = runtime.routes.getRoutes().find((r) => r.operationId === "agent.automations.run");
    expect(route).toBeDefined();

    let thrown: unknown = null;
    try {
      await route!.handler({
        requestId: "req-agent-automation-run-retired",
        receivedAt: NOW,
        params: { automationId: "automation-does-not-matter" },
        query: {},
        body: {},
        headers: {},
        principal: makePrincipal({ role: "admin", scopes: ["agent.run"] }),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(FridayDomainError);
    expect((thrown as FridayDomainError).code).toBe("TS_RUNTIME_AGENT_RUN_CONTROLS_RETIRED");
    expect((thrown as FridayDomainError).httpStatus).toBe(503);
    expect((thrown as FridayDomainError).details).toMatchObject({
      classification: "fail_closed",
      replacement: "rust_owned_agent_run_control_entrypoint_required",
    });
    expect(executeRun).not.toHaveBeenCalled();
  });

  for (const scenario of [
    {
      name: "create",
      operationId: "agent.automations.create",
      params: {},
      body: {
        name: "Daily digest",
        taskTemplate: "send digest",
      },
    },
    {
      name: "update",
      operationId: "agent.automations.update",
      params: { automationId: "automation-does-not-matter" },
      body: { name: "Updated digest" },
    },
    {
      name: "delete",
      operationId: "agent.automations.delete",
      params: { automationId: "automation-does-not-matter" },
      body: {},
    },
  ]) {
    it(`fail-closes live agent automation ${scenario.name} wiring before TypeScript automation asset mutation`, async () => {
      const runtime = createFridayApiRuntime({
        ...makeBaseDeps(),
        agentRuntime: {
          executeRun: vi.fn(),
          rollbackRun: vi.fn(),
          registerTool: vi.fn(),
          resumeStaleRunsOnBoot: vi.fn(() => 0),
          hasRollbackCheckpoint: vi.fn(() => false),
        } as unknown as FridayAgentRuntime,
        agentEventEmitter: {
          on: vi.fn(),
          off: vi.fn(),
          emit: vi.fn(),
        } satisfies FridayAgentEventEmitter,
      });
      const route = runtime.routes.getRoutes().find((r) => r.operationId === scenario.operationId);
      expect(route).toBeDefined();

      let thrown: unknown = null;
      try {
        await route!.handler({
          requestId: `req-agent-automation-${scenario.name}-retired`,
          receivedAt: NOW,
          params: scenario.params,
          query: {},
          body: scenario.body,
          headers: {},
          principal: makePrincipal({ role: "admin", scopes: ["agent.write"] }),
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(FridayDomainError);
      expect((thrown as FridayDomainError).code).toBe("TS_RUNTIME_AGENT_RUN_CONTROLS_RETIRED");
      expect((thrown as FridayDomainError).httpStatus).toBe(503);
      expect((thrown as FridayDomainError).details).toMatchObject({
        classification: "fail_closed",
        replacement: "rust_owned_agent_run_control_entrypoint_required",
      });
    });
  }

  for (const scenario of [
    {
      name: "approve plan",
      operationId: "agent.runs.approve.plan",
      runId: "run-control-retired-approve-plan",
      body: {},
    },
    {
      name: "reject plan",
      operationId: "agent.runs.reject.plan",
      runId: "run-control-retired-reject-plan",
      body: {},
    },
  ]) {
    it(`fail-closes live agent run ${scenario.name} wiring before TypeScript planning control`, async () => {
      const deps = makeBaseDeps();
      seedAgentRun(deps.db, { id: scenario.runId, status: "awaiting_plan_approval" });
      const executeRun = vi.fn<FridayAgentRuntime["executeRun"]>();
      const runtime = createFridayApiRuntime({
        ...deps,
        agentRuntime: {
          executeRun,
          rollbackRun: vi.fn(),
          registerTool: vi.fn(),
          resumeStaleRunsOnBoot: vi.fn(() => 0),
          hasRollbackCheckpoint: vi.fn(() => false),
        } as unknown as FridayAgentRuntime,
        agentEventEmitter: {
          on: vi.fn(),
          off: vi.fn(),
          emit: vi.fn(),
        } satisfies FridayAgentEventEmitter,
      });
      const route = runtime.routes.getRoutes().find((r) => r.operationId === scenario.operationId);
      expect(route).toBeDefined();

      let thrown: unknown = null;
      try {
        await route!.handler({
          requestId: `req-${scenario.runId}`,
          receivedAt: NOW,
          params: { runId: scenario.runId },
          query: {},
          body: scenario.body,
          headers: {},
          principal: makePrincipal({ role: "admin", scopes: ["agent.run"] }),
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(FridayDomainError);
      expect((thrown as FridayDomainError).code).toBe("TS_RUNTIME_AGENT_RUN_CONTROLS_RETIRED");
      expect((thrown as FridayDomainError).httpStatus).toBe(503);
      expect((thrown as FridayDomainError).details).toMatchObject({
        classification: "fail_closed",
        replacement: "rust_owned_agent_run_control_entrypoint_required",
      });
      expect(executeRun).not.toHaveBeenCalled();
    });
  }

  for (const scenario of [
    {
      name: "approve tool",
      operationId: "agent.runs.approve.tool",
      runId: "run-control-retired-approve-tool",
      body: { toolCallId: "tool-call-1" },
    },
    {
      name: "reject tool",
      operationId: "agent.runs.reject.tool",
      runId: "run-control-retired-reject-tool",
      body: { toolCallId: "tool-call-1", reason: "not approved" },
    },
  ]) {
    it(`fail-closes live agent run ${scenario.name} wiring before TypeScript tool approval resolution`, async () => {
      const deps = makeBaseDeps();
      seedAgentRun(deps.db, { id: scenario.runId, status: "awaiting_tool_approval" });
      const resolveToolApproval = vi.fn(() => ({ resolved: true }));
      const runtime = createFridayApiRuntime({
        ...deps,
        agentRuntime: {
          executeRun: vi.fn(),
          rollbackRun: vi.fn(),
          registerTool: vi.fn(),
          resumeStaleRunsOnBoot: vi.fn(() => 0),
          hasRollbackCheckpoint: vi.fn(() => false),
        } as unknown as FridayAgentRuntime,
        agentEventEmitter: {
          on: vi.fn(),
          off: vi.fn(),
          emit: vi.fn(),
        } satisfies FridayAgentEventEmitter,
        resolveToolApproval,
      });
      const route = runtime.routes.getRoutes().find((r) => r.operationId === scenario.operationId);
      expect(route).toBeDefined();

      let thrown: unknown = null;
      try {
        await route!.handler({
          requestId: `req-${scenario.runId}`,
          receivedAt: NOW,
          params: { runId: scenario.runId },
          query: {},
          body: scenario.body,
          headers: {},
          principal: makePrincipal({ role: "admin", scopes: ["agent.run"] }),
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(FridayDomainError);
      expect((thrown as FridayDomainError).code).toBe("TS_RUNTIME_AGENT_RUN_CONTROLS_RETIRED");
      expect((thrown as FridayDomainError).httpStatus).toBe(503);
      expect((thrown as FridayDomainError).details).toMatchObject({
        classification: "fail_closed",
        replacement: "rust_owned_agent_run_control_entrypoint_required",
      });
      expect(resolveToolApproval).not.toHaveBeenCalled();
    });
  }

  it("fail-closes live workflow run start wiring without executing the TypeScript workflow runtime", async () => {
    const { workflowRuntime, execution } = makeWorkflowRuntimeSpies();
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      workflowRuntime,
    });
    const route = runtime.routes.getRoutes().find((r) => r.operationId === "runs.start");
    expect(route).toBeDefined();

    let thrown: unknown = null;
    try {
      await route!.handler({
        requestId: "req-workflow-run-retired",
        receivedAt: NOW,
        params: {},
        query: {},
        body: { workflowId: "workflow-1" },
        headers: {},
        principal: makePrincipal({ role: "admin", scopes: ["workflow.write"] }),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(FridayDomainError);
    expect((thrown as FridayDomainError).code).toBe("TS_RUNTIME_WORKFLOW_RUNS_RETIRED");
    expect((thrown as FridayDomainError).httpStatus).toBe(503);
    expect(execution.startRun).not.toHaveBeenCalled();
    expect(execution.getRun).not.toHaveBeenCalled();
  });

  it("routes live workflow run start/read to the Rust bridge when routeWorkflowRunsViaRust is on", async () => {
    const { workflowRuntime, execution } = makeWorkflowRuntimeSpies();
    const rustRun = {
      id: "rust-run-1",
      workflowId: "workflow-1",
      workflowVersionId: "rust-version:1",
      status: "completed" as const,
      triggerType: "manual",
      startedAt: NOW,
      finishedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      evidenceStatus: "available" as const,
      completionVerification: "verified" as const,
    };
    const rustWorkflowRunBridge = {
      startRun: vi.fn(async () => ({ run: rustRun })),
      getRun: vi.fn(async () => ({ run: rustRun })),
    };
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      workflowRuntime,
      routeWorkflowRunsViaRust: true,
      rustWorkflowRunBridge,
    } as CreateFridayApiRuntimeDeps & {
      routeWorkflowRunsViaRust: true;
      rustWorkflowRunBridge: typeof rustWorkflowRunBridge;
    });

    const startRoute = runtime.routes.getRoutes().find((r) => r.operationId === "runs.start");
    expect(startRoute).toBeDefined();
    await expect(startRoute!.handler({
      requestId: "req-workflow-run-rust-start",
      receivedAt: NOW,
      params: {},
      query: {},
      body: { workflowId: "workflow-1", triggerType: "manual" },
      headers: {},
      principal: makePrincipal({ role: "admin", scopes: ["workflow.write", "workflow.read"] }),
    })).resolves.toMatchObject({ run: { id: "rust-run-1", status: "completed" } });

    const getRoute = runtime.routes.getRoutes().find((r) => r.operationId === "runs.get");
    expect(getRoute).toBeDefined();
    await expect(getRoute!.handler({
      requestId: "req-workflow-run-rust-get",
      receivedAt: NOW,
      params: { runId: "rust-run-1" },
      query: {},
      body: null,
      headers: {},
      principal: makePrincipal({ role: "admin", scopes: ["workflow.read"] }),
    })).resolves.toMatchObject({ run: { id: "rust-run-1", status: "completed" } });

    expect(rustWorkflowRunBridge.startRun).toHaveBeenCalledTimes(1);
    expect(rustWorkflowRunBridge.getRun).toHaveBeenCalledTimes(1);
    expect(execution.startRun).not.toHaveBeenCalled();
    expect(execution.getRun).not.toHaveBeenCalled();
  });

  it.each([
    ["runs.cancel", { reason: "operator requested" }, "cancelRun"],
    ["runs.retry", { nodeIds: ["node-1"] }, "retryRun"],
    ["workflows.runs.resume", {}, "resumeRun"],
  ] as const)(
    "fail-closes live workflow control wiring for %s without TypeScript execution",
    async (operationId, body, methodName) => {
      const { workflowRuntime, execution } = makeWorkflowRuntimeSpies();
      const runtime = createFridayApiRuntime({
        ...makeBaseDeps(),
        workflowRuntime,
      });
      const route = runtime.routes.getRoutes().find((r) => r.operationId === operationId);
      expect(route).toBeDefined();

      let thrown: unknown = null;
      try {
        await route!.handler({
          requestId: `req-${operationId}-retired`,
          receivedAt: NOW,
          params: { runId: "workflow-run-1" },
          query: {},
          body,
          headers: {},
          principal: makePrincipal({ role: "admin", scopes: ["workflow.write"] }),
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(FridayDomainError);
      expect((thrown as FridayDomainError).code).toBe("TS_RUNTIME_WORKFLOW_RUNS_RETIRED");
      expect((thrown as FridayDomainError).httpStatus).toBe(503);
      expect((thrown as FridayDomainError).details).toMatchObject({
        classification: "fail_closed",
        replacement: "rust_owned_workflow_run_entrypoint_required",
      });
      expect(execution.getRun).not.toHaveBeenCalled();
      expect(execution[methodName]).not.toHaveBeenCalled();
    },
  );

  it("fail-closes live workflow evidence export wiring before TypeScript evidence mutation", async () => {
    const { workflowRuntime, evidence } = makeWorkflowRuntimeSpies();
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      workflowRuntime,
    });
    const route = runtime.routes.getRoutes().find((r) => r.operationId === "runs.evidence.export");
    expect(route).toBeDefined();

    let thrown: unknown = null;
    try {
      await route!.handler({
        requestId: "req-workflow-evidence-export-retired",
        receivedAt: NOW,
        params: { runId: "workflow-run-1" },
        query: {},
        body: {},
        headers: {},
        principal: makePrincipal({ role: "admin", scopes: ["workflow.write"] }),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(FridayDomainError);
    expect((thrown as FridayDomainError).code).toBe("TS_RUNTIME_WORKFLOW_RUN_EVIDENCE_EXPORT_RETIRED");
    expect((thrown as FridayDomainError).httpStatus).toBe(503);
    expect((thrown as FridayDomainError).details).toMatchObject({
      classification: "fail_closed",
      replacement: "rust_owned_workflow_run_evidence_export_entrypoint_required",
    });
    expect(evidence.exportRunEvidence).not.toHaveBeenCalled();
  });

  it("registers skills.social.import in disabled state when deps.socialImport is omitted", async () => {
    const runtime = createFridayApiRuntime(makeBaseDeps());
    const route = runtime.routes.getRoutes().find((r) => r.operationId === "skills.social.import");
    expect(route).toBeDefined();
    let thrown: unknown = null;
    try {
      await route!.handler({
        requestId: "req-social-import-disabled",
        receivedAt: NOW,
        params: {},
        query: {},
        body: {
          socialUrl: "https://www.xiaohongshu.com/explore/abc",
          targetGithubRepoUrl: "https://github.com/octocat/Hello-World",
        },
        headers: {},
        principal: makePrincipal({ role: "admin", scopes: ["hub.admin"] }),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FridayDomainError);
    expect((thrown as FridayDomainError).code).toBe("SOCIAL_IMPORT_DISABLED");
    expect((thrown as FridayDomainError).httpStatus).toBe(503);
  });

  it("registers media-understanding routes in disabled state when deps.mediaUnderstanding is omitted", async () => {
    // makeBaseDeps() does NOT supply mediaUnderstanding; the runtime must
    // coalesce to honest-disabled deps and still register both routes.
    const runtime = createFridayApiRuntime(makeBaseDeps());
    const doctorRoute = runtime.routes.getRoutes().find((r) => r.operationId === "media.understanding.doctor");
    const analyzeRoute = runtime.routes.getRoutes().find((r) => r.operationId === "media.understanding.analyze");
    expect(doctorRoute).toBeDefined();
    expect(analyzeRoute).toBeDefined();

    // Disabled-state behavior: both routes throw 503 MEDIA_UNDERSTANDING_DISABLED.
    let doctorThrown: unknown = null;
    try {
      await doctorRoute!.handler({
        requestId: "req-media-doctor-disabled",
        receivedAt: NOW,
        params: {},
        query: {},
        body: {},
        headers: {},
        principal: makePrincipal({ role: "admin", scopes: ["hub.admin"] }),
      });
    } catch (err) {
      doctorThrown = err;
    }
    expect(doctorThrown).toBeInstanceOf(FridayDomainError);
    expect((doctorThrown as FridayDomainError).code).toBe("MEDIA_UNDERSTANDING_DISABLED");
    expect((doctorThrown as FridayDomainError).httpStatus).toBe(503);
    expect((doctorThrown as FridayDomainError).message).toMatch(/media understanding deps not provided/);

    let analyzeThrown: unknown = null;
    try {
      await analyzeRoute!.handler({
        requestId: "req-media-analyze-disabled",
        receivedAt: NOW,
        params: {},
        query: {},
        body: { attachments: [{ mimeType: "image/png", sizeBytes: 1, sourceUrl: "https://example.com/x.png" }] },
        headers: {},
        principal: makePrincipal({ role: "admin", scopes: ["hub.admin"] }),
      });
    } catch (err) {
      analyzeThrown = err;
    }
    expect(analyzeThrown).toBeInstanceOf(FridayDomainError);
    expect((analyzeThrown as FridayDomainError).code).toBe("MEDIA_UNDERSTANDING_DISABLED");
    expect((analyzeThrown as FridayDomainError).httpStatus).toBe(503);
  });

  it("grant revoke rejects a bound principal that neither owns the grant nor has admin authority", async () => {
    const deps = makeBaseDeps();
    const runtime = createFridayApiRuntime(deps);
    deps.db.writer.prepare(
      `INSERT INTO capability_grants (id, principal_id, target, scopes, issued_at)
       VALUES ('grant-1', 'owner-principal', 'shell', '["exec"]', ?)`,
    ).run(NOW);
    const route = runtime.routes.getRoutes().find((r) => r.operationId === "grants.revoke")!;

    await expect(
      route.handler({
        requestId: "req-grant-revoke-wrong-principal",
        receivedAt: NOW,
        params: { grantId: "grant-1" },
        query: {},
        body: {},
        headers: {},
        principal: makePrincipal({
          principalId: "other-principal",
          userId: "other-user",
          role: "viewer",
          scopes: ["workflow.read"],
        }),
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      httpStatus: 403,
    });
  });

  it("grant revoke allows the grant owner without broad admin authority", async () => {
    const deps = makeBaseDeps();
    const runtime = createFridayApiRuntime(deps);
    deps.db.writer.prepare(
      `INSERT INTO capability_grants (id, principal_id, target, scopes, issued_at)
       VALUES ('grant-1', 'owner-principal', 'shell', '["exec"]', ?)`,
    ).run(NOW);
    const route = runtime.routes.getRoutes().find((r) => r.operationId === "grants.revoke")!;

    await expect(
      route.handler({
        requestId: "req-grant-revoke-owner",
        receivedAt: NOW,
        params: { grantId: "grant-1" },
        query: {},
        body: {},
        headers: {},
        principal: makePrincipal({
          principalId: "owner-principal",
          userId: "owner-user",
          role: "viewer",
          scopes: ["workflow.read"],
        }),
      }),
    ).resolves.toEqual({ revoked: true });
    const row = deps.db.writer
      .prepare("SELECT revoked_at FROM capability_grants WHERE id = 'grant-1'")
      .get() as { revoked_at: string | null };
    expect(row.revoked_at).toBe(NOW);
  });

  it.each([
    ["admin role", makePrincipal({ principalId: "admin-principal", role: "admin", scopes: ["workflow.read"] })],
    ["security write scope", makePrincipal({ principalId: "security-principal", role: "viewer", scopes: ["security.write"] })],
  ])("grant revoke allows %s for another principal's grant", async (_label, principal) => {
    const deps = makeBaseDeps();
    const runtime = createFridayApiRuntime(deps);
    deps.db.writer.prepare(
      `INSERT INTO capability_grants (id, principal_id, target, scopes, issued_at)
       VALUES ('grant-1', 'owner-principal', 'shell', '["exec"]', ?)`,
    ).run(NOW);
    const route = runtime.routes.getRoutes().find((r) => r.operationId === "grants.revoke")!;

    await expect(
      route.handler({
        requestId: "req-grant-revoke-admin",
        receivedAt: NOW,
        params: { grantId: "grant-1" },
        query: {},
        body: {},
        headers: {},
        principal,
      }),
    ).resolves.toEqual({ revoked: true });
    const row = deps.db.writer
      .prepare("SELECT revoked_at FROM capability_grants WHERE id = 'grant-1'")
      .get() as { revoked_at: string | null };
    expect(row.revoked_at).toBe(NOW);
  });

  it("workflow trigger mutations reject the synthetic public principal", async () => {
    const runtime = createFridayApiRuntime(makeBaseDeps());
    const updateRoute = runtime.routes.getRoutes().find((r) => r.operationId === "workflows.triggers.update")!;
    const resyncRoute = runtime.routes.getRoutes().find((r) => r.operationId === "workflows.triggers.resync")!;

    await expect(
      updateRoute.handler({
        requestId: "req-trigger-update-public",
        receivedAt: NOW,
        params: { registrationId: "reg-1" },
        query: {},
        body: { enabled: true },
        headers: {},
        principal: {
          principalType: "user",
          principalId: "public:default",
          userId: "00000000-0000-0000-0000-000000000001",
          role: "viewer",
          scopes: ["workflow.read"],
          tokenId: "00000000-0000-0000-0000-000000000002",
          tokenKind: "access",
          issuedAt: NOW,
        },
      }),
    ).rejects.toMatchObject({
      code: "OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED",
      httpStatus: 401,
    });

    await expect(
      resyncRoute.handler({
        requestId: "req-trigger-resync-public",
        receivedAt: NOW,
        params: { workflowId: "wf-1" },
        query: {},
        body: {},
        headers: {},
        principal: {
          principalType: "user",
          principalId: "public:default",
          userId: "00000000-0000-0000-0000-000000000001",
          role: "viewer",
          scopes: ["workflow.read"],
          tokenId: "00000000-0000-0000-0000-000000000002",
          tokenKind: "access",
          issuedAt: NOW,
        },
      }),
    ).rejects.toMatchObject({
      code: "OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED",
      httpStatus: 401,
    });
  });

  it("does not require provider setup canonical approval when canonical gate profile is off", async () => {
    const providerService = makeMockProviderService();
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      providerService,
      canonicalMutatingActionGate: false,
    });
    const route = runtime.routes.getRoutes().find((entry) => entry.operationId === "providers.create")!;

    await route.handler({
      requestId: "req-provider-create-off",
      receivedAt: NOW,
      params: {},
      query: {},
      body: providerBody,
      headers: {},
      principal: makePrincipal({ role: "admin", scopes: ["hub.admin"] }),
    });

    expect(providerService.createProvider).toHaveBeenCalledWith(providerBody);
  });

  it("requires signed provider setup canonical approval when runtime canonical gate profile is on", async () => {
    const providerService = makeMockProviderService();
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      providerService,
      canonicalMutatingActionGate: true,
    });
    const route = runtime.routes.getRoutes().find((entry) => entry.operationId === "providers.create")!;
    const baseCtx = {
      requestId: "req-provider-create-on",
      receivedAt: NOW,
      params: {},
      query: {},
      body: {
        ...providerBody,
        planDigest: "provider-runtime-plan-1",
      },
      headers: {},
      // Owner principal BOUND to the device (principalId = device-owner:<keyHash>).
      principal: makePrincipal({
        role: "admin",
        scopes: ["hub.admin"],
        principalId: RUNTIME_OWNER_PRINCIPAL,
      }),
    };

    let actionDigest = "";
    await route.handler(baseCtx).catch((error: unknown) => {
      expect(error).toBeInstanceOf(FridayDomainError);
      const domainError = error as FridayDomainError;
      expect(domainError.code).toBe("CANONICAL_APPROVAL_REQUIRED");
      const gate = domainError.details.canonicalGate as { actionDigest?: string } | undefined;
      actionDigest = gate?.actionDigest ?? "";
    });
    expect(actionDigest).toBeTruthy();
    expect(providerService.createProvider).not.toHaveBeenCalled();

    // A Hub-minted HMAC approval must be REFUSED on the provider path (Hub self-sign).
    await expect(route.handler({
      ...baseCtx,
      body: {
        ...baseCtx.body,
        canonicalApproval: signFridayCanonicalApproval({
          decision: "approved",
          approvalId: "provider-runtime-hmac",
          decidedByPrincipalId: RUNTIME_OWNER_PRINCIPAL,
          actionDigest,
          expiresAt: "2026-02-27T01:00:00.000Z",
        }, "test-secret"),
      },
    })).rejects.toMatchObject({ code: "PROVIDER_MUTATION_APPROVAL_NOT_DEVICE_AUTHORED" });
    expect(providerService.createProvider).not.toHaveBeenCalled();

    // A DEVICE-AUTHORED approval admits — the Hub verified it with the public key.
    const result = await route.handler({
      ...baseCtx,
      body: {
        ...baseCtx.body,
        canonicalApproval: runtimeDeviceApproval(actionDigest, "provider-runtime-approval"),
      },
    });

    expect(providerService.createProvider).toHaveBeenCalledWith(providerBody);
    expect(result).toHaveProperty("canonicalGate.ticketId");
  });

  it("keeps provider-template deeplink preview-only when provider gate profile is off", async () => {
    const providerService = makeMockProviderService();
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      providerService,
      canonicalMutatingActionGate: false,
    });
    const route = runtime.routes.getRoutes().find((entry) => entry.operationId === "deeplink.apply")!;

    const result = await route.handler({
      requestId: "req-deeplink-provider-off",
      receivedAt: NOW,
      params: {},
      query: {},
      body: {
        confirmed: true,
        payload: {
          version: 1,
          type: "provider-template",
          label: "Imported OpenAI",
          providerTemplate: {
            providerKind: "openai",
            apiKey: "sk-test", // pragma: allowlist secret -- fixture value for deeplink provider import coverage
            model: "gpt-4o-mini",
          },
        },
      },
      headers: {},
      principal: makePrincipal({ role: "admin", scopes: ["hub.admin"] }),
    });

    expect(result).toMatchObject({
      result: {
        applied: false,
        resourceType: "provider-template",
      },
    });
    expect(String((result as { result?: { message?: string } }).result?.message)).toContain("preview-only");
    expect(providerService.createProvider).not.toHaveBeenCalled();
  });

  it("keeps provider-template deeplink preview-only when provider gate profile is on", async () => {
    const providerService = makeMockProviderService();
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      providerService,
      canonicalMutatingActionGate: true,
    });
    const route = runtime.routes.getRoutes().find((entry) => entry.operationId === "deeplink.apply")!;

    const result = await route.handler({
      requestId: "req-deeplink-provider-on",
      receivedAt: NOW,
      params: {},
      query: {},
      body: {
        confirmed: true,
        planDigest: "deeplink-provider-runtime-plan-1",
        payload: {
          version: 1,
          type: "provider-template",
          label: "Imported OpenAI",
          providerTemplate: {
            providerKind: "openai",
            apiKey: "sk-test", // pragma: allowlist secret -- fixture value for deeplink provider import coverage
            model: "gpt-4o-mini",
          },
        },
      },
      headers: {},
      principal: makePrincipal({ role: "admin", scopes: ["hub.admin"] }),
    });

    expect(result).toMatchObject({
      result: {
        applied: false,
        resourceType: "provider-template",
      },
    });
    expect(String((result as { result?: { message?: string } }).result?.message)).toContain("preview-only");
    expect(providerService.createProvider).not.toHaveBeenCalled();
  });

  it("does not require model-routing canonical approval when canonical gate profile is off", async () => {
    const providerService = makeMockProviderService();
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      providerService,
      canonicalMutatingActionGate: false,
    });
    const route = runtime.routes.getRoutes().find((entry) => entry.operationId === "providers.routing.set")!;
    const routingBody = {
      defaultProviderId: "p-1",
      fallbackProviderIds: [],
    };

    await route.handler({
      requestId: "req-routing-off",
      receivedAt: NOW,
      params: {},
      query: {},
      body: routingBody,
      headers: {},
      principal: makePrincipal({ role: "admin", scopes: ["hub.admin"] }),
    });

    expect(providerService.setRoutingConfig).toHaveBeenCalledWith(routingBody);
  });

  it("requires signed model-routing canonical approval when runtime canonical gate profile is on", async () => {
    const providerService = makeMockProviderService();
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      providerService,
      canonicalMutatingActionGate: true,
    });
    const route = runtime.routes.getRoutes().find((entry) => entry.operationId === "providers.routing.set")!;
    const baseCtx = {
      requestId: "req-routing-on",
      receivedAt: NOW,
      params: {},
      query: {},
      body: {
        defaultProviderId: "p-1",
        fallbackProviderIds: [],
        planDigest: "provider-routing-plan-1",
      },
      headers: {},
      principal: makePrincipal({
        role: "admin",
        scopes: ["hub.admin"],
        principalId: RUNTIME_OWNER_PRINCIPAL,
      }),
    };

    let actionDigest = "";
    await route.handler(baseCtx).catch((error: unknown) => {
      expect(error).toBeInstanceOf(FridayDomainError);
      const domainError = error as FridayDomainError;
      expect(domainError.code).toBe("CANONICAL_APPROVAL_REQUIRED");
      const gate = domainError.details.canonicalGate as { actionDigest?: string } | undefined;
      actionDigest = gate?.actionDigest ?? "";
    });
    expect(actionDigest).toBeTruthy();
    expect(providerService.setRoutingConfig).not.toHaveBeenCalled();

    const result = await route.handler({
      ...baseCtx,
      body: {
        ...baseCtx.body,
        canonicalApproval: runtimeDeviceApproval(actionDigest, "provider-routing-runtime-approval"),
      },
    });

    expect(providerService.setRoutingConfig).toHaveBeenCalledWith({
      defaultProviderId: "p-1",
      fallbackProviderIds: [],
    });
    expect(result).toHaveProperty("canonicalGate.ticketId");
  });

  it("derives health enabled channel kinds from a live runtime getter", async () => {
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      supportedChannelKinds: ["webchat", "irc"],
      enabledChannelKinds: () => ["webchat"],
    });

    const route = runtime.routes.getRoutes().find((entry) => entry.operationId === "health.capabilities");
    expect(route).toBeDefined();

    const result = await route!.handler({
      params: {},
      query: {},
      body: null,
      headers: {},
      principal: null,
      requestId: "req-health-runtime-1",
      receivedAt: NOW,
    } as never) as {
      capabilities: {
        channels: {
          supportedKinds: string[];
          enabledKinds: string[];
          webhookEndpoints?: {
            line: boolean;
            whatsapp: boolean;
            telegram: boolean;
            lark: boolean;
          };
        };
        mcp?: { enabled: boolean };
        packaging?: { enabled: boolean };
      };
    };

    expect(result.capabilities.channels.supportedKinds).toEqual(["webchat", "irc"]);
    expect(result.capabilities.channels.enabledKinds).toEqual(["webchat"]);
    expect(result.capabilities.channels.webhookEndpoints).toEqual({
      line: false,
      whatsapp: false,
      telegram: false,
      lark: false,
    });
    expect(result.capabilities.mcp?.enabled).toBe(false);
    expect(result.capabilities.packaging?.enabled).toBe(false);
  });

  it("registers optional extended route families when deps are provided", () => {
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      configManager: makeMockConfigManager(),
      multiTenantSecurity: {} as FridayMultiTenantSecurityRoutesDeps,
      observability: {} as FridayObservabilityRoutesDeps,
      desktop: {} as FridayDesktopRoutesDeps,
      channels: {
        registry: {
          listViews: vi.fn(() => []),
          describe: vi.fn(() => undefined),
        },
      } as unknown as FridayChannelRoutesDeps,
      system: {} as FridaySystemRoutesDeps,
      discovery: {} as FridayDiscoveryRoutesDeps,
      mcpServer: {} as FridayMcpServerRoutesDeps,
      satellitePairing: {} as FridaySatellitePairingRoutesDeps,
      satelliteRuntime: {
        recordHeartbeat: vi.fn(),
        updateCapabilities: vi.fn(),
        pullSync: vi.fn(),
        pushSync: vi.fn(),
        pollCommands: vi.fn(() => []),
        ackCommand: vi.fn(() => ({ acked: true })),
      } as unknown as Omit<FridaySatelliteRuntimeRoutesDeps, "pullEvents" | "getCheckpoint">,
      diagnosis: {
        service: {
          listIncidents: vi.fn(() => []),
          getIncident: vi.fn(() => null),
          getIncidentDiagnosis: vi.fn(() => null),
          listActions: vi.fn(() => []),
          getAction: vi.fn(() => null),
          approveAction: vi.fn(),
          denyAction: vi.fn(),
          manualResolveIncident: vi.fn(),
          executeAction: vi.fn(),
          runReadyActions: vi.fn(),
          rollbackAction: vi.fn(),
          getMetrics: vi.fn(),
          listIssueCards: vi.fn(() => []),
          reportStructuredFailure: vi.fn(),
          emitProcessResults: vi.fn(),
        },
      } as unknown as FridayDiagnosisRoutesDeps,
      autoFix: {
        service: {
          listIncidents: vi.fn(() => []),
          getIncident: vi.fn(() => null),
          getIncidentDiagnosis: vi.fn(() => null),
          listActions: vi.fn(() => []),
          getAction: vi.fn(() => null),
          approveAction: vi.fn(),
          denyAction: vi.fn(),
          manualResolveIncident: vi.fn(),
          executeAction: vi.fn(),
          runReadyActions: vi.fn(),
          rollbackAction: vi.fn(),
          getMetrics: vi.fn(),
          listIssueCards: vi.fn(() => []),
          reportStructuredFailure: vi.fn(),
          emitProcessResults: vi.fn(),
        },
      } as unknown as FridayAutoFixRoutesDeps,
      agentLoop: {
        service: {
          getPolicy: vi.fn(),
          updatePolicy: vi.fn(),
          listRuns: vi.fn(() => []),
          getRun: vi.fn(() => null),
          pauseRun: vi.fn(),
          resumeRun: vi.fn(),
          cancelRun: vi.fn(),
          handleProcessResults: vi.fn(),
          syncAction: vi.fn(),
          findRunByActionId: vi.fn(() => null),
          findRunByIncidentId: vi.fn(() => null),
        },
      } as unknown as FridayAgentLoopRoutesDeps,
      uix: {
        service: {
          resolveIntent: vi.fn(),
          listTemplates: vi.fn(() => []),
          getDiagnostics: vi.fn(() => ({
            generatedAt: "2026-03-25T00:00:00.000Z",
            taskProfilePresets: [],
            recentRuns: [],
            mcpServerStates: [],
            supportedPreprocessors: [],
          })),
          executeTemplate: vi.fn(),
          startWizard: vi.fn(),
          continueWizard: vi.fn(),
          listIssues: vi.fn(() => []),
        },
      } as unknown as FridayUixRoutesDeps,
    });

    const operationIds = runtime.routes.getRoutes().map((route) => route.operationId);
    expect(operationIds).toContain("security.tenants.list");
    expect(operationIds).toContain("observability.traces.search");
    expect(operationIds).toContain("config.get");
    expect(operationIds).toContain("audit.logs.list");
    expect(operationIds).toContain("desktop.actions.execute");
    expect(operationIds).toContain("channels.list");
    expect(operationIds).toContain("system.session.get");
    expect(operationIds).toContain("discovery.scan");
    expect(operationIds).toContain("mcp.server.rpc");
    expect(operationIds).toContain("satellites.register");
    expect(operationIds).toContain("satellites.heartbeat");
    expect(operationIds).toContain("diagnosis.incidents.list");
    expect(operationIds).toContain("autofix.actions.list");
    expect(operationIds).toContain("agent.loop.policy.get");
    expect(operationIds).toContain("uix.templates.list");
  });

  it("enforces tenant boundary on multi-tenant routes for non-privileged principals", async () => {
    const tenantsGet = vi.fn(() => ({ tenant: { id: "tenant-a" } }));
    const multiTenantSecurity = {
      tenants: {
        create: vi.fn(),
        list: vi.fn(),
        get: tenantsGet,
        update: vi.fn(),
        delete: vi.fn(),
      },
      workspaces: {
        create: vi.fn(),
        list: vi.fn(),
        get: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      members: {
        add: vi.fn(),
        list: vi.fn(),
        revoke: vi.fn(),
      },
      roles: {
        create: vi.fn(),
        list: vi.fn(),
        get: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      assignments: {
        grant: vi.fn(),
        list: vi.fn(),
        revoke: vi.fn(),
      },
      secrets: {
        create: vi.fn(),
        list: vi.fn(),
        get: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        rotate: vi.fn(),
        listAccessLog: vi.fn(),
      },
      policies: {
        create: vi.fn(),
        list: vi.fn(),
        get: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        evaluate: vi.fn(),
      },
      audit: {
        list: vi.fn(),
      },
      violations: {
        list: vi.fn(),
        resolve: vi.fn(),
      },
    } as unknown as FridayMultiTenantSecurityRoutesDeps;

    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      multiTenantSecurity,
    });
    const route = runtime.routes
      .getRoutes()
      .find((entry) => entry.operationId === "security.tenants.get");
    expect(route).toBeDefined();

    await expect(route!.handler({
      params: { tenantId: "tenant-a" },
      query: {},
      body: null,
      headers: {},
      principal: makePrincipal({
        principalId: "tenant-b",
        scopes: ["security.read"],
      }),
      requestId: "req-1",
      receivedAt: NOW,
    } as never)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(tenantsGet).not.toHaveBeenCalled();
  });

  it("allows tenant-scoped multi-tenant route access for same-tenant principals", async () => {
    const tenantsGet = vi.fn(() => ({ tenant: { id: "tenant-a" } }));
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      multiTenantSecurity: {
        tenants: {
          create: vi.fn(),
          list: vi.fn(),
          get: tenantsGet,
          update: vi.fn(),
          delete: vi.fn(),
        },
        workspaces: {
          create: vi.fn(),
          list: vi.fn(),
          get: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        },
        members: {
          add: vi.fn(),
          list: vi.fn(),
          revoke: vi.fn(),
        },
        roles: {
          create: vi.fn(),
          list: vi.fn(),
          get: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        },
        assignments: {
          grant: vi.fn(),
          list: vi.fn(),
          revoke: vi.fn(),
        },
        secrets: {
          create: vi.fn(),
          list: vi.fn(),
          get: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
          rotate: vi.fn(),
          listAccessLog: vi.fn(),
        },
        policies: {
          create: vi.fn(),
          list: vi.fn(),
          get: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
          evaluate: vi.fn(),
        },
        audit: {
          list: vi.fn(),
        },
        violations: {
          list: vi.fn(),
          resolve: vi.fn(),
        },
      } as unknown as FridayMultiTenantSecurityRoutesDeps,
    });

    const route = runtime.routes
      .getRoutes()
      .find((entry) => entry.operationId === "security.tenants.get");
    expect(route).toBeDefined();

    await expect(route!.handler({
      params: { tenantId: "tenant-a" },
      query: {},
      body: null,
      headers: {},
      principal: makePrincipal({
        principalId: "tenant-a",
        scopes: ["security.read"],
      }),
      requestId: "req-2",
      receivedAt: NOW,
    } as never)).resolves.toMatchObject({
      tenant: { id: "tenant-a" },
    });
    expect(tenantsGet).toHaveBeenCalledTimes(1);
  });

  it("allows privileged principals to access cross-tenant security routes", async () => {
    const tenantsGet = vi.fn(() => ({ tenant: { id: "tenant-a" } }));
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      multiTenantSecurity: {
        tenants: {
          create: vi.fn(),
          list: vi.fn(),
          get: tenantsGet,
          update: vi.fn(),
          delete: vi.fn(),
        },
        workspaces: {
          create: vi.fn(),
          list: vi.fn(),
          get: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        },
        members: {
          add: vi.fn(),
          list: vi.fn(),
          revoke: vi.fn(),
        },
        roles: {
          create: vi.fn(),
          list: vi.fn(),
          get: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        },
        assignments: {
          grant: vi.fn(),
          list: vi.fn(),
          revoke: vi.fn(),
        },
        secrets: {
          create: vi.fn(),
          list: vi.fn(),
          get: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
          rotate: vi.fn(),
          listAccessLog: vi.fn(),
        },
        policies: {
          create: vi.fn(),
          list: vi.fn(),
          get: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
          evaluate: vi.fn(),
        },
        audit: {
          list: vi.fn(),
        },
        violations: {
          list: vi.fn(),
          resolve: vi.fn(),
        },
      } as unknown as FridayMultiTenantSecurityRoutesDeps,
    });

    const route = runtime.routes
      .getRoutes()
      .find((entry) => entry.operationId === "security.tenants.get");
    expect(route).toBeDefined();

    await expect(route!.handler({
      params: { tenantId: "tenant-a" },
      query: {},
      body: null,
      headers: {},
      principal: makePrincipal({
        principalId: "tenant-b",
        role: "admin",
        scopes: ["security.read"],
      }),
      requestId: "req-3",
      receivedAt: NOW,
    } as never)).resolves.toMatchObject({
      tenant: { id: "tenant-a" },
    });
    expect(tenantsGet).toHaveBeenCalledTimes(1);
  });

  it("blocks satellite principals from tenant-scoped security routes", async () => {
    const tenantsGet = vi.fn(() => ({ tenant: { id: "tenant-a" } }));
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      multiTenantSecurity: {
        tenants: {
          create: vi.fn(),
          list: vi.fn(),
          get: tenantsGet,
          update: vi.fn(),
          delete: vi.fn(),
        },
        workspaces: {
          create: vi.fn(),
          list: vi.fn(),
          get: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        },
        members: {
          add: vi.fn(),
          list: vi.fn(),
          revoke: vi.fn(),
        },
        roles: {
          create: vi.fn(),
          list: vi.fn(),
          get: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        },
        assignments: {
          grant: vi.fn(),
          list: vi.fn(),
          revoke: vi.fn(),
        },
        secrets: {
          create: vi.fn(),
          list: vi.fn(),
          get: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
          rotate: vi.fn(),
          listAccessLog: vi.fn(),
        },
        policies: {
          create: vi.fn(),
          list: vi.fn(),
          get: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
          evaluate: vi.fn(),
        },
        audit: {
          list: vi.fn(),
        },
        violations: {
          list: vi.fn(),
          resolve: vi.fn(),
        },
      } as unknown as FridayMultiTenantSecurityRoutesDeps,
    });

    const route = runtime.routes
      .getRoutes()
      .find((entry) => entry.operationId === "security.tenants.get");
    expect(route).toBeDefined();

    await expect(route!.handler({
      params: { tenantId: "tenant-a" },
      query: {},
      body: null,
      headers: {},
      principal: makePrincipal({
        principalType: "satellite",
        principalId: "tenant-a",
        userId: undefined,
        role: "viewer",
        scopes: ["security.read"],
      }),
      requestId: "req-4",
      receivedAt: NOW,
    } as never)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(tenantsGet).not.toHaveBeenCalled();
  });

});
