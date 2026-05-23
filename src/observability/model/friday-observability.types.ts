/**
 * Observability, Audit, and Ops — Domain Model and Data Contract.
 *
 * Canonical types for the Friday Observability layer: distributed tracing
 * (traces, spans, context propagation), tamper-evident audit logging,
 * SLO monitoring (SLIs, error budgets, burn rates), alerting pipeline
 * (rules, channels, events, escalation), and persistence schema types.
 *
 * @module observability/model
 */

// ─── Foundational Value Types (local; mirrors rules/workflow/uix pattern) ───

/** UUID string identifier. */
export type UUID = string;

/** ISO 8601 date-time string. */
export type ISODateTime = string;

/** JSON-safe primitive value. */
export type JsonPrimitive = string | number | boolean | null;

/** Recursive JSON-safe value. */
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

/** JSON-safe object. */
export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * Attribute value type shaped for future OpenTelemetry export constraints.
 * Friday does not ship an OTLP exporter or wire-level OTel integration here.
 * No nested JSON — only primitives and homogeneous arrays of primitives.
 */
export type FridayAttributeValue =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | boolean[];

/**
 * An attribute map following local OTel-shaped constraints.
 * Keys are strings; values are primitives or homogeneous arrays.
 */
export interface FridayAttributes {
  [key: string]: FridayAttributeValue;
}

// ═══════════════════════════════════════════════════════════════════════
// DISTRIBUTED TRACING
// ═══════════════════════════════════════════════════════════════════════

// ─── Span Kind ───

/**
 * The kind of span, using local Friday trace/span names.
 *
 * - `internal` — In-process function call (e.g., Rules Engine evaluation).
 * - `server` — Inbound API request.
 * - `client` — Outbound call to an external service.
 * - `producer` — Asynchronous message send (e.g., job queue enqueue).
 * - `consumer` — Asynchronous message receive (e.g., job queue dequeue).
 */
export type FridaySpanKind =
  | "internal"
  | "server"
  | "client"
  | "producer"
  | "consumer";

// ─── Span Status ───

/**
 * The status of a span's operation.
 *
 * - `unset` — Status not explicitly set (default).
 * - `ok` — The operation completed successfully.
 * - `error` — The operation encountered an error.
 */
export type FridaySpanStatus =
  | "unset"
  | "ok"
  | "error";

// ─── Span Context (Propagation Token) ───

/**
 * The propagation token threaded across module boundaries.
 * Carries the trace ID, span ID, and trace flags needed to
 * reconstruct the full trace tree.
 *
 * Local Friday propagation token (not W3C traceparent compatible).
 */
export interface FridaySpanContext {
  /** The globally unique trace identifier (128-bit hex string). */
  traceId: string;
  /** The span identifier within the trace (64-bit hex string). */
  spanId: string;
  /**
   * Trace flags (bit field).
   * - Bit 0 (0x01): sampled — the trace is being collected.
   * @default 1
   */
  traceFlags: number;
  /**
   * Additional vendor-specific trace state.
   * Local opaque key=value trace state.
   */
  tracestate?: string;
}

// ─── Span Event ───

/**
 * A timestamped event (annotation) within a span.
 * Used to record notable moments during the span's lifetime
 * (e.g., "cache miss", "retry scheduled").
 */
export interface FridaySpanEvent {
  /** Event name. */
  name: string;
  /** When the event occurred. */
  timestamp: ISODateTime;
  /** Structured attributes on the event (local OTel-shaped primitives only). */
  attributes?: FridayAttributes;
}

// ─── Span ───

/**
 * A single unit of work within a trace.
 * Represents a bounded operation with start/end times,
 * a kind, a status, and structured attributes.
 */
export interface FridaySpan {
  /** Unique span identifier (64-bit hex string). */
  spanId: string;
  /** Parent trace identifier. */
  traceId: string;
  /** Parent span identifier (undefined for root spans). */
  parentSpanId?: string;
  /** Human-readable operation name (e.g., "rules.evaluate", "node.execute"). */
  operationName: string;
  /** The kind of work this span represents. */
  kind: FridaySpanKind;
  /** The outcome status of this span. */
  status: FridaySpanStatus;
  /** Error message when status is "error". */
  statusMessage?: string;
  /**
   * Source module that produced this span.
   *
   * Corresponds to `friday.module` attribute.
   */
  module: FridayObservabilityModule;
  /** Structured attributes for filtering and correlation (local OTel-shaped primitives only). */
  attributes: FridayAttributes;
  /** Timestamped events within this span. */
  events: FridaySpanEvent[];
  /** When this span started. */
  startedAt: ISODateTime;
  /** When this span ended (undefined if still in progress). */
  endedAt?: ISODateTime;
  /** Duration in milliseconds (computed from startedAt → endedAt). */
  durationMs?: number;
}

/**
 * Module identifiers used for trace attribution and SLI scoping.
 */
export type FridayObservabilityModule =
  | "rules"
  | "node-runner"
  | "acceptance"
  | "retry"
  | "uix"
  | "skills"
  | "learning"
  | "workflows"
  | "api"
  | "auth"
  | "observability"
  | "desktop";

// ─── Trace ───

/**
 * A distributed trace: the complete tree of spans for an
 * end-to-end request (e.g., a workflow run, an API request).
 */
export interface FridayTrace {
  /** Unique trace identifier (128-bit hex string). */
  traceId: string;
  /**
   * Human-readable name for the trace
   * (e.g., "workflow-run:wf-abc", "api:POST /api/retry/classify").
   */
  name: string;
  /** The root span of this trace. */
  rootSpanId: string;
  /** All spans belonging to this trace, ordered by startedAt. */
  spans: FridaySpan[];
  /** Trace status: derived from the root span's status. */
  status: FridaySpanStatus;
  /**
   * Structured attributes at the trace level (local OTel-shaped primitives only).
   * Common keys: `friday.workflow.id`, `friday.workflow.run_id`, `friday.principal.id`.
   */
  attributes: FridayAttributes;
  /** Total trace duration in milliseconds. */
  durationMs: number;
  /** Total number of spans. */
  spanCount: number;
  /** When the trace started (root span start). */
  startedAt: ISODateTime;
  /** When the trace ended (last span end). */
  endedAt?: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// AUDIT LOGGING
// ═══════════════════════════════════════════════════════════════════════

// ─── Audit Actor ───

/**
 * The type of entity that performed the auditable action.
 */
export type FridayAuditActorType =
  | "user"
  | "system"
  | "api_key"
  | "workflow"
  | "agent";

/**
 * The actor (who) of an audit event.
 */
export interface FridayAuditActor {
  /** Actor type. */
  type: FridayAuditActorType;
  /** Actor identifier (principal ID, workflow ID, or system component name). */
  id: string;
  /** Human-readable display name. */
  displayName: string;
  /** IP address (for API-originated actions). */
  ip?: string;
  /** User agent string (for API-originated actions). */
  userAgent?: string;
}

// ─── Audit Resource ───

/**
 * The type of resource being acted upon.
 */
export type FridayAuditResourceType =
  | "rule"
  | "policy"
  | "workflow"
  | "workflow_run"
  | "node"
  | "template"
  | "incident"
  | "auto_fix_action"
  | "skill_generation_session"
  | "workflow_generation_session"
  | "preference"
  | "credential"
  | "alert_rule"
  | "slo"
  | "retry_policy"
  | "acceptance_test"
  | "guided_workflow";

/**
 * The resource (what) of an audit event.
 */
export interface FridayAuditResource {
  /** Resource type. */
  type: FridayAuditResourceType;
  /** Resource identifier. */
  id: string;
  /** Human-readable display name. */
  displayName?: string;
  /**
   * Serialized snapshot of the resource before the change.
   * Capped at 64 KB. Null for create/delete actions.
   */
  snapshotBefore?: JsonObject;
  /**
   * Serialized snapshot of the resource after the change.
   * Capped at 64 KB. Null for delete actions.
   */
  snapshotAfter?: JsonObject;
}

// ─── Audit Outcome ───

/**
 * The outcome of the auditable action.
 */
export type FridayAuditOutcome =
  | "success"
  | "failure"
  | "denied"
  | "error";

// ─── Audit Action Category ───

/**
 * High-level categories of auditable actions.
 */
export type FridayAuditActionCategory =
  | "create"
  | "update"
  | "delete"
  | "execute"
  | "access"
  | "authenticate"
  | "authorize"
  | "configure";

// ─── Canonical Serialization ───

/**
 * Canonical serialization for tamper-evident hashing.
 *
 * Specification:
 * - JSON keys sorted lexicographically (recursive)
 * - No whitespace (no spaces, no newlines)
 * - UTF-8 encoded
 * - Null values preserved (not stripped)
 * - Array order preserved (not sorted)
 *
 * This function produces a deterministic byte string for any given input,
 * ensuring that hash computation is reproducible across implementations.
 */
export type FridayCanonicalizeAuditEntry = (
  entry: Omit<FridayAuditEntry, "integrityHash">,
) => string;

// ─── Retention Checkpoint ───

/**
 * A retention checkpoint records the boundary hash when audit entries
 * are deleted by a retention policy. This allows verification of entries
 * after the boundary even though earlier entries are no longer available.
 */
export interface FridayRetentionCheckpoint {
  /** Unique checkpoint identifier. */
  id: UUID;
  /** Sequence number of the last entry deleted by this retention run. */
  lastDeletedSequenceNumber: number;
  /** Integrity hash of the last deleted entry (the new chain anchor). */
  boundaryHash: string;
  /** Sequence number of the first entry retained after this checkpoint. */
  firstRetainedSequenceNumber: number;
  /** When this checkpoint was created. */
  createdAt: ISODateTime;
  /** Reason for the retention deletion (e.g., "90-day retention policy"). */
  reason: string;
}

// ─── Audit Entry ───

/**
 * A single audit log entry.
 *
 * Audit entries are append-only and tamper-evident.
 * Each entry's `integrityHash` includes the previous entry's hash,
 * forming a hash chain that detects modification or deletion.
 *
 * The hash is computed as:
 * `SHA-256(previousHash + canonicalize(entry))`,
 * where canonicalize produces sorted-key, no-whitespace, UTF-8 JSON.
 */
export interface FridayAuditEntry {
  /** Unique audit entry identifier. */
  id: UUID;
  /** Monotonically increasing sequence number (per hub instance). */
  sequenceNumber: number;
  /** Who performed the action. */
  actor: FridayAuditActor;
  /** High-level action category. */
  actionCategory: FridayAuditActionCategory;
  /**
   * Specific action performed.
   * Dot-namespaced: `module.action` (e.g., "rules.create", "retry.policy.update").
   */
  action: string;
  /** The resource acted upon. */
  resource: FridayAuditResource;
  /** The outcome of the action. */
  outcome: FridayAuditOutcome;
  /** Human-readable description of what happened. */
  description: string;
  /** Error code (when outcome is "failure", "denied", or "error"). */
  errorCode?: string;
  /** Error message (when outcome is "failure", "denied", or "error"). */
  errorMessage?: string;
  /** Source module. */
  module: FridayObservabilityModule;
  /**
   * Trace ID for correlation with the distributed tracing system.
   * Links the audit entry to the request trace that produced it.
   */
  traceId?: string;
  /** Span ID for fine-grained correlation. */
  spanId?: string;
  /**
   * SHA-256 integrity hash.
   * Computed as: `SHA-256(previousHash + canonicalize(entry))`.
   * The first entry uses a well-known genesis hash.
   */
  integrityHash: string;
  /**
   * Hash of the previous audit entry.
   * Null for the first entry in the chain (uses genesis hash).
   */
  previousHash: string | null;
  /** Arbitrary metadata. */
  metadata?: JsonObject;
  /** When this audit entry was recorded. */
  recordedAt: ISODateTime;
}

/**
 * The well-known genesis hash for the first entry in the audit chain.
 * SHA-256 of the UTF-8 string "FRIDAY_AUDIT_GENESIS".
 */
export const FRIDAY_AUDIT_GENESIS_HASH =
  "ccfe2250e941cefae29cad430af1a3a6e60d632b2ea9e69767cf1c8d9a124e36" as const;

// ═══════════════════════════════════════════════════════════════════════
// SLO MONITORING
// ═══════════════════════════════════════════════════════════════════════

// ─── SLI Metric ───

/**
 * SLI metric types supported in Phase 1.
 *
 * Phase 1 restricts to higher-is-better ratio-style SLIs where the
 * error budget formula `errorBudget = 100% - target` and
 * `remaining = errorBudget - (100% - actual)` are mathematically valid.
 *
 * `error_rate` is intentionally excluded: it is a lower-is-better metric
 * that would require inverted budget math (`remaining = errorBudget - actual`).
 * It may be added in Phase 2 alongside a polarity-aware SLO model.
 */
export type FridaySliMetricType =
  | "success_rate"
  | "availability";

/**
 * SLI metric types deferred to Phase 2.
 * These require different error budget formulas (absolute thresholds
 * rather than ratio-based budgets) or inverted polarity handling.
 *
 * - `error_rate` — lower-is-better ratio; requires polarity-aware budget math
 * - `latency_percentile` — requires threshold-based SLO (e.g., p99 < 200ms)
 * - `throughput` — requires count-based SLO
 * - `saturation` — requires capacity-based SLO
 */
export type FridaySliMetricTypePhase2 =
  | "error_rate"
  | "latency_percentile"
  | "throughput"
  | "saturation";

/**
 * A service-level indicator metric definition.
 * SLIs are the raw measurements that feed SLO calculations.
 *
 * Phase 1 supports higher-is-better ratio-style SLIs only (success_rate, availability).
 */
export interface FridaySliMetric {
  /**
   * Unique metric name.
   * Dot-namespaced: `module.metric_name`
   * (e.g., "node_runner.execution_success_rate").
   */
  name: string;
  /** Human-readable display name. */
  displayName: string;
  /** Description of what this metric measures. */
  description: string;
  /** The type of measurement (Phase 1: ratio-style only). */
  type: FridaySliMetricType;
  /** The unit of measurement (e.g., "percent"). */
  unit: string;
  /** Source module that produces this metric. */
  module: FridayObservabilityModule;
}

// ─── Error Budget ───

/**
 * The error budget state for an SLO at a point in time.
 *
 * Error budget formula (ratio SLIs only):
 *   errorBudget = 100% - target
 *   remaining = errorBudget - (100% - actual)
 *   consumedPercent = ((errorBudget - remaining) / errorBudget) × 100
 */
export interface FridayErrorBudget {
  /** The SLO definition ID this budget belongs to. */
  sloId: UUID;
  /** Total error budget as a percentage (100% - target). */
  totalBudgetPercent: number;
  /** Remaining error budget as a percentage. */
  remainingBudgetPercent: number;
  /** Consumed error budget as a percentage of total budget (0–100+). */
  consumedPercent: number;
  /** Whether the error budget is exhausted (consumedPercent >= 100). */
  exhausted: boolean;
  /** Current actual value of the SLI metric. */
  currentValue: number;
  /** Start of the compliance window. */
  windowStart: ISODateTime;
  /** End of the compliance window. */
  windowEnd: ISODateTime;
  /** When this budget was last computed. */
  computedAt: ISODateTime;
}

// ─── Burn Rate ───

/**
 * Burn rate measurement for an SLO over a specific time window.
 *
 * Burn rate = (errorRateInWindow / errorBudgetRate).
 * A burn rate of 1.0 means the budget is being consumed at exactly
 * the rate that would exhaust it at the end of the compliance window.
 */
export interface FridayBurnRate {
  /** The SLO definition ID this burn rate belongs to. */
  sloId: UUID;
  /** The time window this burn rate covers (e.g., "5m", "1h", "6h"). */
  windowLabel: string;
  /** Window duration in minutes. */
  windowMinutes: number;
  /** The computed burn rate multiplier. */
  rate: number;
  /** Error rate observed in this window. */
  errorRateInWindow: number;
  /** The baseline error budget rate (budget / compliance window). */
  errorBudgetRate: number;
  /** Whether this burn rate exceeds the alerting threshold. */
  exceedsThreshold: boolean;
  /** The alerting threshold for this window. */
  threshold: number;
  /** When this burn rate was computed. */
  computedAt: ISODateTime;
}

// ─── SLO Definition ───

/**
 * The status of an SLO.
 */
export type FridaySloStatus =
  | "healthy"
  | "warning"
  | "breached";

/**
 * A service-level objective definition.
 * Binds an SLI metric to a target over a compliance window.
 *
 * Phase 1: restricted to ratio-style SLIs where target is a percentage
 * and error budget = 100% - target.
 */
export interface FridaySloDefinition {
  /** Unique SLO identifier. */
  id: UUID;
  /** Human-readable name. */
  name: string;
  /** Description of this SLO. */
  description: string;
  /** The SLI metric this SLO tracks (Phase 1: ratio-style only). */
  sliMetric: FridaySliMetric;
  /**
   * Target value for the SLI as a percentage (e.g., 99.5 for 99.5%).
   * Since Phase 1 only supports ratio SLIs, the target is always a percentage
   * and error budget = 100 - target.
   */
  target: number;
  /**
   * Compliance window in days.
   * Error budget is computed over this rolling window.
   * @default 30
   */
  complianceWindowDays: number;
  /** Current SLO status. */
  status: FridaySloStatus;
  /** Whether this SLO is active. */
  enabled: boolean;
  /** Tags for filtering and organization. */
  tags: string[];
  /** Associated alert rule IDs (burn-rate alerts configured for this SLO). */
  alertRuleIds: UUID[];
  /** Current error budget state. */
  errorBudget?: FridayErrorBudget;
  /** Current burn rates across windows. */
  burnRates: FridayBurnRate[];
  /** Optimistic concurrency token. */
  etag: string;
  /** When this SLO was created. */
  createdAt: ISODateTime;
  /** When this SLO was last updated. */
  updatedAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// ALERTING PIPELINE
// ═══════════════════════════════════════════════════════════════════════

// ─── Alert Severity ───

/**
 * Severity levels for alerts.
 * Determines notification urgency and escalation behavior.
 */
export type FridayAlertSeverity =
  | "critical"
  | "warning"
  | "info";

/**
 * Priority order for alert severities.
 * Lower index = higher severity.
 */
export const FRIDAY_ALERT_SEVERITY_PRIORITY: readonly FridayAlertSeverity[] = [
  "critical",
  "warning",
  "info",
] as const;

// ─── Alert Condition Types (discriminated union) ───

/**
 * The type of condition that triggers an alert.
 */
export type FridayAlertConditionType =
  | "slo_burn_rate"
  | "threshold"
  | "anomaly"
  | "absence";

/**
 * Threshold alert condition: fires when a metric crosses a threshold.
 */
export interface FridayAlertConditionThreshold {
  type: "threshold";
  /** The SLI metric name to evaluate. */
  metricName: string;
  /** Threshold value to compare against. */
  threshold: number;
  /** Comparison operator. */
  operator: "gt" | "gte" | "lt" | "lte" | "eq";
}

/**
 * Absence alert condition: fires when a metric stops reporting.
 */
export interface FridayAlertConditionAbsence {
  type: "absence";
  /** The SLI metric name to evaluate. */
  metricName: string;
  /** Alert fires when the metric has not reported for this many minutes. */
  absenceMinutes: number;
}

/**
 * Anomaly alert condition: fires on anomalous metric behavior.
 */
export interface FridayAlertConditionAnomaly {
  type: "anomaly";
  /** The SLI metric name to evaluate. */
  metricName: string;
  /**
   * Sensitivity (standard deviations from baseline).
   * Lower = more sensitive.
   */
  sensitivity: number;
}

/**
 * Burn-rate alert condition: fires when SLO error budget consumption
 * exceeds a threshold over short and long windows.
 */
export interface FridayAlertConditionBurnRate {
  type: "slo_burn_rate";
  /** The SLO definition ID to evaluate. */
  sloId: string;
  /** Burn rate multiplier threshold. */
  burnRateThreshold: number;
  /** Short window duration in minutes. */
  shortWindowMinutes: number;
  /** Long window duration in minutes. */
  longWindowMinutes: number;
}

/**
 * Discriminated union of all alert condition types.
 * Each variant carries only the fields relevant to that condition type.
 */
export type FridayAlertCondition =
  | FridayAlertConditionThreshold
  | FridayAlertConditionAbsence
  | FridayAlertConditionAnomaly
  | FridayAlertConditionBurnRate;

// ─── Alert Channel (discriminated union) ───

/**
 * The transport type for alert notifications.
 */
export type FridayAlertChannelType =
  | "webhook"
  | "email"
  | "slack"
  | "pagerduty";

/** Common fields shared by all alert channel variants. */
interface FridayAlertChannelBase {
  /** Unique channel identifier. */
  readonly id: UUID;
  /** Human-readable name. */
  readonly name: string;
  /** Whether this channel is active. */
  readonly enabled: boolean;
  /** When this channel was created. */
  readonly createdAt: ISODateTime;
  /** When this channel was last updated. */
  readonly updatedAt: ISODateTime;
}

/** Webhook alert channel. */
export interface FridayAlertChannelWebhook extends FridayAlertChannelBase {
  readonly type: "webhook";
  /** Target URL for HTTP POST. */
  readonly url: string;
  /** Optional headers to include in the request. */
  readonly headers?: Record<string, string>;
}

/** Email alert channel. */
export interface FridayAlertChannelEmail extends FridayAlertChannelBase {
  readonly type: "email";
  /** Recipient email addresses. */
  readonly recipients: string[];
}

/** Slack alert channel. */
export interface FridayAlertChannelSlack extends FridayAlertChannelBase {
  readonly type: "slack";
  /** Slack incoming webhook URL. */
  readonly webhookUrl: string;
  /** Optional Slack channel override. */
  readonly channel?: string;
}

/** PagerDuty alert channel. */
export interface FridayAlertChannelPagerduty extends FridayAlertChannelBase {
  readonly type: "pagerduty";
  /** PagerDuty integration/routing key. */
  readonly routingKey: string;
  /** PagerDuty severity mapping override. */
  readonly severityMapping?: Record<string, string>;
}

/**
 * An alert notification channel (discriminated union).
 *
 * Each variant bundles the channel type with its type-specific configuration
 * inline, making invalid type/config combinations unrepresentable.
 *
 * Discriminant: `type`.
 */
export type FridayAlertChannel =
  | FridayAlertChannelWebhook
  | FridayAlertChannelEmail
  | FridayAlertChannelSlack
  | FridayAlertChannelPagerduty;

// ─── Escalation Tiers ───

/**
 * An escalation tier within an alert rule.
 * Each tier defines how long to wait before escalating and which channels to notify.
 * Maximum 3 tiers per alert rule.
 */
export interface FridayEscalationTier {
  /** Tier number (1 = first escalation, 2 = second, 3 = final). */
  tier: 1 | 2 | 3;
  /**
   * Minutes to wait after the previous tier (or after initial alert for tier 1)
   * before escalating to this tier's channels.
   */
  timeoutMinutes: number;
  /** Channel IDs to notify when this tier activates. */
  channelIds: UUID[];
}

// ─── Alert Rule ───

/**
 * An alert rule definition.
 * Defines when an alert fires, how severe it is, where notifications go,
 * and how escalation works through up to 3 tiers.
 */
export interface FridayAlertRule {
  /** Unique rule identifier. */
  id: UUID;
  /** Human-readable name. */
  name: string;
  /** Description of what this rule monitors. */
  description: string;
  /** Alert severity. */
  severity: FridayAlertSeverity;
  /** Whether this rule is active. */
  enabled: boolean;
  /** The condition that triggers this alert (discriminated union). */
  condition: FridayAlertCondition;
  /**
   * Evaluation interval in seconds.
   * How often the condition is checked.
   * @default 60
   */
  evaluationIntervalSec: number;
  /**
   * Notification channel IDs to dispatch alerts to (initial notification).
   */
  channelIds: UUID[];
  /**
   * Escalation tiers (max 3).
   * Defines time-based escalation if the alert is not acknowledged.
   * Empty array means no escalation.
   */
  escalationTiers: FridayEscalationTier[];
  /**
   * Grouping window in minutes.
   * Alerts of the same rule are deduplicated within this window.
   * @default 5
   */
  groupingWindowMin: number;
  /** Tags for filtering and organization. */
  tags: string[];
  /** Optimistic concurrency token. */
  etag: string;
  /** When this rule was created. */
  createdAt: ISODateTime;
  /** When this rule was last updated. */
  updatedAt: ISODateTime;
  /** Soft-delete timestamp. */
  deletedAt?: ISODateTime;
}

// ─── Alert Event ───

/**
 * The lifecycle state of an alert event.
 */
export type FridayAlertEventStatus =
  | "pending"
  | "firing"
  | "acknowledged"
  | "escalated"
  | "resolved";

/**
 * An alert event: a single instance of an alert rule firing.
 * Tracks the lifecycle from detection through resolution.
 */
export interface FridayAlertEvent {
  /** Unique event identifier. */
  id: UUID;
  /** The alert rule that triggered this event. */
  ruleId: UUID;
  /** Alert severity (copied from rule at fire time). */
  severity: FridayAlertSeverity;
  /** Current lifecycle status. */
  status: FridayAlertEventStatus;
  /** Human-readable summary of why this alert fired. */
  summary: string;
  /** Detailed description with metric values and thresholds. */
  details: string;
  /** Source module where the condition was detected. */
  module: FridayObservabilityModule;
  /**
   * The SLO ID (for SLO-related alerts).
   */
  sloId?: UUID;
  /**
   * The metric name (for metric-related alerts).
   */
  metricName?: string;
  /**
   * The observed value that triggered the alert.
   */
  observedValue?: number;
  /**
   * The threshold that was breached.
   */
  thresholdValue?: number;
  /** Channel IDs that were notified. */
  notifiedChannelIds: UUID[];
  /** Current escalation tier (0 = initial, 1–3 = escalation tier). */
  currentEscalationTier: number;
  /** When the alert condition was first detected. */
  detectedAt: ISODateTime;
  /** When the alert started firing (sustained across evaluation window). */
  firedAt?: ISODateTime;
  /** When the alert was acknowledged. */
  acknowledgedAt?: ISODateTime;
  /** Who acknowledged the alert. */
  acknowledgedBy?: string;
  /** Acknowledgement note. */
  acknowledgeNote?: string;
  /** When the alert was last escalated. */
  escalatedAt?: ISODateTime;
  /** When the alert was resolved (condition cleared). */
  resolvedAt?: ISODateTime;
  /** Arbitrary metadata. */
  metadata?: JsonObject;
}

// ═══════════════════════════════════════════════════════════════════════
// PERSISTENCE ROW TYPES (SQLite)
// ═══════════════════════════════════════════════════════════════════════

/** SQLite row shape for the `obs_traces` table. */
export interface FridayTraceRow {
  trace_id: string;
  name: string;
  root_span_id: string;
  status: string;
  attributes_json: string;
  duration_ms: number;
  span_count: number;
  started_at: string;
  ended_at: string | null;
}

/** SQLite row shape for the `obs_spans` table. */
export interface FridaySpanRow {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  operation_name: string;
  kind: string;
  status: string;
  status_message: string | null;
  module: string;
  attributes_json: string;
  events_json: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
}

/** SQLite row shape for the `obs_audit_entries` table. */
export interface FridayAuditEntryRow {
  id: string;
  sequence_number: number;
  actor_json: string;
  action_category: string;
  action: string;
  resource_json: string;
  outcome: string;
  description: string;
  error_code: string | null;
  error_message: string | null;
  module: string;
  trace_id: string | null;
  span_id: string | null;
  integrity_hash: string;
  previous_hash: string | null;
  metadata_json: string | null;
  recorded_at: string;
}

/** SQLite row shape for the `obs_retention_checkpoints` table. */
export interface FridayRetentionCheckpointRow {
  id: string;
  last_deleted_sequence_number: number;
  boundary_hash: string;
  first_retained_sequence_number: number;
  created_at: string;
  reason: string;
}

/** SQLite row shape for the `obs_slo_definitions` table. */
export interface FridaySloDefinitionRow {
  id: string;
  name: string;
  description: string;
  sli_metric_json: string;
  target: number;
  compliance_window_days: number;
  status: string;
  enabled: number;
  tags_json: string;
  alert_rule_ids_json: string;
  error_budget_json: string | null;
  burn_rates_json: string;
  etag: string;
  created_at: string;
  updated_at: string;
}

/** SQLite row shape for the `obs_alert_rules` table. */
export interface FridayAlertRuleRow {
  id: string;
  name: string;
  description: string;
  severity: string;
  enabled: number;
  condition_json: string;
  evaluation_interval_sec: number;
  channel_ids_json: string;
  escalation_tiers_json: string;
  grouping_window_min: number;
  tags_json: string;
  etag: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** SQLite row shape for the `obs_alert_channels` table. */
export interface FridayAlertChannelRow {
  id: string;
  name: string;
  type: string;
  enabled: number;
  config_json: string;
  created_at: string;
  updated_at: string;
}

/** SQLite row shape for the `obs_alert_events` table. */
export interface FridayAlertEventRow {
  id: string;
  rule_id: string;
  severity: string;
  status: string;
  summary: string;
  details: string;
  module: string;
  slo_id: string | null;
  metric_name: string | null;
  observed_value: number | null;
  threshold_value: number | null;
  notified_channel_ids_json: string;
  current_escalation_tier: number;
  detected_at: string;
  fired_at: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  acknowledge_note: string | null;
  escalated_at: string | null;
  resolved_at: string | null;
  metadata_json: string | null;
}

// ─── Row-to-Entity Mapper Signature ───

/** Generic row-to-entity mapper function type. */
export type FridayObservabilityRowMapper<TRow, TEntity> = (row: TRow) => TEntity;
