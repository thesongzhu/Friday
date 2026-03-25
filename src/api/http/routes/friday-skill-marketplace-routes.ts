/**
 * Skill Marketplace control-plane routes.
 *
 * Exposes source management, catalog discovery, install orchestration,
 * and sync operations from the canonical skill marketplace runtime.
 */

import type { FridayHttpContext, FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayMarketplaceCacheService,
  FridayMarketplaceDiscoveryService,
  FridayMarketplaceSourceEntity,
  FridayMarketplaceSourceService,
  FridayMarketplaceSyncService,
  FridayMarketplaceTrustPolicy,
  FridaySkillInstallationService,
} from "#skills";
import { FridayDomainError } from "#errors";

export interface FridaySkillMarketplaceRoutesDeps {
  sources: FridayMarketplaceSourceService;
  discovery: FridayMarketplaceDiscoveryService;
  installations: FridaySkillInstallationService;
  sync: FridayMarketplaceSyncService;
  cache: FridayMarketplaceCacheService;
}

type Ctx = FridayHttpContext<unknown, Record<string, string>, unknown>;
type Route = FridayRouteDefinition<unknown, Record<string, string>, unknown, unknown>;

const FRIDAY_MARKETPLACE_VALID_TRUST_POLICIES = [
  "strict",
  "warn",
  "permissive",
] as const satisfies readonly FridayMarketplaceTrustPolicy[];

function asRecord(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `"${field}" must be an array of strings`,
      { httpStatus: 400 },
    );
  }
  const items = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
  return items;
}

function parseOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw new FridayDomainError(
    "VALIDATION_ERROR",
    `"${field}" must be a boolean`,
    { httpStatus: 400 },
  );
}

function parsePositiveInteger(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number } = {},
): number | undefined {
  if (value === undefined) return undefined;
  const raw = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(raw) || raw <= 0 || !Number.isInteger(raw)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `"${field}" must be a positive integer`,
      { httpStatus: 400 },
    );
  }
  const min = opts.min ?? 1;
  const max = opts.max ?? Number.MAX_SAFE_INTEGER;
  if (raw < min || raw > max) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `"${field}" must be between ${String(min)} and ${String(max)}`,
      { httpStatus: 400 },
    );
  }
  return raw;
}

function parseTrustPolicy(value: unknown, field: string): FridayMarketplaceTrustPolicy {
  const parsed = asNonEmptyString(value);
  if (!parsed) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `"${field}" is required and must be a non-empty string`,
      { httpStatus: 400 },
    );
  }
  if (!(FRIDAY_MARKETPLACE_VALID_TRUST_POLICIES as readonly string[]).includes(parsed)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `"${field}" must be one of: ${FRIDAY_MARKETPLACE_VALID_TRUST_POLICIES.join(", ")}`,
      { httpStatus: 400 },
    );
  }
  return parsed as FridayMarketplaceTrustPolicy;
}

function buildSourceCreateInput(body: unknown) {
  const record = asRecord(body);
  const name = asNonEmptyString(record.name);
  const baseUrl = asNonEmptyString(record.baseUrl);
  if (!name) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "\"name\" is required and must be a non-empty string",
      { httpStatus: 400 },
    );
  }
  if (!baseUrl) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "\"baseUrl\" is required and must be a non-empty string",
      { httpStatus: 400 },
    );
  }
  return {
    name,
    baseUrl,
    trustPolicy: parseTrustPolicy(record.trustPolicy, "trustPolicy"),
    pinnedKeyIds: asStringArray(record.pinnedKeyIds, "pinnedKeyIds"),
  };
}

function buildSourcePatchInput(body: unknown) {
  const record = asRecord(body);
  const patch: {
    name?: string;
    baseUrl?: string;
    enabled?: boolean;
    trustPolicy?: FridayMarketplaceTrustPolicy;
    pinnedKeyIds?: string[];
  } = {};

  if (record.name !== undefined) {
    const name = asNonEmptyString(record.name);
    if (!name) {
      throw new FridayDomainError("VALIDATION_ERROR", "\"name\" must be a non-empty string", { httpStatus: 400 });
    }
    patch.name = name;
  }
  if (record.baseUrl !== undefined) {
    const baseUrl = asNonEmptyString(record.baseUrl);
    if (!baseUrl) {
      throw new FridayDomainError("VALIDATION_ERROR", "\"baseUrl\" must be a non-empty string", { httpStatus: 400 });
    }
    patch.baseUrl = baseUrl;
  }
  if (record.enabled !== undefined) {
    patch.enabled = parseOptionalBoolean(record.enabled, "enabled");
  }
  if (record.trustPolicy !== undefined) {
    patch.trustPolicy = parseTrustPolicy(record.trustPolicy, "trustPolicy");
  }
  if (record.pinnedKeyIds !== undefined) {
    patch.pinnedKeyIds = asStringArray(record.pinnedKeyIds, "pinnedKeyIds");
  }

  if (Object.keys(patch).length === 0) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "At least one updatable field is required",
      { httpStatus: 400 },
    );
  }

  return patch;
}

function requireSourceExists(
  deps: FridaySkillMarketplaceRoutesDeps,
  sourceId: string,
): void {
  const source = deps.sources.getSource(sourceId);
  if (!source) {
    throw new FridayDomainError(
      "MARKETPLACE_SOURCE_NOT_FOUND",
      `Source "${sourceId}" not found`,
      { httpStatus: 404, details: { sourceId } },
    );
  }
}

function toFallbackSourceView(source: FridayMarketplaceSourceEntity) {
  const reasons = source.enabled ? [] : ["Source is disabled."];
  return {
    ...source,
    trustSummary: {
      policy: source.trustPolicy,
      pinnedKeyCount: source.pinnedKeyIds.length,
      pinned: source.pinnedKeyIds.length > 0,
    },
    catalogSummary: {
      cachedSkillCount: 0,
      cachedVersionCount: 0,
      verifiedVersionCount: 0,
      unsignedVersionCount: 0,
      latestIndexedAt: undefined,
      stale: false,
    },
    healthSummary: {
      status: reasons.length === 0 ? "healthy" : "warning",
      reasons,
    },
  };
}

function getSourceView(service: FridayMarketplaceSourceService, id: string) {
  const view = service.getSourceView?.(id);
  if (view) {
    return view;
  }
  const source = service.getSource(id);
  return source ? toFallbackSourceView(source) : null;
}

function listSourceViews(service: FridayMarketplaceSourceService, enabledOnly?: boolean) {
  return service.listSourceViews?.(enabledOnly)
    ?? service.listSources(enabledOnly).map((source) => toFallbackSourceView(source));
}

function buildInstallInput(body: unknown) {
  const record = asRecord(body);
  const skillId = asNonEmptyString(record.skillId);
  if (!skillId) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "\"skillId\" is required and must be a non-empty string",
      { httpStatus: 400 },
    );
  }

  const version = record.version === undefined ? undefined : asNonEmptyString(record.version);
  if (record.version !== undefined && !version) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "\"version\" must be a non-empty string when provided",
      { httpStatus: 400 },
    );
  }

  const sourceId = record.sourceId === undefined ? undefined : asNonEmptyString(record.sourceId);
  if (record.sourceId !== undefined && !sourceId) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "\"sourceId\" must be a non-empty string when provided",
      { httpStatus: 400 },
    );
  }

  return {
    skillId,
    version,
    sourceId,
    targetSatelliteIds: asStringArray(record.targetSatelliteIds, "targetSatelliteIds"),
    grantPermissions: asStringArray(record.grantPermissions, "grantPermissions"),
  };
}

export function createFridaySkillMarketplaceRoutes(
  deps: FridaySkillMarketplaceRoutesDeps,
): Route[] {
  return [
    {
      operationId: "marketplace.sources.list",
      method: "GET",
      path: "/v1/marketplace/sources",
      auth: { public: false, anyOfScopes: ["marketplace.read"] },
      async handler(ctx: Ctx) {
        const query = ctx.query as Record<string, string | undefined>;
        const enabledOnly = parseOptionalBoolean(query.enabledOnly, "enabledOnly");
        const items = listSourceViews(deps.sources, enabledOnly);
        return { items, total: items.length };
      },
    },
    {
      operationId: "marketplace.sources.create",
      method: "POST",
      path: "/v1/marketplace/sources",
      auth: { public: false, anyOfScopes: ["marketplace.admin"] },
      rateLimitPolicyId: "marketplace.write",
      async handler(ctx: Ctx) {
        const source = deps.sources.addSource(buildSourceCreateInput(ctx.body));
        return { source: getSourceView(deps.sources, source.id) ?? toFallbackSourceView(source) };
      },
    },
    {
      operationId: "marketplace.sources.get",
      method: "GET",
      path: "/v1/marketplace/sources/:id",
      auth: { public: false, anyOfScopes: ["marketplace.read"] },
      async handler(ctx: Ctx) {
        const { id } = ctx.params as { id: string };
        const source = getSourceView(deps.sources, id);
        if (!source) {
          throw new FridayDomainError("MARKETPLACE_SOURCE_NOT_FOUND", `Source "${id}" not found`, { httpStatus: 404 });
        }
        return { source };
      },
    },
    {
      operationId: "marketplace.sources.update",
      method: "PATCH",
      path: "/v1/marketplace/sources/:id",
      auth: { public: false, anyOfScopes: ["marketplace.admin"] },
      rateLimitPolicyId: "marketplace.write",
      async handler(ctx: Ctx) {
        const { id } = ctx.params as { id: string };
        requireSourceExists(deps, id);
        const source = deps.sources.updateSource(id, buildSourcePatchInput(ctx.body));
        return { source: getSourceView(deps.sources, source.id) ?? toFallbackSourceView(source) };
      },
    },
    {
      operationId: "marketplace.sources.enable",
      method: "POST",
      path: "/v1/marketplace/sources/:id/enable",
      auth: { public: false, anyOfScopes: ["marketplace.admin"] },
      rateLimitPolicyId: "marketplace.write",
      async handler(ctx: Ctx) {
        const { id } = ctx.params as { id: string };
        requireSourceExists(deps, id);
        deps.sources.enableSource(id);
        return { source: getSourceView(deps.sources, id) };
      },
    },
    {
      operationId: "marketplace.sources.disable",
      method: "POST",
      path: "/v1/marketplace/sources/:id/disable",
      auth: { public: false, anyOfScopes: ["marketplace.admin"] },
      rateLimitPolicyId: "marketplace.write",
      async handler(ctx: Ctx) {
        const { id } = ctx.params as { id: string };
        requireSourceExists(deps, id);
        deps.sources.disableSource(id);
        return { source: getSourceView(deps.sources, id) };
      },
    },
    {
      operationId: "marketplace.sources.remove",
      method: "DELETE",
      path: "/v1/marketplace/sources/:id",
      auth: { public: false, anyOfScopes: ["marketplace.admin"] },
      rateLimitPolicyId: "marketplace.write",
      async handler(ctx: Ctx) {
        const { id } = ctx.params as { id: string };
        requireSourceExists(deps, id);
        deps.sources.removeSource(id);
        return { removed: true, sourceId: id };
      },
    },
    {
      operationId: "marketplace.skills.catalog",
      method: "GET",
      path: "/v1/marketplace/skills/catalog",
      auth: { public: false, anyOfScopes: ["marketplace.read"] },
      async handler(ctx: Ctx) {
        const query = ctx.query as Record<string, string | undefined>;
        const result = deps.discovery.search({
          sourceId: asNonEmptyString(query.sourceId),
          q: asNonEmptyString(query.q),
          category: asNonEmptyString(query.category),
          cursor: asNonEmptyString(query.cursor),
          limit: parsePositiveInteger(query.limit, "limit", { min: 1, max: 200 }),
          includeStale: parseOptionalBoolean(query.includeStale, "includeStale"),
        });
        return result;
      },
    },
    {
      operationId: "marketplace.skills.install",
      method: "POST",
      path: "/v1/marketplace/skills/install",
      auth: { public: false, anyOfScopes: ["marketplace.write"] },
      rateLimitPolicyId: "marketplace.write",
      async handler(ctx: Ctx) {
        const request = buildInstallInput(ctx.body);
        const result = await deps.installations.install(request);
        return result;
      },
    },
    {
      operationId: "marketplace.skills.sync",
      method: "POST",
      path: "/v1/marketplace/skills/sync",
      auth: { public: false, anyOfScopes: ["marketplace.admin"] },
      rateLimitPolicyId: "marketplace.write",
      async handler(ctx: Ctx) {
        const body = asRecord(ctx.body);
        const sourceId = asNonEmptyString(body.sourceId);
        const results = sourceId
          ? [await deps.sync.syncSource(sourceId)]
          : await deps.sync.syncAllSources();
        return {
          results,
          staleSourceIds: deps.cache.getStaleSourceIds(),
          totalSources: results.length,
          totalErrors: results.reduce((sum, item) => sum + item.errors.length, 0),
        };
      },
    },
    {
      operationId: "marketplace.skills.status.sync",
      method: "GET",
      path: "/v1/marketplace/skills/sync/status",
      auth: { public: false, anyOfScopes: ["marketplace.read"] },
      async handler() {
        const allSources = deps.sources.listSources(false);
        const enabledSources = deps.sources.listSources(true);
        const staleSourceIds = deps.cache.getStaleSourceIds();
        return {
          sourceCount: allSources.length,
          enabledSourceCount: enabledSources.length,
          staleSourceIds,
          staleSourceCount: staleSourceIds.length,
        };
      },
    },
  ];
}
