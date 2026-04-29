/**
 * Canonical skills lifecycle routes.
 *
 * Keeps GET /v1/skills backward-compatible while exposing richer lifecycle
 * orchestration on the same route family.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import {
  canRunFridayBundledSystemNodeSkillWithoutGate,
  evaluateFridaySkillExecutionReadiness,
  FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV,
  getFridayLocalSkillExecutionContext,
  getFridayUnisolatedNodeSkillsDisabledMessage,
  isFridayUnisolatedNodeSkillsEnabled,
} from "#skills";
import type {
  FridaySkillExecutor,
  FridaySkillLifecycleService,
  FridaySkillRegistry,
} from "#skills";
import { FridayDomainError } from "#errors";
import { resolveSafeInstallDir } from "#utilities";
import { throwFridayCapabilityDisabled } from "./friday-capability-disabled.js";

export interface FridaySkillRoutesDeps {
  skillRegistry?: FridaySkillRegistry;
  lifecycle?: FridaySkillLifecycleService;
  skillExecutor?: FridaySkillExecutor;
  managedSkillsDir?: string;
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

  if (deps.managedSkillsDir) {
    routes.push({
      operationId: "skills.content.update",
      method: "PATCH",
      path: "/v1/skills/:skillId/content",
      auth: { public: false, anyOfScopes: ["skill.write", "hub.admin"] },
      async handler(ctx) {
        const skillId = String((ctx.params as Record<string, unknown>).skillId ?? "");
        const body = asRecord(ctx.body);
        const description = asOptionalString(body.description, "description");
        const name = asOptionalString(body.name, "name");
        const tags = body.tags !== undefined ? asStringArray(body.tags, "tags") : undefined;

        const skillDir = resolveSafeInstallDir(deps.managedSkillsDir!, skillId);
        if (!existsSync(skillDir)) {
          throw new FridayDomainError("SKILL_NOT_FOUND", `Skill directory "${skillId}" not found`, {
            httpStatus: 404,
          });
        }

        if (description) {
          const mdPath = join(skillDir, "SKILL.md");
          if (existsSync(mdPath)) {
            let content = readFileSync(mdPath, "utf-8");
            if (content.startsWith("---")) {
              const endIdx = content.indexOf("---", 3);
              if (endIdx !== -1) {
                const frontmatter = content.slice(0, endIdx + 3);
                const rest = content.slice(endIdx + 3);
                const updated = frontmatter.replace(
                  /^description:.*$/m,
                  `description: ${description}`,
                );
                content = updated + rest;
              }
            }
            writeFileSync(mdPath, content);
          }
        }

        if (name || tags) {
          const manifestPath = join(skillDir, "skill.manifest.json");
          if (existsSync(manifestPath)) {
            const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
            if (name) manifest.name = name;
            if (tags) manifest.tags = tags;
            writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
          }
        }

        const skill = deps.lifecycle?.getSkill(skillId) ?? null;
        return { updated: true, skillId, skill };
      },
    });
  }

  // ── Skill execution dispatch (POST /v1/skills/:skillId/run) ──
  routes.push({
    operationId: "skills.run",
    method: "POST",
    path: "/v1/skills/:skillId/run",
    auth: { public: false, anyOfScopes: ["skill.write", "hub.admin"] },
    async handler(ctx) {
      const skillId = String((ctx.params as Record<string, unknown>).skillId ?? "");
      if (!skillId) {
        throw new FridayDomainError("VALIDATION_ERROR", "\"skillId\" is required", {
          httpStatus: 400,
        });
      }
      const body = asRecord(ctx.body);
      const input = (body.input ?? {}) as Record<string, string>;
      const timeoutMs = asOptionalPositiveInteger(body.timeoutMs, "timeoutMs");
      const sessionId = asOptionalString(body.sessionId, "sessionId");
      const channel = asOptionalString(body.channel, "channel") ?? "api";
      const principalId = ctx.principal?.principalId ?? "skill-operator";
      const principalRecord = (ctx.principal ?? null) as { tenantId?: unknown } | null;
      const tenantId = typeof principalRecord?.tenantId === "string" && principalRecord.tenantId.trim().length > 0
        ? principalRecord.tenantId.trim()
        : principalId;
      const lifecycleSkill = deps.lifecycle?.getSkill(skillId) as {
        currentManifest?: { kind?: string; runtime?: { kind?: string } };
        catalogEntry?: { manifest?: { kind?: string; runtime?: { kind?: string } } };
      } | null | undefined;
      const registeredSkill = typeof deps.skillRegistry?.get === "function"
        ? deps.skillRegistry.get(skillId)
        : null;

      // Resolve the skill from registry or lifecycle to validate it exists.
      // `ai-inference` is a built-in executor path even when it is not listed
      // in the registry inventory.
      const skill = lifecycleSkill ?? (registeredSkill ? { skillId } : null);
      if (!skill && skillId !== "ai-inference") {
        throw new FridayDomainError("SKILL_NOT_FOUND", `Skill "${skillId}" not found`, {
          httpStatus: 404,
        });
      }
      if (!deps.skillExecutor) {
        throw new FridayDomainError("SKILL_EXECUTOR_UNAVAILABLE", "Skill executor is unavailable in this runtime", {
          httpStatus: 503,
        });
      }

      const runtimeKind = registeredSkill?.manifest.runtime.kind
        ?? lifecycleSkill?.currentManifest?.runtime?.kind
        ?? lifecycleSkill?.catalogEntry?.manifest?.runtime?.kind;
      if (registeredSkill) {
        const readiness = evaluateFridaySkillExecutionReadiness({
          manifest: registeredSkill.manifest,
          ...getFridayLocalSkillExecutionContext(),
        });
        if (!readiness.ready) {
          throw new FridayDomainError(
            "SKILL_NOT_READY",
            readiness.blockers.join(" "),
            {
              httpStatus: 409,
              details: {
                skillId,
                blockers: readiness.blockers,
                requirements: readiness.requirements,
              },
            },
          );
        }
      }
      const allowBundledSystemNodeSkill = canRunFridayBundledSystemNodeSkillWithoutGate({
        runtimeKind,
        manifestKind: registeredSkill?.manifest.kind
          ?? lifecycleSkill?.currentManifest?.kind
          ?? lifecycleSkill?.catalogEntry?.manifest?.kind,
        source: registeredSkill?.source,
        origin: registeredSkill?.origin,
      });
      if (runtimeKind === "node" && !allowBundledSystemNodeSkill && !isFridayUnisolatedNodeSkillsEnabled()) {
        throwFridayCapabilityDisabled({
          capability: "skill_node_runtime",
          surface: "POST /v1/skills/:skillId/run",
          message: getFridayUnisolatedNodeSkillsDisabledMessage(),
          details: {
            runtimeKind: "node",
            gate: FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV,
            skillId,
          },
        });
      }

      const handle = deps.skillExecutor.execute({
        skillId,
        input,
        sessionId: sessionId ?? `api-skill-run:${skillId}`,
        userId: principalId,
        channel,
        tenantContext: {
          hubId: tenantId,
          userId: principalId,
          channelKind: channel,
        },
        timeoutMs,
      });
      const result = await handle.result;

      return {
        skillId,
        runId: result.runId,
        status: result.status,
        completionDepth: result.status === "completed" ? "executed" : "dispatch-only",
        durationMs: result.durationMs,
        output: result.output,
        stdout: result.stdout,
        stderr: result.stderr,
        input,
      };
    },
  });

  return routes;
}
