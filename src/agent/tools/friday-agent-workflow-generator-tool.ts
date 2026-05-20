import type { FridayWorkflowGeneratorService } from "../../workflows/generator/services/friday-workflow-generator-service.types.js";

import type { FridayAgentToolDefinition } from "../model/friday-agent.types.js";
import {
  errorResult,
  jsonResult,
  normalizeAgentRequestedModel,
  readStringParam,
} from "./friday-agent-tool-helpers.js";

// ─── Factory deps ───

export interface CreateFridayAgentWorkflowGeneratorToolDeps {
  generatorService: FridayWorkflowGeneratorService;
  /** Default user ID for generation sessions when no principal is available. */
  defaultUserId?: string;
}

// ─── Actions ───

type WorkflowGenAction = "start" | "turn" | "generate" | "approve" | "cancel" | "status";

const VALID_ACTIONS = new Set<WorkflowGenAction>(["start", "turn", "generate", "approve", "cancel", "status"]);

// ─── Factory ───

export function createFridayAgentWorkflowGeneratorTool(
  deps: CreateFridayAgentWorkflowGeneratorToolDeps,
): FridayAgentToolDefinition {
  const { generatorService, defaultUserId = "system" } = deps;

  return {
    name: "workflow_generate",
    description:
      "AI-powered workflow generation. Actions: " +
      "start (begin a generation session with a goal), " +
      "turn (submit a follow-up message to an active session), " +
      "generate (generate the workflow draft from the conversation), " +
      "approve (publish the generated workflow version; not lifecycle promotion), " +
      "cancel (cancel an active session), " +
      "status (check session status and draft).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...VALID_ACTIONS],
          description: "The action to perform.",
        },
        goal: {
          type: "string",
          description: "The workflow goal/description (required for 'start').",
        },
        sessionId: {
          type: "string",
          description: "The generation session ID (required for turn/generate/approve/cancel/status).",
        },
        message: {
          type: "string",
          description: "Follow-up message (required for 'turn').",
        },
        model: {
          type: "string",
          description: "Optional model override for generation.",
        },
        userId: {
          type: "string",
          description: "Optional user ID for the session.",
        },
        channel: {
          type: "string",
          description: "Optional channel (defaults to 'agent').",
        },
      },
      required: ["action"],
    },

    async execute(args) {
      const action = readStringParam(args, "action", { required: true }) as WorkflowGenAction;

      if (!VALID_ACTIONS.has(action)) {
        return errorResult(`Invalid action "${action}". Must be one of: ${[...VALID_ACTIONS].join(", ")}`);
      }

      try {
        switch (action) {
          case "start": {
            const goal = readStringParam(args, "goal", { required: true });
            const model = normalizeAgentRequestedModel(readStringParam(args, "model"));
            const userId = readStringParam(args, "userId") ?? defaultUserId;
            const channel = readStringParam(args, "channel") ?? "agent";

            const result = await generatorService.startSession({
              goal,
              requestedModel: model ?? undefined,
              userId,
              channel,
            });

            return jsonResult({
              sessionId: result.session.sessionId,
              status: result.session.status,
              mode: result.mode,
              questions: result.questions ?? [],
            });
          }

          case "turn": {
            const sessionId = readStringParam(args, "sessionId", { required: true });
            const message = readStringParam(args, "message", { required: true });
            const model = normalizeAgentRequestedModel(readStringParam(args, "model"));

            const result = await generatorService.submitTurn(sessionId, {
              message,
              requestedModel: model ?? undefined,
            });

            return jsonResult({
              sessionId: result.session.sessionId,
              status: result.session.status,
              mode: result.mode,
              questions: result.questions ?? [],
            });
          }

          case "generate": {
            const sessionId = readStringParam(args, "sessionId", { required: true });
            const model = normalizeAgentRequestedModel(readStringParam(args, "model"));

            const draft = await generatorService.generateDraft(sessionId, model ?? undefined);

            return jsonResult({
              sessionId,
              validation: draft.validation,
              spec: {
                name: draft.spec.name,
                description: draft.spec.description,
                stepCount: draft.spec.steps?.length ?? 0,
                edgeCount: draft.spec.edges?.length ?? 0,
              },
              testCount: draft.tests?.length ?? 0,
            });
          }

          case "approve": {
            const sessionId = readStringParam(args, "sessionId", { required: true });

            const result = await generatorService.approveAndSave(sessionId);

            return jsonResult({
              approved: true,
              workflowId: result.workflowId,
              workflowVersionId: result.workflowVersionId,
              versionNumber: result.versionNumber,
              slug: result.slug,
              published: result.published,
              publicationBoundary: result.publicationBoundary,
              nextRecommendedAction: {
                surface: "workflow_lifecycle",
                workflowId: result.workflowId,
                workflowVersionId: result.workflowVersionId,
                action: "run workflow lifecycle shadow/canary/promote proof before claiming lifecycle promotion",
              },
            });
          }

          case "cancel": {
            const sessionId = readStringParam(args, "sessionId", { required: true });
            await generatorService.cancelSession(sessionId);
            return jsonResult({ cancelled: true, sessionId });
          }

          case "status": {
            const sessionId = readStringParam(args, "sessionId", { required: true });
            const data = await generatorService.getSession(sessionId);

            if (!data) {
              return errorResult(`Session "${sessionId}" not found.`);
            }

            return jsonResult({
              sessionId: data.session.sessionId,
              status: data.session.status,
              goal: data.session.goal,
              turnCount: data.turns.length,
              hasDraft: !!data.draft,
            });
          }

          default:
            return errorResult(`Unknown action "${String(action)}".`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(`workflow_generate ${action} failed: ${message}`);
      }
    },
  };
}
