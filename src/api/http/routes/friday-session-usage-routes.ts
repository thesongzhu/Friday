/**
 * OC-012: Session usage endpoint — aggregated token/cost usage per session.
 */

import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { FridaySqliteLayer } from "#state";

// ─── Types ───

export interface FridaySessionUsageRoutesDeps {
  db: FridaySqliteLayer;
}

interface UsageByModelRow {
  provider_id: string;
  model: string;
  total_input: number;
  total_output: number;
  total_cost: number;
  run_count: number;
}

interface BulkUsageRow {
  session_key: string;
  total_input: number;
  total_output: number;
  total_cost: number;
  run_count: number;
}

// ─── Factory ───

export function createFridaySessionUsageRoutes(
  deps: FridaySessionUsageRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  const { db } = deps;

  return [
    // GET /v1/sessions/:sessionKey/usage — per-session aggregated usage
    {
      operationId: "sessions.usage.get",
      method: "GET",
      path: "/v1/sessions/:sessionKey/usage",
      auth: { public: false, anyOfScopes: ["hub.admin"] },

      async handler(ctx) {
        const { sessionKey } = ctx.params as { sessionKey: string };

        const rows = db.withReadConnection((conn) =>
          conn
            .prepare(
              `SELECT
                 provider_id,
                 model,
                 COALESCE(SUM(usage_input), 0)  AS total_input,
                 COALESCE(SUM(usage_output), 0) AS total_output,
                 COALESCE(SUM(cost_usd), 0)     AS total_cost,
                 COUNT(*)                        AS run_count
               FROM friday_agent_runs
               WHERE session_key = ?
               GROUP BY provider_id, model
               ORDER BY total_cost DESC`,
            )
            .all(sessionKey),
        ) as UsageByModelRow[];

        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalCostUsd = 0;
        let totalRuns = 0;

        const byModel = rows.map((r) => {
          totalInputTokens += r.total_input;
          totalOutputTokens += r.total_output;
          totalCostUsd += r.total_cost;
          totalRuns += r.run_count;
          return {
            providerId: r.provider_id,
            model: r.model,
            inputTokens: r.total_input,
            outputTokens: r.total_output,
            costUsd: r.total_cost,
            runs: r.run_count,
          };
        });

        return {
          sessionKey,
          totalInputTokens,
          totalOutputTokens,
          totalCostUsd,
          totalRuns,
          byModel,
        };
      },
    },

    // GET /v1/sessions/usage — bulk summary across all sessions
    {
      operationId: "sessions.usage.list",
      method: "GET",
      path: "/v1/sessions/usage",
      auth: { public: false, anyOfScopes: ["hub.admin"] },

      async handler(ctx) {
        const query = ctx.query as Record<string, string | undefined>;
        let limit = 50;
        if (query.limit !== undefined) {
          const parsed = Number(query.limit);
          if (Number.isInteger(parsed) && parsed >= 1) {
            limit = Math.min(parsed, 200);
          }
        }

        const rows = db.withReadConnection((conn) =>
          conn
            .prepare(
              `SELECT
                 session_key,
                 COALESCE(SUM(usage_input), 0)  AS total_input,
                 COALESCE(SUM(usage_output), 0) AS total_output,
                 COALESCE(SUM(cost_usd), 0)     AS total_cost,
                 COUNT(*)                        AS run_count
               FROM friday_agent_runs
               GROUP BY session_key
               ORDER BY total_cost DESC
               LIMIT ?`,
            )
            .all(limit),
        ) as BulkUsageRow[];

        return {
          items: rows.map((r) => ({
            sessionKey: r.session_key,
            totalInputTokens: r.total_input,
            totalOutputTokens: r.total_output,
            totalCostUsd: r.total_cost,
            totalRuns: r.run_count,
          })),
        };
      },
    },
  ];
}
