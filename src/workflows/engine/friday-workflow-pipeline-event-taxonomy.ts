/**
 * A-008 Pipeline Event Taxonomy — canonical event definitions for the
 * five deterministic pipeline modules (rules, node-runner, acceptance,
 * retry, playbook).
 *
 * Defines event names, type-safe payloads with correlation identifiers,
 * a taxonomy-aware emitter bridge with backpressure safeguards, and
 * redaction annotations for sensitive fields.
 *
 * @module workflows/engine
 */

// ─── Event Names ───

export type PipelineEventName =
  // Rules
  | "pipeline.rules.evaluated"
  | "pipeline.rules.denied"
  // Node Runner
  | "pipeline.node.step.started"
  | "pipeline.node.step.completed"
  | "pipeline.node.step.failed"
  | "pipeline.node.execution.completed"
  // Acceptance
  | "pipeline.acceptance.started"
  | "pipeline.acceptance.passed"
  | "pipeline.acceptance.warned"
  | "pipeline.acceptance.failed"
  // Retry
  | "pipeline.retry.attempted"
  | "pipeline.retry.exhausted"
  | "pipeline.retry.circuit.opened"
  | "pipeline.retry.budget.exhausted"
  // Playbook
  | "pipeline.playbook.selected"
  | "pipeline.playbook.no_match"
  | "pipeline.playbook.promoted"
  | "pipeline.playbook.rolled_back"
  | "pipeline.playbook.feedback.recorded";

export type PipelineModuleName = "rules" | "node-runner" | "acceptance" | "retry" | "playbook";

// ─── Correlation Context ───

export interface PipelineEventCorrelation {
  /** Workflow run ID. Required for all pipeline events. */
  runId: string;
  /** Workflow definition ID. */
  workflowId?: string;
  /** Node ID within the graph. */
  nodeId?: string;
  /** Attempt number (for retry-related events). */
  attempt?: number;
  /** Distributed trace ID (for OpenTelemetry linkage). */
  traceId?: string;
  /** Span ID (for OpenTelemetry linkage). */
  spanId?: string;
}

// ─── Payload Map ───

export interface PipelineEventPayloadMap {
  // Rules
  "pipeline.rules.evaluated": {
    bundleId: string;
    ruleCount: number;
    outcome: "allow" | "deny" | "warn";
    durationMs: number;
  };
  "pipeline.rules.denied": {
    bundleId: string;
    reason: string;
    ruleId?: string;
  };

  // Node Runner
  "pipeline.node.step.started": {
    stepName: string;
    stepIndex: number;
  };
  "pipeline.node.step.completed": {
    stepName: string;
    stepIndex: number;
    durationMs: number;
  };
  "pipeline.node.step.failed": {
    stepName: string;
    stepIndex: number;
    errorCode: string;
    errorMessage?: string;
  };
  "pipeline.node.execution.completed": {
    status: string;
    durationMs: number;
    stepCount: number;
    artifactCount: number;
  };

  // Acceptance
  "pipeline.acceptance.started": {
    artifactType: string;
    checkCount: number;
  };
  "pipeline.acceptance.passed": {
    checksRun: number;
    checksPassed: number;
  };
  "pipeline.acceptance.warned": {
    checksRun: number;
    checksPassed: number;
    checksWarned: number;
  };
  "pipeline.acceptance.failed": {
    checksRun: number;
    checksFailed: number;
    blocksCompletion: boolean;
  };

  // Retry
  "pipeline.retry.attempted": {
    category: string;
    delayMs: number;
    budgetRemaining: number;
  };
  "pipeline.retry.exhausted": {
    category: string;
    totalAttempts: number;
    escalatedToDlq: boolean;
  };
  "pipeline.retry.circuit.opened": {
    consecutiveFailures: number;
    threshold: number;
  };
  "pipeline.retry.budget.exhausted": {
    budgetMax: number;
    budgetUsed: number;
  };

  // Playbook
  "pipeline.playbook.selected": {
    playbookId: string;
    versionNumber: number;
    matchScore: number;
  };
  "pipeline.playbook.no_match": {
    workflowType: string;
    reason: string;
  };
  "pipeline.playbook.promoted": {
    candidateId: string;
    playbookId: string;
    compositeScore: number;
  };
  "pipeline.playbook.rolled_back": {
    playbookId: string;
    fromVersion: number;
    toVersion: number;
    reason: string;
  };
  "pipeline.playbook.feedback.recorded": {
    candidateId: string | null;
    success: boolean;
    durationMs: number;
  };
}

// ─── Event Envelope ───

export interface PipelineEvent<TName extends PipelineEventName = PipelineEventName> {
  eventId: string;
  event: TName;
  module: PipelineModuleName;
  payload: PipelineEventPayloadMap[TName];
  correlation: PipelineEventCorrelation;
  emittedAt: string;
  redacted: boolean;
}

// ─── Redaction ───

/** Fields that should be redacted in external-facing event streams. */
const REDACTED_PAYLOAD_FIELDS = new Set(["errorMessage", "reason"]);

export function redactPipelineEvent(event: PipelineEvent): PipelineEvent {
  const payload = { ...event.payload } as Record<string, unknown>;
  for (const key of REDACTED_PAYLOAD_FIELDS) {
    if (key in payload && typeof payload[key] === "string") {
      payload[key] = "[REDACTED]";
    }
  }
  return { ...event, payload: payload as PipelineEvent["payload"], redacted: true };
}

// ─── Module Mapping ───

const EVENT_MODULE_MAP: Record<PipelineEventName, PipelineModuleName> = {
  "pipeline.rules.evaluated": "rules",
  "pipeline.rules.denied": "rules",
  "pipeline.node.step.started": "node-runner",
  "pipeline.node.step.completed": "node-runner",
  "pipeline.node.step.failed": "node-runner",
  "pipeline.node.execution.completed": "node-runner",
  "pipeline.acceptance.started": "acceptance",
  "pipeline.acceptance.passed": "acceptance",
  "pipeline.acceptance.warned": "acceptance",
  "pipeline.acceptance.failed": "acceptance",
  "pipeline.retry.attempted": "retry",
  "pipeline.retry.exhausted": "retry",
  "pipeline.retry.circuit.opened": "retry",
  "pipeline.retry.budget.exhausted": "retry",
  "pipeline.playbook.selected": "playbook",
  "pipeline.playbook.no_match": "playbook",
  "pipeline.playbook.promoted": "playbook",
  "pipeline.playbook.rolled_back": "playbook",
  "pipeline.playbook.feedback.recorded": "playbook",
};

// ─── Emitter Dependencies ───

export interface PipelineEventEmitterDeps {
  /** Publish an event envelope to the downstream bus. */
  publish: (event: PipelineEvent) => void;
  /** Generate unique event IDs. */
  generateId: () => string;
  /** Clock function. */
  nowIso?: () => string;
  /** Max events per second per run (backpressure). 0 = unlimited. Default: 100. */
  maxEventsPerSecondPerRun?: number;
  /** Max buffered events before dropping. Default: 1000. */
  maxBufferSize?: number;
  /** Callback when events are dropped due to backpressure. */
  onDrop?: (dropped: number, runId: string) => void;
}

// ─── Emitter Interface ───

export interface PipelineEventEmitter {
  emit<TName extends PipelineEventName>(
    event: TName,
    payload: PipelineEventPayloadMap[TName],
    correlation: PipelineEventCorrelation,
  ): PipelineEvent<TName> | null;

  getEmittedCount(runId: string): number;
  getDroppedCount(runId: string): number;
  getEvents(runId: string): PipelineEvent[];
  reset(): void;
}

// ─── Factory ───

export function createPipelineEventEmitter(
  deps: PipelineEventEmitterDeps,
): PipelineEventEmitter {
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const maxRate = deps.maxEventsPerSecondPerRun ?? 100;
  const maxBuffer = deps.maxBufferSize ?? 1000;

  // State
  const events: PipelineEvent[] = [];
  const emittedPerRun = new Map<string, number>();
  const droppedPerRun = new Map<string, number>();
  const rateWindow = new Map<string, number[]>(); // runId -> timestamps in current window

  function isRateLimited(runId: string): boolean {
    if (maxRate <= 0) return false;
    const now = Date.now();
    const window = rateWindow.get(runId) ?? [];
    // Remove entries older than 1 second
    const cutoff = now - 1000;
    const recent = window.filter((ts) => ts > cutoff);
    rateWindow.set(runId, recent);
    return recent.length >= maxRate;
  }

  function recordEmission(runId: string): void {
    const now = Date.now();
    const window = rateWindow.get(runId) ?? [];
    window.push(now);
    rateWindow.set(runId, window);
  }

  return {
    emit<TName extends PipelineEventName>(
      eventName: TName,
      payload: PipelineEventPayloadMap[TName],
      correlation: PipelineEventCorrelation,
    ): PipelineEvent<TName> | null {
      const runId = correlation.runId;

      // Backpressure: rate limit
      if (isRateLimited(runId)) {
        droppedPerRun.set(runId, (droppedPerRun.get(runId) ?? 0) + 1);
        deps.onDrop?.(1, runId);
        return null;
      }

      // Backpressure: buffer overflow
      if (events.length >= maxBuffer) {
        droppedPerRun.set(runId, (droppedPerRun.get(runId) ?? 0) + 1);
        deps.onDrop?.(1, runId);
        return null;
      }

      const event: PipelineEvent<TName> = {
        eventId: deps.generateId(),
        event: eventName,
        module: EVENT_MODULE_MAP[eventName],
        payload,
        correlation,
        emittedAt: nowIso(),
        redacted: false,
      };

      events.push(event);
      emittedPerRun.set(runId, (emittedPerRun.get(runId) ?? 0) + 1);
      recordEmission(runId);

      deps.publish(event);
      return event;
    },

    getEmittedCount(runId) {
      return emittedPerRun.get(runId) ?? 0;
    },

    getDroppedCount(runId) {
      return droppedPerRun.get(runId) ?? 0;
    },

    getEvents(runId) {
      return events.filter((e) => e.correlation.runId === runId);
    },

    reset() {
      events.length = 0;
      emittedPerRun.clear();
      droppedPerRun.clear();
      rateWindow.clear();
    },
  };
}
