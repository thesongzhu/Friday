import type { FridayAuthPrincipal, FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { UUID } from "#workflows";
import type {
  FridayListFleetSatellitesQuery,
} from "../../model/friday-api-fleet.types.js";
import type { FridayFleetDashboardService } from "../../fleet/friday-fleet-dashboard-service.types.js";
import { FridayDomainError } from "#errors";
import {
  type FridayCanonicalApprovalResolution,
  type FridayMutatingActionActor,
  type FridayMutatingActionGate,
  type FridayMutatingActionRequest,
  type FridayMutatingActionTicket,
} from "../../../security/friday-mutating-action-gate.js";

// ─── Constants ───

const FLEET_MAX_LIST_LIMIT = 100;

export interface FridayFleetRoutesDeps {
  fleetService: FridayFleetDashboardService;
  canonicalMutationGate?: FridayMutatingActionGate;
  /**
   * Test-oracle only: allow the legacy TypeScript fleet satellite remediation
   * execute mutation. Production/runtime callers must leave this unset so the
   * route fail-closes (503 TS_RUNTIME_FLEET_REMEDIATION_RETIRED) until Rust owns
   * fleet remediation. GET fleet reads are never gated.
   */
  allowTestOnlyFleetRemediationExecution?: boolean;
}

/**
 * TS-runtime retirement guard for the fleet remediation execute mutation.
 * Placed AFTER the canonical-approval gate (requireFleetRemediationTicket -> 403)
 * and IMMEDIATELY BEFORE executeSatelliteRemediationAction, so an unapproved
 * request still surfaces its 403 rather than this 503.
 */
function assertFleetRemediationTestOracleAllowed(deps: FridayFleetRoutesDeps): void {
  if (deps.allowTestOnlyFleetRemediationExecution === true) {
    return;
  }
  throw new FridayDomainError(
    "TS_RUNTIME_FLEET_REMEDIATION_RETIRED",
    "Fleet satellite remediation execution is fail-closed in the default/live runtime; the Rust-owned fleet remediation entrypoint is required.",
    {
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: "rust_owned_fleet_remediation_entrypoint_required",
      },
    },
  );
}

export function createFridayFleetRemediationMutatingActionRequest(input: {
  satelliteId: string;
  actionId: string;
  actor: FridayMutatingActionActor;
  surface: string;
  planDigest?: string;
  idempotencyKey?: string;
}): FridayMutatingActionRequest {
  return {
    action: "fleet.remediation.execute",
    actor: input.actor,
    surface: input.surface,
    resource: {
      type: "fleet_satellite_remediation",
      id: `${input.satelliteId}:${input.actionId}`,
      attributes: {
        satelliteId: input.satelliteId,
        actionId: input.actionId,
      },
    },
    mutating: true,
    risk: "high",
    parameters: {
      satelliteId: input.satelliteId,
      actionId: input.actionId,
    },
    planDigest: input.planDigest,
    idempotencyKey: input.idempotencyKey,
    localClaims: [
      {
        guardId: "fleet_remediation_guard",
        decision: "requires_approval",
        risk: "high",
        reason: "fleet_remediation_execute_requires_canonical_approval",
      },
    ],
  };
}

function createActorFromPrincipal(
  principal: FridayAuthPrincipal | null,
  fallbackId: string,
): FridayMutatingActionActor {
  if (!principal) {
    return {
      kind: "api",
      id: fallbackId,
      principalId: fallbackId,
    };
  }
  return {
    kind: principal.principalType,
    id: principal.principalId,
    principalId: principal.principalId,
  };
}

function readCanonicalApproval(value: unknown): FridayCanonicalApprovalResolution | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as FridayCanonicalApprovalResolution;
  }
  throw new FridayDomainError("VALIDATION_ERROR", "canonicalApproval must be an object", { httpStatus: 400 });
}

function requireFleetRemediationTicket(input: {
  deps: FridayFleetRoutesDeps;
  satelliteId: string;
  actionId: string;
  body: Record<string, unknown>;
  actor: FridayMutatingActionActor;
  surface: string;
}): FridayMutatingActionTicket {
  if (!input.deps.canonicalMutationGate) {
    throw new FridayDomainError(
      "FLEET_REMEDIATION_CANONICAL_GATE_UNAVAILABLE",
      "Fleet remediation actions require the canonical approval gate.",
      { httpStatus: 503 },
    );
  }
  const planDigest = typeof input.body.planDigest === "string" ? input.body.planDigest : undefined;
  if (!planDigest) {
    throw new FridayDomainError(
      "FLEET_REMEDIATION_PLAN_DIGEST_REQUIRED",
      "Fleet remediation actions require an approved plan digest.",
      { httpStatus: 403, details: { satelliteId: input.satelliteId, actionId: input.actionId } },
    );
  }
  const request = createFridayFleetRemediationMutatingActionRequest({
    satelliteId: input.satelliteId,
    actionId: input.actionId,
    actor: input.actor,
    surface: input.surface,
    planDigest,
    idempotencyKey: typeof input.body.idempotencyKey === "string" ? input.body.idempotencyKey : undefined,
  });
  const gateResult = input.deps.canonicalMutationGate.evaluate({
    ...request,
    canonicalApproval: readCanonicalApproval(input.body.canonicalApproval),
  });
  if (gateResult.decision !== "allow" || !gateResult.ticket) {
    throw new FridayDomainError(
      gateResult.decision === "requires_approval"
        ? "CANONICAL_APPROVAL_REQUIRED"
        : "CANONICAL_APPROVAL_DENIED",
      gateResult.decision === "requires_approval"
        ? "Fleet remediation requires canonical approval before any mutation."
        : `Fleet remediation was blocked by the canonical approval gate: ${gateResult.reason}`,
      {
        httpStatus: 403,
        details: {
          canonicalGate: gateResult.evidenceRecord,
          actionDigest: gateResult.actionDigest,
        },
      },
    );
  }
  return gateResult.ticket;
}

export function createFridayFleetRoutes(
  deps: FridayFleetRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "fleet.overview",
      method: "GET",
      path: "/v1/fleet/overview",
      auth: { public: true },
      async handler() {
        return deps.fleetService.getOverview();
      },
    },
    {
      operationId: "fleet.list.satellites",
      method: "GET",
      path: "/v1/fleet/satellites",
      auth: { public: true },
      async handler(ctx) {
        const query = ctx.query as Record<string, string | undefined>;
        let limit: number | undefined;
        if (query.limit !== undefined) {
          const parsed = Number(query.limit);
          if (!Number.isInteger(parsed) || parsed < 1) {
            throw new FridayDomainError(
              "VALIDATION_ERROR",
              "limit must be a positive integer",
              { httpStatus: 400 },
            );
          }
          limit = Math.min(parsed, FLEET_MAX_LIST_LIMIT);
        }
        const sanitised: FridayListFleetSatellitesQuery = {
          ...query,
          limit,
          cursor: query.cursor,
        };
        return deps.fleetService.listSatellites(sanitised);
      },
    },
    {
      operationId: "fleet.get.satellite.detail",
      method: "GET",
      path: "/v1/fleet/satellites/:satelliteId",
      auth: { public: true },
      async handler(ctx) {
        const { satelliteId } = ctx.params as { satelliteId: UUID };
        const detail = deps.fleetService.getSatelliteDetail(satelliteId);
        if (!detail) {
          throw new FridayDomainError(
            "SATELLITE_NOT_FOUND",
            `Satellite '${satelliteId}' not found`,
            { httpStatus: 404 },
          );
        }
        return detail;
      },
    },
    {
      operationId: "fleet.get.satellite.remediation",
      method: "GET",
      path: "/v1/fleet/satellites/:satelliteId/remediation",
      auth: { public: true },
      async handler(ctx) {
        const { satelliteId } = ctx.params as { satelliteId: UUID };
        const remediation = deps.fleetService.getSatelliteRemediationPlan(satelliteId);
        if (!remediation) {
          throw new FridayDomainError(
            "SATELLITE_NOT_FOUND",
            `Satellite '${satelliteId}' not found`,
            { httpStatus: 404 },
          );
        }
        return remediation;
      },
    },
    {
      operationId: "fleet.execute.satellite.remediation",
      method: "POST",
      path: "/v1/fleet/satellites/:satelliteId/remediation/:actionId/execute",
      auth: { public: true },
      async handler(ctx) {
        const { satelliteId, actionId } = ctx.params as {
          satelliteId: UUID;
          actionId: string;
        };
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const ticket = requireFleetRemediationTicket({
          deps,
          satelliteId,
          actionId,
          body,
          actor: createActorFromPrincipal(ctx.principal, `api:${ctx.requestId}`),
          surface: "api:/v1/fleet/satellites/remediation/execute",
        });
        assertFleetRemediationTestOracleAllowed(deps);
        const result = await deps.fleetService.executeSatelliteRemediationAction({
          satelliteId,
          actionId,
        });
        return {
          ...result,
          canonicalGate: {
            ticketId: ticket.ticketId,
            actionDigest: ticket.actionDigest,
            approvalId: ticket.approvalId,
            planDigest: ticket.planDigest,
          },
        };
      },
    },
  ];
}
