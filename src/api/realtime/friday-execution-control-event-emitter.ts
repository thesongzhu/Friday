/**
 * Execution-control event emitter — a thin bridge that domain services
 * call to publish lifecycle events for rules, execution, acceptance,
 * retry, and playbook modules.
 *
 * Responsibilities:
 *   1. Accept domain events with a shared correlationId.
 *   2. Redact PII from payloads before publishing.
 *   3. Route events to the FridayRealtimeEventBus for subscribers.
 *   4. Persist a forensic audit record via the audit log writer.
 *
 * @module api/realtime
 */

import type {
  FridayRealtimeEventEnvelope,
  FridayRealtimeEventName,
  FridayRealtimeEventPayloadMap,
} from "../model/friday-api-realtime.types.js";
import type { FridayRealtimeEventBus } from "./friday-realtime-event-bus.types.js";
import type { FridayAuditRecord } from "../../security/friday-audit-log.js";
import { redactEventPayload } from "./friday-event-payload-redactor.js";

// ─── Execution-control event name subset ───

export type FridayExecutionControlEventName =
  | "rules.bundle.created"
  | "rules.bundle.updated"
  | "rules.rule.created"
  | "rules.rule.updated"
  | "rules.evaluation.completed"
  | "execution.node.started"
  | "execution.node.completed"
  | "execution.node.failed"
  | "acceptance.gate.evaluated"
  | "acceptance.gate.passed"
  | "acceptance.gate.failed"
  | "retry.attempt.scheduled"
  | "retry.attempt.started"
  | "retry.attempt.exhausted"
  | "retry.dlq.enqueued"
  | "playbook.selected"
  | "playbook.candidate.created"
  | "playbook.candidate.promoted"
  | "playbook.score.recalculated"
  | "playbook.rollback.completed";

// ─── Stream ID helpers ───

function streamIdForEvent(event: FridayExecutionControlEventName, payload: Record<string, unknown>): string {
  const domain = event.split(".")[0];
  const subEntity = event.split(".")[1]; // e.g. "bundle", "rule", "dlq", "candidate"
  switch (domain) {
    case "rules": {
      // Prioritize the most specific entity: ruleId > evaluationId > bundleId
      const id = (payload.ruleId ?? payload.evaluationId ?? payload.bundleId ?? "global") as string;
      return `rules:${id}`;
    }
    case "execution": {
      const id = (payload.executionId ?? payload.runId ?? "global") as string;
      return `execution:${id}`;
    }
    case "acceptance": {
      const id = (payload.resultId ?? payload.runId ?? "global") as string;
      return `acceptance:${id}`;
    }
    case "retry": {
      // DLQ entries use entryId as primary key; retry contexts use contextId
      const id = subEntity === "dlq"
        ? (payload.entryId ?? payload.contextId ?? "global") as string
        : (payload.contextId ?? payload.entryId ?? "global") as string;
      return `retry:${id}`;
    }
    case "playbook": {
      // Candidate events use candidateId; playbook-level events use playbookId
      const id = subEntity === "candidate"
        ? (payload.candidateId ?? payload.playbookId ?? "global") as string
        : (payload.playbookId ?? payload.candidateId ?? "global") as string;
      return `playbook:${id}`;
    }
    default:
      return `${domain}:global`;
  }
}

// ─── Audit record builder ───

function buildAuditRecord(
  event: FridayExecutionControlEventName,
  payload: Record<string, unknown>,
  correlationId: string | undefined,
  nowIso: string,
): FridayAuditRecord {
  const [resourceType, ...actionParts] = event.split(".");
  const action = actionParts.join(".");
  return {
    id: `audit-${nowIso}-${event}`,
    ts: nowIso,
    actorType: "service",
    action: event,
    resourceType,
    resourceId: (payload.ruleId ?? payload.evaluationId ?? payload.bundleId ??
      payload.executionId ?? payload.resultId ?? payload.entryId ??
      payload.contextId ?? payload.candidateId ?? payload.playbookId) as string | undefined,
    requestId: correlationId,
    result: action.includes("failed") || action.includes("exhausted") ? "failure" : "success",
    caller: "execution-control-event-emitter",
    details: redactEventPayload(payload) as Record<string, unknown>,
  };
}

// ─── Deps ───

export interface CreateExecutionControlEventEmitterDeps {
  eventBus: FridayRealtimeEventBus;
  nowIso: () => string;
  /** Optional audit sink — receives forensic records for persistence. */
  auditSink?: (record: FridayAuditRecord) => void;
}

// ─── Public interface ───

export interface FridayExecutionControlEventEmitter {
  /**
   * Emit a domain event from an execution-control module.
   * The payload is redacted before publishing to the event bus.
   */
  emit<TEvent extends FridayExecutionControlEventName>(
    event: TEvent,
    payload: FridayRealtimeEventPayloadMap[TEvent],
    correlationId?: string,
  ): FridayRealtimeEventEnvelope<TEvent>;

  /**
   * List all events emitted during this emitter's lifetime (useful for testing).
   */
  readonly emittedEvents: ReadonlyArray<FridayRealtimeEventEnvelope>;
}

// ─── Factory ───

export function createExecutionControlEventEmitter(
  deps: CreateExecutionControlEventEmitterDeps,
): FridayExecutionControlEventEmitter {
  const emitted: FridayRealtimeEventEnvelope[] = [];

  return {
    emit<TEvent extends FridayExecutionControlEventName>(
      event: TEvent,
      payload: FridayRealtimeEventPayloadMap[TEvent],
      correlationId?: string,
    ): FridayRealtimeEventEnvelope<TEvent> {
      // 1. Redact sensitive fields
      const redacted = redactEventPayload(payload);

      // 2. Derive stream id from event + payload
      const streamId = streamIdForEvent(event, redacted as unknown as Record<string, unknown>);

      // 3. Publish to the realtime event bus (this persists + notifies listeners)
      const envelope = deps.eventBus.publish(
        streamId,
        event as FridayRealtimeEventName as TEvent,
        redacted,
        correlationId,
      );

      emitted.push(envelope as FridayRealtimeEventEnvelope);

      // 4. Write audit record (non-blocking, best-effort)
      if (deps.auditSink) {
        try {
          const record = buildAuditRecord(
            event,
            redacted as unknown as Record<string, unknown>,
            correlationId,
            envelope.emittedAt,
          );
          deps.auditSink(record);
        } catch {
          // Audit sink failure is non-fatal
        }
      }

      return envelope;
    },

    get emittedEvents() {
      return emitted;
    },
  };
}
