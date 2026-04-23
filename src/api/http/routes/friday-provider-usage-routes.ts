import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";

import type {
  FridayGetBudgetStatusResponse,
  FridayGetUsageSummaryResponse,
  FridaySetBudgetConfigRequest,
  FridaySetBudgetConfigResponse,
} from "../../model/friday-api-provider.types.js";

import type { FridayProviderService } from "#providers";
import { FridayDomainError } from "#errors";

// ─── Dependencies ───

export interface FridayProviderUsageRoutesDeps {
  providerService: FridayProviderService;
}

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
      auth: { public: false, anyOfScopes: ["hub.admin"] },
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
      auth: { public: false, anyOfScopes: ["hub.admin"] },
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
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      async handler(ctx): Promise<FridaySetBudgetConfigResponse> {
        validateBudgetBody(ctx.body);
        const body = ctx.body;
        const budget = await deps.providerService.setBudgetConfig(body);
        return { budget };
      },
    },
  ];
}
