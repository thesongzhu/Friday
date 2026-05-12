import type { FridaySkillGeneratorService } from "../../skills/generator/services/friday-skill-generator-service.types.js";

import type { FridayAgentToolDefinition } from "../model/friday-agent.types.js";
import {
  errorResult,
  jsonResult,
  normalizeAgentRequestedModel,
  readStringParam,
} from "./friday-agent-tool-helpers.js";

// ─── Factory deps ───

export interface CreateFridayAgentSkillGeneratorToolDeps {
  generatorService: FridaySkillGeneratorService;
  /** Default user ID for generation sessions when no principal is available. */
  defaultUserId?: string;
}

// ─── Actions ───

type SkillGenAction = "start" | "turn" | "generate" | "approve" | "cancel" | "status";

const VALID_ACTIONS = new Set<SkillGenAction>(["start", "turn", "generate", "approve", "cancel", "status"]);

function buildExampleRunInput(
  inputs: Array<{ key: string; type?: string }>,
): Record<string, unknown> {
  return Object.fromEntries(
    inputs.map((field) => [
      field.key,
      field.type === "number"
        ? 0
        : field.type === "boolean"
          ? true
          : field.type === "array"
            ? []
            : field.type === "object"
              ? {}
              : `<${field.key}>`,
    ]),
  );
}

// ─── Factory ───

export function createFridayAgentSkillGeneratorTool(
  deps: CreateFridayAgentSkillGeneratorToolDeps,
): FridayAgentToolDefinition {
  const { generatorService, defaultUserId = "system" } = deps;

  return {
    name: "skill_generate",
    description:
      "AI-powered skill generation. Actions: " +
      "start (begin a generation session with a goal), " +
      "turn (submit a follow-up message to an active session), " +
      "generate (generate the skill draft from the conversation), " +
      "approve (stage the generated skill as a lifecycle candidate; requires canonical approval support), " +
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
          description: "The skill goal/description (required for 'start').",
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
      const action = readStringParam(args, "action", { required: true }) as SkillGenAction;

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
              specSummary: result.session.specSummary,
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
              specSummary: result.session.specSummary,
            });
          }

          case "generate": {
            const sessionId = readStringParam(args, "sessionId", { required: true });
            const model = normalizeAgentRequestedModel(readStringParam(args, "model"));

            const draft = await generatorService.generateDraft(sessionId, model ?? undefined);

            return jsonResult({
              sessionId,
              validation: draft.validation,
              runtimeKind: draft.runtimeKind,
              manifest: {
                id: draft.manifest.id,
                name: draft.manifest.name,
                description: draft.manifest.description,
              },
              fileCount: draft.files.length,
              files: draft.files.map((f) => ({ path: f.path, language: f.language })),
            });
          }

          case "approve": {
            const sessionId = readStringParam(args, "sessionId", { required: true });
            const sessionData = await generatorService.getSession(sessionId);
            const requiredInputs = (sessionData?.draft?.manifest.inputs ?? [])
              .filter((field) => field.required !== false && typeof field.key === "string" && field.key.trim().length > 0)
              .map((field) => ({
                key: field.key.trim(),
                type: field.type,
                label: field.label,
              }));
            const exampleRunInput = buildExampleRunInput(requiredInputs);

            const result = await generatorService.approveAndSave(sessionId);

            return jsonResult({
              approved: true,
              skillId: result.skillId,
              skillDir: result.skillDir,
              candidateId: result.candidateId,
              candidateDir: result.candidateDir,
              savedFiles: result.savedFiles,
              registryRefreshed: result.registryRefreshed,
              promotionStage: result.promotionStage,
              promotedManifestTags: result.promotedManifestTags,
              evidence: result.evidence,
              requiredInputs,
              exampleRunInput,
              nextRecommendedAction: {
                tool: "autonomy_skill_lifecycle",
                skillId: result.skillId,
                candidateId: result.candidateId,
                action: "shadow_then_canary_then_promote",
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
              specSummary: data.session.specSummary,
              openQuestions: data.session.openQuestions,
              decisions: data.session.decisions,
              turnCount: data.turns.length,
              hasDraft: !!data.draft,
            });
          }

          default:
            return errorResult(`Unknown action "${String(action)}".`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(`skill_generate ${action} failed: ${message}`);
      }
    },
  };
}
