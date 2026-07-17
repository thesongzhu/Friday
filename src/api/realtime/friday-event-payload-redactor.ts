/**
 * PII / sensitive-field redaction for event payloads before they enter the
 * realtime event bus, the agent-run-event store, the realtime_events store,
 * the WS gateway, or the execution-control audit log.
 *
 * FIELD-ROLE-AWARE redaction — a single cycle-safe, prototype-safe deep walk
 * that classifies every field and applies one of three policies:
 *
 *   1. Sensitive KEYS (password/secret/token/apikey/ssn/creditcard/…): the whole
 *      value is masked to "[REDACTED]" (highest priority; unchanged behavior).
 *
 *   2. IDENTIFIER / ROUTING fields (executionId, runId, streamId, correlationId,
 *      every field the execution-control emitter derives streamId / audit
 *      resourceId from, and the standard "<name>Id" / "<name>_id" convention):
 *      EXEMPT from shape-based VALUE-PII redaction. Benign string ids round-trip
 *      byte-unchanged and — critically — two DISTINCT ids that happen to be
 *      PII-shaped (e.g. "alice@example.com" vs "bob@example.com") stay DISTINCT,
 *      so the emitter can never collapse them into one streamId / audit key.
 *      Secret-shaped substrings are still stripped from identifier strings (secret
 *      hygiene, and parity with the previous redactor).
 *
 *   3. CONTENT fields (message, errorMessage, note, detail, output, reason, args,
 *      …): full value-PII redaction via the canonical shared production guard
 *      `createFridayMemoryPiiGuard("redact").redactDeep(...)` (the #1610 reuse
 *      principle) — email / US phone / US SSN / Luhn-gated card BY VALUE, full-width
 *      & CJK-adjacent PII, and typed number/bigint PII under the two-gate policy —
 *      LAYERED with the secret-shaped-string pass (Bearer / sk- / gh_ / JWT / PEM /
 *      KEY=VALUE assignments) that redactDeep does not cover. Secret pass runs
 *      first so a secret is masked before redactDeep could chew its digits into a
 *      false card/phone.
 *
 * Why this shape (and not a blunt redactDeep over the whole payload): identifier /
 * routing fields are the SAME plane the event bus and audit log key on. Redacting
 * their VALUES (a) collapses distinct entities into one replay/subscription
 * sequence and destroys audit correlation, and (b) irreversibly rewrites benign
 * string business ids (orderId "2345678" → "[PHONE_US]"). Only CONTENT is
 * shape-redacted; identifiers keep their identity.
 *
 * Residual (disclosed): because the public execute seam accepts arbitrary strings,
 * a caller may place PII in an identifier (e.g. executionId), which then flows
 * un-redacted into the owner-scoped streamId / audit resourceId. streamId format is
 * load-bearing for existing subscription/replay, so it is NOT hashed; the residual
 * is the caller's own PII in the caller's own owner-scoped routing key — analogous
 * to the owner-authenticated WS delivery caveat. Distinct values are never
 * collapsed to one marker.
 *
 * The walk is cycle-safe (WeakMap structural-share) and prototype-pollution-safe
 * (Object.defineProperty). The original payload is never mutated.
 *
 * @module api/realtime
 */

import { createFridayMemoryPiiGuard } from "../../memory/guard/services/friday-memory-pii-guard.js";

// Shared production value-PII guard — constructed ONCE at module load. The factory
// takes only an optional mode and has NO dependencies, so no DI/bootstrap wiring is
// needed at the (direct-import) call sites.
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

// ─── Identifier / routing field allowlist ───

/**
 * Explicit lowercased allowlist of IDENTIFIER / ROUTING field names — every field
 * that the execution-control emitter derives streamId / audit resourceId from
 * (`friday-execution-control-event-emitter.ts`) plus every entity-id / correlation
 * field enumerated from the event payload map (`friday-api-realtime.types.ts`) and
 * the standard business-id fields observed on these payloads. Values under these
 * keys must NOT be shape-redacted: they are identity/routing keys, and redacting
 * them collapses distinct entities and destroys audit correlation.
 */
const IDENTIFIER_FIELD_NAMES = new Set<string>([
  // streamId / audit resourceId derivation fields (the emitter)
  "ruleid",
  "evaluationid",
  "bundleid",
  "executionid",
  "runid",
  "resultid",
  "entryid",
  "contextid",
  "candidateid",
  "playbookid",
  // routing / correlation (envelope + subscription)
  "streamid",
  "correlationid",
  "eventid",
  "subscriptionid",
  "requestid",
  "traceid",
  "spanid",
  "connid",
  "epoch",
  "cursor",
  // entity ids from the event payload map
  "workflowid",
  "versionid",
  "workflowversionid",
  "conflictid",
  "draftid",
  "cancelledby",
  "nodeid",
  "satelliteid",
  "tokenid",
  "principalid",
  "incidentid",
  "userid",
  "diagnosisid",
  "actionid",
  // in-domain crash-fingerprint / version correlation fields (system-generated,
  // opaque, non-PII) — exempt so an accidental PII-shape match cannot corrupt a
  // legitimate fingerprint. SCOPED to specific compound field names: a BARE
  // "signature" / "fingerprint" (which an arbitrary-payload caller could fill with
  // free-text PII) is deliberately NOT exempt and is content-redacted.
  "errorfingerprint",
  "errorsignature",
  "crashsignature",
  "etag",
  // common business identifiers
  "id",
  "orderid",
  "invoiceid",
  "invoicenumber",
  "transactionid",
  "transactionref",
  "customerid",
  "accountid",
  "objectid",
  "referenceid",
  "refid",
  "externalid",
  "jobid",
  "taskid",
  "sessionid",
  "sessionkey",
]);

/**
 * True when `key` names an identifier/routing field. Matches the explicit allowlist,
 * OR the strict identifier NAMING CONVENTION on the ORIGINAL-cased key: camelCase
 * "<name>Id", all-caps "<name>ID"/"<name>UUID"/"<name>GUID", camelCase
 * "<name>Uuid"/"<name>Guid", snake "<name>_id", or exactly "id". The case-sensitive
 * suffix deliberately does NOT match words that merely end in a lowercase "id"
 * (grid / valid / android) and never matches content fields (message, note, …).
 * The "…Number" convention is intentionally excluded — it would wrongly exempt
 * PII-bearing fields such as phoneNumber / socialSecurityNumber.
 */
function isIdentifierField(key: string): boolean {
  if (IDENTIFIER_FIELD_NAMES.has(key.toLowerCase())) return true;
  if (key.toLowerCase() === "id") return true;
  return /(?:Id|ID|_id|Uuid|UUID|Guid|GUID)$/.test(key);
}

// ─── Scalar-leaf redaction policies ───

/**
 * CONTENT scalar: strings get the secret-shape pass first (so a secret is masked
 * before redactDeep can misread its digits) then the shared value-PII redactor;
 * numbers/bigints get redactDeep's two-gate typed-PII policy WITH their key context
 * (redact only when the key names a PII type AND the value shape matches — benign
 * numeric ids preserved). Other scalars pass through unchanged.
 */
function redactContentScalar(key: string, value: unknown): unknown {
  if (typeof value === "string") {
    return piiValueGuard.redactDeep(redactString(value)).value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    // Wrap under the real key so redactDeep's two-gate sees the key context, then read
    // the single resulting value back (via Object.values so the lookup is robust to any
    // key rename and free of dynamic-index object access).
    const wrapped = piiValueGuard.redactDeep({ [key]: value }).value;
    const wrappedValues = Object.values(wrapped as Record<string, unknown>);
    return wrappedValues.length > 0 ? wrappedValues[0] : value;
  }
  return value;
}

/**
 * IDENTIFIER scalar: preserve identity. Strings keep only the secret-shape pass
 * (parity with the previous redactor + secret hygiene) but are NEVER value-PII
 * redacted, so distinct ids stay distinct. Numbers and other scalars pass through
 * unchanged.
 */
function redactIdentifierScalar(value: unknown): unknown {
  return typeof value === "string" ? redactString(value) : value;
}

// ─── Cycle- & prototype-safe field-role-aware walk ───

type FieldRole = "content" | "identifier";

function redactNode(
  value: unknown,
  enclosingKey: string | undefined,
  role: FieldRole,
  seen: WeakMap<object, unknown>,
): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value !== "object") {
    return role === "identifier"
      ? redactIdentifierScalar(value)
      : redactContentScalar(enclosingKey ?? "", value);
  }

  const container = value as object;
  const existing = seen.get(container);
  if (existing !== undefined) return existing; // cycle / shared ref → structural share

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(container, out);
    // An ARRAY is never a scalar routing identifier, so its elements are ALWAYS
    // treated as CONTENT — the identifier exemption is NOT propagated into a list
    // under an id-role key (otherwise `externalId: ["a@b.com", …]` would inherit
    // the exemption and persist CLEAR). The SCALAR-id exemption is unaffected: a
    // scalar directly under an id key is still exempt (findings #1/#2 intact). The
    // array's own key context is still threaded for the numeric two-gate.
    for (const item of value) {
      out.push(redactNode(item, enclosingKey, "content", seen));
    }
    return out;
  }

  const out: Record<string, unknown> = {};
  seen.set(container, out);
  for (const [key, childValue] of Object.entries(value as Record<string, unknown>)) {
    let redactedChild: unknown;
    if (isSensitiveKey(key)) {
      redactedChild = REDACTED;
    } else {
      const childRole: FieldRole = isIdentifierField(key) ? "identifier" : "content";
      redactedChild = redactNode(childValue, key, childRole, seen);
    }
    // Prototype-pollution-safe write: a JSON-origin own key named "__proto__" would
    // otherwise hit the prototype setter (mutating the output prototype and dropping
    // the field). defineProperty round-trips it as an ordinary own data property.
    Object.defineProperty(out, key, {
      value: redactedChild,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

// ─── Public API ───

/**
 * Redact PII and secrets from an event payload before it is persisted or egressed.
 * Returns a new value — the original is never mutated. Field-role-aware: identifier /
 * routing fields keep their identity (exempt from value-PII redaction, distinct ids
 * stay distinct); content fields are value-PII + secret redacted; sensitive keys are
 * masked. Cycle-safe and prototype-pollution-safe.
 */
export function redactEventPayload<T>(payload: T): T {
  return redactNode(payload, undefined, "content", new WeakMap<object, unknown>()) as T;
}
