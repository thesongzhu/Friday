/**
 * PII / sensitive-field redaction for event payloads before
 * they enter the realtime event bus or audit log.
 *
 * Strategy:
 *   - Shallow-clone the payload so the original is never mutated.
 *   - Replace values of known-sensitive keys with "[REDACTED]".
 *   - Redact secret-shaped substrings inside otherwise non-sensitive strings.
 *   - Known-sensitive keys are matched case-insensitively.
 *
 * @module api/realtime
 */

// ─── Sensitive key patterns ───

const SENSITIVE_KEYS = new Set([
  "password",
  "secret",
  "token",
  "apikey",
  "api_key",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "authorization",
  "cookie",
  "ssn",
  "creditcard",
  "credit_card",
  "cardnumber",
  "card_number",
  "cvv",
  "pin",
  "privatekey",
  "private_key",
]);

const REDACTED = "[REDACTED]";

const SECRET_CONTENT_PATTERNS: Array<{
  readonly pattern: RegExp;
  readonly replacement: string | ((substring: string, ...args: string[]) => string);
}> = [
  {
    pattern:
      /-----BEGIN (?:PGP )?[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:PGP )?[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/gu,
    replacement: REDACTED,
  },
  {
    pattern: /\b(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu,
    replacement: (_match, prefix: string) => `${prefix}${REDACTED}`,
  },
  {
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu,
    replacement: (_match, prefix: string) => `${prefix}${REDACTED}`,
  },
  {
    pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/gu,
    replacement: REDACTED,
  },
  {
    pattern: /\b(?:gh[opsru]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{16,})\b/gu,
    replacement: REDACTED,
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{10,}\b/gu,
    replacement: REDACTED,
  },
  {
    pattern:
      /(^|[^A-Za-z0-9])("?(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret[_-]?access[_-]?key|password|secret|token)"?\s*[=:]\s*"?)[A-Za-z0-9._~+/=-]{8,}("?)/giu,
    replacement: (_match, leading: string, prefix: string, suffix: string) =>
      `${leading}${prefix}${REDACTED}${suffix}`,
  },
];

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[-_]/g, "").toLowerCase());
}

function redactString(value: string): string {
  let redacted = value;
  for (const { pattern, replacement } of SECRET_CONTENT_PATTERNS) {
    redacted = redacted.replace(pattern, replacement as never);
  }
  return redacted;
}

// ─── Public API ───

/**
 * Deep-clone a payload object and redact any fields whose keys
 * match known PII / secret patterns. Returns a new object —
 * the original is never mutated.
 */
export function redactEventPayload<T>(payload: T): T {
  if (payload === null || payload === undefined) return payload;
  if (typeof payload === "string") return redactString(payload) as unknown as T;
  if (typeof payload !== "object") return payload;

  if (Array.isArray(payload)) {
    return payload.map((item) => redactEventPayload(item)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      result[key] = REDACTED;
    } else if (typeof value === "object" && value !== null) {
      result[key] = redactEventPayload(value);
    } else if (typeof value === "string") {
      result[key] = redactString(value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}
