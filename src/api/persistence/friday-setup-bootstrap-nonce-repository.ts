import type Database from "better-sqlite3";

// ─── Row type ───

export interface FridaySetupBootstrapNonceRow {
  id: string;
  nonce_hash: string;
  kind: string;
  hub_id: string;
  install_id: string;
  os_user: string;
  origin: string;
  action: string;
  device_id: string | null;
  device_public_key: string | null;
  device_public_key_hash: string | null;
  claimed_user_id: string | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

// ─── Insert / consume inputs ───

export interface InsertFridaySetupBootstrapNonceInput {
  id: string;
  nonceHash: string;
  kind: "install_owner_claim";
  hubId: string;
  installId: string;
  osUser: string;
  origin: string;
  action: string;
  createdAt: string;
  expiresAt: string;
}

export interface ConsumeFridaySetupBootstrapNonceInput {
  nonceHash: string;
  kind: "install_owner_claim";
  /** Origin the claim is presented from; MUST equal the bound issue origin. */
  origin: string;
  /** Wall-clock ISO used for the `expires_at > now` freshness gate. */
  nowIso: string;
  /** Device public key (opaque, caller-supplied) recorded on the winning row. */
  devicePublicKey: string;
  /** Deterministic hash of the device public key. */
  devicePublicKeyHash: string;
  /** Device identifier bound to the claim. */
  deviceId: string;
  /** Owner user id being claimed (e.g. admin-001). */
  claimedUserId: string;
}

// ─── Sweep (reaper / TTL) inputs ───

export interface SweepFridaySetupBootstrapNoncesInput {
  /**
   * Wall-clock ISO (Z, lexicographically comparable to `expires_at`). Rows that
   * are UNCONSUMED and whose `expires_at <= nowIso` are permanently unusable —
   * the consume CAS requires `expires_at > now` — so they are dead weight and
   * are reaped. This bounds the local table growth a loopback caller could cause
   * by minting unbounded challenge nonces (OBS-2).
   */
  nowIso: string;
  /**
   * ISO cutoff (Z) for CONSUMED rows: a consumed nonce whose `consumed_at` is
   * strictly older than this is past its retention horizon and is reaped. The
   * authoritative owner<->device binding lives durably on `users.password_hash`
   * (the device-owner sentinel), so aging out the consumed nonce row does NOT
   * relax the single-owner invariant — the owner CAS (`password_hash IS NULL`)
   * plus the fact a deleted row yields `changes = 0` on any consume both keep a
   * replayed claim closed. The row is retained for a generous horizon (audit +
   * defence-in-depth belt) before reclamation.
   */
  consumedRetentionCutoffIso: string;
  /**
   * Max rows deleted PER class (expired-unconsumed / consumed-retired) per sweep
   * pass. Bounds the work so the sweep itself cannot be turned into a long lock;
   * a backlog drains across successive scheduled passes.
   */
  batchLimit: number;
}

export interface SweepFridaySetupBootstrapNoncesResult {
  /** Expired UNCONSUMED nonce rows deleted this pass. */
  deletedExpiredUnconsumed: number;
  /** CONSUMED nonce rows past the retention horizon deleted this pass. */
  deletedConsumedRetired: number;
}

// ─── Repository interface ───

export interface FridaySetupBootstrapNonceRepository {
  insertNonce(db: Database.Database, input: InsertFridaySetupBootstrapNonceInput): void;
  findByHash(db: Database.Database, nonceHash: string): FridaySetupBootstrapNonceRow | null;
  findById(db: Database.Database, id: string): FridaySetupBootstrapNonceRow | null;
  /**
   * Bounded reaper for the install-nonce ledger. Deletes (a) expired UNCONSUMED
   * nonces (past `expires_at`) and (b) CONSUMED nonces past a retention horizon.
   * Each class is capped at `batchLimit` rows via a subquery LIMIT (better-sqlite3
   * is not compiled with `DELETE ... LIMIT`). ADDITIVE / no-degrade: it only
   * removes rows that are already unusable (expired) or authoritative-elsewhere
   * (consumed → binding held on `users.password_hash`); it never touches a LIVE
   * unconsumed-unexpired nonce nor the owner slot. Returns per-class delete counts.
   */
  sweepExpiredAndRetired(
    db: Database.Database,
    input: SweepFridaySetupBootstrapNoncesInput,
  ): SweepFridaySetupBootstrapNoncesResult;
  /**
   * Single-use compare-and-consume of an owner-claim nonce.
   *
   * The `WHERE consumed_at IS NULL AND expires_at > :now AND origin = :origin`
   * predicate is the atomic replay/expiry/cross-origin gate: a consumed, expired,
   * or origin-mismatched nonce yields `changes = 0`. On success it stamps the
   * winning device binding + claimed user id onto the row so the surviving
   * consumed row is the durable owner<->device binding record.
   *
   * Returns the number of affected rows (1 = won, 0 = replay/expired/mismatch).
   */
  consumeOwnerClaimNonce(
    db: Database.Database,
    input: ConsumeFridaySetupBootstrapNonceInput,
  ): number;
}

// ─── Factory ───

export function createFridaySetupBootstrapNonceRepository(): FridaySetupBootstrapNonceRepository {
  return {
    insertNonce(db, input) {
      db.prepare(
        `INSERT INTO friday_setup_bootstrap_nonces (
           id, nonce_hash, kind, hub_id, install_id, os_user, origin, action,
           device_id, device_public_key, device_public_key_hash, claimed_user_id,
           created_at, expires_at, consumed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
      ).run(
        input.id,
        input.nonceHash,
        input.kind,
        input.hubId,
        input.installId,
        input.osUser,
        input.origin,
        input.action,
        input.createdAt,
        input.expiresAt,
      );
    },

    findByHash(db, nonceHash) {
      return (
        (db
          .prepare("SELECT * FROM friday_setup_bootstrap_nonces WHERE nonce_hash = ?")
          .get(nonceHash) as FridaySetupBootstrapNonceRow | undefined) ?? null
      );
    },

    findById(db, id) {
      return (
        (db
          .prepare("SELECT * FROM friday_setup_bootstrap_nonces WHERE id = ?")
          .get(id) as FridaySetupBootstrapNonceRow | undefined) ?? null
      );
    },

    sweepExpiredAndRetired(db, input) {
      const limit = Math.max(0, Math.floor(input.batchLimit));
      if (limit === 0) {
        return { deletedExpiredUnconsumed: 0, deletedConsumedRetired: 0 };
      }

      // (a) Expired UNCONSUMED nonces. These are the OBS-2 growth vector: a
      // loopback caller can mint unbounded challenge rows, each unusable once
      // `expires_at` passes. The subquery LIMIT bounds a single pass; the
      // idx on (expires_at, consumed_at) serves the predicate + ORDER BY.
      const deletedExpiredUnconsumed = db
        .prepare(
          `DELETE FROM friday_setup_bootstrap_nonces
             WHERE id IN (
               SELECT id FROM friday_setup_bootstrap_nonces
                WHERE consumed_at IS NULL
                  AND expires_at <= :nowIso
                ORDER BY expires_at ASC
                LIMIT :limit
             )`,
        )
        .run({ nowIso: input.nowIso, limit }).changes;

      // (b) CONSUMED nonces past the retention horizon. The authoritative owner
      // binding is on `users.password_hash`; the consumed nonce row is an audit
      // + defence-in-depth record we keep for a generous window, then reclaim.
      const deletedConsumedRetired = db
        .prepare(
          `DELETE FROM friday_setup_bootstrap_nonces
             WHERE id IN (
               SELECT id FROM friday_setup_bootstrap_nonces
                WHERE consumed_at IS NOT NULL
                  AND consumed_at < :cutoff
                ORDER BY consumed_at ASC
                LIMIT :limit
             )`,
        )
        .run({ cutoff: input.consumedRetentionCutoffIso, limit }).changes;

      return { deletedExpiredUnconsumed, deletedConsumedRetired };
    },

    consumeOwnerClaimNonce(db, input) {
      const res = db
        .prepare(
          `UPDATE friday_setup_bootstrap_nonces
              SET consumed_at = :nowIso,
                  device_public_key = :devicePublicKey,
                  device_public_key_hash = :devicePublicKeyHash,
                  device_id = :deviceId,
                  claimed_user_id = :claimedUserId
            WHERE nonce_hash = :nonceHash
              AND kind = :kind
              AND origin = :origin
              AND consumed_at IS NULL
              AND expires_at > :nowIso`,
        )
        .run({
          nowIso: input.nowIso,
          devicePublicKey: input.devicePublicKey,
          devicePublicKeyHash: input.devicePublicKeyHash,
          deviceId: input.deviceId,
          claimedUserId: input.claimedUserId,
          nonceHash: input.nonceHash,
          kind: input.kind,
          origin: input.origin,
        });
      return res.changes;
    },
  };
}
