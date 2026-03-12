// ─── Observability, Audit, and Ops Domain Model ───

export {
  FRIDAY_AUDIT_GENESIS_HASH,
  FRIDAY_ALERT_SEVERITY_PRIORITY,
} from "./friday-observability.types.js";

export type {
  // Foundational value types
  UUID,
  ISODateTime,
  JsonPrimitive,
  JsonValue,
  JsonObject,

  // OTel-compatible attribute types
  FridayAttributeValue,
  FridayAttributes,

  // ─── Distributed Tracing ───

  // Span kind
  FridaySpanKind,

  // Span status
  FridaySpanStatus,

  // Span context (propagation token)
  FridaySpanContext,

  // Span event
  FridaySpanEvent,

  // Span
  FridaySpan,

  // Module identifiers
  FridayObservabilityModule,

  // Trace
  FridayTrace,

  // ─── Audit Logging ───

  // Audit actor
  FridayAuditActorType,
  FridayAuditActor,

  // Audit resource
  FridayAuditResourceType,
  FridayAuditResource,

  // Audit outcome
  FridayAuditOutcome,

  // Audit action category
  FridayAuditActionCategory,

  // Canonical serialization
  FridayCanonicalizeAuditEntry,

  // Retention checkpoint
  FridayRetentionCheckpoint,

  // Audit entry
  FridayAuditEntry,

  // ─── SLO Monitoring ───

  // SLI metric
  FridaySliMetricType,
  FridaySliMetricTypePhase2,
  FridaySliMetric,

  // Error budget
  FridayErrorBudget,

  // Burn rate
  FridayBurnRate,

  // SLO definition
  FridaySloStatus,
  FridaySloDefinition,

  // ─── Alerting Pipeline ───

  // Alert severity
  FridayAlertSeverity,

  // Alert condition (discriminated union)
  FridayAlertConditionType,
  FridayAlertConditionThreshold,
  FridayAlertConditionAbsence,
  FridayAlertConditionAnomaly,
  FridayAlertConditionBurnRate,
  FridayAlertCondition,

  // Alert channel (discriminated union)
  FridayAlertChannelType,
  FridayAlertChannelWebhook,
  FridayAlertChannelEmail,
  FridayAlertChannelSlack,
  FridayAlertChannelPagerduty,
  FridayAlertChannel,

  // Escalation tiers
  FridayEscalationTier,

  // Alert rule
  FridayAlertRule,

  // Alert event
  FridayAlertEventStatus,
  FridayAlertEvent,

  // ─── Persistence Row Types ───

  FridayTraceRow,
  FridaySpanRow,
  FridayAuditEntryRow,
  FridayRetentionCheckpointRow,
  FridaySloDefinitionRow,
  FridayAlertRuleRow,
  FridayAlertChannelRow,
  FridayAlertEventRow,
  FridayObservabilityRowMapper,
} from "./friday-observability.types.js";
