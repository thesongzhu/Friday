/**
 * Observability, Audit, and Ops — API and SDK Contract.
 *
 * Request/response DTOs for the observability REST API.
 * All types follow Friday API conventions: `FridayPage<T>` for pagination,
 * `FridayApiSuccessResponse<T>` / `FridayApiErrorResponse` for responses.
 *
 * @module observability/api
 */

import type {
  FridayAlertChannel,
  FridayAlertCondition,
  FridayAlertEvent,
  FridayAlertEventStatus,
  FridayAlertRule,
  FridayAlertSeverity,
  FridayAuditActionCategory,
  FridayAuditEntry,
  FridayAuditOutcome,
  FridayAuditResourceType,
  FridayBurnRate,
  FridayErrorBudget,
  FridayEscalationTier,
  FridayObservabilityModule,
  FridayRetentionCheckpoint,
  FridaySloDefinition,
  FridaySloStatus,
  FridaySpan,
  FridaySpanKind,
  FridaySpanStatus,
  FridayTrace,
  ISODateTime,
  UUID,
} from "../model/friday-observability.types.js";
import type {
  BucketSize,
  DashboardOverview,
  TimeSeriesResult,
} from "../engine/dashboard-data-provider.js";

import type { FridayPage, FridayPaginationQuery } from "../../api/model/friday-api-common.types.js";

// ─── Error Codes ───

/**
 * Standardized error codes for the observability domain.
 *
 * @example
 * ```ts
 * if (error.code === FRIDAY_OBSERVABILITY_ERROR_CODES.TRACE_NOT_FOUND) { ... }
 * ```
 */
export const FRIDAY_OBSERVABILITY_ERROR_CODES = {
  /** The requested trace does not exist or has expired. */
  TRACE_NOT_FOUND: "OBS_TRACE_NOT_FOUND",
  /** The requested span does not exist within the trace. */
  SPAN_NOT_FOUND: "OBS_SPAN_NOT_FOUND",
  /** The requested audit entry does not exist. */
  AUDIT_ENTRY_NOT_FOUND: "OBS_AUDIT_ENTRY_NOT_FOUND",
  /** Audit chain integrity verification failed. */
  AUDIT_CHAIN_BROKEN: "OBS_AUDIT_CHAIN_BROKEN",
  /** The requested SLO definition does not exist. */
  SLO_NOT_FOUND: "OBS_SLO_NOT_FOUND",
  /** SLO definition validation failed. */
  SLO_VALIDATION_FAILED: "OBS_SLO_VALIDATION_FAILED",
  /** Optimistic concurrency conflict — the etag does not match. */
  SLO_ETAG_MISMATCH: "OBS_SLO_ETAG_MISMATCH",
  /** The requested alert event does not exist. */
  ALERT_NOT_FOUND: "OBS_ALERT_NOT_FOUND",
  /** The alert has already been acknowledged. */
  ALERT_ALREADY_ACKNOWLEDGED: "OBS_ALERT_ALREADY_ACKNOWLEDGED",
  /** The requested alert rule does not exist or has been deleted. */
  ALERT_RULE_NOT_FOUND: "OBS_ALERT_RULE_NOT_FOUND",
  /** Alert rule validation failed. */
  ALERT_RULE_VALIDATION_FAILED: "OBS_ALERT_RULE_VALIDATION_FAILED",
  /** Optimistic concurrency conflict — the alert rule etag does not match. */
  ALERT_RULE_ETAG_MISMATCH: "OBS_ALERT_RULE_ETAG_MISMATCH",
  /** The requested alert channel does not exist. */
  ALERT_CHANNEL_NOT_FOUND: "OBS_ALERT_CHANNEL_NOT_FOUND",
  /** Alert channel validation failed. */
  ALERT_CHANNEL_VALIDATION_FAILED: "OBS_ALERT_CHANNEL_VALIDATION_FAILED",
  /** The alert is not in a state that allows acknowledgement. */
  ALERT_NOT_ACKNOWLEDGEABLE: "OBS_ALERT_NOT_ACKNOWLEDGEABLE",
} as const;

/** Union type of all observability error codes. */
export type FridayObservabilityErrorCode =
  (typeof FRIDAY_OBSERVABILITY_ERROR_CODES)[keyof typeof FRIDAY_OBSERVABILITY_ERROR_CODES];

// ─── Pagination (reuses shared types from api/model) ───

/** Pagination query for observability endpoints. */
export type FridayObservabilityPaginationQuery = FridayPaginationQuery;

/** Paginated result for observability endpoints. */
export type FridayObservabilityPage<TItem> = FridayPage<TItem>;

// ═══════════════════════════════════════════════════════════════════════
// TRACE API
// ═══════════════════════════════════════════════════════════════════════

// ─── Search Traces ───

/**
 * Query parameters for `GET /api/observability/traces`.
 *
 * @openapi operationId: searchTraces
 */
export interface FridaySearchTracesQuery extends FridayObservabilityPaginationQuery {
  /** Filter by trace name (partial match). */
  name?: string;
  /** Filter by trace status. */
  status?: FridaySpanStatus;
  /** Filter by source module. */
  module?: FridayObservabilityModule;
  /** Filter by workflow ID (from trace attributes). */
  workflowId?: string;
  /** Filter by workflow run ID (from trace attributes). */
  runId?: string;
  /** Filter by principal ID (from trace attributes). */
  principalId?: string;
  /** Minimum duration in milliseconds. */
  minDurationMs?: number;
  /** Maximum duration in milliseconds. */
  maxDurationMs?: number;
  /** Filter traces started after this timestamp (inclusive). */
  after?: ISODateTime;
  /** Filter traces started before this timestamp (exclusive). */
  before?: ISODateTime;
}

/**
 * Summary of a trace for list/search views.
 * Omits the full span tree for efficiency.
 */
export interface FridayTraceSummary {
  /** Trace ID. */
  traceId: string;
  /** Trace name. */
  name: string;
  /** Root span ID. */
  rootSpanId: string;
  /** Trace status. */
  status: FridaySpanStatus;
  /** Total duration in milliseconds. */
  durationMs: number;
  /** Total number of spans. */
  spanCount: number;
  /** Source module of the root span. */
  module: FridayObservabilityModule;
  /** Workflow ID (if present in attributes). */
  workflowId?: string;
  /** Workflow run ID (if present in attributes). */
  runId?: string;
  /** Principal ID (if present in attributes). */
  principalId?: string;
  /** When the trace started. */
  startedAt: ISODateTime;
  /** When the trace ended. */
  endedAt?: ISODateTime;
}

/**
 * Response body for `GET /api/observability/traces`.
 *
 * @openapi operationId: searchTraces
 */
export interface FridaySearchTracesResponse extends FridayObservabilityPage<FridayTraceSummary> {}

// ─── Get Trace ───

/**
 * Response body for `GET /api/observability/traces/:traceId`.
 *
 * Full trace detail including all spans.
 *
 * @openapi operationId: getTrace
 */
export interface FridayGetTraceResponse {
  /** The full trace with all spans. */
  trace: FridayTrace;
}

// ═══════════════════════════════════════════════════════════════════════
// DASHBOARD API
// ═══════════════════════════════════════════════════════════════════════

export interface FridayGetObservabilityOverviewResponse {
  overview: DashboardOverview;
  runtime?: {
    browser?: FridayObservabilityBrowserRuntimeSummary;
  };
}

export interface FridayObservabilityBrowserRuntimeSummary {
  configuredMode: "auto" | "headless" | "host_chrome_visible";
  activeMode: "headless" | "host_chrome_visible";
  targetBrowser: string;
  fallbackReason?: string;
  sessionCount: number;
  profiles: Array<{
    name: string;
    kind: "operator" | "automation" | "remote" | "custom";
    sessionCount: number;
    activeTabCount: number;
  }>;
}

export interface FridayGetObservabilityTimeSeriesQuery {
  metricName: string;
  startTime: ISODateTime;
  endTime: ISODateTime;
  bucketSize?: BucketSize;
}

export interface FridayGetObservabilityTimeSeriesResponse {
  series: TimeSeriesResult;
}

// ═══════════════════════════════════════════════════════════════════════
// AUDIT API
// ═══════════════════════════════════════════════════════════════════════

// ─── Search Audit Entries ───

/**
 * Query parameters for `GET /api/observability/audit`.
 *
 * @openapi operationId: searchAuditEntries
 */
export interface FridaySearchAuditEntriesQuery extends FridayObservabilityPaginationQuery {
  /** Filter by actor ID. */
  actorId?: string;
  /** Filter by action category. */
  actionCategory?: FridayAuditActionCategory;
  /** Filter by specific action (dot-namespaced, e.g., "rules.create"). */
  action?: string;
  /** Filter by resource type. */
  resourceType?: FridayAuditResourceType;
  /** Filter by resource ID. */
  resourceId?: string;
  /** Filter by outcome. */
  outcome?: FridayAuditOutcome;
  /** Filter by source module. */
  module?: FridayObservabilityModule;
  /** Filter by trace ID (correlation). */
  traceId?: string;
  /** Filter entries recorded after this timestamp (inclusive). */
  after?: ISODateTime;
  /** Filter entries recorded before this timestamp (exclusive). */
  before?: ISODateTime;
}

/**
 * Summary of an audit entry for list/search views.
 * Omits snapshots for efficiency.
 */
export interface FridayAuditEntrySummary {
  /** Entry ID. */
  id: UUID;
  /** Sequence number. */
  sequenceNumber: number;
  /** Actor display name. */
  actorDisplayName: string;
  /** Actor type. */
  actorType: string;
  /** Actor ID. */
  actorId: string;
  /** Action category. */
  actionCategory: FridayAuditActionCategory;
  /** Specific action. */
  action: string;
  /** Resource type. */
  resourceType: FridayAuditResourceType;
  /** Resource ID. */
  resourceId: string;
  /** Resource display name. */
  resourceDisplayName?: string;
  /** Outcome. */
  outcome: FridayAuditOutcome;
  /** Description. */
  description: string;
  /** Source module. */
  module: FridayObservabilityModule;
  /** Trace ID (for correlation). */
  traceId?: string;
  /** When recorded. */
  recordedAt: ISODateTime;
}

/**
 * Response body for `GET /api/observability/audit`.
 *
 * @openapi operationId: searchAuditEntries
 */
export interface FridaySearchAuditEntriesResponse extends FridayObservabilityPage<FridayAuditEntrySummary> {}

// ─── Get Audit Entry ───

/**
 * Response body for `GET /api/observability/audit/:entryId`.
 *
 * Full audit entry including snapshots and integrity hash.
 *
 * @openapi operationId: getAuditEntry
 */
export interface FridayGetAuditEntryResponse {
  /** The full audit entry. */
  entry: FridayAuditEntry;
  /** Whether the integrity hash chain is valid up to this entry. */
  chainValid: boolean;
}

// ═══════════════════════════════════════════════════════════════════════
// SLO API
// ═══════════════════════════════════════════════════════════════════════

// ─── List SLOs ───

/**
 * Query parameters for `GET /api/observability/slos`.
 *
 * @openapi operationId: listSlos
 */
export interface FridayListSlosQuery extends FridayObservabilityPaginationQuery {
  /** Filter by SLO status. */
  status?: FridaySloStatus;
  /** Filter by source module. */
  module?: FridayObservabilityModule;
  /** Filter by enabled status. */
  enabled?: boolean;
  /** Filter by tag. */
  tag?: string;
}

/**
 * Summary of an SLO for list views.
 */
export interface FridaySloSummary {
  /** SLO ID. */
  id: UUID;
  /** SLO name. */
  name: string;
  /** SLI metric name. */
  sliMetricName: string;
  /** Target value. */
  target: number;
  /** Current status. */
  status: FridaySloStatus;
  /** Whether the SLO is enabled. */
  enabled: boolean;
  /** Current SLI value. */
  currentValue?: number;
  /** Error budget consumed percentage. */
  budgetConsumedPercent?: number;
  /** Whether the error budget is exhausted. */
  budgetExhausted?: boolean;
  /** Compliance window in days. */
  complianceWindowDays: number;
  /** When last updated. */
  updatedAt: ISODateTime;
}

/**
 * Response body for `GET /api/observability/slos`.
 *
 * @openapi operationId: listSlos
 */
export interface FridayListSlosResponse extends FridayObservabilityPage<FridaySloSummary> {}

// ─── Get SLO Status ───

/**
 * Response body for `GET /api/observability/slos/:sloId`.
 *
 * Full SLO detail with error budget and burn rates.
 *
 * @openapi operationId: getSloStatus
 */
export interface FridayGetSloStatusResponse {
  /** The full SLO definition with current state. */
  slo: FridaySloDefinition;
  /** Current error budget state. */
  errorBudget: FridayErrorBudget | null;
  /** Current burn rates across all windows. */
  burnRates: FridayBurnRate[];
}

// ─── Alert Destinations ───

export type FridayAlertDestinationType = "slack" | "email";

export interface FridayAlertDestinationBaseSummary {
  id: UUID;
  name: string;
  type: FridayAlertDestinationType;
  enabled: boolean;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface FridayAlertDestinationSlackSummary extends FridayAlertDestinationBaseSummary {
  type: "slack";
  channel?: string;
  webhookConfigured: boolean;
}

export interface FridayAlertDestinationEmailSummary extends FridayAlertDestinationBaseSummary {
  type: "email";
  recipients: string[];
  fromAddress: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username?: string;
  passwordConfigured: boolean;
}

export type FridayAlertDestinationSummary =
  | FridayAlertDestinationSlackSummary
  | FridayAlertDestinationEmailSummary;

export interface FridayListAlertDestinationsResponse
  extends FridayObservabilityPage<FridayAlertDestinationSummary> {}

export type FridayCreateAlertDestinationRequest =
  | {
    type: "slack";
    name: string;
    enabled?: boolean;
    channel?: string;
    webhookUrl: string;
  }
  | {
    type: "email";
    name: string;
    enabled?: boolean;
    recipients: string[];
    fromAddress: string;
    smtpHost: string;
    smtpPort: number;
    smtpSecure?: boolean;
    username?: string;
    password: string;
  };

export type FridayUpdateAlertDestinationRequest =
  | {
    type?: "slack";
    name?: string;
    enabled?: boolean;
    channel?: string | null;
    webhookUrl?: string;
  }
  | {
    type?: "email";
    name?: string;
    enabled?: boolean;
    recipients?: string[];
    fromAddress?: string;
    smtpHost?: string;
    smtpPort?: number;
    smtpSecure?: boolean;
    username?: string | null;
    password?: string;
  };

export interface FridayCreateAlertDestinationResponse {
  destination: FridayAlertDestinationSummary;
}

export interface FridayUpdateAlertDestinationResponse {
  destination: FridayAlertDestinationSummary;
}

export interface FridayDeleteAlertDestinationResponse {
  deleted: true;
  destinationId: UUID;
}

export interface FridayAlertDispatchAttemptSummary {
  attemptId: UUID;
  destinationId: UUID;
  destinationType: FridayAlertDestinationType;
  status: "sent" | "failed" | "skipped";
  attemptNumber: number;
  dedupeKey: string;
  errorMessage?: string;
  sentAt?: ISODateTime;
}

export interface FridayTestAlertDispatchRequest {
  destinationId?: UUID;
}

export interface FridayTestAlertDispatchResponse {
  alertId: UUID;
  attempts: FridayAlertDispatchAttemptSummary[];
}

// ═══════════════════════════════════════════════════════════════════════
// ALERT API
// ═══════════════════════════════════════════════════════════════════════

// ─── List Alerts ───

/**
 * Query parameters for `GET /api/observability/alerts`.
 *
 * @openapi operationId: listAlerts
 */
export interface FridayListAlertsQuery extends FridayObservabilityPaginationQuery {
  /** Filter by alert rule ID. */
  ruleId?: UUID;
  /** Filter by severity. */
  severity?: FridayAlertSeverity;
  /** Filter by lifecycle status. */
  status?: FridayAlertEventStatus;
  /** Filter by source module. */
  module?: FridayObservabilityModule;
  /** Filter by SLO ID. */
  sloId?: UUID;
  /** Filter alerts detected after this timestamp (inclusive). */
  after?: ISODateTime;
  /** Filter alerts detected before this timestamp (exclusive). */
  before?: ISODateTime;
}

/**
 * Summary of an alert event for list views.
 */
export interface FridayAlertEventSummary {
  /** Event ID. */
  id: UUID;
  /** Rule ID. */
  ruleId: UUID;
  /** Rule name (denormalized for display). */
  ruleName: string;
  /** Severity. */
  severity: FridayAlertSeverity;
  /** Lifecycle status. */
  status: FridayAlertEventStatus;
  /** Summary text. */
  summary: string;
  /** Source module. */
  module: FridayObservabilityModule;
  /** SLO ID (if SLO-related). */
  sloId?: UUID;
  /** When detected. */
  detectedAt: ISODateTime;
  /** When fired. */
  firedAt?: ISODateTime;
  /** When acknowledged. */
  acknowledgedAt?: ISODateTime;
  /** When resolved. */
  resolvedAt?: ISODateTime;
  /** Number of channels already notified for this alert. */
  notifiedChannelCount: number;
  /** Current escalation tier (0 = initial notification). */
  currentEscalationTier: number;
}

/**
 * Response body for `GET /api/observability/alerts`.
 *
 * @openapi operationId: listAlerts
 */
export interface FridayListAlertsResponse extends FridayObservabilityPage<FridayAlertEventSummary> {}

// ─── Get Alert ───

/**
 * Response body for `GET /api/observability/alerts/:alertId`.
 *
 * Full alert event detail.
 *
 * @openapi operationId: getAlert
 */
export interface FridayGetAlertResponse {
  /** The full alert event. */
  alert: FridayAlertEvent;
  /** The alert rule that triggered this event. */
  rule: FridayAlertRule;
  /** The channels that were notified. */
  notifiedChannels: FridayAlertChannel[];
}

// ─── Acknowledge Alert ───

/**
 * Request body for `POST /api/observability/alerts/:alertId/acknowledge`.
 *
 * @openapi operationId: acknowledgeAlert
 */
export interface FridayAcknowledgeAlertRequest {
  /** Optional acknowledgement note. */
  note?: string;
}

/**
 * Response body for `POST /api/observability/alerts/:alertId/acknowledge`.
 *
 * @openapi operationId: acknowledgeAlert
 */
export interface FridayAcknowledgeAlertResponse {
  /** The updated alert event. */
  alert: FridayAlertEvent;
}

// ═══════════════════════════════════════════════════════════════════════
// ALERT RULE CONFIGURATION API
// ═══════════════════════════════════════════════════════════════════════

// ─── List Alert Rules ───

/**
 * Query parameters for `GET /api/observability/alert-rules`.
 *
 * @openapi operationId: listAlertRules
 */
export interface FridayListAlertRulesQuery extends FridayObservabilityPaginationQuery {
  /** Filter by severity. */
  severity?: FridayAlertSeverity;
  /** Filter by enabled status. */
  enabled?: boolean;
  /** Filter by tag. */
  tag?: string;
  /** Include soft-deleted rules. */
  includeDeleted?: boolean;
}

/**
 * Response body for `GET /api/observability/alert-rules`.
 *
 * @openapi operationId: listAlertRules
 */
export interface FridayListAlertRulesResponse extends FridayObservabilityPage<FridayAlertRule> {}

// ─── Get Alert Rule ───

/**
 * Response body for `GET /api/observability/alert-rules/:ruleId`.
 *
 * @openapi operationId: getAlertRule
 */
export interface FridayGetAlertRuleResponse {
  /** The requested alert rule. */
  rule: FridayAlertRule;
  /** The channels configured for this rule. */
  channels: FridayAlertChannel[];
  /** The escalation tiers configured for this rule. */
  escalationTiers: FridayEscalationTier[];
}

// ─── Create Alert Rule ───

/**
 * Request body for `POST /api/observability/alert-rules`.
 *
 * @openapi operationId: createAlertRule
 */
export interface FridayCreateAlertRuleRequest {
  /** Human-readable name. */
  name: string;
  /** Description. */
  description: string;
  /** Alert severity. */
  severity: FridayAlertSeverity;
  /** Whether the rule is enabled on creation. */
  enabled?: boolean;
  /** The condition that triggers the alert (discriminated union). */
  condition: FridayAlertCondition;
  /**
   * Evaluation interval in seconds.
   * @default 60
   */
  evaluationIntervalSec?: number;
  /** Notification channel IDs. */
  channelIds: UUID[];
  /**
   * Escalation tiers (max 3).
   * Each tier specifies a timeout and channels.
   */
  escalationTiers?: FridayEscalationTier[];
  /**
   * Grouping window in minutes.
   * @default 5
   */
  groupingWindowMin?: number;
  /** Tags. */
  tags?: string[];
}

/**
 * Response body for `POST /api/observability/alert-rules`.
 *
 * @openapi operationId: createAlertRule
 */
export interface FridayCreateAlertRuleResponse {
  /** The created alert rule. */
  rule: FridayAlertRule;
}

// ─── Update Alert Rule ───

/**
 * Request body for `PUT /api/observability/alert-rules/:ruleId`.
 *
 * Uses optimistic concurrency — the `etag` must match the current rule version.
 *
 * @openapi operationId: updateAlertRule
 */
export interface FridayUpdateAlertRuleRequest {
  /** Required optimistic concurrency token. */
  etag: string;
  /** Updated name. */
  name?: string;
  /** Updated description. */
  description?: string;
  /** Updated severity. */
  severity?: FridayAlertSeverity;
  /** Updated enabled status. */
  enabled?: boolean;
  /** Updated condition (discriminated union). */
  condition?: FridayAlertCondition;
  /** Updated evaluation interval in seconds. */
  evaluationIntervalSec?: number;
  /** Updated channel IDs. */
  channelIds?: UUID[];
  /** Updated escalation tiers (max 3). */
  escalationTiers?: FridayEscalationTier[];
  /** Updated grouping window. */
  groupingWindowMin?: number;
  /** Updated tags. */
  tags?: string[];
}

/**
 * Response body for `PUT /api/observability/alert-rules/:ruleId`.
 *
 * @openapi operationId: updateAlertRule
 */
export interface FridayUpdateAlertRuleResponse {
  /** The updated alert rule. */
  rule: FridayAlertRule;
}

// ─── Delete Alert Rule ───

/**
 * Request body for `DELETE /api/observability/alert-rules/:ruleId`.
 *
 * @openapi operationId: deleteAlertRule
 */
export interface FridayDeleteAlertRuleRequest {
  /** Required optimistic concurrency token. */
  etag: string;
}

/**
 * Response body for `DELETE /api/observability/alert-rules/:ruleId`.
 *
 * @openapi operationId: deleteAlertRule
 */
export interface FridayDeleteAlertRuleResponse {
  /** Confirmation of deletion. */
  deleted: true;
  /** ID of the deleted rule. */
  ruleId: UUID;
}
