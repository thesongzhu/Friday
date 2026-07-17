/**
 * SEC-EVENT-REDACTION-001 / P0-C -- one-time upgrade rewrite of legacy realtime rows
 * into the opaque-identifier namespace.
 *
 * v106 adds `owner_id` and backfills it, but a hub that upgrades across the
 * pseudonymization change still has legacy `realtime_events` rows whose `stream_id`
 * and payload identifier fields are RAW. Post-upgrade writers persist OPAQUE stream
 * ids and readers resolve client raw ids to OPAQUE, so those legacy raw rows would be
 * (a) unreadable via the new read path (pre-upgrade history silently lost) and (b)
 * raw sensitive bytes left at rest. This rewrite closes both: it re-keys each legacy
 * row's `stream_id` id-part and payload identifier VALUES with the SAME active
 * pseudonymizer the runtime uses, IN PLACE, preserving `seq` (so a canonical owner
 * pulling with the client raw id sees legacy + new events in one continuous
 * sequence) and removing the raw legacy PII.
 *
 * Runs at api-runtime construction (has db + the master-key-derived pseudonymizer in
 * scope -- the correct layer; mirrors the existing secret read-repair rewrite). This
 * is preferred over a SQL/code migration because migrations run inside createTestDb
 * for hundreds of tests where the master key is absent; gating on the runtime
 * pseudonymizer keeps those paths untouched while covering the real upgrade.
 *
 * IDEMPOTENT: because the pseudonymizer is non-forgeable (it re-keys ANY input, incl.
 * an already-opaque one), a row must be rewritten AT MOST ONCE. Rows already in the
 * opaque namespace are detected by a shape gate (`:o<ver>_<hex>` in the stream id)
 * and skipped. The shape gate is used ONLY to avoid double-rewriting -- it is NEVER
 * an authorization decision (that is always the keyed MAC), so its shape-trust is
 * harmless here.
 *
 * @module api/realtime
 */

import type { FridaySqliteLayer } from "#state";
import { safeJsonParse } from "#utilities";
import type { FridayRealtimePseudonymizer } from "./friday-realtime-pseudonym.js";
import { pseudonymizeEventIdentifiers } from "./friday-event-payload-redactor.js";

interface LegacyRealtimeRow {
  event_id: string;
  stream_id: string;
  payload_json: string;
}

/**
 * Shape gate for IDEMPOTENCY ONLY (never authorization): true when a stream id's
 * id-part is already in the opaque namespace `o<version>_<hex>`. Such a row has
 * already been rewritten and must NOT be re-keyed (that would double-MAC it).
 */
function streamIdIsAlreadyOpaque(streamId: string): boolean {
  const colon = streamId.indexOf(":");
  const idPart = colon < 0 ? streamId : streamId.slice(colon + 1);
  return /^o\d+_[0-9a-f]{8,}$/.test(idPart);
}

export interface RewriteLegacyRealtimeIdentifiersResult {
  scanned: number;
  rewritten: number;
}

/**
 * Rewrite any legacy raw `realtime_events` rows into the opaque namespace using
 * `pseudonymizer`. No-op (returns zeros) when the pseudonymizer is inactive (no key
 * -> tests / unprovisioned), when there are no rows, or when every row is already
 * opaque -- so the steady state is a single cheap existence check per boot.
 */
export function rewriteLegacyRealtimeIdentifiers(
  db: FridaySqliteLayer,
  pseudonymizer: FridayRealtimePseudonymizer,
): RewriteLegacyRealtimeIdentifiersResult {
  if (!pseudonymizer.active) return { scanned: 0, rewritten: 0 };

  return db.withWriteTransaction((conn) => {
    // Cheap gate: is there ANY row not yet in the opaque namespace? (GLOB '*:o1_*'
    // matches an opaque stream id; NOT LIKE would miss the no-colon case, so scan
    // only when a legacy-shaped row exists.)
    const pending = conn
      .prepare("SELECT 1 FROM realtime_events WHERE stream_id NOT GLOB '*o[0-9]_*' LIMIT 1")
      .get();
    if (!pending) return { scanned: 0, rewritten: 0 };

    const rows = conn
      .prepare("SELECT event_id, stream_id, payload_json FROM realtime_events")
      .all() as LegacyRealtimeRow[];
    const update = conn.prepare(
      "UPDATE realtime_events SET stream_id = ?, payload_json = ? WHERE event_id = ?",
    );

    let rewritten = 0;
    for (const row of rows) {
      if (streamIdIsAlreadyOpaque(row.stream_id)) continue; // already rewritten
      const newStreamId = pseudonymizer.streamId(row.stream_id);
      const parsed = safeJsonParse<unknown>(row.payload_json);
      const newPayloadJson =
        parsed === undefined || parsed === null
          ? row.payload_json
          : JSON.stringify(
              pseudonymizeEventIdentifiers(parsed, (raw) => pseudonymizer.value(raw)),
            );
      update.run(newStreamId, newPayloadJson, row.event_id);
      rewritten += 1;
    }
    return { scanned: rows.length, rewritten };
  });
}
