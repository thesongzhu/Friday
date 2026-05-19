/**
 * Phase 13.5A task workflow HTTP routes — `/v1/task-workflows*`.
 *
 * These routes are a SEPARATE product surface from `/v1/agent/runs`. They
 * never mutate agent run state. When the runtime is constructed without a
 * task-workflow service slot, the routes return `503 TASK_WORKFLOWS_DISABLED`
 * with a structured `disabledReason`, never 404, matching the pattern used
 * by Phase 02a media-understanding routes.
 *
 * @module api/http/routes/friday-task-workflow-routes
 */

import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import { FridayDomainError } from "#errors";
import {
  assertBoundPrincipalForOperation,
  type FridayPublicMutationOperation,
} from "../../../security/friday-owner-session-channel-capability.js";

import {
  FRIDAY_TASK_WORKFLOW_BUILTIN_BOUNDARIES,
  FRIDAY_TASK_WORKFLOW_BUILTIN_GATES,
  type FridayTaskWorkflowAttachEvidenceRefInput,
  type FridayTaskWorkflowBlockClaimInput,
  type FridayTaskWorkflowChannelIntentKind,
  type FridayTaskWorkflowClaimKind,
  type FridayTaskWorkflowCliBackendId,
  type FridayTaskWorkflowCompleteLaneInput,
  type FridayTaskWorkflowConfirmChannelCommandInput,
  type FridayTaskWorkflowContextPackage,
  type FridayTaskWorkflowCreateInput,
  type FridayTaskWorkflowDraftClaimInput,
  type FridayTaskWorkflowEvidenceExplorerQuery,
  type FridayTaskWorkflowEvidenceSource,
  type FridayTaskWorkflowFallbackAvailability,
  type FridayTaskWorkflowIssueChannelCommandInput,
  type FridayTaskWorkflowLaneIndependence,
  type FridayTaskWorkflowLaneRole,
  type FridayTaskWorkflowOpenExecutorLaneInput,
  type FridayTaskWorkflowOpenVerifierLaneInput,
  type FridayTaskWorkflowRecordCliHandoffInput,
  type FridayTaskWorkflowReviseInput,
  type FridayTaskWorkflowRisk,
  type FridayTaskWorkflowService,
  type FridayTaskWorkflowSubmitVerifierVerdictInput,
  type FridayTaskWorkflowSupervisorMode,
  type FridayTaskWorkflowVerifyClaimInput,
} from "../../../task-workflows/index.js";

const VALID_CHANNEL_INTENT_KINDS: ReadonlySet<FridayTaskWorkflowChannelIntentKind> = new Set([
  "progress_query",
  "closeout_request",
  "supervisor_mode_preview",
  "confirm_token",
]);

export interface FridayTaskWorkflowRoutesDeps {
  /** Active task workflow service when enabled; null when disabled. */
  readonly service: FridayTaskWorkflowService | null;
  /** Structured short reason from bootstrap explaining why task workflows
   *  are disabled. Must never echo secret material. */
  readonly disabledReason: string | null;
}

const DEFAULT_DISABLED_MESSAGE =
  "Task workflows are not enabled in this runtime.";

const VALID_RISKS: ReadonlySet<FridayTaskWorkflowRisk> = new Set([
  "low",
  "medium",
  "high",
]);

const VALID_SUPERVISOR_MODES: ReadonlySet<FridayTaskWorkflowSupervisorMode> = new Set([
  "off",
  "light",
  "standard",
  "strict",
]);

const VALID_CLAIM_KINDS: ReadonlySet<FridayTaskWorkflowClaimKind> = new Set([
  "docs_intent",
  "summary_replay",
  "cli_self_report",
  "provider_fallback",
  "runtime_evidence",
  "code_evidence",
  "api_evidence",
  "artifact_evidence",
]);

const VALID_EVIDENCE_SOURCES: ReadonlySet<FridayTaskWorkflowEvidenceSource> = new Set([
  "agent_run_event",
  "workflow_run_evidence",
  "provider_route_trace",
  "context_replay",
  "self_heal_event",
  "channel_event",
  "session_event",
  "observability_audit",
  "manual_external",
  "docs_intent_reference",
]);

const VALID_LANE_ROLES: ReadonlySet<FridayTaskWorkflowLaneRole> = new Set([
  "native",
  "provider",
  "cli",
]);

const VALID_CLI_BACKEND_IDS: ReadonlySet<FridayTaskWorkflowCliBackendId> = new Set([
  "codex-cli",
  "claude-cli",
]);

const VALID_INDEPENDENCE_CLAIMS: ReadonlySet<FridayTaskWorkflowLaneIndependence> = new Set([
  "independent",
  "degraded_unavailable",
  "degraded_same_provider",
]);

const VALID_LANE_COMPLETION_STATUSES: ReadonlySet<"completed" | "blocked"> = new Set([
  "completed",
  "blocked",
]);

const VALID_FALLBACK_AVAILABILITY: ReadonlySet<FridayTaskWorkflowFallbackAvailability> = new Set([
  "not_used",
  "used_same_provider",
  "used_alternate_provider",
]);

function disabledMessage(deps: FridayTaskWorkflowRoutesDeps): string {
  const reason = deps.disabledReason?.trim() ?? "";
  return reason.length > 0 ? reason : DEFAULT_DISABLED_MESSAGE;
}

function throwDisabled(deps: FridayTaskWorkflowRoutesDeps): never {
  throw new FridayDomainError(
    "TASK_WORKFLOWS_DISABLED",
    disabledMessage(deps),
    { httpStatus: 503 },
  );
}

function requireService(
  deps: FridayTaskWorkflowRoutesDeps,
): FridayTaskWorkflowService {
  if (!deps.service) {
    throwDisabled(deps);
  }
  return deps.service;
}

function assertTaskWorkflowMutationPrincipal(
  principal: Parameters<typeof assertBoundPrincipalForOperation>[0],
  operation: FridayPublicMutationOperation,
): void {
  assertBoundPrincipalForOperation(principal, operation, "api");
}

function asJsonObject(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "Request body must be a JSON object.",
      { httpStatus: 400 },
    );
  }
  return raw as Record<string, unknown>;
}

function parseRisk(value: unknown): FridayTaskWorkflowRisk | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !VALID_RISKS.has(value as FridayTaskWorkflowRisk)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `risk must be one of ${[...VALID_RISKS].join(", ")} when provided.`,
      { httpStatus: 400 },
    );
  }
  return value as FridayTaskWorkflowRisk;
}

function parseSupervisorMode(
  value: unknown,
): FridayTaskWorkflowSupervisorMode | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !VALID_SUPERVISOR_MODES.has(value as FridayTaskWorkflowSupervisorMode)
  ) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `supervisorMode must be one of ${[...VALID_SUPERVISOR_MODES].join(", ")} when provided.`,
      { httpStatus: 400 },
    );
  }
  return value as FridayTaskWorkflowSupervisorMode;
}

function parseStringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${field} must be a string array when provided.`,
      { httpStatus: 400 },
    );
  }
  return value.map((entry, idx) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `${field}[${idx}] must be a non-empty string.`,
        { httpStatus: 400 },
      );
    }
    return entry;
  });
}

function parseCreateBody(raw: unknown): FridayTaskWorkflowCreateInput {
  const body = asJsonObject(raw);
  if (typeof body.charter !== "string") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "charter is required.",
      { httpStatus: 400 },
    );
  }
  if (typeof body.taskKind !== "string") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "taskKind is required.",
      { httpStatus: 400 },
    );
  }
  const contextPackage = body.contextPackage as FridayTaskWorkflowContextPackage;
  return {
    charter: body.charter,
    taskKind: body.taskKind,
    risk: parseRisk(body.risk),
    supervisorMode: parseSupervisorMode(body.supervisorMode),
    contextPackage,
    additionalGateIds: parseStringArray(body.additionalGateIds, "additionalGateIds"),
    metadata: body.metadata !== undefined ? asJsonObject(body.metadata) : undefined,
  };
}

function parseReviseBody(raw: unknown): FridayTaskWorkflowReviseInput {
  const body = asJsonObject(raw);
  if (typeof body.charter !== "string") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "charter is required.",
      { httpStatus: 400 },
    );
  }
  if (typeof body.reason !== "string") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "reason is required.",
      { httpStatus: 400 },
    );
  }
  return {
    charter: body.charter,
    reason: body.reason,
    supervisorMode: parseSupervisorMode(body.supervisorMode),
    contextPackage: body.contextPackage as
      | FridayTaskWorkflowContextPackage
      | undefined,
    additionalGateIds:
      body.additionalGateIds === undefined
        ? undefined
        : parseStringArray(body.additionalGateIds, "additionalGateIds"),
  };
}

function parseDraftClaimBody(raw: unknown): FridayTaskWorkflowDraftClaimInput {
  const body = asJsonObject(raw);
  if (typeof body.claimText !== "string") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "claimText is required.",
      { httpStatus: 400 },
    );
  }
  if (
    typeof body.claimKind !== "string" ||
    !VALID_CLAIM_KINDS.has(body.claimKind as FridayTaskWorkflowClaimKind)
  ) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `claimKind must be one of ${[...VALID_CLAIM_KINDS].join(", ")}.`,
      { httpStatus: 400 },
    );
  }
  return {
    claimText: body.claimText,
    claimKind: body.claimKind as FridayTaskWorkflowClaimKind,
  };
}

function parseAttachEvidenceRefBody(
  raw: unknown,
): FridayTaskWorkflowAttachEvidenceRefInput {
  const body = asJsonObject(raw);
  if (typeof body.refKind !== "string") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "refKind is required.",
      { httpStatus: 400 },
    );
  }
  if (typeof body.refId !== "string") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "refId is required.",
      { httpStatus: 400 },
    );
  }
  if (
    typeof body.refSource !== "string" ||
    !VALID_EVIDENCE_SOURCES.has(body.refSource as FridayTaskWorkflowEvidenceSource)
  ) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `refSource must be one of ${[...VALID_EVIDENCE_SOURCES].join(", ")}.`,
      { httpStatus: 400 },
    );
  }
  return {
    refKind: body.refKind,
    refId: body.refId,
    refSource: body.refSource as FridayTaskWorkflowEvidenceSource,
    refHash: typeof body.refHash === "string" ? body.refHash : undefined,
  };
}

function parseVerifyClaimBody(raw: unknown): FridayTaskWorkflowVerifyClaimInput {
  const body = asJsonObject(raw);
  if (typeof body.verifierVerdict !== "string") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "verifierVerdict is required.",
      { httpStatus: 400 },
    );
  }
  let verifierLaneId: string | undefined;
  if (body.verifierLaneId !== undefined) {
    if (typeof body.verifierLaneId !== "string") {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        "verifierLaneId must be a string when provided.",
        { httpStatus: 400 },
      );
    }
    verifierLaneId = body.verifierLaneId;
  }
  return { verifierVerdict: body.verifierVerdict, verifierLaneId };
}

function parseLaneRole(value: unknown): FridayTaskWorkflowLaneRole {
  if (
    typeof value !== "string" ||
    !VALID_LANE_ROLES.has(value as FridayTaskWorkflowLaneRole)
  ) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `laneRole must be one of ${[...VALID_LANE_ROLES].join(", ")}.`,
      { httpStatus: 400 },
    );
  }
  return value as FridayTaskWorkflowLaneRole;
}

function parseIndependenceClaim(value: unknown): FridayTaskWorkflowLaneIndependence {
  if (
    typeof value !== "string" ||
    !VALID_INDEPENDENCE_CLAIMS.has(value as FridayTaskWorkflowLaneIndependence)
  ) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `independenceClaim must be one of ${[...VALID_INDEPENDENCE_CLAIMS].join(", ")}.`,
      { httpStatus: 400 },
    );
  }
  return value as FridayTaskWorkflowLaneIndependence;
}

function parseOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${field} must be a string when provided.`,
      { httpStatus: 400 },
    );
  }
  return value;
}

function parseOpenExecutorLaneBody(raw: unknown): FridayTaskWorkflowOpenExecutorLaneInput {
  const body = asJsonObject(raw);
  return {
    laneRole: parseLaneRole(body.laneRole),
    providerId: parseOptionalString(body.providerId, "providerId"),
  };
}

function parseOpenVerifierLaneBody(raw: unknown): FridayTaskWorkflowOpenVerifierLaneInput {
  const body = asJsonObject(raw);
  if (typeof body.parentLaneId !== "string") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "parentLaneId is required.",
      { httpStatus: 400 },
    );
  }
  return {
    parentLaneId: body.parentLaneId,
    laneRole: parseLaneRole(body.laneRole),
    providerId: parseOptionalString(body.providerId, "providerId"),
    independenceClaim: parseIndependenceClaim(body.independenceClaim),
  };
}

function parseCompleteLaneBody(raw: unknown): FridayTaskWorkflowCompleteLaneInput {
  const body = asJsonObject(raw);
  if (
    typeof body.status !== "string" ||
    !VALID_LANE_COMPLETION_STATUSES.has(body.status as "completed" | "blocked")
  ) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `status must be one of ${[...VALID_LANE_COMPLETION_STATUSES].join(", ")}.`,
      { httpStatus: 400 },
    );
  }
  let fallbackAvailability: FridayTaskWorkflowFallbackAvailability | undefined;
  if (body.fallbackAvailability !== undefined) {
    if (
      typeof body.fallbackAvailability !== "string" ||
      !VALID_FALLBACK_AVAILABILITY.has(
        body.fallbackAvailability as FridayTaskWorkflowFallbackAvailability,
      )
    ) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `fallbackAvailability must be one of ${[...VALID_FALLBACK_AVAILABILITY].join(", ")} when provided.`,
        { httpStatus: 400 },
      );
    }
    fallbackAvailability = body.fallbackAvailability as FridayTaskWorkflowFallbackAvailability;
  }
  return {
    status: body.status as "completed" | "blocked",
    executorRunRef:
      body.executorRunRef === undefined
        ? undefined
        : body.executorRunRef === null
          ? null
          : typeof body.executorRunRef === "string"
            ? body.executorRunRef
            : (() => {
                throw new FridayDomainError(
                  "VALIDATION_ERROR",
                  "executorRunRef must be a string or null when provided.",
                  { httpStatus: 400 },
                );
              })(),
    routeTraceRef:
      body.routeTraceRef === undefined
        ? undefined
        : body.routeTraceRef === null
          ? null
          : typeof body.routeTraceRef === "string"
            ? body.routeTraceRef
            : (() => {
                throw new FridayDomainError(
                  "VALIDATION_ERROR",
                  "routeTraceRef must be a string or null when provided.",
                  { httpStatus: 400 },
                );
              })(),
    fallbackAvailability,
    blocker: parseOptionalString(body.blocker, "blocker"),
  };
}

function parseSubmitVerifierVerdictBody(
  raw: unknown,
): FridayTaskWorkflowSubmitVerifierVerdictInput {
  const body = asJsonObject(raw);
  if (typeof body.claimId !== "string") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "claimId is required.",
      { httpStatus: 400 },
    );
  }
  if (typeof body.verifierVerdict !== "string") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "verifierVerdict is required.",
      { httpStatus: 400 },
    );
  }
  return {
    claimId: body.claimId,
    verifierVerdict: body.verifierVerdict,
  };
}

function parseBlockClaimBody(raw: unknown): FridayTaskWorkflowBlockClaimInput {
  const body = asJsonObject(raw);
  if (typeof body.reason !== "string") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "reason is required.",
      { httpStatus: 400 },
    );
  }
  return { reason: body.reason };
}

function parsePositiveIntOptional(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${field} must be a positive number when provided.`,
      { httpStatus: 400 },
    );
  }
  return Math.floor(value);
}

function parseRecordCliHandoffBody(
  raw: unknown,
): FridayTaskWorkflowRecordCliHandoffInput {
  const body = asJsonObject(raw);
  if (
    typeof body.backendId !== "string" ||
    !VALID_CLI_BACKEND_IDS.has(body.backendId as FridayTaskWorkflowCliBackendId)
  ) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `backendId must be one of ${[...VALID_CLI_BACKEND_IDS].join(", ")}.`,
      { httpStatus: 400 },
    );
  }
  if (typeof body.systemPrompt !== "string") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "systemPrompt is required.",
      { httpStatus: 400 },
    );
  }
  if (typeof body.conversation !== "string") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "conversation is required.",
      { httpStatus: 400 },
    );
  }
  return {
    backendId: body.backendId as FridayTaskWorkflowCliBackendId,
    systemPrompt: body.systemPrompt,
    conversation: body.conversation,
    model: parseOptionalString(body.model, "model"),
    timeoutMs: parsePositiveIntOptional(body.timeoutMs, "timeoutMs"),
    minSummaryChars: parsePositiveIntOptional(
      body.minSummaryChars,
      "minSummaryChars",
    ),
  };
}

function parseIssueChannelCommandBody(
  raw: unknown,
): FridayTaskWorkflowIssueChannelCommandInput {
  const body = asJsonObject(raw);
  if (typeof body.channelKind !== "string" || body.channelKind.trim().length === 0) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "channelKind is required.",
      { httpStatus: 400 },
    );
  }
  if (typeof body.channelChatId !== "string" || body.channelChatId.trim().length === 0) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "channelChatId is required.",
      { httpStatus: 400 },
    );
  }
  if (typeof body.channelMessageId !== "string" || body.channelMessageId.trim().length === 0) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "channelMessageId is required.",
      { httpStatus: 400 },
    );
  }
  if (typeof body.senderId !== "string" || body.senderId.trim().length === 0) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "senderId is required.",
      { httpStatus: 400 },
    );
  }
  if (
    typeof body.intentKind !== "string" ||
    !VALID_CHANNEL_INTENT_KINDS.has(body.intentKind as FridayTaskWorkflowChannelIntentKind)
  ) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `intentKind must be one of ${[...VALID_CHANNEL_INTENT_KINDS].join(", ")}.`,
      { httpStatus: 400 },
    );
  }
  return {
    channelKind: body.channelKind,
    channelChatId: body.channelChatId,
    channelMessageId: body.channelMessageId,
    senderId: body.senderId,
    intentKind: body.intentKind as FridayTaskWorkflowChannelIntentKind,
    ttlMs: parsePositiveIntOptional(body.ttlMs, "ttlMs"),
  };
}

function parseConfirmChannelCommandBody(
  raw: unknown,
): FridayTaskWorkflowConfirmChannelCommandInput {
  const body = asJsonObject(raw);
  if (typeof body.confirmationToken !== "string" || body.confirmationToken.trim().length === 0) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "confirmationToken is required.",
      { httpStatus: 400 },
    );
  }
  return { confirmationToken: body.confirmationToken };
}

function parseEvidenceExplorerQuery(
  raw: unknown,
): FridayTaskWorkflowEvidenceExplorerQuery {
  const query = (raw ?? {}) as Record<string, unknown>;
  const limitRaw = query.limit;
  let limit: number | undefined;
  if (typeof limitRaw === "string" && limitRaw.length > 0) {
    const parsed = Number(limitRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        "limit must be a positive integer when provided.",
        { httpStatus: 400 },
      );
    }
    limit = Math.floor(parsed);
  }
  const refSourceRaw = typeof query.refSource === "string" ? query.refSource : undefined;
  if (refSourceRaw && !VALID_EVIDENCE_SOURCES.has(refSourceRaw as FridayTaskWorkflowEvidenceSource)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `refSource must be one of ${[...VALID_EVIDENCE_SOURCES].join(", ")} when provided.`,
      { httpStatus: 400 },
    );
  }
  const claimKindRaw = typeof query.claimKind === "string" ? query.claimKind : undefined;
  if (claimKindRaw && !VALID_CLAIM_KINDS.has(claimKindRaw as FridayTaskWorkflowClaimKind)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `claimKind must be one of ${[...VALID_CLAIM_KINDS].join(", ")} when provided.`,
      { httpStatus: 400 },
    );
  }
  return {
    workflowId: typeof query.workflowId === "string" ? query.workflowId : undefined,
    claimId: typeof query.claimId === "string" ? query.claimId : undefined,
    refSource: refSourceRaw as FridayTaskWorkflowEvidenceSource | undefined,
    refKind: typeof query.refKind === "string" ? query.refKind : undefined,
    claimKind: claimKindRaw as FridayTaskWorkflowClaimKind | undefined,
    limit,
  };
}

export function createFridayTaskWorkflowRoutes(
  deps: FridayTaskWorkflowRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "task.workflows.boundaries.list",
      method: "GET",
      path: "/v1/task-workflows/boundaries",
      auth: { public: true },
      async handler() {
        return { items: FRIDAY_TASK_WORKFLOW_BUILTIN_BOUNDARIES };
      },
    },
    {
      operationId: "task.workflows.gates.list",
      method: "GET",
      path: "/v1/task-workflows/gates",
      auth: { public: true },
      async handler() {
        return { items: FRIDAY_TASK_WORKFLOW_BUILTIN_GATES };
      },
    },
    {
      operationId: "task.workflows.preview",
      method: "POST",
      path: "/v1/task-workflows/preview",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        const input = parseCreateBody(ctx.body);
        return { preview: service.preview(input) };
      },
    },
    {
      operationId: "task.workflows.create",
      method: "POST",
      path: "/v1/task-workflows",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        assertTaskWorkflowMutationPrincipal(ctx.principal ?? null, "task.workflow.create");
        const input = parseCreateBody(ctx.body);
        return { workflow: service.create(input) };
      },
    },
    {
      operationId: "task.workflows.list",
      method: "GET",
      path: "/v1/task-workflows",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        const limitRaw = (ctx.query as Record<string, unknown>)?.limit;
        const limit =
          typeof limitRaw === "string" && limitRaw.length > 0
            ? Number(limitRaw)
            : undefined;
        return { items: service.list({ limit }) };
      },
    },
    {
      operationId: "task.workflows.get",
      method: "GET",
      path: "/v1/task-workflows/:workflowId",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        const { workflowId } = ctx.params as { workflowId: string };
        return { workflow: service.get(workflowId) };
      },
    },
    {
      operationId: "task.workflows.revise",
      method: "POST",
      path: "/v1/task-workflows/:workflowId/revisions",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        assertTaskWorkflowMutationPrincipal(ctx.principal ?? null, "task.workflow.revise");
        const { workflowId } = ctx.params as { workflowId: string };
        const input = parseReviseBody(ctx.body);
        return service.revise(workflowId, input);
      },
    },
    {
      operationId: "task.workflows.revisions.list",
      method: "GET",
      path: "/v1/task-workflows/:workflowId/revisions",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        const { workflowId } = ctx.params as { workflowId: string };
        return { items: service.listRevisions(workflowId) };
      },
    },
    {
      operationId: "task.workflows.claims.create",
      method: "POST",
      path: "/v1/task-workflows/:workflowId/claims",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        assertTaskWorkflowMutationPrincipal(ctx.principal ?? null, "task.workflow.claim.create");
        const { workflowId } = ctx.params as { workflowId: string };
        const input = parseDraftClaimBody(ctx.body);
        return { claim: service.draftClaim(workflowId, input) };
      },
    },
    {
      operationId: "task.workflows.claims.list",
      method: "GET",
      path: "/v1/task-workflows/:workflowId/claims",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        const { workflowId } = ctx.params as { workflowId: string };
        return { items: service.listClaims(workflowId) };
      },
    },
    {
      operationId: "task.workflows.claims.get",
      method: "GET",
      path: "/v1/task-workflows/:workflowId/claims/:claimId",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        const { workflowId, claimId } = ctx.params as {
          workflowId: string;
          claimId: string;
        };
        return { claim: service.getClaim(workflowId, claimId) };
      },
    },
    {
      operationId: "task.workflows.claims.evidence.attach",
      method: "POST",
      path: "/v1/task-workflows/:workflowId/claims/:claimId/evidence-ref",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        // Phase 14.5A module_28a: refuse synthetic public principal for
        // evidence attach. Evidence attach is the verifier-lane fresh-read
        // boundary that WP-001 P1 calls out, so it must be bound to a real
        // owner/session/channel principal even though the route stays public
        // (no-login product posture is preserved by the synthetic principal
        // compatibility layer for read-only surfaces).
        assertTaskWorkflowMutationPrincipal(ctx.principal ?? null, "task.workflow.evidence.attach");
        const { workflowId, claimId } = ctx.params as {
          workflowId: string;
          claimId: string;
        };
        const input = parseAttachEvidenceRefBody(ctx.body);
        return service.attachEvidenceRef(workflowId, claimId, input);
      },
    },
    {
      operationId: "task.workflows.claims.evidence.list",
      method: "GET",
      path: "/v1/task-workflows/:workflowId/claims/:claimId/evidence-refs",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        const { workflowId, claimId } = ctx.params as {
          workflowId: string;
          claimId: string;
        };
        return { items: service.listEvidenceRefs(workflowId, claimId) };
      },
    },
    {
      operationId: "task.workflows.claims.verify",
      method: "POST",
      path: "/v1/task-workflows/:workflowId/claims/:claimId/verify",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        assertTaskWorkflowMutationPrincipal(ctx.principal ?? null, "task.workflow.claim.verify");
        const { workflowId, claimId } = ctx.params as {
          workflowId: string;
          claimId: string;
        };
        const input = parseVerifyClaimBody(ctx.body);
        return { claim: service.verifyClaim(workflowId, claimId, input) };
      },
    },
    {
      operationId: "task.workflows.claims.block",
      method: "POST",
      path: "/v1/task-workflows/:workflowId/claims/:claimId/block",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        assertTaskWorkflowMutationPrincipal(ctx.principal ?? null, "task.workflow.claim.block");
        const { workflowId, claimId } = ctx.params as {
          workflowId: string;
          claimId: string;
        };
        const input = parseBlockClaimBody(ctx.body);
        return { claim: service.blockClaim(workflowId, claimId, input) };
      },
    },
    {
      operationId: "task.workflows.closeout",
      method: "POST",
      path: "/v1/task-workflows/:workflowId/closeout",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        assertTaskWorkflowMutationPrincipal(ctx.principal ?? null, "task.workflow.closeout");
        const { workflowId } = ctx.params as { workflowId: string };
        return { receipt: service.closeout(workflowId) };
      },
    },
    {
      operationId: "task.workflows.lanes.executor.open",
      method: "POST",
      path: "/v1/task-workflows/:workflowId/lanes/executor",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        assertTaskWorkflowMutationPrincipal(ctx.principal ?? null, "task.workflow.lane.executor.open");
        const { workflowId } = ctx.params as { workflowId: string };
        const input = parseOpenExecutorLaneBody(ctx.body);
        return { lane: service.openExecutorLane(workflowId, input) };
      },
    },
    {
      operationId: "task.workflows.lanes.verifier.open",
      method: "POST",
      path: "/v1/task-workflows/:workflowId/lanes/verifier",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        assertTaskWorkflowMutationPrincipal(ctx.principal ?? null, "task.workflow.lane.verifier.open");
        const { workflowId } = ctx.params as { workflowId: string };
        const input = parseOpenVerifierLaneBody(ctx.body);
        return { lane: service.openVerifierLane(workflowId, input) };
      },
    },
    {
      operationId: "task.workflows.lanes.complete",
      method: "POST",
      path: "/v1/task-workflows/:workflowId/lanes/:laneId/complete",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        assertTaskWorkflowMutationPrincipal(ctx.principal ?? null, "task.workflow.lane.complete");
        const { workflowId, laneId } = ctx.params as {
          workflowId: string;
          laneId: string;
        };
        const input = parseCompleteLaneBody(ctx.body);
        return { lane: service.completeLane(workflowId, laneId, input) };
      },
    },
    {
      operationId: "task.workflows.lanes.verdict",
      method: "POST",
      path: "/v1/task-workflows/:workflowId/lanes/:laneId/verdict",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        assertTaskWorkflowMutationPrincipal(ctx.principal ?? null, "task.workflow.lane.verdict");
        const { workflowId, laneId } = ctx.params as {
          workflowId: string;
          laneId: string;
        };
        const input = parseSubmitVerifierVerdictBody(ctx.body);
        return { claim: service.submitVerifierVerdict(workflowId, laneId, input) };
      },
    },
    {
      operationId: "task.workflows.lanes.list",
      method: "GET",
      path: "/v1/task-workflows/:workflowId/lanes",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        const { workflowId } = ctx.params as { workflowId: string };
        return { items: service.listLanes(workflowId) };
      },
    },
    {
      operationId: "task.workflows.lanes.get",
      method: "GET",
      path: "/v1/task-workflows/:workflowId/lanes/:laneId",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        const { workflowId, laneId } = ctx.params as {
          workflowId: string;
          laneId: string;
        };
        return { lane: service.getLane(workflowId, laneId) };
      },
    },
    {
      operationId: "task.workflows.lanes.cli.handoff.record",
      method: "POST",
      path: "/v1/task-workflows/:workflowId/lanes/:laneId/cli-handoffs",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        assertTaskWorkflowMutationPrincipal(ctx.principal ?? null, "task.workflow.cli.handoff.record");
        const { workflowId, laneId } = ctx.params as {
          workflowId: string;
          laneId: string;
        };
        const input = parseRecordCliHandoffBody(ctx.body);
        const handoff = await service.recordCliHandoff(workflowId, laneId, input);
        return { handoff };
      },
    },
    {
      operationId: "task.workflows.lanes.cli.handoffs.list",
      method: "GET",
      path: "/v1/task-workflows/:workflowId/lanes/:laneId/cli-handoffs",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        const { workflowId, laneId } = ctx.params as {
          workflowId: string;
          laneId: string;
        };
        return { items: service.listCliHandoffsByLane(workflowId, laneId) };
      },
    },
    {
      operationId: "task.workflows.cli.handoffs.list",
      method: "GET",
      path: "/v1/task-workflows/:workflowId/cli-handoffs",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        const { workflowId } = ctx.params as { workflowId: string };
        return { items: service.listCliHandoffsByWorkflow(workflowId) };
      },
    },
    {
      operationId: "task.workflows.supervisor.read",
      method: "GET",
      path: "/v1/task-workflows/:workflowId/supervisor",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        const { workflowId } = ctx.params as { workflowId: string };
        return { overview: service.getSupervisorOverview(workflowId) };
      },
    },
    {
      operationId: "task.workflows.channel.command.issue",
      method: "POST",
      path: "/v1/task-workflows/:workflowId/channel-commands",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        assertTaskWorkflowMutationPrincipal(ctx.principal ?? null, "task.workflow.channel.command.issue");
        const { workflowId } = ctx.params as { workflowId: string };
        const input = parseIssueChannelCommandBody(ctx.body);
        return service.issueChannelCommand(workflowId, input);
      },
    },
    {
      operationId: "task.workflows.channel.command.list",
      method: "GET",
      path: "/v1/task-workflows/:workflowId/channel-commands",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        const { workflowId } = ctx.params as { workflowId: string };
        return { items: service.listChannelCommands(workflowId) };
      },
    },
    {
      operationId: "task.workflows.channel.command.confirm",
      method: "POST",
      path: "/v1/task-workflows/:workflowId/channel-commands/confirm",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        assertTaskWorkflowMutationPrincipal(ctx.principal ?? null, "task.workflow.channel.command.confirm");
        const { workflowId } = ctx.params as { workflowId: string };
        const input = parseConfirmChannelCommandBody(ctx.body);
        return service.confirmChannelCommand(workflowId, input);
      },
    },
    {
      operationId: "task.workflows.evidence.explorer.query",
      method: "GET",
      path: "/v1/task-workflows/evidence",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        const query = parseEvidenceExplorerQuery(ctx.query);
        return { items: service.queryEvidenceExplorer(query) };
      },
    },
    {
      operationId: "task.workflows.evidence.explorer.raw",
      method: "GET",
      path: "/v1/task-workflows/evidence/:evidenceRefId/raw",
      auth: { public: true },
      async handler(ctx) {
        const service = requireService(deps);
        const { evidenceRefId } = ctx.params as { evidenceRefId: string };
        const queryRecord = (ctx.query ?? {}) as Record<string, unknown>;
        const rawGate = queryRecord.gateConfirmed;
        const gateConfirmed =
          rawGate === true || rawGate === "true" || rawGate === "1";
        return {
          drilldown: service.getEvidenceRefRawDrilldown(evidenceRefId, gateConfirmed),
        };
      },
    },
  ];
}
