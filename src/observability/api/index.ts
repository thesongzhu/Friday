// ─── Observability, Audit, and Ops API Contract ───

export {
  FRIDAY_OBSERVABILITY_ERROR_CODES,
} from "./friday-observability-api.types.js";

export type {
  // Error codes
  FridayObservabilityErrorCode,

  // Pagination
  FridayObservabilityPaginationQuery,
  FridayObservabilityPage,

  // ─── Trace API ───

  // Search traces
  FridaySearchTracesQuery,
  FridayTraceSummary,
  FridaySearchTracesResponse,

  // Get trace
  FridayGetTraceResponse,

  // Dashboard API
  FridayGetObservabilityOverviewResponse,
  FridayGetObservabilityTimeSeriesQuery,
  FridayGetObservabilityTimeSeriesResponse,

  // ─── Audit API ───

  // Search audit entries
  FridaySearchAuditEntriesQuery,
  FridayAuditEntrySummary,
  FridaySearchAuditEntriesResponse,

  // Get audit entry
  FridayGetAuditEntryResponse,

  // ─── SLO API ───

  // List SLOs
  FridayListSlosQuery,
  FridaySloSummary,
  FridayListSlosResponse,

  // Get SLO status
  FridayGetSloStatusResponse,

  // ─── Alert API ───

  // List alerts
  FridayListAlertsQuery,
  FridayAlertEventSummary,
  FridayListAlertsResponse,

  // Get alert
  FridayGetAlertResponse,

  // Acknowledge alert
  FridayAcknowledgeAlertRequest,
  FridayAcknowledgeAlertResponse,

  // ─── Alert Rule Configuration API ───

  // List alert rules
  FridayListAlertRulesQuery,
  FridayListAlertRulesResponse,

  // Get alert rule
  FridayGetAlertRuleResponse,

  // Create alert rule
  FridayCreateAlertRuleRequest,
  FridayCreateAlertRuleResponse,

  // Update alert rule
  FridayUpdateAlertRuleRequest,
  FridayUpdateAlertRuleResponse,

  // Delete alert rule
  FridayDeleteAlertRuleRequest,
  FridayDeleteAlertRuleResponse,
} from "./friday-observability-api.types.js";
