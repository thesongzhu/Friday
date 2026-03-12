import type { FridayAgentTestResult } from "../model/friday-agent.types.js";

// ─── Service interface ───

export interface FridayAgentSelfFixService {
  /** Evaluate test results and decide whether to retry. */
  evaluate(params: FridayAgentSelfFixParams): FridayAgentSelfFixResult;
  /** Reset internal attempt tracking state. */
  reset(): void;
}

// ─── Params ───

export interface FridayAgentSelfFixParams {
  /** Test results from the current attempt. */
  testResults: FridayAgentTestResult[];
  /** The original user task description. */
  task: string;
  /** Current attempt number (0-based). */
  attempt: number;
  /** Maximum allowed attempts. */
  maxAttempts: number;
}

// ─── Result ───

export interface FridayAgentSelfFixResult {
  /** Whether the runtime should retry by feeding fixPrompt back to the LLM. */
  shouldRetry: boolean;
  /** The prompt to feed back into the LLM loop for fixing. */
  fixPrompt?: string;
  /** Human-readable reason when giving up. */
  reason?: string;
}

// ─── Factory ───

export function createFridayAgentSelfFixService(): FridayAgentSelfFixService {
  let previousErrorSignature: string | undefined;

  return {
    evaluate(params: FridayAgentSelfFixParams): FridayAgentSelfFixResult {
      const { testResults, task, attempt, maxAttempts } = params;

      // All tests passed — no fix needed
      const failures = testResults.filter((r) => !r.passed);
      if (failures.length === 0) {
        return { shouldRetry: false, reason: "All tests passed" };
      }

      // Budget exhausted
      if (attempt + 1 >= maxAttempts) {
        return {
          shouldRetry: false,
          reason: `Exhausted retry budget (${String(maxAttempts)} attempts)`,
        };
      }

      // Collect all error messages from failures
      const currentErrors = failures.flatMap((f) => f.errors.map((e) => e.message));
      const currentSignature = buildErrorSignature(currentErrors);

      // Detect identical errors (no progress) — give up early
      if (previousErrorSignature !== undefined && currentSignature === previousErrorSignature) {
        return {
          shouldRetry: false,
          reason: "Identical errors detected — no progress between attempts",
        };
      }

      // Record this attempt's error signature for next comparison
      previousErrorSignature = currentSignature;

      // Build fix prompt
      const errorSummary = formatErrorSummary(failures);
      const fixPrompt = buildFixPrompt(task, errorSummary);

      return { shouldRetry: true, fixPrompt };
    },

    reset(): void {
      previousErrorSignature = undefined;
    },
  };
}

// ─── Helpers ───

function buildErrorSignature(errorMessages: string[]): string {
  // Sort for deterministic comparison regardless of order
  return [...errorMessages].sort().join("\n");
}

function formatErrorSummary(failures: FridayAgentTestResult[]): string {
  const parts: string[] = [];

  for (const failure of failures) {
    const strategyLabel = `[${failure.strategy}]`;
    for (const error of failure.errors) {
      const location = error.file
        ? error.line !== undefined
          ? ` (${error.file}:${String(error.line)})`
          : ` (${error.file})`
        : "";
      parts.push(`${strategyLabel} ${error.severity}: ${error.message}${location}`);
    }
  }

  return parts.join("\n");
}

function buildFixPrompt(task: string, errorSummary: string): string {
  return [
    "The previous attempt failed validation. Fix the issues below.",
    "",
    "── Original task ──",
    task,
    "",
    "── Test failures ──",
    errorSummary,
    "",
    "Fix the issues and produce corrected output.",
  ].join("\n");
}
