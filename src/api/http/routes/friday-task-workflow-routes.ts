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
  FRIDAY_TASK_WORKFLOW_BUILTIN_BOUNDARIES,
  FRIDAY_TASK_WORKFLOW_BUILTIN_GATES,
  type FridayTaskWorkflowAttachEvidenceRefInput,
  type FridayTaskWorkflowBlockClaimInput,
  type FridayTaskWorkflowClaimKind,
  type FridayTaskWorkflowContextPackage,
  type FridayTaskWorkflowCreateInput,
  type FridayTaskWorkflowDraftClaimInput,
  type FridayTaskWorkflowEvidenceSource,
  type FridayTaskWorkflowReviseInput,
  type FridayTaskWorkflowRisk,
  type FridayTaskWorkflowService,
  type FridayTaskWorkflowSupervisorMode,
  type FridayTaskWorkflowVerifyClaimInput,
} from "../../../task-workflows/index.js";

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
  return { verifierVerdict: body.verifierVerdict };
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
        const { workflowId } = ctx.params as { workflowId: string };
        return { receipt: service.closeout(workflowId) };
      },
    },
  ];
}
