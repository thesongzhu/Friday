import { FridayDomainError } from "#errors";

import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayGetAutonomyUpgradeStatusQuery,
  FridayGetAutonomyUpgradeStatusResponse,
  FridayPluginUpgradeActionResponse,
  FridayPromotePluginUpgradeRequest,
  FridayPromoteProviderProfileUpgradeRequest,
  FridayRecordSkillCanaryRequest,
  FridayRecordPluginCanaryRequest,
  FridayRecordProviderProfileCanaryRequest,
  FridayRecordWorkflowCanaryRequest,
  FridayRegisterSkillShadowRequest,
  FridayRegisterPluginShadowRequest,
  FridayRegisterProviderProfileShadowRequest,
  FridayRegisterWorkflowShadowRequest,
  FridayProviderProfileUpgradeActionResponse,
  FridayPromoteSkillUpgradeRequest,
  FridayPromoteWorkflowUpgradeRequest,
  FridayRollbackPluginUpgradeRequest,
  FridayRollbackProviderProfileUpgradeRequest,
  FridayRollbackSkillUpgradeRequest,
  FridayRollbackWorkflowUpgradeRequest,
  FridaySkillUpgradeActionResponse,
  FridayWorkflowUpgradeActionResponse,
} from "../../model/friday-api-autonomy.types.js";
import type { FridayAutonomySubjectKind } from "../../../autonomy/model/friday-autonomy-subject.types.js";
import type { FridayWorkflowEntity } from "../../model/friday-api-workflow.types.js";
import type { FridaySkillLifecycleDetail } from "#skills";
import type { FridayPluginEntity } from "../../../plugins/model/friday-plugin.types.js";
import type { FridayProviderProfile } from "../../../providers/model/friday-provider.types.js";

const AUTONOMY_SUBJECT_KINDS: ReadonlySet<FridayAutonomySubjectKind> = new Set([
  "skill",
  "workflow",
  "plugin",
  "provider_profile",
  "mcp_server",
  "channel_adapter",
]);

export interface FridayAutonomyRoutesDeps {
  listUpgradeStatus: (
    query: FridayGetAutonomyUpgradeStatusQuery,
  ) => FridayGetAutonomyUpgradeStatusResponse | Promise<FridayGetAutonomyUpgradeStatusResponse>;
  workflowActions?: {
    registerShadow: (
      input: { workflowId: string } & FridayRegisterWorkflowShadowRequest,
    ) => FridayWorkflowEntity | Promise<FridayWorkflowEntity>;
    recordCanary: (
      input: { workflowId: string } & FridayRecordWorkflowCanaryRequest,
    ) => FridayWorkflowEntity | Promise<FridayWorkflowEntity>;
    promote: (
      input: { workflowId: string } & FridayPromoteWorkflowUpgradeRequest,
    ) => FridayWorkflowEntity | Promise<FridayWorkflowEntity>;
    rollback: (
      input: { workflowId: string } & FridayRollbackWorkflowUpgradeRequest,
    ) => FridayWorkflowEntity | Promise<FridayWorkflowEntity>;
    getStatus: (workflowId: string) => FridayWorkflowUpgradeActionResponse["status"];
  };
  skillActions?: {
    registerShadow: (
      input: { skillId: string } & FridayRegisterSkillShadowRequest,
    ) => FridaySkillLifecycleDetail | Promise<FridaySkillLifecycleDetail>;
    recordCanary: (
      input: { skillId: string } & FridayRecordSkillCanaryRequest,
    ) => FridaySkillLifecycleDetail | Promise<FridaySkillLifecycleDetail>;
    promote: (
      input: { skillId: string } & FridayPromoteSkillUpgradeRequest,
    ) => FridaySkillLifecycleDetail | Promise<FridaySkillLifecycleDetail>;
    rollback: (
      input: { skillId: string } & FridayRollbackSkillUpgradeRequest,
    ) => FridaySkillLifecycleDetail | Promise<FridaySkillLifecycleDetail>;
    getStatus: (skillId: string) => FridaySkillUpgradeActionResponse["status"];
  };
  pluginActions?: {
    registerShadow: (
      input: { pluginId: string } & FridayRegisterPluginShadowRequest,
    ) => FridayPluginEntity | Promise<FridayPluginEntity>;
    recordCanary: (
      input: { pluginId: string } & FridayRecordPluginCanaryRequest,
    ) => FridayPluginEntity | Promise<FridayPluginEntity>;
    promote: (
      input: { pluginId: string } & FridayPromotePluginUpgradeRequest,
    ) => FridayPluginEntity | Promise<FridayPluginEntity>;
    rollback: (
      input: { pluginId: string } & FridayRollbackPluginUpgradeRequest,
    ) => FridayPluginEntity | Promise<FridayPluginEntity>;
    getStatus: (pluginId: string) => FridayPluginUpgradeActionResponse["status"];
  };
  providerProfileActions?: {
    registerShadow: (
      input: { providerId: string } & FridayRegisterProviderProfileShadowRequest,
    ) => FridayProviderProfile | Promise<FridayProviderProfile>;
    recordCanary: (
      input: { providerId: string } & FridayRecordProviderProfileCanaryRequest,
    ) => FridayProviderProfile | Promise<FridayProviderProfile>;
    promote: (
      input: { providerId: string } & FridayPromoteProviderProfileUpgradeRequest,
    ) => FridayProviderProfile | Promise<FridayProviderProfile>;
    rollback: (
      input: { providerId: string } & FridayRollbackProviderProfileUpgradeRequest,
    ) => FridayProviderProfile | Promise<FridayProviderProfile>;
    getStatus: (providerId: string) => FridayProviderProfileUpgradeActionResponse["status"];
  };
}

function buildSkillUpgradeActionPayload(
  skill: FridaySkillLifecycleDetail,
  status: FridaySkillUpgradeActionResponse["status"],
): FridaySkillUpgradeActionResponse["skill"] {
  return {
    skillId: skill.skillId,
    installedVersion: skill.installedVersion,
    latestVersion: skill.latestVersion,
    status: skill.status,
    promotionChannel: status?.promotionChannel,
    compatibilityStatus: status?.recordedCompatibilityStatus,
    shadowVersionId: status?.shadowVersionId,
    canaryStats: status?.canaryStats,
  };
}

function buildPluginUpgradeActionPayload(
  plugin: FridayPluginEntity,
): FridayPluginUpgradeActionResponse["plugin"] {
  return {
    id: plugin.id,
    version: plugin.version,
    status: plugin.status,
    enabled: plugin.enabled,
    promotionChannel: plugin.promotionChannel ?? undefined,
    compatibilityStatus: plugin.compatibilityStatus ?? undefined,
    shadowVersionId: plugin.shadowVersionId ?? undefined,
    canaryStats: plugin.canaryStats,
  };
}

function buildProviderProfileUpgradeActionPayload(
  provider: FridayProviderProfile,
): FridayProviderProfileUpgradeActionResponse["provider"] {
  return {
    id: provider.id,
    kind: provider.kind,
    name: provider.name,
    defaultModel: provider.defaultModel,
    enabled: provider.enabled,
    promotionChannel: provider.promotionChannel ?? undefined,
    compatibilityStatus: provider.compatibilityStatus ?? undefined,
    shadowVersionId: provider.shadowVersionId ?? undefined,
    canaryStats: provider.canaryStats,
    validationStatus: provider.config.validation?.status,
  };
}

function readSubjectKind(value: unknown): FridayAutonomySubjectKind | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  if (!AUTONOMY_SUBJECT_KINDS.has(value as FridayAutonomySubjectKind)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `kind must be one of ${Array.from(AUTONOMY_SUBJECT_KINDS).join(", ")}`,
      { httpStatus: 400 },
    );
  }
  return value as FridayAutonomySubjectKind;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new FridayDomainError("VALIDATION_ERROR", `${field} must be a positive integer`, {
      httpStatus: 400,
    });
  }
  return Number(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new FridayDomainError("VALIDATION_ERROR", `${field} must be a non-empty string`, {
      httpStatus: 400,
    });
  }
  return value;
}

export function createFridayAutonomyRoutes(
  deps: FridayAutonomyRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  const routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[] = [
    {
      operationId: "autonomy.upgrade.status.list",
      method: "GET",
      path: "/v1/autonomy/upgrade-status",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      async handler(ctx) {
        const query = ctx.query as Record<string, unknown>;
        return deps.listUpgradeStatus({
          kind: readSubjectKind(query.kind),
          id: typeof query.id === "string" && query.id.trim().length > 0 ? query.id : undefined,
        });
      },
    },
  ];

  if (deps.workflowActions) {
    routes.push(
      {
        operationId: "autonomy.workflows.shadow",
        method: "POST",
        path: "/v1/autonomy/workflows/:workflowId/shadow",
        auth: { public: false, anyOfScopes: ["hub.admin"] },
        async handler(ctx) {
          const { workflowId } = ctx.params as { workflowId: string };
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const workflow = await deps.workflowActions!.registerShadow({
            workflowId,
            workflowVersionId: requireNonEmptyString(body.workflowVersionId, "workflowVersionId"),
            runtimeVersion: requireNonEmptyString(body.runtimeVersion, "runtimeVersion"),
            providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
          });
          return { workflow, status: deps.workflowActions!.getStatus(workflowId) };
        },
      },
      {
        operationId: "autonomy.workflows.canary",
        method: "POST",
        path: "/v1/autonomy/workflows/:workflowId/canary",
        auth: { public: false, anyOfScopes: ["hub.admin"] },
        async handler(ctx) {
          const { workflowId } = ctx.params as { workflowId: string };
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          if (typeof body.success !== "boolean") {
            throw new FridayDomainError("VALIDATION_ERROR", "success must be a boolean", {
              httpStatus: 400,
            });
          }
          const workflow = await deps.workflowActions!.recordCanary({
            workflowId,
            success: body.success,
            evaluatedAt: typeof body.evaluatedAt === "string" ? body.evaluatedAt : undefined,
          });
          return { workflow, status: deps.workflowActions!.getStatus(workflowId) };
        },
      },
      {
        operationId: "autonomy.workflows.promote",
        method: "POST",
        path: "/v1/autonomy/workflows/:workflowId/promote",
        auth: { public: false, anyOfScopes: ["hub.admin"] },
        async handler(ctx) {
          const { workflowId } = ctx.params as { workflowId: string };
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const workflow = await deps.workflowActions!.promote({
            workflowId,
            versionNumber: requirePositiveInteger(body.versionNumber, "versionNumber"),
            runtimeVersion: requireNonEmptyString(body.runtimeVersion, "runtimeVersion"),
            providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
          });
          return { workflow, status: deps.workflowActions!.getStatus(workflowId) };
        },
      },
      {
        operationId: "autonomy.workflows.rollback",
        method: "POST",
        path: "/v1/autonomy/workflows/:workflowId/rollback",
        auth: { public: false, anyOfScopes: ["hub.admin"] },
        async handler(ctx) {
          const { workflowId } = ctx.params as { workflowId: string };
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const workflow = await deps.workflowActions!.rollback({
            workflowId,
            targetVersionNumber: requirePositiveInteger(body.targetVersionNumber, "targetVersionNumber"),
            runtimeVersion: requireNonEmptyString(body.runtimeVersion, "runtimeVersion"),
            providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
          });
          return { workflow, status: deps.workflowActions!.getStatus(workflowId) };
        },
      },
    );
  }

  if (deps.skillActions) {
    routes.push(
      {
        operationId: "autonomy.skills.shadow",
        method: "POST",
        path: "/v1/autonomy/skills/:skillId/shadow",
        auth: { public: false, anyOfScopes: ["hub.admin"] },
        async handler(ctx) {
          const { skillId } = ctx.params as { skillId: string };
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const skill = await deps.skillActions!.registerShadow({
            skillId,
            shadowVersionId: requireNonEmptyString(body.shadowVersionId, "shadowVersionId"),
            runtimeVersion: requireNonEmptyString(body.runtimeVersion, "runtimeVersion"),
            providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
          });
          const status = deps.skillActions!.getStatus(skillId);
          return { skill: buildSkillUpgradeActionPayload(skill, status), status };
        },
      },
      {
        operationId: "autonomy.skills.canary",
        method: "POST",
        path: "/v1/autonomy/skills/:skillId/canary",
        auth: { public: false, anyOfScopes: ["hub.admin"] },
        async handler(ctx) {
          const { skillId } = ctx.params as { skillId: string };
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          if (typeof body.success !== "boolean") {
            throw new FridayDomainError("VALIDATION_ERROR", "success must be a boolean", {
              httpStatus: 400,
            });
          }
          const skill = await deps.skillActions!.recordCanary({
            skillId,
            success: body.success,
            evaluatedAt: typeof body.evaluatedAt === "string" ? body.evaluatedAt : undefined,
          });
          const status = deps.skillActions!.getStatus(skillId);
          return { skill: buildSkillUpgradeActionPayload(skill, status), status };
        },
      },
      {
        operationId: "autonomy.skills.promote",
        method: "POST",
        path: "/v1/autonomy/skills/:skillId/promote",
        auth: { public: false, anyOfScopes: ["hub.admin"] },
        async handler(ctx) {
          const { skillId } = ctx.params as { skillId: string };
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const skill = await deps.skillActions!.promote({
            skillId,
            runtimeVersion: requireNonEmptyString(body.runtimeVersion, "runtimeVersion"),
            providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
          });
          const status = deps.skillActions!.getStatus(skillId);
          return { skill: buildSkillUpgradeActionPayload(skill, status), status };
        },
      },
      {
        operationId: "autonomy.skills.rollback",
        method: "POST",
        path: "/v1/autonomy/skills/:skillId/rollback",
        auth: { public: false, anyOfScopes: ["hub.admin"] },
        async handler(ctx) {
          const { skillId } = ctx.params as { skillId: string };
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const skill = await deps.skillActions!.rollback({
            skillId,
            runtimeVersion: requireNonEmptyString(body.runtimeVersion, "runtimeVersion"),
            providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
          });
          const status = deps.skillActions!.getStatus(skillId);
          return { skill: buildSkillUpgradeActionPayload(skill, status), status };
        },
      },
    );
  }

  if (deps.pluginActions) {
    routes.push(
      {
        operationId: "autonomy.plugins.shadow",
        method: "POST",
        path: "/v1/autonomy/plugins/:pluginId/shadow",
        auth: { public: false, anyOfScopes: ["hub.admin"] },
        async handler(ctx) {
          const { pluginId } = ctx.params as { pluginId: string };
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const plugin = await deps.pluginActions!.registerShadow({
            pluginId,
            shadowVersionId: requireNonEmptyString(body.shadowVersionId, "shadowVersionId"),
            runtimeVersion: requireNonEmptyString(body.runtimeVersion, "runtimeVersion"),
            providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
          });
          const status = deps.pluginActions!.getStatus(pluginId);
          return { plugin: buildPluginUpgradeActionPayload(plugin), status };
        },
      },
      {
        operationId: "autonomy.plugins.canary",
        method: "POST",
        path: "/v1/autonomy/plugins/:pluginId/canary",
        auth: { public: false, anyOfScopes: ["hub.admin"] },
        async handler(ctx) {
          const { pluginId } = ctx.params as { pluginId: string };
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          if (typeof body.success !== "boolean") {
            throw new FridayDomainError("VALIDATION_ERROR", "success must be a boolean", {
              httpStatus: 400,
            });
          }
          const plugin = await deps.pluginActions!.recordCanary({
            pluginId,
            success: body.success,
            evaluatedAt: typeof body.evaluatedAt === "string" ? body.evaluatedAt : undefined,
          });
          const status = deps.pluginActions!.getStatus(pluginId);
          return { plugin: buildPluginUpgradeActionPayload(plugin), status };
        },
      },
      {
        operationId: "autonomy.plugins.promote",
        method: "POST",
        path: "/v1/autonomy/plugins/:pluginId/promote",
        auth: { public: false, anyOfScopes: ["hub.admin"] },
        async handler(ctx) {
          const { pluginId } = ctx.params as { pluginId: string };
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const plugin = await deps.pluginActions!.promote({
            pluginId,
            runtimeVersion: requireNonEmptyString(body.runtimeVersion, "runtimeVersion"),
            providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
          });
          const status = deps.pluginActions!.getStatus(pluginId);
          return { plugin: buildPluginUpgradeActionPayload(plugin), status };
        },
      },
      {
        operationId: "autonomy.plugins.rollback",
        method: "POST",
        path: "/v1/autonomy/plugins/:pluginId/rollback",
        auth: { public: false, anyOfScopes: ["hub.admin"] },
        async handler(ctx) {
          const { pluginId } = ctx.params as { pluginId: string };
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const plugin = await deps.pluginActions!.rollback({
            pluginId,
            runtimeVersion: requireNonEmptyString(body.runtimeVersion, "runtimeVersion"),
            providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
          });
          const status = deps.pluginActions!.getStatus(pluginId);
          return { plugin: buildPluginUpgradeActionPayload(plugin), status };
        },
      },
    );
  }

  if (deps.providerProfileActions) {
    routes.push(
      {
        operationId: "autonomy.providers.shadow",
        method: "POST",
        path: "/v1/autonomy/providers/:providerId/shadow",
        auth: { public: false, anyOfScopes: ["hub.admin"] },
        async handler(ctx) {
          const { providerId } = ctx.params as { providerId: string };
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const provider = await deps.providerProfileActions!.registerShadow({
            providerId,
            shadowVersionId: requireNonEmptyString(body.shadowVersionId, "shadowVersionId"),
            runtimeVersion: requireNonEmptyString(body.runtimeVersion, "runtimeVersion"),
            providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
          });
          const status = deps.providerProfileActions!.getStatus(providerId);
          return { provider: buildProviderProfileUpgradeActionPayload(provider), status };
        },
      },
      {
        operationId: "autonomy.providers.canary",
        method: "POST",
        path: "/v1/autonomy/providers/:providerId/canary",
        auth: { public: false, anyOfScopes: ["hub.admin"] },
        async handler(ctx) {
          const { providerId } = ctx.params as { providerId: string };
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          if (typeof body.success !== "boolean") {
            throw new FridayDomainError("VALIDATION_ERROR", "success must be a boolean", {
              httpStatus: 400,
            });
          }
          const provider = await deps.providerProfileActions!.recordCanary({
            providerId,
            success: body.success,
            evaluatedAt: typeof body.evaluatedAt === "string" ? body.evaluatedAt : undefined,
          });
          const status = deps.providerProfileActions!.getStatus(providerId);
          return { provider: buildProviderProfileUpgradeActionPayload(provider), status };
        },
      },
      {
        operationId: "autonomy.providers.promote",
        method: "POST",
        path: "/v1/autonomy/providers/:providerId/promote",
        auth: { public: false, anyOfScopes: ["hub.admin"] },
        async handler(ctx) {
          const { providerId } = ctx.params as { providerId: string };
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const provider = await deps.providerProfileActions!.promote({
            providerId,
            runtimeVersion: requireNonEmptyString(body.runtimeVersion, "runtimeVersion"),
            providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
          });
          const status = deps.providerProfileActions!.getStatus(providerId);
          return { provider: buildProviderProfileUpgradeActionPayload(provider), status };
        },
      },
      {
        operationId: "autonomy.providers.rollback",
        method: "POST",
        path: "/v1/autonomy/providers/:providerId/rollback",
        auth: { public: false, anyOfScopes: ["hub.admin"] },
        async handler(ctx) {
          const { providerId } = ctx.params as { providerId: string };
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const provider = await deps.providerProfileActions!.rollback({
            providerId,
            runtimeVersion: requireNonEmptyString(body.runtimeVersion, "runtimeVersion"),
            providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
          });
          const status = deps.providerProfileActions!.getStatus(providerId);
          return { provider: buildProviderProfileUpgradeActionPayload(provider), status };
        },
      },
    );
  }

  return routes;
}
