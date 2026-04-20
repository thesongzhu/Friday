// ─── Observability, Audit, and Ops — Core Runtime Engine ───

// ─── Metrics Collector ───

export { FridayMetricsCollector, DEFAULT_HISTOGRAM_BUCKETS } from "./metrics-collector.js";

export type {
  MetricType,
  MetricLabels,
  MetricDataPoint,
  CounterSnapshot,
  GaugeSnapshot,
  HistogramBucket,
  HistogramSnapshot,
  MetricSnapshot,
} from "./metrics-collector.js";

// ─── Trace Manager ───

export { FridayTraceManager } from "./trace-manager.js";

export type {
  StartTraceOptions,
  StartSpanOptions,
  SpanEventOptions,
  TraceHandle,
  SpanHandle,
} from "./trace-manager.js";

// ─── Audit Trail ───

export { FridayAuditTrail, canonicalizeAuditEntry } from "./audit-trail.js";

export type {
  AppendAuditEntryOptions,
  FridayAuditTrailOptions,
  FridayAuditTrailPersistenceSnapshot,
  FridayAuditTrailStore,
} from "./audit-trail.js";

// ─── Alert Engine ───

export { FridayAlertEngine } from "./alert-engine.js";

export type {
  AlertMetricProvider,
  AlertBurnRateProvider,
  AlertEvaluationResult,
} from "./alert-engine.js";

// ─── Runbook Automation ───

export { RunbookRegistry, RunbookExecutor } from "./runbook-automation.js";

export type {
  RunbookExecutionContext,
  RunbookDefinition,
  RunbookExecutionResult,
} from "./runbook-automation.js";

// ─── Health Check Manager ───

export { FridayHealthCheckManager } from "./health-check-manager.js";

export type {
  HealthStatus,
  DependencyHealth,
  ComponentHealth,
  SystemHealth,
  HealthCheckFn,
} from "./health-check-manager.js";

// ─── Instrumentation Bridge ───

export {
  createObservabilityInstrumentationBridge,
  INSTRUMENTATION_METRICS,
  INSTRUMENTATION_TRACE_NAMES,
} from "./friday-observability-instrumentation-bridge.js";

export type {
  ObservabilityCorrelation,
  InstrumentationEventKind,
  InstrumentationEvent,
  SamplingPolicy,
  InstrumentationBridgeDeps,
  FridayObservabilityInstrumentationBridge,
} from "./friday-observability-instrumentation-bridge.js";

// ─── Alert Evaluation Scheduler ───

export { createAlertEvaluationScheduler } from "./friday-alert-evaluation-scheduler.js";

export type {
  EvaluationCycleStats,
  AlertEvaluationSchedulerConfig,
  SchedulerState,
  AlertEvaluationSchedulerDeps,
  FridayAlertEvaluationScheduler,
  AggregateEvaluationStats,
} from "./friday-alert-evaluation-scheduler.js";

// ─── Dashboard Data Provider ───

export { FridayDashboardDataProvider } from "./dashboard-data-provider.js";

export type {
  BucketSize,
  TimeSeriesPoint,
  TimeSeriesQuery,
  TimeSeriesResult,
  TraceSummaryStats,
  AuditSummaryStats,
  AlertSummaryStats,
  DashboardOverview,
} from "./dashboard-data-provider.js";
