import { describe, expect, it } from "vitest";

import {
  buildFridayCustomPackPromptFragment,
  findFridayCustomPackById,
} from "../../../../src/packs/custom/friday-custom-pack-context.js";

describe("friday-custom-pack-context", () => {
  it("resolves a persisted custom pack from packs.customInputs using the canonical pack id", () => {
    const resolved = findFridayCustomPackById([
      {
        name: "Weekly Ops",
        nameEn: "Weekly Ops",
        description: "Track real operating tasks",
        descriptionEn: "Track real operating tasks",
        skillIds: ["ops-review"],
        entryPrompts: ["Review this week's ops queue"],
      },
      {
        name: "Creator Pipeline",
        nameEn: "Creator Pipeline",
        description: "Keep the creator workflow moving",
        descriptionEn: "Keep the creator workflow moving",
        skillIds: ["content-calendar"],
        entryPrompts: ["Plan the next creator sprint"],
      },
    ], "custom-1-creator-pipeline");

    expect(resolved).not.toBeNull();
    expect(resolved?.index).toBe(1);
    expect(resolved?.input.name).toBe("Creator Pipeline");
  });

  it("builds a prompt fragment with the persisted definition and recent live runs", () => {
    const pack = findFridayCustomPackById([
      {
        name: "真实任务连线测试",
        nameEn: "Real Task Wire Test",
        description: "验证自创任务和真实 run 的后端链路。",
        descriptionEn: "Verify the backend path between the custom task and live runs.",
        skillIds: ["runtime-check", "ops-review"],
        entryPrompts: [
          "先检查真实后端链路，再告诉我下一步。",
          "如果已经有 run，直接继续真实上下文。",
        ],
      },
    ], "custom-0-真实任务连线测试");

    expect(pack).not.toBeNull();

    const fragment = buildFridayCustomPackPromptFragment({
      packId: "custom-0-真实任务连线测试",
      pack: pack!,
      recentRuns: [
        {
          id: "run-1",
          task: "执行用户自创任务包「真实任务连线测试」。",
          status: "completed",
          sessionKey: "session-1",
          attempt: 1,
          maxAttempts: 3,
          createdAt: "2026-04-21T20:00:00.000Z",
          startedAt: "2026-04-21T20:00:01.000Z",
          completedAt: "2026-04-21T20:00:30.000Z",
          summary: "已经验证 packs.customInputs 与 friday_agent_runs 的真实关联。",
          metadata: {
            packContext: {
              packId: "custom-0-真实任务连线测试",
              surface: "packs",
              updatedAt: "2026-04-21T20:00:01.000Z",
            },
            apiRequest: {
              operationId: "agent.runs.start",
              idempotencyKey: "pack-start:test",
              payloadHash: "hash",
              receivedAt: "2026-04-21T20:00:00.000Z",
              principalId: "admin-001",
            },
          },
        },
      ],
    });

    expect(fragment).toContain("<active-custom-pack>");
    expect(fragment).toContain("Use this stored custom-pack brief as the authoritative source for the current run.");
    expect(fragment).toContain("Stored pack name: 真实任务连线测试");
    expect(fragment).toContain("Stored pack brief: 验证自创任务和真实 run 的后端链路。");
    expect(fragment).toContain("Recent live runs for this pack:");
    expect(fragment).toContain("[completed] 2026-04-21T20:00:30.000Z");
    expect(fragment).toContain("runtime-check");
    expect(fragment).not.toContain("pack_id:");
  });
});
