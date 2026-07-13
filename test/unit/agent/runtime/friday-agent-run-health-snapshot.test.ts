import { describe, expect, it } from "vitest";

import { buildFridayAgentRunHealthSnapshot } from "../../../../src/agent/runtime/friday-agent-run-presentation.js";
import { buildFridayAgentReplayableEvidenceReceipt } from "../../../../src/agent/services/friday-agent-evidence-receipt.js";
import type {
  FridayAgentActualExecution,
  FridayAgentRunRecord,
  FridayAgentRunStatus,
} from "../../../../src/agent/model/friday-agent.types.js";

/**
 * Coverage for the "Needs Me" run-health classifier
 * (buildFridayAgentRunHealthSnapshot). The anchor of this file is the
 * awaiting_clarification gap: a run waiting on the user's answer must surface as
 * human-action-required ("needs_approval") rather than silently "healthy".
 *
 * The cross-classifier consistency block ties the health snapshot to its sibling
 * classifier inside the evidence receipt so the two cannot silently diverge on
 * the human-waiting statuses again.
 */

function makeRun(overrides: Partial<FridayAgentRunRecord> = {}): FridayAgentRunRecord {
  return {
    id: "run-health-fixture",
    task: "demo task",
    status: "executing",
    sessionKey: "session-health-fixture",
    attempt: 1,
    maxAttempts: 3,
    ...overrides,
  };
}

// The three canonical run statuses that mean "a human decision is pending".
// awaiting_tool_approval is intentionally NOT a member of FridayAgentRunStatus
// (the presentation code reads it defensively via String(run.status)); it is
// cast at the call site to mirror that runtime-only value.
const HUMAN_WAITING_STATUSES = [
  "awaiting_clarification",
  "awaiting_plan_approval",
  "awaiting_tool_approval",
] as const;

const CLARIFICATION_STATUS = "awaiting_clarification" satisfies FridayAgentRunStatus;

describe("buildFridayAgentRunHealthSnapshot — awaiting_clarification (Needs Me anchor)", () => {
  it("classifies awaiting_clarification as needs_approval with clarification_required", () => {
    const snapshot = buildFridayAgentRunHealthSnapshot({
      run: makeRun({ status: CLARIFICATION_STATUS }),
    });

    // RED anchor: against the pre-fix classifier this run falls through every
    // branch and returns { state: "healthy", reasonCodes: [] }, so both of these
    // assertions throw real AssertionErrors.
    expect(snapshot.state).toBe("needs_approval");
    expect(snapshot.reasonCodes).toContain("clarification_required");
    expect(snapshot.rollbackAvailable).toBe(false);
  });
});

describe("run-health <> evidence-receipt cross-classifier consistency", () => {
  it.each(HUMAN_WAITING_STATUSES)(
    "both siblings agree a human is needed for status %s",
    (status) => {
      const healthSnapshot = buildFridayAgentRunHealthSnapshot({
        // awaiting_tool_approval is a runtime-only string, hence the cast.
        run: makeRun({ status: status as FridayAgentRunStatus }),
      });
      const receipt = buildFridayAgentReplayableEvidenceReceipt({
        runId: "run-cross-classifier",
        task: "demo task",
        status,
      });

      expect(healthSnapshot.state).toBe("needs_approval");
      expect(receipt.receiptStatus).toBe("waiting_for_human");
    },
  );
});

describe("buildFridayAgentRunHealthSnapshot — regression matrix (green before and after the fix)", () => {
  it("classifies awaiting_plan_approval as needs_approval with plan_approval_required", () => {
    const snapshot = buildFridayAgentRunHealthSnapshot({
      run: makeRun({ status: "awaiting_plan_approval" }),
    });

    expect(snapshot.state).toBe("needs_approval");
    expect(snapshot.reasonCodes).toContain("plan_approval_required");
  });

  it("classifies awaiting_tool_approval (runtime-only status) as needs_approval with tool_approval_required", () => {
    const snapshot = buildFridayAgentRunHealthSnapshot({
      run: makeRun({ status: "awaiting_tool_approval" as FridayAgentRunStatus }),
    });

    expect(snapshot.state).toBe("needs_approval");
    expect(snapshot.reasonCodes).toContain("tool_approval_required");
  });

  it("prefers rollback_available over every other signal", () => {
    const snapshot = buildFridayAgentRunHealthSnapshot({
      // Even with a human-waiting status, an available rollback wins the branch.
      run: makeRun({ status: CLARIFICATION_STATUS }),
      rollbackAvailable: true,
    });

    expect(snapshot.state).toBe("rollback_available");
    expect(snapshot.rollbackAvailable).toBe(true);
    expect(snapshot.reasonCodes).toContain("rollback_available");
  });

  it("classifies a non-retryable failure as failed", () => {
    const snapshot = buildFridayAgentRunHealthSnapshot({
      run: makeRun({ status: "failed", errorMessage: "assertion failed: unexpected output" }),
    });

    expect(snapshot.state).toBe("failed");
    expect(snapshot.reasonCodes).toContain("failed");
  });

  it("classifies a 429/overloaded failure as retryable", () => {
    const snapshot = buildFridayAgentRunHealthSnapshot({
      run: makeRun({ status: "failed", errorMessage: "provider returned 429 overloaded, please retry" }),
    });

    expect(snapshot.state).toBe("retryable");
    expect(snapshot.reasonCodes).toContain("retryable_provider_or_network_failure");
  });

  it("classifies fallback / blocked-tool / learning-adjusted execution as degraded", () => {
    const actualExecution = {
      turns: [],
      fallbackAttempts: [{ providerId: "primary" }],
      blockedTools: [{ toolName: "shell", reason: "policy" }],
      learningAdjusted: true,
    } as unknown as FridayAgentActualExecution;

    const snapshot = buildFridayAgentRunHealthSnapshot({
      run: makeRun({ status: "executing", actualExecution }),
    });

    expect(snapshot.state).toBe("degraded");
    expect(snapshot.reasonCodes).toEqual(
      expect.arrayContaining(["route_fallback", "blocked_tools", "learning_adjusted_route"]),
    );
  });

  it("classifies a clean completed run as healthy with no reason codes", () => {
    const snapshot = buildFridayAgentRunHealthSnapshot({
      run: makeRun({ status: "completed" }),
    });

    expect(snapshot.state).toBe("healthy");
    expect(snapshot.reasonCodes).toHaveLength(0);
  });

  it("classifies a clean executing run as healthy with no reason codes", () => {
    const snapshot = buildFridayAgentRunHealthSnapshot({
      run: makeRun({ status: "executing" }),
    });

    expect(snapshot.state).toBe("healthy");
    expect(snapshot.reasonCodes).toHaveLength(0);
  });
});
