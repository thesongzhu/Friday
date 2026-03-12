/**
 * PII / sensitive-field redaction for event payloads before
 * they enter the realtime event bus or audit log.
 *
 * Strategy:
 *   - Shallow-clone the payload so the original is never mutated.
 *   - Replace values of known-sensitive keys with "[REDACTED]".
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

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[-_]/g, "").toLowerCase());
}

// ─── Public API ───

/**
 * Deep-clone a payload object and redact any fields whose keys
 * match known PII / secret patterns. Returns a new object —
 * the original is never mutated.
 */
export function redactEventPayload<T>(payload: T): T {
  if (payload === null || payload === undefined) return payload;
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
    } else {
      result[key] = value;
    }
  }
  return result as T;
}
