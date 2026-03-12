import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridaySubagentRegistry,
  FridaySubagentRunStatus,
} from "#agent";
import { FridayDomainError } from "#errors";
import { FRIDAY_SUBAGENT_ERROR_CODES } from "#agent";

// ─── Constants ───

const SUBAGENT_MAX_LIST_LIMIT = 100;

// ─── Deps ───

export interface FridaySubagentRoutesDeps {
  subagentRegistry: FridaySubagentRegistry;
}

// ─── Factory ───

export function createFridaySubagentRoutes(
  deps: FridaySubagentRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    // ─── GET /v1/agent/subagents ───
    {
      operationId: "agent.subagents.list",
      method: "GET",
      path: "/v1/agent/subagents",
      auth: { public: false, anyOfScopes: ["workflow.run"] },
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
          limit = Math.min(parsed, SUBAGENT_MAX_LIST_LIMIT);
        }

        const parentRunId = query.parentRunId;
        const status = query.status as FridaySubagentRunStatus | undefined;

        const items = deps.subagentRegistry.list({
          parentRunId,
          status,
          limit,
          cursor: query.cursor,
        });

        return { items };
      },
    },

    // ─── GET /v1/agent/subagents/:subagentId ───
    {
      operationId: "agent.subagents.get",
      method: "GET",
      path: "/v1/agent/subagents/:subagentId",
      auth: { public: false, anyOfScopes: ["workflow.run"] },
      async handler(ctx) {
        const { subagentId } = ctx.params as { subagentId: string };
        const subagent = deps.subagentRegistry.getById(subagentId);
        if (!subagent) {
          throw new FridayDomainError(
            FRIDAY_SUBAGENT_ERROR_CODES.NOT_FOUND,
            "Sub-agent not found",
            { httpStatus: 404 },
          );
        }
        return { subagent };
      },
    },

    // ─── GET /v1/agent/runs/:runId/subagents ───
    {
      operationId: "agent.runs.subagents.list",
      method: "GET",
      path: "/v1/agent/runs/:runId/subagents",
      auth: { public: false, anyOfScopes: ["workflow.run"] },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: string };
        const items = deps.subagentRegistry.listByParentRunId(runId);
        return { items };
      },
    },
  ];
}
