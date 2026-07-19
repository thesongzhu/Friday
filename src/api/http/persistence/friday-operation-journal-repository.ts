/**
 * DUR-OPERATION-JOURNAL-001 — durable HTTP idempotency / operation journal store.
 *
 * The generic non-GET idempotency guard in friday-http-server.ts used to keep
 * reservations + completed replay responses in a volatile in-memory `Map`. On a
 * process crash/restart the Map was gone, so a retry with the same
 * `Idempotency-Key` missed and the handler RE-EXECUTED, DUPLICATING the durable
 * side-effect the handler had already committed.
 *
 * This module defines a small store interface that mirrors the exact Map usage the
 * server had, plus two implementations:
 *
 *  - {@link FridayInMemoryOperationJournalStore}: byte-for-byte the previous Map
 *    behavior. Used as the default when no db-backed store is injected (keeps every
 *    test that builds a server without a db working unchanged).
 *  - {@link FridaySqliteOperationJournalStore}: durable, backed by the
 *    `http_operation_journal` table (migration v100). Survives restarts, and its
 *    `reserve` is a single atomic INSERT so a cross-process race cannot double-reserve.
 *
 * The store key is the joined identity `${principalId}:${operationId}:${idempotencyKey}`
 * (exactly as the server built it). The durable table stores those three parts as a
 * composite primary key; get()/release() match rows by the reconstructed joined key.
 */

import type Database from "better-sqlite3";

import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import { throwIdempotencyConflict } from "../routes/friday-route-idempotency.js";

/** A single idempotency journal entry — mirrors the previous in-memory Map entry. */
export interface FridayHttpIdempotencyEntry {
  operationId: string;
  principalId: string;
  payloadHash: string;
  /**
   * "in_flight" = a request with this key is currently executing (reservation set
   * before the handler runs). "completed" = the handler finished and `responseJson`
   * holds the replayable response bytes. "indeterminate" = a reservation orphaned by a
   * crash: the handler may have committed its side-effect but never wrote its completed
   * receipt, so the outcome is unknown — fail-closed, never auto-retried, never TTL-pruned.
   */
  status: "in_flight" | "completed" | "indeterminate";
  /**
   * The RAW, already-serialized replay JSON string exactly as stored in the
   * `response_json` column — never a re-serialized object. `undefined` for
   * in_flight/indeterminate rows (no replayable body). The server splices this string
   * verbatim into the replay envelope; it is NEVER JSON.parse'd + re-JSON.stringify'd,
   * so a polluted `Object.prototype.toJSON` cannot make the served/inspected bytes
   * diverge from what is persisted at rest.
   */
  responseJson: string | undefined;
  expiresAtMs: number;
}

export interface FridayHttpIdempotencyReserveInput {
  operationId: string;
  principalId: string;
  payloadHash: string;
  expiresAtMs: number;
}

export interface FridayHttpIdempotencyCompleteInput {
  operationId: string;
  principalId: string;
  payloadHash: string;
  /**
   * The EXACT, already-serialized replay JSON string to persist verbatim into
   * `response_json`. The server serializes the handler result to a string exactly once
   * and passes that string here — completion NEVER re-serializes a result-derived object.
   */
  responseJson: string;
  expiresAtMs: number;
}

/**
 * Idempotency store used by the HTTP server's generic non-GET idempotency guard.
 * All methods are SYNC (better-sqlite3 is synchronous), so the server keeps its
 * existing straight-line control flow with no async refactor.
 */
export interface FridayHttpIdempotencyStore {
  /** Look up an entry by the joined store key, or `undefined` when absent. */
  get(key: string): FridayHttpIdempotencyEntry | undefined;
  /**
   * Reserve an `in_flight` entry BEFORE running the handler. The durable
   * implementation is atomic (single INSERT): if a concurrent process already
   * reserved/completed the same key, a pre-existing row with a DIFFERENT payload
   * digest surfaces as a typed 409 conflict, and a matching in-progress reservation
   * surfaces as a retryable 409 — never a silent overwrite that could double-execute.
   */
  reserve(key: string, input: FridayHttpIdempotencyReserveInput): void;
  /** Upgrade the reservation to a `completed`, replayable entry. */
  complete(key: string, input: FridayHttpIdempotencyCompleteInput): void;
  /** Drop the entry for this key (release an unfinished reservation). */
  release(key: string): void;
  /**
   * Mark an in_flight reservation indeterminate WITHOUT deleting it — used when a
   * side-effect committed but the completed receipt write failed, so a retry is refused
   * (fail-closed) rather than re-executing.
   */
  markIndeterminate(key: string): void;
  /**
   * Prune expired entries. ONLY `completed` replay entries are pruned — an `in_flight`
   * or `indeterminate` reservation is NEVER TTL-deleted, because deleting it would let a
   * retry miss the journal and re-execute a possibly-committed side-effect.
   */
  pruneExpired(nowMs: number): void;
  /**
   * Reconcile reservations orphaned by a crash. Called once at process boot, BEFORE the
   * server accepts requests: a freshly-booted process has zero live in-flight requests, so
   * any `in_flight` row is the residue of a crash between side-effect commit and the
   * completed receipt. Such rows are marked `indeterminate` (fail-closed) rather than
   * released, so a retry is refused instead of re-executing.
   */
  reconcileOrphanedReservations(): void;
}

// ─── In-memory implementation (default; byte-for-byte the previous behavior) ───

export class FridayInMemoryOperationJournalStore implements FridayHttpIdempotencyStore {
  private readonly entries = new Map<string, FridayHttpIdempotencyEntry>();

  get(key: string): FridayHttpIdempotencyEntry | undefined {
    return this.entries.get(key);
  }

  reserve(key: string, input: FridayHttpIdempotencyReserveInput): void {
    this.entries.set(key, {
      operationId: input.operationId,
      principalId: input.principalId,
      payloadHash: input.payloadHash,
      status: "in_flight",
      responseJson: undefined,
      expiresAtMs: input.expiresAtMs,
    });
  }

  complete(key: string, input: FridayHttpIdempotencyCompleteInput): void {
    this.entries.set(key, {
      operationId: input.operationId,
      principalId: input.principalId,
      payloadHash: input.payloadHash,
      status: "completed",
      // Store the already-serialized replay string VERBATIM — never a re-serialized object.
      responseJson: input.responseJson,
      expiresAtMs: input.expiresAtMs,
    });
  }

  release(key: string): void {
    this.entries.delete(key);
  }

  markIndeterminate(key: string): void {
    // Fail-closed transition for the effect-committed-but-receipt-write-failed case: keep the
    // reservation row and flip it to indeterminate so a retry is refused, never re-executed. No-op
    // if the entry is absent or is no longer in_flight (a completed receipt wins).
    const entry = this.entries.get(key);
    if (entry && entry.status === "in_flight") {
      entry.status = "indeterminate";
    }
  }

  pruneExpired(nowMs: number): void {
    // Only prune completed replay entries — never a reservation, matching the durable
    // store's fail-closed contract.
    for (const [key, entry] of this.entries.entries()) {
      if (entry.status === "completed" && entry.expiresAtMs <= nowMs) {
        this.entries.delete(key);
      }
    }
  }

  reconcileOrphanedReservations(): void {
    // No-op: a volatile in-memory store starts empty on every boot, so there are no
    // durable orphaned reservations to reconcile.
  }
}

// ─── Durable SQLite implementation ───

interface OperationJournalRow {
  principal_id: string;
  operation_id: string;
  idempotency_key: string;
  payload_digest: string;
  status: "in_flight" | "completed" | "indeterminate";
  response_json: string | null;
  expires_at_ms: number;
  created_at_ms: number;
}

/**
 * Recover the `idempotency_key` PK component from the joined store key. The joined
 * key is exactly `${principalId}:${operationId}:${idempotencyKey}`, so stripping the
 * `${principalId}:${operationId}:` prefix by LENGTH is exact even when the principal
 * or operation id themselves contain ':'.
 */
function idempotencyKeyFromStoreKey(key: string, principalId: string, operationId: string): string {
  return key.slice(principalId.length + operationId.length + 2);
}

function isPrimaryKeyConflict(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return (
    code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    code === "SQLITE_CONSTRAINT"
  );
}

export class FridaySqliteOperationJournalStore implements FridayHttpIdempotencyStore {
  constructor(private readonly sqlite: FridaySqliteLayer) {}

  private rowToEntry(row: OperationJournalRow): FridayHttpIdempotencyEntry {
    return {
      operationId: row.operation_id,
      principalId: row.principal_id,
      payloadHash: row.payload_digest,
      status: row.status,
      // The RAW stored string — never JSON.parse'd back into an object. The server splices
      // it verbatim into the replay envelope, so a polluted Object.prototype.toJSON cannot
      // re-serialize it into different (secret-bearing) bytes on the replay path.
      responseJson: row.response_json ?? undefined,
      expiresAtMs: row.expires_at_ms,
    };
  }

  private readByJoinedKey(db: Database.Database, key: string): OperationJournalRow | undefined {
    return db
      .prepare(
        `SELECT principal_id, operation_id, idempotency_key, payload_digest, status,
                response_json, expires_at_ms, created_at_ms
           FROM http_operation_journal
          WHERE (principal_id || ':' || operation_id || ':' || idempotency_key) = ?`,
      )
      .get(key) as OperationJournalRow | undefined;
  }

  get(key: string): FridayHttpIdempotencyEntry | undefined {
    const row = this.sqlite.withReadConnection((db) => this.readByJoinedKey(db, key));
    return row ? this.rowToEntry(row) : undefined;
  }

  reserve(key: string, input: FridayHttpIdempotencyReserveInput): void {
    const idempotencyKey = idempotencyKeyFromStoreKey(key, input.principalId, input.operationId);
    const nowMs = Date.now();
    try {
      // Single atomic INSERT: a concurrent process holding the same key makes this
      // throw a PRIMARY KEY conflict rather than silently overwriting.
      this.sqlite.withWriteTransaction((db) => {
        db.prepare(
          `INSERT INTO http_operation_journal (
             principal_id, operation_id, idempotency_key, payload_digest, status,
             response_json, expires_at_ms, created_at_ms
           ) VALUES (?, ?, ?, ?, 'in_flight', NULL, ?, ?)`,
        ).run(
          input.principalId,
          input.operationId,
          idempotencyKey,
          input.payloadHash,
          input.expiresAtMs,
          nowMs,
        );
      });
    } catch (err) {
      if (!isPrimaryKeyConflict(err)) {
        throw err;
      }
      // A concurrent request won the reservation between our get() and this reserve().
      const existing = this.get(key);
      if (existing) {
        if (existing.status === "indeterminate") {
          // A crash-orphaned reservation: fail closed, non-retryable, never re-execute.
          throw new FridayDomainError(
            "SECURITY_IDEMPOTENCY_INDETERMINATE",
            "a prior request with this Idempotency-Key did not complete; its outcome is indeterminate and will not be auto-retried.",
            { httpStatus: 409, retryable: false },
          );
        }
        if (existing.payloadHash !== input.payloadHash || existing.operationId !== input.operationId) {
          throwIdempotencyConflict(idempotencyKey, input.operationId);
        }
        // Same-payload concurrent reservation/replay: surface a retryable 409 so the
        // caller retries and resolves against the winner's entry — never double-execute.
        throw new FridayDomainError(
          "SECURITY_IDEMPOTENCY_IN_PROGRESS",
          `Idempotency-Key '${idempotencyKey}' is already being processed for operation '${input.operationId}'.`,
          { httpStatus: 409, retryable: true },
        );
      }
      throw err;
    }
  }

  complete(key: string, input: FridayHttpIdempotencyCompleteInput): void {
    const idempotencyKey = idempotencyKeyFromStoreKey(key, input.principalId, input.operationId);
    // Persist the caller's already-serialized replay bytes VERBATIM. We do NOT re-serialize any
    // result-derived object here: the server serialized the result to a string exactly once and
    // passed it as `input.responseJson`, so a stateful/polluted `toJSON` cannot make the persisted
    // bytes diverge from the bytes the server inspected for secrets.
    const responseJson = input.responseJson;
    const nowMs = Date.now();
    this.sqlite.withWriteTransaction((db) => {
      // Upsert on the composite PK: normally the in_flight reservation exists and is
      // upgraded; if it was pruned the completed entry is still recorded.
      db.prepare(
        `INSERT INTO http_operation_journal (
           principal_id, operation_id, idempotency_key, payload_digest, status,
           response_json, expires_at_ms, created_at_ms
         ) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)
         ON CONFLICT (principal_id, operation_id, idempotency_key) DO UPDATE SET
           payload_digest = excluded.payload_digest,
           status = 'completed',
           response_json = excluded.response_json,
           expires_at_ms = excluded.expires_at_ms`,
      ).run(
        input.principalId,
        input.operationId,
        idempotencyKey,
        input.payloadHash,
        responseJson,
        input.expiresAtMs,
        nowMs,
      );
    });
  }

  release(key: string): void {
    this.sqlite.withWriteTransaction((db) => {
      db.prepare(
        `DELETE FROM http_operation_journal
          WHERE (principal_id || ':' || operation_id || ':' || idempotency_key) = ?`,
      ).run(key);
    });
  }

  markIndeterminate(key: string): void {
    // Fail-closed transition for the effect-committed-but-receipt-write-failed case: the
    // reservation row is KEPT (never DELETEd) and flipped to indeterminate so a retry with the same
    // key is refused rather than re-executing the already-committed side-effect. Scoped to
    // status='in_flight' so a concurrently-written completed receipt is never clobbered.
    this.sqlite.withWriteTransaction((db) => {
      db.prepare(
        `UPDATE http_operation_journal SET status = 'indeterminate'
          WHERE (principal_id || ':' || operation_id || ':' || idempotency_key) = ?
            AND status = 'in_flight'`,
      ).run(key);
    });
  }

  pruneExpired(nowMs: number): void {
    // Only completed replay entries are TTL-pruned. An in_flight/indeterminate reservation is
    // NEVER deleted here: dropping it would let a retry miss the journal and re-execute a
    // possibly-committed side-effect.
    this.sqlite.withWriteTransaction((db) => {
      db.prepare(
        "DELETE FROM http_operation_journal WHERE status = 'completed' AND expires_at_ms <= ?",
      ).run(nowMs);
    });
  }

  reconcileOrphanedReservations(): void {
    // Boot-time reconciliation: any in_flight row in a freshly-booted process is orphaned by
    // a crash (no request is live yet). Mark them indeterminate so a retry is refused rather
    // than re-executing a side-effect that may already have committed.
    this.sqlite.withWriteTransaction((db) => {
      db.prepare(
        "UPDATE http_operation_journal SET status = 'indeterminate' WHERE status = 'in_flight'",
      ).run();
    });
  }
}
