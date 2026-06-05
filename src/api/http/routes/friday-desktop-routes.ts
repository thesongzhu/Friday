/**
 * C-003 Desktop Runtime API Routes — action execution, recording, replay,
 * policy, permissions, element inspection, platform capability discovery.
 *
 * @module api/http/routes
 */

import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import { FridayDomainError } from "../../../errors/friday-domain-error.js";
import type {
  FridayAddDesktopPolicyRuleRequest,
  FridayAddDesktopPolicyRuleResponse,
  FridayBatchDesktopActionsRequest,
  FridayBatchDesktopActionsResponse,
  FridayCancelDesktopActionRequest,
  FridayCancelDesktopActionResponse,
  FridayCreateDesktopPolicyRequest,
  FridayCreateDesktopPolicyResponse,
  FridayDeleteDesktopPolicyRequest,
  FridayDeleteDesktopPolicyResponse,
  FridayDeleteDesktopRecordingRequest,
  FridayDeleteDesktopRecordingResponse,
  FridayExecuteDesktopActionRequest,
  FridayExecuteDesktopActionResponse,
  FridayGetDesktopPlatformResponse,
  FridayGetDesktopPolicyResponse,
  FridayGetDesktopRecordingResponse,
  FridayInspectDesktopElementRequest,
  FridayInspectDesktopElementResponse,
  FridayListDesktopActionLogQuery,
  FridayListDesktopActionLogResponse,
  FridayListDesktopPermissionDecisionsQuery,
  FridayListDesktopPermissionDecisionsResponse,
  FridayListDesktopPermissionsResponse,
  FridayListDesktopPoliciesQuery,
  FridayListDesktopPoliciesResponse,
  FridayListDesktopRecordingsQuery,
  FridayListDesktopRecordingsResponse,
  FridayListDesktopRecordingStepsQuery,
  FridayListDesktopRecordingStepsResponse,
  FridayPauseDesktopRecordingRequest,
  FridayPauseDesktopRecordingResponse,
  FridayRemoveDesktopPolicyRuleRequest,
  FridayRemoveDesktopPolicyRuleResponse,
  FridayReplayDesktopRecordingRequest,
  FridayReplayDesktopRecordingResponse,
  FridayRespondToPermissionPromptRequest,
  FridayRespondToPermissionPromptResponse,
  FridayResumeDesktopRecordingRequest,
  FridayResumeDesktopRecordingResponse,
  FridaySearchDesktopElementsQuery,
  FridaySearchDesktopElementsResponse,
  FridayStartDesktopRecordingRequest,
  FridayStartDesktopRecordingResponse,
  FridayStopDesktopRecordingRequest,
  FridayStopDesktopRecordingResponse,
  FridayUpdateDesktopPolicyRequest,
  FridayUpdateDesktopPolicyResponse,
} from "../../../desktop/api/friday-desktop-api.types.js";
import type { UUID } from "../../../desktop/model/friday-desktop.types.js";

// ─── Service Dependencies ───

export interface FridayDesktopRoutesDeps {
  allowTestOnlyDesktopActionExecution?: boolean;
  actions: {
    execute(req: FridayExecuteDesktopActionRequest): Promise<FridayExecuteDesktopActionResponse>;
    batch(req: FridayBatchDesktopActionsRequest): Promise<FridayBatchDesktopActionsResponse>;
    cancel(actionId: UUID, req: FridayCancelDesktopActionRequest): Promise<FridayCancelDesktopActionResponse>;
    log(query: FridayListDesktopActionLogQuery): FridayListDesktopActionLogResponse;
  };
  recordings: {
    start(req: FridayStartDesktopRecordingRequest): FridayStartDesktopRecordingResponse;
    stop(recordingId: UUID, req: FridayStopDesktopRecordingRequest): FridayStopDesktopRecordingResponse;
    pause(recordingId: UUID, req: FridayPauseDesktopRecordingRequest): FridayPauseDesktopRecordingResponse;
    resume(recordingId: UUID, req: FridayResumeDesktopRecordingRequest): FridayResumeDesktopRecordingResponse;
    list(query: FridayListDesktopRecordingsQuery): FridayListDesktopRecordingsResponse;
    get(recordingId: UUID): FridayGetDesktopRecordingResponse;
    listSteps(recordingId: UUID, query: FridayListDesktopRecordingStepsQuery): FridayListDesktopRecordingStepsResponse;
    replay(recordingId: UUID, req: FridayReplayDesktopRecordingRequest): Promise<FridayReplayDesktopRecordingResponse>;
    delete(recordingId: UUID, req: FridayDeleteDesktopRecordingRequest): FridayDeleteDesktopRecordingResponse;
  };
  policies: {
    create(req: FridayCreateDesktopPolicyRequest): FridayCreateDesktopPolicyResponse;
    get(policyId: UUID): FridayGetDesktopPolicyResponse;
    list(query: FridayListDesktopPoliciesQuery): FridayListDesktopPoliciesResponse;
    update(policyId: UUID, req: FridayUpdateDesktopPolicyRequest): FridayUpdateDesktopPolicyResponse;
    delete(policyId: UUID, req: FridayDeleteDesktopPolicyRequest): FridayDeleteDesktopPolicyResponse;
    addRule(policyId: UUID, req: FridayAddDesktopPolicyRuleRequest): FridayAddDesktopPolicyRuleResponse;
    removeRule(policyId: UUID, ruleId: UUID, req: FridayRemoveDesktopPolicyRuleRequest): FridayRemoveDesktopPolicyRuleResponse;
  };
  permissions: {
    list(): Promise<FridayListDesktopPermissionsResponse>;
    respond(promptId: UUID, req: FridayRespondToPermissionPromptRequest): FridayRespondToPermissionPromptResponse;
    listDecisions(query: FridayListDesktopPermissionDecisionsQuery): FridayListDesktopPermissionDecisionsResponse;
  };
  platform: {
    get(): Promise<FridayGetDesktopPlatformResponse>;
  };
  elements: {
    inspect(req: FridayInspectDesktopElementRequest): Promise<FridayInspectDesktopElementResponse>;
    search(query: FridaySearchDesktopElementsQuery): Promise<FridaySearchDesktopElementsResponse>;
  };
}

// ─── Validation Helpers ───

function requireString(body: unknown, field: string): void {
  const obj = body as Record<string, unknown> | null | undefined;
  if (!obj || typeof obj[field] !== "string" || (obj[field] as string).trim() === "") {
    throw new FridayDomainError("VALIDATION_ERROR", `${field} is required`);
  }
}

function requirePresent(body: unknown, field: string): void {
  const obj = body as Record<string, unknown> | null | undefined;
  if (!obj || obj[field] === undefined || obj[field] === null) {
    throw new FridayDomainError("VALIDATION_ERROR", `${field} is required`);
  }
}

function requireIdempotencyKey(body: unknown): void {
  requireString(body, "idempotencyKey");
}

function requireEtag(body: unknown): void {
  requireString(body, "etag");
}

function throwRetiredDesktopActionExecution(): never {
  throw new FridayDomainError(
    "TS_RUNTIME_DESKTOP_ACTION_EXECUTION_RETIRED",
    "Desktop action execution is fail-closed while runtime ownership is being moved out of TypeScript.",
    {
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: "rust_owned_desktop_action_execution_entrypoint_required",
      },
    },
  );
}

// ─── Factory ───

export function createFridayDesktopRoutes(
  deps: FridayDesktopRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    // ═══════════════════════════════════════════════════════════════
    // ACTIONS
    // ═══════════════════════════════════════════════════════════════

    {
      operationId: "desktop.actions.execute",
      method: "POST",
      path: "/v1/desktop/actions/execute",
      auth: { public: true },
      async handler(ctx) {
        const body = ctx.body as FridayExecuteDesktopActionRequest;
        requirePresent(body, "action");
        requireIdempotencyKey(body);
        if (deps.allowTestOnlyDesktopActionExecution !== true) {
          throwRetiredDesktopActionExecution();
        }
        return deps.actions.execute(body);
      },
    },
    {
      operationId: "desktop.actions.batch",
      method: "POST",
      path: "/v1/desktop/actions/batch",
      auth: { public: true },
      async handler(ctx) {
        const body = ctx.body as FridayBatchDesktopActionsRequest;
        if (!body.actions || !Array.isArray(body.actions) || body.actions.length === 0) {
          throw new FridayDomainError("VALIDATION_ERROR", "actions array is required");
        }
        requireIdempotencyKey(body);
        if (deps.allowTestOnlyDesktopActionExecution !== true) {
          throwRetiredDesktopActionExecution();
        }
        return deps.actions.batch(body);
      },
    },
    {
      operationId: "desktop.actions.cancel",
      method: "POST",
      path: "/v1/desktop/actions/:actionId/cancel",
      auth: { public: true },
      async handler(ctx) {
        const { actionId } = ctx.params as { actionId: string };
        const body = ctx.body as FridayCancelDesktopActionRequest;
        requireIdempotencyKey(body);
        return deps.actions.cancel(actionId, body);
      },
    },
    {
      operationId: "desktop.actions.log",
      method: "GET",
      path: "/v1/desktop/actions/log",
      auth: { public: true },
      async handler(ctx) {
        return deps.actions.log(ctx.query as FridayListDesktopActionLogQuery);
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // RECORDINGS
    // ═══════════════════════════════════════════════════════════════

    {
      operationId: "desktop.recordings.start",
      method: "POST",
      path: "/v1/desktop/recordings",
      auth: { public: true },
      async handler(ctx) {
        const body = ctx.body as FridayStartDesktopRecordingRequest;
        requireString(body, "name");
        requireIdempotencyKey(body);
        return deps.recordings.start(body);
      },
    },
    {
      operationId: "desktop.recordings.list",
      method: "GET",
      path: "/v1/desktop/recordings",
      auth: { public: true },
      async handler(ctx) {
        return deps.recordings.list(ctx.query as FridayListDesktopRecordingsQuery);
      },
    },
    {
      operationId: "desktop.recordings.get",
      method: "GET",
      path: "/v1/desktop/recordings/:recordingId",
      auth: { public: true },
      async handler(ctx) {
        const { recordingId } = ctx.params as { recordingId: string };
        return deps.recordings.get(recordingId);
      },
    },
    {
      operationId: "desktop.recordings.stop",
      method: "POST",
      path: "/v1/desktop/recordings/:recordingId/stop",
      auth: { public: true },
      async handler(ctx) {
        const { recordingId } = ctx.params as { recordingId: string };
        const body = ctx.body as FridayStopDesktopRecordingRequest;
        requireIdempotencyKey(body);
        return deps.recordings.stop(recordingId, body);
      },
    },
    {
      operationId: "desktop.recordings.pause",
      method: "POST",
      path: "/v1/desktop/recordings/:recordingId/pause",
      auth: { public: true },
      async handler(ctx) {
        const { recordingId } = ctx.params as { recordingId: string };
        const body = ctx.body as FridayPauseDesktopRecordingRequest;
        requireIdempotencyKey(body);
        return deps.recordings.pause(recordingId, body);
      },
    },
    {
      operationId: "desktop.recordings.resume",
      method: "POST",
      path: "/v1/desktop/recordings/:recordingId/resume",
      auth: { public: true },
      async handler(ctx) {
        const { recordingId } = ctx.params as { recordingId: string };
        const body = ctx.body as FridayResumeDesktopRecordingRequest;
        requireIdempotencyKey(body);
        return deps.recordings.resume(recordingId, body);
      },
    },
    {
      operationId: "desktop.recordings.steps.list",
      method: "GET",
      path: "/v1/desktop/recordings/:recordingId/steps",
      auth: { public: true },
      async handler(ctx) {
        const { recordingId } = ctx.params as { recordingId: string };
        return deps.recordings.listSteps(recordingId, ctx.query as FridayListDesktopRecordingStepsQuery);
      },
    },
    {
      operationId: "desktop.recordings.replay",
      method: "POST",
      path: "/v1/desktop/recordings/:recordingId/replay",
      auth: { public: true },
      async handler(ctx) {
        const { recordingId } = ctx.params as { recordingId: string };
        const body = ctx.body as FridayReplayDesktopRecordingRequest;
        requireIdempotencyKey(body);
        return deps.recordings.replay(recordingId, body);
      },
    },
    {
      operationId: "desktop.recordings.delete",
      method: "DELETE",
      path: "/v1/desktop/recordings/:recordingId",
      auth: { public: true },
      async handler(ctx) {
        const { recordingId } = ctx.params as { recordingId: string };
        const body = ctx.body as FridayDeleteDesktopRecordingRequest;
        requireIdempotencyKey(body);
        return deps.recordings.delete(recordingId, body);
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // POLICIES
    // ═══════════════════════════════════════════════════════════════

    {
      operationId: "desktop.policies.create",
      method: "POST",
      path: "/v1/desktop/policies",
      auth: { public: true },
      async handler(ctx) {
        const body = ctx.body as FridayCreateDesktopPolicyRequest;
        requireString(body, "name");
        requireIdempotencyKey(body);
        return deps.policies.create(body);
      },
    },
    {
      operationId: "desktop.policies.list",
      method: "GET",
      path: "/v1/desktop/policies",
      auth: { public: true },
      async handler(ctx) {
        return deps.policies.list(ctx.query as FridayListDesktopPoliciesQuery);
      },
    },
    {
      operationId: "desktop.policies.get",
      method: "GET",
      path: "/v1/desktop/policies/:policyId",
      auth: { public: true },
      async handler(ctx) {
        const { policyId } = ctx.params as { policyId: string };
        return deps.policies.get(policyId);
      },
    },
    {
      operationId: "desktop.policies.update",
      method: "PATCH",
      path: "/v1/desktop/policies/:policyId",
      auth: { public: true },
      async handler(ctx) {
        const { policyId } = ctx.params as { policyId: string };
        const body = ctx.body as FridayUpdateDesktopPolicyRequest;
        requireEtag(body);
        requireIdempotencyKey(body);
        return deps.policies.update(policyId, body);
      },
    },
    {
      operationId: "desktop.policies.delete",
      method: "DELETE",
      path: "/v1/desktop/policies/:policyId",
      auth: { public: true },
      async handler(ctx) {
        const { policyId } = ctx.params as { policyId: string };
        const body = ctx.body as FridayDeleteDesktopPolicyRequest;
        requireEtag(body);
        requireIdempotencyKey(body);
        return deps.policies.delete(policyId, body);
      },
    },
    {
      operationId: "desktop.policies.rules.create",
      method: "POST",
      path: "/v1/desktop/policies/:policyId/rules",
      auth: { public: true },
      async handler(ctx) {
        const { policyId } = ctx.params as { policyId: string };
        const body = ctx.body as FridayAddDesktopPolicyRuleRequest;
        requirePresent(body, "rule");
        requireEtag(body);
        requireIdempotencyKey(body);
        return deps.policies.addRule(policyId, body);
      },
    },
    {
      operationId: "desktop.policies.rules.delete",
      method: "DELETE",
      path: "/v1/desktop/policies/:policyId/rules/:ruleId",
      auth: { public: true },
      async handler(ctx) {
        const { policyId, ruleId } = ctx.params as { policyId: string; ruleId: string };
        const body = ctx.body as FridayRemoveDesktopPolicyRuleRequest;
        requireEtag(body);
        requireIdempotencyKey(body);
        return deps.policies.removeRule(policyId, ruleId, body);
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // PERMISSIONS
    // ═══════════════════════════════════════════════════════════════

    {
      operationId: "desktop.permissions.list",
      method: "GET",
      path: "/v1/desktop/permissions",
      auth: { public: true },
      async handler() {
        return deps.permissions.list();
      },
    },
    {
      operationId: "desktop.permissions.respond",
      method: "POST",
      path: "/v1/desktop/permissions/prompts/:promptId/respond",
      auth: { public: true },
      async handler(ctx) {
        const { promptId } = ctx.params as { promptId: string };
        const body = ctx.body as FridayRespondToPermissionPromptRequest;
        requireString(body, "decision");
        requireIdempotencyKey(body);
        return deps.permissions.respond(promptId, body);
      },
    },
    {
      operationId: "desktop.permissions.decisions.list",
      method: "GET",
      path: "/v1/desktop/permissions/decisions",
      auth: { public: true },
      async handler(ctx) {
        return deps.permissions.listDecisions(
          ctx.query as FridayListDesktopPermissionDecisionsQuery,
        );
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // PLATFORM / ELEMENTS
    // ═══════════════════════════════════════════════════════════════

    {
      operationId: "desktop.platform.get",
      method: "GET",
      path: "/v1/desktop/platform",
      auth: { public: true },
      async handler() {
        return deps.platform.get();
      },
    },
    {
      operationId: "desktop.elements.inspect",
      method: "POST",
      path: "/v1/desktop/elements/inspect",
      auth: { public: true },
      async handler(ctx) {
        const body = ctx.body as FridayInspectDesktopElementRequest;
        requirePresent(body, "selector");
        return deps.elements.inspect(body);
      },
    },
    {
      operationId: "desktop.elements.search",
      method: "GET",
      path: "/v1/desktop/elements/search",
      auth: { public: true },
      async handler(ctx) {
        const query = ctx.query as FridaySearchDesktopElementsQuery;
        if (!query.query) {
          throw new FridayDomainError("VALIDATION_ERROR", "query is required");
        }
        return deps.elements.search(query);
      },
    },
  ];
}
