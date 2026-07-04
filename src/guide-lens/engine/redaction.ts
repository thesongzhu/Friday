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

function pushRedaction(
  redactions: FridayGuideLensRedaction[],
  kind: FridayGuideLensRedaction["kind"],
  source: FridayGuideLensRedaction["source"],
  count: number,
): void {
  if (count <= 0) return;
  redactions.push({
    kind,
    replacement: `[${kind}:redacted]`,
    source,
    count,
  });
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
    pushRedaction(redactions, kind, source, count);
  }

  return {
    text: redacted,
    redactions,
  };
}

function replaceSensitiveText(
  text: string,
  pattern: RegExp,
  replacement: string | ((match: string, ...args: unknown[]) => string),
): { text: string; count: number } {
  let count = 0;
  const next = text.replace(pattern, (match, ...args: unknown[]) => {
    count += 1;
    return typeof replacement === "function" ? replacement(match, ...args) : replacement;
  });
  return { text: next, count };
}

export function minimizeGuideLensParserText(
  text: string,
  source: FridayGuideLensRedaction["source"],
): FridayGuideLensRedactionResult {
  const secret = redactGuideLensText(text, source);
  let redacted = secret.text;
  let sensitiveCount = 0;

  const labeled = replaceSensitiveText(
    redacted,
    /\b((?:customer|email|phone|shipping\s+address|address|account\s+id|account|order|invoice)\s*(?:id|number|#)?\s*[:#])\s*[^\r\n]+/gi,
    (_match, label) => `${String(label).trim()} [sensitive_text:redacted]`,
  );
  redacted = labeled.text;
  sensitiveCount += labeled.count;

  for (const pattern of [
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    /\+?\d[\d\s().-]{7,}\d/g,
    /\b\d{1,6}\s+[A-Za-z0-9.' -]+(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct)\b(?:[, ][A-Za-z .-]+)?(?:\s+\d{5}(?:-\d{4})?)?/gi,
    /\b(?:order|invoice|account|customer|session|user)[\s_-]*(?:id|number|#)?[\s:#-]*[A-Za-z0-9._-]{4,}\b/gi,
    /\b(?:acct|cus|ord|inv)_[A-Za-z0-9_-]{6,}\b/g,
  ]) {
    const replaced = replaceSensitiveText(redacted, pattern, "[sensitive_text:redacted]");
    redacted = replaced.text;
    sensitiveCount += replaced.count;
  }

  if (/(?:@|customer|phone|ship|address|order|account|invoice)/i.test(text)) {
    const names = replaceSensitiveText(
      redacted,
      /\b[A-Z][a-z]{1,30}\s+[A-Z][a-z]{1,30}\b/g,
      "[sensitive_text:redacted]",
    );
    redacted = names.text;
    sensitiveCount += names.count;
  }

  return {
    text: redacted,
    redactions: [
      ...secret.redactions,
      ...(sensitiveCount > 0
        ? [{
          kind: "sensitive_text" as const,
          replacement: "[sensitive_text:redacted]",
          source,
          count: sensitiveCount,
        }]
        : []),
    ],
  };
}

export function looksSensitiveGuideLensText(text: string): boolean {
  return SECRET_PATTERNS.some(({ pattern }) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  }) || /(?:@|customer|phone|ship|address|order|account|invoice|\+?\d[\d\s().-]{7,}\d)/i.test(text);
}
