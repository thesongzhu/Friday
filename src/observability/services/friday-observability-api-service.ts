import * as net from "node:net";
import * as tls from "node:tls";

import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import {
  createFridaySecretRepository,
  decryptSecretWithMigration,
  encryptSecret,
  type FridayEncryptedEnvelope,
  fridaySecretAadContext,
  getStrictMasterKey,
} from "#providers";
import type {
  FridayAcknowledgeAlertRequest,
  FridayAcknowledgeAlertResponse,
  FridayAlertDestinationSummary,
  FridayAlertDispatchAttemptSummary,
  FridayCreateAlertDestinationRequest,
  FridayCreateAlertDestinationResponse,
  FridayCreateAlertRuleRequest,
  FridayCreateAlertRuleResponse,
  FridayDeleteAlertDestinationResponse,
  FridayDeleteAlertRuleRequest,
  FridayDeleteAlertRuleResponse,
  FridayGetAlertResponse,
  FridayGetAlertRuleResponse,
  FridayGetAuditEntryResponse,
  FridayGetObservabilityOverviewResponse,
  FridayGetObservabilityTimeSeriesQuery,
  FridayGetObservabilityTimeSeriesResponse,
  FridayGetSloStatusResponse,
  FridayGetTraceResponse,
  FridayListAlertDestinationsResponse,
  FridayListAlertRulesQuery,
  FridayListAlertRulesResponse,
  FridayListAlertsQuery,
  FridayListAlertsResponse,
  FridayListSlosQuery,
  FridayListSlosResponse,
  FridayObservabilityBrowserRuntimeSummary,
  FridaySearchAuditEntriesQuery,
  FridaySearchAuditEntriesResponse,
  FridaySearchTracesQuery,
  FridaySearchTracesResponse,
  FridayTestAlertDispatchRequest,
  FridayTestAlertDispatchResponse,
  FridayTraceSummary,
  FridayUpdateAlertDestinationRequest,
  FridayUpdateAlertDestinationResponse,
  FridayUpdateAlertRuleRequest,
  FridayUpdateAlertRuleResponse,
} from "../api/friday-observability-api.types.js";
import type {
  FridayAlertChannel,
  FridayAlertChannelRow,
  FridayAlertEvent,
  FridayAlertRule,
  FridayAlertSeverity,
  FridayAuditActionCategory,
  FridayAuditActorType,
  FridayAuditEntry,
  FridayAuditResourceType,
  FridayBurnRate,
  FridayErrorBudget,
  FridayObservabilityModule,
  FridaySliMetric,
  FridaySloDefinition,
  FridaySloDefinitionRow,
  JsonObject,
  UUID,
} from "../model/friday-observability.types.js";
import {
  createAlertEvaluationScheduler,
  FridayAlertEngine,
  type FridayAlertEvaluationScheduler,
  FridayAuditTrail,
  FridayDashboardDataProvider,
  FridayHealthCheckManager,
  FridayMetricsCollector,
  FridayTraceManager,
} from "../engine/index.js";
import { createFridayObservabilityAuditRepository } from "../persistence/friday-observability-audit-repository.js";
import type { FridayObservabilityRoutesDeps } from "../../api/http/routes/friday-observability-routes.js";
import type {
  FridayIncidentDiagnosisDetails,
  FridaySelfHealingActionDetails,
} from "../../learning/services/friday-self-healing-api-service.js";
import type { FridayAgentLoopRunDetails } from "../../learning/services/friday-agent-loop-service.js";
import type { FridaySkillGenerationEvidence } from "../../api/model/friday-api-skill-generator.types.js";
import type { FridayWorkflowGenerationEvidence } from "../../api/model/friday-api-workflow.types.js";
import type {
  FridayBeginnerIntentResolution,
  FridayUixTemplateExecutionResponse,
  FridayUixWizardResponse,
} from "../../api/model/friday-api-uix-surface.types.js";

type CounterMetricName =
  | "friday.observability.alert_dispatches.total"
  | "friday.observability.alert_dispatch_failures.total"
  | "friday.learning.failures.total"
  | "friday.learning.incidents.total"
  | "friday.learning.diagnoses.total"
  | "friday.learning.actions.total"
  | "friday.learning.rollbacks.total"
  | "friday.agent_loop.runs.total"
  | "friday.agent_loop.halts.total"
  | "friday.agent_loop.rollbacks.total"
  | "friday.agent_loop.verification_failures.total"
  | "friday.skills.generator.sessions.total"
  | "friday.skills.generator.tests.total"
  | "friday.skills.generator.failures.total"
  | "friday.workflows.generator.sessions.total"
  | "friday.workflows.generator.failures.total"
  | "friday.workflows.deployments.total"
  | "friday.workflows.deploy_failures.total"
  | "friday.workflows.exports.total"
  | "friday.workflows.runs.started.total"
  | "friday.uix.intents.total"
  | "friday.uix.templates.executed.total"
  | "friday.uix.wizards.continued.total";

type HistogramMetricName =
  | "friday.observability.alert_dispatch.duration_ms"
  | "friday.learning.action.duration_ms"
  | "friday.agent_loop.duration_ms"
  | "friday.skills.generator.duration_ms"
  | "friday.workflows.generator.duration_ms"
  | "friday.workflows.deploy.duration_ms"
  | "friday.uix.intent.duration_ms"
  | "friday.uix.template.duration_ms"
  | "friday.uix.wizard.duration_ms";

interface MetricState {
  lastValues: Map<string, number>;
  lastReportedAt: Map<string, string>;
}

type AlertDestinationConfig =
  | {
    type: "slack";
    channel?: string;
    webhookRefKey: string;
  }
  | {
    type: "email";
    recipients: string[];
    fromAddress: string;
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
    username?: string;
    passwordRefKey: string;
  };

interface AlertDestinationEntity {
  id: string;
  name: string;
  type: FridayAlertDestinationSummary["type"];
  enabled: boolean;
  config: AlertDestinationConfig;
  createdAt: string;
  updatedAt: string;
}

interface SloRuntimeRecord {
  id: string;
  name: string;
  description: string;
  sliMetric: FridaySliMetric;
  target: number;
  complianceWindowDays: number;
  enabled: boolean;
  tags: string[];
  alertRuleIds: UUID[];
  etag: string;
  createdAt: string;
  updatedAt: string;
}

interface AlertDispatchAttemptRecord {
  attemptId: string;
  destinationId: string;
  destinationType: FridayAlertDestinationSummary["type"];
  status: "sent" | "failed" | "skipped";
  attemptNumber: number;
  dedupeKey: string;
  errorMessage?: string;
  sentAt?: string;
}

export interface FridayObservedOperationContext {
  traceId: string;
  spanId: string;
}

export interface FridayObservedOperationActor {
  type: FridayAuditActorType;
  id: string;
  displayName: string;
}

export interface FridayObservedOperationInput {
  module: FridayObservabilityModule;
  operationName: string;
  actionCategory: FridayAuditActionCategory;
  action: string;
  resourceType: FridayAuditResourceType;
  resourceId: string;
  resourceDisplayName?: string;
  actor: FridayObservedOperationActor;
  description: string;
  successMetric?: CounterMetricName;
  failureMetric?: CounterMetricName;
  durationMetric?: HistogramMetricName;
  attributes?: Record<string, string | number | boolean>;
  metadata?: Record<string, unknown>;
}

export interface FridayObservabilityApiService {
  readonly routes: FridayObservabilityRoutesDeps;
  readonly traces: FridayTraceManager;
  readonly audit: FridayAuditTrail;
  readonly metrics: FridayMetricsCollector;
  readonly alerts: FridayAlertEngine;
  readonly health: FridayHealthCheckManager;
  readonly dashboard: FridayDashboardDataProvider;
  readonly scheduler: FridayAlertEvaluationScheduler;
  /**
   * Report-only: publish a realtime_events growth reading through the formal
   * observability seam (gauges + metricState + dashboard time-series). Never
   * deletes anything. RESTART-VOLATILE (in-memory).
   */
  recordRealtimeEventsGrowth(reading: FridayRealtimeEventsGrowthReading): void;
  observeAsync<T>(input: FridayObservedOperationInput, work: () => Promise<T>): Promise<T>;
  drainAuditWrites(): Promise<void>;
  shutdown(): Promise<void>;
  recordSelfHealingProcessResults(input: {
    results: Array<{
      incidentsCreated: Array<{
        incidentId: string;
        userId: string;
        category: string;
        severity: string;
        signature: string;
        status: string;
        createdAt: string;
      }>;
      diagnosisCreated: Array<{
        id: string;
        incidentId?: string;
        confidence: number;
        errorFingerprint: string;
        createdAt: string;
      }>;
    }>;
    correlationId?: string;
  }): void;
  recordAutoFixActionEvent(input: {
    event: string;
    details: FridaySelfHealingActionDetails;
    actor: FridayObservedOperationActor;
    description: string;
  }): Promise<void>;
  recordSkillGeneratorEvent(input: {
    sessionId: string;
    userId: string;
    event: "session_started" | "draft_generated" | "draft_tested" | "draft_saved" | "generation_failed";
    summary: string;
    ok?: boolean;
    evidence?: FridaySkillGenerationEvidence | null;
  }): Promise<void>;
  recordWorkflowGeneratorEvent(input: {
    sessionId: string;
    userId: string;
    event:
      | "session_started"
      | "draft_generated"
      | "draft_saved"
      | "generation_failed"
      | "approve_blocked"
      | "verdict_ready"
      | "handoff_written";
    summary: string;
    ok?: boolean;
    evidence?: FridayWorkflowGenerationEvidence | null;
  }): Promise<void>;
  recordAssistantEvent(input: {
    userId: string;
    event: "intent_resolved" | "template_executed" | "wizard_started" | "wizard_continued";
    summary: string;
    intent?: FridayBeginnerIntentResolution;
    result?: FridayUixTemplateExecutionResponse | FridayUixWizardResponse;
  }): Promise<void>;
  recordAgentLoopEvent(input: {
    event: string;
    run: {
      loopRunId: string;
      incidentId: string;
      actionId?: string;
      status: string;
      haltReason?: string;
      attemptNumber: number;
      rollbackAttempted: boolean;
      rollbackSucceeded: boolean;
    };
    details: FridayAgentLoopRunDetails;
  }): Promise<void>;
}

export interface CreateFridayObservabilityApiServiceDeps {
  db?: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
  browserDiagnosticsProvider?: () => FridayObservabilityBrowserRuntimeSummary | undefined;
  heartbeatStateGetter?: () => { lastRunAt: string | null; result: string; intervalMs: number | null; nextRunAt: string | null } | null;
  heartbeatTrigger?: () => unknown | Promise<unknown>;
  /**
   * Per-attempt timeout (ms) for outbound Slack alert-webhook dispatch.
   *
   * B2 hanging-fetch boundary: without this, `deliverToDestination` could hang
   * indefinitely against an unresponsive Slack endpoint, blocking the per-
   * dedupeKey retry loop forever. Default 10s matches the project convention
   * for short-lived webhook calls (see `src/studio/friday-studio-service.ts`
   * and `src/providers/oauth/friday-anthropic-oauth.ts`).
   */
  webhookTimeoutMs?: number;
  /**
   * Per-attempt timeout (ms) for outbound SMTP alert-email dispatch.
   *
   * B2 hanging-fetch boundary (sibling to webhookTimeoutMs): without this,
   * `sendSmtpMail` could hang indefinitely against an unresponsive SMTP
   * endpoint — either during TCP/TLS connect or while waiting for any
   * `readResponse` between commands. Default 10s matches the webhook timeout.
   */
  smtpTimeoutMs?: number;
}

/** Default per-attempt timeout for the slack-webhook fetch. */
const FRIDAY_DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;

/** Default per-attempt timeout for SMTP socket operations. */
const FRIDAY_DEFAULT_SMTP_TIMEOUT_MS = 10_000;

export const FRIDAY_BUILT_IN_SELF_HEALING_ALERT_RULE_ID = "builtin-self-healing-repeat-failures";
const BUILT_IN_ALERT_DISPATCH_FAILURE_RULE_ID = "builtin-alert-dispatch-failures";
const ALERT_DESTINATION_CREDENTIAL_SCOPE = "observability.alert_destination";

const COUNTER_METRICS: Array<{ name: CounterMetricName; module: FridayObservabilityModule }> = [
  { name: "friday.observability.alert_dispatches.total", module: "observability" },
  { name: "friday.observability.alert_dispatch_failures.total", module: "observability" },
  { name: "friday.learning.failures.total", module: "learning" },
  { name: "friday.learning.incidents.total", module: "learning" },
  { name: "friday.learning.diagnoses.total", module: "learning" },
  { name: "friday.learning.actions.total", module: "learning" },
  { name: "friday.learning.rollbacks.total", module: "learning" },
  { name: "friday.agent_loop.runs.total", module: "learning" },
  { name: "friday.agent_loop.halts.total", module: "learning" },
  { name: "friday.agent_loop.rollbacks.total", module: "learning" },
  { name: "friday.agent_loop.verification_failures.total", module: "learning" },
  { name: "friday.skills.generator.sessions.total", module: "skills" },
  { name: "friday.skills.generator.tests.total", module: "skills" },
  { name: "friday.skills.generator.failures.total", module: "skills" },
  { name: "friday.workflows.generator.sessions.total", module: "workflows" },
  { name: "friday.workflows.generator.failures.total", module: "workflows" },
  { name: "friday.workflows.deployments.total", module: "workflows" },
  { name: "friday.workflows.deploy_failures.total", module: "workflows" },
  { name: "friday.workflows.exports.total", module: "workflows" },
  { name: "friday.workflows.runs.started.total", module: "workflows" },
  { name: "friday.uix.intents.total", module: "uix" },
  { name: "friday.uix.templates.executed.total", module: "uix" },
  { name: "friday.uix.wizards.continued.total", module: "uix" },
];

const HISTOGRAM_METRICS: Array<{ name: HistogramMetricName; module: FridayObservabilityModule }> = [
  { name: "friday.observability.alert_dispatch.duration_ms", module: "observability" },
  { name: "friday.learning.action.duration_ms", module: "learning" },
  { name: "friday.agent_loop.duration_ms", module: "learning" },
  { name: "friday.skills.generator.duration_ms", module: "skills" },
  { name: "friday.workflows.generator.duration_ms", module: "workflows" },
  { name: "friday.workflows.deploy.duration_ms", module: "workflows" },
  { name: "friday.uix.intent.duration_ms", module: "uix" },
  { name: "friday.uix.template.duration_ms", module: "uix" },
  { name: "friday.uix.wizard.duration_ms", module: "uix" },
];

// ─── realtime_events growth gauges (report-only; DATA-RETENTION-001) ───
//
// Report-only growth telemetry for the append-only, DERIVED realtime_events
// replay stream. These gauges are registered and reported through the SAME
// formal seam the counters/histograms use (metrics collector + metricState +
// dashboard.recordDataPoint), so the signal is authoritatively readable off the
// real `/v1/observability/metrics` and `/v1/observability/time-series` routes
// and by the alert engine's metric provider. RESTART-VOLATILE: like every other
// metric in this in-memory collector, the values and the time-series history do
// NOT survive a Hub restart — no deletion is ever performed here.

/** Gauge: approximate realtime_events row count (O(1) MAX(rowid) proxy). */
export const REALTIME_EVENTS_ROWS_GAUGE = "friday.realtime_events.rows_estimate";
/** Gauge: estimated realtime_events payload size in true UTF-8 bytes. */
export const REALTIME_EVENTS_BYTES_GAUGE = "friday.realtime_events.bytes_estimate";
/**
 * Gauge: the mutable growth status encoded as a numeric VALUE (not a label).
 * A label-encoded status would leave an uncleanable stale gauge variant per
 * transition; a single unlabeled gauge whose value is the status code updates in
 * place, so the API always reflects exactly the CURRENT status.
 */
export const REALTIME_EVENTS_STATUS_CODE_GAUGE = "friday.realtime_events.growth_status_code";

/** Numeric encoding for the report-only growth status (rides as a gauge value). */
export const REALTIME_EVENTS_GROWTH_STATUS_CODE: Readonly<Record<string, number>> = {
  healthy: 0,
  warn: 1,
  critical: 2,
  degraded: 3,
};

const GAUGE_METRICS: Array<{ name: string; module: FridayObservabilityModule }> = [
  { name: REALTIME_EVENTS_ROWS_GAUGE, module: "learning" },
  { name: REALTIME_EVENTS_BYTES_GAUGE, module: "learning" },
  { name: REALTIME_EVENTS_STATUS_CODE_GAUGE, module: "learning" },
];

/**
 * Structural, report-only growth reading accepted by
 * `recordRealtimeEventsGrowth`. Deliberately decoupled from the learning-layer
 * `FridaySystemHealthGrowthDetail` (which is structurally assignable to it) so
 * the observability service never imports the health monitor.
 */
export interface FridayRealtimeEventsGrowthReading {
  status: string;
  rowCount: number;
  estimatedBytes: number;
  sampleSize: number;
  reclaim_status: string;
  failClosed?: boolean;
}

/** The last-observed growth snapshot returned off the metrics route (current, restart-volatile). */
export interface FridayRealtimeEventsGrowthSnapshot {
  rowCount: number;
  estimatedBytes: number;
  status: string;
  statusCode: number;
  reclaim_status: string;
  sampleSize: number;
  failClosed: boolean;
  reportedAt: string;
  /**
   * Honesty marker: this snapshot and its time-series history live only in the
   * in-memory collector. A durable, cross-restart growth trend is PENDING.
   */
  durability: "restart_volatile";
}

function buildDefaultAlertRule(nowIso: string): FridayAlertRule {
  return {
    id: FRIDAY_BUILT_IN_SELF_HEALING_ALERT_RULE_ID,
    name: "Repeated self-healing failures",
    description: "Escalate when self-healing keeps opening incidents without recovering the system.",
    severity: "critical",
    enabled: true,
    condition: {
      type: "threshold",
      metricName: "friday.learning.failures.total",
      threshold: 3,
      operator: "gte",
    },
    evaluationIntervalSec: 30,
    channelIds: [],
    escalationTiers: [],
    groupingWindowMin: 0,
    tags: ["self-healing", "built-in"],
    etag: "builtin-self-healing-repeat-failures-v1",
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

function buildDefaultAlertDispatchFailureRule(nowIso: string): FridayAlertRule {
  return {
    id: BUILT_IN_ALERT_DISPATCH_FAILURE_RULE_ID,
    name: "Repeated alert dispatch failures",
    description: "Escalate when alert delivery keeps failing and operator attention is required.",
    severity: "warning",
    enabled: true,
    condition: {
      type: "threshold",
      metricName: "friday.observability.alert_dispatch_failures.total",
      threshold: 3,
      operator: "gte",
    },
    evaluationIntervalSec: 30,
    channelIds: [],
    escalationTiers: [],
    groupingWindowMin: 0,
    tags: ["observability", "dispatch", "built-in"],
    etag: "builtin-alert-dispatch-failures-v1",
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

function buildDefaultSloPack(nowIso: string): SloRuntimeRecord[] {
  return [
    {
      id: "slo-api-availability",
      name: "API availability",
      description: "Tracks whether API request handling stays above the target success band.",
      sliMetric: {
        name: "friday.api.requests.availability",
        displayName: "API request availability",
        description: "Success ratio derived from API traces.",
        type: "availability",
        unit: "percent",
        module: "api",
      },
      target: 99.5,
      complianceWindowDays: 30,
      enabled: true,
      tags: ["default", "api"],
      alertRuleIds: [],
      etag: "slo-api-availability-v1",
      createdAt: nowIso,
      updatedAt: nowIso,
    },
    {
      id: "slo-agent-run-success",
      name: "Agent run success",
      description: "Tracks successful agent executions based on agent traces.",
      sliMetric: {
        name: "friday.agent.runs.success_rate",
        displayName: "Agent run success rate",
        description: "Success ratio derived from agent traces.",
        type: "success_rate",
        unit: "percent",
        module: "learning",
      },
      target: 97,
      complianceWindowDays: 14,
      enabled: true,
      tags: ["default", "agent"],
      alertRuleIds: [],
      etag: "slo-agent-run-success-v1",
      createdAt: nowIso,
      updatedAt: nowIso,
    },
    {
      id: "slo-workflow-deploy-success",
      name: "Workflow deploy success",
      description: "Tracks the success ratio for workflow deploy attempts.",
      sliMetric: {
        name: "friday.workflows.deploy.success_rate",
        displayName: "Workflow deploy success rate",
        description: "Success ratio derived from deploy totals and failures.",
        type: "success_rate",
        unit: "percent",
        module: "workflows",
      },
      target: 98,
      complianceWindowDays: 14,
      enabled: true,
      tags: ["default", "workflow"],
      alertRuleIds: [],
      etag: "slo-workflow-deploy-success-v1",
      createdAt: nowIso,
      updatedAt: nowIso,
    },
    {
      id: "slo-self-healing-acceptance",
      name: "Self-healing acceptance",
      description: "Tracks verified autonomous/self-healing loop executions after acceptance checks.",
      sliMetric: {
        name: "friday.agent_loop.acceptance.success_rate",
        displayName: "Self-healing acceptance success rate",
        description: "Success ratio derived from agent loop runs and verification failures.",
        type: "success_rate",
        unit: "percent",
        module: "learning",
      },
      target: 95,
      complianceWindowDays: 14,
      enabled: true,
      tags: ["default", "self-healing"],
      alertRuleIds: [],
      etag: "slo-self-healing-acceptance-v1",
      createdAt: nowIso,
      updatedAt: nowIso,
    },
    {
      id: "slo-system-runtime-health",
      name: "System runtime health",
      description: "Tracks healthy system/runtime health checks as an availability SLO.",
      sliMetric: {
        name: "friday.system.runtime.health",
        displayName: "System runtime health",
        description: "Derived from registered health checks.",
        type: "availability",
        unit: "percent",
        module: "desktop",
      },
      target: 99,
      complianceWindowDays: 30,
      enabled: true,
      tags: ["default", "system"],
      alertRuleIds: [],
      etag: "slo-system-runtime-health-v1",
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  ];
}

function toAlertDestinationSummary(destination: AlertDestinationEntity): FridayAlertDestinationSummary {
  if (destination.config.type === "slack") {
    return {
      id: destination.id,
      name: destination.name,
      type: "slack",
      enabled: destination.enabled,
      channel: destination.config.channel,
      webhookConfigured: true,
      createdAt: destination.createdAt,
      updatedAt: destination.updatedAt,
    };
  }
  return {
    id: destination.id,
    name: destination.name,
    type: "email",
    enabled: destination.enabled,
    recipients: destination.config.recipients,
    fromAddress: destination.config.fromAddress,
    smtpHost: destination.config.smtpHost,
    smtpPort: destination.config.smtpPort,
    smtpSecure: destination.config.smtpSecure,
    username: destination.config.username,
    passwordConfigured: true,
    createdAt: destination.createdAt,
    updatedAt: destination.updatedAt,
  };
}

function toAlertChannelResponse(destination: AlertDestinationEntity): FridayAlertChannel {
  if (destination.config.type === "slack") {
    return {
      id: destination.id,
      name: destination.name,
      type: "slack",
      enabled: destination.enabled,
      channel: destination.config.channel,
      webhookUrl: `secret://${ALERT_DESTINATION_CREDENTIAL_SCOPE}/${destination.config.webhookRefKey}`,
      createdAt: destination.createdAt,
      updatedAt: destination.updatedAt,
    };
  }
  return {
    id: destination.id,
    name: destination.name,
    type: "email",
    recipients: destination.config.recipients,
    enabled: destination.enabled,
    createdAt: destination.createdAt,
    updatedAt: destination.updatedAt,
  };
}

function toJsonObject(
  value: Record<string, unknown> | undefined,
): JsonObject | undefined {
  if (!value) {
    return undefined;
  }
  return value as JsonObject;
}

function decodeCursor(cursor?: string): number {
  if (!cursor) {
    return 0;
  }
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function encodeCursor(value: number | null): string | undefined {
  if (value === null) {
    return undefined;
  }
  return String(value);
}

function paginate<T>(
  items: readonly T[],
  query: { limit?: number; cursor?: string },
): { items: T[]; nextCursor?: string } {
  const offset = decodeCursor(query.cursor);
  const limit = Math.max(1, Math.min(100, query.limit ?? 25));
  const page = items.slice(offset, offset + limit);
  const nextCursor = offset + limit < items.length ? encodeCursor(offset + limit) : undefined;
  return { items: [...page], nextCursor };
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function traceAttribute(trace: { attributes: Record<string, unknown> }, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = trace.attributes[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function metricValueFromSnapshots(snapshots: ReturnType<FridayMetricsCollector["getAllSnapshots"]>): number {
  return snapshots.reduce((sum, snapshot) => {
    if (snapshot.type === "counter" || snapshot.type === "gauge") {
      return sum + snapshot.value;
    }
    return sum + snapshot.count;
  }, 0);
}

function parseStoredJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    console.warn("[friday][observability-api-service] JSON parse failed:", err instanceof Error ? err.message : String(err));
    return fallback;
  }
}

function escapeSmtpBody(value: string): string {
  return value.replace(/\r?\n/g, "\r\n").replace(/\r\n\./g, "\r\n..");
}

async function sendSmtpMail(input: {
  host: string;
  port: number;
  secure: boolean;
  username?: string;
  password?: string;
  fromAddress: string;
  recipients: string[];
  subject: string;
  body: string;
  /** Hard inactivity / connect deadline. Each read or connect attempt must
   *  complete within this many milliseconds, or the socket is destroyed and
   *  the operation rejects with a clear timeout error. */
  timeoutMs: number;
}): Promise<void> {
  const socket = await new Promise<net.Socket | tls.TLSSocket>((resolve, reject) => {
    let settled = false;
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      reject(error);
    };
    const connectTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`SMTP connection to ${input.host}:${input.port} timed out after ${input.timeoutMs}ms`));
    }, input.timeoutMs);
    if (input.secure) {
      const connection = tls.connect(
        {
          host: input.host,
          port: input.port,
          servername: input.host,
        },
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(connectTimer);
          resolve(connection);
        },
      );
      connection.once("error", onError);
      return;
    }
    const connection = net.connect({ host: input.host, port: input.port }, () => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      resolve(connection);
    });
    connection.once("error", onError);
  });

  // B2 hanging-fetch boundary: per-operation inactivity timeout. If any
  // subsequent readResponse waits longer than `timeoutMs` for the next byte,
  // node emits 'timeout'; destroy the socket so the pending readResponse
  // rejects via its 'error' listener with a clear timeout message.
  socket.setTimeout(input.timeoutMs);
  socket.on("timeout", () => {
    socket.destroy(new Error(`SMTP server at ${input.host}:${input.port} inactive for ${input.timeoutMs}ms`));
  });

  let buffer = "";

  async function readResponse(expectedPrefix: string): Promise<string[]> {
    return await new Promise<string[]>((resolve, reject) => {
      const onData = (chunk: Buffer | string) => {
        buffer += chunk.toString();
        if (!buffer.includes("\r\n")) {
          return;
        }
        const lines = buffer.split("\r\n").filter((line) => line.length > 0);
        if (lines.length === 0) {
          return;
        }
        const last = lines[lines.length - 1]!;
        if (!/^\d{3} /.test(last)) {
          return;
        }
        buffer = "";
        cleanup();
        if (!last.startsWith(expectedPrefix)) {
          reject(new Error(`SMTP expected ${expectedPrefix}, received ${last}`));
          return;
        }
        resolve(lines);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        socket.off("data", onData);
        socket.off("error", onError);
      };
      socket.on("data", onData);
      socket.on("error", onError);
    });
  }

  async function sendCommand(command: string, expectedPrefix: string): Promise<string[]> {
    socket.write(`${command}\r\n`);
    return readResponse(expectedPrefix);
  }

  try {
    await readResponse("220");
    await sendCommand("EHLO friday.local", "250");
    if (input.username && input.password) {
      const payload = Buffer.from(`\u0000${input.username}\u0000${input.password}`, "utf8").toString("base64");
      await sendCommand(`AUTH PLAIN ${payload}`, "235");
    }
    await sendCommand(`MAIL FROM:<${input.fromAddress}>`, "250");
    for (const recipient of input.recipients) {
      await sendCommand(`RCPT TO:<${recipient}>`, "250");
    }
    await sendCommand("DATA", "354");
    socket.write([
      `From: ${input.fromAddress}`,
      `To: ${input.recipients.join(", ")}`,
      `Subject: ${input.subject}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      escapeSmtpBody(input.body),
      ".",
      "",
    ].join("\r\n"));
    await readResponse("250");
    await sendCommand("QUIT", "221");
  } finally {
    socket.destroy();
  }
}

export function createFridayObservabilityApiService(
  deps: CreateFridayObservabilityApiServiceDeps,
): FridayObservabilityApiService {
  const traces = new FridayTraceManager();
  const auditStore = deps.db
    ? createFridayObservabilityAuditRepository({ db: deps.db })
    : undefined;
  const audit = new FridayAuditTrail({ store: auditStore });
  const metrics = new FridayMetricsCollector();
  const alerts = new FridayAlertEngine();
  const health = new FridayHealthCheckManager();
  const dashboard = new FridayDashboardDataProvider({
    metrics,
    traces,
    audit,
    alerts,
    health,
  });
  const metricState: MetricState = {
    lastValues: new Map(),
    lastReportedAt: new Map(),
  };
  const secretRepo = createFridaySecretRepository();
  const inMemoryAlertDestinations = new Map<string, AlertDestinationEntity>();
  const inMemorySloDefinitions = new Map<string, SloRuntimeRecord>();
  const inMemorySecrets = new Map<string, string>();
  const dispatchHistoryByKey = new Map<string, AlertDispatchAttemptRecord>();
  const resolvedAlertIds = new Set<string>();
  const observedAgentLoopRunIds = new Set<string>();
  const pendingAuditWrites = new Set<Promise<void>>();
  const backgroundAuditFailures: unknown[] = [];

  for (const metric of COUNTER_METRICS) {
    metrics.registerCounter(metric.name, metric.module);
  }
  for (const metric of HISTOGRAM_METRICS) {
    metrics.registerHistogram(metric.name, metric.module);
  }
  for (const metric of GAUGE_METRICS) {
    metrics.registerGauge(metric.name, metric.module);
  }

  // Latest report-only realtime_events growth snapshot (restart-volatile; the
  // metrics route returns it so status/reclaim_status strings are readable).
  let lastRealtimeEventsGrowth: FridayRealtimeEventsGrowthSnapshot | null = null;

  function parseAlertDestinationRow(row: FridayAlertChannelRow): AlertDestinationEntity {
    const config: AlertDestinationConfig = row.type === "email"
      ? {
        type: "email",
        recipients: [],
        fromAddress: "alerts@friday.dev",
        smtpHost: "localhost",
        smtpPort: 25,
        smtpSecure: false,
        passwordRefKey: `${row.id}:smtp-password`,
      }
      : {
        type: "slack",
        webhookRefKey: `${row.id}:slack-webhook`,
      };
    return {
      id: row.id,
      name: row.name,
      type: row.type as AlertDestinationEntity["type"],
      enabled: row.enabled === 1,
      config: parseStoredJson<AlertDestinationConfig>(row.config_json, config),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function listAlertDestinations(): AlertDestinationEntity[] {
    if (!deps.db) {
      return [...inMemoryAlertDestinations.values()].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
    }
    try {
      return deps.db.withReadConnection((db) =>
        (
          db.prepare(
            `SELECT * FROM obs_alert_channels
             ORDER BY updated_at DESC, id DESC`,
          ).all() as FridayAlertChannelRow[]
        ).map(parseAlertDestinationRow),
      );
    } catch (err) {
      console.warn("[friday][observability-api-service] alert destinations list failed:", err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  function getAlertDestination(destinationId: string): AlertDestinationEntity | null {
    if (!deps.db) {
      return inMemoryAlertDestinations.get(destinationId) ?? null;
    }
    try {
      return deps.db.withReadConnection((db) => {
        const row = db
          .prepare("SELECT * FROM obs_alert_channels WHERE id = ?")
          .get(destinationId) as FridayAlertChannelRow | undefined;
        return row ? parseAlertDestinationRow(row) : null;
      });
    } catch (err) {
      console.warn("[friday][observability-api-service] alert destination get failed:", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  function storeAlertDestination(destination: AlertDestinationEntity): void {
    if (!deps.db) {
      inMemoryAlertDestinations.set(destination.id, destination);
      return;
    }
    deps.db.withWriteTransaction((db) => {
      db.prepare(
        `INSERT INTO obs_alert_channels (id, name, type, enabled, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           type = excluded.type,
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`,
      ).run(
        destination.id,
        destination.name,
        destination.type,
        destination.enabled ? 1 : 0,
        JSON.stringify(destination.config),
        destination.createdAt,
        destination.updatedAt,
      );
    });
  }

  function deleteAlertDestination(destinationId: string): boolean {
    const existing = getAlertDestination(destinationId);
    if (!existing) {
      return false;
    }
    if (existing.config.type === "slack") {
      deleteStoredSecret(existing.config.webhookRefKey);
    } else {
      deleteStoredSecret(existing.config.passwordRefKey);
    }
    if (!deps.db) {
      return inMemoryAlertDestinations.delete(destinationId);
    }
    return deps.db.withWriteTransaction((db) => {
      const result = db.prepare("DELETE FROM obs_alert_channels WHERE id = ?").run(destinationId);
      return result.changes > 0;
    });
  }

  function parseSloDefinitionRow(row: FridaySloDefinitionRow): SloRuntimeRecord {
    const metric = parseStoredJson<FridaySliMetric>(row.sli_metric_json, {
      name: "unknown",
      displayName: "Unknown",
      description: "",
      type: "availability",
      unit: "percent",
      module: "observability",
    });
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      sliMetric: metric,
      target: row.target,
      complianceWindowDays: row.compliance_window_days,
      enabled: row.enabled === 1,
      tags: parseStoredJson<string[]>(row.tags_json, []),
      alertRuleIds: parseStoredJson<UUID[]>(row.alert_rule_ids_json, []),
      etag: row.etag,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function listSloRecords(): SloRuntimeRecord[] {
    if (!deps.db) {
      return [...inMemorySloDefinitions.values()].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
    }
    try {
      return deps.db.withReadConnection((db) =>
        (
          db.prepare(
            `SELECT * FROM obs_slo_definitions
             ORDER BY updated_at DESC, id DESC`,
          ).all() as FridaySloDefinitionRow[]
        ).map(parseSloDefinitionRow),
      );
    } catch (err) {
      console.warn("[friday][observability-api-service] SLO definitions list failed:", err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  function getSloRecord(sloId: string): SloRuntimeRecord | null {
    if (!deps.db) {
      return inMemorySloDefinitions.get(sloId) ?? null;
    }
    try {
      return deps.db.withReadConnection((db) => {
        const row = db
          .prepare("SELECT * FROM obs_slo_definitions WHERE id = ?")
          .get(sloId) as FridaySloDefinitionRow | undefined;
        return row ? parseSloDefinitionRow(row) : null;
      });
    } catch (err) {
      console.warn("[friday][observability-api-service] SLO record get failed:", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  function storeSloRecord(record: SloRuntimeRecord): void {
    if (!deps.db) {
      inMemorySloDefinitions.set(record.id, record);
      return;
    }
    deps.db.withWriteTransaction((db) => {
      db.prepare(
        `INSERT INTO obs_slo_definitions (
           id, name, description, sli_metric_json, target, compliance_window_days,
           status, enabled, tags_json, alert_rule_ids_json, error_budget_json, burn_rates_json,
           etag, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           sli_metric_json = excluded.sli_metric_json,
           target = excluded.target,
           compliance_window_days = excluded.compliance_window_days,
           status = excluded.status,
           enabled = excluded.enabled,
           tags_json = excluded.tags_json,
           alert_rule_ids_json = excluded.alert_rule_ids_json,
           etag = excluded.etag,
           updated_at = excluded.updated_at`,
      ).run(
        record.id,
        record.name,
        record.description,
        JSON.stringify(record.sliMetric),
        record.target,
        record.complianceWindowDays,
        "healthy",
        record.enabled ? 1 : 0,
        JSON.stringify(record.tags),
        JSON.stringify(record.alertRuleIds),
        null,
        "[]",
        record.etag,
        record.createdAt,
        record.updatedAt,
      );
    });
  }

  function ensureDefaultSloPack(): void {
    const existingIds = new Set(listSloRecords().map((record) => record.id));
    for (const record of buildDefaultSloPack(deps.nowIso())) {
      if (!existingIds.has(record.id)) {
        storeSloRecord(record);
      }
    }
  }

  function readStoredSecret(refKey: string): string | null {
    if (!deps.db) {
      return inMemorySecrets.get(refKey) ?? null;
    }
    const secret = deps.db.withReadConnection((db) =>
      secretRepo.getByRef(db, ALERT_DESTINATION_CREDENTIAL_SCOPE, refKey),
    );
    if (!secret) {
      return null;
    }
    const envelope = parseStoredJson<FridayEncryptedEnvelope | null>(
      secret.encryptedValue,
      null,
    );
    if (!envelope) {
      return null;
    }
    const { plaintext, rewrapped } = decryptSecretWithMigration(
      envelope,
      getStrictMasterKey(),
      fridaySecretAadContext(secret),
    );
    if (rewrapped) {
      // Read-repair (SEC-SECRET-AAD-001): persist the v2 re-wrap; best-effort.
      try {
        const now = deps.nowIso();
        deps.db.withWriteTransaction((db) => {
          secretRepo.updateById(db, {
            secretId: secret.id,
            encryptedValue: JSON.stringify(rewrapped),
            keyId: "master-v1",
            nowIso: now,
          });
        });
      } catch {
        // Non-fatal: the read already succeeded.
      }
    }
    return plaintext;
  }

  function storeSecret(refKey: string, value: string): void {
    if (!deps.db) {
      inMemorySecrets.set(refKey, value);
      return;
    }
    const now = deps.nowIso();
    const secretId = `${refKey}-secret`;
    deps.db.withWriteTransaction((db) => {
      secretRepo.upsert(db, {
        id: secretId,
        scope: ALERT_DESTINATION_CREDENTIAL_SCOPE,
        refKey,
        encryptedValue: JSON.stringify(
          encryptSecret(
            value,
            getStrictMasterKey(),
            fridaySecretAadContext({ scope: ALERT_DESTINATION_CREDENTIAL_SCOPE, id: secretId }),
          ),
        ),
        keyId: "master-v1",
        nowIso: now,
      });
    });
  }

  function deleteStoredSecret(refKey: string): void {
    if (!deps.db) {
      inMemorySecrets.delete(refKey);
      return;
    }
    deps.db.withWriteTransaction((db) => {
      secretRepo.deleteByRef(db, ALERT_DESTINATION_CREDENTIAL_SCOPE, refKey);
    });
  }

  ensureDefaultSloPack();

  function toAlertChannelResponse(destination: AlertDestinationEntity): FridayAlertChannel {
    if (destination.config.type === "slack") {
      return {
        id: destination.id,
        name: destination.name,
        type: "slack",
        enabled: destination.enabled,
        createdAt: destination.createdAt,
        updatedAt: destination.updatedAt,
        webhookUrl: REDACTED_SECRET,
        channel: destination.config.channel,
      };
    }

    return {
      id: destination.id,
      name: destination.name,
      type: "email",
      enabled: destination.enabled,
      createdAt: destination.createdAt,
      updatedAt: destination.updatedAt,
      recipients: destination.config.recipients,
    };
  }

  function listConfiguredChannels(channelIds: readonly UUID[]): FridayAlertChannel[] {
    return channelIds
      .map((channelId) => getAlertDestination(channelId))
      .filter((channel): channel is AlertDestinationEntity => channel !== null)
      .map(toAlertChannelResponse);
  }

  function ensureAlertChannelsExist(channelIds: readonly UUID[]): void {
    for (const channelId of channelIds) {
      if (!getAlertDestination(channelId)) {
        throw new FridayDomainError(
          "OBS_ALERT_CHANNEL_NOT_FOUND",
          `Alert channel ${channelId} was not found`,
          { httpStatus: 400 },
        );
      }
    }
  }

  function validateAlertDestinationRequest(
    input: FridayCreateAlertDestinationRequest | FridayUpdateAlertDestinationRequest,
    existing?: AlertDestinationEntity,
  ): AlertDestinationEntity {
    const now = deps.nowIso();
    const resolvedType = input.type ?? existing?.type;
    if (resolvedType !== "slack" && resolvedType !== "email") {
      throw new FridayDomainError(
        "OBS_ALERT_CHANNEL_VALIDATION_FAILED",
        "type must be either slack or email",
        { httpStatus: 400 },
      );
    }

    if (resolvedType === "slack") {
      const slackInput = input as Extract<FridayCreateAlertDestinationRequest | FridayUpdateAlertDestinationRequest, { type?: "slack" }>;
      const channel = slackInput.channel === null ? undefined : slackInput.channel ?? (existing?.config.type === "slack" ? existing.config.channel : undefined);
      const webhookRefKey = existing?.config.type === "slack" ? existing.config.webhookRefKey : `${deps.idGenerator()}:slack-webhook`;
      const name = slackInput.name ?? existing?.name;
      if (!name) {
        throw new FridayDomainError("OBS_ALERT_CHANNEL_VALIDATION_FAILED", "name is required", {
          httpStatus: 400,
        });
      }
      if (!existing && !slackInput.webhookUrl) {
        throw new FridayDomainError(
          "OBS_ALERT_CHANNEL_VALIDATION_FAILED",
          "webhookUrl is required for slack destinations",
          { httpStatus: 400 },
        );
      }
      return {
        id: existing?.id ?? deps.idGenerator(),
        name,
        type: "slack",
        enabled: slackInput.enabled ?? existing?.enabled ?? true,
        config: {
          type: "slack",
          channel,
          webhookRefKey,
        },
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
    }

    const emailInput = input as Extract<FridayCreateAlertDestinationRequest | FridayUpdateAlertDestinationRequest, { type?: "email" }>;
    const name = emailInput.name ?? existing?.name;
    if (!name) {
      throw new FridayDomainError("OBS_ALERT_CHANNEL_VALIDATION_FAILED", "name is required", {
        httpStatus: 400,
      });
    }
    const recipients = emailInput.recipients ?? (existing?.config.type === "email" ? existing.config.recipients : undefined);
    if (!recipients || recipients.length === 0) {
      throw new FridayDomainError(
        "OBS_ALERT_CHANNEL_VALIDATION_FAILED",
        "recipients must include at least one email address",
        { httpStatus: 400 },
      );
    }
    const fromAddress = emailInput.fromAddress ?? (existing?.config.type === "email" ? existing.config.fromAddress : undefined);
    const smtpHost = emailInput.smtpHost ?? (existing?.config.type === "email" ? existing.config.smtpHost : undefined);
    const smtpPort = emailInput.smtpPort ?? (existing?.config.type === "email" ? existing.config.smtpPort : undefined);
    if (!fromAddress || !smtpHost || !smtpPort) {
      throw new FridayDomainError(
        "OBS_ALERT_CHANNEL_VALIDATION_FAILED",
        "fromAddress, smtpHost, and smtpPort are required for email destinations",
        { httpStatus: 400 },
      );
    }
    return {
      id: existing?.id ?? deps.idGenerator(),
      name,
      type: "email",
      enabled: emailInput.enabled ?? existing?.enabled ?? true,
      config: {
        type: "email",
        recipients,
        fromAddress,
        smtpHost,
        smtpPort,
        smtpSecure: emailInput.smtpSecure ?? (existing?.config.type === "email" ? existing.config.smtpSecure : false),
        username: emailInput.username === null
          ? undefined
          : (emailInput.username ?? (existing?.config.type === "email" ? existing.config.username : undefined)),
        passwordRefKey: existing?.config.type === "email" ? existing.config.passwordRefKey : `${deps.idGenerator()}:smtp-password`,
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  alerts.setMetricProvider({
    getMetricValue(metricName) {
      return metricState.lastValues.get(metricName) ?? null;
    },
    getMetricLastReportedAt(metricName) {
      return metricState.lastReportedAt.get(metricName) ?? null;
    },
  });
  alerts.addRule(buildDefaultAlertRule(deps.nowIso()));
  alerts.addRule(buildDefaultAlertDispatchFailureRule(deps.nowIso()));

  const scheduler = createAlertEvaluationScheduler({
    alertEngine: alerts,
    nowIso: deps.nowIso,
  });
  const REDACTED_SECRET = "********";

  async function appendAudit(input: {
    actor: FridayObservedOperationActor;
    actionCategory: FridayAuditActionCategory;
    action: string;
    resourceType: FridayAuditResourceType;
    resourceId: string;
    resourceDisplayName?: string;
    module: FridayObservabilityModule;
    outcome: "success" | "failure" | "denied";
    description: string;
    traceId?: string;
    spanId?: string;
    metadata?: JsonObject;
    errorMessage?: string;
  }): Promise<string> {
    try {
      const entry = await audit.append({
        actor: {
          type: input.actor.type,
          id: input.actor.id,
          displayName: input.actor.displayName,
        },
        actionCategory: input.actionCategory,
        action: input.action,
        resource: {
          type: input.resourceType,
          id: input.resourceId,
          displayName: input.resourceDisplayName,
        },
        outcome: input.outcome,
        description: input.description,
        module: input.module,
        traceId: input.traceId,
        spanId: input.spanId,
        errorMessage: input.errorMessage,
        metadata: input.metadata,
      });
      return entry.id;
    } catch (error) {
      console.warn("[friday] observability audit append failed", error);
      throw new FridayDomainError(
        "OBS_AUDIT_APPEND_FAILED",
        "Observability audit append failed; refusing to complete audited operation",
        { httpStatus: 503, cause: error },
      );
    }
  }

  function enqueueBackgroundAudit(input: Parameters<typeof appendAudit>[0]): void {
    const pending = appendAudit(input)
      .then(() => undefined)
      .catch((error: unknown) => {
        backgroundAuditFailures.push(error);
      })
      .finally(() => {
        pendingAuditWrites.delete(pending);
      });
    pendingAuditWrites.add(pending);
  }

  async function drainAuditWrites(): Promise<void> {
    while (pendingAuditWrites.size > 0) {
      await Promise.allSettled([...pendingAuditWrites]);
    }
    if (backgroundAuditFailures.length > 0) {
      const [firstFailure] = backgroundAuditFailures.splice(0, backgroundAuditFailures.length);
      throw new FridayDomainError(
        "OBS_AUDIT_BACKGROUND_APPEND_FAILED",
        "Observability background audit append failed; lifecycle drain refused to hide the failure",
        { httpStatus: 503, cause: firstFailure },
      );
    }
  }

  function incrementCounter(name: CounterMetricName, delta = 1): void {
    metrics.incrementCounter(name, {}, delta);
    const value = metricValueFromSnapshots(metrics.getAllSnapshots(name));
    const timestamp = deps.nowIso();
    metricState.lastValues.set(name, value);
    metricState.lastReportedAt.set(name, timestamp);
    dashboard.recordDataPoint(name, value, timestamp);
  }

  function recordHistogram(name: HistogramMetricName, value: number): void {
    metrics.recordHistogram(name, value, {});
    const timestamp = deps.nowIso();
    metricState.lastValues.set(name, value);
    metricState.lastReportedAt.set(name, timestamp);
    dashboard.recordDataPoint(name, value, timestamp);
  }

  /**
   * Report a gauge through the FULL formal seam counters/histograms use: the
   * metrics collector (readback via `/v1/observability/metrics`), the alert
   * engine's metricState (`lastValues`/`lastReportedAt`), and the dashboard
   * time-series (readback + trend via `/v1/observability/time-series`). Uses an
   * EMPTY label set so the gauge keeps a single stable identity — no per-status
   * variant can leak. Report-only; never deletes anything.
   */
  function reportGauge(name: string, value: number, timestamp: string): void {
    metrics.setGauge(name, value, {});
    metricState.lastValues.set(name, value);
    metricState.lastReportedAt.set(name, timestamp);
    dashboard.recordDataPoint(name, value, timestamp);
  }

  /**
   * Publish the report-only realtime_events growth reading through the formal
   * observability seam. rows/bytes/status-code land as unlabeled gauges (so the
   * metrics route enumerates them and the time-series route can trend them), and
   * the structured snapshot (with the status + reclaim_status strings) is stored
   * for the metrics route. RESTART-VOLATILE and DELETION-FREE.
   */
  function recordRealtimeEventsGrowth(reading: FridayRealtimeEventsGrowthReading): void {
    const timestamp = deps.nowIso();
    const statusCode = REALTIME_EVENTS_GROWTH_STATUS_CODE[reading.status]
      ?? REALTIME_EVENTS_GROWTH_STATUS_CODE.degraded;
    reportGauge(REALTIME_EVENTS_ROWS_GAUGE, reading.rowCount, timestamp);
    reportGauge(REALTIME_EVENTS_BYTES_GAUGE, reading.estimatedBytes, timestamp);
    reportGauge(REALTIME_EVENTS_STATUS_CODE_GAUGE, statusCode, timestamp);
    lastRealtimeEventsGrowth = {
      rowCount: reading.rowCount,
      estimatedBytes: reading.estimatedBytes,
      status: reading.status,
      statusCode,
      reclaim_status: reading.reclaim_status,
      sampleSize: reading.sampleSize,
      failClosed: reading.failClosed === true,
      reportedAt: timestamp,
      durability: "restart_volatile",
    };
  }

  function metricValue(name: string): number {
    return metricValueFromSnapshots(metrics.getAllSnapshots(name));
  }

  function traceSuccessRate(module: FridayObservabilityModule): number {
    const completed = traces.getCompletedTraces().filter((trace) => trace.spans[0]?.module === module);
    if (completed.length === 0) {
      return 100;
    }
    const okCount = completed.filter((trace) => trace.status !== "error").length;
    return Number(((okCount / completed.length) * 100).toFixed(2));
  }

  async function currentHealthAvailabilityPercent(): Promise<number> {
    const cached = health.getLastResults();
    const snapshot = cached.size > 0
      ? Array.from(cached.values())
      : (await health.checkAll()).components;
    if (snapshot.length === 0) {
      return 100;
    }
    const healthyLike = snapshot.filter((component) =>
      component.status === "healthy" || component.status === "degraded"
    ).length;
    return Number(((healthyLike / snapshot.length) * 100).toFixed(2));
  }

  function ratioFromCounters(totalMetric: string, failureMetric: string): number {
    const total = metricValue(totalMetric);
    const failures = metricValue(failureMetric);
    if (total <= 0) {
      return 100;
    }
    return Number((Math.max(0, total - failures) / total * 100).toFixed(2));
  }

  async function computeSloState(record: SloRuntimeRecord): Promise<{
    definition: FridaySloDefinition;
    errorBudget: FridayErrorBudget;
    burnRates: FridayBurnRate[];
  }> {
    let currentValue = 100;
    switch (record.id) {
      case "slo-api-availability":
        currentValue = traceSuccessRate("api");
        break;
      case "slo-agent-run-success":
        currentValue = traceSuccessRate("learning");
        break;
      case "slo-workflow-deploy-success":
        currentValue = ratioFromCounters(
          "friday.workflows.deployments.total",
          "friday.workflows.deploy_failures.total",
        );
        break;
      case "slo-self-healing-acceptance":
        currentValue = ratioFromCounters(
          "friday.agent_loop.runs.total",
          "friday.agent_loop.verification_failures.total",
        );
        break;
      case "slo-system-runtime-health":
        currentValue = await currentHealthAvailabilityPercent();
        break;
      default:
        currentValue = 100;
        break;
    }

    const totalBudgetPercent = Math.max(0.001, 100 - record.target);
    const remainingBudgetPercent = Math.max(0, totalBudgetPercent - (100 - currentValue));
    const consumedPercent = Number(
      Math.max(0, ((totalBudgetPercent - remainingBudgetPercent) / totalBudgetPercent) * 100).toFixed(2),
    );
    const now = deps.nowIso();
    const windowEnd = new Date(now);
    const windowStart = new Date(windowEnd);
    windowStart.setUTCDate(windowStart.getUTCDate() - record.complianceWindowDays);
    const errorRate = Math.max(0, 100 - currentValue);
    const budgetRate = totalBudgetPercent / Math.max(1, record.complianceWindowDays * 24 * 60);
    const shortThreshold = 2;
    const longThreshold = 1;
    const shortRate = Number((errorRate / totalBudgetPercent).toFixed(4));
    const longRate = Number((errorRate / totalBudgetPercent).toFixed(4));
    const burnRates: FridayBurnRate[] = [
      {
        sloId: record.id,
        windowLabel: "5m",
        windowMinutes: 5,
        rate: shortRate,
        errorRateInWindow: errorRate,
        errorBudgetRate: Number(budgetRate.toFixed(6)),
        exceedsThreshold: shortRate >= shortThreshold,
        threshold: shortThreshold,
        computedAt: now,
      },
      {
        sloId: record.id,
        windowLabel: "1h",
        windowMinutes: 60,
        rate: longRate,
        errorRateInWindow: errorRate,
        errorBudgetRate: Number(budgetRate.toFixed(6)),
        exceedsThreshold: longRate >= longThreshold,
        threshold: longThreshold,
        computedAt: now,
      },
    ];
    const errorBudget: FridayErrorBudget = {
      sloId: record.id,
      totalBudgetPercent: Number(totalBudgetPercent.toFixed(2)),
      remainingBudgetPercent: Number(remainingBudgetPercent.toFixed(2)),
      consumedPercent,
      exhausted: consumedPercent >= 100,
      currentValue,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      computedAt: now,
    };
    const status = currentValue < record.target || consumedPercent >= 100
      ? "breached"
      : consumedPercent >= 75 || burnRates.some((rate) => rate.exceedsThreshold)
        ? "warning"
        : "healthy";
    return {
      definition: {
        id: record.id,
        name: record.name,
        description: record.description,
        sliMetric: record.sliMetric,
        target: record.target,
        complianceWindowDays: record.complianceWindowDays,
        status,
        enabled: record.enabled,
        tags: record.tags,
        alertRuleIds: record.alertRuleIds,
        errorBudget,
        burnRates,
        etag: record.etag,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
      errorBudget,
      burnRates,
    };
  }

  async function appendDispatchAudit(input: {
    destination: AlertDestinationEntity;
    alert: FridayAlertEvent;
    outcome: "success" | "failure";
    description: string;
    metadata: Record<string, unknown>;
    errorMessage?: string;
  }): Promise<void> {
    await appendAudit({
      actor: { type: "system", id: "observability", displayName: "Friday Observability" },
      actionCategory: "execute",
      action: "observability.alert.dispatch",
      resourceType: "alert_rule",
      resourceId: input.alert.ruleId,
      resourceDisplayName: input.destination.name,
      module: "observability",
      outcome: input.outcome,
      description: input.description,
      metadata: toJsonObject({
        alertId: input.alert.id,
        destinationId: input.destination.id,
        destinationType: input.destination.type,
        ...input.metadata,
      }),
      errorMessage: input.errorMessage,
    });
  }

  async function deliverToDestination(
    destination: AlertDestinationEntity,
    alert: FridayAlertEvent,
    rule: FridayAlertRule,
    dedupeKey: string,
    attemptNumber: number,
  ): Promise<AlertDispatchAttemptRecord> {
    const subject = `[Friday][${alert.severity.toUpperCase()}] ${rule.name}`;
    const body = [
      `Alert: ${alert.summary}`,
      `Rule: ${rule.name}`,
      `Status: ${alert.status}`,
      `Module: ${alert.module}`,
      `Detected: ${alert.detectedAt}`,
      "",
      alert.details,
    ].join("\n");
    const startedAt = Date.now();

    try {
      if (destination.config.type === "slack") {
        const webhookUrl = readStoredSecret(destination.config.webhookRefKey);
        if (!webhookUrl) {
          throw new FridayDomainError("NOT_FOUND", `Missing Slack webhook secret for ${destination.id}`, { httpStatus: 404 });
        }
        const webhookTimeoutMs = deps.webhookTimeoutMs ?? FRIDAY_DEFAULT_WEBHOOK_TIMEOUT_MS;
        let response: Response;
        try {
          response = await fetch(webhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              text: `${subject}\n${body}`,
              channel: destination.config.channel,
            }),
            signal: AbortSignal.timeout(webhookTimeoutMs),
          });
        } catch (fetchError) {
          // B2 hanging-fetch boundary: translate AbortSignal.timeout AbortError
          // into a domain-typed 504 so the failure is recoverable (clear error,
          // no hang) and the retry loop at the call site can advance per-
          // attempt. Other fetch failures (DNS, refused) propagate via the
          // outer catch with their original message.
          if (fetchError instanceof Error && (fetchError.name === "TimeoutError" || fetchError.name === "AbortError")) {
            throw new FridayDomainError(
              "OBSERVABILITY_WEBHOOK_TIMEOUT",
              `Slack webhook timed out after ${webhookTimeoutMs}ms`,
              { httpStatus: 504, retryable: true, details: { destinationId: destination.id, timeoutMs: webhookTimeoutMs } },
            );
          }
          throw fetchError;
        }
        if (!response.ok) {
          throw new FridayDomainError("INTERNAL_ERROR", `Slack webhook responded with ${response.status}`, { httpStatus: 500 });
        }
      } else {
        const password = readStoredSecret(destination.config.passwordRefKey);
        if (!password && destination.config.username) {
          throw new FridayDomainError("NOT_FOUND", `Missing SMTP password secret for ${destination.id}`, { httpStatus: 404 });
        }
        const smtpTimeoutMs = deps.smtpTimeoutMs ?? FRIDAY_DEFAULT_SMTP_TIMEOUT_MS;
        try {
          await sendSmtpMail({
            host: destination.config.smtpHost,
            port: destination.config.smtpPort,
            secure: destination.config.smtpSecure,
            username: destination.config.username,
            password: password ?? undefined,
            fromAddress: destination.config.fromAddress,
            recipients: destination.config.recipients,
            subject,
            body,
            timeoutMs: smtpTimeoutMs,
          });
        } catch (smtpError) {
          // B2 hanging-fetch boundary: translate SMTP connect/inactivity
          // timeout into a domain-typed 504 so the failure is recoverable
          // and the retry loop can advance per-attempt instead of hanging.
          // Other SMTP failures (auth refusal, recipient rejection, real
          // network errors) propagate via the outer catch with their
          // original message.
          if (smtpError instanceof Error && /timed out|inactive for/i.test(smtpError.message)) {
            throw new FridayDomainError(
              "OBSERVABILITY_SMTP_TIMEOUT",
              smtpError.message,
              { httpStatus: 504, retryable: true, details: { destinationId: destination.id, timeoutMs: smtpTimeoutMs } },
            );
          }
          throw smtpError;
        }
      }

      incrementCounter("friday.observability.alert_dispatches.total");
      recordHistogram("friday.observability.alert_dispatch.duration_ms", Date.now() - startedAt);
      await appendDispatchAudit({
        destination,
        alert,
        outcome: "success",
        description: `Dispatched alert ${alert.id} to ${destination.name}`,
        metadata: { dedupeKey, attemptNumber },
      });
      return {
        attemptId: deps.idGenerator(),
        destinationId: destination.id,
        destinationType: destination.type,
        status: "sent",
        attemptNumber,
        dedupeKey,
        sentAt: deps.nowIso(),
      };
    } catch (error) {
      incrementCounter("friday.observability.alert_dispatch_failures.total");
      recordHistogram("friday.observability.alert_dispatch.duration_ms", Date.now() - startedAt);
      await appendDispatchAudit({
        destination,
        alert,
        outcome: "failure",
        description: `Failed dispatching alert ${alert.id} to ${destination.name}`,
        metadata: { dedupeKey, attemptNumber },
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return {
        attemptId: deps.idGenerator(),
        destinationId: destination.id,
        destinationType: destination.type,
        status: "failed",
        attemptNumber,
        dedupeKey,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function dispatchAlert(
    alert: FridayAlertEvent,
    rule: FridayAlertRule,
    options?: { destinationId?: string; force?: boolean },
  ): Promise<AlertDispatchAttemptRecord[]> {
    const destinationIds = options?.destinationId
      ? [options.destinationId]
      : alert.currentEscalationTier > 0
        ? (rule.escalationTiers.find((tier) => tier.tier === alert.currentEscalationTier)?.channelIds ?? [])
        : rule.channelIds;

    const attempts: AlertDispatchAttemptRecord[] = [];
    for (const destinationId of destinationIds) {
      const destination = getAlertDestination(destinationId);
      if (!destination || !destination.enabled) {
        attempts.push({
          attemptId: deps.idGenerator(),
          destinationId,
          destinationType: destination?.type ?? "slack",
          status: "skipped",
          attemptNumber: 0,
          dedupeKey: `${alert.id}:${destinationId}:${alert.currentEscalationTier}`,
          errorMessage: destination ? "Destination disabled" : "Destination not found",
        });
        continue;
      }
      const dedupeKey = `${alert.id}:${destinationId}:${alert.currentEscalationTier}`;
      const previous = dispatchHistoryByKey.get(dedupeKey);
      if (!options?.force && previous?.status === "sent") {
        attempts.push({
          ...previous,
          status: "skipped",
        });
        continue;
      }

      let latestAttempt: AlertDispatchAttemptRecord | null = null;
      for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
        latestAttempt = await deliverToDestination(destination, alert, rule, dedupeKey, attemptNumber);
        if (latestAttempt.status === "sent") {
          dispatchHistoryByKey.set(dedupeKey, latestAttempt);
          break;
        }
        if (attemptNumber < 3) {
          await new Promise((resolve) => setTimeout(resolve, 25 * (2 ** (attemptNumber - 1))));
        }
      }
      if (latestAttempt) {
        dispatchHistoryByKey.set(dedupeKey, latestAttempt);
        attempts.push(latestAttempt);
      }
    }
    return attempts;
  }

  function maybeEvaluateAlerts(): void {
    try {
      const cycle = scheduler.evaluateNow();
      void Promise.all(cycle.events.map(async (event) => {
        const rule = alerts.getRule(event.ruleId);
        if (!rule) {
          return;
        }
        if (event.status === "resolved") {
          if (!resolvedAlertIds.has(event.id)) {
            resolvedAlertIds.add(event.id);
            await appendAudit({
              actor: { type: "system", id: "observability", displayName: "Friday Observability" },
              actionCategory: "update",
              action: "observability.alert.resolved",
              resourceType: "alert_rule",
              resourceId: event.ruleId,
              module: "observability",
              outcome: "success",
              description: `Resolved alert ${event.id}`,
              metadata: toJsonObject({ alertId: event.id }),
            });
          }
          return;
        }
        if (rule.channelIds.length === 0 && event.currentEscalationTier === 0) {
          return;
        }
        await dispatchAlert(event, rule);
      })).catch((error: unknown) => {
        console.warn("[friday] observability alert evaluation failed", error);
      });
    } catch (error) {
      console.warn("[friday] observability alert evaluation failed", error);
    }
  }

  function startTrace(
    module: FridayObservabilityModule,
    operationName: string,
    attributes?: Record<string, string | number | boolean>,
  ): FridayObservedOperationContext {
    const handle = traces.startTrace({
      name: operationName,
      module,
      operationName,
      attributes,
    });
    return {
      traceId: handle.traceId,
      spanId: handle.rootSpanContext.spanId,
    };
  }

  function endTrace(
    correlation: FridayObservedOperationContext,
    status: "ok" | "error",
    error?: string,
    attributes?: Record<string, string | number | boolean>,
  ): void {
    if (attributes) {
      traces.setSpanAttributes(
        { traceId: correlation.traceId, spanId: correlation.spanId, traceFlags: 1 },
        attributes,
      );
    }
    traces.endSpan(
      { traceId: correlation.traceId, spanId: correlation.spanId, traceFlags: 1 },
      status,
      error,
    );
  }

  function toTraceSummary(trace: ReturnType<FridayTraceManager["getCompletedTraces"]>[number]): FridayTraceSummary {
    return {
      traceId: trace.traceId,
      name: trace.name,
      rootSpanId: trace.rootSpanId,
      status: trace.status,
      durationMs: trace.durationMs,
      spanCount: trace.spanCount,
      module: trace.spans[0]?.module ?? "observability",
      workflowId: traceAttribute(trace, ["workflowId", "friday.workflow.id"]),
      runId: traceAttribute(trace, ["runId", "friday.workflow.run_id"]),
      principalId: traceAttribute(trace, ["principalId", "friday.principal.id"]),
      startedAt: trace.startedAt,
      endedAt: trace.endedAt,
    };
  }

  function buildRuleResponse(rule: FridayAlertRule | null): FridayGetAlertRuleResponse {
    if (!rule) {
      throw new FridayDomainError("OBS_ALERT_RULE_NOT_FOUND", "Alert rule not found", { httpStatus: 404 });
    }
    const uniqueChannelIds = Array.from(
      new Set([
        ...rule.channelIds,
        ...rule.escalationTiers.flatMap((tier) => tier.channelIds),
      ]),
    );
    return {
      rule,
      channels: listConfiguredChannels(uniqueChannelIds),
      escalationTiers: rule.escalationTiers,
    };
  }

  async function listSloSummaries(query: FridayListSlosQuery): Promise<FridayListSlosResponse> {
    const summaries = await Promise.all(
      listSloRecords().map(async (record) => {
        const state = await computeSloState(record);
        return {
          id: state.definition.id,
          name: state.definition.name,
          sliMetricName: state.definition.sliMetric.name,
          target: state.definition.target,
          status: state.definition.status,
          enabled: state.definition.enabled,
          currentValue: state.errorBudget.currentValue,
          budgetConsumedPercent: state.errorBudget.consumedPercent,
          budgetExhausted: state.errorBudget.exhausted,
          complianceWindowDays: state.definition.complianceWindowDays,
          updatedAt: state.definition.updatedAt,
        };
      }),
    );
    const filtered = summaries.filter((summary) => {
      const record = getSloRecord(summary.id);
      if (query.status && summary.status !== query.status) return false;
      if (query.enabled !== undefined && summary.enabled !== query.enabled) return false;
      if (query.tag && !(record?.tags.includes(query.tag))) return false;
      if (query.module && record?.sliMetric.module !== query.module) return false;
      return true;
    });
    const page = paginate(filtered.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), query);
    return { items: page.items, nextCursor: page.nextCursor };
  }

  async function getSloStatus(sloId: string): Promise<FridayGetSloStatusResponse> {
    const record = getSloRecord(sloId);
    if (!record) {
      throw new FridayDomainError("OBS_SLO_NOT_FOUND", "SLO not found", { httpStatus: 404 });
    }
    const state = await computeSloState(record);
    return {
      slo: state.definition,
      errorBudget: state.errorBudget,
      burnRates: state.burnRates,
    };
  }

  function toAlertSummary(event: FridayAlertEvent) {
    return {
      id: event.id,
      ruleId: event.ruleId,
      ruleName: alerts.getRule(event.ruleId)?.name ?? "Unknown rule",
      severity: event.severity,
      status: event.status,
      summary: event.summary,
      module: event.module,
      sloId: event.sloId,
      detectedAt: event.detectedAt,
      firedAt: event.firedAt,
      acknowledgedAt: event.acknowledgedAt,
      resolvedAt: event.resolvedAt,
      notifiedChannelCount: event.notifiedChannelIds.length,
      currentEscalationTier: event.currentEscalationTier,
    };
  }

  const routes: FridayObservabilityRoutesDeps = {
    overview: {
      async get(): Promise<FridayGetObservabilityOverviewResponse> {
        const runtimeBrowser = deps.browserDiagnosticsProvider?.();
        return {
          overview: await dashboard.getOverview(),
          ...(runtimeBrowser ? { runtime: { browser: runtimeBrowser } } : {}),
        };
      },
    },
    timeSeries: {
      get(query): FridayGetObservabilityTimeSeriesResponse {
        const metricName = normalizeString(query.metricName);
        const startTime = normalizeString(query.startTime);
        const endTime = normalizeString(query.endTime);
        if (!metricName || !startTime || !endTime) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "metricName, startTime, and endTime are required",
            { httpStatus: 400 },
          );
        }
        return {
          series: dashboard.queryTimeSeries({
            metricName,
            startTime,
            endTime,
            bucketSize: query.bucketSize ?? "5m",
          }),
        };
      },
    },
    traces: {
      search(query): FridaySearchTracesResponse {
        const filtered = traces.getCompletedTraces()
          .filter((trace) => {
            const summary = toTraceSummary(trace);
            if (query.name && !summary.name.toLowerCase().includes(query.name.toLowerCase())) return false;
            if (query.status && summary.status !== query.status) return false;
            if (query.module && summary.module !== query.module) return false;
            if (query.workflowId && summary.workflowId !== query.workflowId) return false;
            if (query.runId && summary.runId !== query.runId) return false;
            if (query.principalId && summary.principalId !== query.principalId) return false;
            if (query.minDurationMs !== undefined && summary.durationMs < query.minDurationMs) return false;
            if (query.maxDurationMs !== undefined && summary.durationMs > query.maxDurationMs) return false;
            if (query.after && summary.startedAt < query.after) return false;
            if (query.before && summary.startedAt >= query.before) return false;
            return true;
          })
          .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
          .map(toTraceSummary);
        const page = paginate(filtered, query);
        return {
          items: page.items,
          nextCursor: page.nextCursor,
        };
      },
      get(traceId): FridayGetTraceResponse {
        const trace = traces.getTrace(traceId);
        if (!trace) {
          throw new FridayDomainError("OBS_TRACE_NOT_FOUND", "Trace not found", { httpStatus: 404 });
        }
        return { trace };
      },
    },
    audit: {
      search(query): FridaySearchAuditEntriesResponse {
        const filtered = [
          ...audit.query({
            actorId: query.actorId,
            actionCategory: query.actionCategory,
            action: query.action,
            resourceType: query.resourceType,
            resourceId: query.resourceId,
            outcome: query.outcome,
            module: query.module,
            traceId: query.traceId,
            after: query.after,
            before: query.before,
          }),
        ].sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));
        const page = paginate(filtered, query);
        return {
          items: page.items.map((entry) => ({
            id: entry.id,
            sequenceNumber: entry.sequenceNumber,
            actorDisplayName: entry.actor.displayName,
            actorType: entry.actor.type,
            actorId: entry.actor.id,
            actionCategory: entry.actionCategory,
            action: entry.action,
            resourceType: entry.resource.type,
            resourceId: entry.resource.id,
            resourceDisplayName: entry.resource.displayName,
            outcome: entry.outcome,
            description: entry.description,
            module: entry.module,
            traceId: entry.traceId,
            recordedAt: entry.recordedAt,
          })),
          nextCursor: page.nextCursor,
        };
      },
      async get(entryId): Promise<FridayGetAuditEntryResponse> {
        const entry = audit.getEntry(entryId);
        if (!entry) {
          throw new FridayDomainError("OBS_AUDIT_ENTRY_NOT_FOUND", "Audit entry not found", {
            httpStatus: 404,
          });
        }
        const chainValid = (await audit.verifyChain()).valid;
        return { entry, chainValid };
      },
    },
    slos: {
      async list(query): Promise<FridayListSlosResponse> {
        return listSloSummaries(query);
      },
      async get(sloId): Promise<FridayGetSloStatusResponse> {
        return getSloStatus(sloId);
      },
      async create(input) {
        const id = deps.idGenerator();
        const now = deps.nowIso();
        const sliMetric = input.sliMetric as unknown as FridaySliMetric;
        const record: SloRuntimeRecord = {
          id,
          name: input.name,
          description: input.description ?? "",
          sliMetric,
          target: input.target,
          complianceWindowDays: input.complianceWindowDays ?? 30,
          enabled: input.enabled ?? true,
          tags: input.tags ?? [],
          alertRuleIds: [],
          etag: deps.idGenerator(),
          createdAt: now,
          updatedAt: now,
        };
        storeSloRecord(record);
        return getSloStatus(id);
      },
      async update(sloId, input) {
        const existing = getSloRecord(sloId);
        if (!existing) {
          throw new FridayDomainError("OBS_SLO_NOT_FOUND", "SLO not found", { httpStatus: 404 });
        }
        if (existing.etag !== input.etag) {
          throw new FridayDomainError("OBS_SLO_ETAG_MISMATCH", "SLO was modified concurrently", { httpStatus: 409 });
        }
        const now = deps.nowIso();
        const updated: SloRuntimeRecord = {
          ...existing,
          name: input.name ?? existing.name,
          description: input.description ?? existing.description,
          target: input.target ?? existing.target,
          complianceWindowDays: input.complianceWindowDays ?? existing.complianceWindowDays,
          enabled: input.enabled ?? existing.enabled,
          tags: input.tags ?? existing.tags,
          etag: deps.idGenerator(),
          updatedAt: now,
        };
        storeSloRecord(updated);
        return getSloStatus(sloId);
      },
      async delete(sloId, etag) {
        const existing = getSloRecord(sloId);
        if (!existing) {
          throw new FridayDomainError("OBS_SLO_NOT_FOUND", "SLO not found", { httpStatus: 404 });
        }
        if (existing.etag !== etag) {
          throw new FridayDomainError("OBS_SLO_ETAG_MISMATCH", "SLO was modified concurrently", { httpStatus: 409 });
        }
        if (deps.db) {
          deps.db.withWriteTransaction((db) => {
            db.prepare("DELETE FROM obs_slo_definitions WHERE id = ?").run(sloId);
          });
        } else {
          inMemorySloDefinitions.delete(sloId);
        }
        return { deleted: true as const, sloId };
      },
    },
    alerts: {
      list(query): FridayListAlertsResponse {
        const filtered = alerts.getAllEvents()
          .filter((event) => {
            if (query.ruleId && event.ruleId !== query.ruleId) return false;
            if (query.severity && event.severity !== query.severity) return false;
            if (query.status && event.status !== query.status) return false;
            if (query.module && event.module !== query.module) return false;
            if (query.sloId && event.sloId !== query.sloId) return false;
            if (query.after && event.detectedAt < query.after) return false;
            if (query.before && event.detectedAt >= query.before) return false;
            return true;
          })
          .sort((left, right) => right.detectedAt.localeCompare(left.detectedAt));
        const page = paginate(filtered, query);
        return {
          items: page.items.map(toAlertSummary),
          nextCursor: page.nextCursor,
        };
      },
      get(alertId): FridayGetAlertResponse {
        const alert = alerts.getEvent(alertId);
        if (!alert) {
          throw new FridayDomainError("OBS_ALERT_NOT_FOUND", "Alert not found", { httpStatus: 404 });
        }
        const rule = alerts.getRule(alert.ruleId);
        if (!rule) {
          throw new FridayDomainError("OBS_ALERT_RULE_NOT_FOUND", "Alert rule not found", { httpStatus: 404 });
        }
        return {
          alert,
          rule,
          notifiedChannels: listConfiguredChannels(alert.notifiedChannelIds),
        };
      },
      async acknowledge(alertId, req): Promise<FridayAcknowledgeAlertResponse> {
        const alert = alerts.acknowledgeAlert(alertId, "operator", req.note);
        if (!alert) {
          throw new FridayDomainError("OBS_ALERT_NOT_FOUND", "Alert not found", { httpStatus: 404 });
        }
        await appendAudit({
          actor: { type: "user", id: "operator", displayName: "Operator" },
          actionCategory: "authorize",
          action: "observability.alert.acknowledge",
          resourceType: "alert_rule",
          resourceId: alert.ruleId,
          module: "observability",
          outcome: "success",
          description: `Acknowledged alert ${alert.id}`,
          metadata: { alertId, note: req.note ?? null },
        });
        return { alert };
      },
      async testDispatch(alertId, req): Promise<FridayTestAlertDispatchResponse> {
        const alert = alerts.getEvent(alertId);
        if (!alert) {
          throw new FridayDomainError("OBS_ALERT_NOT_FOUND", "Alert not found", { httpStatus: 404 });
        }
        const rule = alerts.getRule(alert.ruleId);
        if (!rule) {
          throw new FridayDomainError("OBS_ALERT_RULE_NOT_FOUND", "Alert rule not found", { httpStatus: 404 });
        }
        if (req.destinationId && !getAlertDestination(req.destinationId)) {
          throw new FridayDomainError("OBS_ALERT_CHANNEL_NOT_FOUND", "Alert destination not found", {
            httpStatus: 404,
          });
        }
        const attempts = await dispatchAlert(alert, rule, {
          destinationId: req.destinationId,
          force: true,
        });
        return {
          alertId,
          attempts,
        };
      },
    },
    alertDestinations: {
      list(): FridayListAlertDestinationsResponse {
        return {
          items: listAlertDestinations().map(toAlertDestinationSummary),
        };
      },
      async create(req): Promise<FridayCreateAlertDestinationResponse> {
        const destination = validateAlertDestinationRequest(req);
        if (destination.config.type === "slack" && "webhookUrl" in req) {
          storeSecret(destination.config.webhookRefKey, req.webhookUrl);
        } else if (destination.config.type === "email" && "password" in req) {
          storeSecret(destination.config.passwordRefKey, req.password);
        }
        storeAlertDestination(destination);
        await appendAudit({
          actor: { type: "user", id: "operator", displayName: "Operator" },
          actionCategory: "create",
          action: "observability.alert_destination.create",
          resourceType: "alert_rule",
          resourceId: destination.id,
          resourceDisplayName: destination.name,
          module: "observability",
          outcome: "success",
          description: `Created alert destination ${destination.name}`,
          metadata: toJsonObject({ destinationType: destination.type }),
        });
        return { destination: toAlertDestinationSummary(destination) };
      },
      async update(destinationId, req): Promise<FridayUpdateAlertDestinationResponse> {
        const existing = getAlertDestination(destinationId);
        if (!existing) {
          throw new FridayDomainError("OBS_ALERT_CHANNEL_NOT_FOUND", "Alert destination not found", {
            httpStatus: 404,
          });
        }
        const destination = validateAlertDestinationRequest(req, existing);
        if (destination.config.type === "slack" && "webhookUrl" in req && req.webhookUrl) {
          storeSecret(destination.config.webhookRefKey, req.webhookUrl);
        }
        if (destination.config.type === "email" && "password" in req && req.password) {
          storeSecret(destination.config.passwordRefKey, req.password);
        }
        storeAlertDestination(destination);
        await appendAudit({
          actor: { type: "user", id: "operator", displayName: "Operator" },
          actionCategory: "update",
          action: "observability.alert_destination.update",
          resourceType: "alert_rule",
          resourceId: destination.id,
          resourceDisplayName: destination.name,
          module: "observability",
          outcome: "success",
          description: `Updated alert destination ${destination.name}`,
          metadata: toJsonObject({ destinationType: destination.type }),
        });
        return { destination: toAlertDestinationSummary(destination) };
      },
      async delete(destinationId): Promise<FridayDeleteAlertDestinationResponse> {
        const existing = getAlertDestination(destinationId);
        if (!existing) {
          throw new FridayDomainError("OBS_ALERT_CHANNEL_NOT_FOUND", "Alert destination not found", {
            httpStatus: 404,
          });
        }
        deleteAlertDestination(destinationId);
        await appendAudit({
          actor: { type: "user", id: "operator", displayName: "Operator" },
          actionCategory: "delete",
          action: "observability.alert_destination.delete",
          resourceType: "alert_rule",
          resourceId: destinationId,
          resourceDisplayName: existing.name,
          module: "observability",
          outcome: "success",
          description: `Deleted alert destination ${existing.name}`,
        });
        return { deleted: true, destinationId };
      },
    },
    alertRules: {
      list(query): FridayListAlertRulesResponse {
        const filtered = alerts.getRules()
          .filter((rule) => {
            if (query.severity && rule.severity !== query.severity) return false;
            if (query.enabled !== undefined && rule.enabled !== query.enabled) return false;
            if (query.tag && !rule.tags.includes(query.tag)) return false;
            if (!query.includeDeleted && rule.deletedAt) return false;
            return true;
          })
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        const page = paginate(filtered, query);
        return {
          items: page.items,
          nextCursor: page.nextCursor,
        };
      },
      get(ruleId): FridayGetAlertRuleResponse {
        return buildRuleResponse(alerts.getRule(ruleId));
      },
      async create(req): Promise<FridayCreateAlertRuleResponse> {
        ensureAlertChannelsExist([
          ...req.channelIds,
          ...(req.escalationTiers ?? []).flatMap((tier) => tier.channelIds),
        ]);
        const now = deps.nowIso();
        const rule: FridayAlertRule = {
          id: deps.idGenerator(),
          name: req.name,
          description: req.description,
          severity: req.severity,
          enabled: req.enabled ?? true,
          condition: req.condition,
          evaluationIntervalSec: req.evaluationIntervalSec ?? 60,
          channelIds: req.channelIds,
          escalationTiers: req.escalationTiers ?? [],
          groupingWindowMin: req.groupingWindowMin ?? 5,
          tags: req.tags ?? [],
          etag: `${deps.idGenerator()}-${Date.now()}`,
          createdAt: now,
          updatedAt: now,
        };
        alerts.addRule(rule);
        await appendAudit({
          actor: { type: "user", id: "operator", displayName: "Operator" },
          actionCategory: "create",
          action: "observability.alert_rule.create",
          resourceType: "alert_rule",
          resourceId: rule.id,
          resourceDisplayName: rule.name,
          module: "observability",
          outcome: "success",
          description: `Created alert rule ${rule.name}`,
        });
        return { rule };
      },
      async update(ruleId, req): Promise<FridayUpdateAlertRuleResponse> {
        const existing = alerts.getRule(ruleId);
        if (!existing) {
          throw new FridayDomainError("OBS_ALERT_RULE_NOT_FOUND", "Alert rule not found", { httpStatus: 404 });
        }
        if (existing.etag !== req.etag) {
          throw new FridayDomainError("OBS_ALERT_RULE_ETAG_MISMATCH", "etag does not match the current rule", {
            httpStatus: 409,
          });
        }
        ensureAlertChannelsExist([
          ...(req.channelIds ?? existing.channelIds),
          ...(req.escalationTiers ?? existing.escalationTiers).flatMap((tier) => tier.channelIds),
        ]);
        const updated: FridayAlertRule = {
          ...existing,
          ...req,
          id: existing.id,
          etag: `${deps.idGenerator()}-${Date.now()}`,
          updatedAt: deps.nowIso(),
        };
        alerts.addRule(updated);
        await appendAudit({
          actor: { type: "user", id: "operator", displayName: "Operator" },
          actionCategory: "update",
          action: "observability.alert_rule.update",
          resourceType: "alert_rule",
          resourceId: updated.id,
          resourceDisplayName: updated.name,
          module: "observability",
          outcome: "success",
          description: `Updated alert rule ${updated.name}`,
        });
        return { rule: updated };
      },
      async delete(ruleId, req): Promise<FridayDeleteAlertRuleResponse> {
        const existing = alerts.getRule(ruleId);
        if (!existing) {
          throw new FridayDomainError("OBS_ALERT_RULE_NOT_FOUND", "Alert rule not found", { httpStatus: 404 });
        }
        if (existing.etag !== req.etag) {
          throw new FridayDomainError("OBS_ALERT_RULE_ETAG_MISMATCH", "etag does not match the current rule", {
            httpStatus: 409,
          });
        }
        alerts.removeRule(ruleId);
        await appendAudit({
          actor: { type: "user", id: "operator", displayName: "Operator" },
          actionCategory: "delete",
          action: "observability.alert_rule.delete",
          resourceType: "alert_rule",
          resourceId: existing.id,
          resourceDisplayName: existing.name,
          module: "observability",
          outcome: "success",
          description: `Deleted alert rule ${existing.name}`,
        });
        return {
          deleted: true,
          ruleId,
        };
      },
    },
    metrics: {
      getSnapshot() {
        const collected: Record<string, number> = {};
        for (const { name } of COUNTER_METRICS) {
          collected[name] = metricValueFromSnapshots(metrics.getAllSnapshots(name));
        }
        // Enumerate gauges too, so the report-only realtime_events growth signal
        // (rows/bytes/status-code) is authoritatively readable off this route.
        for (const { name } of GAUGE_METRICS) {
          collected[name] = metricValueFromSnapshots(metrics.getAllSnapshots(name));
        }
        return {
          collectedAt: deps.nowIso(),
          metrics: collected,
          // Structured current growth snapshot carries the status + reclaim_status
          // STRINGS (the numeric gauges above cannot). Null until the first tick.
          // RESTART-VOLATILE: cleared on Hub restart (in-memory collector).
          realtimeEventsGrowth: lastRealtimeEventsGrowth,
          summary:
            `In-memory metrics collector active with ${COUNTER_METRICS.length} counter(s) and ` +
            `${GAUGE_METRICS.length} gauge(s). Values are RESTART-VOLATILE (not persisted across Hub restart).`,
        };
      },
    },
    heartbeat: deps.heartbeatStateGetter || deps.heartbeatTrigger
      ? {
        ...(deps.heartbeatStateGetter
          ? {
              getStatus() {
                const state = deps.heartbeatStateGetter!();
                return {
                  lastRunAt: state?.lastRunAt ?? null,
                  result: state?.result ?? "unknown",
                  intervalMs: state?.intervalMs ?? null,
                  nextRunAt: state?.nextRunAt ?? null,
                };
              },
            }
          : {}),
        ...(deps.heartbeatTrigger
          ? {
              trigger() {
                return deps.heartbeatTrigger!();
              },
            }
          : {}),
      }
      : undefined,
  };

  return {
    routes,
    traces,
    audit,
    metrics,
    alerts,
    health,
    dashboard,
    scheduler,
    drainAuditWrites,
    recordRealtimeEventsGrowth,
    async shutdown() {
      scheduler.stop();
      await drainAuditWrites();
    },
    async observeAsync<T>(input: FridayObservedOperationInput, work: () => Promise<T>): Promise<T> {
      const startedAt = Date.now();
      const correlation = startTrace(input.module, input.operationName, {
        action: input.action,
        resourceId: input.resourceId,
        resourceType: input.resourceType,
        ...input.attributes,
      });

      try {
        const result = await work();
        const durationMs = Date.now() - startedAt;
        endTrace(correlation, "ok");
        if (input.successMetric) {
          incrementCounter(input.successMetric);
        }
        if (input.durationMetric) {
          recordHistogram(input.durationMetric, durationMs);
        }
        await appendAudit({
          actor: input.actor,
          actionCategory: input.actionCategory,
          action: input.action,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          resourceDisplayName: input.resourceDisplayName,
          module: input.module,
          outcome: "success",
          description: input.description,
          traceId: correlation.traceId,
          spanId: correlation.spanId,
          metadata: toJsonObject(input.metadata),
        });
        return result;
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        endTrace(
          correlation,
          "error",
          error instanceof Error ? error.message : "unknown error",
        );
        if (input.failureMetric) {
          incrementCounter(input.failureMetric);
        }
        if (input.durationMetric) {
          recordHistogram(input.durationMetric, durationMs);
        }
        await appendAudit({
          actor: input.actor,
          actionCategory: input.actionCategory,
          action: input.action,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          resourceDisplayName: input.resourceDisplayName,
          module: input.module,
          outcome: "failure",
          description: input.description,
          traceId: correlation.traceId,
          spanId: correlation.spanId,
          metadata: toJsonObject(input.metadata),
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        maybeEvaluateAlerts();
        throw error;
      }
    },
    recordSelfHealingProcessResults(input) {
      for (const result of input.results) {
        for (const incident of result.incidentsCreated) {
          incrementCounter("friday.learning.incidents.total");
          incrementCounter("friday.learning.failures.total");
          const correlation = startTrace("learning", "learning.incident.opened", {
            incidentId: incident.incidentId,
            category: incident.category,
            severity: incident.severity,
            correlationId: input.correlationId ?? incident.incidentId,
          });
          endTrace(correlation, "error", incident.signature);
          enqueueBackgroundAudit({
            actor: { type: "system", id: "self-healing", displayName: "Friday Self-Healing" },
            actionCategory: "create",
            action: "learning.incident.opened",
            resourceType: "incident",
            resourceId: incident.incidentId,
            module: "learning",
            outcome: "failure",
            description: `Opened ${incident.category} incident ${incident.incidentId}`,
            traceId: correlation.traceId,
            spanId: correlation.spanId,
            metadata: {
              severity: incident.severity,
              status: incident.status,
              signature: incident.signature,
              userId: incident.userId,
            },
            errorMessage: incident.signature,
          });
        }

        for (const diagnosis of result.diagnosisCreated) {
          incrementCounter("friday.learning.diagnoses.total");
          const correlation = startTrace("learning", "learning.diagnosis.recorded", {
            diagnosisId: diagnosis.id,
            incidentId: diagnosis.incidentId ?? "unknown",
            confidence: diagnosis.confidence,
          });
          endTrace(correlation, "ok");
          enqueueBackgroundAudit({
            actor: { type: "system", id: "self-healing", displayName: "Friday Self-Healing" },
            actionCategory: "create",
            action: "learning.diagnosis.recorded",
            resourceType: "incident",
            resourceId: diagnosis.incidentId ?? diagnosis.id,
            module: "learning",
            outcome: "success",
            description: `Recorded diagnosis ${diagnosis.id}`,
            traceId: correlation.traceId,
            spanId: correlation.spanId,
            metadata: {
              diagnosisId: diagnosis.id,
              confidence: diagnosis.confidence,
              errorFingerprint: diagnosis.errorFingerprint,
            },
          });
        }
      }
      maybeEvaluateAlerts();
    },
    async recordAutoFixActionEvent(input) {
      const isFailure = input.details.action.status === "rolled_back"
        || input.details.action.outcome === "failed";
      if (input.event.includes("rolled_back")) {
        incrementCounter("friday.learning.rollbacks.total");
      }
      await this.observeAsync({
        module: "learning",
        operationName: input.event,
        actionCategory: "execute",
        action: input.event,
        resourceType: "auto_fix_action",
        resourceId: input.details.action.actionId,
        resourceDisplayName: input.details.action.plan.title,
        actor: input.actor,
        description: input.description,
        successMetric: "friday.learning.actions.total",
        failureMetric: isFailure ? "friday.learning.failures.total" : undefined,
        durationMetric: "friday.learning.action.duration_ms",
        metadata: {
          incidentId: input.details.action.incidentId,
          riskTier: input.details.action.riskTier,
          status: input.details.action.status,
          outcome: input.details.action.outcome,
          rootCauseSummary: input.details.evidence.rootCauseSummary,
        },
      }, async () => input.details);
      maybeEvaluateAlerts();
    },
    async recordSkillGeneratorEvent(input) {
      const successMetric = input.event === "generation_failed"
        ? undefined
        : input.event === "draft_tested"
          ? "friday.skills.generator.tests.total"
          : "friday.skills.generator.sessions.total";
      const failureMetric = input.event === "generation_failed" || input.ok === false
        ? "friday.skills.generator.failures.total"
        : undefined;
      await this.observeAsync({
        module: "skills",
        operationName: `skills.${input.event}`,
        actionCategory: "execute",
        action: `skills.${input.event}`,
        resourceType: "skill_generation_session",
        resourceId: input.sessionId,
        resourceDisplayName: input.sessionId,
        actor: { type: "user", id: input.userId, displayName: input.userId },
        description: input.summary,
        successMetric,
        failureMetric,
        durationMetric: "friday.skills.generator.duration_ms",
        metadata: {
          ok: input.ok ?? null,
          approvalReady: input.evidence?.approvalReadiness.ready ?? null,
        },
      }, async () => input.evidence ?? null);
      maybeEvaluateAlerts();
    },
    async recordWorkflowGeneratorEvent(input) {
      const successMetric = input.event === "generation_failed" || input.event === "approve_blocked"
        ? undefined
        : "friday.workflows.generator.sessions.total";
      const failureMetric = input.event === "generation_failed" || input.event === "approve_blocked" || input.ok === false
        ? "friday.workflows.generator.failures.total"
        : undefined;
      await this.observeAsync({
        module: "workflows",
        operationName: `workflows.${input.event}`,
        actionCategory: "execute",
        action: `workflows.${input.event}`,
        resourceType: "workflow_generation_session",
        resourceId: input.sessionId,
        resourceDisplayName: input.sessionId,
        actor: { type: "user", id: input.userId, displayName: input.userId },
        description: input.summary,
        successMetric,
        failureMetric,
        durationMetric: "friday.workflows.generator.duration_ms",
        metadata: {
          ok: input.ok ?? null,
          approvalReady: input.evidence?.approvalReadiness.ready ?? null,
          verdict: input.evidence?.qaVerdict?.verdict ?? null,
        },
      }, async () => input.evidence ?? null);
      maybeEvaluateAlerts();
    },
    async recordAssistantEvent(input) {
      const metric = input.event === "intent_resolved"
        ? "friday.uix.intents.total"
        : input.event === "template_executed"
          ? "friday.uix.templates.executed.total"
          : "friday.uix.wizards.continued.total";
      const durationMetric = input.event === "intent_resolved"
        ? "friday.uix.intent.duration_ms"
        : input.event === "template_executed"
          ? "friday.uix.template.duration_ms"
          : "friday.uix.wizard.duration_ms";
      await this.observeAsync({
        module: "uix",
        operationName: `uix.${input.event}`,
        actionCategory: "execute",
        action: `uix.${input.event}`,
        resourceType: input.event === "template_executed" ? "template" : "guided_workflow",
        resourceId: input.event === "template_executed"
          ? (input.result as FridayUixTemplateExecutionResponse | undefined)?.templateId ?? "assistant"
          : "guided-assistant",
        actor: { type: "user", id: input.userId, displayName: input.userId },
        description: input.summary,
        successMetric: metric,
        durationMetric,
        metadata: {
          intent: input.intent?.intent,
          confidence: input.intent?.confidence,
          routeTarget: input.intent?.routeTarget,
          state: input.intent?.state ?? input.result?.state,
          assumptionsCount:
            input.intent?.assumptions?.length
            ?? input.result?.assumptions?.length
            ?? 0,
          unknownsCount:
            input.intent?.unknowns?.length
            ?? input.result?.unknowns?.length
            ?? 0,
        },
      }, async () => input.result ?? input.intent ?? null);
    },
    async recordAgentLoopEvent(input) {
      if (!observedAgentLoopRunIds.has(input.run.loopRunId)) {
        observedAgentLoopRunIds.add(input.run.loopRunId);
        incrementCounter("friday.agent_loop.runs.total");
      }
      if (input.run.status === "halted") {
        incrementCounter("friday.agent_loop.halts.total");
      }
      if (input.run.rollbackAttempted) {
        incrementCounter("friday.agent_loop.rollbacks.total");
      }
      if (input.run.status === "failed" || input.run.haltReason === "verification_failed") {
        incrementCounter("friday.agent_loop.verification_failures.total");
      }
      await this.observeAsync({
        module: "learning",
        operationName: input.event,
        actionCategory: "execute",
        action: input.event,
        resourceType: "incident",
        resourceId: input.run.incidentId,
        resourceDisplayName: input.details.action?.action.plan.title,
        actor: { type: "system", id: "agent-loop", displayName: "Friday Agent Loop" },
        description: `Agent loop ${input.event} for ${input.run.incidentId}`,
        successMetric: undefined,
        failureMetric: input.run.status === "failed" || input.run.status === "halted"
          ? "friday.learning.failures.total"
          : undefined,
        durationMetric: "friday.agent_loop.duration_ms",
        metadata: {
          loopRunId: input.run.loopRunId,
          actionId: input.run.actionId,
          status: input.run.status,
          haltReason: input.run.haltReason,
          attemptNumber: input.run.attemptNumber,
          expertModeEnabled: input.details.run.expertModeEnabled,
          riskClass: input.details.run.riskClass,
          assumptionsCount: input.details.run.assumptions?.length ?? 0,
          probeStepsCount: input.details.run.probeSteps?.length ?? 0,
        },
      }, async () => input.details);
      maybeEvaluateAlerts();
    },
  };
}
