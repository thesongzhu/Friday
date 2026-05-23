import { FridayDomainError } from "#errors";

import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import { assertBoundPrincipalAuthorityForOperation } from "../../../security/friday-owner-session-channel-capability.js";
import type {
  FridayGetConfigQuery,
  FridayGetConfigResponse,
  FridayGetVersionResponse,
  FridayListAuditLogsQuery,
  FridayListAuditLogsResponse,
  FridayListConfigRevisionsQuery,
  FridayListConfigRevisionsResponse,
  FridayRevertConfigRequest,
  FridayRevertConfigResponse,
  FridayUpdateConfigRequest,
  FridayUpdateConfigResponse,
} from "../../model/friday-api-runtime-admin.types.js";

export interface FridayRuntimeAdminRoutesDeps {
  version: {
    get(): FridayGetVersionResponse | Promise<FridayGetVersionResponse>;
  };
  config?: {
    get(query: FridayGetConfigQuery): FridayGetConfigResponse | Promise<FridayGetConfigResponse>;
    update(
      request: FridayUpdateConfigRequest,
    ): FridayUpdateConfigResponse | Promise<FridayUpdateConfigResponse>;
    listRevisions(
      query: FridayListConfigRevisionsQuery,
    ): FridayListConfigRevisionsResponse | Promise<FridayListConfigRevisionsResponse>;
    revert(
      request: FridayRevertConfigRequest,
    ): FridayRevertConfigResponse | Promise<FridayRevertConfigResponse>;
  };
  auditLogs?: {
    list(query: FridayListAuditLogsQuery): FridayListAuditLogsResponse | Promise<FridayListAuditLogsResponse>;
  };
}

function readStringArrayQuery(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const items = value.split(",").map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  if (Array.isArray(value)) {
    const items = value
      .filter((entry): entry is string => typeof entry === "string")
      .flatMap((entry) => entry.split(","))
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

function assertRuntimeConfigAdminPrincipal(
  principal: Parameters<typeof assertBoundPrincipalAuthorityForOperation>[0],
  operation: "runtime.config.update" | "runtime.config.revert",
): void {
  assertBoundPrincipalAuthorityForOperation(principal, operation, "api", {
    anyOfScopes: ["hub.admin"],
    anyOfRoles: ["owner", "admin"],
  });
}

export function createFridayRuntimeAdminRoutes(
  deps: FridayRuntimeAdminRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  const routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[] = [
    {
      operationId: "version.get",
      method: "GET",
      path: "/v1/version",
      auth: { public: true },
      async handler() {
        return deps.version.get();
      },
    },
  ];

  if (deps.config) {
    routes.push(
      {
        operationId: "config.get",
        method: "GET",
        path: "/v1/config",
        auth: { public: true },
        async handler(ctx) {
          const query = ctx.query as Record<string, unknown>;
          return deps.config!.get({
            keys: readStringArrayQuery(query.keys),
          });
        },
      },
      {
        operationId: "config.update",
        method: "PATCH",
        path: "/v1/config",
        auth: { public: true },
        async handler(ctx) {
          assertRuntimeConfigAdminPrincipal(ctx.principal ?? null, "runtime.config.update");
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          if (!Number.isInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) {
            throw new FridayDomainError("VALIDATION_ERROR", "expectedRevision must be a positive integer", {
              httpStatus: 400,
            });
          }
          if (body.patch == null || typeof body.patch !== "object" || Array.isArray(body.patch)) {
            throw new FridayDomainError("VALIDATION_ERROR", "patch must be an object", {
              httpStatus: 400,
            });
          }
          return deps.config!.update({
            expectedRevision: Number(body.expectedRevision),
            patch: body.patch as Record<string, unknown>,
            reason: typeof body.reason === "string" && body.reason.trim() !== "" ? body.reason : undefined,
          });
        },
      },
      {
        operationId: "config.revisions.list",
        method: "GET",
        path: "/v1/config/revisions",
        auth: { public: true },
        async handler(ctx) {
          const query = ctx.query as Record<string, unknown>;
          const limit =
            typeof query.limit === "string" && query.limit.trim() !== ""
              ? Number.parseInt(query.limit, 10)
              : typeof query.limit === "number"
                ? Math.trunc(query.limit)
                : undefined;
          if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
            throw new FridayDomainError("VALIDATION_ERROR", "limit must be a positive integer", {
              httpStatus: 400,
            });
          }
          return deps.config!.listRevisions({
            cursor: typeof query.cursor === "string" && query.cursor.trim() !== "" ? query.cursor : undefined,
            limit,
          });
        },
      },
      {
        operationId: "config.revisions.revert",
        method: "POST",
        path: "/v1/config/revert",
        auth: { public: true },
        async handler(ctx) {
          assertRuntimeConfigAdminPrincipal(ctx.principal ?? null, "runtime.config.revert");
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          if (!Number.isInteger(body.toRevision) || Number(body.toRevision) < 1) {
            throw new FridayDomainError("VALIDATION_ERROR", "toRevision must be a positive integer", {
              httpStatus: 400,
            });
          }
          return deps.config!.revert({ toRevision: Number(body.toRevision) });
        },
      },
    );
  }

  if (deps.auditLogs) {
    routes.push({
      operationId: "audit.logs.list",
      method: "GET",
      path: "/v1/audit/logs",
      auth: { public: true },
      async handler(ctx) {
        return deps.auditLogs!.list(ctx.query as FridayListAuditLogsQuery);
      },
    });
  }

  return routes;
}
