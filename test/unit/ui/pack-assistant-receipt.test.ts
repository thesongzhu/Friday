import { describe, expect, it } from "vitest";
import type { AgentRunRecord } from "../../../ui/src/lib/api/types";
import { buildPackAssistantReceiptModel } from "../../../ui/src/lib/packs/pack-assistant-receipt";
import { getPackById } from "../../../ui/src/lib/packs/pack-registry";

function buildRun(overrides: Partial<AgentRunRecord>): AgentRunRecord {
  return {
    id: "run-1",
    task: "Build a weekly content calendar",
    status: "completed",
    sessionKey: "guided:content-social",
    startedAt: "2026-04-07T12:00:00.000Z",
    summary: "Drafted a weekly content calendar with hooks and follow-up themes.",
    ...overrides,
  };
}

describe("pack assistant receipt", () => {
  it("builds a ready handoff when a related run completed successfully", () => {
    const pack = getPackById("industry-creator-media");
    expect(pack?.productCopy).toBeTruthy();

    const receipt = buildPackAssistantReceiptModel({
      pack: pack!,
      runs: [
        buildRun({
          metadata: {
            packContext: {
              packId: "industry-creator-media",
              surface: "guided-flow",
              updatedAt: "2026-04-07T12:00:00.000Z",
            },
          },
          health: {
            state: "healthy",
            rollbackAvailable: false,
            reasonCodes: [],
          },
          contextSummary: {
            taskProfileId: "planning",
            taskProfileLabel: "Planning",
            totalEstimatedChars: 1400,
            dominantContextKinds: ["workspace_context"],
            learningAdjusted: true,
            fallbackAttemptCount: 0,
            blockedToolCount: 0,
          },
        }),
      ],
      locale: "zh",
      approvalsCount: 0,
      alertCount: 0,
    });

    expect(receipt).not.toBeNull();
    expect(receipt?.state).toBe("ready");
    expect(receipt?.stateLabel).toBe("正常");
    expect(receipt?.deliverables.every((item) => item.statusLabel === "已就绪")).toBe(true);
    expect(receipt?.nextActions[0]?.id).toBe("continue_chat");
    expect(receipt?.contextNotes.some((note) => note.includes("任务档位"))).toBe(true);
  });

  it("surfaces approval-driven next actions when the run is waiting on review", () => {
    const pack = getPackById("industry-cross-border-ecommerce");
    expect(pack?.productCopy).toBeTruthy();

    const receipt = buildPackAssistantReceiptModel({
      pack: pack!,
      runs: [
        buildRun({
          id: "run-2",
          task: "Review today’s store anomalies",
          sessionKey: "guided:ecommerce",
          metadata: {
            packContext: {
              packId: "industry-cross-border-ecommerce",
              surface: "guided-flow",
              updatedAt: "2026-04-07T12:05:00.000Z",
            },
          },
          status: "awaiting_tool_approval",
          summary: "Paused before applying a suggested inventory correction.",
          health: {
            state: "needs_approval",
            rollbackAvailable: false,
            reasonCodes: ["awaiting_tool_approval"],
          },
        }),
      ],
      locale: "en",
      approvalsCount: 2,
      alertCount: 1,
    });

    expect(receipt).not.toBeNull();
    expect(receipt?.state).toBe("needs_approval");
    expect(receipt?.nextActions[0]?.id).toBe("review_approvals");
    expect(receipt?.nextActions.some((action) => action.id === "continue_chat")).toBe(true);
    expect(receipt?.contextNotes.some((note) => note.includes("2 approval"))).toBe(true);
  });

  it("prefers explicit pack metadata over session-key inference for chat-origin runs", () => {
    const pack = getPackById("industry-creator-media");
    expect(pack?.productCopy).toBeTruthy();

    const receipt = buildPackAssistantReceiptModel({
      pack: pack!,
      runs: [
        buildRun({
          id: "run-chat-pack",
          sessionKey: "chat:default:pack-context",
          metadata: {
            packContext: {
              packId: "industry-creator-media",
              surface: "chat",
              updatedAt: "2026-04-07T12:01:00.000Z",
            },
          },
          health: {
            state: "healthy",
            rollbackAvailable: false,
            reasonCodes: [],
          },
        }),
      ],
      locale: "zh",
      approvalsCount: 0,
      alertCount: 0,
    });

    expect(receipt).not.toBeNull();
    expect(receipt?.currentRun?.id).toBe("run-chat-pack");
    expect(receipt?.state).toBe("ready");
  });

  it("does not match runs that only share the old guided session key", () => {
    const pack = getPackById("industry-creator-media");
    expect(pack?.productCopy).toBeTruthy();

    const receipt = buildPackAssistantReceiptModel({
      pack: pack!,
      runs: [
        buildRun({
          id: "legacy-guided-run",
          sessionKey: "guided:content-social",
          metadata: undefined,
        }),
      ],
      locale: "zh",
      approvalsCount: 0,
      alertCount: 0,
    });

    expect(receipt).not.toBeNull();
    expect(receipt?.state).toBe("not_started");
    expect(receipt?.currentRun).toBeNull();
  });
});
