/**
 * PII / sensitive-field redaction for event payloads before they enter the
 * realtime event bus, the agent-run-event store, the realtime_events store,
 * the WS gateway, or the execution-control audit log.
 *
 * TWO LAYERED, ORDER-DEPENDENT passes composed so neither undoes the other:
 *
 *   Pass 1 — secret-shaped + sensitive-key (this module):
 *     - Replace values of known-sensitive KEYS with "[REDACTED]".
 *     - Redact secret-SHAPED substrings (Bearer / sk- / gh_ / JWT / PEM /
 *       KEY=VALUE assignments) that the value-PII pass does NOT cover.
 *     - Runs FIRST so a secret can never be partially chewed into a false
 *       card/phone by the value-PII pass — the secret is already "[REDACTED]".
 *     - Cycle- and prototype-pollution-safe (WeakMap-guarded; Object.defineProperty
 *       so a JSON-origin own key "__proto__" is preserved for pass 2).
 *
 *   Pass 2 — PII-BY-VALUE (shared production redactor, the #1610 reuse principle):
 *     `createFridayMemoryPiiGuard("redact").redactDeep(...)` — the SAME canonical
 *     guard the memory path uses. Adds email / US phone / US SSN / Luhn-gated card
 *     BY VALUE in free text, full-width & CJK-adjacent PII, and typed
 *     number/bigint PII under the two-gate policy (sensitive key AND value shape),
 *     with the \p{Nd} pure-digit key exemption so benign numeric business ids are
 *     preserved (no over-redaction / NO DEGRADE). It is ITERATIVE and CYCLE-AWARE,
 *     so the combined path is cycle-safe.
 *
 * Both passes deep-clone; the original payload is never mutated.
 *
 * @module api/realtime
 */

import { createFridayMemoryPiiGuard } from "../../memory/guard/services/friday-memory-pii-guard.js";

// ─── Pass 2: value-PII guard (shared production redactor) ───
// Constructed ONCE at module load — the factory takes only an optional mode and
// has NO dependencies, so no DI/bootstrap wiring is needed at the call sites.
const piiValueGuard = createFridayMemoryPiiGuard("redact");

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

// ─── Pass 1: secret-shaped + sensitive-key (cycle- & prototype-safe) ───

/**
 * Deep-clone `payload`, masking values under sensitive KEYS to "[REDACTED]" and
 * redacting secret-SHAPED substrings inside string leaves. `seen` maps an input
 * container to its output container so a cyclic or shared reference resolves to
 * the SAME output node instead of recursing forever (cycle-safe). Object writes
 * use Object.defineProperty so a JSON-origin own key named "__proto__" is
 * preserved as an ordinary data property (no prototype pollution, no field loss)
 * for pass 2 to walk.
 */
function redactSecretShapesAndSensitiveKeys<T>(
  payload: T,
  seen: WeakMap<object, unknown>,
): T {
  if (payload === null || payload === undefined) return payload;
  if (typeof payload === "string") return redactString(payload) as unknown as T;
  if (typeof payload !== "object") return payload;

  const container = payload as unknown as object;
  const existing = seen.get(container);
  if (existing !== undefined) return existing as T; // cycle / shared ref → structural share

  if (Array.isArray(payload)) {
    const out: unknown[] = [];
    seen.set(container, out);
    for (const item of payload) {
      out.push(redactSecretShapesAndSensitiveKeys(item, seen));
    }
    return out as unknown as T;
  }

  const out: Record<string, unknown> = {};
  seen.set(container, out);
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    const redactedValue = isSensitiveKey(key)
      ? REDACTED
      : redactSecretShapesAndSensitiveKeys(value, seen);
    Object.defineProperty(out, key, {
      value: redactedValue,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out as T;
}

// ─── Public API ───

/**
 * Redact PII and secrets from an event payload before it is persisted or
 * egressed. Returns a new value — the original is never mutated.
 *
 * Pass 1 masks sensitive keys + secret-shaped strings (cycle- & proto-safe);
 * pass 2 applies the shared production value-PII redactor (`redactDeep`), which
 * adds email/phone/SSN/card-by-value, full-width & CJK-adjacent PII, and typed
 * numeric PII while preserving benign business identifiers. `redactDeep` is
 * cycle-aware, so the composed path never stack-overflows on a cyclic payload.
 */
export function redactEventPayload<T>(payload: T): T {
  const afterSecrets = redactSecretShapesAndSensitiveKeys(
    payload,
    new WeakMap<object, unknown>(),
  );
  return piiValueGuard.redactDeep(afterSecrets).value as T;
}
