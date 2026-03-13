/**
 * Canonical skills lifecycle routes.
 *
 * Keeps GET /v1/skills backward-compatible while exposing richer lifecycle
 * orchestration on the same route family.
 */

import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { FridaySkillLifecycleService, FridaySkillRegistry } from "#skills";
import { FridayDomainError } from "#errors";

export interface FridaySkillRoutesDeps {
  skillRegistry?: FridaySkillRegistry;
  lifecycle?: FridaySkillLifecycleService;
}

function toLegacyCompatibleListItem(item: {
  skillId: string;
  name: string;
  status: string;
  starter?: boolean;
  tags: string[];
  installedVersion?: string;
  latestVersion?: string;
}): Record<string, unknown> {
  return {
    ...item,
    id: item.skillId,
    version: item.installedVersion ?? item.latestVersion ?? "unknown",
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new FridayDomainError("VALIDATION_ERROR", `"${field}" must be a string when provided`, {
      httpStatus: 400,
    });
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asStringArray(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new FridayDomainError("VALIDATION_ERROR", `"${field}" must be an array of strings`, {
      httpStatus: 400,
    });
  }
  return value.map((item) => item.trim()).filter((item) => item.length > 0);
}

function asOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  throw new FridayDomainError("VALIDATION_ERROR", `"${field}" must be a boolean`, {
    httpStatus: 400,
  });
}

function asOptionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new FridayDomainError("VALIDATION_ERROR", `"${field}" must be a positive integer`, {
      httpStatus: 400,
    });
  }
  return parsed;
}

export function createFridaySkillRoutes(
  deps: FridaySkillRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  const routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[] = [
    {
      operationId: "skills.list",
      method: "GET",
      path: "/v1/skills",
      auth: { public: false, anyOfScopes: ["skill.read", "hub.admin"] },
      async handler() {
        if (deps.lifecycle) {
          return { items: deps.lifecycle.listSkills().map((item) => toLegacyCompatibleListItem(item)) };
        }
        if (!deps.skillRegistry) {
          throw new FridayDomainError("SKILL_REGISTRY_UNAVAILABLE", "Skill registry is unavailable", {
            httpStatus: 503,
          });
        }
        const items = deps.skillRegistry.list().map((skill) => ({
          skillId: skill.manifest.id,
          name: skill.manifest.name,
          source: skill.source,
          origin: skill.origin,
          status: skill.status,
          category: skill.manifest.category,
          starter: (skill.manifest.tags ?? []).includes("starter"),
          tags: skill.manifest.tags ?? [],
          latestVersion: skill.manifest.version,
          installedVersion: skill.manifest.version,
          updateAvailable: false,
          managed: skill.origin === "managed",
          registryLoaded: true,
          currentManifest: skill.manifest,
        })).map((item) => toLegacyCompatibleListItem(item));
        return { items };
      },
    },
  ];

  if (!deps.lifecycle) {
    return routes;
  }

  routes.push(
    {
      operationId: "skills.catalog.list",
      method: "GET",
      path: "/v1/skills/catalog",
      auth: { public: false, anyOfScopes: ["skill.read", "hub.admin"] },
      async handler(ctx) {
        const query = asRecord(ctx.query);
        const result = deps.lifecycle!.listCatalog({
          sourceId: asOptionalString(query.sourceId, "sourceId"),
          q: asOptionalString(query.q, "q"),
          category: asOptionalString(query.category, "category"),
          cursor: asOptionalString(query.cursor, "cursor"),
          limit: asOptionalPositiveInteger(query.limit, "limit"),
          includeStale: asOptionalBoolean(query.includeStale, "includeStale"),
        });
        return result;
      },
    },
    {
      operationId: "skills.get",
      method: "GET",
      path: "/v1/skills/:skillId",
      auth: { public: false, anyOfScopes: ["skill.read", "hub.admin"] },
      async handler(ctx) {
        const skillId = String((ctx.params as Record<string, unknown>).skillId ?? "");
        const skill = deps.lifecycle!.getSkill(skillId);
        if (!skill) {
          throw new FridayDomainError("SKILL_NOT_FOUND", `Skill "${skillId}" not found`, {
            httpStatus: 404,
          });
        }
        return { skill };
      },
    },
    {
      operationId: "skills.install",
      method: "POST",
      path: "/v1/skills/install",
      auth: { public: false, anyOfScopes: ["skill.write", "hub.admin"] },
      rateLimitPolicyId: "marketplace.write",
      async handler(ctx) {
        const body = asRecord(ctx.body);
        const skillId = asOptionalString(body.skillId, "skillId");
        if (!skillId) {
          throw new FridayDomainError("VALIDATION_ERROR", "\"skillId\" is required", {
            httpStatus: 400,
          });
        }
        const result = await deps.lifecycle!.install({
          userId: ctx.principal?.principalId ?? "skill-operator",
          skillId,
          version: asOptionalString(body.version, "version"),
          sourceId: asOptionalString(body.sourceId, "sourceId"),
          targetSatelliteIds: asStringArray(body.targetSatelliteIds, "targetSatelliteIds"),
          grantPermissions: asStringArray(body.grantPermissions, "grantPermissions"),
        });
        return result;
      },
    },
    {
      operationId: "skills.update",
      method: "POST",
      path: "/v1/skills/:skillId/update",
      auth: { public: false, anyOfScopes: ["skill.write", "hub.admin"] },
      rateLimitPolicyId: "marketplace.write",
      async handler(ctx) {
        const body = asRecord(ctx.body);
        const skillId = String((ctx.params as Record<string, unknown>).skillId ?? "");
        const result = await deps.lifecycle!.update({
          userId: ctx.principal?.principalId ?? "skill-operator",
          skillId,
          version: asOptionalString(body.version, "version"),
          sourceId: asOptionalString(body.sourceId, "sourceId"),
          targetSatelliteIds: asStringArray(body.targetSatelliteIds, "targetSatelliteIds"),
          grantPermissions: asStringArray(body.grantPermissions, "grantPermissions"),
        });
        return result;
      },
    },
    {
      operationId: "skills.delete",
      method: "DELETE",
      path: "/v1/skills/:skillId",
      auth: { public: false, anyOfScopes: ["skill.write", "hub.admin"] },
      rateLimitPolicyId: "marketplace.write",
      async handler(ctx) {
        const skillId = String((ctx.params as Record<string, unknown>).skillId ?? "");
        return deps.lifecycle!.deleteSkill({
          skillId,
          deletedBy: ctx.principal?.principalId ?? "skill-operator",
        });
      },
    },
    {
      operationId: "skills.manifest.validate",
      method: "POST",
      path: "/v1/skills/validate-manifest",
      auth: { public: false, anyOfScopes: ["skill.write", "hub.admin"] },
      async handler(ctx) {
        const body = asRecord(ctx.body);
        if (body.manifest === undefined) {
          throw new FridayDomainError("VALIDATION_ERROR", "\"manifest\" is required", {
            httpStatus: 400,
          });
        }
        return {
          verdict: deps.lifecycle!.validateManifest(body.manifest),
        };
      },
    },
    {
      operationId: "skills.verify",
      method: "POST",
      path: "/v1/skills/:skillId/verify",
      auth: { public: false, anyOfScopes: ["skill.read", "hub.admin"] },
      async handler(ctx) {
        const skillId = String((ctx.params as Record<string, unknown>).skillId ?? "");
        const evidence = await deps.lifecycle!.verifySkill({
          skillId,
          userId: ctx.principal?.principalId ?? "skill-operator",
        });
        return { evidence };
      },
    },
  );

  return routes;
}
