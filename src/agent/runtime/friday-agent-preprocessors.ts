export type FridayAgentPreprocessorKind =
  | "test_output"
  | "log_excerpt"
  | "browser_snapshot"
  | "diff_excerpt";

export interface FridayAgentPreprocessorInput {
  kind: FridayAgentPreprocessorKind;
  content: string;
  maxChars?: number;
}

export interface FridayAgentPreprocessorResult {
  kind: FridayAgentPreprocessorKind;
  applied: boolean;
  content: string;
  originalChars: number;
  outputChars: number;
}

function clipContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  return `${content.slice(0, maxChars)}\n...(truncated)`;
}

export function preprocessFridayAgentContent(
  input: FridayAgentPreprocessorInput,
): FridayAgentPreprocessorResult {
  const maxChars = input.maxChars ?? 1_200;
  const original = input.content;
  let next = original;

  switch (input.kind) {
    case "test_output":
      next = original
        .split("\n")
        .filter((line) => /fail|error|warn|expected|actual|Assertion/i.test(line))
        .join("\n");
      break;
    case "log_excerpt":
      next = original
        .split("\n")
        .filter((line) => /\b(error|warn|fatal|exception)\b/i.test(line))
        .join("\n");
      break;
    case "browser_snapshot":
      next = original
        .split("\n")
        .filter((line) => /title|heading|button|form|error|alert|dialog/i.test(line))
        .join("\n");
      break;
    case "diff_excerpt":
      next = original
        .split("\n")
        .filter((line) => /^[+-]/.test(line) || /^@@/.test(line))
        .join("\n");
      break;
  }

  if (next.trim().length === 0) {
    next = original;
  }

  const clipped = clipContent(next.trim(), maxChars);
  return {
    kind: input.kind,
    applied: clipped !== original,
    content: clipped,
    originalChars: original.length,
    outputChars: clipped.length,
  };
}
