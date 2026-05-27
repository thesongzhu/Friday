import type { FridayAuthPrincipal, FridayRouteDefinition } from "../../model/friday-api-common.types.js";

import type {
  FridayGetBudgetStatusResponse,
  FridayGetUsageSummaryResponse,
  FridaySetBudgetConfigRequest,
  FridaySetBudgetConfigResponse,
} from "../../model/friday-api-provider.types.js";

import type { FridayProviderService } from "#providers";
import { FridayDomainError } from "#errors";
import {
  type FridayCanonicalApprovalResolution,
  type FridayMutatingActionActor,
  type FridayMutatingActionGate,
  type FridayMutatingActionTicket,
} from "../../../security/friday-mutating-action-gate.js";
import { createFridayProviderSetupMutatingActionRequest } from "./friday-provider-routes.js";

// ─── Dependencies ───

export interface FridayProviderUsageRoutesDeps {
  providerService: FridayProviderService;
  canonicalMutationGate?: FridayMutatingActionGate;
  providerMutationGateRequired?: boolean;
}

type BudgetMutationBody = FridaySetBudgetConfigRequest & {
  planDigest?: string;
  idempotencyKey?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
};

// ─── Budget validation ───

function validateBudgetBody(body: unknown): asserts body is FridaySetBudgetConfigRequest {
  if (body == null || typeof body !== "object") {
    throw new FridayDomainError("VALIDATION_ERROR", "Request body is required", { httpStatus: 400 });
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof b.monthlyLimitUsd !== "number" || !Number.isFinite(b.monthlyLimitUsd) || b.monthlyLimitUsd <= 0) {
    errors.push("monthlyLimitUsd is required and must be a positive number");
  }

  if (errors.length > 0) {
    throw new FridayDomainError("VALIDATION_ERROR", `Invalid request body: ${errors.join("; ")}`, { httpStatus: 400 });
  }
}

function getDefaultUtcUsageRange(receivedAt: string | undefined): { from: string; to: string } {
  const received = receivedAt ? new Date(receivedAt) : new Date();
  const safeDate = Number.isNaN(received.getTime()) ? new Date() : received;
  // llm_usage_records.usage_day is written from ISO UTC dates, so default
  // queries must use the same UTC boundary or late-evening local usage disappears.
  const to = safeDate.toISOString().slice(0, 10);
  return {
    from: `${to.slice(0, 7)}-01`,
    to,
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

function canonicalGateEvidence(ticket: FridayMutatingActionTicket | undefined): {
  ticketId: string;
  actionDigest: string;
  approvalId: string;
  planDigest?: string;
} | undefined {
  if (!ticket) {
    return undefined;
  }
  return {
    ticketId: ticket.ticketId,
    actionDigest: ticket.actionDigest,
    approvalId: ticket.approvalId,
    planDigest: ticket.planDigest,
  };
}

function withCanonicalGate<T extends object>(
  payload: T,
  ticket: FridayMutatingActionTicket | undefined,
): T & { canonicalGate?: NonNullable<ReturnType<typeof canonicalGateEvidence>> } {
  const evidence = canonicalGateEvidence(ticket);
  return evidence ? { ...payload, canonicalGate: evidence } : payload;
}

function maybeRequireBudgetMutationTicket(input: {
  deps: FridayProviderUsageRoutesDeps;
  ctx: { requestId: string; principal: FridayAuthPrincipal | null };
  body: BudgetMutationBody;
}): FridayMutatingActionTicket | undefined {
  if (!input.deps.providerMutationGateRequired) {
    return undefined;
  }
  if (!input.deps.canonicalMutationGate) {
    throw new FridayDomainError(
      "PROVIDER_MUTATION_CANONICAL_GATE_UNAVAILABLE",
      "Provider budget mutations require the canonical approval gate in this profile.",
      { httpStatus: 503 },
    );
  }
  if (!input.body.planDigest) {
    throw new FridayDomainError(
      "PROVIDER_MUTATION_PLAN_DIGEST_REQUIRED",
      "Provider budget mutations require an approved plan digest in this profile.",
      { httpStatus: 403, details: { action: "providers.budget.set", resourceId: "llm.budget.v1" } },
    );
  }

  const parameters = { monthlyLimitUsd: input.body.monthlyLimitUsd };
  const request = createFridayProviderSetupMutatingActionRequest({
    action: "providers.budget.set",
    actor: createActorFromPrincipal(input.ctx.principal, `api:${input.ctx.requestId}`),
    surface: "api:/v1/providers/budget",
    resourceId: "llm.budget.v1",
    parameters,
    planDigest: input.body.planDigest,
    idempotencyKey: input.body.idempotencyKey,
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
        ? "Provider budget mutation requires canonical approval before any budget setting is changed."
        : `Provider budget mutation was blocked by the canonical approval gate: ${gateResult.reason}`,
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

// ─── Factory ───

export function createFridayProviderUsageRoutes(
  deps: FridayProviderUsageRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    // ─── Get usage summary ───
    {
      operationId: "providers.usage.get",
      method: "GET",
      path: "/v1/providers/usage",
      auth: { public: true },
      async handler(ctx): Promise<FridayGetUsageSummaryResponse> {
        const query = ctx.query as Record<string, string | undefined>;
        // DX-004: Default 'from' to start of current month, 'to' to today
        const defaults = getDefaultUtcUsageRange(ctx.receivedAt);
        const from = query.from ?? defaults.from;
        const to = query.to ?? defaults.to;

        if (!from || !to) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "Query parameters 'from' and 'to' are required (YYYY-MM-DD)",
            { httpStatus: 400 },
          );
        }

        // Validate date format
        const datePattern = /^\d{4}-\d{2}-\d{2}$/;
        if (!datePattern.test(from) || !datePattern.test(to)) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "Query parameters 'from' and 'to' must be in YYYY-MM-DD format",
            { httpStatus: 400 },
          );
        }

        const groupByRaw = query.groupBy ?? "day";
        if (groupByRaw !== "day" && groupByRaw !== "provider" && groupByRaw !== "model") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "Query parameter 'groupBy' must be one of: day, provider, model",
            { httpStatus: 400 },
          );
        }

        const summary = await deps.providerService.getUsageSummary({
          from,
          to,
          groupBy: groupByRaw,
          providerId: query.providerId,
          model: query.model,
        });

        return { summary };
      },
    },

    // ─── Get budget status ───
    {
      operationId: "providers.budget.get",
      method: "GET",
      path: "/v1/providers/budget",
      auth: { public: true },
      async handler(): Promise<FridayGetBudgetStatusResponse> {
        const budget = await deps.providerService.getBudgetStatus();
        return { budget };
      },
    },

    // ─── Set budget config ───
    {
      operationId: "providers.budget.set",
      method: "PUT",
      path: "/v1/providers/budget",
      auth: { public: true },
      async handler(ctx): Promise<FridaySetBudgetConfigResponse> {
        validateBudgetBody(ctx.body);
        const body = ctx.body as BudgetMutationBody;
        const ticket = maybeRequireBudgetMutationTicket({ deps, ctx, body });
        const budget = await deps.providerService.setBudgetConfig({
          monthlyLimitUsd: body.monthlyLimitUsd,
        });
        return withCanonicalGate({ budget }, ticket);
      },
    },
  ];
}
