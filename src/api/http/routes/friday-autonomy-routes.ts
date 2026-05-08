import { FridayDomainError } from "#errors";

import type { FridayAuthPrincipal, FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayAgendaItemResponse,
  FridayAgendaRunResponse,
  FridayAutonomyPolicyResponse,
  FridayCapabilityAcquisitionPlanResponse,
  FridayCapabilityAcquisitionRunResponse,
  FridayChannelAdapterUpgradeActionResponse,
  FridayCreateStandingGoalRequest,
  FridayGetAutonomyUpgradeStatusQuery,
  FridayGetAutonomyUpgradeStatusResponse,
  FridayListAgendaResponse,
  FridayListStandingGoalsResponse,
  FridayMcpServerUpgradeActionResponse,
  FridayPatchAutonomyPolicyRequest,
  FridayPatchStandingGoalRequest,
  FridayPluginUpgradeActionResponse,
  FridayPromoteChannelAdapterUpgradeRequest,
  FridayPromoteMcpServerUpgradeRequest,
  FridayPromotePluginUpgradeRequest,
  FridayPromoteProviderProfileUpgradeRequest,
  FridayPromoteSkillUpgradeRequest,
  FridayPromoteWorkflowUpgradeRequest,
  FridayProviderProfileUpgradeActionResponse,
  FridayRecordChannelAdapterCanaryRequest,
  FridayRecordMcpServerCanaryRequest,
  FridayRecordPluginCanaryRequest,
  FridayRecordProviderProfileCanaryRequest,
  FridayRecordSkillCanaryRequest,
  FridayRecordWorkflowCanaryRequest,
  FridayRegisterChannelAdapterShadowRequest,
  FridayRegisterMcpServerShadowRequest,
  FridayRegisterPluginShadowRequest,
  FridayRegisterProviderProfileShadowRequest,
  FridayRegisterSkillShadowRequest,
  FridayRegisterWorkflowShadowRequest,
  FridayReviewEnablePluginRequest,
  FridayRollbackChannelAdapterUpgradeRequest,
  FridayRollbackMcpServerUpgradeRequest,
  FridayRollbackPluginUpgradeRequest,
  FridayRollbackProviderProfileUpgradeRequest,
  FridayRollbackSkillUpgradeRequest,
  FridayRollbackWorkflowUpgradeRequest,
  FridaySkillUpgradeActionResponse,
  FridayStandingGoalResponse,
  FridayWorkflowUpgradeActionResponse,
} from "../../model/friday-api-autonomy.types.js";
import type { FridayAutonomySubjectKind } from "../../../autonomy/model/friday-autonomy-subject.types.js";
import type {
  FridayAutonomyPolicyService,
  FridayCapabilityAcquisitionService,
  FridayStandingAgendaService,
} from "../../../autonomy/index.js";
import type { FridayWorkflowEntity } from "../../model/friday-api-workflow.types.js";
import type { FridaySkillLifecycleDetail } from "#skills";
import type { FridayPluginEntity } from "../../../plugins/model/friday-plugin.types.js";
import type { FridayProviderProfile } from "../../../providers/model/friday-provider.types.js";
import { FRIDAY_RUNTIME_CAPABILITY_IDS, type FridayProviderTenantContext, type FridayRuntimeCapabilityId } from "#providers";
import {
  type FridaySkillLifecycleApprovalRequestInput,
} from "../../../autonomy/services/friday-skill-upgrade-lifecycle-service.js";
import type {
  FridayProviderProfileLifecycleApprovalRequestInput,
} from "../../../autonomy/services/friday-provider-profile-upgrade-lifecycle-service.js";
import type {
  FridayMcpServerLifecycleApprovalRequestInput,
} from "../../../autonomy/services/friday-mcp-server-upgrade-lifecycle-service.js";
import type {
  FridayPluginLifecycleApprovalRequestInput,
} from "../../../autonomy/services/friday-plugin-upgrade-lifecycle-service.js";
import {
  type FridayCanonicalApprovalResolution,
  type FridayMutatingActionGate,
} from "../../../security/friday-mutating-action-gate.js";

const AUTONOMY_SUBJECT_KINDS: ReadonlySet<FridayAutonomySubjectKind> = new Set([
  "skill",
  "workflow",
  "plugin",
  "provider_profile",
  "mcp_server",
  "channel_adapter",
]);

const RUNTIME_CAPABILITY_IDS = new Set<string>(FRIDAY_RUNTIME_CAPABILITY_IDS);

export interface FridayAutonomyRoutesDeps {
  listUpgradeStatus: (
    query: FridayGetAutonomyUpgradeStatusQuery,
  ) => FridayGetAutonomyUpgradeStatusResponse | Promise<FridayGetAutonomyUpgradeStatusResponse>;
  policyService?: FridayAutonomyPolicyService;
  acquisitionService?: FridayCapabilityAcquisitionService;
  standingAgendaService?: FridayStandingAgendaService;
  canonicalMutationGate?: FridayMutatingActionGate;
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
      input: { skillId: string; actor: FridaySkillLifecycleApprovalRequestInput["actor"]; surface: string } & FridayRegisterSkillShadowRequest,
    ) => FridaySkillLifecycleDetail | Promise<FridaySkillLifecycleDetail>;
    recordCanary: (
      input: { skillId: string; actor: FridaySkillLifecycleApprovalRequestInput["actor"]; surface: string } & FridayRecordSkillCanaryRequest,
    ) => FridaySkillLifecycleDetail | Promise<FridaySkillLifecycleDetail>;
    promote: (
      input: { skillId: string; actor: FridaySkillLifecycleApprovalRequestInput["actor"]; surface: string } & FridayPromoteSkillUpgradeRequest,
    ) => FridaySkillLifecycleDetail | Promise<FridaySkillLifecycleDetail>;
    rollback: (
      input: { skillId: string; actor: FridaySkillLifecycleApprovalRequestInput["actor"]; surface: string } & FridayRollbackSkillUpgradeRequest,
    ) => FridaySkillLifecycleDetail | Promise<FridaySkillLifecycleDetail>;
    getStatus: (skillId: string) => FridaySkillUpgradeActionResponse["status"];
    getEvidence: (input: { skillId: string; candidateId: string }) => FridaySkillUpgradeActionResponse["evidence"] | null;
  };
  pluginActions?: {
    registerShadow: (
      input: { pluginId: string; actor: FridayPluginLifecycleApprovalRequestInput["actor"]; surface: string } & FridayRegisterPluginShadowRequest,
    ) => FridayPluginEntity | Promise<FridayPluginEntity>;
    recordCanary: (
      input: { pluginId: string; actor: FridayPluginLifecycleApprovalRequestInput["actor"]; surface: string } & FridayRecordPluginCanaryRequest,
    ) => FridayPluginEntity | Promise<FridayPluginEntity>;
    promote: (
      input: { pluginId: string; actor: FridayPluginLifecycleApprovalRequestInput["actor"]; surface: string } & FridayPromotePluginUpgradeRequest,
    ) => FridayPluginEntity | Promise<FridayPluginEntity>;
    rollback: (
      input: { pluginId: string; actor: FridayPluginLifecycleApprovalRequestInput["actor"]; surface: string } & FridayRollbackPluginUpgradeRequest,
    ) => FridayPluginEntity | Promise<FridayPluginEntity>;
    reviewEnable?: (
      input: {
        pluginId: string;
        actor: FridayPluginLifecycleApprovalRequestInput["actor"];
        surface: string;
      } & FridayReviewEnablePluginRequest,
    ) => FridayPluginEntity | Promise<FridayPluginEntity>;
    getStatus: (pluginId: string) => FridayPluginUpgradeActionResponse["status"];
    getEvidence?: (input: { pluginId: string }) => FridayPluginUpgradeActionResponse["evidence"] | null;
  };
  providerProfileActions?: {
    registerShadow: (
      input: {
        providerId: string;
        actor: FridayProviderProfileLifecycleApprovalRequestInput["actor"];
        surface: string;
      } & FridayRegisterProviderProfileShadowRequest,
    ) => FridayProviderProfile | Promise<FridayProviderProfile>;
    recordCanary: (
      input: {
        providerId: string;
        actor: FridayProviderProfileLifecycleApprovalRequestInput["actor"];
        surface: string;
        tenantContext?: FridayProviderTenantContext;
      } & FridayRecordProviderProfileCanaryRequest,
    ) => FridayProviderProfile | Promise<FridayProviderProfile>;
    promote: (
      input: {
        providerId: string;
        actor: FridayProviderProfileLifecycleApprovalRequestInput["actor"];
        surface: string;
      } & FridayPromoteProviderProfileUpgradeRequest,
    ) => FridayProviderProfile | Promise<FridayProviderProfile>;
    rollback: (
      input: {
        providerId: string;
        actor: FridayProviderProfileLifecycleApprovalRequestInput["actor"];
        surface: string;
      } & FridayRollbackProviderProfileUpgradeRequest,
    ) => FridayProviderProfile | Promise<FridayProviderProfile>;
    getStatus: (providerId: string) => FridayProviderProfileUpgradeActionResponse["status"];
    getEvidence?: (input: { providerId: string }) => FridayProviderProfileUpgradeActionResponse["evidence"] | null;
  };
  mcpServerActions?: {
    registerShadow: (
      input: {
        serverId: string;
        actor: FridayMcpServerLifecycleApprovalRequestInput["actor"];
        surface: string;
      } & FridayRegisterMcpServerShadowRequest,
    ) => void | Promise<void>;
    recordCanary: (
      input: {
        serverId: string;
        actor: FridayMcpServerLifecycleApprovalRequestInput["actor"];
        surface: string;
      } & FridayRecordMcpServerCanaryRequest,
    ) => void | Promise<void>;
    promote: (
      input: {
        serverId: string;
        actor: FridayMcpServerLifecycleApprovalRequestInput["actor"];
        surface: string;
      } & FridayPromoteMcpServerUpgradeRequest,
    ) => void | Promise<void>;
    rollback: (
      input: {
        serverId: string;
        actor: FridayMcpServerLifecycleApprovalRequestInput["actor"];
        surface: string;
      } & FridayRollbackMcpServerUpgradeRequest,
    ) => void | Promise<void>;
    getStatus: (serverId: string) => FridayMcpServerUpgradeActionResponse["status"];
    getEvidence?: (input: { serverId: string }) => FridayMcpServerUpgradeActionResponse["evidence"] | null;
  };
  channelAdapterActions?: {
    registerShadow: (
      input: { channelKind: string } & FridayRegisterChannelAdapterShadowRequest,
    ) => void | Promise<void>;
    recordCanary: (
      input: { channelKind: string } & FridayRecordChannelAdapterCanaryRequest,
    ) => void | Promise<void>;
    promote: (
      input: { channelKind: string } & FridayPromoteChannelAdapterUpgradeRequest,
    ) => void | Promise<void>;
    rollback: (
      input: { channelKind: string } & FridayRollbackChannelAdapterUpgradeRequest,
    ) => void | Promise<void>;
    getStatus: (channelKind: string) => FridayChannelAdapterUpgradeActionResponse["status"];
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

function createActorFromPrincipal(
  principal: FridayAuthPrincipal | null,
  fallbackId: string,
): FridaySkillLifecycleApprovalRequestInput["actor"] {
  if (!principal) {
    return {
      kind: "api",
      id: fallbackId,
      principalId: fallbackId,
    };
  }
  return {
    kind: principal.principalType,
    id: principal.principalId,
    principalId: principal.principalId,
  };
}

function buildProviderLifecycleTenantContext(principal: FridayAuthPrincipal | null): FridayProviderTenantContext | undefined {
  if (!principal) {
    return undefined;
  }
  const userId = principal.userId?.trim() || principal.principalId.trim();
  const hubId = principal.tenantId?.trim() || userId;
  return {
    hubId,
    userId,
  };
}

function readCanonicalApproval(value: unknown): FridayCanonicalApprovalResolution | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as FridayCanonicalApprovalResolution;
  }
  throw new FridayDomainError("VALIDATION_ERROR", "canonicalApproval must be an object", { httpStatus: 400 });
}

function requireSkillLifecycleCanonicalApproval(
  action: FridaySkillLifecycleApprovalRequestInput["action"],
  canonicalApproval: FridayCanonicalApprovalResolution | undefined,
): FridayCanonicalApprovalResolution {
  if (!canonicalApproval) {
    throw new FridayDomainError(
      "CANONICAL_APPROVAL_REQUIRED",
      `Skill lifecycle ${action} requires canonical approval before any mutation.`,
      { httpStatus: 403 },
    );
  }
  return canonicalApproval;
}

function requireProviderProfileLifecycleCanonicalApproval(
  action: FridayProviderProfileLifecycleApprovalRequestInput["action"],
  canonicalApproval: FridayCanonicalApprovalResolution | undefined,
): FridayCanonicalApprovalResolution {
  if (!canonicalApproval) {
    throw new FridayDomainError(
      "CANONICAL_APPROVAL_REQUIRED",
      `Provider lifecycle ${action} requires canonical approval before any mutation.`,
      { httpStatus: 403 },
    );
  }
  return canonicalApproval;
}

function requireMcpServerLifecycleCanonicalApproval(
  action: FridayMcpServerLifecycleApprovalRequestInput["action"],
  canonicalApproval: FridayCanonicalApprovalResolution | undefined,
): FridayCanonicalApprovalResolution {
  if (!canonicalApproval) {
    throw new FridayDomainError(
      "CANONICAL_APPROVAL_REQUIRED",
      `MCP server lifecycle ${action} requires canonical approval before any mutation.`,
      { httpStatus: 403 },
    );
  }
  return canonicalApproval;
}

function requirePluginLifecycleCanonicalApproval(
  action: FridayPluginLifecycleApprovalRequestInput["action"],
  canonicalApproval: FridayCanonicalApprovalResolution | undefined,
): FridayCanonicalApprovalResolution {
  if (!canonicalApproval) {
    throw new FridayDomainError(
      "CANONICAL_APPROVAL_REQUIRED",
      `Plugin lifecycle ${action} requires canonical approval before any mutation.`,
      { httpStatus: 403 },
    );
  }
  return canonicalApproval;
}

function requireSkillLifecycleEvidence(input: {
  deps: FridayAutonomyRoutesDeps;
  skillId: string;
  candidateId: string;
  expectedStage: string;
}): Record<string, unknown> {
  const evidence = input.deps.skillActions!.getEvidence({ skillId: input.skillId, candidateId: input.candidateId });
  if (!evidence) {
    throw new FridayDomainError(
      "SKILL_LIFECYCLE_EVIDENCE_MISSING",
      `Skill lifecycle ${input.expectedStage} completed without readable lifecycle evidence.`,
      { httpStatus: 500, details: { skillId: input.skillId, candidateId: input.candidateId, stage: input.expectedStage } },
    );
  }
  return evidence;
}

function requirePluginLifecycleEvidence(input: {
  deps: FridayAutonomyRoutesDeps;
  pluginId: string;
  expectedStage: string;
}): Record<string, unknown> {
  const evidence = input.deps.pluginActions!.getEvidence?.({ pluginId: input.pluginId });
  if (!evidence) {
    throw new FridayDomainError(
      "PLUGIN_LIFECYCLE_EVIDENCE_MISSING",
      `Plugin lifecycle ${input.expectedStage} completed without readable lifecycle evidence.`,
      { httpStatus: 500, details: { pluginId: input.pluginId, stage: input.expectedStage } },
    );
  }
  return evidence;
}

function requireMcpServerLifecycleEvidence(input: {
  deps: FridayAutonomyRoutesDeps;
  serverId: string;
  expectedStage: string;
}): Record<string, unknown> {
  const evidence = input.deps.mcpServerActions!.getEvidence?.({ serverId: input.serverId });
  if (!evidence) {
    throw new FridayDomainError(
      "MCP_SERVER_LIFECYCLE_EVIDENCE_MISSING",
      `MCP server lifecycle ${input.expectedStage} completed without readable lifecycle evidence.`,
      { httpStatus: 500, details: { serverId: input.serverId, stage: input.expectedStage } },
    );
  }
  return evidence;
}

function requireProviderProfileLifecycleEvidence(input: {
  deps: FridayAutonomyRoutesDeps;
  providerId: string;
  expectedStage: string;
}): Record<string, unknown> {
  const evidence = input.deps.providerProfileActions!.getEvidence?.({ providerId: input.providerId });
  if (!evidence) {
    throw new FridayDomainError(
      "PROVIDER_LIFECYCLE_EVIDENCE_MISSING",
      `Provider lifecycle ${input.expectedStage} completed without readable lifecycle evidence.`,
      { httpStatus: 500, details: { providerId: input.providerId, stage: input.expectedStage } },
    );
  }
  return evidence;
}

function readOptionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new FridayDomainError("VALIDATION_ERROR", `${field} must be an object`, { httpStatus: 400 });
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

function buildMcpServerUpgradeActionPayload(
  status: FridayMcpServerUpgradeActionResponse["status"],
): FridayMcpServerUpgradeActionResponse["server"] {
  return {
    id: status?.id ?? "",
    status: status?.status ?? "unknown",
    transport: typeof status?.details?.transport === "string" ? status.details.transport : undefined,
    toolCount: typeof status?.details?.toolCount === "number" ? status.details.toolCount : undefined,
    resourceCount: typeof status?.details?.resourceCount === "number" ? status.details.resourceCount : undefined,
    promotionChannel: status?.promotionChannel,
    compatibilityStatus: status?.recordedCompatibilityStatus,
    shadowVersionId: status?.shadowVersionId,
    canaryStats: status?.canaryStats,
  };
}

function buildChannelAdapterUpgradeActionPayload(
  status: FridayChannelAdapterUpgradeActionResponse["status"],
): FridayChannelAdapterUpgradeActionResponse["channel"] {
  return {
    kind: status?.id ?? "",
    status: status?.status ?? "unknown",
    running: typeof status?.details?.running === "boolean" ? status.details.running : undefined,
    credentialStatus: typeof status?.details?.credentialStatus === "string"
      ? status.details.credentialStatus
      : undefined,
    authMode: typeof status?.details?.authMode === "string" ? status.details.authMode : undefined,
    promotionChannel: status?.promotionChannel,
    compatibilityStatus: status?.recordedCompatibilityStatus,
    shadowVersionId: status?.shadowVersionId,
    canaryStats: status?.canaryStats,
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

function requireUserId(principal: { userId?: string } | null, bodyOrQuery?: Record<string, unknown>): string {
  const explicit = bodyOrQuery?.userId;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit.trim();
  }
  if (!principal?.userId) {
    throw new FridayDomainError("UNAUTHORIZED", "A user-scoped autonomy principal is required", {
      httpStatus: 401,
    });
  }
  return principal.userId;
}

function readOptionalCapabilities(value: unknown): FridayRuntimeCapabilityId[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const capabilities = raw
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter((item): item is FridayRuntimeCapabilityId => RUNTIME_CAPABILITY_IDS.has(item));
  return capabilities.length > 0 ? [...new Set(capabilities)] : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return undefined;
}

function readLimit(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
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
    {
      operationId: "capabilities.acquisition.plan",
      method: "GET",
      path: "/v1/capabilities/acquisition/plan",
      auth: { public: false, anyOfScopes: ["agent.read"] },
      async handler(ctx): Promise<FridayCapabilityAcquisitionPlanResponse> {
        if (!deps.acquisitionService) {
          throw new FridayDomainError("NOT_IMPLEMENTED", "Capability acquisition service is not configured", { httpStatus: 501 });
        }
        const query = (ctx.query ?? {}) as Record<string, unknown>;
        const goal = requireNonEmptyString(query.goal, "goal");
        const userId = requireUserId(ctx.principal, query);
        const run = await deps.acquisitionService.plan({
          userId,
          goal,
          requiredCapabilities: readOptionalCapabilities(query.requiredCapabilities ?? query.capabilities),
          readOnly: readBoolean(query.readOnly),
        });
        return { run };
      },
    },
    {
      operationId: "capabilities.acquisition.runs.create",
      method: "POST",
      path: "/v1/capabilities/acquisition/runs",
      auth: { public: false, anyOfScopes: ["agent.write"] },
      rateLimitPolicyId: "agent.run",
      async handler(ctx): Promise<FridayCapabilityAcquisitionRunResponse> {
        if (!deps.acquisitionService) {
          throw new FridayDomainError("NOT_IMPLEMENTED", "Capability acquisition service is not configured", { httpStatus: 501 });
        }
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const goal = requireNonEmptyString(body.goal, "goal");
        const userId = requireUserId(ctx.principal, body);
        const run = await deps.acquisitionService.startRun({
          userId,
          goal,
          requiredCapabilities: readOptionalCapabilities(body.requiredCapabilities),
          readOnly: readBoolean(body.readOnly),
        });
        return { run };
      },
    },
    {
      operationId: "capabilities.acquisition.runs.approve",
      method: "POST",
      path: "/v1/capabilities/acquisition/runs/:id/approve",
      auth: { public: false, anyOfScopes: ["agent.write"] },
      rateLimitPolicyId: "agent.run",
      async handler(ctx): Promise<FridayCapabilityAcquisitionRunResponse> {
        if (!deps.acquisitionService) {
          throw new FridayDomainError("NOT_IMPLEMENTED", "Capability acquisition service is not configured", { httpStatus: 501 });
        }
        requireUserId(ctx.principal);
        const { id } = ctx.params as { id: string };
        return { run: await deps.acquisitionService.approveRun(id) };
      },
    },
    {
      operationId: "capabilities.acquisition.runs.cancel",
      method: "POST",
      path: "/v1/capabilities/acquisition/runs/:id/cancel",
      auth: { public: false, anyOfScopes: ["agent.write"] },
      async handler(ctx): Promise<FridayCapabilityAcquisitionRunResponse> {
        if (!deps.acquisitionService) {
          throw new FridayDomainError("NOT_IMPLEMENTED", "Capability acquisition service is not configured", { httpStatus: 501 });
        }
        requireUserId(ctx.principal);
        const { id } = ctx.params as { id: string };
        return { run: deps.acquisitionService.cancelRun(id) };
      },
    },
    {
      operationId: "autonomy.policy.get",
      method: "GET",
      path: "/v1/autonomy-policy",
      auth: { public: false, anyOfScopes: ["agent.read"] },
      async handler(): Promise<FridayAutonomyPolicyResponse> {
        if (!deps.policyService) {
          throw new FridayDomainError("NOT_IMPLEMENTED", "Autonomy policy service is not configured", { httpStatus: 501 });
        }
        return { policy: deps.policyService.getPolicy() };
      },
    },
    {
      operationId: "autonomy.policy.patch",
      method: "PATCH",
      path: "/v1/autonomy-policy",
      auth: { public: false, anyOfScopes: ["agent.write"] },
      async handler(ctx): Promise<FridayAutonomyPolicyResponse> {
        if (!deps.policyService) {
          throw new FridayDomainError("NOT_IMPLEMENTED", "Autonomy policy service is not configured", { httpStatus: 501 });
        }
        requireUserId(ctx.principal);
        const body = (ctx.body ?? {}) as FridayPatchAutonomyPolicyRequest;
        return { policy: deps.policyService.updatePolicy(body) };
      },
    },
    {
      operationId: "standing.goals.list",
      method: "GET",
      path: "/v1/standing-goals",
      auth: { public: false, anyOfScopes: ["agent.read"] },
      async handler(ctx): Promise<FridayListStandingGoalsResponse> {
        if (!deps.standingAgendaService) {
          throw new FridayDomainError("NOT_IMPLEMENTED", "Standing goals service is not configured", { httpStatus: 501 });
        }
        const query = (ctx.query ?? {}) as Record<string, unknown>;
        const userId = requireUserId(ctx.principal, query);
        return {
          items: deps.standingAgendaService.listStandingGoals({
            userId,
            includeArchived: readBoolean(query.includeArchived),
          }),
        };
      },
    },
    {
      operationId: "standing.goals.create",
      method: "POST",
      path: "/v1/standing-goals",
      auth: { public: false, anyOfScopes: ["agent.write"] },
      rateLimitPolicyId: "agent.run",
      async handler(ctx): Promise<FridayStandingGoalResponse> {
        if (!deps.standingAgendaService) {
          throw new FridayDomainError("NOT_IMPLEMENTED", "Standing goals service is not configured", { httpStatus: 501 });
        }
        const body = (ctx.body ?? {}) as FridayCreateStandingGoalRequest;
        const userId = requireUserId(ctx.principal, body as unknown as Record<string, unknown>);
        const result = await deps.standingAgendaService.createStandingGoal({
          ...body,
          userId,
          objective: requireNonEmptyString(body.objective, "objective"),
        });
        return { goal: result.goal, agendaItem: result.agendaItem };
      },
    },
    {
      operationId: "standing.goals.patch",
      method: "PATCH",
      path: "/v1/standing-goals/:id",
      auth: { public: false, anyOfScopes: ["agent.write"] },
      async handler(ctx): Promise<FridayStandingGoalResponse> {
        if (!deps.standingAgendaService) {
          throw new FridayDomainError("NOT_IMPLEMENTED", "Standing goals service is not configured", { httpStatus: 501 });
        }
        requireUserId(ctx.principal);
        const { id } = ctx.params as { id: string };
        const body = (ctx.body ?? {}) as FridayPatchStandingGoalRequest;
        return { goal: deps.standingAgendaService.updateStandingGoal(id, body) };
      },
    },
    {
      operationId: "agenda.list",
      method: "GET",
      path: "/v1/agenda",
      auth: { public: false, anyOfScopes: ["agent.read"] },
      async handler(ctx): Promise<FridayListAgendaResponse> {
        if (!deps.standingAgendaService) {
          throw new FridayDomainError("NOT_IMPLEMENTED", "Standing goals service is not configured", { httpStatus: 501 });
        }
        const query = (ctx.query ?? {}) as Record<string, unknown>;
        const userId = requireUserId(ctx.principal, query);
        return {
          items: deps.standingAgendaService.listAgenda({
            userId,
            status: typeof query.status === "string" && query.status.trim().length > 0 ? query.status : undefined,
            limit: readLimit(query.limit),
          }),
        };
      },
    },
    {
      operationId: "agenda.approve",
      method: "POST",
      path: "/v1/agenda/:id/approve",
      auth: { public: false, anyOfScopes: ["agent.write"] },
      async handler(ctx): Promise<FridayAgendaItemResponse> {
        if (!deps.standingAgendaService) {
          throw new FridayDomainError("NOT_IMPLEMENTED", "Standing goals service is not configured", { httpStatus: 501 });
        }
        const userId = requireUserId(ctx.principal);
        const { id } = ctx.params as { id: string };
        return { item: deps.standingAgendaService.approveAgendaItem({ agendaItemId: id, userId }) };
      },
    },
    {
      operationId: "agenda.run",
      method: "POST",
      path: "/v1/agenda/:id/run",
      auth: { public: false, anyOfScopes: ["agent.write"] },
      rateLimitPolicyId: "agent.run",
      async handler(ctx): Promise<FridayAgendaRunResponse> {
        if (!deps.standingAgendaService) {
          throw new FridayDomainError("NOT_IMPLEMENTED", "Standing goals service is not configured", { httpStatus: 501 });
        }
        const userId = requireUserId(ctx.principal);
        const { id } = ctx.params as { id: string };
        return { run: await deps.standingAgendaService.runAgendaItem({ agendaItemId: id, userId }) };
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
          const candidateId = requireNonEmptyString(body.candidateId, "candidateId");
          const shadowVersionId = typeof body.shadowVersionId === "string" && body.shadowVersionId.trim().length > 0
            ? body.shadowVersionId.trim()
            : candidateId;
          const runtimeVersion = requireNonEmptyString(body.runtimeVersion, "runtimeVersion");
          const providerModel = typeof body.providerModel === "string" ? body.providerModel : undefined;
          const planDigest = typeof body.planDigest === "string" ? body.planDigest : undefined;
          const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
          const canonicalApproval = requireSkillLifecycleCanonicalApproval(
            "shadow",
            readCanonicalApproval(body.canonicalApproval),
          );
          const skill = await deps.skillActions!.registerShadow({
            skillId,
            candidateId,
            shadowVersionId,
            runtimeVersion,
            providerModel,
            planDigest,
            idempotencyKey,
            canonicalApproval,
            actor: createActorFromPrincipal(ctx.principal, `api:${ctx.requestId}`),
            surface: "api:/v1/autonomy/skills/shadow",
          });
          const status = deps.skillActions!.getStatus(skillId);
          return {
            skill: buildSkillUpgradeActionPayload(skill, status),
            status,
            evidence: requireSkillLifecycleEvidence({ deps, skillId, candidateId, expectedStage: "shadow" }),
          };
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
          if (body.success !== undefined || body.evaluatedAt !== undefined) {
            throw new FridayDomainError(
              "SKILL_CANARY_RUNTIME_PROOF_REQUIRED",
              "Skill canary results cannot be supplied by the caller; the lifecycle runtime must execute the canary.",
              { httpStatus: 400 },
            );
          }
          const candidateId = requireNonEmptyString(body.candidateId, "candidateId");
          const runtimeVersion = requireNonEmptyString(body.runtimeVersion, "runtimeVersion");
          const providerModel = typeof body.providerModel === "string" ? body.providerModel : undefined;
          const planDigest = typeof body.planDigest === "string" ? body.planDigest : undefined;
          const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
          const canonicalApproval = requireSkillLifecycleCanonicalApproval(
            "canary",
            readCanonicalApproval(body.canonicalApproval),
          );
          const skill = await deps.skillActions!.recordCanary({
            skillId,
            candidateId,
            runtimeVersion,
            providerModel,
            input: readOptionalRecord(body.input, "input"),
            planDigest,
            idempotencyKey,
            canonicalApproval,
            actor: createActorFromPrincipal(ctx.principal, `api:${ctx.requestId}`),
            surface: "api:/v1/autonomy/skills/canary",
          });
          const status = deps.skillActions!.getStatus(skillId);
          return {
            skill: buildSkillUpgradeActionPayload(skill, status),
            status,
            evidence: requireSkillLifecycleEvidence({ deps, skillId, candidateId, expectedStage: "canary" }),
          };
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
          const candidateId = requireNonEmptyString(body.candidateId, "candidateId");
          const runtimeVersion = requireNonEmptyString(body.runtimeVersion, "runtimeVersion");
          const providerModel = typeof body.providerModel === "string" ? body.providerModel : undefined;
          const planDigest = requireNonEmptyString(body.planDigest, "planDigest");
          const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
          const canonicalApproval = requireSkillLifecycleCanonicalApproval(
            "promote",
            readCanonicalApproval(body.canonicalApproval),
          );
          const skill = await deps.skillActions!.promote({
            skillId,
            candidateId,
            runtimeVersion,
            providerModel,
            planDigest,
            idempotencyKey,
            canonicalApproval,
            actor: createActorFromPrincipal(ctx.principal, `api:${ctx.requestId}`),
            surface: "api:/v1/autonomy/skills/promote",
          });
          const status = deps.skillActions!.getStatus(skillId);
          return {
            skill: buildSkillUpgradeActionPayload(skill, status),
            status,
            evidence: requireSkillLifecycleEvidence({ deps, skillId, candidateId, expectedStage: "active" }),
          };
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
          const candidateId = requireNonEmptyString(body.candidateId, "candidateId");
          const runtimeVersion = requireNonEmptyString(body.runtimeVersion, "runtimeVersion");
          const providerModel = typeof body.providerModel === "string" ? body.providerModel : undefined;
          const planDigest = requireNonEmptyString(body.planDigest, "planDigest");
          const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
          const canonicalApproval = requireSkillLifecycleCanonicalApproval(
            "rollback",
            readCanonicalApproval(body.canonicalApproval),
          );
          const skill = await deps.skillActions!.rollback({
            skillId,
            candidateId,
            runtimeVersion,
            providerModel,
            reason: typeof body.reason === "string" ? body.reason : undefined,
            planDigest,
            idempotencyKey,
            canonicalApproval,
            actor: createActorFromPrincipal(ctx.principal, `api:${ctx.requestId}`),
            surface: "api:/v1/autonomy/skills/rollback",
          });
          const status = deps.skillActions!.getStatus(skillId);
          return {
            skill: buildSkillUpgradeActionPayload(skill, status),
            status,
            evidence: requireSkillLifecycleEvidence({ deps, skillId, candidateId, expectedStage: "rolled_back" }),
          };
        },
      },
    );
  }

  if (deps.pluginActions) {
    routes.push(
      {
        operationId: "autonomy.plugins.review.enable",
        method: "POST",
        path: "/v1/autonomy/plugins/:pluginId/review-enable",
        auth: { public: false, anyOfScopes: ["hub.admin"] },
        async handler(ctx) {
          if (!deps.pluginActions!.reviewEnable) {
            throw new FridayDomainError(
              "PLUGIN_REVIEW_ENABLE_UNAVAILABLE",
              "Plugin review-enable requires a runtime-backed plugin lifecycle service.",
              { httpStatus: 503 },
            );
          }
          const { pluginId } = ctx.params as { pluginId: string };
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const plugin = await deps.pluginActions!.reviewEnable({
            pluginId,
            runtimeVersion: typeof body.runtimeVersion === "string" ? body.runtimeVersion : undefined,
            providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
            idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
            actor: createActorFromPrincipal(ctx.principal, `api:${ctx.requestId}`),
            surface: "api:/v1/autonomy/plugins/review-enable",
          });
          const status = deps.pluginActions!.getStatus(pluginId);
          return {
            plugin: buildPluginUpgradeActionPayload(plugin),
            status,
            evidence: requirePluginLifecycleEvidence({ deps, pluginId, expectedStage: "active" }),
          };
        },
      },
      {
        operationId: "autonomy.plugins.shadow",
        method: "POST",
        path: "/v1/autonomy/plugins/:pluginId/shadow",
        auth: { public: false, anyOfScopes: ["hub.admin"] },
        async handler(ctx) {
          const { pluginId } = ctx.params as { pluginId: string };
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const planDigest = requireNonEmptyString(body.planDigest, "planDigest");
          const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
          const canonicalApproval = requirePluginLifecycleCanonicalApproval(
            "shadow",
            readCanonicalApproval(body.canonicalApproval),
          );
          const plugin = await deps.pluginActions!.registerShadow({
            pluginId,
            shadowVersionId: requireNonEmptyString(body.shadowVersionId, "shadowVersionId"),
            runtimeVersion: requireNonEmptyString(body.runtimeVersion, "runtimeVersion"),
            providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
            planDigest,
            idempotencyKey,
            canonicalApproval,
            actor: createActorFromPrincipal(ctx.principal, `api:${ctx.requestId}`),
            surface: "api:/v1/autonomy/plugins/shadow",
          });
          const status = deps.pluginActions!.getStatus(pluginId);
          return {
            plugin: buildPluginUpgradeActionPayload(plugin),
            status,
            evidence: requirePluginLifecycleEvidence({ deps, pluginId, expectedStage: "shadow" }),
          };
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
          if (body.success !== undefined || body.evaluatedAt !== undefined) {
            throw new FridayDomainError(
              "PLUGIN_CANARY_RUNTIME_PROOF_REQUIRED",
              "Plugin canary success must be produced by the lifecycle runtime, not supplied by the caller.",
              { httpStatus: 400 },
            );
          }
          const planDigest = requireNonEmptyString(body.planDigest, "planDigest");
          const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
          const canonicalApproval = requirePluginLifecycleCanonicalApproval(
            "canary",
            readCanonicalApproval(body.canonicalApproval),
          );
          const plugin = await deps.pluginActions!.recordCanary({
            pluginId,
            runtimeVersion: requireNonEmptyString(body.runtimeVersion, "runtimeVersion"),
            providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
            planDigest,
            idempotencyKey,
            canonicalApproval,
            actor: createActorFromPrincipal(ctx.principal, `api:${ctx.requestId}`),
            surface: "api:/v1/autonomy/plugins/canary",
          });
          const status = deps.pluginActions!.getStatus(pluginId);
          return {
            plugin: buildPluginUpgradeActionPayload(plugin),
            status,
            evidence: requirePluginLifecycleEvidence({ deps, pluginId, expectedStage: "canary" }),
          };
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
          const planDigest = requireNonEmptyString(body.planDigest, "planDigest");
          const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
          const canonicalApproval = requirePluginLifecycleCanonicalApproval(
            "promote",
            readCanonicalApproval(body.canonicalApproval),
          );
          const plugin = await deps.pluginActions!.promote({
            pluginId,
            runtimeVersion: requireNonEmptyString(body.runtimeVersion, "runtimeVersion"),
            providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
            planDigest,
            idempotencyKey,
            canonicalApproval,
            actor: createActorFromPrincipal(ctx.principal, `api:${ctx.requestId}`),
            surface: "api:/v1/autonomy/plugins/promote",
          });
          const status = deps.pluginActions!.getStatus(pluginId);
          return {
            plugin: buildPluginUpgradeActionPayload(plugin),
            status,
            evidence: requirePluginLifecycleEvidence({ deps, pluginId, expectedStage: "active" }),
          };
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
          const planDigest = requireNonEmptyString(body.planDigest, "planDigest");
          const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
          const canonicalApproval = requirePluginLifecycleCanonicalApproval(
            "rollback",
            readCanonicalApproval(body.canonicalApproval),
          );
          const plugin = await deps.pluginActions!.rollback({
            pluginId,
            runtimeVersion: requireNonEmptyString(body.runtimeVersion, "runtimeVersion"),
            providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
            reason: typeof body.reason === "string" ? body.reason : undefined,
            planDigest,
            idempotencyKey,
            canonicalApproval,
            actor: createActorFromPrincipal(ctx.principal, `api:${ctx.requestId}`),
            surface: "api:/v1/autonomy/plugins/rollback",
          });
          const status = deps.pluginActions!.getStatus(pluginId);
          return {
            plugin: buildPluginUpgradeActionPayload(plugin),
            status,
            evidence: requirePluginLifecycleEvidence({ deps, pluginId, expectedStage: "rolled_back" }),
          };
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
          const planDigest = requireNonEmptyString(body.planDigest, "planDigest");
          const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
          const canonicalApproval = requireProviderProfileLifecycleCanonicalApproval(
            "shadow",
            readCanonicalApproval(body.canonicalApproval),
          );
          const provider = await deps.providerProfileActions!.registerShadow({
            providerId,
            shadowVersionId: requireNonEmptyString(body.shadowVersionId, "shadowVersionId"),
            runtimeVersion: requireNonEmptyString(body.runtimeVersion, "runtimeVersion"),
            providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
            planDigest,
            idempotencyKey,
            canonicalApproval,
            actor: createActorFromPrincipal(ctx.principal, `api:${ctx.requestId}`),
            surface: "api:/v1/autonomy/providers/shadow",
          });
          const status = deps.providerProfileActions!.getStatus(providerId);
          return {
            provider: buildProviderProfileUpgradeActionPayload(provider),
            status,
            evidence: requireProviderProfileLifecycleEvidence({ deps, providerId, expectedStage: "shadow" }),
          };
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
          if (body.success !== undefined || body.evaluatedAt !== undefined) {
            throw new FridayDomainError(
              "PROVIDER_CANARY_RUNTIME_PROOF_REQUIRED",
              "Provider canary results cannot be supplied by the caller; the lifecycle runtime must validate the provider.",
              { httpStatus: 400 },
            );
          }
          const runtimeVersion = requireNonEmptyString(body.runtimeVersion, "runtimeVersion");
          const providerModel = typeof body.providerModel === "string" ? body.providerModel : undefined;
          const planDigest = requireNonEmptyString(body.planDigest, "planDigest");
          const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
          const canonicalApproval = requireProviderProfileLifecycleCanonicalApproval(
            "canary",
            readCanonicalApproval(body.canonicalApproval),
          );
          const provider = await deps.providerProfileActions!.recordCanary({
            providerId,
            runtimeVersion,
            providerModel,
            planDigest,
            idempotencyKey,
            canonicalApproval,
            actor: createActorFromPrincipal(ctx.principal, `api:${ctx.requestId}`),
            surface: "api:/v1/autonomy/providers/canary",
            tenantContext: buildProviderLifecycleTenantContext(ctx.principal),
          });
          const status = deps.providerProfileActions!.getStatus(providerId);
          return {
            provider: buildProviderProfileUpgradeActionPayload(provider),
            status,
            evidence: requireProviderProfileLifecycleEvidence({ deps, providerId, expectedStage: "canary" }),
          };
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
          const planDigest = requireNonEmptyString(body.planDigest, "planDigest");
          const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
          const canonicalApproval = requireProviderProfileLifecycleCanonicalApproval(
            "promote",
            readCanonicalApproval(body.canonicalApproval),
          );
          const provider = await deps.providerProfileActions!.promote({
            providerId,
            runtimeVersion: requireNonEmptyString(body.runtimeVersion, "runtimeVersion"),
            providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
            planDigest,
            idempotencyKey,
            canonicalApproval,
            actor: createActorFromPrincipal(ctx.principal, `api:${ctx.requestId}`),
            surface: "api:/v1/autonomy/providers/promote",
          });
          const status = deps.providerProfileActions!.getStatus(providerId);
          return {
            provider: buildProviderProfileUpgradeActionPayload(provider),
            status,
            evidence: requireProviderProfileLifecycleEvidence({ deps, providerId, expectedStage: "active" }),
          };
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
          const planDigest = requireNonEmptyString(body.planDigest, "planDigest");
          const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
          const canonicalApproval = requireProviderProfileLifecycleCanonicalApproval(
            "rollback",
            readCanonicalApproval(body.canonicalApproval),
          );
          const provider = await deps.providerProfileActions!.rollback({
            providerId,
            runtimeVersion: requireNonEmptyString(body.runtimeVersion, "runtimeVersion"),
            providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
            reason: typeof body.reason === "string" ? body.reason : undefined,
            planDigest,
            idempotencyKey,
            canonicalApproval,
            actor: createActorFromPrincipal(ctx.principal, `api:${ctx.requestId}`),
            surface: "api:/v1/autonomy/providers/rollback",
          });
          const status = deps.providerProfileActions!.getStatus(providerId);
          return {
            provider: buildProviderProfileUpgradeActionPayload(provider),
            status,
            evidence: requireProviderProfileLifecycleEvidence({ deps, providerId, expectedStage: "rolled_back" }),
          };
        },
      },
    );
  }

  if (deps.mcpServerActions) {
    routes.push(
      {
        operationId: "autonomy.mcp.servers.shadow",
        method: "POST",
        path: "/v1/autonomy/mcp-servers/:serverId/shadow",
        auth: { public: false, anyOfScopes: ["hub.admin"] },
        async handler(ctx) {
          const { serverId } = ctx.params as { serverId: string };
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const planDigest = requireNonEmptyString(body.planDigest, "planDigest");
          const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
          const canonicalApproval = requireMcpServerLifecycleCanonicalApproval(
            "shadow",
            readCanonicalApproval(body.canonicalApproval),
          );
          await deps.mcpServerActions!.registerShadow({
            serverId,
            shadowVersionId: requireNonEmptyString(body.shadowVersionId, "shadowVersionId"),
            runtimeVersion: requireNonEmptyString(body.runtimeVersion, "runtimeVersion"),
            providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
            planDigest,
            idempotencyKey,
            canonicalApproval,
            actor: createActorFromPrincipal(ctx.principal, `api:${ctx.requestId}`),
            surface: "api:/v1/autonomy/mcp-servers/shadow",
          });
          const status = deps.mcpServerActions!.getStatus(serverId);
          return {
            server: buildMcpServerUpgradeActionPayload(status),
            status,
            evidence: requireMcpServerLifecycleEvidence({ deps, serverId, expectedStage: "shadow" }),
          };
        },
      },
      {
        operationId: "autonomy.mcp.servers.canary",
        method: "POST",
        path: "/v1/autonomy/mcp-servers/:serverId/canary",
        auth: { public: false, anyOfScopes: ["hub.admin"] },
        async handler(ctx) {
          const { serverId } = ctx.params as { serverId: string };
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          if ("success" in body || "evaluatedAt" in body) {
            throw new FridayDomainError("MCP_SERVER_CANARY_RUNTIME_PROOF_REQUIRED", "MCP server canary success must be produced by Friday's read-only runtime smoke, not supplied by the caller.", {
              httpStatus: 400,
            });
          }
          const planDigest = requireNonEmptyString(body.planDigest, "planDigest");
          const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
          const canonicalApproval = requireMcpServerLifecycleCanonicalApproval(
            "canary",
            readCanonicalApproval(body.canonicalApproval),
          );
          await deps.mcpServerActions!.recordCanary({
            serverId,
            runtimeVersion: requireNonEmptyString(body.runtimeVersion, "runtimeVersion"),
            providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
            planDigest,
            idempotencyKey,
            canonicalApproval,
            actor: createActorFromPrincipal(ctx.principal, `api:${ctx.requestId}`),
            surface: "api:/v1/autonomy/mcp-servers/canary",
          });
          const status = deps.mcpServerActions!.getStatus(serverId);
          return {
            server: buildMcpServerUpgradeActionPayload(status),
            status,
            evidence: requireMcpServerLifecycleEvidence({ deps, serverId, expectedStage: "canary" }),
          };
        },
      },
      {
        operationId: "autonomy.mcp.servers.promote",
        method: "POST",
        path: "/v1/autonomy/mcp-servers/:serverId/promote",
        auth: { public: false, anyOfScopes: ["hub.admin"] },
        async handler(ctx) {
          const { serverId } = ctx.params as { serverId: string };
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const planDigest = requireNonEmptyString(body.planDigest, "planDigest");
          const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
          const canonicalApproval = requireMcpServerLifecycleCanonicalApproval(
            "promote",
            readCanonicalApproval(body.canonicalApproval),
          );
          await deps.mcpServerActions!.promote({
            serverId,
            runtimeVersion: requireNonEmptyString(body.runtimeVersion, "runtimeVersion"),
            providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
            planDigest,
            idempotencyKey,
            canonicalApproval,
            actor: createActorFromPrincipal(ctx.principal, `api:${ctx.requestId}`),
            surface: "api:/v1/autonomy/mcp-servers/promote",
          });
          const status = deps.mcpServerActions!.getStatus(serverId);
          return {
            server: buildMcpServerUpgradeActionPayload(status),
            status,
            evidence: requireMcpServerLifecycleEvidence({ deps, serverId, expectedStage: "active" }),
          };
        },
      },
      {
        operationId: "autonomy.mcp.servers.rollback",
        method: "POST",
        path: "/v1/autonomy/mcp-servers/:serverId/rollback",
        auth: { public: false, anyOfScopes: ["hub.admin"] },
        async handler(ctx) {
          const { serverId } = ctx.params as { serverId: string };
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const planDigest = requireNonEmptyString(body.planDigest, "planDigest");
          const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
          const canonicalApproval = requireMcpServerLifecycleCanonicalApproval(
            "rollback",
            readCanonicalApproval(body.canonicalApproval),
          );
          await deps.mcpServerActions!.rollback({
            serverId,
            runtimeVersion: requireNonEmptyString(body.runtimeVersion, "runtimeVersion"),
            providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
            reason: typeof body.reason === "string" ? body.reason : undefined,
            planDigest,
            idempotencyKey,
            canonicalApproval,
            actor: createActorFromPrincipal(ctx.principal, `api:${ctx.requestId}`),
            surface: "api:/v1/autonomy/mcp-servers/rollback",
          });
          const status = deps.mcpServerActions!.getStatus(serverId);
          return {
            server: buildMcpServerUpgradeActionPayload(status),
            status,
            evidence: requireMcpServerLifecycleEvidence({ deps, serverId, expectedStage: "rolled_back" }),
          };
        },
      },
    );
  }

  if (deps.channelAdapterActions) {
    routes.push(
      {
        operationId: "autonomy.channels.shadow",
        method: "POST",
        path: "/v1/autonomy/channels/:channelKind/shadow",
        auth: { public: false, anyOfScopes: ["hub.admin"] },
        async handler(ctx) {
          const { channelKind } = ctx.params as { channelKind: string };
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          await deps.channelAdapterActions!.registerShadow({
            channelKind,
            shadowVersionId: requireNonEmptyString(body.shadowVersionId, "shadowVersionId"),
            runtimeVersion: requireNonEmptyString(body.runtimeVersion, "runtimeVersion"),
            providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
          });
          const status = deps.channelAdapterActions!.getStatus(channelKind);
          return { channel: buildChannelAdapterUpgradeActionPayload(status), status };
        },
      },
      {
        operationId: "autonomy.channels.canary",
        method: "POST",
        path: "/v1/autonomy/channels/:channelKind/canary",
        auth: { public: false, anyOfScopes: ["hub.admin"] },
        async handler(ctx) {
          const { channelKind } = ctx.params as { channelKind: string };
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          if (typeof body.success !== "boolean") {
            throw new FridayDomainError("VALIDATION_ERROR", "success must be a boolean", {
              httpStatus: 400,
            });
          }
          await deps.channelAdapterActions!.recordCanary({
            channelKind,
            success: body.success,
            evaluatedAt: typeof body.evaluatedAt === "string" ? body.evaluatedAt : undefined,
          });
          const status = deps.channelAdapterActions!.getStatus(channelKind);
          return { channel: buildChannelAdapterUpgradeActionPayload(status), status };
        },
      },
      {
        operationId: "autonomy.channels.promote",
        method: "POST",
        path: "/v1/autonomy/channels/:channelKind/promote",
        auth: { public: false, anyOfScopes: ["hub.admin"] },
        async handler(ctx) {
          const { channelKind } = ctx.params as { channelKind: string };
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          await deps.channelAdapterActions!.promote({
            channelKind,
            runtimeVersion: requireNonEmptyString(body.runtimeVersion, "runtimeVersion"),
            providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
          });
          const status = deps.channelAdapterActions!.getStatus(channelKind);
          return { channel: buildChannelAdapterUpgradeActionPayload(status), status };
        },
      },
      {
        operationId: "autonomy.channels.rollback",
        method: "POST",
        path: "/v1/autonomy/channels/:channelKind/rollback",
        auth: { public: false, anyOfScopes: ["hub.admin"] },
        async handler(ctx) {
          const { channelKind } = ctx.params as { channelKind: string };
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          await deps.channelAdapterActions!.rollback({
            channelKind,
            runtimeVersion: requireNonEmptyString(body.runtimeVersion, "runtimeVersion"),
            providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
          });
          const status = deps.channelAdapterActions!.getStatus(channelKind);
          return { channel: buildChannelAdapterUpgradeActionPayload(status), status };
        },
      },
    );
  }

  return routes;
}
