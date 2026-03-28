/**
 * C-005 Program Discovery & Integration Recommendation Routes.
 *
 * REST endpoints for local program scanning, catalog retrieval,
 * integration recommendations, and discovery policy management.
 *
 * @module api/http/routes
 */

import { FridayDomainError } from "#errors";
import type { FridayHttpContext, FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayDiscoveryFilterOptions,
  FridayDiscoveryPolicy,
  FridayProgramCatalog,
  FridayRecommendationResult,
} from "../../../skills/converter/discovery/friday-program-discovery.types.js";

// ─── Deps ───

export interface FridayDiscoveryRoutesDeps {
  discovery: {
    discover(): Promise<FridayProgramCatalog>;
    getCachedCatalog(): FridayProgramCatalog | null;
    recommend(filter?: FridayDiscoveryFilterOptions): Promise<FridayRecommendationResult>;
    getPolicy(): FridayDiscoveryPolicy;
    setPolicy(policy: Partial<FridayDiscoveryPolicy>): void;
    isEnabled(): boolean;
  };
}

// ─── Helpers ───

type Ctx = FridayHttpContext<unknown, Record<string, string>, unknown>;
type Route = FridayRouteDefinition<unknown, Record<string, string>, unknown, unknown>;

// ─── Factory ───

export function createFridayDiscoveryRoutes(
  deps: FridayDiscoveryRoutesDeps,
): Route[] {
  return [
    // ── Scan ──
    {
      operationId: "discovery.scan",
      method: "POST",
      path: "/v1/discovery/scan",
      auth: { public: false, anyOfScopes: ["desktop.read"] },
      handler: async (_ctx: Ctx) => {
        const catalog = await deps.discovery.discover();
        return {
          status: 200,
          body: {
            catalog: {
              id: catalog.id,
              platform: catalog.platform,
              programCount: catalog.programs.length,
              generatedAt: catalog.generatedAt,
              scanDurationMs: catalog.scanDurationMs,
              scanErrors: catalog.scanErrors,
            },
          },
        };
      },
    },

    // ── Get Catalog ──
    {
      operationId: "discovery.catalog.get",
      method: "GET",
      path: "/v1/discovery/catalog",
      auth: { public: false, anyOfScopes: ["desktop.read"] },
      handler: async (_ctx: Ctx) => {
        const catalog = deps.discovery.getCachedCatalog();
        if (!catalog) {
          throw new FridayDomainError("CATALOG_NOT_AVAILABLE", "No catalog available — run a scan first", { httpStatus: 404 });
        }
        return { status: 200, body: { catalog } };
      },
    },

    // ── List Programs ──
    {
      operationId: "discovery.programs.list",
      method: "GET",
      path: "/v1/discovery/programs",
      auth: { public: false, anyOfScopes: ["desktop.read"] },
      handler: async (ctx: Ctx) => {
        const catalog = deps.discovery.getCachedCatalog();
        if (!catalog) {
          throw new FridayDomainError("CATALOG_NOT_AVAILABLE", "No catalog available — run a scan first", { httpStatus: 404 });
        }

        const query = ctx.query ?? {};
        let programs = [...catalog.programs];

        if (query.category) {
          programs = programs.filter((p) => p.category === query.category);
        }

        if (query.q) {
          const q = query.q.toLowerCase();
          programs = programs.filter(
            (p) =>
              p.name.toLowerCase().includes(q) ||
              p.id.toLowerCase().includes(q),
          );
        }

        if (query.cli !== undefined) {
          const isCli = query.cli === "true";
          programs = programs.filter((p) => p.isCli === isCli);
        }

        return {
          status: 200,
          body: { programs, total: programs.length, catalogId: catalog.id },
        };
      },
    },

    // ── Get Recommendations ──
    {
      operationId: "discovery.recommend",
      method: "GET",
      path: "/v1/discovery/recommendations",
      auth: { public: false, anyOfScopes: ["desktop.read"] },
      handler: async (ctx: Ctx) => {
        const query = ctx.query ?? {};
        const filter: {
          category?: FridayDiscoveryFilterOptions["category"];
          minConfidence?: number;
          integrationPath?: FridayDiscoveryFilterOptions["integrationPath"];
          query?: string;
        } = {};

        if (query.category) filter.category = query.category as FridayDiscoveryFilterOptions["category"];
        if (query.minConfidence) filter.minConfidence = Number(query.minConfidence);
        if (query.integrationPath) filter.integrationPath = query.integrationPath as FridayDiscoveryFilterOptions["integrationPath"];
        if (query.q) filter.query = query.q;

        const result = await deps.discovery.recommend(filter);
        return { status: 200, body: result };
      },
    },

    // ── Get Policy ──
    {
      operationId: "discovery.policy.get",
      method: "GET",
      path: "/v1/discovery/policy",
      auth: { public: false, anyOfScopes: ["desktop.read"], anyOfRoles: ["admin", "operator"] },
      handler: async (_ctx: Ctx) => {
        const policy = deps.discovery.getPolicy();
        return { status: 200, body: { policy } };
      },
    },

    // ── Update Policy ──
    {
      operationId: "discovery.policy.update",
      method: "PATCH",
      path: "/v1/discovery/policy",
      auth: { public: false, anyOfScopes: ["desktop.write"], anyOfRoles: ["admin"] },
      handler: async (ctx: Ctx) => {
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const updates: Record<string, unknown> = {};

        if (typeof body.enabled === "boolean") updates.enabled = body.enabled;
        if (typeof body.scheduledRefreshEnabled === "boolean") updates.scheduledRefreshEnabled = body.scheduledRefreshEnabled;
        if (typeof body.refreshIntervalMs === "number") updates.refreshIntervalMs = body.refreshIntervalMs;
        if (Array.isArray(body.excludedPaths)) updates.excludedPaths = body.excludedPaths;
        if (Array.isArray(body.excludedProgramIds)) updates.excludedProgramIds = body.excludedProgramIds;
        if (typeof body.redactSensitiveDetails === "boolean") updates.redactSensitiveDetails = body.redactSensitiveDetails;

        deps.discovery.setPolicy(updates as Partial<FridayDiscoveryPolicy>);
        const policy = deps.discovery.getPolicy();
        return { status: 200, body: { policy } };
      },
    },

    // ── Check Status ──
    {
      operationId: "discovery.status",
      method: "GET",
      path: "/v1/discovery/status",
      auth: { public: false, anyOfScopes: ["desktop.read"] },
      handler: async (_ctx: Ctx) => {
        const enabled = deps.discovery.isEnabled();
        const catalog = deps.discovery.getCachedCatalog();
        return {
          status: 200,
          body: {
            enabled,
            hasCatalog: catalog !== null,
            catalogId: catalog?.id ?? null,
            lastScanAt: catalog?.generatedAt ?? null,
            programCount: catalog?.programs.length ?? 0,
          },
        };
      },
    },
  ];
}
