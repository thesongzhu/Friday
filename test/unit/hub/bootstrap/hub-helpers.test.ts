import { describe, expect, it } from "vitest";
import type { FridaySkillRegistry } from "#skills";
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

  it("fails closed for pause_workflow", async () => {
    const support = createFridayHubAutoFixExecutionSupport({
      registry: makeRegistry(true),
      memoryState: createStubMemoryState(),
      nowIso: () => "2026-03-13T10:00:00.000Z",
    });

    await expect(support.stepExecutors.pause_workflow?.({
      stepId: "step-pause-001",
      kind: "pause_workflow",
      target: "wf-123",
      payload: {},
    })).resolves.toBe(false);
    await expect(support.stepVerifiers.pause_workflow?.({
      stepId: "step-pause-001",
      kind: "pause_workflow",
      target: "wf-123",
      payload: {},
      verify: { method: "error_absent", timeoutMs: 5000 },
    })).resolves.toBe(false);
  });
});
