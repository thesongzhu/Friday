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

const PARSER_SAFE_ACTION_TEXT = /^(?:authorize|continue|next|done|save|submit|allow|deny|cancel|ok|open|connect|retry|back|sign in|log in)$/i;

const PARSER_VALUE_LABEL = /^((?:api\s*key|access\s*token|secret\s*key|password|passcode|secret|customer|email|phone|shipping\s+address|address|account\s+id|account|order|invoice|full\s+name|patient|dob|date\s+of\s+birth|mrn|medical\s+record(?:\s+number)?)\s*(?:id|number)?\s*(?::|#)?)\s+(.+)$/i;

const SECRET_PLACEHOLDER = /\[(?:api_key|password|token|secret):redacted\]/;

function minimizeParserLine(line: string): { text: string; redacted: boolean } {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return { text: line, redacted: false };
  }
  if (PARSER_SAFE_ACTION_TEXT.test(trimmed)) {
    return { text: trimmed, redacted: false };
  }
  if (SECRET_PLACEHOLDER.test(trimmed) && /^\[.*\]$/.test(trimmed)) {
    return { text: trimmed, redacted: false };
  }

  const label = trimmed.match(PARSER_VALUE_LABEL);
  if (label) {
    const placeholder = label[2].match(SECRET_PLACEHOLDER)?.[0] ?? "[sensitive_text:redacted]";
    return {
      text: `${label[1].trim()} ${placeholder}`,
      redacted: placeholder === "[sensitive_text:redacted]",
    };
  }

  return { text: "[sensitive_text:redacted]", redacted: true };
}

export function minimizeGuideLensParserText(
  text: string,
  source: FridayGuideLensRedaction["source"],
): FridayGuideLensRedactionResult {
  const secret = redactGuideLensText(text, source);
  const minimizedLines: string[] = [];
  let sensitiveCount = 0;

  for (const line of secret.text.split(/\r?\n/)) {
    const minimized = minimizeParserLine(line);
    minimizedLines.push(minimized.text);
    if (minimized.redacted) {
      sensitiveCount += 1;
    }
  }

  return {
    text: minimizedLines.join("\n"),
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
