import { FridayDomainError } from "#errors";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { FridayWorkflowGeneratorService } from "#workflows";
import type {
  FridayWorkflowGeneratorApproveResponse,
  FridayWorkflowGeneratorCancelResponse,
  FridayWorkflowGeneratorGenerateResponse,
  FridayWorkflowGeneratorGetSessionResponse,
  FridayWorkflowGeneratorStartSessionResponse,
  FridayWorkflowGeneratorSubmitMessageResponse,
} from "../../model/friday-api-workflow.types.js";

// ─── Deps ───

export interface FridayWorkflowGeneratorRoutesDeps {
  workflowGenerator: FridayWorkflowGeneratorService;
}

// ─── Validation helpers ───

function validateCreateSessionBody(
  body: unknown,
): asserts body is { goal: string; requestedModel?: string; userId: string; channel: string } {
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

  return [
    // 1. Create session
    {
      operationId: "workflows.generator.sessions.create",
      method: "POST",
      path: "/v1/workflows/generator/sessions",
      auth: { public: false, anyOfScopes: ["workflow.write"] },
      rateLimitPolicyId: "generator.write",
      async handler(ctx): Promise<FridayWorkflowGeneratorStartSessionResponse> {
        validateCreateSessionBody(ctx.body);
        const body = ctx.body;
        return workflowGenerator.startSession({
          goal: body.goal,
          requestedModel: body.requestedModel,
          userId: body.userId,
          channel: body.channel,
        });
      },
    },

    // 2. Get session
    {
      operationId: "workflows.generator.sessions.get",
      method: "GET",
      path: "/v1/workflows/generator/sessions/:sessionId",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
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
      auth: { public: false, anyOfScopes: ["workflow.write"] },
      rateLimitPolicyId: "generator.llm",
      async handler(ctx): Promise<FridayWorkflowGeneratorSubmitMessageResponse> {
        const { sessionId } = ctx.params as { sessionId: string };
        validateSubmitMessageBody(ctx.body);
        const body = ctx.body;
        return workflowGenerator.submitTurn(sessionId, {
          message: body.message,
          requestedModel: body.requestedModel,
        });
      },
    },

    // 4. Generate draft
    {
      operationId: "workflows.generator.sessions.generate",
      method: "POST",
      path: "/v1/workflows/generator/sessions/:sessionId/generate",
      auth: { public: false, anyOfScopes: ["workflow.write"] },
      rateLimitPolicyId: "generator.llm",
      async handler(ctx): Promise<FridayWorkflowGeneratorGenerateResponse> {
        const { sessionId } = ctx.params as { sessionId: string };
        validateGenerateBody(ctx.body);
        const body = ctx.body as { requestedModel?: string };
        const draft = await workflowGenerator.generateDraft(
          sessionId,
          body?.requestedModel,
        );
        return { draft };
      },
    },

    // 5. Approve and save
    {
      operationId: "workflows.generator.sessions.approve",
      method: "POST",
      path: "/v1/workflows/generator/sessions/:sessionId/approve",
      auth: { public: false, anyOfScopes: ["workflow.write"] },
      rateLimitPolicyId: "workflow.publish",
      async handler(ctx): Promise<FridayWorkflowGeneratorApproveResponse> {
        const { sessionId } = ctx.params as { sessionId: string };
        return workflowGenerator.approveAndSave(sessionId);
      },
    },

    // 6. Cancel session
    {
      operationId: "workflows.generator.sessions.cancel",
      method: "DELETE",
      path: "/v1/workflows/generator/sessions/:sessionId",
      auth: { public: false, anyOfScopes: ["workflow.write"] },
      async handler(ctx): Promise<FridayWorkflowGeneratorCancelResponse> {
        const { sessionId } = ctx.params as { sessionId: string };
        await workflowGenerator.cancelSession(sessionId);
        return { cancelled: true };
      },
    },
  ];
}
