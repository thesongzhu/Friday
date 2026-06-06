/**
 * B-005 Observability API Routes — exposes trace search, audit log queries,
 * SLO status, alert management, and alert rule CRUD.
 *
 * @module api/http/routes
 */

import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import { FridayDomainError } from "../../../errors/friday-domain-error.js";
import type {
  FridayAcknowledgeAlertRequest,
  FridayAcknowledgeAlertResponse,
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
  FridaySearchAuditEntriesQuery,
  FridaySearchAuditEntriesResponse,
  FridaySearchTracesQuery,
  FridaySearchTracesResponse,
  FridayTestAlertDispatchRequest,
  FridayTestAlertDispatchResponse,
  FridayUpdateAlertDestinationRequest,
  FridayUpdateAlertDestinationResponse,
  FridayUpdateAlertRuleRequest,
  FridayUpdateAlertRuleResponse,
} from "../../../observability/api/friday-observability-api.types.js";
import type { UUID } from "../../../security/multi-tenant/model/friday-multi-tenant-security.types.js";

// ─── Service Dependencies ───

export interface FridayObservabilityRoutesDeps {
  overview: {
    get(): FridayGetObservabilityOverviewResponse | Promise<FridayGetObservabilityOverviewResponse>;
  };
  timeSeries: {
    get(
      query: FridayGetObservabilityTimeSeriesQuery,
    ): FridayGetObservabilityTimeSeriesResponse | Promise<FridayGetObservabilityTimeSeriesResponse>;
  };
  traces: {
    search(query: FridaySearchTracesQuery): FridaySearchTracesResponse | Promise<FridaySearchTracesResponse>;
    get(traceId: string): FridayGetTraceResponse | Promise<FridayGetTraceResponse>;
  };
  audit: {
    search(
      query: FridaySearchAuditEntriesQuery,
    ): FridaySearchAuditEntriesResponse | Promise<FridaySearchAuditEntriesResponse>;
    get(entryId: UUID): FridayGetAuditEntryResponse | Promise<FridayGetAuditEntryResponse>;
  };
  slos: {
    list(query: FridayListSlosQuery): FridayListSlosResponse | Promise<FridayListSlosResponse>;
    get(sloId: UUID): FridayGetSloStatusResponse | Promise<FridayGetSloStatusResponse>;
    create(input: { name: string; description?: string; sliMetric: Record<string, unknown>; target: number; complianceWindowDays?: number; enabled?: boolean; tags?: string[] }): Promise<FridayGetSloStatusResponse>;
    update(sloId: UUID, input: { etag: string; name?: string; description?: string; target?: number; complianceWindowDays?: number; enabled?: boolean; tags?: string[] }): Promise<FridayGetSloStatusResponse>;
    delete(sloId: UUID, etag: string): Promise<{ deleted: true; sloId: string }>;
  };
  alerts: {
    list(query: FridayListAlertsQuery): FridayListAlertsResponse | Promise<FridayListAlertsResponse>;
    get(alertId: UUID): FridayGetAlertResponse | Promise<FridayGetAlertResponse>;
    acknowledge(
      alertId: UUID,
      req: FridayAcknowledgeAlertRequest,
    ): FridayAcknowledgeAlertResponse | Promise<FridayAcknowledgeAlertResponse>;
    testDispatch(
      alertId: UUID,
      req: FridayTestAlertDispatchRequest,
    ): FridayTestAlertDispatchResponse | Promise<FridayTestAlertDispatchResponse>;
  };
  alertDestinations: {
    list(): FridayListAlertDestinationsResponse | Promise<FridayListAlertDestinationsResponse>;
    create(
      req: FridayCreateAlertDestinationRequest,
    ): FridayCreateAlertDestinationResponse | Promise<FridayCreateAlertDestinationResponse>;
    update(
      destinationId: UUID,
      req: FridayUpdateAlertDestinationRequest,
    ): FridayUpdateAlertDestinationResponse | Promise<FridayUpdateAlertDestinationResponse>;
    delete(destinationId: UUID): FridayDeleteAlertDestinationResponse | Promise<FridayDeleteAlertDestinationResponse>;
  };
  alertRules: {
    list(query: FridayListAlertRulesQuery): FridayListAlertRulesResponse | Promise<FridayListAlertRulesResponse>;
    get(ruleId: UUID): FridayGetAlertRuleResponse | Promise<FridayGetAlertRuleResponse>;
    create(req: FridayCreateAlertRuleRequest): FridayCreateAlertRuleResponse | Promise<FridayCreateAlertRuleResponse>;
    update(
      ruleId: UUID,
      req: FridayUpdateAlertRuleRequest,
    ): FridayUpdateAlertRuleResponse | Promise<FridayUpdateAlertRuleResponse>;
    delete(
      ruleId: UUID,
      req: FridayDeleteAlertRuleRequest,
    ): FridayDeleteAlertRuleResponse | Promise<FridayDeleteAlertRuleResponse>;
  };
  /** Optional: metrics snapshot from the in-memory metrics collector. */
  metrics?: {
    getSnapshot(): unknown | Promise<unknown>;
  };
  /** Optional: heartbeat system status. */
  heartbeat?: {
    getStatus?(): unknown | Promise<unknown>;
    trigger?(): unknown | Promise<unknown>;
  };
  /**
   * Test-oracle only: allow the legacy TypeScript observability alert/SLO
   * mutations (SLO create/update/delete, alert acknowledge, alert-destination
   * create/update/delete, alert-rule create/update/delete) in isolated
   * mock/unit validation. Production/runtime callers must leave this unset so
   * the observability alert engine stays fail-closed until Rust owns it.
   */
  allowTestOnlyObservabilityExecution?: boolean;
  /**
   * Test-oracle only: allow the legacy TypeScript heartbeat trigger (which runs
   * an agent run via the heartbeat job) in isolated mock/unit validation.
   * Production/runtime callers must leave this unset so heartbeat execution
   * stays fail-closed until Rust owns it.
   */
  allowTestOnlyHeartbeatExecution?: boolean;
}

// ─── Retirement helpers ───
//
// The observability alert/SLO mutation surfaces write alert-engine state
// (SecureStore destinations, alert rules, SLO records, acknowledgements) and
// the heartbeat trigger runs an agent run; both fail-close by default/live
// until Rust owns the corresponding entrypoints. The alert test-dispatch route
// is a separate operator_external_adapter (real Slack/SMTP egress) and is NOT
// guarded here. Legacy behavior is reachable only through the explicit
// per-engine test-oracle flags above.

function throwRetiredObservability(
  code: string,
  label: string,
  replacement: string,
): never {
  throw new FridayDomainError(
    code,
    `${label} is fail-closed in default/live runtime; use the Rust-owned ${replacement} entrypoint.`,
    {
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: `rust_owned_${replacement}_entrypoint_required`,
      },
    },
  );
}

function assertObservabilityTestOracleAllowed(deps: FridayObservabilityRoutesDeps): void {
  if (deps.allowTestOnlyObservabilityExecution !== true) {
    throwRetiredObservability(
      "TS_RUNTIME_OBSERVABILITY_RETIRED",
      "TypeScript observability alert/SLO mutation",
      "observability_alert_engine",
    );
  }
}

function assertHeartbeatTestOracleAllowed(deps: FridayObservabilityRoutesDeps): void {
  if (deps.allowTestOnlyHeartbeatExecution !== true) {
    throwRetiredObservability(
      "TS_RUNTIME_HEARTBEAT_TRIGGER_RETIRED",
      "TypeScript heartbeat trigger execution",
      "heartbeat_trigger",
    );
  }
}

// ─── Factory ───

export function createFridayObservabilityRoutes(
  deps: FridayObservabilityRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "observability.overview",
      method: "GET",
      path: "/v1/observability/overview",
      auth: { public: true },
      async handler() {
        return deps.overview.get();
      },
    },
    {
      operationId: "observability.time.series",
      method: "GET",
      path: "/v1/observability/time-series",
      auth: { public: true },
      async handler(ctx) {
        return deps.timeSeries.get(ctx.query as FridayGetObservabilityTimeSeriesQuery);
      },
    },
    // ═══════════════════════════════════════════════════════════════
    // TRACES
    // ═══════════════════════════════════════════════════════════════

    {
      operationId: "observability.traces.search",
      method: "GET",
      path: "/v1/observability/traces",
      auth: { public: true },
      async handler(ctx) {
        return deps.traces.search(ctx.query as FridaySearchTracesQuery);
      },
    },
    {
      operationId: "observability.traces.get",
      method: "GET",
      path: "/v1/observability/traces/:traceId",
      auth: { public: true },
      async handler(ctx) {
        const { traceId } = ctx.params as { traceId: string };
        return deps.traces.get(traceId);
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // AUDIT
    // ═══════════════════════════════════════════════════════════════

    {
      operationId: "observability.audit.search",
      method: "GET",
      path: "/v1/observability/audit",
      auth: { public: true },
      async handler(ctx) {
        return deps.audit.search(ctx.query as FridaySearchAuditEntriesQuery);
      },
    },
    {
      operationId: "observability.audit.get",
      method: "GET",
      path: "/v1/observability/audit/:entryId",
      auth: { public: true },
      async handler(ctx) {
        const { entryId } = ctx.params as { entryId: UUID };
        return deps.audit.get(entryId);
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // SLOs
    // ═══════════════════════════════════════════════════════════════

    {
      operationId: "observability.slos.list",
      method: "GET",
      path: "/v1/observability/slos",
      auth: { public: true },
      async handler(ctx) {
        return deps.slos.list(ctx.query as FridayListSlosQuery);
      },
    },
    {
      operationId: "observability.slos.get",
      method: "GET",
      path: "/v1/observability/slos/:sloId",
      auth: { public: true },
      async handler(ctx) {
        const { sloId } = ctx.params as { sloId: UUID };
        return deps.slos.get(sloId);
      },
    },
    {
      operationId: "observability.slos.create",
      method: "POST",
      path: "/v1/observability/slos",
      auth: { public: true },
      async handler(ctx) {
        const body = ctx.body as { name: string; sliMetric: Record<string, unknown>; target: number; description?: string; complianceWindowDays?: number; enabled?: boolean; tags?: string[] };
        if (!body || typeof body.name !== "string" || body.name.trim() === "") {
          throw new FridayDomainError("VALIDATION_ERROR", "name is required", { httpStatus: 400 });
        }
        if (typeof body.target !== "number" || body.target <= 0 || body.target > 100) {
          throw new FridayDomainError("VALIDATION_ERROR", "target must be between 0 and 100", { httpStatus: 400 });
        }
        assertObservabilityTestOracleAllowed(deps);
        return deps.slos.create(body);
      },
    },
    {
      operationId: "observability.slos.update",
      method: "PUT",
      path: "/v1/observability/slos/:sloId",
      auth: { public: true },
      async handler(ctx) {
        const { sloId } = ctx.params as { sloId: UUID };
        const body = ctx.body as { etag: string; name?: string; description?: string; target?: number; complianceWindowDays?: number; enabled?: boolean; tags?: string[] };
        if (!body || typeof body.etag !== "string") {
          throw new FridayDomainError("VALIDATION_ERROR", "etag is required", { httpStatus: 400 });
        }
        assertObservabilityTestOracleAllowed(deps);
        return deps.slos.update(sloId, body);
      },
    },
    {
      operationId: "observability.slos.delete",
      method: "DELETE",
      path: "/v1/observability/slos/:sloId",
      auth: { public: true },
      async handler(ctx) {
        const { sloId } = ctx.params as { sloId: UUID };
        const etag = (ctx.query as Record<string, string>).etag ?? ((ctx.body as Record<string, string> | null)?.etag);
        if (typeof etag !== "string" || etag.trim() === "") {
          throw new FridayDomainError("VALIDATION_ERROR", "etag is required", { httpStatus: 400 });
        }
        assertObservabilityTestOracleAllowed(deps);
        return deps.slos.delete(sloId, etag);
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // ALERTS
    // ═══════════════════════════════════════════════════════════════

    {
      operationId: "observability.alerts.list",
      method: "GET",
      path: "/v1/observability/alerts",
      auth: { public: true },
      async handler(ctx) {
        return deps.alerts.list(ctx.query as FridayListAlertsQuery);
      },
    },
    {
      operationId: "observability.alerts.get",
      method: "GET",
      path: "/v1/observability/alerts/:alertId",
      auth: { public: true },
      async handler(ctx) {
        const { alertId } = ctx.params as { alertId: UUID };
        return deps.alerts.get(alertId);
      },
    },
    {
      operationId: "observability.alerts.acknowledge",
      method: "POST",
      path: "/v1/observability/alerts/:alertId/acknowledge",
      auth: { public: true },
      async handler(ctx) {
        const { alertId } = ctx.params as { alertId: UUID };
        const body = (ctx.body ?? {}) as FridayAcknowledgeAlertRequest;
        assertObservabilityTestOracleAllowed(deps);
        return deps.alerts.acknowledge(alertId, body);
      },
    },
    {
      operationId: "observability.alerts.test.dispatch",
      method: "POST",
      path: "/v1/observability/alerts/:alertId/test-dispatch",
      auth: { public: true },
      async handler(ctx) {
        const { alertId } = ctx.params as { alertId: UUID };
        return deps.alerts.testDispatch(
          alertId,
          ((ctx.body ?? {}) as FridayTestAlertDispatchRequest),
        );
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // ALERT DESTINATIONS
    // ═══════════════════════════════════════════════════════════════

    {
      operationId: "observability.alert.destinations.list",
      method: "GET",
      path: "/v1/observability/alert-destinations",
      auth: { public: true },
      async handler() {
        return deps.alertDestinations.list();
      },
    },
    {
      operationId: "observability.alert.destinations.create",
      method: "POST",
      path: "/v1/observability/alert-destinations",
      auth: { public: true },
      async handler(ctx) {
        assertObservabilityTestOracleAllowed(deps);
        return deps.alertDestinations.create(ctx.body as FridayCreateAlertDestinationRequest);
      },
    },
    {
      operationId: "observability.alert.destinations.update",
      method: "PATCH",
      path: "/v1/observability/alert-destinations/:destinationId",
      auth: { public: true },
      async handler(ctx) {
        const { destinationId } = ctx.params as { destinationId: UUID };
        assertObservabilityTestOracleAllowed(deps);
        return deps.alertDestinations.update(
          destinationId,
          ctx.body as FridayUpdateAlertDestinationRequest,
        );
      },
    },
    {
      operationId: "observability.alert.destinations.delete",
      method: "DELETE",
      path: "/v1/observability/alert-destinations/:destinationId",
      auth: { public: true },
      async handler(ctx) {
        const { destinationId } = ctx.params as { destinationId: UUID };
        assertObservabilityTestOracleAllowed(deps);
        return deps.alertDestinations.delete(destinationId);
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // ALERT RULES
    // ═══════════════════════════════════════════════════════════════

    {
      operationId: "observability.alert.rules.list",
      method: "GET",
      path: "/v1/observability/alert-rules",
      auth: { public: true },
      async handler(ctx) {
        return deps.alertRules.list(ctx.query as FridayListAlertRulesQuery);
      },
    },
    {
      operationId: "observability.alert.rules.get",
      method: "GET",
      path: "/v1/observability/alert-rules/:ruleId",
      auth: { public: true },
      async handler(ctx) {
        const { ruleId } = ctx.params as { ruleId: UUID };
        return deps.alertRules.get(ruleId);
      },
    },
    {
      operationId: "observability.alert.rules.create",
      method: "POST",
      path: "/v1/observability/alert-rules",
      auth: { public: true },
      async handler(ctx) {
        const body = ctx.body as FridayCreateAlertRuleRequest;
        if (!body || typeof body.name !== "string" || body.name.trim() === "") {
          throw new FridayDomainError("VALIDATION_ERROR", "name is required");
        }
        if (!body.condition) {
          throw new FridayDomainError("VALIDATION_ERROR", "condition is required");
        }
        assertObservabilityTestOracleAllowed(deps);
        return deps.alertRules.create(body);
      },
    },
    {
      operationId: "observability.alert.rules.update",
      method: "PUT",
      path: "/v1/observability/alert-rules/:ruleId",
      auth: { public: true },
      async handler(ctx) {
        const { ruleId } = ctx.params as { ruleId: UUID };
        const body = ctx.body as FridayUpdateAlertRuleRequest;
        if (!body || typeof body.etag !== "string" || body.etag.trim() === "") {
          throw new FridayDomainError("VALIDATION_ERROR", "etag is required");
        }
        assertObservabilityTestOracleAllowed(deps);
        return deps.alertRules.update(ruleId, body);
      },
    },
    {
      operationId: "observability.alert.rules.delete",
      method: "DELETE",
      path: "/v1/observability/alert-rules/:ruleId",
      auth: { public: true },
      async handler(ctx) {
        const { ruleId } = ctx.params as { ruleId: UUID };
        const body = ctx.body as FridayDeleteAlertRuleRequest;
        if (!body || typeof body.etag !== "string" || body.etag.trim() === "") {
          throw new FridayDomainError("VALIDATION_ERROR", "etag is required");
        }
        assertObservabilityTestOracleAllowed(deps);
        return deps.alertRules.delete(ruleId, body);
      },
    },
    // ─── Metrics endpoint ───
    ...(deps.metrics
      ? [
          {
            operationId: "observability.metrics.snapshot",
            method: "GET" as const,
            path: "/v1/observability/metrics",
            auth: { public: true } as const,
            async handler() {
              return deps.metrics!.getSnapshot();
            },
          },
        ]
      : []),
    // ─── Heartbeat status endpoint ───
    ...(deps.heartbeat?.getStatus
      ? [
          {
            operationId: "observability.heartbeat.status",
            method: "GET" as const,
            path: "/v1/heartbeat/status",
            auth: { public: true } as const,
            async handler() {
              return deps.heartbeat!.getStatus!();
            },
          },
        ]
      : []),
    ...(deps.heartbeat?.trigger
      ? [
          {
            operationId: "observability.heartbeat.trigger",
            method: "POST" as const,
            path: "/v1/heartbeat/trigger",
            auth: { public: true } as const,
            async handler() {
              assertHeartbeatTestOracleAllowed(deps);
              return deps.heartbeat!.trigger!();
            },
          },
        ]
      : []),
  ];
}
