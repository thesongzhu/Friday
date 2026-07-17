/**
 * Hub audit log writer — legacy compatibility wrapper around the hardened
 * security audit log writer.
 *
 * Delegates to `src/security/friday-audit-log.ts` for actual writes.
 * Accepts the legacy `FridayAuditLogWrite` type from hub memory state types
 * and converts to `FridayAuditRecord` for the security layer.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import {
  appendFridayAuditLog as appendSecurityAuditLog,
  buildFridayAuditRecordBase,
  resolveFridayAuditLogPath as resolveSecurityAuditLogPath,
} from "../../security/friday-audit-log.js";
import type { FridayAuditRecord, FridayAuditLogWriterOptions as SecurityWriterOptions } from "../../security/friday-audit-log.js";
// SEC-EVENT-REDACTION-001: reuse the shared production PII guard read-only. It is NOT modified.
import { createFridayMemoryPiiGuard } from "../../memory/guard/services/friday-memory-pii-guard.js";
// SEC-EVENT-REDACTION-001: shared, comprehensive secret-shape scrubber (field-name + generic
// assignment + github_pat_/ghp_ + sk-/JWT/PEM/Bearer + AWS/Slack). Independent string primitive,
// layered OVER the PII guard.
import {
  FRIDAY_DEFAULT_SECRET_MARKER,
  isSensitiveSecretFieldName,
  redactSecretShapesInString,
} from "../../security/friday-secret-shape-redactor.js";
import type { FridayAuditLogWrite } from "./friday-hub-memory-state.types.js";

// ─── Types (legacy compatibility re-export) ───

export interface FridayAuditLogWriterOptions {
  /** Maximum file size in bytes before rotation. Default: 10MB. */
  maxBytes?: number;
  /** Number of most-recent lines to keep after rotation. Default: 1000. */
  keepLines?: number;
}

// ─── Path helper (legacy compatibility re-export) ───

/**
 * Resolve the audit log path within a state directory.
 */
export function resolveFridayAuditLogPath(stateDir: string): string {
  return resolveSecurityAuditLogPath(stateDir);
}

// ─── Details redaction (SEC-EVENT-REDACTION-001) ───
//
// The caller-supplied `details` payload is arbitrary and has been persisted RAW into both the
// SQLite `audit_logs.details_json` column and the `audit.jsonl` mirror. Live inflow (hub
// `logChannelIssue`) spreads `chatId` — the user's phone for WhatsApp/Signal — plus a free-text
// `errorMessage` and arbitrary caller fields. This module redacts PII-by-value and secret shapes
// from the `details` CONTENT before it reaches either sink. It NEVER touches the canonical audit
// columns (id / ts / actor / action / resource / request/trace ids / result), which live OUTSIDE
// `details` on the record and are copied through `toAuditRecord` verbatim.

/**
 * Shared production PII guard, reused read-only. `redactDeep` redacts PII-by-value
 * (email / US phone incl. full-width / SSN / Luhn-gated credit card) across a deep value and
 * returns `{ value, tagsToAdd }` — we unwrap `.value`. The shared guard does NOT cover secret
 * shapes, so the shared `redactSecretShapesInString` scrubber is layered on top (see the content /
 * identifier leaf passes).
 */
const auditPiiGuard = createFridayMemoryPiiGuard("redact");

const AUDIT_SECRET_MARKER = FRIDAY_DEFAULT_SECRET_MARKER;

/** Marker for an international (non-US) E.164 channel-identity phone (see `redactInternationalChannelPhone`). */
const AUDIT_INTL_PHONE_MARKER = "[PHONE]";

/**
 * Residual country-code US phone completion, layered on both content and preserved-identifier
 * strings. The shared guard's US-phone detector matches the bare 10-digit and separator forms but
 * NOT the `+1XXXXXXXXXX` / `1XXXXXXXXXX` country-code forms — which is exactly how the live channel
 * `chatId` arrives (Signal `sourceNumber` is E.164 `+1…`; WhatsApp `msg.from` is bare `1…`).
 * Without this, the headline chatId phone would survive redaction. The pattern REQUIRES the leading
 * `1` country code and is digit-run-bounded (`(?<![\w+])` … `(?!\d)`) so it never fires on a benign
 * national-format id, an epoch timestamp, or a longer numeric id.
 */
function redactResidualUsPhone(input: string): string {
  return input.replace(
    /(?<![\w+])\+?1[-.\s]?\(?[2-9]\d{2}\)?[-.\s]?[2-9]\d{2}[-.\s]?\d{4}(?!\d)/g,
    "[PHONE_US]",
  );
}

// International-channel-phone pass (SEC-EVENT-REDACTION-001 finding 3). Context-scoped to the AUDIT
// redactor — NOT a change to the shared US-only `friday-memory-pii-guard.ts` (which is used by
// memory / learned-fact / typed-PII, where a blanket international rule would over-redact benign
// international-looking numbers). Channel identities arrive as E.164 `+<cc><number>` (Signal
// `sourceNumber`, WhatsApp non-US `from`), so a UK `+447911123456` embedded in `chatId` /
// `sessionKey` / `correlationId` would otherwise persist CLEAR. Three discriminators keep this from
// collapsing benign machine identifiers OR signed monetary amounts (reviewer finding F-2):
//   1. a MANDATORY leading `+` / full-width `＋` — a benign numeric id, epoch, or SHA never carries one;
//   2. a candidate that contains a DECIMAL POINT or thousands grouping (`+100000.00`, `+1,000,000`) is
//      a monetary amount, never a channel phone → rejected outright;
//   3. the digit count must be a PLAUSIBLE international channel phone: 11–15 digits (1–3-digit
//      country code + national number). A short `+`-number (`+12345678`, `+1000000000`) is a signed
//      amount / id, not a channel identity, and is left intact.
// ASCII and full-width digits / separators are both recognized; the fold is used only to COUNT digits.
const AUDIT_INTL_PHONE_CANDIDATE =
  /(?<![0-9０-９A-Za-z+＋])[+＋][1-9１-９][0-9０-９()\-.,\s　（）－．，]{6,18}/gu;
const AUDIT_INTL_PHONE_TRAILING_SEP = /[()\-.,\s　（）－．，]+$/u;
// A decimal point / comma INSIDE the core marks a monetary amount (or grouped number), not a phone.
const AUDIT_INTL_PHONE_AMOUNT_SEP = /[.,．，]/u;

function foldedDigitCount(candidate: string): number {
  let count = 0;
  for (const ch of candidate) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp >= 0x30 && cp <= 0x39) || (cp >= 0xff10 && cp <= 0xff19)) count += 1;
  }
  return count;
}

function redactInternationalChannelPhone(input: string): string {
  return input.replace(AUDIT_INTL_PHONE_CANDIDATE, (match) => {
    // The greedy separator class may capture trailing separators/punctuation; strip them so we
    // never eat following benign text and count digits on the phone core only. Trailing sentence
    // punctuation (`.`, `,`) is stripped here BEFORE the amount check, so it does not mask a phone.
    const core = match.replace(AUDIT_INTL_PHONE_TRAILING_SEP, "");
    if (AUDIT_INTL_PHONE_AMOUNT_SEP.test(core)) return match; // decimal / grouped amount → leave intact
    const digits = foldedDigitCount(core);
    if (digits < 11 || digits > 15) return match; // not a channel-phone-length number → leave intact
    return `${AUDIT_INTL_PHONE_MARKER}${match.slice(core.length)}`;
  });
}

/**
 * Preserved-identifier leaf pass: secret shapes + phone stripping, WITHOUT the PII-by-value guard.
 *
 * Forensic identifier fields are preserved (they skip `redactDeep`) so distinct correlation / trace
 * / run ids stay distinct and a benign national-format numeric id is never collapsed. But the LIVE
 * channel caller builds `correlationId` / `channelCorrelationId` / (channel) `idempotencyKey` as
 * `channel:<kind>:<chatId>:<msg.id>`, where `chatId` IS the user's phone (Signal E.164 `+1…`/`+44…`,
 * WhatsApp bare `1…`). Without a phone pass those ids would persist the phone CLEAR — the same phone
 * redacted in the `chatId` / `sessionKey` content of the SAME record (the #1618 over-exemption
 * class). US + international passes strip exactly the phone segment while the `channel:<kind>:`
 * routing prefix and message-id tail survive; the US pass needs a leading `1` and the intl pass a
 * leading `+`, so a benign national-format id (`2015550123`), opaque id (`run-…`/`wamid.…`/UUID),
 * epoch, or SHA is left intact — distinct ids are not collapsed or corrupted.
 */
function redactIdentifierLeaf(input: string): string {
  return redactInternationalChannelPhone(redactResidualUsPhone(redactSecretShapesInString(input)));
}

/** Secret shapes + US + international channel phone — applied to CONTENT strings (after `redactDeep`). */
function redactContentLeaf(input: string): string {
  return redactInternationalChannelPhone(redactResidualUsPhone(redactSecretShapesInString(input)));
}

/**
 * Deeply map every string leaf of `value` through `fn`, preserving structure, key order,
 * numbers, booleans, null and `Date` instances. Iterative + cycle-aware (a back-edge to a node
 * still on the DFS path becomes a structural share) so arbitrarily deep or self-referential
 * input neither overflows the call stack nor loops forever. Objects are rebuilt via own
 * data-property definition so a JSON-originated `__proto__` key cannot poison the prototype.
 *
 * `fn` may return a non-string (e.g. the finalize pass restores a forensic placeholder string with
 * its original object/array subtree); the returned value replaces the string leaf verbatim and is
 * NOT re-walked, so a fully-processed replacement subtree is spliced in as-is.
 */
function mapStringsDeep(value: unknown, fn: (s: string) => unknown): unknown {
  type ValueFrame = { v: unknown; assign: (r: unknown) => void };
  type ExitFrame = { exit: object };
  const root: { out: unknown } = { out: undefined };
  const onPath = new WeakMap<object, unknown>();
  const stack: Array<ValueFrame | ExitFrame> = [{ v: value, assign: (r) => { root.out = r; } }];

  while (stack.length > 0) {
    const frame = stack.pop() as ValueFrame | ExitFrame;
    if ("exit" in frame) {
      onPath.delete(frame.exit);
      continue;
    }
    const { v, assign } = frame;

    if (typeof v === "string") {
      assign(fn(v));
      continue;
    }
    if (v instanceof Date) {
      assign(v);
      continue;
    }
    if (Array.isArray(v)) {
      if (onPath.has(v)) {
        assign(onPath.get(v));
        continue;
      }
      const out: unknown[] = new Array(v.length);
      onPath.set(v, out);
      assign(out);
      stack.push({ exit: v });
      for (let i = v.length - 1; i >= 0; i -= 1) {
        const idx = i;
        stack.push({ v: v[idx], assign: (r) => { out[idx] = r; } });
      }
      continue;
    }
    if (v && typeof v === "object") {
      if (onPath.has(v)) {
        assign(onPath.get(v));
        continue;
      }
      const out: Record<string, unknown> = {};
      onPath.set(v, out);
      assign(out);
      stack.push({ exit: v });
      const objectEntries = Object.entries(v as Record<string, unknown>);
      for (let i = objectEntries.length - 1; i >= 0; i -= 1) {
        const key = objectEntries[i][0];
        const child = objectEntries[i][1];
        stack.push({
          v: child,
          assign: (r) => {
            Object.defineProperty(out, key, {
              value: r,
              enumerable: true,
              writable: true,
              configurable: true,
            });
          },
        });
      }
      continue;
    }

    assign(v); // number / bigint / boolean / null / undefined / symbol / function
  }

  return root.out;
}

/**
 * Curated forensic-identifier allowlist (normalized to compact lowercase). Values under these
 * keys are PRESERVED — they skip the `redactDeep` PII-by-value pass and only the identifier-leaf
 * pass runs on them (secret shapes + residual leading-country-code E.164 phone; see
 * `redactIdentifierLeaf`) — so distinct correlation / trace / run / request / resource identifiers
 * stay distinct and a benign national-format numeric id is never corrupted by a false-positive PII
 * match, while a phone embedded in a channel-derived id (`channel:<kind>:<phone>:…`) is still
 * stripped. This is the #1618 field-role lesson: a blunt deep-redact over a whole payload collapses
 * distinct identifiers and corrupts benign business ids.
 *
 * The allowlist holds ONLY machine-generated correlation / trace / run / request / sequence ids —
 * values that are never user PII but CAN coincidentally match a PII shape (e.g. a phone-shaped
 * numeric id), which is precisely the false-positive corruption this allowlist prevents.
 *
 * Fields that are DERIVED from a user identifier are DELIBERATELY absent, because preserving them
 * would leak the very PII we redact elsewhere:
 *   - `chatId` / `senderId` — a channel chatId is a routing id that is ALSO the user's phone for
 *     WhatsApp/Signal;
 *   - `sessionKey` / `sessionId` — a channel session key is built as `channel:<kind>:<chatId>`
 *     (normalized, NOT hashed), so it embeds the phone.
 * These are treated as CONTENT: their non-PII routing prefix survives (`channel:signal:` stays)
 * while the embedded phone is redacted, keeping the fix consistent with the `chatId` redaction.
 * Any preserved identifier that still legitimately embeds PII is a disclosed owner-scoped residual
 * (the audit sinks are owner-scoped, 0600-permissioned).
 */
const AUDIT_FORENSIC_IDENTIFIER_KEYS = new Set<string>([
  "id", "requestid", "correlationid", "channelcorrelationid", "runid", "parentrunid",
  "traceid", "spanid", "messageid", "nodeid", "toolcallid",
  "grantid", "skillid", "workflowid", "workflowversionid", "routeid", "resourceid",
  "entityid", "eventid", "jobid", "taskid", "threadid", "sequence", "sequencenumber",
  "idempotencykey", "canonicalactiondigest", "plandigest", "revision",
]);

/**
 * Compound suffixes that unambiguously denote a machine identifier (never user PII), so prefixed
 * variants (e.g. `parentCorrelationId`, `originalRequestId`) are also preserved. Bare `id` is
 * intentionally NOT a suffix — it would swallow `chatId` / `senderId`, which carry PII.
 */
const AUDIT_FORENSIC_IDENTIFIER_SUFFIXES = [
  "correlationid", "requestid", "runid", "traceid", "spanid", "toolcallid",
  "sequencenumber", "idempotencykey", "messageid",
];

function isForensicIdentifierKey(key: string): boolean {
  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  if (normalized.length === 0) return false;
  if (AUDIT_FORENSIC_IDENTIFIER_KEYS.has(normalized)) return true;
  return AUDIT_FORENSIC_IDENTIFIER_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/**
 * OUT-OF-BAND marker for a cut-out forensic subtree (reviewer finding F-1). Restoration keys on
 * OBJECT IDENTITY (`instanceof`), NEVER on a string value — so NO untrusted content value can ever
 * be mistaken for a marker (a prior in-band NUL-delimited string sentinel could be forged verbatim
 * by a caller `details` value, corrupting the record). It extends `Date` because a `Date` is the
 * ONLY value the shared guard's `redactDeep` (and `mapStringsDeep`) passes through BY REFERENCE, so
 * the marker survives the PII pass with its identity — and its captured `original` — intact.
 */
class AuditForensicRef extends Date {
  readonly original: unknown;
  constructor(original: unknown) {
    super(0);
    this.original = original;
  }
}

/** Content phone pre-pass (US then international), applied to CONTENT strings BEFORE `redactDeep`. */
function redactContentChannelPhones(input: string): string {
  return redactInternationalChannelPhone(redactResidualUsPhone(input));
}

/**
 * Build the CONTENT SKELETON for `redactAuditDetails` Pass 1 — RECURSIVE / path-aware field-role
 * classification applied at EVERY object level (finding 2). Iterative + cycle-aware (a back-edge to
 * a node still on the DFS path becomes a structural share, so deep/cyclic input neither overflows
 * the stack nor loops). At each object key:
 *   - forensic identifier key  → the whole value is CUT: replaced by an `AuditForensicRef` wrapper
 *     (out-of-band identity), so the PII guard never sees (and never corrupts) a nested benign
 *     identifier such as `nested.requestId = "2015550123"`;
 *   - sensitive-secret key     → the whole value is nuked to the secret marker (an opaque
 *     credential has no shape and is only catchable by its key);
 *   - content key              → cloned through and descended, so `redactDeep` redacts its PII.
 * CONTENT string leaves get the phone pre-pass HERE (F-3): a Luhn-valid 13–16-digit `+`-E.164 phone
 * becomes `[PHONE]` BEFORE `redactDeep`'s CARD detector runs in Pass 2, so it is never mislabeled
 * `+[CREDIT_CARD]`. Array elements inherit their container's content role; an OBJECT element
 * re-establishes per-key roles. Keys are reserved in FORWARD `Object.entries` order and written as
 * own data properties, so enumeration order is byte-identical to the input and a JSON `__proto__`
 * key cannot pollute.
 */
function buildContentSkeleton(root: unknown): unknown {
  type ValueFrame = { v: unknown; assign: (r: unknown) => void };
  type ExitFrame = { exit: object };
  const outRef: { value: unknown } = { value: undefined };
  const onPath = new WeakMap<object, unknown>();
  const stack: Array<ValueFrame | ExitFrame> = [{ v: root, assign: (r) => { outRef.value = r; } }];

  const defineOwn = (target: Record<string, unknown>, key: string, val: unknown): void => {
    Object.defineProperty(target, key, { value: val, enumerable: true, writable: true, configurable: true });
  };

  while (stack.length > 0) {
    const frame = stack.pop() as ValueFrame | ExitFrame;
    if ("exit" in frame) {
      onPath.delete(frame.exit);
      continue;
    }
    const { v, assign } = frame;

    if (Array.isArray(v)) {
      if (onPath.has(v)) { assign(onPath.get(v)); continue; }
      const arr: unknown[] = new Array(v.length);
      onPath.set(v, arr);
      assign(arr);
      stack.push({ exit: v });
      for (let i = v.length - 1; i >= 0; i -= 1) {
        const idx = i;
        stack.push({ v: v[idx], assign: (r) => { arr[idx] = r; } });
      }
      continue;
    }

    if (v && typeof v === "object" && !(v instanceof Date)) {
      if (onPath.has(v)) { assign(onPath.get(v)); continue; }
      const obj: Record<string, unknown> = {};
      onPath.set(v, obj);
      assign(obj);
      stack.push({ exit: v });
      const childFrames: ValueFrame[] = [];
      for (const [key, child] of Object.entries(v as Record<string, unknown>)) {
        if (isForensicIdentifierKey(key)) {
          defineOwn(obj, key, new AuditForensicRef(child)); // cut point — restored by identity in Pass 3
        } else if (isSensitiveSecretFieldName(key)) {
          defineOwn(obj, key, AUDIT_SECRET_MARKER); // nuke the whole value regardless of shape
        } else {
          defineOwn(obj, key, undefined); // reserve slot in forward order; filled by its frame
          childFrames.push({ v: child, assign: (r) => { defineOwn(obj, key, r); } });
        }
      }
      for (let i = childFrames.length - 1; i >= 0; i -= 1) {
        stack.push(childFrames[i]);
      }
      continue;
    }

    // Scalar leaf. Only genuine CONTENT scalars reach here (forensic subtrees are cut, secret values
    // nuked). Content strings get the phone pre-pass BEFORE `redactDeep` sees them (F-3).
    assign(typeof v === "string" ? redactContentChannelPhones(v) : v);
  }

  return outRef.value;
}

/**
 * Pass 3 — finalize the redacted skeleton. Iterative + cycle-aware. For each node:
 *   - `AuditForensicRef`  → restore the cut-out subtree, run through the identifier-leaf. Keyed on
 *     OBJECT IDENTITY, so a content value can NEVER be mistaken for a marker (F-1 fix);
 *   - genuine `Date`      → preserved (type + value);
 *   - string leaf         → content-leaf (secret shapes + US/intl phone);
 *   - array / object      → rebuilt, keys reserved in FORWARD order (order + `__proto__` safety).
 */
function finalizeRedactedSkeleton(root: unknown): unknown {
  type ValueFrame = { v: unknown; assign: (r: unknown) => void };
  type ExitFrame = { exit: object };
  const outRef: { value: unknown } = { value: undefined };
  const onPath = new WeakMap<object, unknown>();
  const stack: Array<ValueFrame | ExitFrame> = [{ v: root, assign: (r) => { outRef.value = r; } }];

  const defineOwn = (target: Record<string, unknown>, key: string, val: unknown): void => {
    Object.defineProperty(target, key, { value: val, enumerable: true, writable: true, configurable: true });
  };

  while (stack.length > 0) {
    const frame = stack.pop() as ValueFrame | ExitFrame;
    if ("exit" in frame) {
      onPath.delete(frame.exit);
      continue;
    }
    const { v, assign } = frame;

    if (typeof v === "string") {
      assign(redactContentLeaf(v));
      continue;
    }
    if (v instanceof AuditForensicRef) {
      assign(mapStringsDeep(v.original, redactIdentifierLeaf));
      continue;
    }
    if (v instanceof Date) {
      assign(v); // genuine caller Date — preserve
      continue;
    }
    if (Array.isArray(v)) {
      if (onPath.has(v)) { assign(onPath.get(v)); continue; }
      const arr: unknown[] = new Array(v.length);
      onPath.set(v, arr);
      assign(arr);
      stack.push({ exit: v });
      for (let i = v.length - 1; i >= 0; i -= 1) {
        const idx = i;
        stack.push({ v: v[idx], assign: (r) => { arr[idx] = r; } });
      }
      continue;
    }
    if (v && typeof v === "object") {
      if (onPath.has(v)) { assign(onPath.get(v)); continue; }
      const obj: Record<string, unknown> = {};
      onPath.set(v, obj);
      assign(obj);
      stack.push({ exit: v });
      const objectEntries = Object.entries(v as Record<string, unknown>);
      for (const [key] of objectEntries) defineOwn(obj, key, undefined); // reserve forward order
      for (let i = objectEntries.length - 1; i >= 0; i -= 1) {
        const key = objectEntries[i][0];
        const child = objectEntries[i][1];
        stack.push({ v: child, assign: (r) => { defineOwn(obj, key, r); } });
      }
      continue;
    }

    assign(v); // number / bigint / boolean / null / undefined
  }

  return outRef.value;
}

/**
 * Redact the caller `details` payload before persistence. RECURSIVE, field-role aware at EVERY
 * nesting level (SEC-EVENT-REDACTION-001):
 *   - forensic identifier fields (allowlist, any depth) → PRESERVED as identifiers (cut out of the
 *     PII guard, identifier-leaf only), so distinct ids stay distinct and a nested benign
 *     phone-shaped id is never corrupted to `[PHONE_US]`;
 *   - sensitive-secret field NAMES (any depth)          → whole value nuked to the secret marker;
 *   - every other CONTENT field                         → phone pre-pass, then PII-by-value
 *     redaction via `redactDeep`, then the content-leaf (secret shapes + US/intl phone).
 *
 * The whole content skeleton is handed to `redactDeep` in ONE call, so the guard's FULL capability
 * (numeric key-context, array threading, key-collision handling, hardened cycle-aware traversal)
 * applies to all content with zero degrade while the out-of-band `AuditForensicRef` markers survive
 * it by reference. A benign payload round-trips byte-identically (structure + key order preserved).
 */
function redactAuditDetails(details: Record<string, unknown>): Record<string, unknown> {
  // Pass 1 — structural cut walk: forensic subtrees → AuditForensicRef; secret values → marker;
  // content strings → phone pre-pass (US + intl) so `+`-E.164 never reaches the card detector.
  const skeleton = buildContentSkeleton(details);

  // Pass 2 — PII-by-value redaction over the whole content skeleton via the shared guard. The
  // out-of-band markers (Date subclass) and the secret marker survive unchanged.
  const redactedSkeleton = auditPiiGuard.redactDeep(skeleton).value;

  // Pass 3 — finalize: restore each forensic marker (by identity) with its original subtree run
  // through the identifier-leaf; apply the content-leaf to every remaining content string.
  return finalizeRedactedSkeleton(redactedSkeleton) as Record<string, unknown>;
}

// ─── Adapter ───

/**
 * Convert a legacy `FridayAuditLogWrite` entry to the enriched `FridayAuditRecord`.
 *
 * SEC-EVENT-REDACTION-001: the caller `details` content is redacted (PII-by-value + secret
 * shapes) here — the single choke point feeding BOTH the SQLite `details_json` column and the
 * `audit.jsonl` mirror. Canonical columns are copied through verbatim.
 */
function toAuditRecord(entry: FridayAuditLogWrite): FridayAuditRecord {
  return buildFridayAuditRecordBase({
    id: entry.id,
    ts: entry.ts,
    actorType: entry.actorType,
    actorId: entry.actorId,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    requestId: entry.requestId,
    traceId: entry.traceId,
    details: entry.details === undefined ? undefined : redactAuditDetails(entry.details),
    result: entry.result,
    errorCode: entry.errorCode,
    errorMessage: entry.errorMessage,
    caller: entry.caller,
  });
}

function resolveFridayAuditSqlitePath(filePath: string): string | null {
  const auditDir = path.dirname(filePath);
  if (path.basename(filePath) !== "audit.jsonl" || path.basename(auditDir) !== ".friday") {
    return null;
  }
  return path.join(path.dirname(auditDir), "friday.db");
}

async function appendFridayAuditSqliteMirror(
  filePath: string,
  record: FridayAuditRecord,
): Promise<void> {
  const sqlitePath = resolveFridayAuditSqlitePath(filePath);
  if (!sqlitePath || !existsSync(sqlitePath)) {
    return;
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(sqlitePath);
    db.pragma("busy_timeout = 1000");
    db.prepare(
      `INSERT OR IGNORE INTO audit_logs
       (id, ts, actor_type, actor_id, action, resource_type, resource_id, request_id, trace_id, ip, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.id,
      record.ts,
      record.actorType,
      record.actorId ?? null,
      record.action,
      record.resourceType,
      record.resourceId ?? null,
      record.requestId ?? null,
      record.traceId ?? null,
      record.ip ?? null,
      record.details ? JSON.stringify(record.details) : null,
    );
  } catch (err) {
    console.warn("[friday][audit-log] sqlite mirror failed:", err instanceof Error ? err.message : String(err));
  } finally {
    db?.close();
  }
}

// ─── Writer (legacy compatibility wrapper) ───

/**
 * Append an audit log entry as a JSONL line.
 *
 * Delegates to the hardened security audit writer with forensic metadata
 * and secure file permissions.
 */
export async function appendFridayAuditLog(
  filePath: string,
  entry: FridayAuditLogWrite,
  options?: FridayAuditLogWriterOptions,
): Promise<void> {
  const record = toAuditRecord(entry);
  const securityOptions: SecurityWriterOptions | undefined = options
    ? { maxBytes: options.maxBytes, keepLines: options.keepLines }
    : undefined;
  await appendSecurityAuditLog(filePath, record, securityOptions);
  await appendFridayAuditSqliteMirror(filePath, record);
}
