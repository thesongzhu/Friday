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
import { redactSecretShapesInString } from "../../security/friday-secret-shape-redactor.js";

const DEFAULT_EMITTED_EVENTS_LIMIT = 1_000;
const DEFAULT_AUDIT_SINK_FAILURES_LIMIT = 100;

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
    result: isFailureAuditEvent(event, action) ? "failure" : "success",
    caller: "execution-control-event-emitter",
    details: redactEventPayload(payload) as Record<string, unknown>,
  };
}

function isFailureAuditEvent(event: FridayExecutionControlEventName, action: string): boolean {
  return action.includes("failed") || action.includes("exhausted") || event === "retry.dlq.enqueued";
}

function pushBounded<T>(items: T[], item: T, limit: number): void {
  items.push(item);
  while (items.length > limit) {
    items.shift();
  }
}

function clampPositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function auditSinkErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Secret-shape scrubbing converges onto the CANONICAL detector — the single source of truth for
  // provider-credential shapes (`hf_` / `glpat-` / `ghp_` / `gh?_` / `github_pat_` / `sk-` / `gsk_` /
  // AWS `AKIA…` / JWT / PEM / `AIza…` / `ya29.` / `GOCSPX-` / `SG.` / `sq0…` / `dop_v1_` / `npm_` /
  // Slack / `Bearer …` / generic `key=value` assignments — see friday-secret-shape-redactor.ts). The
  // previous LOCAL prefix list was divergent: it covered `gsk_` but MISSED `hf_` / `glpat-` / `ghp_` /
  // AWS / JWT / PEM, so a raw token in the sink's exception message leaked to the process logs.
  //
  // Two DISPLAY-only extras are kept, layered ON TOP, precisely because the canonical persistence /
  // egress detector DELIBERATELY EXCLUDES them (see that module's header): (1) the generic /
  // unverified-provenance error-message prefixes `key-` / `pk-` / `aip-` / `whsk-` / `sess-` / `ssm-`
  // that canonical drops as over-redactors, and (2) any long base64 blob. This is a logs-only
  // exception-message display sink that TOLERATES over-redaction where the canonical detector must
  // not — so the scrub is never LESS aggressive than before, only strictly more (no coverage lost).
  return redactSecretShapesInString(raw, "[REDACTED]")
    .replace(/\b(key-|pk-|aip-|whsk-|sess-|ssm-)[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\b[A-Za-z0-9/+]{40,}={0,2}\b/g, "[REDACTED]");
}

// ─── Deps ───

export interface FridayExecutionControlAuditSinkFailure {
  event: FridayExecutionControlEventName;
  streamId: string;
  emittedAt: string;
  message: string;
}

export interface CreateExecutionControlEventEmitterDeps {
  eventBus: FridayRealtimeEventBus;
  nowIso: () => string;
  /** Optional audit sink — receives forensic records for persistence. */
  auditSink?: (record: FridayAuditRecord) => void;
  /** Maximum in-memory envelopes retained for inspection. */
  maxEmittedEvents?: number;
  /** Maximum audit-sink failures retained for inspection. */
  maxAuditSinkFailures?: number;
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

  /**
   * List recent audit-sink failures without breaking event emission.
   */
  readonly auditSinkFailures: ReadonlyArray<FridayExecutionControlAuditSinkFailure>;
}

// ─── Factory ───

export function createExecutionControlEventEmitter(
  deps: CreateExecutionControlEventEmitterDeps,
): FridayExecutionControlEventEmitter {
  const emittedLimit = clampPositiveInteger(deps.maxEmittedEvents, DEFAULT_EMITTED_EVENTS_LIMIT);
  const auditFailureLimit = clampPositiveInteger(deps.maxAuditSinkFailures, DEFAULT_AUDIT_SINK_FAILURES_LIMIT);
  const emitted: FridayRealtimeEventEnvelope[] = [];
  const auditFailures: FridayExecutionControlAuditSinkFailure[] = [];

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

      pushBounded(emitted, envelope as FridayRealtimeEventEnvelope, emittedLimit);

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
        } catch (err) {
          const message = auditSinkErrorMessage(err);
          pushBounded(auditFailures, {
            event,
            streamId,
            emittedAt: envelope.emittedAt,
            message,
          }, auditFailureLimit);
          console.warn("[friday][execution-control-event-emitter] operation failed:", message);
          // Audit sink failure is non-fatal
        }
      }

      return envelope;
    },

    get emittedEvents() {
      return emitted;
    },

    get auditSinkFailures() {
      return auditFailures;
    },
  };
}
