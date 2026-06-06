/**
 * C-005 Program Discovery & Integration Recommendation Routes.
 *
 * REST endpoints for local program scanning, catalog retrieval,
 * integration recommendations, and discovery policy management.
 *
 * @module api/http/routes
 */

import { FridayDomainError } from "#errors";
import { throwFridayCapabilityDisabled } from "./friday-capability-disabled.js";
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
  /**
   * Test-oracle only: allow the legacy TypeScript discovery product-logic
   * mutations (scan = local-program discovery algorithm; policy.update =
   * in-memory policy mutation; integrate is in friday-discovery-integration-
   * routes.ts under the same flag). Production/runtime callers must leave this
   * unset so those POST/PATCH routes fail-close (503 TS_RUNTIME_DISCOVERY_RETIRED)
   * until Rust owns discovery. The GET catalog/programs/recommendations/policy/
   * status reads are never gated (recommend() product-logic is still reachable
   * via the GET /v1/discovery/recommendations read-derive — route-scoped).
   */
  allowTestOnlyDiscoveryExecution?: boolean;
}

// ─── Helpers ───

type Ctx = FridayHttpContext<unknown, Record<string, string>, unknown>;
type Route = FridayRouteDefinition<unknown, Record<string, string>, unknown, unknown>;

/**
 * TS-runtime retirement guard for the discovery product-logic routes (scan +
 * policy.update here; integrate in the integration-routes file). Placed AFTER
 * any body validation and IMMEDIATELY BEFORE the discovery service call.
 */
function assertDiscoveryTestOracleAllowed(deps: { allowTestOnlyDiscoveryExecution?: boolean }): void {
  if (deps.allowTestOnlyDiscoveryExecution === true) {
    return;
  }
  throw new FridayDomainError(
    "TS_RUNTIME_DISCOVERY_RETIRED",
    "Program discovery scan and policy mutation are fail-closed in the default/live runtime; the Rust-owned discovery entrypoint is required.",
    {
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: "rust_owned_discovery_entrypoint_required",
      },
    },
  );
}

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
      auth: { public: true },
      handler: async (_ctx: Ctx) => {
        assertDiscoveryTestOracleAllowed(deps);
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
      auth: { public: true },
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
      auth: { public: true },
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
      auth: { public: true },
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

        // TS-runtime retirement: this GET is normally a read, but recommend() falls
        // back to this.discover() (the scanner FS-enumeration) on a cache MISS — and
        // since discovery.scan is now fail-closed it can never warm the cache in
        // default/live, so an unguarded GET would deterministically execute the
        // retired scan product logic after every restart. Gate it under the same
        // discovery flag so the scan algorithm is fully closed in default/live.
        assertDiscoveryTestOracleAllowed(deps);
        const result = await deps.discovery.recommend(filter);
        return { status: 200, body: result };
      },
    },

    // ── Get Policy ──
    {
      operationId: "discovery.policy.get",
      method: "GET",
      path: "/v1/discovery/policy",
      auth: { public: true },
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
      auth: { public: true },
      handler: async (ctx: Ctx) => {
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const updates: Record<string, unknown> = {};

        if (typeof body.enabled === "boolean") updates.enabled = body.enabled;
        if (typeof body.scheduledRefreshEnabled === "boolean") updates.scheduledRefreshEnabled = body.scheduledRefreshEnabled;
        if (typeof body.refreshIntervalMs === "number") updates.refreshIntervalMs = body.refreshIntervalMs;
        if (Array.isArray(body.excludedPaths)) updates.excludedPaths = body.excludedPaths;
        if (Array.isArray(body.excludedProgramIds)) updates.excludedProgramIds = body.excludedProgramIds;
        if (typeof body.redactSensitiveDetails === "boolean") updates.redactSensitiveDetails = body.redactSensitiveDetails;

        assertDiscoveryTestOracleAllowed(deps);
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
      auth: { public: true },
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

export function createFridayDiscoveryDisabledRoutes(): Route[] {
  const unavailableMessage = "Program discovery is disabled. Enable FRIDAY_DISCOVERY_ENABLED=true to scan local programs.";

  const throwDisabled = (surface: string): never => throwFridayCapabilityDisabled({
    capability: "program_discovery",
    surface,
    message: unavailableMessage,
  });

  return [
    {
      operationId: "discovery.scan",
      method: "POST",
      path: "/v1/discovery/scan",
      auth: { public: true },
      handler: async () => throwDisabled("scan"),
    },
    {
      operationId: "discovery.catalog.get",
      method: "GET",
      path: "/v1/discovery/catalog",
      auth: { public: true },
      handler: async () => throwDisabled("catalog"),
    },
    {
      operationId: "discovery.programs.list",
      method: "GET",
      path: "/v1/discovery/programs",
      auth: { public: true },
      handler: async () => throwDisabled("programs"),
    },
    {
      operationId: "discovery.recommend",
      method: "GET",
      path: "/v1/discovery/recommendations",
      auth: { public: true },
      handler: async () => throwDisabled("recommendations"),
    },
    {
      operationId: "discovery.policy.get",
      method: "GET",
      path: "/v1/discovery/policy",
      auth: { public: true },
      handler: async () => ({
        status: 200,
        body: {
          policy: {
            enabled: false,
            scheduledRefreshEnabled: false,
            refreshIntervalMs: 86_400_000,
            excludedPaths: [],
            excludedProgramIds: [],
            redactSensitiveDetails: true,
          },
        },
      }),
    },
    {
      operationId: "discovery.policy.update",
      method: "PATCH",
      path: "/v1/discovery/policy",
      auth: { public: true },
      handler: async () => throwDisabled("policy"),
    },
    {
      operationId: "discovery.status",
      method: "GET",
      path: "/v1/discovery/status",
      auth: { public: true },
      handler: async () => ({
        status: 200,
        body: {
          enabled: false,
          hasCatalog: false,
          catalogId: null,
          lastScanAt: null,
          programCount: 0,
          unavailableReason: unavailableMessage,
        },
      }),
    },
  ];
}
