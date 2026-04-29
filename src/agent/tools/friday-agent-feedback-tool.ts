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
const FEEDBACK_VALUE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "be",
  "for",
  "i",
  "is",
  "me",
  "my",
  "of",
  "please",
  "the",
  "to",
  "use",
]);
const EXPLICIT_FEEDBACK_STATEMENT_PATTERNS = [
  /\b(?:i|we)\s+(?:prefer|like|want|need|usually use|would like)\b/i,
  /\b(?:call me|refer to me as|my codename is|my name is)\b/i,
  /\b(?:that(?:'s| is)\s+wrong|incorrect|actually|instead|use .* instead)\b/i,
  /(我更喜欢|我希望|我想要|请叫我|叫我|称呼我为|我的名字是|我叫|我的昵称是|名字叫|昵称是|以后叫我|以后称呼我为|我的代号是|这是错的|应该改成)/u,
] as const;
const FEEDBACK_QUESTION_PATTERNS = [
  /^\s*(?:what|which|who|can|could|would|do|did|does|is|are)\b/i,
  /^\s*(?:什么|哪个|谁|可以|能不能|是否|是不是)/u,
] as const;

function normalizeFeedbackField(field: string): string {
  return field.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function tokenizeFeedbackValue(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !FEEDBACK_VALUE_STOPWORDS.has(token));
}

function taskPromptExplicitlyStatesFeedback(taskPrompt?: string): boolean {
  if (!taskPrompt || taskPrompt.trim().length === 0) {
    return false;
  }
  if (EXPLICIT_FEEDBACK_STATEMENT_PATTERNS.some((pattern) => pattern.test(taskPrompt))) {
    return true;
  }
  return false;
}

function taskPromptLooksLikeQuestion(taskPrompt?: string): boolean {
  if (!taskPrompt || taskPrompt.trim().length === 0) {
    return false;
  }
  return FEEDBACK_QUESTION_PATTERNS.some((pattern) => pattern.test(taskPrompt))
    || taskPrompt.includes("?");
}

function taskPromptSupportsFeedbackValue(taskPrompt: string | undefined, value: string): boolean {
  if (!taskPrompt || taskPrompt.trim().length === 0) {
    return false;
  }
  const promptLower = taskPrompt.toLowerCase();
  const normalizedValue = value.trim().toLowerCase();
  if (normalizedValue.length >= 3 && promptLower.includes(normalizedValue)) {
    return true;
  }
  const valueTokens = tokenizeFeedbackValue(value);
  if (valueTokens.length === 0) {
    return false;
  }
  const matchedTokenCount = valueTokens.filter((token) => promptLower.includes(token)).length;
  return matchedTokenCount >= Math.min(2, valueTokens.length);
}

function extractExplicitDisplayName(taskPrompt?: string): string | null {
  if (!taskPrompt) {
    return null;
  }
  const patterns = [
    /\bcall me\s+(.+?)\s*[.!?]?$/i,
    /\bmy name is\s+(.+?)\s*[.!?]?$/i,
    /\brefer to me as\s+(.+?)\s*[.!?]?$/i,
    /(叫我|称呼我为|把我叫做|被称为)\s*["“]?([^"”'。！？!,，\n]+)["”']?/u,
    /(我的名字是|我叫|我的昵称是|名字叫|昵称是|以后叫我|以后称呼我为)\s*["“]?([^"”'。！？!,，\n]+)["”']?/u,
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
      const taskPrompt = executionContext?.taskPrompt;

      // Use per-run principal if injected by the runtime, otherwise fall back to default.
      const userId =
        typeof args["__principalId"] === "string" && args["__principalId"].length > 0
          ? args["__principalId"]
          : defaultUserId;

      if (!(VALID_KINDS as readonly string[]).includes(kind)) {
        return textResult(`Invalid feedback kind "${kind}". Must be one of: ${VALID_KINDS.join(", ")}`);
      }

      const explicitFeedbackStatement = taskPromptExplicitlyStatesFeedback(taskPrompt);
      const questionLikePrompt = taskPromptLooksLikeQuestion(taskPrompt);
      const valueSupportedByPrompt = taskPromptSupportsFeedbackValue(taskPrompt, value);

      if (!explicitFeedbackStatement || questionLikePrompt || !valueSupportedByPrompt) {
        return textResult(
          "Feedback not recorded because the current user message does not explicitly state that correction or preference.",
        );
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
