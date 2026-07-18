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
 *      …): full value-PII + secret redaction, Unicode-obfuscation resistant. String
 *      leaves run (a) the Unicode-resistant SECRET pass (Bearer / sk- / gh_ / JWT /
 *      PEM / KEY=VALUE assignments), then (b) the Unicode-resistant value-PII pass —
 *      email / US phone / US SSN / Luhn-gated card BY VALUE — which reuses the
 *      canonical shared production guard's own detector (the #1610 reuse principle)
 *      over a shared NFKD detection copy, so a fullwidth / zero-width-split / combining
 *      / precomposed-accent email (or phone/SSN/card) is redacted FULL-SPAN before an
 *      ASCII pass could fragment it — closing round-8 F2b; then (c) the shared
 *      `redactDeep` safety net (ASCII + fullwidth-DIGIT value-PII and the typed
 *      number/bigint two-gate policy). The secret pass runs first so a secret is masked
 *      before its digits could be misread as a false card/phone. Steps (a)/(b) leave
 *      benign multilingual/accented text byte-identical and pure-ASCII/fullwidth-DIGIT
 *      input identical to the prior guard output (a strict Unicode-resistant superset).
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

import {
  findSecretShapeSpans,
  redactSecretShapesInString,
} from "../../security/friday-secret-shape-redactor.js";
import {
  buildUnicodeDetectionCopy,
  redactUnicodeObfuscated,
} from "../../security/friday-unicode-pii-normalizer.js";
import { createFridayMemoryPiiGuard } from "../../memory/guard/services/friday-memory-pii-guard.js";
import { redactUnicodeResistantPii } from "../../security/friday-value-pii-fold.js";

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

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[-_]/g, "").toLowerCase());
}

/**
 * Strip secret-shaped substrings (PEM / Bearer / sk- / gh_ / JWT / KEY=VALUE / …) from a string,
 * resistant to zero-width / combining / fullwidth / math-alphanumeric / precomposed-accent Unicode
 * obfuscation. Delegates to the CANONICAL shared secret detector — `findSecretShapeSpans` /
 * `redactSecretShapesInString` (`src/security/friday-secret-shape-redactor.ts`) — layered over the
 * canonical `redactUnicodeObfuscated` / `buildUnicodeDetectionCopy` de-obfuscation primitive
 * (`src/security/friday-unicode-pii-normalizer.ts`), EXACTLY as the memory-egress + audit sinks do
 * (no divergent realtime-local detector). Two passes mirror those sinks:
 *   1. Unicode pass — when the detection copy actually folds (obfuscated input), run
 *      `findSecretShapeSpans` over the de-obfuscated copy; each match is mapped back to the ORIGINAL
 *      bytes (credential subspan only — a Bearer scheme / assignment label + separator + quoting is
 *      preserved BYTE-FOR-BYTE) and spliced. Skipped (no-op) on pure-ASCII input.
 *   2. Raw residual — `redactSecretShapesInString` catches a pure-ASCII (or any un-obfuscated)
 *      secret the Unicode pass skipped. Both passes use the realtime `[REDACTED]` marker (a
 *      documented parameter of the shared detector), so behavior is byte-consistent with the prior
 *      pass and benign multilingual text round-trips byte-identical.
 */
function redactString(value: string): string {
  const detection = buildUnicodeDetectionCopy(value);
  const afterUnicode = detection.changed
    ? redactUnicodeObfuscated(value, [(normalized) => findSecretShapeSpans(normalized, REDACTED)])
    : value;
  return redactSecretShapesInString(afterUnicode, REDACTED);
}

/**
 * Full CONTENT-field redaction for a string leaf, resistant to Unicode obfuscation for
 * BOTH secrets AND value-PII (round-8 F2b). Order is load-bearing:
 *   1. secret pass (Unicode-resistant) — the CANONICAL shared secret detector
 *      (`findSecretShapeSpans` / `redactSecretShapesInString` via `redactString`) masks a secret
 *      before its digits could be misread as a card/phone;
 *   2. value-PII pass (Unicode-resistant) — email / phone / SSN / Luhn-gated card, run over the
 *      value-PII detection copy using the shared guard's own detector, so a fullwidth / zero-width-
 *      split / combining / precomposed-accent email (or phone/SSN/card) is redacted FULL-SPAN with
 *      the guard's canonical `[<TYPE>]` marker BEFORE any ASCII pass can fragment it (no partial-
 *      fragment residual). The copy is ALIGNED with the guard's deliberate width fold
 *      (the shared `src/security/friday-value-pii-fold.ts`) so it never over-redacts compat-whitespace-bridged
 *      fullwidth digits or decorative No/Nl digit runs (round-9 F2b-ND-1);
 *   3. shared `redactDeep` — an idempotent ASCII/fullwidth-DIGIT safety net (the markers
 *      from steps 1–2 carry no PII shape, so it is a no-op on them) that also preserves the
 *      established at-rest string policy.
 * Pure-ASCII / fullwidth-DIGIT input round-trips byte-identically to the prior behavior:
 * the value-PII pass reuses the guard's exact matcher and its normalized copy is length-
 * aligned 1:1 for those inputs, so it produces the identical marker/extent — a strict
 * Unicode-resistant superset, never a divergence. Benign multilingual text is untouched.
 */
function redactContentString(value: string): string {
  const afterSecrets = redactString(value);
  const afterPii = redactUnicodeResistantPii(
    afterSecrets,
    (normalized) => piiValueGuard.scanAndTransform(normalized).matches,
  );
  return piiValueGuard.redactDeep(afterPii).value as string;
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
 * CONTENT scalar: strings go through {@link redactContentString} — the Unicode-resistant
 * secret pass, then the Unicode-resistant value-PII pass (email / phone / SSN / card),
 * then the shared `redactDeep` safety net — so obfuscated PII is redacted FULL-SPAN before
 * any ASCII pass could fragment it, while pure-ASCII / fullwidth-DIGIT input round-trips
 * byte-identically. Numbers/bigints get redactDeep's two-gate typed-PII policy WITH their
 * key context (redact only when the key names a PII type AND the value shape matches —
 * benign numeric ids preserved). Other scalars pass through unchanged.
 */
function redactContentScalar(key: string, value: unknown): unknown {
  if (typeof value === "string") {
    return redactContentString(value);
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

// ─── Identifier pseudonymization (SEC-EVENT-REDACTION-001 root fix) ───

function pseudonymizeNode(
  value: unknown,
  role: FieldRole,
  pseudonymize: (raw: string) => string,
  seen: WeakMap<object, unknown>,
): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value !== "object") {
    // Only STRING identifier scalars are pseudonymized (the sensitive-bytes vector);
    // content and non-string leaves are left for the content-PII pass.
    return role === "identifier" && typeof value === "string" ? pseudonymize(value) : value;
  }

  const container = value as object;
  const existing = seen.get(container);
  if (existing !== undefined) return existing; // cycle / shared ref → structural share

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(container, out);
    // An array is never a scalar routing identifier (mirrors the redactor's FIX 1):
    // its elements are CONTENT even under an id-role key.
    for (const item of value) {
      out.push(pseudonymizeNode(item, "content", pseudonymize, seen));
    }
    return out;
  }

  const out: Record<string, unknown> = {};
  seen.set(container, out);
  for (const [key, childValue] of Object.entries(value as Record<string, unknown>)) {
    const childRole: FieldRole = isIdentifierField(key) ? "identifier" : "content";
    Object.defineProperty(out, key, {
      value: pseudonymizeNode(childValue, childRole, pseudonymize, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * Replace every IDENTIFIER-field string value (the same fields
 * {@link redactEventPayload} exempts from value-PII redaction) with its
 * deterministic owner-scoped pseudonym, using the caller-supplied `pseudonymize`
 * function. Applied at the event-forming sites BEFORE {@link redactEventPayload}, so
 * the streamId/resourceId derived from the payload — and the persisted payload id
 * fields — carry the OPAQUE pseudonym, never the raw value. Content fields are left
 * for the content-PII pass. Cycle-safe and prototype-pollution-safe. Returns a new
 * value — the original is never mutated. When `pseudonymize` is identity (inactive),
 * the result is byte-identical to the input.
 */
export function pseudonymizeEventIdentifiers<T>(
  payload: T,
  pseudonymize: (raw: string) => string,
): T {
  return pseudonymizeNode(payload, "content", pseudonymize, new WeakMap<object, unknown>()) as T;
}
