import { describe, expect, it } from "vitest";
import type { FridaySkillRegistry } from "#skills";
import type { FridayProviderService } from "#providers";
import type { FridayWorkflowRuntime } from "#workflows";
import {
  createFridayHubAutoFixExecutionSupport,
  createStubMemoryState,
} from "../../../../src/hub/bootstrap/index.js";

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

  function makeWorkflowRuntime(): FridayWorkflowRuntime {
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
          nodes.push({ nodeId: "node-a", attempt: 2, status: "retrying" });
          (run as { status: string }).status = "running";
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
  });

  it("retries a workflow node and verifies a new attempt exists", async () => {
    const support = createFridayHubAutoFixExecutionSupport({
      registry: makeRegistry(true),
      memoryState: createStubMemoryState(),
      workflowRuntime: makeWorkflowRuntime(),
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
