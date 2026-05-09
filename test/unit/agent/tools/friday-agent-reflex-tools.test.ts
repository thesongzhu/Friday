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

  it("lets the agent approve a strictly low-risk ordinary memory candidate", async () => {
    const getCandidate = vi.fn().mockReturnValue({
      id: "memory-1",
      userId: "user-1",
      kind: "memory",
      status: "ready_for_review",
      origin: "post_run",
      title: "Remember concise summaries",
      summary: "Alice prefers concise summaries for status updates.",
      payload: { namespace: "user_preferences", content: "Alice prefers concise summaries for status updates." },
      evidence: { evidenceCount: 2 },
      confidence: 0.9,
      riskTier: 1,
      createdAt: "2026-05-09T00:00:00.000Z",
      updatedAt: "2026-05-09T00:00:00.000Z",
    });
    const approveCandidate = vi.fn().mockResolvedValue({ id: "memory-1", status: "approved" });
    const tools = createFridayAgentReflexTools({
      reflexService: {
        getCandidate,
        approveCandidate,
      } as never,
      defaultUserId: "user-1",
    });
    const tool = tools.find((item) => item.name === "reflex_candidate_decide");

    const result = await tool!.execute({
      candidateId: "memory-1",
      action: "approve",
      __principalId: "user-1",
    }, new AbortController().signal);

    expect(approveCandidate).toHaveBeenCalledWith({ userId: "user-1", candidateId: "memory-1" });
    expect(JSON.parse(result.content as string)).toMatchObject({ id: "memory-1", status: "approved" });
  });

  it("blocks agent approval of high-impact memory candidates", async () => {
    const approveCandidate = vi.fn();
    const tools = createFridayAgentReflexTools({
      reflexService: {
        getCandidate: vi.fn().mockReturnValue({
          id: "memory-2",
          userId: "user-1",
          kind: "memory",
          status: "ready_for_review",
          origin: "post_run",
          title: "Remember provider routing behavior",
          summary: "Alice wants provider routing behavior changed.",
          payload: { content: "Provider routing behavior should change." },
          evidence: { evidenceCount: 2 },
          confidence: 0.9,
          riskTier: 1,
          createdAt: "2026-05-09T00:00:00.000Z",
          updatedAt: "2026-05-09T00:00:00.000Z",
        }),
        approveCandidate,
      } as never,
      defaultUserId: "user-1",
    });
    const tool = tools.find((item) => item.name === "reflex_candidate_decide");

    const result = await tool!.execute({
      candidateId: "memory-2",
      action: "approve",
      __principalId: "user-1",
    }, new AbortController().signal);

    expect(approveCandidate).not.toHaveBeenCalled();
    expect(JSON.parse(result.content as string)).toMatchObject({
      status: "blocked",
      code: "REFLEX_CANDIDATE_USER_CONFIRMATION_REQUIRED",
      kind: "memory",
    });
  });

  it("blocks mislabeled high-impact communication/uix preference candidates", async () => {
    const approveCandidate = vi.fn();
    const tools = createFridayAgentReflexTools({
      reflexService: {
        getCandidate: vi.fn().mockReturnValue({
          id: "pref-1",
          userId: "user-1",
          kind: "preference",
          status: "ready_for_review",
          origin: "post_run",
          title: "Change workflow execution setting",
          summary: "Looks like a UI preference but changes workflow execution.",
          payload: {
            category: "uix",
            key: "workflow.execution.mode",
            value: "auto",
          },
          evidence: { evidenceCount: 1 },
          confidence: 0.9,
          riskTier: 1,
          createdAt: "2026-05-09T00:00:00.000Z",
          updatedAt: "2026-05-09T00:00:00.000Z",
        }),
        approveCandidate,
      } as never,
      defaultUserId: "user-1",
    });
    const tool = tools.find((item) => item.name === "reflex_candidate_decide");

    const result = await tool!.execute({
      candidateId: "pref-1",
      action: "approve",
      __principalId: "user-1",
    }, new AbortController().signal);

    expect(approveCandidate).not.toHaveBeenCalled();
    expect(JSON.parse(result.content as string)).toMatchObject({
      status: "blocked",
      code: "REFLEX_CANDIDATE_USER_CONFIRMATION_REQUIRED",
      kind: "preference",
    });
  });

  it("blocks agent approval of skill and workflow candidates", async () => {
    const approveCandidate = vi.fn();
    const tools = createFridayAgentReflexTools({
      reflexService: {
        getCandidate: vi.fn().mockReturnValue({
          id: "skill-1",
          userId: "user-1",
          kind: "skill",
          status: "ready_for_review",
          origin: "post_run",
          title: "Generate a helper skill",
          summary: "Repeated success suggests a new skill.",
          payload: { skillId: "helper" },
          evidence: { evidenceCount: 3 },
          confidence: 0.9,
          riskTier: 1,
          createdAt: "2026-05-09T00:00:00.000Z",
          updatedAt: "2026-05-09T00:00:00.000Z",
        }),
        approveCandidate,
      } as never,
      defaultUserId: "user-1",
    });
    const tool = tools.find((item) => item.name === "reflex_candidate_decide");

    const result = await tool!.execute({
      candidateId: "skill-1",
      action: "approve",
      __principalId: "user-1",
    }, new AbortController().signal);

    expect(approveCandidate).not.toHaveBeenCalled();
    expect(JSON.parse(result.content as string)).toMatchObject({
      status: "blocked",
      kind: "skill",
    });
  });
});
