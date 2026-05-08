import { describe, expect, it, vi } from "vitest";

import { createFridayAgentReflexTools } from "../../../../src/agent/tools/friday-agent-reflex-tools.js";

describe("Friday agent Reflex tools", () => {
  it("routes preference updates through the confirmation-aware service path", async () => {
    const requestPreferenceUpdate = vi.fn().mockReturnValue({
      requiresConfirmation: true,
      candidate: {
        id: "candidate-1",
        status: "ready_for_review",
        kind: "preference",
      },
    });
    const updatePreference = vi.fn();
    const tools = createFridayAgentReflexTools({
      reflexService: {
        requestPreferenceUpdate,
        updatePreference,
      } as never,
      defaultUserId: "user-1",
    });
    const tool = tools.find((item) => item.name === "reflex_preference_update");

    const result = await tool!.execute({
      category: "reflex",
      key: "testing.live_llm_policy",
      value: "allowed_with_cost_notice",
      sourceSurface: "operate",
      __principalId: "user-1",
    }, new AbortController().signal);

    expect(requestPreferenceUpdate).toHaveBeenCalledWith({
      userId: "user-1",
      category: "reflex",
      key: "testing.live_llm_policy",
      value: "allowed_with_cost_notice",
      sourceSurface: "operate",
    });
    expect(updatePreference).not.toHaveBeenCalled();
    expect(JSON.parse(result.content as string)).toMatchObject({
      requiresConfirmation: true,
      candidate: {
        id: "candidate-1",
        status: "ready_for_review",
      },
    });
  });

  it("does not let the agent claim Review Center confirmation", async () => {
    const tools = createFridayAgentReflexTools({
      reflexService: {
        requestPreferenceUpdate: vi.fn(),
      } as never,
      defaultUserId: "user-1",
    });
    const tool = tools.find((item) => item.name === "reflex_preference_update");

    await expect(tool!.execute({
      category: "reflex",
      key: "testing.live_llm_policy",
      value: "allowed_with_cost_notice",
      sourceSurface: "review_center",
      __principalId: "user-1",
    }, new AbortController().signal)).rejects.toThrow("sourceSurface must be channel or operate");
  });
});
