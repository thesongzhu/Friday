import type { FridayAuthPrincipal, FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayAgentRunExecutionResponse,
  FridayAgentRunWithUnifiedTaskState,
  FridayCancelAgentRunResponse,
  FridayGetAgentRunResponse,
  FridayListAgentRunsQuery,
  FridayListAgentRunsResponse,
  FridayResumeAgentRunResponse,
  FridayStartAgentRunRequest,
  FridayStartAgentRunResponse,
} from "../../model/friday-api-agent.types.js";
import type {
  FridayAgentAutomationSchedule,
  FridayAgentAutomationService,
  FridayAgentAutomationSessionTarget,
  FridayAgentEventEmitter,
  FridayAgentEventMap,
  FridayAgentEventName,
  FridayAgentExecutionContext,
  FridayAgentReplayableEvidenceReceipt,
  FridayAgentRunConstraints,
  FridayAgentRunRecord,
  FridayAgentRunStatus,
  FridayAgentRuntimeResult,
  FridayAgentTaskProfileInput,
  FridayAgentToolCallRecord,
} from "#agent";
import { buildFridayAgentReplayableEvidenceReceipt, buildFridayAgentUnifiedTaskState } from "#agent";
import type { FridayProviderTenantContext } from "#providers";
import { FridayDomainError } from "#errors";
import { isValidCronExpression } from "#jobs";
import type { FridayAgentRunEventRecord } from "#agent";
import {
  hashIdempotencyPayload,
  readIdempotencyKeyHeader,
} from "./friday-route-idempotency.js";
import { assertBoundPrincipalForOperation } from "../../../security/friday-owner-session-channel-capability.js";
import { buildPublicV1AgentRunIsolation } from "./friday-public-v1-agent-isolation.js";

// ─── Constants ───

const AGENT_MAX_LIST_LIMIT = 100;
const AGENT_SSE_KEEPALIVE_MS = 15_000;

/** Terminal statuses — no further events will be emitted. */
const TERMINAL_STATUSES: ReadonlySet<FridayAgentRunStatus> = new Set([
  "completed",
  "failed",
  "failed_tests",
  "cancelled",
]);

/** Event names that signal a terminal state (derived from TERMINAL_STATUSES). */
const TERMINAL_EVENT_NAMES: ReadonlySet<string> = new Set(
  [...TERMINAL_STATUSES].map((s) => `agent.run.${s}`),
);

const AGENT_READ_SCOPES = ["agent.read", "workflow.run"] as const;
const AGENT_RUN_SCOPES = ["agent.run", "workflow.run"] as const;
const AGENT_WRITE_SCOPES = ["agent.write", "workflow.run"] as const;
const CUSTOM_PACK_INTERNAL_DETAIL_PATTERNS: ReadonlyArray<RegExp> = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /[（(]?\s*ID\s*[:：]/i,
  /\b(?:readOnly|skills_list|memory_search|agents_list|sub-?agent|sessionKey|session key|childRunId|tool[_ ]call|tool name|pack_id|pack id|memory system|memory item|memory namespace)\b/i,
  /\b(?:run id|session id|subagent id)\b/i,
  /(?:任务包\s*id|只读模式|内存(?:系统|持久化|记录)|记忆(?:系统|条目|检索)|工作流目录|workflow catalog|子代理|会话键|父会话|父子会话|运行深度|元数据)/i,
];
const CUSTOM_PACK_INTERNAL_LINE_DROP_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:只读模式|read[- ]?only mode)/i,
  /(?:内存(?:系统|持久化|记录)|记忆(?:系统|条目|检索)|memory system|memory item|memory namespace|memory search)/i,
  /(?:skills_list|memory_search|agents_list|sub-?agent|tool[_ ]call|tool name)/i,
  /(?:子代理|会话键|父会话|父子会话|运行深度|元数据)/i,
  /(?:当前运行.*正在执行中)/i,
];
const CUSTOM_PACK_UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function getRunSurface(run: FridayAgentRunRecord): string | undefined {
  const directSurface = run.metadata?.surface?.trim();
  if (directSurface) {
    return directSurface;
  }
  const packSurface = run.metadata?.packContext?.surface?.trim();
  return packSurface && packSurface.length > 0 ? packSurface : undefined;
}

function unwrapSubagentSessionKey(sessionKey: string): string {
  let normalized = sessionKey;
  while (normalized.startsWith("subagent:")) {
    normalized = normalized.slice("subagent:".length);
  }
  return normalized;
}

function isInternalAutonomousRun(run: FridayAgentRunRecord): boolean {
  const surface = getRunSurface(run);
  if (surface?.startsWith("autonomous_internal_")) {
    return true;
  }
  return unwrapSubagentSessionKey(run.sessionKey).startsWith("autonomous:");
}

function isSubagentChildRun(run: FridayAgentRunRecord): boolean {
  return run.sessionKey.trim().startsWith("subagent:");
}

function isUserVisibleAgentRun(run: FridayAgentRunRecord): boolean {
  return !isInternalAutonomousRun(run) && !isSubagentChildRun(run);
}

function requireToolApprovalPrincipal(
  principal: FridayAuthPrincipal | null,
  operation: "agent.tool.approve" | "agent.tool.reject",
): {
  approverPrincipalId: string;
  approverPrincipalType?: string;
  approvalSurface: string;
} {
  const bound = assertBoundPrincipalForOperation(principal, operation, "api");
  return {
    approverPrincipalId: bound.principalId,
    approverPrincipalType: bound.principalType,
    approvalSurface: "api",
  };
}

function filterVisibleAgentRuns(runs: FridayAgentRunRecord[]): FridayAgentRunRecord[] {
  return runs.filter(isUserVisibleAgentRun);
}

function expandVisibleRunFetchLimit(limit?: number): number | undefined {
  if (typeof limit !== "number") {
    return undefined;
  }
  return Math.min(Math.max(limit * 4, limit), AGENT_MAX_LIST_LIMIT);
}

function isCustomPackRun(run: FridayAgentRunRecord): boolean {
  return Boolean(run.metadata?.packContext?.packId?.trim().startsWith("custom-"));
}

function sanitizeCustomPackText(text: string): string {
  const filteredLines = text
    .split("\n")
    .map((line) =>
      line
        .replace(/(?:任务包\s*id|pack(?:\s|_)?id|run(?:\s|_)?id|session(?:\s|_)?id|session(?:\s|_)?key)\s*[:：=]\s*[^\s,，;；)）]+/giu, "")
        .replace(/\b(?:readOnly|readonly)\b\s*(?:[:=]\s*(?:true|false))?/giu, "")
        .replace(/\b(?:skills_list|memory_search|agents_list|sub-agent|subagent|sessionKey|childRunId|tool[_ ]call|tool name)\b/giu, "")
        .replace(CUSTOM_PACK_UUID_RE, "")
        .replace(/[（(]\s*ID\s*[:：]\s*[）)]/giu, "")
        .replace(/\bID\s*[:：]\s*/giu, "")
        .replace(/[（(]\s*[）)]/gu, "")
        .replace(/\s{2,}/g, " ")
        .trim(),
    )
    .filter((line) => line.length > 0)
    .filter((line) => !/^(?:[-*•]\s*|(?:\d+[.)]\s*))$/u.test(line))
    .filter((line) => !CUSTOM_PACK_INTERNAL_LINE_DROP_PATTERNS.some((pattern) => pattern.test(line)))
    .filter((line) => !CUSTOM_PACK_INTERNAL_DETAIL_PATTERNS.some((pattern) => pattern.test(line)));

  const sanitized = filteredLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return sanitized.length > 0
    ? sanitized
    : "这次自创任务已经完成，结果已按真实任务定义和真实运行记录整理。";
}

function sanitizeUserVisibleRun(run: FridayAgentRunRecord): FridayAgentRunRecord {
  if (!isCustomPackRun(run)) {
    return run;
  }

  return {
    ...run,
    ...(run.responseText ? { responseText: sanitizeCustomPackText(run.responseText) } : {}),
    ...(run.summary ? { summary: sanitizeCustomPackText(run.summary) } : {}),
    ...(run.errorMessage ? { errorMessage: sanitizeCustomPackText(run.errorMessage) } : {}),
  };
}

function sanitizePlanReviewForPublicRead(
  planReview: FridayAgentRunRecord["planReview"],
): FridayAgentRunRecord["planReview"] | undefined {
  if (!planReview) {
    return undefined;
  }
  return {
    plan: {
      task: planReview.plan.task,
      stepCount: planReview.plan.stepCount,
      description: planReview.plan.description,
    },
    ...(planReview.gate
      ? {
        gate: {
          kind: planReview.gate.kind,
          state: planReview.gate.state,
          ...(Array.isArray(planReview.gate.clarificationQuestions)
            ? { clarificationQuestions: planReview.gate.clarificationQuestions.map(() => "[redacted]") }
            : {}),
          ...(planReview.gate.planSummary ? { planSummary: "[redacted]" } : {}),
          ...(planReview.gate.approvalUpdatedAt ? { approvalUpdatedAt: planReview.gate.approvalUpdatedAt } : {}),
        },
      }
      : {}),
    ...(planReview.decision
      ? {
        decision: {
          approved: planReview.decision.approved,
          mode: planReview.decision.mode,
          reviewedAt: planReview.decision.reviewedAt,
        },
      }
      : {}),
  };
}

function sanitizePublicAgentRunRecord(run: FridayAgentRunRecord): FridayAgentRunRecord {
  const sanitized = sanitizeUserVisibleRun(run);
  return {
    id: sanitized.id,
    task: sanitized.task,
    status: sanitized.status,
    sessionKey: sanitized.sessionKey,
    attempt: sanitized.attempt,
    maxAttempts: sanitized.maxAttempts,
    createdAt: sanitized.createdAt,
    ...(sanitized.startedAt ? { startedAt: sanitized.startedAt } : {}),
    ...(sanitized.completedAt ? { completedAt: sanitized.completedAt } : {}),
    ...(typeof sanitized.durationMs === "number" ? { durationMs: sanitized.durationMs } : {}),
    ...(typeof sanitized.usageInput === "number" ? { usageInput: sanitized.usageInput } : {}),
    ...(typeof sanitized.usageOutput === "number" ? { usageOutput: sanitized.usageOutput } : {}),
    ...(typeof sanitized.costUsd === "number" ? { costUsd: sanitized.costUsd } : {}),
    ...(sanitized.errorCode ? { errorCode: sanitized.errorCode } : {}),
    ...(sanitized.errorMessage ? { errorMessage: sanitized.errorMessage } : {}),
    ...(sanitized.responseText ? { responseText: sanitized.responseText } : {}),
    ...(sanitized.summary ? { summary: sanitized.summary } : {}),
    ...(sanitized.planReview ? { planReview: sanitizePlanReviewForPublicRead(sanitized.planReview) } : {}),
    ...(sanitized.constraints
      ? {
        constraints: {
          ...(typeof sanitized.constraints.readOnly === "boolean" ? { readOnly: sanitized.constraints.readOnly } : {}),
          ...(sanitized.constraints.operationalMode ? { operationalMode: sanitized.constraints.operationalMode } : {}),
          ...(sanitized.constraints.dataSensitivity ? { dataSensitivity: sanitized.constraints.dataSensitivity } : {}),
          ...(typeof sanitized.constraints.localOnly === "boolean" ? { localOnly: sanitized.constraints.localOnly } : {}),
          ...(typeof sanitized.constraints.noEgress === "boolean" ? { noEgress: sanitized.constraints.noEgress } : {}),
        },
      }
      : {}),
    ...(sanitized.taskProfile
      ? {
        taskProfile: {
          id: sanitized.taskProfile.id,
          label: sanitized.taskProfile.label,
          description: sanitized.taskProfile.description,
          reasoningEffort: sanitized.taskProfile.reasoningEffort,
          ...(typeof sanitized.taskProfile.temperature === "number" ? { temperature: sanitized.taskProfile.temperature } : {}),
        },
      }
      : {}),
    ...(sanitized.metadata?.surface
      ? {
        metadata: {
          surface: sanitized.metadata.surface,
        },
      }
      : {}),
    ...(sanitized.health ? { health: sanitized.health } : {}),
    ...(sanitized.contextSummary ? { contextSummary: sanitized.contextSummary } : {}),
    ...(typeof sanitized.rollbackAvailable === "boolean" ? { rollbackAvailable: sanitized.rollbackAvailable } : {}),
  };
}

// D1 fix: reconstruct tool-call outcomes from the durable event stream so the
// API-rebuilt receipt counts real tool failures. Without this, toolCalls was never
// passed to the receipt builder, so countToolCalls(undefined).failed was always 0 and
// every completed run with an artifactDir was misclassified as `verified_receipt` —
// disagreeing with the on-disk receipt (which was built WITH the real tool calls).
// Each terminal `agent.run.tool_end` event carries `isError`; a tool_start without a
// matching tool_end is treated as a failure (it did not complete).
function collectToolCallRecordsFromEvents(
  auditEvents: FridayAgentRunEventRecord[],
): FridayAgentToolCallRecord[] {
  const startById = new Map<string, FridayAgentRunEventRecord>();
  const endById = new Map<string, FridayAgentRunEventRecord>();
  for (const event of auditEvents) {
    const payload = asRecord(event.payload);
    const toolCallId = readStringField(payload, "toolCallId");
    if (!toolCallId) continue;
    if (event.eventName === "agent.run.tool_start") {
      startById.set(toolCallId, event);
    } else if (event.eventName === "agent.run.tool_end") {
      endById.set(toolCallId, event);
    }
  }
  const toolCallIds = new Set<string>([...startById.keys(), ...endById.keys()]);
  const records: FridayAgentToolCallRecord[] = [];
  for (const toolCallId of toolCallIds) {
    const startEvent = startById.get(toolCallId);
    const endEvent = endById.get(toolCallId);
    const endPayload = asRecord(endEvent?.payload);
    const startPayload = asRecord(startEvent?.payload);
    // No tool_end => the call never completed => treat as an error outcome.
    const isError = endEvent ? endPayload?.isError === true : true;
    const durationMs = typeof endPayload?.durationMs === "number" ? endPayload.durationMs : 0;
    records.push({
      toolCallId,
      toolName: readStringField(endPayload, "toolName")
        ?? readStringField(startPayload, "toolName")
        ?? "unknown",
      args: {},
      result: { content: "", isError },
      durationMs,
      startedAt: (startEvent ?? endEvent)?.emittedAt ?? "",
    });
  }
  return records;
}

function buildReplayableEvidenceReceiptForRun(
  run: FridayAgentRunRecord,
  auditEvents: FridayAgentRunEventRecord[],
  issuedAt: string,
  decisionTrace?: FridayAgentAuditDecisionTrace,
) {
  return buildFridayAgentReplayableEvidenceReceipt({
    runId: run.id,
    task: run.task,
    status: run.status,
    issuedAt,
    completedAt: run.completedAt,
    durationMs: run.durationMs,
    usageInput: run.usageInput,
    usageOutput: run.usageOutput,
    costUsd: run.costUsd ?? run.actualExecution?.totalCostUsd,
    artifactDir: run.artifactDir,
    toolCalls: collectToolCallRecordsFromEvents(auditEvents),
    testResults: run.testResults,
    artifacts: run.artifacts,
    auditEventCount: auditEvents.length,
    ...(decisionTrace
      ? {
        decisionTraceAvailable: true,
        decisionTraceActionCount: decisionTrace.actions.length,
      }
      : {}),
  });
}

function sanitizeReplayReceiptForPublicRead(
  receipt: FridayAgentReplayableEvidenceReceipt,
): FridayAgentReplayableEvidenceReceipt {
  return {
    ...receipt,
    replay: {
      auditEndpoint: receipt.replay.auditEndpoint,
      files: receipt.replay.files.map((file) => ({
        label: file.label,
        kind: file.kind,
        ...(file.kind === "audit_endpoint" && file.href ? { href: file.href } : {}),
      })),
    },
    limitations: [
      "Replay file entries are proof refs; private filesystem paths are redacted from this public API surface.",
      ...receipt.limitations.filter((limitation) => !/file paths|tool-calls\.json/i.test(limitation)),
    ],
  };
}

function buildVisibleRunWithUnifiedTaskState(
  run: FridayAgentRunRecord,
  events: FridayAgentRunEventRecord[],
  issuedAt: string,
): FridayAgentRunWithUnifiedTaskState {
  const replayReceipt = buildReplayableEvidenceReceiptForRun(run, events, issuedAt);
  const publicReplayReceipt = sanitizeReplayReceiptForPublicRead(replayReceipt);
  return {
    ...sanitizePublicAgentRunRecord(run),
    unifiedTaskState: buildFridayAgentUnifiedTaskState({
      run,
      events,
      replayReceipt: publicReplayReceipt,
    }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readStringField(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readToolGuardrail(record: Record<string, unknown> | null): Record<string, unknown> | null {
  return asRecord(record?.guardrail);
}

function sanitizeToolGuardrailForAudit(
  guardrail: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  if (!guardrail) return undefined;
  return {
    ...(readStringField(guardrail, "schemaVersion") ? { schemaVersion: readStringField(guardrail, "schemaVersion") } : {}),
    ...(readStringField(guardrail, "phase") ? { phase: readStringField(guardrail, "phase") } : {}),
    ...(readStringField(guardrail, "decision") ? { decision: readStringField(guardrail, "decision") } : {}),
    ...(readStringField(guardrail, "status") ? { status: readStringField(guardrail, "status") } : {}),
    ...(readStringField(guardrail, "toolCallId") ? { toolCallId: readStringField(guardrail, "toolCallId") } : {}),
    ...(readStringField(guardrail, "toolName") ? { toolName: readStringField(guardrail, "toolName") } : {}),
    ...(typeof guardrail.mutating === "boolean" ? { mutating: guardrail.mutating } : {}),
    ...(typeof guardrail.readOnly === "boolean" ? { readOnly: guardrail.readOnly } : {}),
    ...(typeof guardrail.approvalRequired === "boolean" ? { approvalRequired: guardrail.approvalRequired } : {}),
    ...(readStringField(guardrail, "riskLevel") ? { riskLevel: readStringField(guardrail, "riskLevel") } : {}),
    ...(typeof guardrail.evidenceCaptured === "boolean" ? { evidenceCaptured: guardrail.evidenceCaptured } : {}),
    ...(readStringField(guardrail, "outputPointerKind") ? { outputPointerKind: readStringField(guardrail, "outputPointerKind") } : {}),
    ...(typeof guardrail.summaryAvailable === "boolean" ? { summaryAvailable: guardrail.summaryAvailable } : {}),
    ...(typeof guardrail.durationMs === "number" ? { durationMs: guardrail.durationMs } : {}),
    ...(readStringField(guardrail, "routeId") ? { routeId: readStringField(guardrail, "routeId") } : {}),
    ...(readStringField(guardrail, "correlationId") ? { correlationId: readStringField(guardrail, "correlationId") } : {}),
    ...(Array.isArray(guardrail.checks) ? { checks: guardrail.checks.filter((entry): entry is string => typeof entry === "string") } : {}),
    ...(Array.isArray(guardrail.inputKeys) ? { inputKeys: guardrail.inputKeys.filter((entry): entry is string => typeof entry === "string") } : {}),
    ...(readStringField(guardrail, "evidenceBoundary") ? { evidenceBoundary: readStringField(guardrail, "evidenceBoundary") } : {}),
  };
}

function buildToolGuardrailTrace(
  guardrail: Record<string, unknown> | null,
  event: FridayAgentRunEventRecord,
  kind: string,
): FridayAgentAuditToolGuardrailTrace | undefined {
  const sanitized = sanitizeToolGuardrailForAudit(guardrail);
  if (!sanitized) return undefined;
  return {
    phase: sanitized.phase === "post" ? "post" : "pre",
    eventPointer: eventPointer(event, kind),
    ...(typeof sanitized.decision === "string" ? { decision: sanitized.decision as "allow" | "block" | "requires_approval" } : {}),
    ...(typeof sanitized.status === "string" ? { status: sanitized.status as "completed" | "failed" | "blocked" } : {}),
    ...(typeof sanitized.riskLevel === "string" ? { riskLevel: sanitized.riskLevel } : {}),
    ...(typeof sanitized.mutating === "boolean" ? { mutating: sanitized.mutating } : {}),
    ...(typeof sanitized.approvalRequired === "boolean" ? { approvalRequired: sanitized.approvalRequired } : {}),
    ...(typeof sanitized.evidenceCaptured === "boolean" ? { evidenceCaptured: sanitized.evidenceCaptured } : {}),
    ...(typeof sanitized.routeId === "string" ? { routeId: sanitized.routeId } : {}),
    ...(typeof sanitized.correlationId === "string" ? { correlationId: sanitized.correlationId } : {}),
  };
}

function eventPointer(event: FridayAgentRunEventRecord, kind = "agent_run_event"): FridayAgentAuditPointer {
  const payload = asRecord(event.payload);
  return {
    kind,
    runId: event.runId ?? readStringField(payload, "runId") ?? "unknown",
    seq: event.seq,
  };
}

function buildPlanControlInput(
  runId: string,
  principal: FridayAuthPrincipal | null,
): FridayAgentPlanControlInput {
  return {
    runId,
    executionContext: {
      surface: "api",
      interactive: true,
    },
    ...(principal
      ? {
        principalId: principal.principalId,
        scopes: principal.scopes,
      }
      : {}),
  };
}

function buildAgentRunDecisionTrace(
  run: FridayAgentRunRecord,
  auditEvents: FridayAgentRunEventRecord[],
): FridayAgentAuditDecisionTrace {
  const planEventNames = new Set([
    "agent.run.planning",
    "agent.run.plan_ready",
    "agent.run.awaiting_clarification",
    "agent.run.awaiting_plan_approval",
    "agent.run.plan_approved",
    "agent.run.plan_rejected",
  ]);
  const planEvents = auditEvents.filter((event) => planEventNames.has(event.eventName));
  const planDecisionEvent = auditEvents.find((event) =>
    event.eventName === "agent.run.plan_approved" || event.eventName === "agent.run.plan_rejected");
  const planDecisionPayload = asRecord(planDecisionEvent?.payload);
  const planDecisionFromEvent = planDecisionEvent
    ? {
      approved: planDecisionEvent.eventName === "agent.run.plan_approved",
      mode: planDecisionEvent.eventName === "agent.run.plan_approved"
        ? readStringField(planDecisionPayload, "approvalMode") ?? "manual-approve"
        : readStringField(planDecisionPayload, "rejectionMode") ?? "manual-reject",
      reviewedAt: readStringField(planDecisionPayload, "approvedAt")
        ?? readStringField(planDecisionPayload, "rejectedAt")
        ?? planDecisionEvent.emittedAt,
      eventPointer: eventPointer(planDecisionEvent, "agent_plan_decision_event"),
    }
    : undefined;
  const startByToolCallId = new Map<string, FridayAgentRunEventRecord>();
  const endByToolCallId = new Map<string, FridayAgentRunEventRecord>();

  for (const event of auditEvents) {
    const payload = asRecord(event.payload);
    const toolCallId = readStringField(payload, "toolCallId");
    if (!toolCallId) continue;
    if (event.eventName === "agent.run.tool_start") {
      startByToolCallId.set(toolCallId, event);
    } else if (event.eventName === "agent.run.tool_end") {
      endByToolCallId.set(toolCallId, event);
    }
  }

  const actions: FridayAgentAuditActionTrace[] = [...startByToolCallId.entries()]
    .map(([toolCallId, startEvent]) => {
      const startPayload = asRecord(startEvent.payload);
      const endEvent = endByToolCallId.get(toolCallId);
      const endPayload = asRecord(endEvent?.payload);
      const isError = endPayload?.isError === true;
      const preGuardrail = buildToolGuardrailTrace(
        readToolGuardrail(startPayload),
        startEvent,
        "agent_tool_pre_guardrail_event",
      );
      const postGuardrail = endEvent
        ? buildToolGuardrailTrace(
            readToolGuardrail(endPayload),
            endEvent,
            "agent_tool_post_guardrail_event",
          )
        : undefined;
      return {
        toolCallId,
        toolName: readStringField(startPayload, "toolName") ?? readStringField(endPayload, "toolName") ?? "unknown",
        status: endEvent ? (isError ? "failed" : "completed") : "started",
        inputPointer: eventPointer(startEvent, "agent_tool_input_event"),
        ...(endEvent ? { outputPointer: eventPointer(endEvent, "agent_tool_output_event") } : {}),
        ...(endEvent ? { evidencePointer: eventPointer(endEvent, "agent_tool_evidence_event") } : {}),
        ...(preGuardrail || postGuardrail
          ? {
            guardrails: {
              ...(preGuardrail ? { pre: preGuardrail } : {}),
              ...(postGuardrail ? { post: postGuardrail } : {}),
            },
          }
          : {}),
        ...(readStringField(endPayload, "routeId") ? { routeId: readStringField(endPayload, "routeId") } : {}),
        ...(readStringField(endPayload, "correlationId") ? { correlationId: readStringField(endPayload, "correlationId") } : {}),
      };
    });

  const toolRequests = auditEvents
    .filter((event) => event.eventName === "agent.run.awaiting_tool_approval")
    .map((event) => {
      const payload = asRecord(event.payload);
      return {
        ...(readStringField(payload, "toolCallId") ? { toolCallId: readStringField(payload, "toolCallId") } : {}),
        ...(readStringField(payload, "toolName") ? { toolName: readStringField(payload, "toolName") } : {}),
        eventPointer: eventPointer(event, "agent_tool_approval_request_event"),
      };
    });

  const grantStateByEventName = new Map<string, "issued" | "used" | "denied" | "revoked">([
    ["agent.run.capability_grant_issued", "issued"],
    ["agent.run.capability_grant_used", "used"],
    ["agent.run.capability_grant_denied", "denied"],
    ["agent.run.capability_grant_revoked", "revoked"],
  ]);
  const grants = auditEvents
    .filter((event) => grantStateByEventName.has(event.eventName))
    .map((event) => {
      const payload = asRecord(event.payload);
      return {
        state: grantStateByEventName.get(event.eventName)!,
        ...(readStringField(payload, "grantId") ? { grantId: readStringField(payload, "grantId") } : {}),
        ...(readStringField(payload, "toolCallId") ? { toolCallId: readStringField(payload, "toolCallId") } : {}),
        ...(readStringField(payload, "toolName") ? { toolName: readStringField(payload, "toolName") } : {}),
        eventPointer: eventPointer(event, "agent_capability_grant_event"),
      };
    });
  const contextReplayReads = auditEvents
    .filter((event) => event.eventName === "agent.run.context_replay_loaded")
    .map((event) => {
      const payload = asRecord(event.payload);
      return {
        eventPointer: eventPointer(event, "agent_context_replay_read_event"),
        ...(readStringField(payload, "sessionKey") ? { sessionKey: readStringField(payload, "sessionKey") } : {}),
        evidenceTier: readStringField(payload, "evidenceTier") ?? "audit_replay_evidence",
        trustLevel: readStringField(payload, "trustLevel") ?? "unconfirmed_summary",
        memoryBoundary: readStringField(payload, "memoryBoundary") ?? "not_user_confirmed_memory",
        ...(typeof payload?.sourceCount === "number" ? { sourceCount: payload.sourceCount } : {}),
        ...(typeof payload?.blockCount === "number" ? { blockCount: payload.blockCount } : {}),
        ...(typeof payload?.redactionApplied === "boolean" ? { redactionApplied: payload.redactionApplied } : {}),
        ...(typeof payload?.redactionCount === "number" ? { redactionCount: payload.redactionCount } : {}),
      };
    });
  const contextReplayWrites = auditEvents
    .filter((event) => event.eventName === "agent.run.compaction_persisted")
    .map((event) => {
      const payload = asRecord(event.payload);
      return {
        eventPointer: eventPointer(event, "agent_context_replay_write_event"),
        ...(readStringField(payload, "sessionKey") ? { sessionKey: readStringField(payload, "sessionKey") } : {}),
        ...(readStringField(payload, "entryId") ? { entryId: readStringField(payload, "entryId") } : {}),
        evidenceTier: readStringField(payload, "evidenceTier") ?? "audit_replay_evidence",
        trustLevel: readStringField(payload, "trustLevel") ?? "unconfirmed_summary",
        ...(typeof payload?.blockCount === "number" ? { blockCount: payload.blockCount } : {}),
        ...(typeof payload?.redactionApplied === "boolean" ? { redactionApplied: payload.redactionApplied } : {}),
        ...(typeof payload?.redactionCount === "number" ? { redactionCount: payload.redactionCount } : {}),
      };
    });
  const contextReplayExceptions = auditEvents
    .filter((event) =>
      event.eventName === "agent.run.compaction_persist_skipped"
      || event.eventName === "agent.run.compaction_persist_failed")
    .map((event) => {
      const payload = asRecord(event.payload);
      const kind: "skipped" | "failed" = event.eventName === "agent.run.compaction_persist_skipped" ? "skipped" : "failed";
      return {
        eventPointer: eventPointer(event, "agent_context_replay_exception_event"),
        kind,
        ...(readStringField(payload, "sessionKey") ? { sessionKey: readStringField(payload, "sessionKey") } : {}),
        ...(readStringField(payload, "skippedReason") ? { reason: readStringField(payload, "skippedReason") } : {}),
        ...(readStringField(payload, "errorName") ? { errorName: readStringField(payload, "errorName") } : {}),
        evidenceTier: readStringField(payload, "evidenceTier") ?? "audit_replay_evidence",
        trustLevel: readStringField(payload, "trustLevel") ?? "unconfirmed_summary",
      };
    });

  return {
    evidenceTier: "audit_replay_evidence",
    source: "friday_agent_run_events",
    boundary: "Derived from persisted run metadata and event pointers only; reading this trace does not execute tools or mutate state.",
    run: {
      runId: run.id,
      status: run.status,
      ...(getRunSurface(run) ? { sourceSurface: getRunSurface(run) } : {}),
      ...(run.startedAt ? { startedAt: run.startedAt } : {}),
      ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    },
    plan: {
      ...(run.planReview ? { reviewPointer: { kind: "agent_run_plan_review", runId: run.id } } : {}),
      ...(run.planReview?.gate?.state ? { state: run.planReview.gate.state } : {}),
      ...(run.planReview?.gate?.kind ? { planKind: run.planReview.gate.kind } : {}),
      ...(typeof run.planReview?.plan?.stepCount === "number" ? { stepCount: run.planReview.plan.stepCount } : {}),
      eventPointers: planEvents.map((event) => eventPointer(event)),
      ...(planDecisionFromEvent
        ? {
          decision: {
            approved: planDecisionFromEvent.approved,
            mode: planDecisionFromEvent.mode,
            reviewedAt: planDecisionFromEvent.reviewedAt,
            eventPointer: planDecisionFromEvent.eventPointer,
          },
        }
        : {}),
    },
    approvals: {
      ...(planDecisionFromEvent
        ? {
          plan: {
            state: planDecisionFromEvent.approved ? "approved" : "rejected",
            reviewedAt: planDecisionFromEvent.reviewedAt,
            mode: planDecisionFromEvent.mode,
            eventPointer: planDecisionFromEvent.eventPointer,
          },
        }
        : {}),
      toolRequests,
      grants,
    },
    actions,
    rollback: {
      available: run.rollbackAvailable === true,
      ...(run.rollbackAvailable === true
        ? { pointer: { kind: "agent_runtime_rollback_checkpoint", runId: run.id } }
        : {}),
    },
    contextReplay: {
      reads: contextReplayReads,
      writes: contextReplayWrites,
      exceptions: contextReplayExceptions,
      boundary: "Context replay is audit evidence and unconfirmed summary input; it is not durable memory or user-confirmed preference.",
    },
    traceCompleteness: {
      hasPlanReview: Boolean(run.planReview),
      hasPlanDecision: Boolean(planDecisionFromEvent),
      toolStartCount: startByToolCallId.size,
      toolEndCount: endByToolCallId.size,
      unpairedToolStartCount: actions.filter((action) => action.status === "started").length,
      hasTerminalEvent: auditEvents.some((event) => TERMINAL_EVENT_NAMES.has(event.eventName)),
      contextReplayReadCount: contextReplayReads.length,
      contextReplayWriteCount: contextReplayWrites.length,
      contextReplayExceptionCount: contextReplayExceptions.length,
    },
  };
}

function sanitizeAuditEventPayload(event: FridayAgentRunEventRecord): unknown {
  const payload = asRecord(event.payload);
  if (!payload) {
    return event.payload;
  }
  if (event.eventName === "agent.run.started") {
    const contextSelection = asRecord(payload.contextSelection);
    const selectedBlocks = Array.isArray(contextSelection?.selectedBlocks)
      ? contextSelection.selectedBlocks
      : [];
    return {
      ...(readStringField(payload, "runId") ? { runId: readStringField(payload, "runId") } : {}),
      hasTask: typeof payload.task === "string" && payload.task.length > 0,
      hasModel: typeof payload.model === "string" && payload.model.length > 0,
      providerRouted: typeof payload.providerId === "string" && payload.providerId.length > 0,
      ...(asRecord(payload.taskProfile)?.id ? { taskProfileId: readStringField(asRecord(payload.taskProfile), "id") } : {}),
      contextSelection: {
        selectedBlockCount: selectedBlocks.length,
        hasSelectionReasons: Array.isArray(contextSelection?.selectionReasons) && contextSelection.selectionReasons.length > 0,
      },
    };
  }
  if (event.eventName === "agent.run.planning") {
    return {
      ...(readStringField(payload, "runId") ? { runId: readStringField(payload, "runId") } : {}),
      status: "planning",
      hasMessage: typeof payload.message === "string" && payload.message.length > 0,
    };
  }
  if (event.eventName === "agent.run.plan_ready") {
    return {
      ...(readStringField(payload, "runId") ? { runId: readStringField(payload, "runId") } : {}),
      ...(readStringField(payload, "planKind") ? { planKind: readStringField(payload, "planKind") } : {}),
      hasPlanMarkdown: typeof payload.planMarkdown === "string" && payload.planMarkdown.length > 0,
      hasPlanSummary: typeof payload.planSummary === "string" && payload.planSummary.length > 0,
    };
  }
  if (event.eventName === "agent.run.awaiting_clarification") {
    const questions = Array.isArray(payload.questions)
      ? payload.questions.filter((question): question is string => typeof question === "string" && question.trim().length > 0)
      : [];
    return {
      ...(readStringField(payload, "runId") ? { runId: readStringField(payload, "runId") } : {}),
      status: "awaiting_clarification",
      ...(readStringField(payload, "planKind") ? { planKind: readStringField(payload, "planKind") } : {}),
      hasMessage: typeof payload.message === "string" && payload.message.length > 0,
      questionCount: questions.length,
    };
  }
  if (event.eventName === "agent.run.awaiting_plan_approval") {
    return {
      ...(readStringField(payload, "runId") ? { runId: readStringField(payload, "runId") } : {}),
      status: "awaiting_plan_approval",
      ...(readStringField(payload, "planKind") ? { planKind: readStringField(payload, "planKind") } : {}),
      hasMessage: typeof payload.message === "string" && payload.message.length > 0,
      hasPlanMarkdown: typeof payload.planMarkdown === "string" && payload.planMarkdown.length > 0,
      hasPlanSummary: typeof payload.planSummary === "string" && payload.planSummary.length > 0,
    };
  }
  if (event.eventName === "agent.run.tool_start" || event.eventName === "agent.run.tool_end") {
    const guardrail = sanitizeToolGuardrailForAudit(readToolGuardrail(payload));
    return {
      ...(readStringField(payload, "runId") ? { runId: readStringField(payload, "runId") } : {}),
      ...(readStringField(payload, "toolCallId") ? { toolCallId: readStringField(payload, "toolCallId") } : {}),
      ...(readStringField(payload, "toolName") ? { toolName: readStringField(payload, "toolName") } : {}),
      ...(event.eventName === "agent.run.tool_end" && typeof payload.isError === "boolean" ? { isError: payload.isError } : {}),
      ...(event.eventName === "agent.run.tool_end" && typeof payload.durationMs === "number" ? { durationMs: payload.durationMs } : {}),
      ...(event.eventName === "agent.run.tool_end" && readStringField(payload, "routeId") ? { routeId: readStringField(payload, "routeId") } : {}),
      ...(event.eventName === "agent.run.tool_end" && readStringField(payload, "correlationId") ? { correlationId: readStringField(payload, "correlationId") } : {}),
      hasParams: event.eventName === "agent.run.tool_start" && typeof payload.params === "object" && payload.params !== null,
      hasSummary: event.eventName === "agent.run.tool_end" && typeof payload.summary === "string" && payload.summary.length > 0,
      ...(guardrail ? { guardrail } : {}),
    };
  }
  if (event.eventName === "agent.run.awaiting_tool_approval") {
    const guardrail = sanitizeToolGuardrailForAudit(readToolGuardrail(payload));
    return {
      ...(readStringField(payload, "runId") ? { runId: readStringField(payload, "runId") } : {}),
      status: "awaiting_tool_approval",
      ...(readStringField(payload, "grantId") ? { grantId: readStringField(payload, "grantId") } : {}),
      ...(readStringField(payload, "toolCallId") ? { toolCallId: readStringField(payload, "toolCallId") } : {}),
      ...(readStringField(payload, "toolName") ? { toolName: readStringField(payload, "toolName") } : {}),
      ...(readStringField(payload, "expiresAt") ? { expiresAt: readStringField(payload, "expiresAt") } : {}),
      ...(readStringField(payload, "riskLevel") ? { riskLevel: readStringField(payload, "riskLevel") } : {}),
      hasParams: typeof payload.params === "object" && payload.params !== null,
      hasReason: typeof payload.reason === "string" && payload.reason.length > 0,
      ...(guardrail ? { guardrail } : {}),
    };
  }
  if (event.eventName === "agent.run.executing") {
    return {
      ...(readStringField(payload, "runId") ? { runId: readStringField(payload, "runId") } : {}),
      status: "executing",
      ...(typeof payload.step === "number" ? { step: payload.step } : {}),
      ...(typeof payload.totalSteps === "number" ? { totalSteps: payload.totalSteps } : {}),
      hasDescription: typeof payload.description === "string" && payload.description.length > 0,
    };
  }
  if (event.eventName === "agent.run.text_delta") {
    return {
      ...(readStringField(payload, "runId") ? { runId: readStringField(payload, "runId") } : {}),
      type: "agent.run.text_delta",
      hasDelta: typeof payload.delta === "string" && payload.delta.length > 0,
    };
  }
  if (
    event.eventName === "agent.run.context_replay_loaded"
    || event.eventName === "agent.run.compaction_persisted"
    || event.eventName === "agent.run.compaction_persist_skipped"
    || event.eventName === "agent.run.compaction_persist_failed"
  ) {
    return {
      ...(readStringField(payload, "runId") ? { runId: readStringField(payload, "runId") } : {}),
      ...(readStringField(payload, "sessionKey") ? { sessionKey: readStringField(payload, "sessionKey") } : {}),
      ...(readStringField(payload, "entryId") ? { entryId: readStringField(payload, "entryId") } : {}),
      ...(readStringField(payload, "evidenceTier") ? { evidenceTier: readStringField(payload, "evidenceTier") } : {}),
      ...(readStringField(payload, "trustLevel") ? { trustLevel: readStringField(payload, "trustLevel") } : {}),
      ...(readStringField(payload, "memoryBoundary") ? { memoryBoundary: readStringField(payload, "memoryBoundary") } : {}),
      ...(readStringField(payload, "skippedReason") ? { skippedReason: readStringField(payload, "skippedReason") } : {}),
      ...(readStringField(payload, "errorName") ? { errorName: readStringField(payload, "errorName") } : {}),
      ...(typeof payload.sourceCount === "number" ? { sourceCount: payload.sourceCount } : {}),
      ...(typeof payload.blockCount === "number" ? { blockCount: payload.blockCount } : {}),
      ...(typeof payload.redactionApplied === "boolean" ? { redactionApplied: payload.redactionApplied } : {}),
      ...(typeof payload.redactionCount === "number" ? { redactionCount: payload.redactionCount } : {}),
    };
  }
  if (
    event.eventName === "agent.run.completed"
    || event.eventName === "agent.run.failed"
    || event.eventName === "agent.run.failed_tests"
    || event.eventName === "agent.run.cancelled"
    || event.eventName === "agent.run.degraded"
    || event.eventName === "agent.run.mode_changed"
    || event.eventName === "agent.run.route_selected"
    || event.eventName === "agent.run.route_fallback"
    || event.eventName === "agent.run.route_mismatch"
    || event.eventName.startsWith("autonomous.")
    || event.eventName.startsWith("agent.subagent.")
    || event.eventName.startsWith("agent.run.capability_grant_")
    || event.eventName === "agent.run.plan_approved"
    || event.eventName === "agent.run.plan_rejected"
  ) {
    return {
      ...(readStringField(payload, "runId") ? { runId: readStringField(payload, "runId") } : {}),
      ...(readStringField(payload, "parentRunId") ? { parentRunId: readStringField(payload, "parentRunId") } : {}),
      ...(readStringField(payload, "goalId") ? { goalId: readStringField(payload, "goalId") } : {}),
      ...(readStringField(payload, "toolCallId") ? { toolCallId: readStringField(payload, "toolCallId") } : {}),
      ...(readStringField(payload, "toolName") ? { toolName: readStringField(payload, "toolName") } : {}),
      ...(readStringField(payload, "grantId") ? { grantId: readStringField(payload, "grantId") } : {}),
      ...(readStringField(payload, "routeId") ? { routeId: readStringField(payload, "routeId") } : {}),
      ...(readStringField(payload, "correlationId") ? { correlationId: readStringField(payload, "correlationId") } : {}),
      ...(typeof payload.durationMs === "number" ? { durationMs: payload.durationMs } : {}),
      ...(typeof payload.toolCallCount === "number" ? { toolCallCount: payload.toolCallCount } : {}),
      ...(typeof payload.isError === "boolean" ? { isError: payload.isError } : {}),
      hasMessage: typeof payload.message === "string" && payload.message.length > 0,
      hasSummary: typeof payload.summary === "string" && payload.summary.length > 0,
      hasReason: typeof payload.reason === "string" && payload.reason.length > 0,
      hasErrorMessage: typeof payload.errorMessage === "string" && payload.errorMessage.length > 0,
    };
  }
  return {
    ...(readStringField(payload, "runId") ? { runId: readStringField(payload, "runId") } : {}),
    redacted: true,
    payloadKeys: Object.keys(payload).sort(),
  };
}

// ─── Deps ───

export interface FridayAgentRoutesDeps {
  validateRequestedRoute?: (
    providerId?: string,
    model?: string,
    tenantContext?: FridayProviderTenantContext,
  ) => Promise<void>;
  startRun: (input: {
    task: string;
    taskPrompt?: string;
    sessionKey?: string;
    providerId?: string;
    model?: string;
    replyToMessageId?: string;
    timezone?: string;
    timeoutMs?: number;
    requireReview?: boolean;
    constraints?: FridayAgentRunConstraints;
    disabledToolNames?: string[];
    taskProfile?: FridayAgentTaskProfileInput;
    executionContext?: {
      surface?: string;
      interactive?: boolean;
      browserPresentationMode?: "auto" | "headless" | "host_chrome_visible";
      packId?: string;
    };
    apiIdempotencyKey?: string;
    apiIdempotencyPayloadHash?: string;
    apiIdempotencyReceivedAt?: string;
    principalId?: string;
    scopes?: string[];
    tenantContext?: FridayProviderTenantContext;
    // execrun-replacement S-F-compose (DARK): the explicit per-run Rust read-tool grant.
    // Additive + optional; forwarded straight to the route-bound startRun wrapper, which
    // (only when the default-OFF Rust-route flag is on) uses it as the clause-4 qualifier.
    allowedRustRouteTools?: string[];
    // execrun S-F carry-forward (DARK): a plan-review OVERRIDE marker (predicate clause-5
    // disqualifier). Additive + optional; PRESENCE alone disqualifies the Rust route (→ the
    // unchanged 503). Forwarded RAW — presence-only, never coerced/injected (route-not-method
    // pin: it may only DISQUALIFY, never grant). Absent for every existing caller.
    planReviewOverride?: unknown;
    // (A2b Phase 2, mutation-relax — DARK, default-off) the explicit POSITIVE grant of mutating
    // Rust tools + the operator-signed gate opt-in marker. Additive + optional; forwarded straight
    // to the route-bound startRun wrapper, which (ONLY when the default-OFF
    // `FRIDAY_AGENT_RUN_CONTROL_VIA_RUST` flag is on) lets the qualifier admit a `readOnly:false`
    // run. Absent for every existing caller (→ the mutating branch never opens → byte-identical
    // 503). NEVER infers mutation-permission from `readOnly` flipping — both are explicit gates.
    mutatingToolGrant?: string[];
    mutationGate?: string;
    // (NS45-PR2 mission-bound driver — DARK) the first-class Mission handle this run binds to.
    // Additive + optional; forwarded straight to the route-bound startRun wrapper, which threads
    // it (UNCHANGED, camelCase) onto the sealed-WS dispatch ONLY when present. Absent for every
    // existing caller (→ omitted on the wire → byte-identical unbound run). Does NOT change
    // Rust-route qualification; the bound owner stays the authenticated principal, never this handle.
    missionContext?: {
      fridayConversationId: string;
      missionId: string;
      workItemId: string;
    };
  }) => Promise<FridayAgentRuntimeResult>;
  getRun: (runId: string) => FridayAgentRunRecord | null;
  listRuns: (query: {
    status?: FridayAgentRunStatus;
    limit?: number;
    cursor?: string;
  }) => FridayAgentRunRecord[];
  listRunEvents: (runId: string, afterSeq?: number) => FridayAgentRunEventRecord[];
  cancelRun: (runId: string) => void;
  approvePlan: (input: FridayAgentPlanControlInput) => Promise<FridayAgentRuntimeResult>;
  rejectPlan: (input: FridayAgentPlanControlInput) => Promise<FridayAgentRuntimeResult>;
  resolveToolApproval: (
    runId: string,
    toolCallId: string,
    approved: boolean,
    options: {
      reason?: string;
      approverPrincipalId: string;
      approverPrincipalType?: string;
      approvalSurface?: string;
    },
  ) => { resolved: boolean; grantId?: string; decision?: "approved" | "rejected" };
  rollbackRun?: (runId: string) => { restoredCount: number; errors: Array<{ filePath: string; error: string }> } | null;
  eventEmitter: FridayAgentEventEmitter;
  automationService: FridayAgentAutomationService;
  /**
   * (S6 mutating-chat — DARK, default-off) The resolved on/off state of the Rust run-CONTROL plane
   * flag (`FRIDAY_AGENT_RUN_CONTROL_VIA_RUST`). The resume route is gated on this being EXACTLY
   * `true`; absent / `undefined` / `false` (the default) ⇒ the resume route SHORT-CIRCUITS to the
   * SAME fail-closed 503 a non-routed (retired) run raises — BEFORE any run lookup, so a dark host
   * leaks no run existence and is byte-identical to today. Sourced from the SAME
   * `resolveAgentRunControlViaRust` boolean the Rust server + sealed client gate on, so the TS
   * control surface and the Rust control plane flip together.
   */
  agentRunControlViaRust?: boolean;
  /**
   * (S6 mutating-chat — DARK, default-off) Relay an operator's OPAQUE Ed25519-signed approval to
   * RESUME a paused mutating run. The route is a PURE COURIER: it relays `opaqueSignedBlob` VERBATIM
   * to the Rust sealed-WS resume (INV-1 — TS NEVER parses/validates/inspects the signature/digest;
   * verification happens ONLY in Rust under the operator verify key). The route enforces, BEFORE
   * calling this, that the authenticated caller equals the run's bound owner. This fn resolves the
   * WS client X25519 secret + dials the sealed resume; it fails CLOSED (the byte-identical 503) on a
   * missing secret / WS error / flag-off. Returns the refs-only resume outcome. Provided ONLY by the
   * runtime; absent ⇒ the route is unreachable (its flag gate has already 503'd).
   */
  resumeRun?: (
    runId: string,
    opaqueSignedBlob: Uint8Array,
    principal: FridayAuthPrincipal | null,
  ) => Promise<FridayResumeAgentRunResponse>;
}

interface FridayAgentPlanControlInput {
  runId: string;
  principalId?: string;
  scopes?: string[];
  executionContext?: FridayAgentExecutionContext;
}

interface FridayAgentAuditPointer {
  kind: string;
  runId: string;
  seq?: number;
}

interface FridayAgentAuditToolGuardrailTrace {
  phase: "pre" | "post";
  eventPointer: FridayAgentAuditPointer;
  decision?: "allow" | "block" | "requires_approval";
  status?: "completed" | "failed" | "blocked";
  riskLevel?: string;
  mutating?: boolean;
  approvalRequired?: boolean;
  evidenceCaptured?: boolean;
  routeId?: string;
  correlationId?: string;
}

interface FridayAgentAuditActionTrace {
  toolCallId: string;
  toolName: string;
  status: "started" | "completed" | "failed";
  inputPointer: FridayAgentAuditPointer;
  outputPointer?: FridayAgentAuditPointer;
  evidencePointer?: FridayAgentAuditPointer;
  guardrails?: {
    pre?: FridayAgentAuditToolGuardrailTrace;
    post?: FridayAgentAuditToolGuardrailTrace;
  };
  routeId?: string;
  correlationId?: string;
}

interface FridayAgentAuditDecisionTrace {
  evidenceTier: "audit_replay_evidence";
  source: "friday_agent_run_events";
  boundary: string;
  run: {
    runId: string;
    status: FridayAgentRunStatus;
    sourceSurface?: string;
    startedAt?: string;
    completedAt?: string;
  };
  plan: {
    reviewPointer?: FridayAgentAuditPointer;
    state?: string;
    planKind?: string;
    stepCount?: number;
    eventPointers: FridayAgentAuditPointer[];
    decision?: {
      approved: boolean;
      mode: string;
      reviewedAt: string;
      eventPointer?: FridayAgentAuditPointer;
    };
  };
  approvals: {
    plan?: {
      state: "approved" | "rejected";
      reviewedAt: string;
      mode: string;
      eventPointer?: FridayAgentAuditPointer;
    };
    toolRequests: Array<{
      toolCallId?: string;
      toolName?: string;
      eventPointer: FridayAgentAuditPointer;
    }>;
    grants: Array<{
      state: "issued" | "used" | "denied" | "revoked";
      grantId?: string;
      toolCallId?: string;
      toolName?: string;
      eventPointer: FridayAgentAuditPointer;
    }>;
  };
  actions: FridayAgentAuditActionTrace[];
  rollback: {
    available: boolean;
    pointer?: FridayAgentAuditPointer;
  };
  contextReplay: {
    reads: Array<{
      eventPointer: FridayAgentAuditPointer;
      sessionKey?: string;
      evidenceTier: string;
      trustLevel: string;
      memoryBoundary: string;
      sourceCount?: number;
      blockCount?: number;
      redactionApplied?: boolean;
      redactionCount?: number;
    }>;
    writes: Array<{
      eventPointer: FridayAgentAuditPointer;
      sessionKey?: string;
      entryId?: string;
      evidenceTier: string;
      trustLevel: string;
      blockCount?: number;
      redactionApplied?: boolean;
      redactionCount?: number;
    }>;
    exceptions: Array<{
      eventPointer: FridayAgentAuditPointer;
      kind: "skipped" | "failed";
      sessionKey?: string;
      reason?: string;
      errorName?: string;
      evidenceTier: string;
      trustLevel: string;
    }>;
    boundary: string;
  };
  traceCompleteness: {
    hasPlanReview: boolean;
    hasPlanDecision: boolean;
    toolStartCount: number;
    toolEndCount: number;
    unpairedToolStartCount: number;
    hasTerminalEvent: boolean;
    contextReplayReadCount: number;
    contextReplayWriteCount: number;
    contextReplayExceptionCount: number;
  };
}

function readPreferredString(
  primary: unknown,
  alias: unknown,
): string | undefined {
  if (typeof primary === "string" && primary.trim().length > 0) {
    return primary.trim();
  }
  if (typeof alias === "string" && alias.trim().length > 0) {
    return alias.trim();
  }
  return undefined;
}

function assertNoAliasConflict(
  primary: unknown,
  alias: unknown,
  fieldName: string,
  aliasFieldName: string,
): void {
  if (typeof primary !== "string" || typeof alias !== "string") {
    return;
  }
  const normalizedPrimary = primary.trim();
  const normalizedAlias = alias.trim();
  if (!normalizedPrimary || !normalizedAlias || normalizedPrimary === normalizedAlias) {
    return;
  }
  throw new FridayDomainError(
    "VALIDATION_ERROR",
    `${fieldName} and ${aliasFieldName} must match when both are provided`,
    { httpStatus: 400 },
  );
}

function toFridayAgentRunExecutionResponse(
  result: FridayAgentRuntimeResult,
): FridayAgentRunExecutionResponse {
  return {
    runId: result.runId,
    status: result.status,
    response: result.response,
    toolCallCount: result.toolCallCount,
    durationMs: result.durationMs,
    usageInput: result.usageInput,
    usageOutput: result.usageOutput,
    ...(result.images ? { images: result.images } : {}),
    ...(result.finalResponse ? { finalResponse: result.finalResponse } : {}),
    ...(result.contextCostSummary ? { contextCostSummary: result.contextCostSummary } : {}),
    ...(result.taskProfile ? { taskProfile: result.taskProfile } : {}),
  };
}

// ─── SSE response type ───

/** Describes the raw Node `ServerResponse` shape needed for SSE streaming. */
interface FridaySseResponse {
  writeHead(statusCode: number, headers: Record<string, string>): void;
  write(chunk: string): boolean;
  end(): void;
  on(event: string, listener: () => void): void;
}

// ─── Factory ───

export function createFridayAgentRoutes(
  deps: FridayAgentRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  function getVisibleRunOrThrow(runId: string): FridayAgentRunRecord {
    const run = deps.getRun(runId);
    if (!run || !isUserVisibleAgentRun(run)) {
      throw new FridayDomainError(
        "AGENT_RUN_NOT_FOUND",
        "Agent run not found",
        { httpStatus: 404 },
      );
    }
    return sanitizeUserVisibleRun(run);
  }

  function getToolApprovalTargetRunOrThrow(runId: string): FridayAgentRunRecord {
    const run = deps.getRun(runId);
    if (!run || isInternalAutonomousRun(run)) {
      throw new FridayDomainError(
        "AGENT_RUN_NOT_FOUND",
        "Agent run not found",
        { httpStatus: 404 },
      );
    }
    return run;
  }

  // (S6 mutating-chat) The byte-IDENTICAL fail-closed 503 a non-routed (retired) agent-run raises
  // (same code/message/status/classification/replacement as the runtime's `failClosedRustAgentRun`
  // + the retired `startRun`). The resume route throws this on the flag-OFF short-circuit — BEFORE
  // any run lookup — so a DARK host's `/resume` is INDISTINGUISHABLE from the retired path: it leaks
  // no run existence and is byte-identical to today.
  function failClosedResumeRoute(): FridayDomainError {
    return new FridayDomainError(
      "TS_RUNTIME_AGENT_RUNS_RETIRED",
      "Agent run execution is fail-closed while runtime ownership is being moved out of TypeScript.",
      {
        httpStatus: 503,
        details: {
          classification: "fail_closed",
          replacement: "rust_owned_agent_run_entrypoint_required",
        },
      },
    );
  }

  // (S6 mutating-chat) Read a run's BOUND OWNER principal from `metadata.apiRequest.principalId`
  // (the SAME shape the compose paused/delivered projection stamps + the idempotency reads use).
  // A blank/whitespace/absent value ⇒ `undefined` (fail-closed: an ownerless run can be resumed by
  // NOBODY — every caller mismatches). NEVER the body — a principal id is a ref.
  function readRunOwnerPrincipalId(run: FridayAgentRunRecord): string | undefined {
    const owner = run.metadata?.apiRequest?.principalId;
    return typeof owner === "string" && owner.trim().length > 0 ? owner.trim() : undefined;
  }

  function buildTenantContext(principal: unknown): FridayProviderTenantContext | undefined {
    if (!principal || typeof principal !== "object") {
      return undefined;
    }
    const record = principal as {
      userId?: unknown;
      principalId?: unknown;
      tenantId?: unknown;
    };
    const userId = typeof record.userId === "string" && record.userId.trim().length > 0
      ? record.userId.trim()
      : typeof record.principalId === "string" && record.principalId.trim().length > 0
        ? record.principalId.trim()
        : undefined;
    if (!userId) {
      return undefined;
    }
    const tenantId = typeof record.tenantId === "string" && record.tenantId.trim().length > 0
      ? record.tenantId.trim()
      : userId;
    return {
      hubId: tenantId,
      userId,
    };
  }

  function serializeReplayEvent(
    event: FridayAgentRunEventRecord,
    replayed: boolean,
  ): string {
    return JSON.stringify({
      type: event.eventName,
      payload: sanitizeAuditEventPayload(event),
      seq: event.seq,
      emittedAt: event.emittedAt,
      replayed,
    });
  }

  return [
    // ─── POST /v1/agent/runs ───
    {
      operationId: "agent.runs.start",
      method: "POST",
      path: "/v1/agent/runs",
      auth: { public: true },
      rateLimitPolicyId: "agent.run",
      async handler(ctx) {
        const body = ctx.body as FridayStartAgentRunRequest | null;
        if (!body || typeof body.task !== "string" || body.task.trim() === "") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "task is required and must be a non-empty string",
            { httpStatus: 400 },
          );
        }
        assertNoAliasConflict(body.providerId, body.requestedProviderId, "providerId", "requestedProviderId");
        assertNoAliasConflict(body.model, body.requestedModel, "model", "requestedModel");
        const providerId = readPreferredString(body.providerId, body.requestedProviderId);
        const model = readPreferredString(body.model, body.requestedModel);
        const publicIsolation = buildPublicV1AgentRunIsolation(ctx.principal);
        const tenantContext = publicIsolation ? undefined : buildTenantContext(ctx.principal);
        if (providerId || model) {
          await deps.validateRequestedRoute?.(providerId, model, tenantContext);
        }
        const replyToMessageId = typeof body.replyToMessageId === "string" ? body.replyToMessageId : undefined;
        if (body.replyToMessageId !== undefined && (!replyToMessageId || replyToMessageId.trim() === "")) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "replyToMessageId must be a non-empty string when provided",
            { httpStatus: 400 },
          );
        }
        const taskPrompt = typeof body.taskPrompt === "string" && body.taskPrompt.trim().length > 0
          ? body.taskPrompt.trim()
          : undefined;
        if (body.taskPrompt !== undefined && !taskPrompt) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "taskPrompt must be a non-empty string when provided",
            { httpStatus: 400 },
          );
        }
        const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey : undefined;
        if (body.sessionKey !== undefined && (!sessionKey || sessionKey.trim() === "")) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "sessionKey must be a non-empty string when provided",
            { httpStatus: 400 },
          );
        }
        const timezone = parseOptionalIanaTimezone(body.timezone, "timezone");
        let timeoutMs: number | undefined;
        if (body.timeoutMs !== undefined) {
          const parsed = Number(body.timeoutMs);
          if (!Number.isFinite(parsed) || parsed < 1 || parsed > 600_000) {
            throw new FridayDomainError(
              "VALIDATION_ERROR",
              "timeoutMs must be a positive number up to 600000",
              { httpStatus: 400 },
            );
          }
          timeoutMs = parsed;
        }

        // IMPL-1: requireReview flag
        const requireReview = typeof body.requireReview === "boolean" ? body.requireReview : undefined;

        // IMPL-4: constraints
        let constraints: FridayAgentRunConstraints | undefined;
        if (body.constraints !== undefined && typeof body.constraints === "object" && body.constraints !== null && !Array.isArray(body.constraints)) {
          const c = body.constraints as Record<string, unknown>;
          const validModes = ["plan", "execute", "restricted"] as const;
          const parsedMode = typeof c.operationalMode === "string" && (validModes as readonly string[]).includes(c.operationalMode)
            ? (c.operationalMode as "plan" | "execute" | "restricted")
            : undefined;
          constraints = {
            readOnly: typeof c.readOnly === "boolean" ? c.readOnly : undefined,
            operationalMode: parsedMode,
          };
        }
        if (publicIsolation) {
          constraints = {
            ...constraints,
            ...publicIsolation.constraints,
          };
        }

        let executionContext:
          | {
            surface?: string;
            interactive?: boolean;
            browserPresentationMode?: "auto" | "headless" | "host_chrome_visible";
            packId?: string;
          }
          | undefined;
        if (
          body.executionContext !== undefined
          && typeof body.executionContext === "object"
          && body.executionContext !== null
          && !Array.isArray(body.executionContext)
        ) {
          const input = body.executionContext as Record<string, unknown>;
          const surface = typeof input.surface === "string" && input.surface.trim().length > 0
            ? input.surface.trim()
            : undefined;
          const interactive = typeof input.interactive === "boolean"
            ? input.interactive
            : undefined;
          const browserPresentationMode = input.browserPresentationMode === "auto"
            || input.browserPresentationMode === "headless"
            || input.browserPresentationMode === "host_chrome_visible"
            ? input.browserPresentationMode
            : undefined;
          const rawPackId = input.packId;
          if (rawPackId !== undefined && (typeof rawPackId !== "string" || rawPackId.trim().length === 0)) {
            throw new FridayDomainError(
              "VALIDATION_ERROR",
              "executionContext.packId must be a non-empty string when provided",
              { httpStatus: 400 },
            );
          }
          const packId = typeof rawPackId === "string" && rawPackId.trim().length > 0
            ? rawPackId.trim()
            : undefined;
          executionContext = {
            ...(surface ? { surface } : {}),
            ...(interactive !== undefined ? { interactive } : {}),
            ...(browserPresentationMode ? { browserPresentationMode } : {}),
            ...(packId ? { packId } : {}),
          };
        }

        let taskProfile: FridayAgentTaskProfileInput | undefined;
        if (
          body.taskProfile !== undefined
          && typeof body.taskProfile === "object"
          && body.taskProfile !== null
          && !Array.isArray(body.taskProfile)
        ) {
          const input = body.taskProfile as Record<string, unknown>;
          const id = input.id;
          const reasoningEffort = input.reasoningEffort;
          const temperature = input.temperature;
          taskProfile = {
            ...(id === "default" || id === "deterministic" || id === "planning" || id === "review" || id === "creative"
              ? { id }
              : {}),
            ...(typeof input.model === "string" && input.model.trim().length > 0
              ? { model: input.model.trim() }
              : {}),
            ...(typeof temperature === "number" && Number.isFinite(temperature) && temperature >= 0 && temperature <= 2
              ? { temperature }
              : {}),
            ...(reasoningEffort === "low" || reasoningEffort === "medium" || reasoningEffort === "high"
              ? { reasoningEffort }
              : {}),
            ...(typeof input.reason === "string" && input.reason.trim().length > 0
              ? { reason: input.reason.trim() }
              : {}),
          };
        }

        const principalInput = ctx.principal && !publicIsolation
          ? {
            principalId: ctx.principal.principalId,
            scopes: ctx.principal.scopes,
            tenantContext,
          }
          : {};
        const apiIdempotencyKey = readIdempotencyKeyHeader(ctx.headers);
        const apiIdempotencyPayloadHash = apiIdempotencyKey
          ? hashIdempotencyPayload({
            task: body.task,
            taskPrompt,
            sessionKey,
            providerId,
            model,
            replyToMessageId,
            timezone,
            timeoutMs,
            requireReview,
            constraints,
            taskProfile,
            executionContext,
          })
          : undefined;

        // execrun-replacement S-F-compose (DARK): parse the explicit, optional per-run Rust
        // read-tool grant. Accepted ONLY as an array of non-empty strings; any other shape
        // (or absence) ⇒ undefined ⇒ the Rust-route predicate's clause-4 fails ⇒ today's
        // unchanged 503. Additive: no existing caller sends it, so behavior is unchanged.
        const allowedRustRouteTools = Array.isArray(body.allowedRustRouteTools)
          && body.allowedRustRouteTools.every(
            (t): t is string => typeof t === "string" && t.length > 0,
          )
          ? body.allowedRustRouteTools
          : undefined;

        // execrun S-F carry-forward (DARK): forward `body.planReviewOverride` RAW into the
        // route-bound startRun wrapper so the Rust-route predicate's clause-5 plan-review
        // disqualifier can fire (PRESENCE → disqualified → today's unchanged 503). Parsed
        // presence-only (`"planReviewOverride" in body`) — NEVER coerced, validated, or
        // injected: the route-not-method pin requires this field may ONLY disqualify, never
        // grant. Absent for every existing caller (conditional spread → omitted → byte-
        // identical), so the only HTTP-observable change is: a run carrying this marker is now
        // disqualified instead of (incorrectly) qualifying.
        const hasPlanReviewOverride = "planReviewOverride" in body;

        // (A2b Phase 2, mutation-relax — DARK, default-off) parse the explicit, optional per-run
        // mutating-tool grant + the operator-signed gate marker. Mirrors the `allowedRustRouteTools`
        // extraction EXACTLY: accepted ONLY as an array of non-empty strings (grant) / a non-empty
        // string (gate); any other shape (or absence) ⇒ undefined. ADDITIVE: no existing caller sends
        // either, so behavior is unchanged (→ the qualifier's mutating branch stays closed → today's
        // 503). The gate is enforced downstream by the qualifier (closed allow-list + the
        // `operator_signed_ed25519` marker) ONLY behind the default-off `FRIDAY_AGENT_RUN_CONTROL_VIA_RUST`
        // flag — these fields can ONLY make a `readOnly:false` run a CANDIDATE, never AUTHORIZE the
        // mutation (the Rust gate Pauses every mutating tool pending an operator-signed Ed25519
        // approval; this route never carries the signature). Mutation-permission is NEVER inferred
        // from `readOnly` flipping — both the grant and the marker are explicit, required gates.
        const mutatingToolGrant = Array.isArray(body.mutatingToolGrant)
          && body.mutatingToolGrant.every(
            (t): t is string => typeof t === "string" && t.length > 0,
          )
          ? body.mutatingToolGrant
          : undefined;
        const mutationGate =
          typeof body.mutationGate === "string" && body.mutationGate.length > 0
            ? body.mutationGate
            : undefined;

        // (NS45-PR2 mission-bound driver — DARK) parse the optional first-class Mission handle.
        // ALL-OR-NOTHING (mirrors the executionContext/taskProfile structured-body discipline):
        // accepted ONLY as an object carrying all THREE required, non-empty string fields
        // (fridayConversationId/missionId/workItemId — the exact 3 the Rust `MissionWorkItemContextWire`
        // requires). Any other shape — absence, non-object, or a MISSING/blank field — ⇒ undefined ⇒
        // the conditional spread below OMITS the key ⇒ a byte-identical unbound dispatch (today's
        // behavior). PRESENCE-ONLY: never fabricate a field, never crash on a partial body. This
        // handle ONLY SELECTS the Mission/WorkItem to bind; the run's owner stays the authenticated
        // principal (forwarded below via `principalInput`), never this handle.
        let missionContext:
          | { fridayConversationId: string; missionId: string; workItemId: string }
          | undefined;
        if (
          body.missionContext !== undefined
          && typeof body.missionContext === "object"
          && body.missionContext !== null
          && !Array.isArray(body.missionContext)
        ) {
          const mc = body.missionContext as Record<string, unknown>;
          const fridayConversationId =
            typeof mc.fridayConversationId === "string" && mc.fridayConversationId.trim().length > 0
              ? mc.fridayConversationId.trim()
              : undefined;
          const missionId =
            typeof mc.missionId === "string" && mc.missionId.trim().length > 0
              ? mc.missionId.trim()
              : undefined;
          const workItemId =
            typeof mc.workItemId === "string" && mc.workItemId.trim().length > 0
              ? mc.workItemId.trim()
              : undefined;
          if (fridayConversationId && missionId && workItemId) {
            missionContext = { fridayConversationId, missionId, workItemId };
          }
        }

        const result = await deps.startRun({
          task: body.task,
          taskPrompt,
          sessionKey,
          providerId,
          model,
          replyToMessageId,
          timezone,
          timeoutMs,
          requireReview,
          constraints,
          disabledToolNames: publicIsolation?.disabledToolNames,
          taskProfile,
          executionContext,
          ...(allowedRustRouteTools ? { allowedRustRouteTools } : {}),
          ...(hasPlanReviewOverride
            ? { planReviewOverride: (body as Record<string, unknown>).planReviewOverride }
            : {}),
          ...(mutatingToolGrant ? { mutatingToolGrant } : {}),
          ...(mutationGate ? { mutationGate } : {}),
          // (NS45-PR2 mission-bound driver — DARK) forward the validated Mission handle UNCHANGED
          // (camelCase). Absent ⇒ key OMITTED ⇒ byte-identical unbound run.
          ...(missionContext ? { missionContext } : {}),
          ...(apiIdempotencyKey
            ? {
              apiIdempotencyKey,
              apiIdempotencyPayloadHash,
              apiIdempotencyReceivedAt: ctx.receivedAt,
            }
            : {}),
          ...principalInput,
        });
        const response: FridayStartAgentRunResponse = {
          ...toFridayAgentRunExecutionResponse(result),
          eventStreamAvailable: true,
        };
        return response;
      },
    },

    // ─── GET /v1/agent/runs ───
    {
      operationId: "agent.runs.list",
      method: "GET",
      path: "/v1/agent/runs",
      auth: { public: true },
      async handler(ctx) {
        const query = ctx.query as FridayListAgentRunsQuery;

        let limit: number | undefined;
        if (query.limit !== undefined) {
          const parsed = Number(query.limit);
          if (!Number.isInteger(parsed) || parsed < 1) {
            throw new FridayDomainError(
              "VALIDATION_ERROR",
              "limit must be a positive integer",
              { httpStatus: 400 },
            );
          }
          limit = Math.min(parsed, AGENT_MAX_LIST_LIMIT);
        }

        const VALID_RUN_STATUSES: Set<string> = new Set([
          "pending", "planning", "awaiting_clarification", "awaiting_plan_approval",
          "executing", "testing", "fixing", "completed", "failed", "failed_tests", "cancelled",
        ]);
        const rawStatus = query.status as string | undefined;
        const status = rawStatus && VALID_RUN_STATUSES.has(rawStatus)
          ? rawStatus as FridayAgentRunStatus
          : undefined;

        const fetchedRuns = deps.listRuns({
          status,
          limit: expandVisibleRunFetchLimit(limit),
          cursor: query.cursor,
        });
        const items = filterVisibleAgentRuns(fetchedRuns)
          .slice(0, limit ?? AGENT_MAX_LIST_LIMIT)
          .map((run) => buildVisibleRunWithUnifiedTaskState(run, deps.listRunEvents(run.id), ctx.receivedAt));
        const response: FridayListAgentRunsResponse = { items };
        return response;
      },
    },

    // ─── GET /v1/agent/runs/summary ───
    {
      operationId: "agent.runs.summary",
      method: "GET",
      path: "/v1/agent/runs/summary",
      auth: { public: true },
      async handler(ctx) {
        const query = ctx.query as { since?: string };
        const allRuns = filterVisibleAgentRuns(deps.listRuns({ limit: AGENT_MAX_LIST_LIMIT }));
        const since = query.since ? new Date(query.since).getTime() : 0;
        const recentRuns = since > 0
          ? allRuns.filter((r) => new Date(r.createdAt).getTime() >= since)
          : allRuns;

        let totalCostUsd = 0;
        let completedCount = 0;
        let failedCount = 0;
        let cancelledCount = 0;

        for (const run of recentRuns) {
          totalCostUsd += run.costUsd ?? 0;
          if (run.status === "completed") completedCount++;
          else if (run.status === "failed" || run.status === "failed_tests") failedCount++;
          else if (run.status === "cancelled") cancelledCount++;
        }

        return {
          since: query.since ?? null,
          totalRuns: recentRuns.length,
          completedCount,
          failedCount,
          cancelledCount,
          totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
          runs: recentRuns.slice(0, 20).map((r) => ({
            id: r.id,
            task: r.task,
            status: r.status,
            createdAt: r.createdAt,
            durationMs: r.durationMs,
          })),
        };
      },
    },

    // ─── GET /v1/agent/runs/:runId ───
    {
      operationId: "agent.runs.get",
      method: "GET",
      path: "/v1/agent/runs/:runId",
      auth: { public: true },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: string };
        const run = getVisibleRunOrThrow(runId);
        const response: FridayGetAgentRunResponse = {
          run: buildVisibleRunWithUnifiedTaskState(run, deps.listRunEvents(runId), ctx.receivedAt),
        };
        return response;
      },
    },

    // ─── POST /v1/agent/runs/:runId/cancel ───
    {
      operationId: "agent.runs.cancel",
      method: "POST",
      path: "/v1/agent/runs/:runId/cancel",
      auth: { public: true },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: string };
        const run = getVisibleRunOrThrow(runId);
        if (TERMINAL_STATUSES.has(run.status)) {
          throw new FridayDomainError(
            "AGENT_RUN_ALREADY_TERMINAL",
            `Agent run is already in terminal status: ${run.status}`,
            { httpStatus: 409 },
          );
        }
        deps.cancelRun(runId);
        const response: FridayCancelAgentRunResponse = { cancelled: true, runId };
        return response;
      },
    },

    // ─── POST /v1/agent/runs/:runId/resume ───
    // (S6 mutating-chat — DARK, default-off) Relay an operator's OPAQUE Ed25519-signed approval to
    // RESUME a paused mutating run. GATED on `FRIDAY_AGENT_RUN_CONTROL_VIA_RUST`:
    //   * FLAG OFF (the default) ⇒ SHORT-CIRCUIT to the byte-identical retired 503 BEFORE any run
    //     lookup — a DARK host's `/resume` is indistinguishable from the retired path (no run
    //     existence leak, byte-identical to today).
    //   * FLAG ON ⇒ require a bound owner principal, fetch the run named by the WIRE `runId`, and
    //     enforce the authenticated principal === THAT run's bound owner (its
    //     `metadata.apiRequest.principalId`) — reject fail-closed otherwise — then relay the OPAQUE
    //     signed blob VERBATIM to Rust. This TS gate checks the owner of the WIRE `runId`; Rust
    //     resume is signature-authed and does NOT re-check the owner, but (since the s6-687 fix) the
    //     Rust side BINDS `pending.run_id == run_id`, so the owner-gated run (wire `runId`) and the
    //     run the nonce actually executes are guaranteed to be the SAME run — a resume whose wire
    //     `runId` mismatches the nonce's pending row is refused in Rust (`run_mismatch`) and runs
    //     nothing.
    // INV-1 (opaque relay): the route NEVER parses/validates/inspects the signature/digest; it
    // base64-decodes the operator's `signedApproval` to bytes and hands them through unchanged.
    // Verification happens ONLY in Rust under the operator verify key (the hub holds no signing key).
    {
      operationId: "agent.runs.resume",
      method: "POST",
      path: "/v1/agent/runs/:runId/resume",
      auth: { public: true },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: string };

        // (a) FLAG GATE — checked FIRST, BEFORE any run lookup. Flag off / resume fn absent ⇒ the
        // byte-identical retired 503 (DARK: no run existence leak). `resumeRun` is provided ONLY by
        // the runtime; its absence is treated identically to flag-off (defense-in-depth).
        if (deps.agentRunControlViaRust !== true || !deps.resumeRun) {
          throw failClosedResumeRoute();
        }

        // (b) BOUND OWNER required. The synthetic public principal can never own/resume a run.
        const bound = assertBoundPrincipalForOperation(ctx.principal, "agent.run.resume", "api");

        // (c) Fetch the run named by the WIRE `runId`; enforce the authenticated principal === THAT
        // run's BOUND OWNER. An ownerless run (no stamped owner) is resumable by NOBODY
        // (fail-closed). Any mismatch ⇒ 403, never executing the mutation under the wrong principal.
        // Rust does NOT re-check the owner on resume (it is signature-authed), but it DOES bind
        // `pending.run_id == run_id` (the s6-687 wire-run binding) — so the run this gate owner-checks
        // (the wire `runId`) and the run the nonce executes are the SAME run; a wire/nonce run
        // mismatch is refused in Rust before any execution. This gate is thus the owner boundary for
        // the run that actually resumes.
        const run = getVisibleRunOrThrow(runId);
        const ownerPrincipalId = readRunOwnerPrincipalId(run);
        if (!ownerPrincipalId || ownerPrincipalId !== bound.principalId) {
          throw new FridayDomainError(
            "AGENT_RUN_RESUME_PRINCIPAL_MISMATCH",
            "The authenticated principal is not the bound owner of this run.",
            { httpStatus: 403 },
          );
        }

        // (d) OPAQUE relay. The operator's signed CanonicalApproval rides the body as a base64
        // string (`signedApproval`); decode it to bytes VERBATIM and relay — NEVER parse/inspect the
        // signature/digest (INV-1). A missing/non-string/undecodable value is a 400 (no relay, no
        // mutation). We do NOT validate JSON-ness or any inner field — Rust owns verification.
        const body = ctx.body as { signedApproval?: unknown } | null | undefined;
        const signedApprovalB64 = body?.signedApproval;
        if (typeof signedApprovalB64 !== "string" || signedApprovalB64.length === 0) {
          throw new FridayDomainError(
            "AGENT_RUN_RESUME_SIGNED_APPROVAL_REQUIRED",
            "signedApproval (base64-encoded operator-signed approval) is required in the request body.",
            { httpStatus: 400 },
          );
        }
        let opaqueSignedBlob: Uint8Array;
        try {
          opaqueSignedBlob = new Uint8Array(Buffer.from(signedApprovalB64, "base64"));
        } catch {
          throw new FridayDomainError(
            "AGENT_RUN_RESUME_SIGNED_APPROVAL_MALFORMED",
            "signedApproval could not be base64-decoded.",
            { httpStatus: 400 },
          );
        }
        if (opaqueSignedBlob.length === 0) {
          throw new FridayDomainError(
            "AGENT_RUN_RESUME_SIGNED_APPROVAL_MALFORMED",
            "signedApproval decoded to an empty blob.",
            { httpStatus: 400 },
          );
        }

        // (e) Relay VERBATIM to the runtime resume (which resolves the WS secret + dials the sealed
        // resume; fails closed on any error). Returns the refs-only outcome (NEVER a body).
        return await deps.resumeRun(runId, opaqueSignedBlob, ctx.principal);
      },
    },

    // ─── GET /v1/agent/runs/:runId/audit ───
    {
      operationId: "agent.runs.audit",
      method: "GET",
      path: "/v1/agent/runs/:runId/audit",
      auth: { public: true },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: string };
        const run = getVisibleRunOrThrow(runId);
        const AUDIT_EVENT_NAMES = new Set([
          "agent.run.started",
          "agent.run.planning",
          "agent.run.plan_ready",
          "agent.run.awaiting_clarification",
          "agent.run.awaiting_plan_approval",
          "agent.run.plan_approved",
          "agent.run.plan_rejected",
          "agent.run.executing",
          "agent.run.tool_start",
          "agent.run.tool_end",
          "agent.run.route_selected",
          "agent.run.route_fallback",
          "agent.run.route_mismatch",
          "agent.run.degraded",
          "agent.run.mode_changed",
          "agent.run.awaiting_tool_approval",
          "agent.run.capability_grant_issued",
          "agent.run.capability_grant_denied",
          "agent.run.capability_grant_used",
          "agent.run.capability_grant_revoked",
          "agent.run.context_replay_loaded",
          "agent.run.compaction_persisted",
          "agent.run.compaction_persist_skipped",
          "agent.run.compaction_persist_failed",
          "agent.run.completed",
          "agent.run.failed",
          "agent.run.cancelled",
        ]);
        const allEvents = deps.listRunEvents(runId);
        const auditEvents = allEvents.filter((e) =>
          AUDIT_EVENT_NAMES.has(e.eventName) || e.eventName.startsWith("autonomous."),
        );
        const decisionTrace = buildAgentRunDecisionTrace(run, auditEvents);
        const replayReceipt = buildReplayableEvidenceReceiptForRun(run, auditEvents, ctx.receivedAt, decisionTrace);
        const publicReplayReceipt = sanitizeReplayReceiptForPublicRead(replayReceipt);
        const unifiedTaskState = buildFridayAgentUnifiedTaskState({
          run,
          events: auditEvents,
          replayReceipt: publicReplayReceipt,
        });
        return {
          runId,
          events: auditEvents.map((e) => ({
            seq: e.seq,
            type: e.eventName,
            timestamp: e.emittedAt,
            payload: sanitizeAuditEventPayload(e),
          })),
          decisionTrace,
          replayReceipt: publicReplayReceipt,
          unifiedTaskState,
        };
      },
    },

    // ─── POST /v1/agent/runs/:runId/rollback ───
    {
      operationId: "agent.runs.rollback",
      method: "POST",
      path: "/v1/agent/runs/:runId/rollback",
      auth: { public: true },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: string };
        getVisibleRunOrThrow(runId);
        if (!deps.rollbackRun) {
          throw new FridayDomainError(
            "AGENT_ROLLBACK_NOT_AVAILABLE",
            "File rollback is not available",
            { httpStatus: 501 },
          );
        }
        const result = deps.rollbackRun(runId);
        if (!result) {
          throw new FridayDomainError(
            "AGENT_ROLLBACK_NO_CHECKPOINT",
            "No checkpoint found for this run",
            { httpStatus: 404 },
          );
        }
        return result;
      },
    },

    // ─── POST /v1/agent/runs/:runId/approve-plan ───
    {
      operationId: "agent.runs.approve.plan",
      method: "POST",
      path: "/v1/agent/runs/:runId/approve-plan",
      auth: { public: true },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: string };
        getVisibleRunOrThrow(runId);
        assertBoundPrincipalForOperation(ctx.principal, "agent.plan.approve", "api");
        return await deps.approvePlan(buildPlanControlInput(runId, ctx.principal));
      },
    },

    // ─── POST /v1/agent/runs/:runId/reject-plan ───
    {
      operationId: "agent.runs.reject.plan",
      method: "POST",
      path: "/v1/agent/runs/:runId/reject-plan",
      auth: { public: true },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: string };
        getVisibleRunOrThrow(runId);
        assertBoundPrincipalForOperation(ctx.principal, "agent.plan.reject", "api");
        return await deps.rejectPlan(buildPlanControlInput(runId, ctx.principal));
      },
    },

    // ─── POST /v1/agent/runs/:runId/approve-tool ───
    {
      operationId: "agent.runs.approve.tool",
      method: "POST",
      path: "/v1/agent/runs/:runId/approve-tool",
      auth: { public: true },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: string };
        const body = ctx.body as { toolCallId?: string } | undefined;
        const toolCallId = body?.toolCallId;
        if (!toolCallId) {
          throw new FridayDomainError(
            "AGENT_TOOL_CALL_ID_REQUIRED",
            "toolCallId is required in the request body",
            { httpStatus: 400 },
          );
        }
        getToolApprovalTargetRunOrThrow(runId);
        return deps.resolveToolApproval(runId, toolCallId, true, requireToolApprovalPrincipal(ctx.principal, "agent.tool.approve"));
      },
    },

    // ─── POST /v1/agent/runs/:runId/reject-tool ───
    {
      operationId: "agent.runs.reject.tool",
      method: "POST",
      path: "/v1/agent/runs/:runId/reject-tool",
      auth: { public: true },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: string };
        const body = ctx.body as { toolCallId?: string; reason?: string } | undefined;
        const toolCallId = body?.toolCallId;
        if (!toolCallId) {
          throw new FridayDomainError(
            "AGENT_TOOL_CALL_ID_REQUIRED",
            "toolCallId is required in the request body",
            { httpStatus: 400 },
          );
        }
        getToolApprovalTargetRunOrThrow(runId);
        return deps.resolveToolApproval(runId, toolCallId, false, {
          ...requireToolApprovalPrincipal(ctx.principal, "agent.tool.reject"),
          reason: body?.reason,
        });
      },
    },

    // ─── GET /v1/agent/runs/:runId/events (SSE) ───
    {
      operationId: "agent.runs.events",
      method: "GET",
      path: "/v1/agent/runs/:runId/events",
      auth: { public: true },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: string };
        const query = ctx.query as Record<string, string | undefined>;
        const run = getVisibleRunOrThrow(runId);
        let afterSeq: number | undefined;
        if (query.afterSeq !== undefined) {
          const parsed = Number(query.afterSeq);
          if (!Number.isInteger(parsed) || parsed < 0) {
            throw new FridayDomainError(
              "VALIDATION_ERROR",
              "afterSeq must be a non-negative integer",
              { httpStatus: 400 },
            );
          }
          afterSeq = parsed;
        }

        // Access raw response for SSE streaming.
        // The HTTP context carries a `_raw` reference set by the HTTP server adapter.
        const rawRes = (ctx as unknown as Record<string, unknown>)._raw as FridaySseResponse | undefined;
        if (!rawRes) {
          // Fallback: if no raw response, return the current run state as JSON.
          return {
            run: buildVisibleRunWithUnifiedTaskState(run, deps.listRunEvents(runId), ctx.receivedAt),
            streaming: false,
          };
        }

        // Set SSE headers
        rawRes.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        let closed = false;
        let terminalSeen = false;
        let lastSeq = afterSeq ?? 0;
        let flushChain = Promise.resolve();
        // Additional terminal/testing event types can be appended here once they
        // are added to FridayAgentEventMap.
        const eventNames: FridayAgentEventName[] = [
          "agent.run.started",
          "agent.run.planning",
          "agent.run.awaiting_clarification",
          "agent.run.plan_ready",
          "agent.run.awaiting_plan_approval",
          "agent.run.plan_approved",
          "agent.run.plan_rejected",
          "agent.run.awaiting_tool_approval",
          "agent.run.degraded",
          "agent.run.mode_changed",
          "agent.run.route_selected",
          "agent.run.route_fallback",
          "agent.run.route_mismatch",
          "agent.run.executing",
          "agent.run.tool_start",
          "agent.run.tool_end",
          "agent.run.completed",
          "agent.run.failed",
          "agent.run.text_delta",
          "agent.run.cancelled",
          "agent.subagent.spawned",
          "agent.subagent.completed",
          "autonomous.goal.created",
          "autonomous.goal.started",
          "autonomous.step.started",
          "autonomous.step.completed",
          "autonomous.step.failed",
          "autonomous.goal.completed",
          "autonomous.goal.failed",
        ];

        type AnyListener = (payload: FridayAgentEventMap[FridayAgentEventName]) => void;
        const listeners: Array<{ event: FridayAgentEventName; listener: AnyListener }> = [];

        function cleanup(): void {
          if (closed) return;
          closed = true;
          clearInterval(keepaliveTimer);
          for (const { event, listener } of listeners) {
            deps.eventEmitter.off(event, listener);
          }
        }

        const flushPersistedEvents = async (replayed: boolean): Promise<void> => {
          const events = deps.listRunEvents(runId, lastSeq);
          for (const event of events) {
            if (closed) {
              return;
            }
            lastSeq = event.seq;
            rawRes.write(`data: ${serializeReplayEvent(event, replayed)}\n\n`);
            if (TERMINAL_EVENT_NAMES.has(event.eventName)) {
              terminalSeen = true;
            }
          }
        };

        const queueFlush = (replayed: boolean): void => {
          flushChain = flushChain
            .then(() => flushPersistedEvents(replayed))
            .then(() => {
              if (!closed && terminalSeen) {
                rawRes.end();
                cleanup();
              }
            })
            .catch((err: unknown) => console.warn("[friday][agent-routes] flush:", err instanceof Error ? err.message : String(err)));
        };

        // Keepalive
        const keepaliveTimer = setInterval(() => {
          if (!closed) {
            rawRes.write(":keepalive\n\n");
          }
        }, AGENT_SSE_KEEPALIVE_MS);

        // Listen for client disconnect
        rawRes.on("close", cleanup);

        await flushPersistedEvents(true);
        if (terminalSeen || TERMINAL_STATUSES.has(run.status)) {
          if (!terminalSeen) {
            rawRes.write(`data: ${JSON.stringify({
              type: "agent.run.status",
              runId,
              status: run.status,
              seq: lastSeq,
              emittedAt: run.completedAt ?? run.createdAt,
              replayed: true,
            })}\n\n`);
          }
          rawRes.end();
          cleanup();
          return undefined as unknown as Record<string, unknown>;
        }

        // Subscribe to events
        for (const eventName of eventNames) {
          const listener = ((payload: FridayAgentEventMap[typeof eventName]) => {
            // Filter by runId — standard events use runId, subagent events use parentRunId
            const p = payload as unknown as Record<string, unknown>;
            const payloadRunId = p.runId ?? p.parentRunId;
            if (payloadRunId !== runId) return;
            queueFlush(false);
          }) as AnyListener;

          listeners.push({ event: eventName, listener });
          deps.eventEmitter.on(eventName, listener);
        }

        // Return undefined to signal the HTTP server that we've taken over the response
        return undefined as unknown as Record<string, unknown>;
      },
    },

    // ─── POST /v1/agent/automations ───
    {
      operationId: "agent.automations.create",
      method: "POST",
      path: "/v1/agent/automations",
      auth: { public: true },
      async handler(ctx) {
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body.name !== "string" || body.name.trim() === "") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "name is required and must be a non-empty string",
            { httpStatus: 400 },
          );
        }
        if (typeof body.taskTemplate !== "string" || body.taskTemplate.trim() === "") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "taskTemplate is required and must be a non-empty string",
            { httpStatus: 400 },
          );
        }

        const schedule = parseAutomationSchedule(body.schedule, {
          allowNull: false,
          path: "schedule",
        });

        const automation = deps.automationService.save({
          name: body.name,
          description: typeof body.description === "string" ? body.description : undefined,
          sourceRunId: typeof body.sourceRunId === "string" ? body.sourceRunId : undefined,
          taskTemplate: body.taskTemplate,
          variables: isStringRecord(body.variables) ? body.variables : undefined,
          skillIds: isStringArray(body.skillIds) ? body.skillIds : undefined,
          workflowIds: isStringArray(body.workflowIds) ? body.workflowIds : undefined,
          triggerId: typeof body.triggerId === "string" ? body.triggerId : undefined,
          schedule: schedule ?? undefined,
          sessionTarget: parseAutomationSessionTarget(body.sessionTarget, {
            allowNull: false,
            path: "sessionTarget",
          }) ?? undefined,
          enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        });

        return { automation };
      },
    },

    // ─── GET /v1/agent/automations ───
    {
      operationId: "agent.automations.list",
      method: "GET",
      path: "/v1/agent/automations",
      auth: { public: true },
      async handler(ctx) {
        const query = ctx.query as Record<string, string | undefined>;

        let limit: number | undefined;
        if (query.limit !== undefined) {
          const parsed = Number(query.limit);
          if (!Number.isInteger(parsed) || parsed < 1) {
            throw new FridayDomainError(
              "VALIDATION_ERROR",
              "limit must be a positive integer",
              { httpStatus: 400 },
            );
          }
          limit = Math.min(parsed, AGENT_MAX_LIST_LIMIT);
        }

        let enabled: boolean | undefined;
        if (query.enabled !== undefined) {
          if (query.enabled !== "true" && query.enabled !== "false") {
            throw new FridayDomainError(
              "VALIDATION_ERROR",
              "enabled must be 'true' or 'false'",
              { httpStatus: 400 },
            );
          }
          enabled = query.enabled === "true";
        }

        const items = deps.automationService.list({
          enabled,
          limit,
          cursor: query.cursor,
        });

        return { items };
      },
    },

    // ─── GET /v1/agent/automations/:automationId ───
    {
      operationId: "agent.automations.get",
      method: "GET",
      path: "/v1/agent/automations/:automationId",
      auth: { public: true },
      async handler(ctx) {
        const { automationId } = ctx.params as { automationId: string };
        const automation = deps.automationService.get(automationId);
        if (!automation) {
          throw new FridayDomainError(
            "AGENT_AUTOMATION_NOT_FOUND",
            "Automation not found",
            { httpStatus: 404 },
          );
        }
        return { automation };
      },
    },

    // ─── PATCH /v1/agent/automations/:automationId ───
    {
      operationId: "agent.automations.update",
      method: "PATCH",
      path: "/v1/agent/automations/:automationId",
      auth: { public: true },
      async handler(ctx) {
        const { automationId } = ctx.params as { automationId: string };
        const body = ctx.body as Record<string, unknown> | null;
        if (!body) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "Request body is required",
            { httpStatus: 400 },
          );
        }

        const schedule = parseAutomationSchedule(body.schedule, {
          allowNull: true,
          path: "schedule",
        });

        const automation = deps.automationService.update(automationId, {
          name: typeof body.name === "string" ? body.name : undefined,
          description: typeof body.description === "string" ? body.description : undefined,
          taskTemplate: typeof body.taskTemplate === "string" ? body.taskTemplate : undefined,
          variables: isStringRecord(body.variables) ? body.variables : undefined,
          skillIds: isStringArray(body.skillIds) ? body.skillIds : undefined,
          workflowIds: isStringArray(body.workflowIds) ? body.workflowIds : undefined,
          triggerId: typeof body.triggerId === "string" ? body.triggerId : undefined,
          schedule,
          sessionTarget: parseAutomationSessionTarget(body.sessionTarget, {
            allowNull: true,
            path: "sessionTarget",
          }),
          enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        });

        return { automation };
      },
    },

    // ─── DELETE /v1/agent/automations/:automationId ───
    {
      operationId: "agent.automations.delete",
      method: "DELETE",
      path: "/v1/agent/automations/:automationId",
      auth: { public: true },
      async handler(ctx) {
        const { automationId } = ctx.params as { automationId: string };
        deps.automationService.remove(automationId);
        return { deleted: true, automationId };
      },
    },

    // ─── POST /v1/agent/automations/:automationId/run ───
    {
      operationId: "agent.automations.run",
      method: "POST",
      path: "/v1/agent/automations/:automationId/run",
      auth: { public: true },
      async handler(ctx) {
        const { automationId } = ctx.params as { automationId: string };
        const body = (ctx.body as Record<string, unknown> | null) ?? {};

        const taskOverride = typeof body.taskOverride === "string" ? body.taskOverride : undefined;
        const providerId = typeof body.providerId === "string" ? body.providerId : undefined;
        const model = typeof body.model === "string" ? body.model : undefined;
        let timeoutMs: number | undefined;
        if (body.timeoutMs !== undefined) {
          const parsed = Number(body.timeoutMs);
          if (!Number.isFinite(parsed) || parsed < 1 || parsed > 600_000) {
            throw new FridayDomainError(
              "VALIDATION_ERROR",
              "timeoutMs must be a positive number up to 600000",
              { httpStatus: 400 },
            );
          }
          timeoutMs = parsed;
        }

        const result = await deps.automationService.run(automationId, {
          taskOverride,
          providerId,
          model,
          timeoutMs,
          sessionTarget: parseAutomationSessionTarget(body.sessionTarget, {
            allowNull: false,
            path: "sessionTarget",
          }) ?? undefined,
        });

        return { result };
      },
    },
  ];
}

// ─── Helpers ───

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === "string");
}

function parseOptionalIanaTimezone(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${path} must be a non-empty string when provided`,
      { httpStatus: 400 },
    );
  }
  const timezone = value.trim();
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch (err) {
    console.warn("[friday][agent-routes] operation failed:", err instanceof Error ? err.message : String(err));
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${path} is not a valid IANA timezone`,
      { httpStatus: 400 },
    );
  }
  return timezone;
}

function parseAutomationSchedule(
  value: unknown,
  options: { allowNull: boolean; path: string },
): FridayAgentAutomationSchedule | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) {
    if (options.allowNull) return null;
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${options.path} cannot be null`,
      { httpStatus: 400 },
    );
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${options.path} must be an object`,
      { httpStatus: 400 },
    );
  }

  const raw = value as Record<string, unknown>;
  const typeRaw = raw.type;
  if (typeRaw !== undefined && typeRaw !== "cron") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${options.path}.type must be 'cron'`,
      { httpStatus: 400 },
    );
  }

  const cron = typeof raw.cron === "string" ? raw.cron.trim() : "";
  if (!cron) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${options.path}.cron is required and must be a non-empty string`,
      { httpStatus: 400 },
    );
  }
  if (!isValidCronExpression(cron)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${options.path}.cron is not a valid cron expression`,
      { httpStatus: 400 },
    );
  }

  let timezone: string | undefined;
  if (raw.timezone !== undefined) {
    if (typeof raw.timezone !== "string" || raw.timezone.trim() === "") {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `${options.path}.timezone must be a non-empty string when provided`,
        { httpStatus: 400 },
      );
    }
    timezone = raw.timezone.trim();
    try {
      Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    } catch (err) {
    console.warn("[friday][agent-routes] operation failed:", err instanceof Error ? err.message : String(err));
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `${options.path}.timezone is not a valid IANA timezone`,
        { httpStatus: 400 },
      );
    }
  }

  return {
    type: "cron",
    cron,
    timezone,
  };
}

function parseAutomationSessionTarget(
  value: unknown,
  options: { allowNull: boolean; path: string },
): FridayAgentAutomationSessionTarget | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) {
    if (options.allowNull) return null;
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${options.path} cannot be null`,
      { httpStatus: 400 },
    );
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${options.path} must be an object`,
      { httpStatus: 400 },
    );
  }

  const raw = value as Record<string, unknown>;
  const type = raw.type;
  if (type !== "isolated" && type !== "named" && type !== "current") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${options.path}.type must be 'isolated', 'named', or 'current'`,
      { httpStatus: 400 },
    );
  }

  const sessionKey = raw.sessionKey;
  if (type === "isolated") {
    if (sessionKey !== undefined && sessionKey !== null) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `${options.path}.sessionKey is not allowed for isolated targets`,
        { httpStatus: 400 },
      );
    }
    return { type: "isolated" };
  }

  if (sessionKey === undefined || sessionKey === null) {
    if (type === "named") {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `${options.path}.sessionKey is required for named targets`,
        { httpStatus: 400 },
      );
    }
    return { type };
  }

  if (typeof sessionKey !== "string" || sessionKey.trim() === "") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${options.path}.sessionKey must be a non-empty string when provided`,
      { httpStatus: 400 },
    );
  }

  return {
    type,
    sessionKey: sessionKey.trim(),
  };
}
