import type { FridayAgentRunRecord, FridayAgentRunStatus } from "../model/friday-agent.types.js";
import type { FridayAgentRunEventRecord } from "../persistence/friday-agent-run-event-repository.js";
import type {
  FridayAgentEvidenceReceiptStatus,
  FridayAgentReplayableEvidenceReceipt,
} from "./friday-agent-evidence-receipt.js";

export const FRIDAY_AGENT_UNIFIED_TASK_STATE_SCHEMA_VERSION = "friday.agent.unified_task_state.v1";

export type FridayAgentUnifiedTaskState =
  | "awaiting_clarification"
  | "awaiting_plan_approval"
  | "awaiting_tool_approval"
  | "executing"
  | "verified_receipt"
  | "blocked_recoverable";

export type FridayAgentUnifiedTaskRequiredAction =
  | "answer_clarification"
  | "approve_or_reject_plan"
  | "approve_or_reject_tool"
  | "wait_for_execution"
  | "read_verified_receipt"
  | "review_blocker_or_retry";

export interface FridayAgentUnifiedTaskStatePointer {
  kind: "agent_run_event" | "agent_evidence_receipt" | "agent_run_record";
  runId: string;
  seq?: number;
  path?: string;
  href?: string;
}

export interface FridayAgentUnifiedTaskStateSnapshot {
  schemaVersion: typeof FRIDAY_AGENT_UNIFIED_TASK_STATE_SCHEMA_VERSION;
  state: FridayAgentUnifiedTaskState;
  source:
    | "planning_gate"
    | "tool_approval_event"
    | "run_status"
    | "evidence_receipt"
    | "terminal_recovery";
  requiredAction: FridayAgentUnifiedTaskRequiredAction;
  summary: string;
  run: {
    runId: string;
    runStatus: FridayAgentRunStatus;
    sourceSurface?: string;
    startedAt?: string;
    completedAt?: string;
  };
  evidence: {
    statePointer: FridayAgentUnifiedTaskStatePointer;
    receiptStatus?: FridayAgentEvidenceReceiptStatus;
    auditEventCount: number;
    openToolApproval?: {
      grantId?: string;
      toolCallId?: string;
      toolName?: string;
      eventPointer: FridayAgentUnifiedTaskStatePointer;
    };
    terminalPointer?: FridayAgentUnifiedTaskStatePointer;
  };
  recovery: {
    retryable: boolean;
    reason?: string;
  };
  channelBoundary: {
    consumableByChannelAdapters: true;
    liveChannelProof: "not_claimed";
    message: string;
  };
  proofBoundary: string;
}

export interface BuildFridayAgentUnifiedTaskStateInput {
  run: FridayAgentRunRecord;
  events?: FridayAgentRunEventRecord[];
  replayReceipt?: FridayAgentReplayableEvidenceReceipt;
}

const ACTIVE_STATUSES = new Set<FridayAgentRunStatus>([
  "pending",
  "planning",
  "executing",
  "testing",
  "fixing",
]);

const TERMINAL_EVENT_NAMES = new Set([
  "agent.run.completed",
  "agent.run.failed",
  "agent.run.cancelled",
]);

const TOOL_APPROVAL_RESOLUTION_EVENTS = new Set([
  "agent.run.capability_grant_issued",
  "agent.run.capability_grant_denied",
  "agent.run.capability_grant_used",
  "agent.run.capability_grant_revoked",
  "agent.run.tool_start",
  "agent.run.tool_end",
]);

const PROOF_BOUNDARY = [
  "This state is a shared local/API/channel-origin task-state contract.",
  "It is not channel live proof and does not claim Discord, Telegram, Lark/Feishu, or WhatsApp delivery.",
  "A verified_receipt state means the run has a replayable local evidence receipt; release/default-on claims still require same-SHA Real Green Gate and the applicable real proof.",
].join(" ");

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function pointerForRun(run: FridayAgentRunRecord): FridayAgentUnifiedTaskStatePointer {
  return {
    kind: "agent_run_record",
    runId: run.id,
  };
}

function pointerForEvent(event: FridayAgentRunEventRecord): FridayAgentUnifiedTaskStatePointer {
  return {
    kind: "agent_run_event",
    runId: event.runId,
    seq: event.seq,
  };
}

function pointerForReceipt(
  run: FridayAgentRunRecord,
  receipt?: FridayAgentReplayableEvidenceReceipt,
): FridayAgentUnifiedTaskStatePointer | undefined {
  const receiptFile = receipt?.replay.files.find((file) => file.kind === "evidence_receipt");
  if (!receiptFile) return undefined;
  return {
    kind: "agent_evidence_receipt",
    runId: run.id,
    ...(receiptFile.path ? { path: receiptFile.path } : {}),
    ...(receiptFile.href ? { href: receiptFile.href } : {}),
  };
}

function sourceSurface(run: FridayAgentRunRecord): string | undefined {
  const direct = run.metadata?.surface?.trim();
  if (direct) return direct;
  const packSurface = run.metadata?.packContext?.surface?.trim();
  return packSurface && packSurface.length > 0 ? packSurface : undefined;
}

function sortEvents(events: FridayAgentRunEventRecord[]): FridayAgentRunEventRecord[] {
  return [...events].sort((a, b) => a.seq - b.seq);
}

function latestEvent(
  events: FridayAgentRunEventRecord[],
  eventNames: ReadonlySet<string>,
): FridayAgentRunEventRecord | undefined {
  return sortEvents(events)
    .filter((event) => eventNames.has(event.eventName))
    .at(-1);
}

function toolApprovalKeys(event: FridayAgentRunEventRecord): string[] {
  const payload = asRecord(event.payload);
  return [
    readString(payload, "grantId"),
    readString(payload, "toolCallId"),
  ].filter((value): value is string => Boolean(value));
}

function findOpenToolApproval(
  events: FridayAgentRunEventRecord[],
): FridayAgentRunEventRecord | undefined {
  const open = new Map<string, FridayAgentRunEventRecord>();
  for (const event of sortEvents(events)) {
    const keys = toolApprovalKeys(event);
    if (keys.length === 0) continue;
    if (event.eventName === "agent.run.awaiting_tool_approval") {
      for (const key of keys) {
        open.set(key, event);
      }
      continue;
    }
    if (TOOL_APPROVAL_RESOLUTION_EVENTS.has(event.eventName)) {
      const matchedOpenEvents = new Set(
        keys
          .map((key) => open.get(key))
          .filter((value): value is FridayAgentRunEventRecord => Boolean(value)),
      );
      for (const key of keys) {
        open.delete(key);
      }
      if (matchedOpenEvents.size > 0) {
        for (const [openKey, openEvent] of open.entries()) {
          if (matchedOpenEvents.has(openEvent)) {
            open.delete(openKey);
          }
        }
      }
    }
  }
  return [...new Set(open.values())].sort((a, b) => a.seq - b.seq).at(-1);
}

function buildBase(input: {
  run: FridayAgentRunRecord;
  events: FridayAgentRunEventRecord[];
  state: FridayAgentUnifiedTaskState;
  source: FridayAgentUnifiedTaskStateSnapshot["source"];
  requiredAction: FridayAgentUnifiedTaskRequiredAction;
  summary: string;
  statePointer?: FridayAgentUnifiedTaskStatePointer;
  receiptStatus?: FridayAgentEvidenceReceiptStatus;
  openToolApproval?: FridayAgentUnifiedTaskStateSnapshot["evidence"]["openToolApproval"];
  recovery?: Partial<FridayAgentUnifiedTaskStateSnapshot["recovery"]>;
  replayReceipt?: FridayAgentReplayableEvidenceReceipt;
}): FridayAgentUnifiedTaskStateSnapshot {
  const terminalPointer = latestEvent(input.events, TERMINAL_EVENT_NAMES);
  const surface = sourceSurface(input.run);
  return {
    schemaVersion: FRIDAY_AGENT_UNIFIED_TASK_STATE_SCHEMA_VERSION,
    state: input.state,
    source: input.source,
    requiredAction: input.requiredAction,
    summary: input.summary,
    run: {
      runId: input.run.id,
      runStatus: input.run.status,
      ...(surface ? { sourceSurface: surface } : {}),
      ...(input.run.startedAt ? { startedAt: input.run.startedAt } : {}),
      ...(input.run.completedAt ? { completedAt: input.run.completedAt } : {}),
    },
    evidence: {
      statePointer: input.statePointer ?? pointerForReceipt(input.run, input.replayReceipt) ?? pointerForRun(input.run),
      ...(input.receiptStatus ? { receiptStatus: input.receiptStatus } : {}),
      auditEventCount: input.events.length,
      ...(input.openToolApproval ? { openToolApproval: input.openToolApproval } : {}),
      ...(terminalPointer ? { terminalPointer: pointerForEvent(terminalPointer) } : {}),
    },
    recovery: {
      retryable: input.recovery?.retryable ?? false,
      ...(input.recovery?.reason ? { reason: input.recovery.reason } : {}),
    },
    channelBoundary: {
      consumableByChannelAdapters: true,
      liveChannelProof: "not_claimed",
      message: "Phase 22G exposes a shared state contract only. Phase 24 must prove each live channel separately.",
    },
    proofBoundary: PROOF_BOUNDARY,
  };
}

export function buildFridayAgentUnifiedTaskState(
  input: BuildFridayAgentUnifiedTaskStateInput,
): FridayAgentUnifiedTaskStateSnapshot {
  const events = input.events ?? [];
  const awaitingClarification = latestEvent(events, new Set(["agent.run.awaiting_clarification"]));
  const awaitingPlanApproval = latestEvent(events, new Set(["agent.run.awaiting_plan_approval"]));

  if (input.run.status === "awaiting_clarification") {
    return buildBase({
      run: input.run,
      events,
      state: "awaiting_clarification",
      source: "planning_gate",
      requiredAction: "answer_clarification",
      summary: "Friday is waiting for the user to answer clarification questions before execution.",
      statePointer: awaitingClarification ? pointerForEvent(awaitingClarification) : pointerForRun(input.run),
      replayReceipt: input.replayReceipt,
    });
  }

  if (input.run.status === "awaiting_plan_approval") {
    return buildBase({
      run: input.run,
      events,
      state: "awaiting_plan_approval",
      source: "planning_gate",
      requiredAction: "approve_or_reject_plan",
      summary: "Friday has a proposed plan and is waiting for explicit user approval before execution.",
      statePointer: awaitingPlanApproval ? pointerForEvent(awaitingPlanApproval) : pointerForRun(input.run),
      replayReceipt: input.replayReceipt,
    });
  }

  const openToolApproval = findOpenToolApproval(events);
  if (openToolApproval) {
    const payload = asRecord(openToolApproval.payload);
    return buildBase({
      run: input.run,
      events,
      state: "awaiting_tool_approval",
      source: "tool_approval_event",
      requiredAction: "approve_or_reject_tool",
      summary: "Friday is paused at a tool/action approval gate and has not executed that tool call yet.",
      statePointer: pointerForEvent(openToolApproval),
      openToolApproval: {
        ...(readString(payload, "grantId") ? { grantId: readString(payload, "grantId") } : {}),
        ...(readString(payload, "toolCallId") ? { toolCallId: readString(payload, "toolCallId") } : {}),
        ...(readString(payload, "toolName") ? { toolName: readString(payload, "toolName") } : {}),
        eventPointer: pointerForEvent(openToolApproval),
      },
      replayReceipt: input.replayReceipt,
    });
  }

  if (ACTIVE_STATUSES.has(input.run.status)) {
    const activeEvent = latestEvent(events, new Set([
      "agent.run.executing",
      "agent.run.progress",
      "agent.run.tool_start",
      "agent.run.tool_end",
      "agent.run.started",
    ]));
    return buildBase({
      run: input.run,
      events,
      state: "executing",
      source: "run_status",
      requiredAction: "wait_for_execution",
      summary: "Friday is actively working or preparing to work on this run.",
      statePointer: activeEvent ? pointerForEvent(activeEvent) : pointerForRun(input.run),
      recovery: { retryable: false },
      replayReceipt: input.replayReceipt,
    });
  }

  if (input.run.status === "completed" && input.replayReceipt?.receiptStatus === "verified_receipt") {
    return buildBase({
      run: input.run,
      events,
      state: "verified_receipt",
      source: "evidence_receipt",
      requiredAction: "read_verified_receipt",
      summary: "Friday completed the run and produced a replayable local evidence receipt.",
      statePointer: pointerForReceipt(input.run, input.replayReceipt),
      receiptStatus: input.replayReceipt.receiptStatus,
      replayReceipt: input.replayReceipt,
    });
  }

  return buildBase({
    run: input.run,
    events,
    state: "blocked_recoverable",
    source: "terminal_recovery",
    requiredAction: "review_blocker_or_retry",
    summary: input.run.status === "completed"
      ? "Friday completed, but no verified replay receipt is attached to this state snapshot."
      : `Friday stopped in ${input.run.status}; review the blocker and decide whether to retry or recover.`,
    receiptStatus: input.replayReceipt?.receiptStatus,
    recovery: {
      retryable: input.run.status !== "cancelled",
      reason: input.run.errorMessage ?? input.run.errorCode ?? input.replayReceipt?.blockers.at(0),
    },
    replayReceipt: input.replayReceipt,
  });
}
