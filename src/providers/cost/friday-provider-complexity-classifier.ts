import type { FridayTaskComplexity } from "../model/friday-provider-cost.types.js";

// ─── Constants ───

/** Prompts below this token estimate are classified as simple. */
const SIMPLE_MAX_TOKENS = 900;

/** Prompts above this token estimate are classified as complex. */
const COMPLEX_MIN_TOKENS = 4_000;

/** Keywords that push classification toward complex. */
const COMPLEX_KEYWORDS = [
  "multi-file",
  "refactor",
  "architecture",
  "migration",
  "security",
  "validator",
  "schema",
  "workflow",
  "async",
  "error handling",
];

// ─── Interface ───

export interface FridayProviderComplexityClassifier {
  classify(params: {
    systemPrompt: string;
    userPrompt: string;
    estimatedInputTokens: number;
  }): FridayTaskComplexity;
}

// ─── Factory ───

export function createFridayProviderComplexityClassifier(): FridayProviderComplexityClassifier {
  return {
    classify(params) {
      const { systemPrompt, userPrompt, estimatedInputTokens } = params;

      // Fast path: small prompts are simple
      if (estimatedInputTokens <= SIMPLE_MAX_TOKENS) {
        return "simple";
      }

      // Check for complex keywords in combined prompt text
      const combinedLower = `${systemPrompt}\n${userPrompt}`.toLowerCase();
      const matchedKeywords = COMPLEX_KEYWORDS.filter((kw) =>
        combinedLower.includes(kw),
      );

      // Token-heavy or keyword-dense → complex
      if (estimatedInputTokens >= COMPLEX_MIN_TOKENS || matchedKeywords.length >= 2) {
        return "complex";
      }

      // Single keyword match → medium
      if (matchedKeywords.length >= 1) {
        return "medium";
      }

      return "medium";
    },
  };
}
