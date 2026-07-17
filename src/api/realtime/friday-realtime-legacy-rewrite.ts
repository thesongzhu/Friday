/**
 * SEC-EVENT-REDACTION-001 / P0-C + SEC-REALTIME-EVENT-PII-BY-VALUE / round-6 --
 * one-time, DURABLE-PROVENANCE, bounded upgrade rewrite of legacy realtime rows into
 * the opaque-identifier namespace with CONTENT PII cleaned at rest.
 *
 * v106 adds `owner_id` (backfilled) AND `identifier_epoch` (pseudonym key version a
 * row's identifiers are opaque under; NULL = legacy/pending). A hub that upgrades
 * across the pseudonymization change still has legacy `realtime_events` rows whose
 * `stream_id` and payload identifier fields are RAW, and whose payload CONTENT fields
 * (message/note/etc.) may carry PII. Post-upgrade writers persist OPAQUE stream ids +
 * redacted payloads and readers resolve client raw ids to OPAQUE, so those legacy raw
 * rows would be (a) unreadable via the new read path (pre-upgrade history silently
 * lost), (b) raw sensitive identifier bytes at rest, and (c) raw CONTENT PII at rest.
 * This rewrite closes all three: for each PENDING row it re-keys the `stream_id`
 * id-part + payload identifier VALUES with the SAME active pseudonymizer the runtime
 * uses, then applies the canonical CONTENT redactor (the SAME two-pass transform the
 * live sink applies), IN PLACE, preserving `seq`, and stamps `identifier_epoch` in the
 * SAME transaction so the row is a DURABLE "already converted" state fact.
 *
 * Runs at api-runtime construction (has db + the master-key-derived pseudonymizer in
 * scope). Synchronous + complete-before-serve, so reads never observe a mixed
 * raw/opaque history.
 *
 * IDEMPOTENT + CRASH-RESUMABLE (round-6 P1-3): "already rewritten" is the durable
 * `identifier_epoch IS NOT NULL` state, NOT a regex over the value shape. A legacy RAW
 * id that merely LOOKS opaque (`run:o1_<40hex>`) is still `identifier_epoch IS NULL`
 * and IS converted exactly once; a crash mid-rewrite leaves later rows NULL and the
 * next boot resumes them without double-processing the finished ones.
 *
 * BOUNDED (round-6 P1-4): never `.all()` the whole table. Rows are converted in
 * bounded batches selected by the partial index `idx_realtime_events_pending_rewrite`
 * (WHERE identifier_epoch IS NULL), so memory stays O(batch) regardless of corpus
 * size, and once every row is stamped the next boot's probe is an empty index seek
 * (no full scan).
 *
 * @module api/realtime
 */

import type { FridaySqliteLayer } from "#state";
import { safeJsonParse } from "#utilities";
import type { FridayRealtimePseudonymizer } from "./friday-realtime-pseudonym.js";
import { FRIDAY_REALTIME_PSEUDONYM_KEY_VERSION } from "./friday-realtime-pseudonym.js";
import { pseudonymizeEventIdentifiers, redactEventPayload } from "./friday-event-payload-redactor.js";

interface LegacyRealtimeRow {
  event_id: string;
  stream_id: string;
  payload_json: string;
  correlation_id: string | null;
}

/** Default rewrite batch size (rows loaded per SELECT — bounds memory, not time). */
const DEFAULT_REWRITE_BATCH_SIZE = 500;

/**
 * SEC-REALTIME-EVENT-PII-BY-VALUE / round-7 F3 — fail-closed placeholder for a legacy
 * payload whose bytes CANNOT be safely transformed (unparseable JSON, or a transform /
 * serialization that throws). Stamping `identifier_epoch` while preserving such bytes
 * would brand raw sensitive content as "clean" and permanently skip the row. Replacing
 * ALL bytes with this valid-JSON placeholder guarantees NO raw canary can remain under
 * clean provenance, and it parses back to a non-null object so the read path
 * (`rowToEnvelope` → `safeJsonParse(...)!`) never trips on a null payload.
 */
const MALFORMED_LEGACY_PAYLOAD_PLACEHOLDER_JSON = JSON.stringify({
  _redacted: "[MALFORMED_LEGACY_PAYLOAD_REDACTED]",
});

/**
 * Transform a single legacy payload for the rewrite. FAIL-CLOSED: on an unparseable
 * payload — or any throw from the identifier pseudonymization / content redaction /
 * serialization — return the safe placeholder so NO raw bytes survive. A valid payload
 * (including a legitimate JSON `null`) is pseudonymized then content-redacted, mirroring
 * the live sink's two-pass transform.
 */
function transformLegacyPayload(
  payloadJson: string,
  pseudonymizer: FridayRealtimePseudonymizer,
): string {
  try {
    const parsed = safeJsonParse<unknown>(payloadJson);
    // `safeJsonParse` returns `undefined` for BOTH empty input and a JSON PARSE FAILURE
    // (malformed bytes). Either way the payload cannot be structurally transformed, so
    // its raw bytes must NOT be carried forward under a stamped epoch — fail closed.
    if (parsed === undefined) return MALFORMED_LEGACY_PAYLOAD_PLACEHOLDER_JSON;
    const transformed = JSON.stringify(
      redactEventPayload(
        pseudonymizeEventIdentifiers(parsed, (raw) => pseudonymizer.value(raw)),
      ),
    );
    // `JSON.stringify` yields `undefined` only for a top-level `undefined`/function/symbol,
    // which `JSON.parse` can never produce — but guard anyway so a stamped row is always
    // valid, byte-clean JSON.
    return typeof transformed === "string" ? transformed : MALFORMED_LEGACY_PAYLOAD_PLACEHOLDER_JSON;
  } catch {
    return MALFORMED_LEGACY_PAYLOAD_PLACEHOLDER_JSON;
  }
}

export interface RewriteLegacyRealtimeIdentifiersResult {
  scanned: number;
  rewritten: number;
}

export interface RewriteLegacyRealtimeIdentifiersOptions {
  /** Rows converted per bounded batch (default {@link DEFAULT_REWRITE_BATCH_SIZE}). */
  batchSize?: number;
}

/**
 * Convert legacy `realtime_events` rows (`identifier_epoch IS NULL`) into the opaque
 * namespace using `pseudonymizer`, cleaning payload CONTENT PII, in bounded batches.
 * Fast-returns zeros when the pseudonymizer is inactive (no key -> tests /
 * unprovisioned). Idempotent, crash-resumable and — once complete — costs an empty
 * partial-index probe rather than a full-table scan.
 */
export function rewriteLegacyRealtimeIdentifiers(
  db: FridaySqliteLayer,
  pseudonymizer: FridayRealtimePseudonymizer,
  options: RewriteLegacyRealtimeIdentifiersOptions = {},
): RewriteLegacyRealtimeIdentifiersResult {
  if (!pseudonymizer.active) return { scanned: 0, rewritten: 0 };

  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_REWRITE_BATCH_SIZE);
  let scanned = 0;
  let rewritten = 0;

  for (;;) {
    // Bounded read: only pending rows, capped at batchSize (partial-index backed).
    // NEVER `.all()` the whole table — memory stays O(batchSize).
    const batch = db.withReadConnection(
      (conn) =>
        conn
          .prepare(
            "SELECT event_id, stream_id, payload_json, correlation_id FROM realtime_events WHERE identifier_epoch IS NULL ORDER BY rowid ASC LIMIT ?",
          )
          .all(batchSize) as LegacyRealtimeRow[],
    );
    if (batch.length === 0) break;
    scanned += batch.length;

    const convertedInBatch = db.withWriteTransaction((conn) => {
      // Guard `identifier_epoch IS NULL` in the UPDATE too, so a row can only be
      // converted once even under an unexpected concurrent write (durable provenance).
      const update = conn.prepare(
        "UPDATE realtime_events SET stream_id = ?, payload_json = ?, correlation_id = ?, identifier_epoch = ? WHERE event_id = ? AND identifier_epoch IS NULL",
      );
      let count = 0;
      for (const row of batch) {
        const newStreamId = pseudonymizer.streamId(row.stream_id);
        // Mirror the live sink: pseudonymize identifier VALUES, THEN redact CONTENT
        // PII/secrets. A payload whose bytes cannot be safely transformed FAILS CLOSED to
        // a placeholder (round-7 F3) — never carried raw under a stamped epoch.
        const newPayloadJson = transformLegacyPayload(row.payload_json, pseudonymizer);
        // round-7 F1: the envelope correlationId was persisted RAW into
        // `realtime_events.correlation_id` and bypassed the sink. Re-key legacy raw
        // correlation ids with the SAME deterministic pseudonym key so nothing raw
        // remains at rest and correlation semantics survive (same raw → same opaque).
        const newCorrelationId =
          row.correlation_id === null ? null : pseudonymizer.value(row.correlation_id);
        const info = update.run(
          newStreamId,
          newPayloadJson,
          newCorrelationId,
          FRIDAY_REALTIME_PSEUDONYM_KEY_VERSION,
          row.event_id,
        );
        count += info.changes;
      }
      return count;
    });

    rewritten += convertedInBatch;

    // Progress/termination: a short batch means no more pending rows. If a full batch
    // somehow converted nothing (should be impossible — every read row is NULL and the
    // UPDATE stamps it), stop rather than loop forever.
    if (batch.length < batchSize) break;
    if (convertedInBatch === 0) break;
  }

  return { scanned, rewritten };
}
