import type { FridayGuideLensRedaction } from "../model/friday-guide-lens.types.js";

const SECRET_PATTERNS: Array<{
  kind: FridayGuideLensRedaction["kind"];
  pattern: RegExp;
}> = [
  {
    kind: "api_key",
    pattern: /\b(?:sk|pk|rk|ak)-[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    kind: "token",
    pattern: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    kind: "password",
    pattern: /\b(password|passcode|secret)\s*[:=]\s*([^\s,;]+)/gi,
  },
  {
    kind: "secret",
    pattern: /\b(?:api[_ -]?key|access[_ -]?token|secret[_ -]?key)\s*[:=]\s*([^\s,;]+)/gi,
  },
];

export interface FridayGuideLensRedactionResult {
  text: string;
  redactions: FridayGuideLensRedaction[];
}

export function redactGuideLensText(
  text: string,
  source: FridayGuideLensRedaction["source"],
): FridayGuideLensRedactionResult {
  let redacted = text;
  const redactions: FridayGuideLensRedaction[] = [];

  for (const { kind, pattern } of SECRET_PATTERNS) {
    let count = 0;
    redacted = redacted.replace(pattern, (match, prefix) => {
      count += 1;
      if (kind === "password" || kind === "secret") {
        const label = typeof prefix === "string" && prefix.trim().length > 0
          ? prefix
          : kind;
        return `${label}: [${kind}:redacted]`;
      }
      return `[${kind}:redacted]`;
    });
    if (count > 0) {
      redactions.push({
        kind,
        replacement: `[${kind}:redacted]`,
        source,
        count,
      });
    }
  }

  return {
    text: redacted,
    redactions,
  };
}

export function looksSensitiveGuideLensText(text: string): boolean {
  return SECRET_PATTERNS.some(({ pattern }) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}
