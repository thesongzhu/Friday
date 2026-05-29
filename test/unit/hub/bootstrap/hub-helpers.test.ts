import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";
import type { FridaySkillRegistry, SkillLifecycleStatus } from "#skills";
import { createFridaySkillRepository } from "#skills";
import type { FridaySkillGeneratorService } from "#skills/generator";
import { createTestDb } from "../../../helpers/friday-test-db.helper.js";
import type { FridayProviderService } from "#providers";
import type { FridayWorkflowRuntime } from "#workflows";
import type { FridayHubConfigManagerService } from "../../../../src/hub/services/friday-hub-config-manager.types.js";
import { initializeFridayState } from "#state";
import {
  createFridayHubAutoFixExecutionSupport,
  createPersistentConfigManager,
  createStubMemoryState,
} from "../../../../src/hub/bootstrap/index.js";
import { createDurableMemoryState } from "../../../../src/hub/bootstrap/hub-helpers.js";
import {
  buildFridayChannelDeliveryFailureText,
  buildFridayChannelMessageTooLongText,
  resolveFridayChannelTerminalText,
} from "../../../../src/hub/bootstrap/hub-helpers.js";

describe("createFridayHubAutoFixExecutionSupport", () => {
  function makeRegistry(hasSkill = true): FridaySkillRegistry {
    return {
      list: () => [],
      get: (skillId: string) => {
        if (!hasSkill || skillId !== "skill-x") {
          return null;
        }
        return {} as ReturnType<FridaySkillRegistry["get"]>;
      },
      resolveByIntent: () => null,
      validateAll: () => [],
      reload: async () => {},
      refresh: async () => {},
      isCompatible: () => ({ compatible: true, reasons: [] }),
      startWatching: async () => {},
      stopWatching: async () => {},
      close: async () => {},
    };
  }

  function makeWorkflowRuntime(
    retryOutcomeStatus: "retrying" | "completed" | "failed" = "completed",
  ): FridayWorkflowRuntime {
    const run = { id: "run-1", status: "running" } as ReturnType<FridayWorkflowRuntime["execution"]["getRun"]> extends infer T ? NonNullable<T> : never;
    const nodes = [
      { nodeId: "node-a", attempt: 1, status: "failed" },
    ] as Array<{ nodeId: string; attempt: number; status: string }>;
    return {
      crud: {} as FridayWorkflowRuntime["crud"],
      triggers: {} as FridayWorkflowRuntime["triggers"],
      approval: {} as FridayWorkflowRuntime["approval"],
      evidence: {} as FridayWorkflowRuntime["evidence"],
      execution: {
        setDistributedDispatcher: async () => {},
        startRun: async () => run as never,
        resumeRun: async () => run as never,
        pauseRun: async () => {
          (run as { status: string }).status = "paused";
          return run as never;
        },
        cancelRun: async () => run as never,
        retryRun: async () => {
          nodes.push({ nodeId: "node-a", attempt: 2, status: retryOutcomeStatus });
          (run as { status: string }).status = retryOutcomeStatus === "failed"
            ? "failed"
            : retryOutcomeStatus === "completed"
              ? "completed"
              : "running";
          return run as never;
        },
        getRun: () => run as never,
        listRuns: () => [],
        listActiveRuns: () => [],
        getRunNodes: () => nodes as never,
        recoverActiveRuns: async () => 0,
        reportRemoteNodeResult: async () => run as never,
        reapExpiredLeases: async () => 0,
        sweepTimedOutRuns: async () => 0,
        sweepTimedOutNodes: async () => 0,
      },
    };
  }

  function makeProviderService(): FridayProviderService {
    let routing = {
      defaultProviderId: "provider-a",
      defaultModel: "gpt-old",
      fallbackProviderIds: ["provider-b"],
      costMode: "strict" as const,
    };
    const providers = [
      {
        id: "provider-a",
        name: "Provider A",
        kind: "openai",
        baseUrl: "https://api.openai.com",
        enabled: true,
        defaultModel: "gpt-old",
        config: {
          api: "openai-responses",
          authMode: "api-key",
          keySource: { kind: "none" as const },
          supportedModels: ["gpt-old"],
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "provider-b",
        name: "Provider B",
        kind: "openai",
        baseUrl: "https://api.openai.com",
        enabled: true,
        defaultModel: "gpt-5.4",
        config: {
          api: "openai-responses",
          authMode: "api-key",
          keySource: { kind: "none" as const },
          supportedModels: ["gpt-old", "gpt-5.4"],
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ] as Awaited<ReturnType<FridayProviderService["listProviders"]>>;

    return {
      listProviders: async () => providers,
      getProvider: async () => null,
      listAuthProfiles: async () => [],
      activateAuthProfile: async () => {
        throw new Error("not implemented");
      },
      doctorProvider: async () => {
        throw new Error("not implemented");
      },
      createProvider: async () => {
        throw new Error("not implemented");
      },
      updateProvider: async () => {
        throw new Error("not implemented");
      },
      deleteProvider: async () => {},
      validateProvider: async () => ({ status: "never" }),
      getRoutingConfig: async () => routing,
      setRoutingConfig: async (input) => {
        routing = { ...routing, ...input };
        return routing;
      },
      resolveRoute: async () => {
        throw new Error("not implemented");
      },
      runWithFallback: async () => {
        throw new Error("not implemented");
      },
      recordUsage: async () => {},
      getUsageSummary: async () => {
        throw new Error("not implemented");
      },
      getBudgetStatus: async () => {
        throw new Error("not implemented");
      },
      setBudgetConfig: async () => {
        throw new Error("not implemented");
      },
      initiateOAuthLogin: async () => {
        throw new Error("not implemented");
      },
      completeOAuthLogin: async () => {
        throw new Error("not implemented");
      },
    };
  }

  function makeConfigManager(): FridayHubConfigManagerService {
    let revision = 7;
    let revertedToRevision: number | undefined;
    return {
      getCurrentConfig: async () => ({}) as never,
      getConfig: async () => ({ revision, settings: {} }),
      validatePatch: async () => ({ valid: true, errors: [] }),
      applyPatch: async ({ expectedRevision }) => {
        expect(expectedRevision).toBe(revision);
        revision += 1;
        return { revision, changedKeys: ["provider.defaultModel"] };
      },
      listRevisions: async () => ({ items: [] }),
      revertToRevision: async (toRevision) => {
        revertedToRevision = toRevision;
        revision += 1;
        return { revision, changedKeys: ["provider.defaultModel"], revertedFrom: toRevision + 1 };
      },
      getSkillRegistrySettings: async () => ({
        workspaceDir: ".",
        bundledSkillsDir: "skills",
        managedSkillsDir: "managed-skills",
        extraSkillDirs: [],
        watchEnabled: false,
        watchDebounceMs: 300,
      }),
      getSkillSecurityProfile: async () => ({}),
      _getRevertedToRevision: () => revertedToRevision,
    } as FridayHubConfigManagerService & { _getRevertedToRevision(): number | undefined };
  }

  it("disables a skill and verifies the disabled state", async () => {
    const memoryState = createStubMemoryState();
    const support = createFridayHubAutoFixExecutionSupport({
      registry: makeRegistry(true),
      memoryState,
      nowIso: () => "2026-03-13T10:00:00.000Z",
    });
    const step = {
      stepId: "step-001",
      kind: "disable_skill" as const,
      target: "skill-x",
      payload: {},
      verify: { method: "error_absent" as const, timeoutMs: 5000 },
    };

    await expect(support.stepExecutors.disable_skill?.(step)).resolves.toBe(true);
    await expect(support.stepVerifiers.disable_skill?.(step)).resolves.toBe(true);

    const statuses = await memoryState.listSkillStatuses();
    expect(statuses["skill-x"]).toBe("disabled");
    expect(step.payload).toMatchObject({
      _skillDisabled: true,
      _skillStatusAfter: "disabled",
      _skillStatusTarget: "skill-x",
      _skillStatusAt: "2026-03-13T10:00:00.000Z",
    });
  });

  it("revert payload restores the installed state", async () => {
    const memoryState = createStubMemoryState();
    await memoryState.updateSkillStatus("skill-x", "disabled");
    const support = createFridayHubAutoFixExecutionSupport({
      registry: makeRegistry(true),
      memoryState,
      nowIso: () => "2026-03-13T10:00:00.000Z",
    });
    const step = {
      stepId: "rb-step-001",
      kind: "disable_skill" as const,
      target: "skill-x",
      payload: { revert: true },
      verify: { method: "error_absent" as const, timeoutMs: 5000 },
    };

    await expect(support.stepExecutors.disable_skill?.(step)).resolves.toBe(true);
    await expect(support.stepVerifiers.disable_skill?.(step)).resolves.toBe(true);

    const statuses = await memoryState.listSkillStatuses();
    expect(statuses["skill-x"]).toBe("installed");
    expect(step.payload).toMatchObject({
      _skillDisabled: false,
      _skillStatusAfter: "installed",
      _skillStatusTarget: "skill-x",
      _skillStatusAt: "2026-03-13T10:00:00.000Z",
    });
  });

  // ── self-heal skill-status durable persistence (residual E) ──
  // Durable persistence is provided by createDurableMemoryState (audit E3, PR #406): its
  // updateSkillStatus wrapper persists explicit transitions to the skills table (the source the
  // workflow-exec safety gate reads). These tests verify self-heal writes the RIGHT status through
  // that single wrapper — the regenerate_skill rollback restores the plan-captured prior status
  // (capture-restore), never a default-enable and never promoting a not_installed candidate.
  // (createDurableMemoryState's persistence itself is covered by friday-durable-memory-state.test.ts.)
  function makeRegistryWith(ids: readonly string[]): FridaySkillRegistry {
    const set = new Set(ids);
    return {
      list: () => [],
      get: (skillId: string) => (set.has(skillId) ? ({} as ReturnType<FridaySkillRegistry["get"]>) : null),
      resolveByIntent: () => null,
      validateAll: () => [],
      reload: async () => {},
      refresh: async () => {},
      isCompatible: () => ({ compatible: true, reasons: [] }),
      startWatching: async () => {},
      stopWatching: async () => {},
      close: async () => {},
    };
  }
  const skillGenStub = {
    startSession: async () => ({ session: { sessionId: "sess-1" } }),
    generateDraft: async () => ({ manifest: { name: "Skill X" } }),
    approveAndSave: async () => ({ candidateId: "cand-1" }),
  } as unknown as FridaySkillGeneratorService;
  const E3_NOW = "2026-03-13T10:00:00.000Z";
  const seedSkill = (
    db: ReturnType<typeof createTestDb>,
    repo: ReturnType<typeof createFridaySkillRepository>,
    id: string,
    status: SkillLifecycleStatus,
  ) =>
    db.withWriteTransaction((conn) =>
      repo.upsertSkillFromCatalog(conn, { id, name: id, source: "local", origin: "workspace", status, nowIso: E3_NOW }),
    );
  const tableStatus = (
    db: ReturnType<typeof createTestDb>,
    repo: ReturnType<typeof createFridaySkillRepository>,
    id: string,
  ) => db.withReadConnection((conn) => repo.getSkillById(conn, id)?.status);

  it("self-heal disable persists 'disabled' durably via the createDurableMemoryState wrapper (single path)", async () => {
    const db = createTestDb();
    try {
      const repo = createFridaySkillRepository();
      seedSkill(db, repo, "skill-x", "installed");
      const support = createFridayHubAutoFixExecutionSupport({
        registry: makeRegistryWith(["skill-x"]),
        memoryState: createDurableMemoryState({ db, skillRepository: repo, nowIso: () => E3_NOW }),
        nowIso: () => E3_NOW,
      });
      const step = { stepId: "d1", kind: "disable_skill" as const, target: "skill-x", payload: {} as Record<string, unknown>, verify: { method: "error_absent" as const, timeoutMs: 5000 } };
      await expect(support.stepExecutors.disable_skill?.(step)).resolves.toBe(true);
      expect(tableStatus(db, repo, "skill-x")).toBe("disabled"); // durable via the #406 wrapper
      // No second persist path: the executor no longer accepts a persist dep, so there is exactly
      // one durable write (the wrapper) and no _skillStatusDurable flag on the payload.
      expect(step.payload).not.toHaveProperty("_skillStatusDurable");
    } finally {
      db.close();
    }
  });

  it("regenerate rollback restores the plan-captured prior status durably (installed/not_installed), never default-enable", async () => {
    const db = createTestDb();
    try {
      const repo = createFridaySkillRepository();
      seedSkill(db, repo, "skill-x", "installed");
      seedSkill(db, repo, "skill-c", "not_installed");
      const support = createFridayHubAutoFixExecutionSupport({
        registry: makeRegistryWith(["skill-x", "skill-c"]),
        memoryState: createDurableMemoryState({ db, skillRepository: repo, nowIso: () => E3_NOW }),
        nowIso: () => E3_NOW,
        skillGenerator: skillGenStub,
      });
      const rev = (id: string, restoreStatus: string) => ({ stepId: "r-" + id, kind: "regenerate_skill" as const, target: id, payload: { revert: true, skillId: id, restoreStatus } as Record<string, unknown>, verify: { method: "skill_registry_available" as const, timeoutMs: 5000 } });
      await expect(support.stepExecutors.regenerate_skill?.(rev("skill-x", "installed"))).resolves.toBe(true);
      expect(tableStatus(db, repo, "skill-x")).toBe("installed"); // restored installed
      await expect(support.stepExecutors.regenerate_skill?.(rev("skill-c", "not_installed"))).resolves.toBe(true);
      expect(tableStatus(db, repo, "skill-c")).toBe("not_installed"); // restored candidate, NOT promoted
    } finally {
      db.close();
    }
  });

  it("false-positive regenerate rollback keeps an already-disabled skill disabled (durable), never re-enabled", async () => {
    const db = createTestDb();
    try {
      const repo = createFridaySkillRepository();
      seedSkill(db, repo, "skill-x", "installed");
      const support = createFridayHubAutoFixExecutionSupport({
        registry: makeRegistryWith(["skill-x"]),
        memoryState: createDurableMemoryState({ db, skillRepository: repo, nowIso: () => E3_NOW }),
        nowIso: () => E3_NOW,
        skillGenerator: skillGenStub,
      });
      // captured prior status was 'disabled' (a false-positive regenerate on an already-disabled skill)
      const step = { stepId: "r-fp", kind: "regenerate_skill" as const, target: "skill-x", payload: { revert: true, skillId: "skill-x", restoreStatus: "disabled" } as Record<string, unknown>, verify: { method: "skill_registry_available" as const, timeoutMs: 5000 } };
      await expect(support.stepExecutors.regenerate_skill?.(step)).resolves.toBe(true);
      expect(tableStatus(db, repo, "skill-x")).toBe("disabled"); // stayed disabled, not re-enabled
    } finally {
      db.close();
    }
  });

  it("regenerate rollback with no captured restoreStatus falls back to the safe 'disabled' (never enable)", async () => {
    const db = createTestDb();
    try {
      const repo = createFridaySkillRepository();
      seedSkill(db, repo, "skill-x", "installed");
      const support = createFridayHubAutoFixExecutionSupport({
        registry: makeRegistryWith(["skill-x"]),
        memoryState: createDurableMemoryState({ db, skillRepository: repo, nowIso: () => E3_NOW }),
        nowIso: () => E3_NOW,
        skillGenerator: skillGenStub,
      });
      const step = { stepId: "r-none", kind: "regenerate_skill" as const, target: "skill-x", payload: { revert: true, skillId: "skill-x" } as Record<string, unknown>, verify: { method: "skill_registry_available" as const, timeoutMs: 5000 } };
      await expect(support.stepExecutors.regenerate_skill?.(step)).resolves.toBe(true);
      expect(tableStatus(db, repo, "skill-x")).toBe("disabled"); // safe default, not enabled
    } finally {
      db.close();
    }
  });

  it("Phase 14.5B module_28b: apply_config_patch is fail-closed when no real patch payload is provided", async () => {
    const support = createFridayHubAutoFixExecutionSupport({
      registry: makeRegistry(true),
      memoryState: createStubMemoryState(),
      nowIso: () => "2026-03-13T10:00:00.000Z",
    });
    const step = {
      stepId: "config-step-001",
      kind: "apply_config_patch" as const,
      target: "config",
      payload: { incidentId: "inc-config" } as Record<string, unknown>,
      verify: { method: "config_reload_valid" as const, timeoutMs: 5000 },
    };
    const rollbackStep = {
      stepId: "config-rb-001",
      kind: "apply_config_patch" as const,
      target: "config",
      payload: { incidentId: "inc-config", revert: true },
    };

    // Forward step without a real patch returns false (no diagnostic_marker
    // shortcut) and the verifier refuses the diagnostic-only payload.
    await expect(support.stepExecutors.apply_config_patch?.(step)).resolves.toBe(false);
    expect(step.payload._configPatchApplied).toBe(false);
    expect(step.payload._configPatchMode).toBe("diagnostic_only");
    expect(step.payload._configPatchRevision).toBeUndefined();
    await expect(support.stepVerifiers.apply_config_patch?.(step)).resolves.toBe(false);

    // Revert without configManager still records the rollback marker, since
    // the original rollback path is unchanged outside the forward fail-closed
    // boundary.
    await expect(support.stepExecutors.apply_config_patch?.(rollbackStep)).resolves.toBe(true);
    await expect(support.stepVerifiers.apply_config_patch?.(rollbackStep)).resolves.toBe(true);
  });

  it("uses the config manager when a concrete config patch is present", async () => {
    const configManager = makeConfigManager();
    const support = createFridayHubAutoFixExecutionSupport({
      registry: makeRegistry(true),
      memoryState: createStubMemoryState(),
      configManager,
      nowIso: () => "2026-03-13T10:00:00.000Z",
    });
    const step = {
      stepId: "config-step-002",
      kind: "apply_config_patch" as const,
      target: "config",
      payload: { patch: { provider: { defaultModel: "gpt-5.4" } } },
      verify: { method: "config_reload_valid" as const, timeoutMs: 5000 },
    };

    await expect(support.stepExecutors.apply_config_patch?.(step)).resolves.toBe(true);
    await expect(support.stepVerifiers.apply_config_patch?.(step)).resolves.toBe(true);
    expect(step.payload).toMatchObject({
      _configPatchApplied: true,
      _configPatchPreviousRevision: 7,
      _configPatchRevision: 8,
    });

    const rollbackStep = {
      stepId: "config-rb-002",
      kind: "apply_config_patch" as const,
      target: "config",
      payload: { revert: true, toRevision: 7 },
    };
    await expect(support.stepExecutors.apply_config_patch?.(rollbackStep)).resolves.toBe(true);
    await expect(support.stepVerifiers.apply_config_patch?.(rollbackStep)).resolves.toBe(true);
    expect((configManager as FridayHubConfigManagerService & { _getRevertedToRevision(): number | undefined })._getRevertedToRevision()).toBe(7);
  });

  it("retries a workflow node and verifies a new attempt exists", async () => {
    const support = createFridayHubAutoFixExecutionSupport({
      registry: makeRegistry(true),
      memoryState: createStubMemoryState(),
      workflowRuntime: makeWorkflowRuntime("completed"),
      nowIso: () => "2026-03-13T10:00:00.000Z",
    });

    const step = {
      stepId: "retry-step-001",
      kind: "retry_node" as const,
      target: "run-1",
      payload: { runId: "run-1", nodeId: "node-a" },
      verify: { method: "error_absent" as const, timeoutMs: 5000 },
    };

    await expect(support.stepExecutors.retry_node?.(step)).resolves.toBe(true);
    await expect(support.stepVerifiers.retry_node?.(step)).resolves.toBe(true);
  });

  it("fails retry verification when the new attempt immediately fails", async () => {
    const support = createFridayHubAutoFixExecutionSupport({
      registry: makeRegistry(true),
      memoryState: createStubMemoryState(),
      workflowRuntime: makeWorkflowRuntime("failed"),
      nowIso: () => "2026-03-13T10:00:00.000Z",
    });

    const step = {
      stepId: "retry-step-002",
      kind: "retry_node" as const,
      target: "run-1",
      payload: { runId: "run-1", nodeId: "node-a" },
      verify: { method: "error_absent" as const, timeoutMs: 100 },
    };

    await expect(support.stepExecutors.retry_node?.(step)).resolves.toBe(true);
    await expect(support.stepVerifiers.retry_node?.(step)).resolves.toBe(false);
  });

  it("pauses a workflow run and verifies the paused state", async () => {
    const support = createFridayHubAutoFixExecutionSupport({
      registry: makeRegistry(true),
      memoryState: createStubMemoryState(),
      workflowRuntime: makeWorkflowRuntime(),
      nowIso: () => "2026-03-13T10:00:00.000Z",
    });

    const step = {
      stepId: "pause-step-001",
      kind: "pause_workflow" as const,
      target: "run-1",
      payload: { runId: "run-1" },
      verify: { method: "error_absent" as const, timeoutMs: 5000 },
    };

    await expect(support.stepExecutors.pause_workflow?.(step)).resolves.toBe(true);
    await expect(support.stepVerifiers.pause_workflow?.(step)).resolves.toBe(true);
  });

  it("switches model routing to a verified fallback provider", async () => {
    const providerService = makeProviderService();
    const support = createFridayHubAutoFixExecutionSupport({
      registry: makeRegistry(true),
      memoryState: createStubMemoryState(),
      providerService,
      nowIso: () => "2026-03-13T10:00:00.000Z",
    });

    const step = {
      stepId: "switch-step-001",
      kind: "switch_model_fallback" as const,
      target: "provider-a",
      payload: { model: "gpt-5.4" },
      verify: { method: "error_absent" as const, timeoutMs: 5000 },
    };

    await expect(support.stepExecutors.switch_model_fallback?.(step)).resolves.toBe(true);
    await expect(support.stepVerifiers.switch_model_fallback?.(step)).resolves.toBe(true);
    await expect(providerService.getRoutingConfig()).resolves.toMatchObject({
      defaultProviderId: "provider-b",
      defaultModel: "gpt-5.4",
      costMode: "strict",
    });
  });

  it("trims oversized payload fields deterministically", async () => {
    const support = createFridayHubAutoFixExecutionSupport({
      registry: makeRegistry(true),
      memoryState: createStubMemoryState(),
      nowIso: () => "2026-03-13T10:00:00.000Z",
    });

    const step = {
      stepId: "trim-step-001",
      kind: "trim_payload" as const,
      target: "routing",
      payload: { prompt: "x".repeat(20), maxChars: 8 },
      verify: { method: "error_absent" as const, timeoutMs: 5000 },
    };

    await expect(support.stepExecutors.trim_payload?.(step)).resolves.toBe(true);
    await expect(support.stepVerifiers.trim_payload?.(step)).resolves.toBe(true);
    expect(typeof (step.payload as { prompt: string }).prompt).toBe("string");
    expect((step.payload as { prompt: string }).prompt.length).toBeLessThanOrEqual(8);
  });
});

describe("createPersistentConfigManager", () => {
  it("hydrates currentConfig with the actual runtime state dir and launch cwd", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-audit-state-"));
    const stateRuntime = initializeFridayState({
      env: {
        ...process.env,
        FRIDAY_STATE_DIR: stateDir,
      },
    });

    try {
      const manager = createPersistentConfigManager(
        {
          skillDirs: ["skills", "managed-skills"],
        },
        stateRuntime,
      );

      const current = await manager.getCurrentConfig();

      expect(current.runtimeStateDir).toBe(stateDir);
      expect(current.launchCwd).toBe(process.cwd());
      expect(current.configPath).toBe(path.join(stateDir, "friday.config.json5"));
    } finally {
      stateRuntime.close();
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  });
});

describe("channel helper copy", () => {
  it("localizes terminal fallback text for Chinese channel requests", () => {
    expect(resolveFridayChannelTerminalText({
      status: "completed",
      response: "",
      imageCount: 0,
      sourceText: "帮我生成报告",
    })).toBe("已完成。");

    expect(resolveFridayChannelTerminalText({
      status: "failed",
      response: "",
      imageCount: 0,
      sourceText: "帮我生成报告",
    })).toBe("请求失败，请重试。");
  });

  it("localizes delivery failure copy for Chinese channel requests", () => {
    expect(buildFridayChannelDeliveryFailureText("run-1", "请发到飞书")).toBe(
      "请求已完成，但消息发送失败（E-CH-OUTBOUND-001）。关联 ID：run-1。",
    );
  });

  it("localizes message-too-long copy for Chinese channel requests", () => {
    expect(buildFridayChannelMessageTooLongText(1000, "这条消息太长了")).toBe(
      "消息太长（最多 1000 个字符）。",
    );
    expect(buildFridayChannelMessageTooLongText(1000, "This message is too long")).toBe(
      "Message too long (max 1000 chars).",
    );
  });
});
