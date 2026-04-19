import type { FridayLearningEventAppendInput } from "#ledger";

import type { FridayAgentToolDefinition } from "../model/friday-agent.types.js";
import { getFridayAgentToolExecutionContext } from "../runtime/friday-agent-tool-execution-context.js";
import { readStringParam, textResult } from "./friday-agent-tool-helpers.js";

// ─── Factory deps ───

export interface CreateFridayAgentFeedbackToolDeps {
  learningEventWriter: (events: FridayLearningEventAppendInput[]) => void;
  idGenerator: () => string;
  nowIso: () => string;
  /** User ID to attribute feedback events to (must exist in users table). */
  defaultUserId: string;
}

// ─── Factory ───

const VALID_KINDS = ["correction", "preference", "positive_feedback"] as const;

function normalizeFeedbackField(field: string): string {
  return field.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function extractExplicitDisplayName(taskPrompt?: string): string | null {
  if (!taskPrompt) {
    return null;
  }
  const patterns = [
    /\bcall me\s+(.+?)\s*[.!?]?$/i,
    /(叫我|称呼我为|把我叫做|被称为)\s*["“]?([^"”'。！？!,，\n]+)["”']?/u,
  ] as const;
  for (const pattern of patterns) {
    const match = taskPrompt.match(pattern);
    const rawValue = match?.[2] ?? match?.[1];
    if (typeof rawValue === "string" && rawValue.trim().length > 0) {
      return rawValue.trim().replace(/^["“']+|["”']+$/gu, "");
    }
  }
  return null;
}

export function createFridayAgentFeedbackTool(
  deps: CreateFridayAgentFeedbackToolDeps,
): FridayAgentToolDefinition {
  const { learningEventWriter, idGenerator, nowIso, defaultUserId } = deps;

  return {
    name: "feedback",
    description:
      "Record a user correction, preference, or piece of feedback for the learning system. " +
      "Use this when the user explicitly corrects you or states a preference.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: [...VALID_KINDS],
          description: "The type of feedback: correction, preference, or positive_feedback.",
        },
        field: {
          type: "string",
          description: "What the feedback is about (e.g. 'tone', 'format', 'language').",
        },
        value: {
          type: "string",
          description: "The preferred value or correction.",
        },
        context: {
          type: "string",
          description: "Brief context about what was corrected or preferred.",
        },
      },
      required: ["kind", "field", "value"],
    },

    async execute(args: Record<string, unknown>, signal: AbortSignal) {
      const kind = readStringParam(args, "kind", { required: true });
      const field = readStringParam(args, "field", { required: true });
      const normalizedField = normalizeFeedbackField(field);
      const rawValue = readStringParam(args, "value", { required: true });
      const context = typeof args["context"] === "string" ? args["context"] : undefined;
      const executionContext = getFridayAgentToolExecutionContext(signal);
      const exactDisplayName = kind === "preference"
        && (normalizedField === "user_name" || normalizedField === "display_name" || normalizedField === "name")
        ? extractExplicitDisplayName(executionContext?.taskPrompt)
        : null;
      const value = exactDisplayName ?? rawValue;

      // Use per-run principal if injected by the runtime, otherwise fall back to default.
      const userId =
        typeof args["__principalId"] === "string" && args["__principalId"].length > 0
          ? args["__principalId"]
          : defaultUserId;

      if (!(VALID_KINDS as readonly string[]).includes(kind)) {
        return textResult(`Invalid feedback kind "${kind}". Must be one of: ${VALID_KINDS.join(", ")}`);
      }

      learningEventWriter([
        {
          eventId: idGenerator(),
          ts: nowIso(),
          userId,
          kind: "user_correction",
          payload: {
            feedbackKind: kind,
            correctedField: field,
            newValue: value,
            field,
            value,
            ...(context ? { context } : {}),
          },
        },
      ]);

      return textResult(`Feedback recorded: ${kind} for "${field}" = "${value}".`);
    },
  };
}
