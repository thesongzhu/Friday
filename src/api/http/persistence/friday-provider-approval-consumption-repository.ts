/**
 * SEC-APPROVAL-AUTHORITY-001 · CORE-A round-3 Lane B (Advisor round-2 finding #3) —
 * durable single-use ledger for canonical mutating-action approvals.
 *
 * The mutating-action gate used to track single-use in a process-local in-memory
 * `Set<string>` (`consumedCanonicalApprovalKeys`). On restart the Set was gone, so a
 * fresh process re-admitted the SAME device-authored approval (its `deviceProof` is
 * re-verified asymmetrically), letting a captured confirmed approval be replayed to
 * drive a SECOND provider mutation.
 *
 * This module defines a store interface that the gate consumes plus two implementations
 * (mirroring {@link FridayHttpIdempotencyStore}):
 *
 *  - {@link FridayInMemoryApprovalConsumptionStore}: byte-for-byte the previous Set
 *    behaviour. Default when no db-backed store is injected (keeps db-less gate/route
 *    unit tests unchanged).
 *  - {@link FridaySqliteApprovalConsumptionStore}: durable, backed by
 *    `provider_mutation_approval_consumption` (migration v108). Survives restarts, and
 *    both `reserveConsumed` and `reserveInFlight` are a single atomic INSERT so a
 *    cross-process race cannot double-reserve — exactly one wins the PRIMARY KEY.
 *
 * Two consumption shapes:
 *  - INLINE (`reserveConsumed`): the whole single-use is one atomic INSERT with
 *    status='consumed', committed in the store's OWN write transaction. Used by every
 *    gate caller whose mutation is not restructured for same-transaction atomicity.
 *  - TWO-PHASE (`reserveInFlight` → `completeConsumptionInTransaction`): the reserve is
 *    an atomic INSERT with status='in_flight' (single-use is already enforced here — a
 *    replay collides on the PK). The paired provider mutation then flips the row to
 *    'consumed' via `completeConsumptionInTransaction` INSIDE THE SAME
 *    `withWriteTransaction` as the mutation write, so a rollback unwinds BOTH the
 *    completion and the mutation (no effect without a durable consumption; a crash
 *    between reserve and completion leaves an in_flight orphan that boot reconcile marks
 *    indeterminate — fail-closed). A clean pre-commit failure calls `releaseReservation`
 *    so the owner can retry the same confirmed approval (no effect ran).
 */

import type Database from "better-sqlite3";

import type { FridaySqliteLayer } from "#state";

/** A single canonical-approval single-use reservation. */
export interface FridayApprovalConsumptionReservation {
  /**
   * The canonical approval USE KEY (`createCanonicalApprovalUseKey`):
   * approvalId:actionDigest:issuer:hmac:deviceSignature. The PRIMARY KEY — a replay of
   * the identical signed approval reproduces it exactly and so collides.
   */
  readonly useKey: string;
  readonly actionDigest: string;
  readonly idempotencyKey?: string;
  /** The mutating action consumed for (e.g. 'providers.create') — provenance only. */
  readonly mutationOperationId: string;
}

export type FridayApprovalConsumptionReserveOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "canonical_approval_already_used" };

export interface FridayApprovalConsumptionStore {
  /**
   * INLINE single-use: atomically record consumption (status='consumed') in the store's
   * OWN write transaction. Returns `{ ok: false }` when the use key was already
   * reserved/consumed (PK conflict) so the gate denies `canonical_approval_already_used`.
   */
  reserveConsumed(
    reservation: FridayApprovalConsumptionReservation,
  ): FridayApprovalConsumptionReserveOutcome;

  /**
   * TWO-PHASE single-use phase 1: atomically reserve (status='in_flight') in the store's
   * OWN write transaction, returning `{ ok: false }` on a PK conflict. Single-use is
   * already enforced here. The caller MUST then either
   * {@link completeConsumptionInTransaction} (in the SAME txn as the mutation) or, on a
   * clean pre-commit failure, {@link releaseReservation}.
   */
  reserveInFlight(
    reservation: FridayApprovalConsumptionReservation,
  ): FridayApprovalConsumptionReserveOutcome;

  /**
   * TWO-PHASE single-use phase 2 (ATOMIC): flip the in_flight reservation to 'consumed'
   * on the PROVIDED db handle, so the consume commits in the SAME write transaction as
   * the provider mutation. A rollback of that transaction unwinds BOTH.
   */
  completeConsumptionInTransaction(db: Database.Database, useKey: string): void;

  /**
   * Release an in_flight reservation after a clean pre-commit failure (no side effect
   * ran), so the owner can retry the same confirmed approval. Scoped to status='in_flight'
   * so a completed/indeterminate row is never removed.
   */
  releaseReservation(useKey: string): void;

  /** True iff a consumption row (any status) exists for the use key. */
  hasConsumption(useKey: string): boolean;

  /**
   * Boot-time reconcile: any `in_flight` row in a freshly-booted process is a crash
   * orphan (no mutation is live yet). Mark them `indeterminate` (fail-closed) so a replay
   * is refused rather than admitted. Run once before the server accepts requests.
   */
  reconcileOrphanedReservations(): void;
}

type ConsumptionStatus = "in_flight" | "consumed" | "indeterminate";

// ─── In-memory implementation (default; equivalent to the previous Set behaviour) ───

export class FridayInMemoryApprovalConsumptionStore implements FridayApprovalConsumptionStore {
  private readonly entries = new Map<string, ConsumptionStatus>();

  reserveConsumed(
    reservation: FridayApprovalConsumptionReservation,
  ): FridayApprovalConsumptionReserveOutcome {
    if (this.entries.has(reservation.useKey)) {
      return { ok: false, reason: "canonical_approval_already_used" };
    }
    this.entries.set(reservation.useKey, "consumed");
    return { ok: true };
  }

  reserveInFlight(
    reservation: FridayApprovalConsumptionReservation,
  ): FridayApprovalConsumptionReserveOutcome {
    if (this.entries.has(reservation.useKey)) {
      return { ok: false, reason: "canonical_approval_already_used" };
    }
    this.entries.set(reservation.useKey, "in_flight");
    return { ok: true };
  }

  completeConsumptionInTransaction(_db: Database.Database, useKey: string): void {
    // In-memory: mirror the durable UPDATE (scoped to an existing in_flight reservation).
    if (this.entries.get(useKey) === "in_flight") {
      this.entries.set(useKey, "consumed");
    }
  }

  releaseReservation(useKey: string): void {
    if (this.entries.get(useKey) === "in_flight") {
      this.entries.delete(useKey);
    }
  }

  hasConsumption(useKey: string): boolean {
    return this.entries.has(useKey);
  }

  reconcileOrphanedReservations(): void {
    // A volatile in-memory store starts empty on every boot, so there is nothing durable
    // to reconcile. Still flip any residual in_flight rows for parity with the durable store.
    for (const [key, status] of this.entries.entries()) {
      if (status === "in_flight") {
        this.entries.set(key, "indeterminate");
      }
    }
  }
}

// ─── Durable SQLite implementation ───

function isPrimaryKeyConflict(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return (
    code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    code === "SQLITE_CONSTRAINT"
  );
}

export class FridaySqliteApprovalConsumptionStore implements FridayApprovalConsumptionStore {
  constructor(private readonly sqlite: FridaySqliteLayer) {}

  private insert(reservation: FridayApprovalConsumptionReservation, status: ConsumptionStatus): void {
    const nowMs = Date.now();
    this.sqlite.withWriteTransaction((db) => {
      insertConsumptionRow(db, reservation, status, nowMs);
    });
  }

  private reserve(
    reservation: FridayApprovalConsumptionReservation,
    status: ConsumptionStatus,
  ): FridayApprovalConsumptionReserveOutcome {
    try {
      // Single atomic INSERT: a concurrent process (or a restart replay) holding the same
      // use key makes this throw a PRIMARY KEY conflict rather than silently overwriting.
      this.insert(reservation, status);
      return { ok: true };
    } catch (err) {
      if (isPrimaryKeyConflict(err)) {
        return { ok: false, reason: "canonical_approval_already_used" };
      }
      throw err;
    }
  }

  reserveConsumed(
    reservation: FridayApprovalConsumptionReservation,
  ): FridayApprovalConsumptionReserveOutcome {
    return this.reserve(reservation, "consumed");
  }

  reserveInFlight(
    reservation: FridayApprovalConsumptionReservation,
  ): FridayApprovalConsumptionReserveOutcome {
    return this.reserve(reservation, "in_flight");
  }

  completeConsumptionInTransaction(db: Database.Database, useKey: string): void {
    // Runs on the CALLER's db handle so it commits/rolls back with the provider mutation.
    // Scoped to status='in_flight' so a concurrently-reconciled indeterminate row is never
    // silently revived to consumed.
    db.prepare(
      `UPDATE provider_mutation_approval_consumption
          SET status = 'consumed', consumed_at_ms = ?
        WHERE use_key = ? AND status = 'in_flight'`,
    ).run(Date.now(), useKey);
  }

  releaseReservation(useKey: string): void {
    this.sqlite.withWriteTransaction((db) => {
      db.prepare(
        `DELETE FROM provider_mutation_approval_consumption
           WHERE use_key = ? AND status = 'in_flight'`,
      ).run(useKey);
    });
  }

  hasConsumption(useKey: string): boolean {
    const row = this.sqlite.withReadConnection((db) =>
      db
        .prepare("SELECT 1 AS present FROM provider_mutation_approval_consumption WHERE use_key = ?")
        .get(useKey),
    );
    return row !== undefined;
  }

  reconcileOrphanedReservations(): void {
    this.sqlite.withWriteTransaction((db) => {
      db.prepare(
        `UPDATE provider_mutation_approval_consumption
            SET status = 'indeterminate'
          WHERE status = 'in_flight'`,
      ).run();
    });
  }
}

function insertConsumptionRow(
  db: Database.Database,
  reservation: FridayApprovalConsumptionReservation,
  status: ConsumptionStatus,
  nowMs: number,
): void {
  db.prepare(
    `INSERT INTO provider_mutation_approval_consumption (
       use_key, action_digest, idempotency_key, mutation_operation_id,
       status, consumed_at_ms, created_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    reservation.useKey,
    reservation.actionDigest,
    reservation.idempotencyKey ?? null,
    reservation.mutationOperationId,
    status,
    status === "consumed" ? nowMs : null,
    nowMs,
  );
}
