import { FridayDomainError } from "#errors";
import type { FridayProviderTenantContext } from "#providers";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { FridayWorkflowGeneratorService } from "#workflows";
import type { FridayObservabilityApiService } from "../../../observability/services/friday-observability-api-service.js";
import type {
  FridayWorkflowGenerationEvidence,
  FridayWorkflowGeneratorApproveResponse,
  FridayWorkflowGeneratorCancelResponse,
  FridayWorkflowGeneratorEvidenceResponse,
  FridayWorkflowGeneratorGenerateResponse,
  FridayWorkflowGeneratorGetSessionResponse,
  FridayWorkflowGeneratorStartSessionResponse,
  FridayWorkflowGeneratorSubmitMessageResponse,
} from "../../model/friday-api-workflow.types.js";

// ─── Deps ───

export interface FridayWorkflowGeneratorRoutesDeps {
  workflowGenerator: FridayWorkflowGeneratorService;
  observability?: FridayObservabilityApiService;
}

function buildTenantContext(principal: unknown, fallbackUserId: string, fallbackChannel: string): FridayProviderTenantContext {
  const record = principal && typeof principal === "object"
    ? principal as { tenantId?: unknown; principalId?: unknown; userId?: unknown }
    : {};
  const userId = typeof record.userId === "string" && record.userId.trim().length > 0
    ? record.userId.trim()
    : typeof record.principalId === "string" && record.principalId.trim().length > 0
      ? record.principalId.trim()
      : fallbackUserId;
  const tenantId = typeof record.tenantId === "string" && record.tenantId.trim().length > 0
    ? record.tenantId.trim()
    : userId;
  return {
    hubId: tenantId,
    userId,
    channelKind: fallbackChannel,
  };
}

// ─── Validation helpers ───

function validateCreateSessionBody(
  body: unknown,
): asserts body is { goal: string; requestedModel?: string; userId: string; channel: string; targetWorkflowId?: string } {
  if (body == null || typeof body !== "object") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "Request body is required",
      { httpStatus: 400 },
    );
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof b.goal !== "string" || b.goal.trim() === "") {
    errors.push("goal is required and must be a non-empty string");
  }
  if (typeof b.userId !== "string" || b.userId.trim() === "") {
    errors.push("userId is required and must be a non-empty string");
  }
  if (typeof b.channel !== "string" || b.channel.trim() === "") {
    errors.push("channel is required and must be a non-empty string");
  }
  if (b.requestedModel !== undefined && typeof b.requestedModel !== "string") {
    errors.push("requestedModel must be a string when provided");
  }
  if (b.targetWorkflowId !== undefined && typeof b.targetWorkflowId !== "string") {
    errors.push("targetWorkflowId must be a string when provided");
  }

  if (errors.length > 0) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `Invalid request body: ${errors.join("; ")}`,
      { httpStatus: 400 },
    );
  }
}

function validateSubmitMessageBody(
  body: unknown,
): asserts body is { message: string; requestedModel?: string } {
  if (body == null || typeof body !== "object") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "Request body is required",
      { httpStatus: 400 },
    );
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof b.message !== "string" || b.message.trim() === "") {
    errors.push("message is required and must be a non-empty string");
  }
  if (b.requestedModel !== undefined && typeof b.requestedModel !== "string") {
    errors.push("requestedModel must be a string when provided");
  }

  if (errors.length > 0) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `Invalid request body: ${errors.join("; ")}`,
      { httpStatus: 400 },
    );
  }
}

function validateGenerateBody(
  body: unknown,
): asserts body is { requestedModel?: string } {
  if (body != null && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (b.requestedModel !== undefined && typeof b.requestedModel !== "string") {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        "requestedModel must be a string when provided",
        { httpStatus: 400 },
      );
    }
  }
}

// ─── Factory ───

export function createFridayWorkflowGeneratorRoutes(
  deps: FridayWorkflowGeneratorRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  const { workflowGenerator } = deps;
  const isFailureMode = (mode: "clarification_required" | "preview_ready" | "draft_needs_repair" | "retryable_provider_failure" | "generation_failed") =>
    mode === "retryable_provider_failure" || mode === "generation_failed";

  async function reportGenerationFailure(input: {
    sessionId: string;
    userId: string;
    message: string;
  }): Promise<void> {
    await deps.observability?.recordWorkflowGeneratorEvent({
      sessionId: input.sessionId,
      userId: input.userId,
      event: "generation_failed",
      summary: input.message,
      ok: false,
    });
  }

  async function buildEvidence(
    sessionId: string,
  ): Promise<FridayWorkflowGenerationEvidence> {
    const result = await workflowGenerator.getSession(sessionId);
    if (!result) {
      throw new FridayDomainError(
        "GENERATOR_SESSION_NOT_FOUND",
        `Generation session not found: ${sessionId}`,
        { httpStatus: 404 },
      );
    }

    const qaVerdict = await workflowGenerator.getQaVerdict(sessionId);
    const harness = await workflowGenerator.getHarnessSummary(sessionId);
    const draft = result.draft;
    const approvalReadiness = qaVerdict
      ? {
        ready: qaVerdict.verdict === "pass",
        reason:
          qaVerdict.verdict === "pass"
            ? "Draft passed the current QA verdict."
            : qaVerdict.summary,
      }
      : draft
        ? {
          ready: draft.validation.ok,
          reason: draft.validation.ok
            ? "Draft passed generator validation and is ready for QA review."
            : "Draft has validation issues that must be fixed before approval.",
        }
        : {
          ready: false,
          reason: "No draft has been generated yet.",
        };

    return {
      sessionId,
      validationSummary: {
        ok: draft?.validation.ok ?? false,
        repaired: draft?.validation.repaired ?? false,
        repairAttempts: draft?.validation.repairAttempts ?? 0,
        issueCount: draft?.validation.issues.length ?? 0,
      },
      approvalReadiness,
      qaVerdict,
      harness,
    };
  }

  return [
    // 1. Create session
    {
      operationId: "workflows.generator.sessions.create",
      method: "POST",
      path: "/v1/workflows/generator/sessions",
      auth: { public: true },
      rateLimitPolicyId: "generator.write",
      async handler(ctx): Promise<FridayWorkflowGeneratorStartSessionResponse> {
        validateCreateSessionBody(ctx.body);
        const body = ctx.body;
        const result = await workflowGenerator.startSession({
          goal: body.goal,
          requestedModel: body.requestedModel,
          userId: body.userId,
          channel: body.channel,
          targetWorkflowId: body.targetWorkflowId,
          tenantContext: buildTenantContext(ctx.principal, body.userId, body.channel),
        });
        if (isFailureMode(result.mode)) {
          await reportGenerationFailure({
            sessionId: result.session.sessionId,
            userId: result.session.userId,
            message: result.errors?.map((error) => error.message).join("; ") ?? "generation failed",
          });
        }
        await deps.observability?.recordWorkflowGeneratorEvent({
          sessionId: result.session.sessionId,
          userId: result.session.userId,
          event: "session_started",
          summary: `Started workflow generation session for ${result.session.goal}`,
          ok: !isFailureMode(result.mode),
        });
        return result;
      },
    },

    // 2. Get session
    {
      operationId: "workflows.generator.sessions.get",
      method: "GET",
      path: "/v1/workflows/generator/sessions/:sessionId",
      auth: { public: true },
      async handler(ctx): Promise<FridayWorkflowGeneratorGetSessionResponse> {
        const { sessionId } = ctx.params as { sessionId: string };
        const result = await workflowGenerator.getSession(sessionId);
        if (!result) {
          throw new FridayDomainError(
            "GENERATOR_SESSION_NOT_FOUND",
            `Generation session not found: ${sessionId}`,
            { httpStatus: 404 },
          );
        }
        return result;
      },
    },

    // 3. Submit message
    {
      operationId: "workflows.generator.sessions.messages.create",
      method: "POST",
      path: "/v1/workflows/generator/sessions/:sessionId/messages",
      auth: { public: true },
      rateLimitPolicyId: "generator.llm",
      async handler(ctx): Promise<FridayWorkflowGeneratorSubmitMessageResponse> {
        const { sessionId } = ctx.params as { sessionId: string };
        validateSubmitMessageBody(ctx.body);
        const body = ctx.body;
        const result = await workflowGenerator.submitTurn(sessionId, {
          message: body.message,
          requestedModel: body.requestedModel,
        });
        if (isFailureMode(result.mode)) {
          await reportGenerationFailure({
            sessionId: result.session.sessionId,
            userId: result.session.userId,
            message: result.errors?.map((error) => error.message).join("; ") ?? "generation failed",
          });
        }
        return result;
      },
    },

    // 4. Generate draft
    {
      operationId: "workflows.generator.sessions.generate",
      method: "POST",
      path: "/v1/workflows/generator/sessions/:sessionId/generate",
      auth: { public: true },
      rateLimitPolicyId: "generator.llm",
      async handler(ctx): Promise<FridayWorkflowGeneratorGenerateResponse> {
        const { sessionId } = ctx.params as { sessionId: string };
        validateGenerateBody(ctx.body);
        const body = ctx.body as { requestedModel?: string };
        let draft;
        try {
          draft = await workflowGenerator.generateDraft(
            sessionId,
            body?.requestedModel,
          );
        } catch (error) {
          const session = await workflowGenerator.getSession(sessionId);
          if (session) {
            await reportGenerationFailure({
              sessionId,
              userId: session.session.userId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
          throw error;
        }
        const session = await workflowGenerator.getSession(sessionId);
        if (session) {
          const evidence = await buildEvidence(sessionId);
          await deps.observability?.recordWorkflowGeneratorEvent({
            sessionId,
            userId: session.session.userId,
            event: "draft_generated",
            summary: `Generated a workflow draft for session ${sessionId}`,
            ok: draft.validation.ok,
            evidence,
          });
          if (evidence.qaVerdict) {
            await deps.observability?.recordWorkflowGeneratorEvent({
              sessionId,
              userId: session.session.userId,
              event: "verdict_ready",
              summary: evidence.qaVerdict.summary,
              ok: evidence.qaVerdict.verdict === "pass",
              evidence,
            });
          }
        }
        return { draft };
      },
    },

    // 5. Evidence summary
    {
      operationId: "workflows.generator.sessions.evidence.get",
      method: "GET",
      path: "/v1/workflows/generator/sessions/:sessionId/evidence",
      auth: { public: true },
      async handler(ctx): Promise<FridayWorkflowGeneratorEvidenceResponse> {
        const { sessionId } = ctx.params as { sessionId: string };
        const evidence = await buildEvidence(sessionId);
        return { evidence };
      },
    },

    // 6. Approve and save
    {
      operationId: "workflows.generator.sessions.approve",
      method: "POST",
      path: "/v1/workflows/generator/sessions/:sessionId/approve",
      auth: { public: true },
      rateLimitPolicyId: "workflow.publish",
      async handler(ctx): Promise<FridayWorkflowGeneratorApproveResponse> {
        const { sessionId } = ctx.params as { sessionId: string };
        const evidence = await buildEvidence(sessionId);
        if (!evidence.approvalReadiness.ready) {
          const session = await workflowGenerator.getSession(sessionId);
          await deps.observability?.recordWorkflowGeneratorEvent({
            sessionId,
            userId: session?.session.userId ?? "operator",
            event: "approve_blocked",
            summary: evidence.approvalReadiness.reason,
            ok: false,
            evidence,
          });
        }
        const result = await workflowGenerator.approveAndSave(sessionId);
        await deps.observability?.recordWorkflowGeneratorEvent({
          sessionId,
          userId: "operator",
          event: "draft_saved",
          summary: `Saved generated workflow ${result.workflowId}`,
          ok: true,
          evidence: {
            ...evidence,
            approvalReadiness: {
              ready: true,
              reason: "Generated workflow saved.",
            },
            qaVerdict: result.qaVerdict ?? evidence.qaVerdict ?? null,
            harness: result.harness ?? evidence.harness ?? null,
          },
        });
        return {
          ...result,
          evidence: {
            ...evidence,
            approvalReadiness: {
              ready: true,
              reason: "Generated workflow saved.",
            },
            qaVerdict: result.qaVerdict ?? evidence.qaVerdict ?? null,
            harness: result.harness ?? evidence.harness ?? null,
          },
        };
      },
    },

    // 7. Cancel session
    {
      operationId: "workflows.generator.sessions.cancel",
      method: "DELETE",
      path: "/v1/workflows/generator/sessions/:sessionId",
      auth: { public: true },
      async handler(ctx): Promise<FridayWorkflowGeneratorCancelResponse> {
        const { sessionId } = ctx.params as { sessionId: string };
        await workflowGenerator.cancelSession(sessionId);
        return { cancelled: true };
      },
    },
  ];
}
