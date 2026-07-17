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
 * shapes, so a secret-shape pass is layered on top (see `redactSecretShapes`).
 */
const auditPiiGuard = createFridayMemoryPiiGuard("redact");

const AUDIT_SECRET_MARKER = "[REDACTED_SECRET]";

/**
 * Secret-shape redaction layered on top of the PII-by-value guard. Every shape here is
 * distinctive enough that it can never match a benign forensic identifier (UUID, numeric id,
 * SHA-256 hash), so it is safe to apply even to preserved identifier fields — it strips a leaked
 * credential without corrupting a business id.
 */
function redactSecretShapes(input: string): string {
  return input
    // PEM private-key blocks (RSA / EC / OPENSSH / generic).
    .replace(
      /-----BEGIN(?:[A-Z0-9 ]+)?PRIVATE KEY-----[\s\S]*?-----END(?:[A-Z0-9 ]+)?PRIVATE KEY-----/g,
      AUDIT_SECRET_MARKER,
    )
    // JWT (three base64url segments; the first two are `{"...` → begin with `eyJ`).
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, AUDIT_SECRET_MARKER)
    // OpenAI-style keys (`sk-` / `sk-proj-`).
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, AUDIT_SECRET_MARKER)
    // GitHub tokens (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` and legacy `gh_`).
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, AUDIT_SECRET_MARKER)
    .replace(/\bgh_[A-Za-z0-9]{20,}\b/g, AUDIT_SECRET_MARKER)
    // Bearer credentials — keep the scheme word, redact the token.
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${AUDIT_SECRET_MARKER}`);
}

/**
 * Residual E.164 / country-code US phone completion, layered ONLY on CONTENT strings (never on
 * preserved identifier fields). The shared guard's US-phone detector matches the bare 10-digit
 * and separator forms but NOT the `+1XXXXXXXXXX` / `1XXXXXXXXXX` country-code forms — which is
 * exactly how the live channel `chatId` arrives (Signal `sourceNumber` is E.164 `+1…`; WhatsApp
 * `msg.from` is `1…`). Without this, the headline chatId phone would survive redaction. The
 * pattern requires the leading `1` country code and is digit-run-bounded (`(?<![\w+])` … `(?!\d)`)
 * so it never fires on a benign national-format id, an epoch timestamp, or a longer numeric id.
 * The national-format and full-width forms remain the shared guard's responsibility.
 */
function redactResidualUsPhone(input: string): string {
  return input.replace(
    /(?<![\w+])\+?1[-.\s]?\(?[2-9]\d{2}\)?[-.\s]?[2-9]\d{2}[-.\s]?\d{4}(?!\d)/g,
    "[PHONE_US]",
  );
}

/**
 * Preserved-identifier leaf pass: secret shapes + residual country-code (E.164) US phone.
 *
 * Forensic identifier fields are preserved (they skip the `redactDeep` PII-by-value pass) so that
 * distinct correlation / trace / run ids stay distinct and a benign national-format numeric id is
 * never collapsed. But the LIVE channel caller builds `correlationId` / `channelCorrelationId` /
 * (channel) `idempotencyKey` as `channel:<kind>:<chatId>:<msg.id>`, where `chatId` IS the user's
 * phone for Signal/WhatsApp (Signal E.164 `+1…`, WhatsApp bare `1…`). Without a phone pass those
 * ids would persist the phone CLEAR — the same phone we already redact in the `chatId` /
 * `sessionKey` content fields in the SAME record (the #1618 over-exemption class). The residual
 * pass strips exactly the leading-country-code phone segment while the `channel:<kind>:` routing
 * prefix and the trailing message id survive; because it REQUIRES the leading `1` country code
 * (and is digit-run-bounded), a benign national-format id like `2015550123` — or any opaque
 * `run-…` / `wamid.…` / UUID id — is left intact, so distinct ids are not collapsed or corrupted.
 * (The bare national / full-width phone forms remain the CONTENT-path `redactDeep` responsibility
 * and are deliberately NOT applied to preserved identifiers, to avoid false-positive collapse.)
 */
function redactIdentifierLeaf(input: string): string {
  return redactResidualUsPhone(redactSecretShapes(input));
}

/** Secret shapes + residual E.164 phone — applied to CONTENT fields (after `redactDeep`). */
function redactContentLeaf(input: string): string {
  return redactResidualUsPhone(redactSecretShapes(input));
}

/**
 * Deeply map every string leaf of `value` through `fn`, preserving structure, key order,
 * numbers, booleans, null and `Date` instances. Iterative + cycle-aware (a back-edge to a node
 * still on the DFS path becomes a structural share) so arbitrarily deep or self-referential
 * input neither overflows the call stack nor loops forever. Objects are rebuilt via own
 * data-property definition so a JSON-originated `__proto__` key cannot poison the prototype.
 */
function mapStringsDeep(value: unknown, fn: (s: string) => string): unknown {
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
 * Redact the caller `details` payload before persistence. Field-role aware:
 *   - forensic identifier fields (allowlist)  → PRESERVED (secret-shape pass only), so distinct
 *     ids are never collapsed and benign business ids are never corrupted;
 *   - every other CONTENT field               → PII-by-value redaction via the shared guard's
 *     `redactDeep`, followed by the secret-shape pass.
 * Content keys are collected into ONE sub-object before `redactDeep` so the guard's key-context
 * numeric logic (a numeric value under a `phone`/`ssn`/`card` key) is retained; the result is
 * reassembled in ORIGINAL key order so a benign payload round-trips byte-identically.
 */
function redactAuditDetails(details: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(details);

  const contentInput: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (!isForensicIdentifierKey(key)) {
      contentInput[key] = value;
    }
  }
  const redactedContent = auditPiiGuard.redactDeep(contentInput).value as Record<string, unknown>;

  const out: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (isForensicIdentifierKey(key)) {
      out[key] = mapStringsDeep(value, redactIdentifierLeaf);
      continue;
    }
    // Content field-name keys are never PII, so `redactDeep` does not rename them; the fallback
    // re-redacts the value standalone only in the (unexpected) event a content key was itself PII.
    const contentValue = Object.prototype.hasOwnProperty.call(redactedContent, key)
      ? redactedContent[key]
      : auditPiiGuard.redactDeep(value).value;
    out[key] = mapStringsDeep(contentValue, redactContentLeaf);
  }
  return out;
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
