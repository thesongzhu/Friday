import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayAgentRunExecutionResponse,
  FridayCancelAgentRunResponse,
  FridayGetAgentRunResponse,
  FridayListAgentRunsQuery,
  FridayListAgentRunsResponse,
  FridayStartAgentRunRequest,
  FridayStartAgentRunResponse,
} from "../../model/friday-api-agent.types.js";
import type {
  FridayAgentAutomationSchedule,
  FridayAgentAutomationService,
  FridayAgentAutomationSessionTarget,
  FridayAgentEventEmitter,
  FridayAgentEventMap,
  FridayAgentEventName,
  FridayAgentRunConstraints,
  FridayAgentRunRecord,
  FridayAgentRunStatus,
  FridayAgentRuntimeResult,
  FridayAgentTaskProfileInput,
} from "#agent";
import type { FridayProviderTenantContext } from "#providers";
import { FridayDomainError } from "#errors";
import { isValidCronExpression } from "#jobs";
import type { FridayAgentRunEventRecord } from "#agent";

// ─── Constants ───

const AGENT_MAX_LIST_LIMIT = 100;
const AGENT_SSE_KEEPALIVE_MS = 15_000;

/** Terminal statuses — no further events will be emitted. */
const TERMINAL_STATUSES: ReadonlySet<FridayAgentRunStatus> = new Set([
  "completed",
  "failed",
  "failed_tests",
  "cancelled",
]);

/** Event names that signal a terminal state (derived from TERMINAL_STATUSES). */
const TERMINAL_EVENT_NAMES: ReadonlySet<string> = new Set(
  [...TERMINAL_STATUSES].map((s) => `agent.run.${s}`),
);

const AGENT_READ_SCOPES = ["agent.read", "workflow.run"] as const;
const AGENT_RUN_SCOPES = ["agent.run", "workflow.run"] as const;
const AGENT_WRITE_SCOPES = ["agent.write", "workflow.run"] as const;

// ─── Deps ───

export interface FridayAgentRoutesDeps {
  assertListingEntitled?: (listingId: string, principalId: string) => Promise<void>;
  startRun: (input: {
    task: string;
    sessionKey?: string;
    providerId?: string;
    model?: string;
    replyToMessageId?: string;
    timezone?: string;
    timeoutMs?: number;
    requireReview?: boolean;
    constraints?: FridayAgentRunConstraints;
    taskProfile?: FridayAgentTaskProfileInput;
    executionContext?: {
      surface?: string;
      interactive?: boolean;
      browserPresentationMode?: "auto" | "headless" | "host_chrome_visible";
      packId?: string;
    };
    principalId?: string;
    scopes?: string[];
    tenantContext?: FridayProviderTenantContext;
  }) => Promise<FridayAgentRuntimeResult>;
  getRun: (runId: string) => FridayAgentRunRecord | null;
  listRuns: (query: {
    status?: FridayAgentRunStatus;
    limit?: number;
    cursor?: string;
  }) => FridayAgentRunRecord[];
  listRunEvents: (runId: string, afterSeq?: number) => FridayAgentRunEventRecord[];
  cancelRun: (runId: string) => void;
  approvePlan: (runId: string) => Promise<FridayAgentRuntimeResult>;
  rejectPlan: (runId: string) => Promise<FridayAgentRuntimeResult>;
  resolveToolApproval: (
    runId: string,
    toolCallId: string,
    approved: boolean,
    reason?: string,
  ) => { resolved: boolean; grantId?: string; decision?: "approved" | "rejected" };
  rollbackRun?: (runId: string) => { restoredCount: number; errors: Array<{ filePath: string; error: string }> } | null;
  eventEmitter: FridayAgentEventEmitter;
  automationService: FridayAgentAutomationService;
}

function toFridayAgentRunExecutionResponse(
  result: FridayAgentRuntimeResult,
): FridayAgentRunExecutionResponse {
  return {
    runId: result.runId,
    status: result.status,
    response: result.response,
    toolCallCount: result.toolCallCount,
    durationMs: result.durationMs,
    usageInput: result.usageInput,
    usageOutput: result.usageOutput,
    ...(result.images ? { images: result.images } : {}),
    ...(result.finalResponse ? { finalResponse: result.finalResponse } : {}),
    ...(result.contextCostSummary ? { contextCostSummary: result.contextCostSummary } : {}),
    ...(result.taskProfile ? { taskProfile: result.taskProfile } : {}),
  };
}

// ─── SSE response type ───

/** Describes the raw Node `ServerResponse` shape needed for SSE streaming. */
interface FridaySseResponse {
  writeHead(statusCode: number, headers: Record<string, string>): void;
  write(chunk: string): boolean;
  end(): void;
  on(event: string, listener: () => void): void;
}

// ─── Factory ───

export function createFridayAgentRoutes(
  deps: FridayAgentRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  function buildTenantContext(principal: unknown): FridayProviderTenantContext | undefined {
    if (!principal || typeof principal !== "object") {
      return undefined;
    }
    const record = principal as {
      principalId?: unknown;
      tenantId?: unknown;
    };
    const principalId = typeof record.principalId === "string" && record.principalId.trim().length > 0
      ? record.principalId.trim()
      : undefined;
    if (!principalId) {
      return undefined;
    }
    const tenantId = typeof record.tenantId === "string" && record.tenantId.trim().length > 0
      ? record.tenantId.trim()
      : principalId;
    return {
      hubId: tenantId,
      userId: principalId,
    };
  }

  function serializeReplayEvent(
    event: FridayAgentRunEventRecord,
    replayed: boolean,
  ): string {
    return JSON.stringify({
      type: event.eventName,
      ...event.payload,
      seq: event.seq,
      emittedAt: event.emittedAt,
      replayed,
    });
  }

  return [
    // ─── POST /v1/agent/runs ───
    {
      operationId: "agent.runs.start",
      method: "POST",
      path: "/v1/agent/runs",
      auth: { public: false, anyOfScopes: [...AGENT_RUN_SCOPES] },
      rateLimitPolicyId: "agent.run",
      async handler(ctx) {
        const body = ctx.body as FridayStartAgentRunRequest | null;
        if (!body || typeof body.task !== "string" || body.task.trim() === "") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "task is required and must be a non-empty string",
            { httpStatus: 400 },
          );
        }
        const marketplaceListingId = typeof body.marketplaceListingId === "string"
          ? body.marketplaceListingId.trim()
          : undefined;
        if (body.marketplaceListingId !== undefined && !marketplaceListingId) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "marketplaceListingId must be a non-empty string when provided",
            { httpStatus: 400 },
          );
        }
        if (marketplaceListingId && ctx.principal?.principalId) {
          await deps.assertListingEntitled?.(marketplaceListingId, ctx.principal.principalId);
        }

        const providerId = typeof body.providerId === "string" ? body.providerId : undefined;
        const replyToMessageId = typeof body.replyToMessageId === "string" ? body.replyToMessageId : undefined;
        if (body.replyToMessageId !== undefined && (!replyToMessageId || replyToMessageId.trim() === "")) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "replyToMessageId must be a non-empty string when provided",
            { httpStatus: 400 },
          );
        }
        const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey : undefined;
        if (body.sessionKey !== undefined && (!sessionKey || sessionKey.trim() === "")) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "sessionKey must be a non-empty string when provided",
            { httpStatus: 400 },
          );
        }
        const model = typeof body.model === "string" ? body.model : undefined;
        const timezone = parseOptionalIanaTimezone(body.timezone, "timezone");
        let timeoutMs: number | undefined;
        if (body.timeoutMs !== undefined) {
          const parsed = Number(body.timeoutMs);
          if (!Number.isFinite(parsed) || parsed < 1 || parsed > 600_000) {
            throw new FridayDomainError(
              "VALIDATION_ERROR",
              "timeoutMs must be a positive number up to 600000",
              { httpStatus: 400 },
            );
          }
          timeoutMs = parsed;
        }

        // IMPL-1: requireReview flag
        const requireReview = typeof body.requireReview === "boolean" ? body.requireReview : undefined;

        // IMPL-4: constraints
        let constraints: { readOnly?: boolean; operationalMode?: "plan" | "execute" | "restricted" } | undefined;
        if (body.constraints !== undefined && typeof body.constraints === "object" && body.constraints !== null && !Array.isArray(body.constraints)) {
          const c = body.constraints as Record<string, unknown>;
          const validModes = ["plan", "execute", "restricted"] as const;
          const parsedMode = typeof c.operationalMode === "string" && (validModes as readonly string[]).includes(c.operationalMode)
            ? (c.operationalMode as "plan" | "execute" | "restricted")
            : undefined;
          constraints = {
            readOnly: typeof c.readOnly === "boolean" ? c.readOnly : undefined,
            operationalMode: parsedMode,
          };
        }

        let executionContext:
          | {
            surface?: string;
            interactive?: boolean;
            browserPresentationMode?: "auto" | "headless" | "host_chrome_visible";
            packId?: string;
          }
          | undefined;
        if (
          body.executionContext !== undefined
          && typeof body.executionContext === "object"
          && body.executionContext !== null
          && !Array.isArray(body.executionContext)
        ) {
          const input = body.executionContext as Record<string, unknown>;
          const surface = typeof input.surface === "string" && input.surface.trim().length > 0
            ? input.surface.trim()
            : undefined;
          const interactive = typeof input.interactive === "boolean"
            ? input.interactive
            : undefined;
          const browserPresentationMode = input.browserPresentationMode === "auto"
            || input.browserPresentationMode === "headless"
            || input.browserPresentationMode === "host_chrome_visible"
            ? input.browserPresentationMode
            : undefined;
          const rawPackId = input.packId;
          if (rawPackId !== undefined && (typeof rawPackId !== "string" || rawPackId.trim().length === 0)) {
            throw new FridayDomainError(
              "VALIDATION_ERROR",
              "executionContext.packId must be a non-empty string when provided",
              { httpStatus: 400 },
            );
          }
          const packId = typeof rawPackId === "string" && rawPackId.trim().length > 0
            ? rawPackId.trim()
            : undefined;
          executionContext = {
            ...(surface ? { surface } : {}),
            ...(interactive !== undefined ? { interactive } : {}),
            ...(browserPresentationMode ? { browserPresentationMode } : {}),
            ...(packId ? { packId } : {}),
          };
        }

        let taskProfile: FridayAgentTaskProfileInput | undefined;
        if (
          body.taskProfile !== undefined
          && typeof body.taskProfile === "object"
          && body.taskProfile !== null
          && !Array.isArray(body.taskProfile)
        ) {
          const input = body.taskProfile as Record<string, unknown>;
          const id = input.id;
          const reasoningEffort = input.reasoningEffort;
          const temperature = input.temperature;
          taskProfile = {
            ...(id === "default" || id === "deterministic" || id === "planning" || id === "review" || id === "creative"
              ? { id }
              : {}),
            ...(typeof input.model === "string" && input.model.trim().length > 0
              ? { model: input.model.trim() }
              : {}),
            ...(typeof temperature === "number" && Number.isFinite(temperature) && temperature >= 0 && temperature <= 2
              ? { temperature }
              : {}),
            ...(reasoningEffort === "low" || reasoningEffort === "medium" || reasoningEffort === "high"
              ? { reasoningEffort }
              : {}),
            ...(typeof input.reason === "string" && input.reason.trim().length > 0
              ? { reason: input.reason.trim() }
              : {}),
          };
        }

        const principalInput = ctx.principal
          ? {
            principalId: ctx.principal.principalId,
            scopes: ctx.principal.scopes,
            tenantContext: buildTenantContext(ctx.principal),
          }
          : {};

        const result = await deps.startRun({
          task: body.task,
          sessionKey,
          providerId,
          model,
          replyToMessageId,
          timezone,
          timeoutMs,
          requireReview,
          constraints,
          taskProfile,
          executionContext,
          ...principalInput,
        });
        const response: FridayStartAgentRunResponse = {
          ...toFridayAgentRunExecutionResponse(result),
          eventStreamAvailable: true,
        };
        return response;
      },
    },

    // ─── GET /v1/agent/runs ───
    {
      operationId: "agent.runs.list",
      method: "GET",
      path: "/v1/agent/runs",
      auth: { public: false, anyOfScopes: [...AGENT_READ_SCOPES] },
      async handler(ctx) {
        const query = ctx.query as FridayListAgentRunsQuery;

        let limit: number | undefined;
        if (query.limit !== undefined) {
          const parsed = Number(query.limit);
          if (!Number.isInteger(parsed) || parsed < 1) {
            throw new FridayDomainError(
              "VALIDATION_ERROR",
              "limit must be a positive integer",
              { httpStatus: 400 },
            );
          }
          limit = Math.min(parsed, AGENT_MAX_LIST_LIMIT);
        }

        const VALID_RUN_STATUSES: Set<string> = new Set([
          "pending", "planning", "awaiting_clarification", "awaiting_plan_approval",
          "executing", "testing", "fixing", "completed", "failed", "failed_tests", "cancelled",
        ]);
        const rawStatus = query.status as string | undefined;
        const status = rawStatus && VALID_RUN_STATUSES.has(rawStatus)
          ? rawStatus as FridayAgentRunStatus
          : undefined;

        const items = deps.listRuns({ status, limit, cursor: query.cursor });
        const response: FridayListAgentRunsResponse = { items };
        return response;
      },
    },

    // ─── GET /v1/agent/runs/summary ───
    {
      operationId: "agent.runs.summary",
      method: "GET",
      path: "/v1/agent/runs/summary",
      auth: { public: false, anyOfScopes: [...AGENT_READ_SCOPES] },
      async handler(ctx) {
        const query = ctx.query as { since?: string };
        const allRuns = deps.listRuns({ limit: 100 });
        const since = query.since ? new Date(query.since).getTime() : 0;
        const recentRuns = since > 0
          ? allRuns.filter((r) => new Date(r.createdAt).getTime() >= since)
          : allRuns;

        let totalCostUsd = 0;
        let completedCount = 0;
        let failedCount = 0;
        let cancelledCount = 0;

        for (const run of recentRuns) {
          totalCostUsd += run.costUsd ?? 0;
          if (run.status === "completed") completedCount++;
          else if (run.status === "failed" || run.status === "failed_tests") failedCount++;
          else if (run.status === "cancelled") cancelledCount++;
        }

        return {
          since: query.since ?? null,
          totalRuns: recentRuns.length,
          completedCount,
          failedCount,
          cancelledCount,
          totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
          runs: recentRuns.slice(0, 20).map((r) => ({
            id: r.id,
            task: r.task,
            status: r.status,
            createdAt: r.createdAt,
            durationMs: r.durationMs,
          })),
        };
      },
    },

    // ─── GET /v1/agent/runs/:runId ───
    {
      operationId: "agent.runs.get",
      method: "GET",
      path: "/v1/agent/runs/:runId",
      auth: { public: false, anyOfScopes: [...AGENT_READ_SCOPES] },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: string };
        const run = deps.getRun(runId);
        if (!run) {
          throw new FridayDomainError(
            "AGENT_RUN_NOT_FOUND",
            "Agent run not found",
            { httpStatus: 404 },
          );
        }
        const response: FridayGetAgentRunResponse = { run };
        return response;
      },
    },

    // ─── POST /v1/agent/runs/:runId/cancel ───
    {
      operationId: "agent.runs.cancel",
      method: "POST",
      path: "/v1/agent/runs/:runId/cancel",
      auth: { public: false, anyOfScopes: [...AGENT_WRITE_SCOPES] },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: string };
        const run = deps.getRun(runId);
        if (!run) {
          throw new FridayDomainError(
            "AGENT_RUN_NOT_FOUND",
            "Agent run not found",
            { httpStatus: 404 },
          );
        }
        if (TERMINAL_STATUSES.has(run.status)) {
          throw new FridayDomainError(
            "AGENT_RUN_ALREADY_TERMINAL",
            `Agent run is already in terminal status: ${run.status}`,
            { httpStatus: 409 },
          );
        }
        deps.cancelRun(runId);
        const response: FridayCancelAgentRunResponse = { cancelled: true, runId };
        return response;
      },
    },

    // ─── GET /v1/agent/runs/:runId/audit ───
    {
      operationId: "agent.runs.audit",
      method: "GET",
      path: "/v1/agent/runs/:runId/audit",
      auth: { public: false, anyOfScopes: [...AGENT_READ_SCOPES] },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: string };
        const run = deps.getRun(runId);
        if (!run) {
          throw new FridayDomainError(
            "AGENT_RUN_NOT_FOUND",
            "Agent run not found",
            { httpStatus: 404 },
          );
        }
        const AUDIT_EVENT_NAMES = new Set([
          "agent.run.started",
          "agent.run.tool_start",
          "agent.run.tool_end",
          "agent.run.route_selected",
          "agent.run.route_fallback",
          "agent.run.route_mismatch",
          "agent.run.degraded",
          "agent.run.mode_changed",
          "agent.run.awaiting_tool_approval",
          "agent.run.capability_grant_issued",
          "agent.run.capability_grant_denied",
          "agent.run.capability_grant_used",
          "agent.run.completed",
          "agent.run.failed",
          "agent.run.cancelled",
        ]);
        const allEvents = deps.listRunEvents(runId);
        const auditEvents = allEvents.filter((e) => AUDIT_EVENT_NAMES.has(e.eventName));
        return {
          runId,
          events: auditEvents.map((e) => ({
            seq: e.seq,
            type: e.eventName,
            timestamp: e.emittedAt,
            payload: e.payload,
          })),
        };
      },
    },

    // ─── POST /v1/agent/runs/:runId/rollback ───
    {
      operationId: "agent.runs.rollback",
      method: "POST",
      path: "/v1/agent/runs/:runId/rollback",
      auth: { public: false, anyOfScopes: [...AGENT_WRITE_SCOPES] },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: string };
        const run = deps.getRun(runId);
        if (!run) {
          throw new FridayDomainError(
            "AGENT_RUN_NOT_FOUND",
            "Agent run not found",
            { httpStatus: 404 },
          );
        }
        if (!deps.rollbackRun) {
          throw new FridayDomainError(
            "AGENT_ROLLBACK_NOT_AVAILABLE",
            "File rollback is not available",
            { httpStatus: 501 },
          );
        }
        const result = deps.rollbackRun(runId);
        if (!result) {
          throw new FridayDomainError(
            "AGENT_ROLLBACK_NO_CHECKPOINT",
            "No checkpoint found for this run",
            { httpStatus: 404 },
          );
        }
        return result;
      },
    },

    // ─── POST /v1/agent/runs/:runId/approve-plan ───
    {
      operationId: "agent.runs.approve.plan",
      method: "POST",
      path: "/v1/agent/runs/:runId/approve-plan",
      auth: { public: false, anyOfScopes: [...AGENT_WRITE_SCOPES] },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: string };
        const run = deps.getRun(runId);
        if (!run) {
          throw new FridayDomainError(
            "AGENT_RUN_NOT_FOUND",
            "Agent run not found",
            { httpStatus: 404 },
          );
        }
        return await deps.approvePlan(runId);
      },
    },

    // ─── POST /v1/agent/runs/:runId/reject-plan ───
    {
      operationId: "agent.runs.reject.plan",
      method: "POST",
      path: "/v1/agent/runs/:runId/reject-plan",
      auth: { public: false, anyOfScopes: [...AGENT_WRITE_SCOPES] },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: string };
        const run = deps.getRun(runId);
        if (!run) {
          throw new FridayDomainError(
            "AGENT_RUN_NOT_FOUND",
            "Agent run not found",
            { httpStatus: 404 },
          );
        }
        return await deps.rejectPlan(runId);
      },
    },

    // ─── POST /v1/agent/runs/:runId/approve-tool ───
    {
      operationId: "agent.runs.approve.tool",
      method: "POST",
      path: "/v1/agent/runs/:runId/approve-tool",
      auth: { public: false, anyOfScopes: [...AGENT_WRITE_SCOPES] },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: string };
        const body = ctx.body as { toolCallId?: string } | undefined;
        const toolCallId = body?.toolCallId;
        if (!toolCallId) {
          throw new FridayDomainError(
            "AGENT_TOOL_CALL_ID_REQUIRED",
            "toolCallId is required in the request body",
            { httpStatus: 400 },
          );
        }
        const run = deps.getRun(runId);
        if (!run) {
          throw new FridayDomainError(
            "AGENT_RUN_NOT_FOUND",
            "Agent run not found",
            { httpStatus: 404 },
          );
        }
        return deps.resolveToolApproval(runId, toolCallId, true);
      },
    },

    // ─── POST /v1/agent/runs/:runId/reject-tool ───
    {
      operationId: "agent.runs.reject.tool",
      method: "POST",
      path: "/v1/agent/runs/:runId/reject-tool",
      auth: { public: false, anyOfScopes: [...AGENT_WRITE_SCOPES] },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: string };
        const body = ctx.body as { toolCallId?: string; reason?: string } | undefined;
        const toolCallId = body?.toolCallId;
        if (!toolCallId) {
          throw new FridayDomainError(
            "AGENT_TOOL_CALL_ID_REQUIRED",
            "toolCallId is required in the request body",
            { httpStatus: 400 },
          );
        }
        const run = deps.getRun(runId);
        if (!run) {
          throw new FridayDomainError(
            "AGENT_RUN_NOT_FOUND",
            "Agent run not found",
            { httpStatus: 404 },
          );
        }
        return deps.resolveToolApproval(runId, toolCallId, false, body?.reason);
      },
    },

    // ─── GET /v1/agent/runs/:runId/events (SSE) ───
    {
      operationId: "agent.runs.events",
      method: "GET",
      path: "/v1/agent/runs/:runId/events",
      auth: { public: false, anyOfScopes: [...AGENT_READ_SCOPES] },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: string };
        const query = ctx.query as Record<string, string | undefined>;
        const run = deps.getRun(runId);
        if (!run) {
          throw new FridayDomainError(
            "AGENT_RUN_NOT_FOUND",
            "Agent run not found",
            { httpStatus: 404 },
          );
        }
        let afterSeq: number | undefined;
        if (query.afterSeq !== undefined) {
          const parsed = Number(query.afterSeq);
          if (!Number.isInteger(parsed) || parsed < 0) {
            throw new FridayDomainError(
              "VALIDATION_ERROR",
              "afterSeq must be a non-negative integer",
              { httpStatus: 400 },
            );
          }
          afterSeq = parsed;
        }

        // Access raw response for SSE streaming.
        // The HTTP context carries a `_raw` reference set by the HTTP server adapter.
        const rawRes = (ctx as unknown as Record<string, unknown>)._raw as FridaySseResponse | undefined;
        if (!rawRes) {
          // Fallback: if no raw response, return the current run state as JSON.
          return { run, streaming: false };
        }

        // Set SSE headers
        rawRes.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        let closed = false;
        let terminalSeen = false;
        let lastSeq = afterSeq ?? 0;
        let flushChain = Promise.resolve();
        // Additional terminal/testing event types can be appended here once they
        // are added to FridayAgentEventMap.
        const eventNames: FridayAgentEventName[] = [
          "agent.run.started",
          "agent.run.planning",
          "agent.run.awaiting_clarification",
          "agent.run.plan_ready",
          "agent.run.awaiting_plan_approval",
          "agent.run.awaiting_tool_approval",
          "agent.run.degraded",
          "agent.run.mode_changed",
          "agent.run.route_selected",
          "agent.run.route_fallback",
          "agent.run.route_mismatch",
          "agent.run.executing",
          "agent.run.tool_start",
          "agent.run.tool_end",
          "agent.run.completed",
          "agent.run.failed",
          "agent.run.text_delta",
          "agent.run.cancelled",
          "agent.subagent.spawned",
          "agent.subagent.completed",
          "autonomous.goal.created",
          "autonomous.goal.started",
          "autonomous.step.started",
          "autonomous.step.completed",
          "autonomous.step.failed",
          "autonomous.goal.completed",
          "autonomous.goal.failed",
        ];

        type AnyListener = (payload: FridayAgentEventMap[FridayAgentEventName]) => void;
        const listeners: Array<{ event: FridayAgentEventName; listener: AnyListener }> = [];

        function cleanup(): void {
          if (closed) return;
          closed = true;
          clearInterval(keepaliveTimer);
          for (const { event, listener } of listeners) {
            deps.eventEmitter.off(event, listener);
          }
        }

        const flushPersistedEvents = async (replayed: boolean): Promise<void> => {
          const events = deps.listRunEvents(runId, lastSeq);
          for (const event of events) {
            if (closed) {
              return;
            }
            lastSeq = event.seq;
            rawRes.write(`data: ${serializeReplayEvent(event, replayed)}\n\n`);
            if (TERMINAL_EVENT_NAMES.has(event.eventName)) {
              terminalSeen = true;
            }
          }
        };

        const queueFlush = (replayed: boolean): void => {
          flushChain = flushChain
            .then(() => flushPersistedEvents(replayed))
            .then(() => {
              if (!closed && terminalSeen) {
                rawRes.end();
                cleanup();
              }
            })
            .catch((err: unknown) => console.warn("[friday][agent-routes] flush:", err instanceof Error ? err.message : String(err)));
        };

        // Keepalive
        const keepaliveTimer = setInterval(() => {
          if (!closed) {
            rawRes.write(":keepalive\n\n");
          }
        }, AGENT_SSE_KEEPALIVE_MS);

        // Listen for client disconnect
        rawRes.on("close", cleanup);

        await flushPersistedEvents(true);
        if (terminalSeen || TERMINAL_STATUSES.has(run.status)) {
          if (!terminalSeen) {
            rawRes.write(`data: ${JSON.stringify({
              type: "agent.run.status",
              runId,
              status: run.status,
              seq: lastSeq,
              emittedAt: run.completedAt ?? run.createdAt,
              replayed: true,
            })}\n\n`);
          }
          rawRes.end();
          cleanup();
          return undefined as unknown as Record<string, unknown>;
        }

        // Subscribe to events
        for (const eventName of eventNames) {
          const listener = ((payload: FridayAgentEventMap[typeof eventName]) => {
            // Filter by runId — standard events use runId, subagent events use parentRunId
            const p = payload as unknown as Record<string, unknown>;
            const payloadRunId = p.runId ?? p.parentRunId;
            if (payloadRunId !== runId) return;
            queueFlush(false);
          }) as AnyListener;

          listeners.push({ event: eventName, listener });
          deps.eventEmitter.on(eventName, listener);
        }

        // Return undefined to signal the HTTP server that we've taken over the response
        return undefined as unknown as Record<string, unknown>;
      },
    },

    // ─── POST /v1/agent/automations ───
    {
      operationId: "agent.automations.create",
      method: "POST",
      path: "/v1/agent/automations",
      auth: { public: false, anyOfScopes: [...AGENT_WRITE_SCOPES] },
      async handler(ctx) {
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body.name !== "string" || body.name.trim() === "") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "name is required and must be a non-empty string",
            { httpStatus: 400 },
          );
        }
        if (typeof body.taskTemplate !== "string" || body.taskTemplate.trim() === "") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "taskTemplate is required and must be a non-empty string",
            { httpStatus: 400 },
          );
        }

        const schedule = parseAutomationSchedule(body.schedule, {
          allowNull: false,
          path: "schedule",
        });

        const automation = deps.automationService.save({
          name: body.name,
          description: typeof body.description === "string" ? body.description : undefined,
          sourceRunId: typeof body.sourceRunId === "string" ? body.sourceRunId : undefined,
          taskTemplate: body.taskTemplate,
          variables: isStringRecord(body.variables) ? body.variables : undefined,
          skillIds: isStringArray(body.skillIds) ? body.skillIds : undefined,
          workflowIds: isStringArray(body.workflowIds) ? body.workflowIds : undefined,
          triggerId: typeof body.triggerId === "string" ? body.triggerId : undefined,
          schedule: schedule ?? undefined,
          sessionTarget: parseAutomationSessionTarget(body.sessionTarget, {
            allowNull: false,
            path: "sessionTarget",
          }) ?? undefined,
          enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        });

        return { automation };
      },
    },

    // ─── GET /v1/agent/automations ───
    {
      operationId: "agent.automations.list",
      method: "GET",
      path: "/v1/agent/automations",
      auth: { public: false, anyOfScopes: [...AGENT_READ_SCOPES] },
      async handler(ctx) {
        const query = ctx.query as Record<string, string | undefined>;

        let limit: number | undefined;
        if (query.limit !== undefined) {
          const parsed = Number(query.limit);
          if (!Number.isInteger(parsed) || parsed < 1) {
            throw new FridayDomainError(
              "VALIDATION_ERROR",
              "limit must be a positive integer",
              { httpStatus: 400 },
            );
          }
          limit = Math.min(parsed, AGENT_MAX_LIST_LIMIT);
        }

        let enabled: boolean | undefined;
        if (query.enabled !== undefined) {
          if (query.enabled !== "true" && query.enabled !== "false") {
            throw new FridayDomainError(
              "VALIDATION_ERROR",
              "enabled must be 'true' or 'false'",
              { httpStatus: 400 },
            );
          }
          enabled = query.enabled === "true";
        }

        const items = deps.automationService.list({
          enabled,
          limit,
          cursor: query.cursor,
        });

        return { items };
      },
    },

    // ─── GET /v1/agent/automations/:automationId ───
    {
      operationId: "agent.automations.get",
      method: "GET",
      path: "/v1/agent/automations/:automationId",
      auth: { public: false, anyOfScopes: [...AGENT_READ_SCOPES] },
      async handler(ctx) {
        const { automationId } = ctx.params as { automationId: string };
        const automation = deps.automationService.get(automationId);
        if (!automation) {
          throw new FridayDomainError(
            "AGENT_AUTOMATION_NOT_FOUND",
            "Automation not found",
            { httpStatus: 404 },
          );
        }
        return { automation };
      },
    },

    // ─── PATCH /v1/agent/automations/:automationId ───
    {
      operationId: "agent.automations.update",
      method: "PATCH",
      path: "/v1/agent/automations/:automationId",
      auth: { public: false, anyOfScopes: [...AGENT_WRITE_SCOPES] },
      async handler(ctx) {
        const { automationId } = ctx.params as { automationId: string };
        const body = ctx.body as Record<string, unknown> | null;
        if (!body) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "Request body is required",
            { httpStatus: 400 },
          );
        }

        const schedule = parseAutomationSchedule(body.schedule, {
          allowNull: true,
          path: "schedule",
        });

        const automation = deps.automationService.update(automationId, {
          name: typeof body.name === "string" ? body.name : undefined,
          description: typeof body.description === "string" ? body.description : undefined,
          taskTemplate: typeof body.taskTemplate === "string" ? body.taskTemplate : undefined,
          variables: isStringRecord(body.variables) ? body.variables : undefined,
          skillIds: isStringArray(body.skillIds) ? body.skillIds : undefined,
          workflowIds: isStringArray(body.workflowIds) ? body.workflowIds : undefined,
          triggerId: typeof body.triggerId === "string" ? body.triggerId : undefined,
          schedule,
          sessionTarget: parseAutomationSessionTarget(body.sessionTarget, {
            allowNull: true,
            path: "sessionTarget",
          }),
          enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        });

        return { automation };
      },
    },

    // ─── DELETE /v1/agent/automations/:automationId ───
    {
      operationId: "agent.automations.delete",
      method: "DELETE",
      path: "/v1/agent/automations/:automationId",
      auth: { public: false, anyOfScopes: [...AGENT_WRITE_SCOPES] },
      async handler(ctx) {
        const { automationId } = ctx.params as { automationId: string };
        deps.automationService.remove(automationId);
        return { deleted: true, automationId };
      },
    },

    // ─── POST /v1/agent/automations/:automationId/run ───
    {
      operationId: "agent.automations.run",
      method: "POST",
      path: "/v1/agent/automations/:automationId/run",
      auth: { public: false, anyOfScopes: [...AGENT_RUN_SCOPES] },
      async handler(ctx) {
        const { automationId } = ctx.params as { automationId: string };
        const body = (ctx.body as Record<string, unknown> | null) ?? {};

        const taskOverride = typeof body.taskOverride === "string" ? body.taskOverride : undefined;
        const providerId = typeof body.providerId === "string" ? body.providerId : undefined;
        const model = typeof body.model === "string" ? body.model : undefined;
        let timeoutMs: number | undefined;
        if (body.timeoutMs !== undefined) {
          const parsed = Number(body.timeoutMs);
          if (!Number.isFinite(parsed) || parsed < 1 || parsed > 600_000) {
            throw new FridayDomainError(
              "VALIDATION_ERROR",
              "timeoutMs must be a positive number up to 600000",
              { httpStatus: 400 },
            );
          }
          timeoutMs = parsed;
        }

        const result = await deps.automationService.run(automationId, {
          taskOverride,
          providerId,
          model,
          timeoutMs,
          sessionTarget: parseAutomationSessionTarget(body.sessionTarget, {
            allowNull: false,
            path: "sessionTarget",
          }) ?? undefined,
        });

        return { result };
      },
    },
  ];
}

// ─── Helpers ───

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === "string");
}

function parseOptionalIanaTimezone(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${path} must be a non-empty string when provided`,
      { httpStatus: 400 },
    );
  }
  const timezone = value.trim();
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch (err) {
    console.warn("[friday][agent-routes] operation failed:", err instanceof Error ? err.message : String(err));
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${path} is not a valid IANA timezone`,
      { httpStatus: 400 },
    );
  }
  return timezone;
}

function parseAutomationSchedule(
  value: unknown,
  options: { allowNull: boolean; path: string },
): FridayAgentAutomationSchedule | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) {
    if (options.allowNull) return null;
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${options.path} cannot be null`,
      { httpStatus: 400 },
    );
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${options.path} must be an object`,
      { httpStatus: 400 },
    );
  }

  const raw = value as Record<string, unknown>;
  const typeRaw = raw.type;
  if (typeRaw !== undefined && typeRaw !== "cron") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${options.path}.type must be 'cron'`,
      { httpStatus: 400 },
    );
  }

  const cron = typeof raw.cron === "string" ? raw.cron.trim() : "";
  if (!cron) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${options.path}.cron is required and must be a non-empty string`,
      { httpStatus: 400 },
    );
  }
  if (!isValidCronExpression(cron)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${options.path}.cron is not a valid cron expression`,
      { httpStatus: 400 },
    );
  }

  let timezone: string | undefined;
  if (raw.timezone !== undefined) {
    if (typeof raw.timezone !== "string" || raw.timezone.trim() === "") {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `${options.path}.timezone must be a non-empty string when provided`,
        { httpStatus: 400 },
      );
    }
    timezone = raw.timezone.trim();
    try {
      Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    } catch (err) {
    console.warn("[friday][agent-routes] operation failed:", err instanceof Error ? err.message : String(err));
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `${options.path}.timezone is not a valid IANA timezone`,
        { httpStatus: 400 },
      );
    }
  }

  return {
    type: "cron",
    cron,
    timezone,
  };
}

function parseAutomationSessionTarget(
  value: unknown,
  options: { allowNull: boolean; path: string },
): FridayAgentAutomationSessionTarget | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) {
    if (options.allowNull) return null;
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${options.path} cannot be null`,
      { httpStatus: 400 },
    );
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${options.path} must be an object`,
      { httpStatus: 400 },
    );
  }

  const raw = value as Record<string, unknown>;
  const type = raw.type;
  if (type !== "isolated" && type !== "named" && type !== "current") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${options.path}.type must be 'isolated', 'named', or 'current'`,
      { httpStatus: 400 },
    );
  }

  const sessionKey = raw.sessionKey;
  if (type === "isolated") {
    if (sessionKey !== undefined && sessionKey !== null) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `${options.path}.sessionKey is not allowed for isolated targets`,
        { httpStatus: 400 },
      );
    }
    return { type: "isolated" };
  }

  if (sessionKey === undefined || sessionKey === null) {
    if (type === "named") {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `${options.path}.sessionKey is required for named targets`,
        { httpStatus: 400 },
      );
    }
    return { type };
  }

  if (typeof sessionKey !== "string" || sessionKey.trim() === "") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${options.path}.sessionKey must be a non-empty string when provided`,
      { httpStatus: 400 },
    );
  }

  return {
    type,
    sessionKey: sessionKey.trim(),
  };
}
