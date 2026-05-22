import { describe, expect, it } from "vitest";
import {
  buildFridayAgentUnifiedTaskState,
  FRIDAY_AGENT_UNIFIED_TASK_STATE_SCHEMA_VERSION,
  type FridayAgentReplayableEvidenceReceipt,
  type FridayAgentRunRecord,
} from "#agent";
import type { FridayAgentRunEventRecord } from "#agent";

function run(overrides: Partial<FridayAgentRunRecord> = {}): FridayAgentRunRecord {
  return {
    id: "run-1",
    task: "Test task",
    status: "executing",
    sessionKey: "agent:run:run-1",
    attempt: 0,
    maxAttempts: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function event(
  seq: number,
  eventName: string,
  payload: Record<string, unknown> = { runId: "run-1" },
): FridayAgentRunEventRecord {
  return {
    eventId: `event-${seq}`,
    runId: "run-1",
    seq,
    eventName,
    payload,
    emittedAt: `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`,
    createdAt: `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`,
  };
}

function verifiedReceipt(): FridayAgentReplayableEvidenceReceipt {
  return {
    schemaVersion: "friday.agent.evidence_receipt.v1",
    receiptKind: "agent_run_replayable_evidence",
    receiptStatus: "verified_receipt",
    issuedAt: "2026-01-01T00:00:06.000Z",
    run: {
      runId: "run-1",
      task: "Test task",
      status: "completed",
      completedAt: "2026-01-01T00:00:05.000Z",
    },
    evidence: {
      toolCalls: { total: 0, succeeded: 0, failed: 0 },
      tests: { total: 1, passed: 1, failed: 0 },
      artifacts: { total: 1, byType: { evidence_receipt: 1 } },
      auditEventCount: 1,
      decisionTraceAvailable: true,
      decisionTraceActionCount: 0,
    },
    replay: {
      auditEndpoint: "/v1/agent/runs/run-1/audit",
      artifactDir: "/tmp/friday/run-1",
      files: [
        { label: "Evidence receipt", kind: "evidence_receipt", path: "/tmp/friday/run-1/evidence-receipt.json" },
      ],
    },
    blockers: [],
    limitations: [],
    proofBoundary: "not release proof; same-SHA Real Green Gate required",
    userSummary: "Friday has a replayable receipt for this completed local run.",
  };
}

describe("buildFridayAgentUnifiedTaskState", () => {
  it("maps clarification and plan gates to explicit human-waiting states", () => {
    const clarification = buildFridayAgentUnifiedTaskState({
      run: run({ status: "awaiting_clarification" }),
      events: [event(1, "agent.run.awaiting_clarification")],
    });
    const planApproval = buildFridayAgentUnifiedTaskState({
      run: run({ status: "awaiting_plan_approval" }),
      events: [event(1, "agent.run.awaiting_plan_approval")],
    });

    expect(clarification).toMatchObject({
      schemaVersion: FRIDAY_AGENT_UNIFIED_TASK_STATE_SCHEMA_VERSION,
      state: "awaiting_clarification",
      source: "planning_gate",
      requiredAction: "answer_clarification",
      channelBoundary: { liveChannelProof: "not_claimed" },
    });
    expect(planApproval).toMatchObject({
      state: "awaiting_plan_approval",
      source: "planning_gate",
      requiredAction: "approve_or_reject_plan",
    });
  });

  it("preserves channel-origin runs in the same shared state contract without claiming live delivery", () => {
    const snapshot = buildFridayAgentUnifiedTaskState({
      run: run({
        status: "awaiting_plan_approval",
        metadata: { surface: "channel" },
      }),
      events: [event(1, "agent.run.awaiting_plan_approval")],
    });

    expect(snapshot).toMatchObject({
      schemaVersion: FRIDAY_AGENT_UNIFIED_TASK_STATE_SCHEMA_VERSION,
      state: "awaiting_plan_approval",
      source: "planning_gate",
      requiredAction: "approve_or_reject_plan",
      run: {
        runId: "run-1",
        runStatus: "awaiting_plan_approval",
        sourceSurface: "channel",
      },
      channelBoundary: {
        consumableByChannelAdapters: true,
        liveChannelProof: "not_claimed",
      },
    });
    expect(snapshot.proofBoundary).toContain("shared local/API/channel-origin task-state contract");
    expect(snapshot.proofBoundary).toContain("not channel live proof");
  });

  it("keeps unresolved tool approval open without repeating raw approval params", () => {
    const snapshot = buildFridayAgentUnifiedTaskState({
      run: run({ status: "executing" }),
      events: [
        event(1, "agent.run.awaiting_tool_approval", {
          runId: "run-1",
          grantId: "grant-1",
          toolCallId: "call-1",
          toolName: "shell",
          params: { command: "npm test" },
          reason: "Needs approval for shell command",
        }),
      ],
    });

    expect(snapshot.state).toBe("awaiting_tool_approval");
    expect(snapshot.requiredAction).toBe("approve_or_reject_tool");
    expect(snapshot.evidence.openToolApproval).toEqual({
      grantId: "grant-1",
      toolCallId: "call-1",
      toolName: "shell",
      eventPointer: { kind: "agent_run_event", runId: "run-1", seq: 1 },
    });
    expect(JSON.stringify(snapshot)).not.toContain("npm test");
    expect(JSON.stringify(snapshot)).not.toContain("Needs approval for shell command");
  });

  it("closes tool approval when either grant or tool call resolution appears", () => {
    const snapshot = buildFridayAgentUnifiedTaskState({
      run: run({ status: "executing" }),
      events: [
        event(1, "agent.run.awaiting_tool_approval", {
          runId: "run-1",
          grantId: "grant-1",
          toolCallId: "call-1",
          toolName: "shell",
        }),
        event(2, "agent.run.tool_start", {
          runId: "run-1",
          toolCallId: "call-1",
          toolName: "shell",
        }),
      ],
    });

    expect(snapshot.state).toBe("executing");
    expect(snapshot.evidence.openToolApproval).toBeUndefined();
    expect(snapshot.evidence.statePointer).toEqual({ kind: "agent_run_event", runId: "run-1", seq: 2 });
  });

  it("maps active, verified, and recoverable terminal runs", () => {
    const executing = buildFridayAgentUnifiedTaskState({
      run: run({ status: "testing" }),
      events: [event(2, "agent.run.progress")],
    });
    const verified = buildFridayAgentUnifiedTaskState({
      run: run({ status: "completed", completedAt: "2026-01-01T00:00:05.000Z", artifactDir: "/tmp/friday/run-1" }),
      events: [event(3, "agent.run.completed")],
      replayReceipt: verifiedReceipt(),
    });
    const blocked = buildFridayAgentUnifiedTaskState({
      run: run({ status: "failed", errorCode: "PROVIDER_ERROR" }),
      events: [event(4, "agent.run.failed")],
    });

    expect(executing).toMatchObject({
      state: "executing",
      requiredAction: "wait_for_execution",
    });
    expect(verified).toMatchObject({
      state: "verified_receipt",
      source: "evidence_receipt",
      requiredAction: "read_verified_receipt",
      evidence: { receiptStatus: "verified_receipt" },
    });
    expect(blocked).toMatchObject({
      state: "blocked_recoverable",
      requiredAction: "review_blocker_or_retry",
      recovery: { retryable: true, reason: "PROVIDER_ERROR" },
    });
    expect(verified.proofBoundary).toContain("not channel live proof");
    expect(verified.proofBoundary).toContain("same-SHA Real Green Gate");
  });
});
