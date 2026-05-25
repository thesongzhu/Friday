/**
 * B-004 Observability Instrumentation Bridge — connects workflow, agent, and
 * API runtime hooks to the observability managers (metrics, traces, audit).
 *
 * Provides:
 * - Automatic span creation for workflow runs, agent executions, and API requests
 * - Metric counters and histograms for throughput, latency, and error rates
 * - Correlation ID propagation (traceId + spanId) across layers
 * - Sampling controls for high-volume events
 * - Dimension labeling for module, operation, and status
 *
 * **B4 truth-labeling note (proof_pending; NOT wired into production):**
 * `createObservabilityInstrumentationBridge`, `INSTRUMENTATION_METRICS`,
 * and `INSTRUMENTATION_TRACE_NAMES` are exported via
 * `observability/engine/index.ts` but have ZERO production import sites
 * as of the B4 capability inventory. The workflow runtime, agent runtime,
 * and API runtime instrument their own counters via
 * `FridayMetricsCollector` and `FridayTraceManager` directly. The
 * bridge's value-add (correlation propagation + sampling + dimension
 * labeling) is real but uninvoked.
 *
 * The export is preserved via the parent barrel so a future
 * "wire-instrumentation-bridge-into-runtimes" slice can hook it in
 * without a contract break. A one-time `console.info` advisory fires
 * at first construction so anyone wiring it in production sees the
 * proof_pending state in logs.
 *
 * @module observability/engine
 */

import type {
  FridayObservabilityModule,
  FridaySpanKind,
  FridaySpanStatus,
} from "../model/friday-observability.types.js";

// ─── Correlation Context ───

export interface ObservabilityCorrelation {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  module: FridayObservabilityModule;
}

// ─── Instrumentation Event Types ───

export type InstrumentationEventKind =
  | "workflow.run.start"
  | "workflow.run.end"
  | "workflow.node.start"
  | "workflow.node.end"
  | "agent.run.start"
  | "agent.run.end"
  | "agent.tool.start"
  | "agent.tool.end"
  | "api.request.start"
  | "api.request.end";

export interface InstrumentationEvent {
  kind: InstrumentationEventKind;
  module: FridayObservabilityModule;
  operationName: string;
  correlation: ObservabilityCorrelation;
  attributes: Record<string, string | number | boolean>;
  durationMs?: number;
  status?: FridaySpanStatus;
  error?: string;
  timestamp: string;
}

// ─── Sampling Policy ───

export interface SamplingPolicy {
  /** Sample rate (0.0 to 1.0). 1.0 = sample everything. */
  rate: number;
  /** Always sample errors regardless of rate. */
  alwaysSampleErrors: boolean;
  /** Always sample operations exceeding this duration (ms). 0 = disabled. */
  alwaysSampleSlowMs: number;
}

const DEFAULT_SAMPLING_POLICY: SamplingPolicy = {
  rate: 1.0,
  alwaysSampleErrors: true,
  alwaysSampleSlowMs: 5000,
};

// ─── Metric Names (documented constants) ───

export const INSTRUMENTATION_METRICS = {
  // Workflow
  WORKFLOW_RUNS_TOTAL: "friday.workflow.runs.total",
  WORKFLOW_RUN_DURATION_MS: "friday.workflow.run.duration_ms",
  WORKFLOW_NODE_EXECUTIONS_TOTAL: "friday.workflow.node.executions.total",
  WORKFLOW_NODE_DURATION_MS: "friday.workflow.node.duration_ms",

  // Agent
  AGENT_RUNS_TOTAL: "friday.agent.runs.total",
  AGENT_RUN_DURATION_MS: "friday.agent.run.duration_ms",
  AGENT_TOOL_CALLS_TOTAL: "friday.agent.tool.calls.total",
  AGENT_TOOL_DURATION_MS: "friday.agent.tool.duration_ms",

  // API
  API_REQUESTS_TOTAL: "friday.api.requests.total",
  API_REQUEST_DURATION_MS: "friday.api.request.duration_ms",
} as const;

export const INSTRUMENTATION_TRACE_NAMES = {
  WORKFLOW_RUN: "workflow.run",
  WORKFLOW_NODE: "workflow.node",
  AGENT_RUN: "agent.run",
  AGENT_TOOL: "agent.tool",
  API_REQUEST: "api.request",
} as const;

// ─── Dependencies ───

export interface InstrumentationBridgeDeps {
  /** Record a metric counter increment. */
  incrementCounter: (name: string, labels: Record<string, string>, delta?: number) => void;
  /** Record a histogram observation. */
  recordHistogram: (name: string, labels: Record<string, string>, value: number) => void;
  /** Start a trace span. Returns a handle with spanId for nesting. */
  startSpan: (params: {
    traceId: string;
    name: string;
    kind: FridaySpanKind;
    module: FridayObservabilityModule;
    parentSpanId?: string;
    attributes?: Record<string, string | number | boolean>;
  }) => { spanId: string };
  /** End a span with status and optional error. */
  endSpan: (params: {
    traceId: string;
    spanId: string;
    status: FridaySpanStatus;
    error?: string;
    attributes?: Record<string, string | number | boolean>;
  }) => void;
  /** Generate a trace ID. */
  generateTraceId: () => string;
  /** Generate a span ID. */
  generateSpanId: () => string;
  /** Clock. */
  nowIso?: () => string;
  /** Sampling policy. */
  samplingPolicy?: SamplingPolicy;
}

// ─── Interface ───

export interface FridayObservabilityInstrumentationBridge {
  /**
   * Record an instrumentation event. Handles span lifecycle, metrics, and sampling.
   */
  record(event: InstrumentationEvent): void;

  /**
   * Start a new trace and return correlation context for propagation.
   */
  startTrace(params: {
    module: FridayObservabilityModule;
    operationName: string;
    attributes?: Record<string, string | number | boolean>;
  }): ObservabilityCorrelation;

  /**
   * Start a child span within an existing trace.
   */
  startSpan(params: {
    parent: ObservabilityCorrelation;
    operationName: string;
    kind?: FridaySpanKind;
    attributes?: Record<string, string | number | boolean>;
  }): ObservabilityCorrelation;

  /**
   * End a span and record metrics.
   */
  endSpan(params: {
    correlation: ObservabilityCorrelation;
    status: FridaySpanStatus;
    durationMs: number;
    error?: string;
    attributes?: Record<string, string | number | boolean>;
  }): void;

  /**
   * Check if an event should be sampled based on sampling policy.
   */
  shouldSample(params: {
    status?: FridaySpanStatus;
    durationMs?: number;
  }): boolean;

  /**
   * Get all recorded events (for testing / diagnostics).
   */
  getRecordedEvents(): readonly InstrumentationEvent[];

  /**
   * Get counts by event kind (for testing / diagnostics).
   */
  getEventCounts(): Record<InstrumentationEventKind, number>;

  /**
   * Reset internal state.
   */
  reset(): void;
}

// ─── Metric Name Mapping ───

const EVENT_METRIC_MAP: Record<string, { counter: string; histogram: string }> = {
  "workflow.run": {
    counter: INSTRUMENTATION_METRICS.WORKFLOW_RUNS_TOTAL,
    histogram: INSTRUMENTATION_METRICS.WORKFLOW_RUN_DURATION_MS,
  },
  "workflow.node": {
    counter: INSTRUMENTATION_METRICS.WORKFLOW_NODE_EXECUTIONS_TOTAL,
    histogram: INSTRUMENTATION_METRICS.WORKFLOW_NODE_DURATION_MS,
  },
  "agent.run": {
    counter: INSTRUMENTATION_METRICS.AGENT_RUNS_TOTAL,
    histogram: INSTRUMENTATION_METRICS.AGENT_RUN_DURATION_MS,
  },
  "agent.tool": {
    counter: INSTRUMENTATION_METRICS.AGENT_TOOL_CALLS_TOTAL,
    histogram: INSTRUMENTATION_METRICS.AGENT_TOOL_DURATION_MS,
  },
  "api.request": {
    counter: INSTRUMENTATION_METRICS.API_REQUESTS_TOTAL,
    histogram: INSTRUMENTATION_METRICS.API_REQUEST_DURATION_MS,
  },
};

function getMetricCategory(kind: InstrumentationEventKind): string {
  // "workflow.run.start" → "workflow.run"
  const parts = kind.split(".");
  return parts.slice(0, 2).join(".");
}

// ─── Factory ───

let observabilityInstrumentationBridgeAdvisoryEmitted = false;

/** Warn-once advisory at first construction. See module header. */
function emitObservabilityInstrumentationBridgeAdvisoryOnce(): void {
  if (observabilityInstrumentationBridgeAdvisoryEmitted) return;
  observabilityInstrumentationBridgeAdvisoryEmitted = true;
  console.info(
    "[friday][observability][instrumentation-bridge] advisory: createObservabilityInstrumentationBridge is constructed but has zero production import sites as of the B4 capability inventory; the workflow, agent, and API runtimes instrument via FridayMetricsCollector and FridayTraceManager directly. Wiring this bridge is proof_pending — see module header.",
  );
}

export function createObservabilityInstrumentationBridge(
  deps: InstrumentationBridgeDeps,
): FridayObservabilityInstrumentationBridge {
  emitObservabilityInstrumentationBridgeAdvisoryOnce();
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const sampling = deps.samplingPolicy ?? DEFAULT_SAMPLING_POLICY;
  const events: InstrumentationEvent[] = [];
  const eventCounts = new Map<InstrumentationEventKind, number>();

  // Deterministic sampling based on trace ID hash
  let sampleSeed = 0;

  function shouldSampleInternal(status?: FridaySpanStatus, durationMs?: number): boolean {
    // Always sample errors
    if (sampling.alwaysSampleErrors && status === "error") return true;
    // Always sample slow operations
    if (sampling.alwaysSampleSlowMs > 0 && durationMs && durationMs >= sampling.alwaysSampleSlowMs) return true;
    // Rate-based sampling
    if (sampling.rate >= 1.0) return true;
    if (sampling.rate <= 0.0) return false;
    // Simple deterministic sampling
    sampleSeed = (sampleSeed + 1) % 1000;
    return sampleSeed / 1000 < sampling.rate;
  }

  function recordMetrics(event: InstrumentationEvent): void {
    const category = getMetricCategory(event.kind);
    const mapping = EVENT_METRIC_MAP[category];
    if (!mapping) return;

    const labels: Record<string, string> = {
      module: event.module,
      operation: event.operationName,
      status: event.status ?? "unset",
    };

    // Only record metrics on "end" events
    if (event.kind.endsWith(".end")) {
      deps.incrementCounter(mapping.counter, labels);
      if (event.durationMs !== undefined) {
        deps.recordHistogram(mapping.histogram, labels, event.durationMs);
      }
    }
  }

  return {
    record(event) {
      events.push(event);
      eventCounts.set(event.kind, (eventCounts.get(event.kind) ?? 0) + 1);

      if (shouldSampleInternal(event.status, event.durationMs)) {
        recordMetrics(event);
      }
    },

    startTrace(params) {
      const traceId = deps.generateTraceId();
      const spanResult = deps.startSpan({
        traceId,
        name: params.operationName,
        kind: "internal",
        module: params.module,
        attributes: params.attributes,
      });

      return {
        traceId,
        spanId: spanResult.spanId,
        module: params.module,
      };
    },

    startSpan(params) {
      const spanResult = deps.startSpan({
        traceId: params.parent.traceId,
        name: params.operationName,
        kind: params.kind ?? "internal",
        module: params.parent.module,
        parentSpanId: params.parent.spanId,
        attributes: params.attributes,
      });

      return {
        traceId: params.parent.traceId,
        spanId: spanResult.spanId,
        parentSpanId: params.parent.spanId,
        module: params.parent.module,
      };
    },

    endSpan(params) {
      deps.endSpan({
        traceId: params.correlation.traceId,
        spanId: params.correlation.spanId,
        status: params.status,
        error: params.error,
        attributes: params.attributes,
      });

      // Record end-span metrics
      const category = `${params.correlation.module === "workflows" ? "workflow" : params.correlation.module}.run`;
      const mapping = EVENT_METRIC_MAP[category];
      if (mapping && shouldSampleInternal(params.status, params.durationMs)) {
        const labels: Record<string, string> = {
          module: params.correlation.module,
          status: params.status,
        };
        deps.incrementCounter(mapping.counter, labels);
        deps.recordHistogram(mapping.histogram, labels, params.durationMs);
      }
    },

    shouldSample(params) {
      return shouldSampleInternal(params.status, params.durationMs);
    },

    getRecordedEvents() {
      return [...events];
    },

    getEventCounts() {
      const counts = {} as Record<InstrumentationEventKind, number>;
      for (const kind of eventCounts.keys()) {
        counts[kind] = eventCounts.get(kind)!;
      }
      return counts;
    },

    reset() {
      events.length = 0;
      eventCounts.clear();
      sampleSeed = 0;
    },
  };
}
