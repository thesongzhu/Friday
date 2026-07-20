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

// ─── Nonce kinds ───

/**
 * Ledger `kind` discriminator. `install_owner_claim` is the first-boot
 * device-bound owner claim (SEC-SETUP-BOOTSTRAP-001 Slice 1). Slice 5 adds
 * `device_migration_claim` — the SECOND consumer of this same ledger, minted for
 * an AUTHENTICATED existing-passphrase-owner → device migration. CR-1 adds
 * `device_login_challenge` (v107) — the THIRD consumer, a server-issued single-use
 * nonce minted PER device-key login attempt so the login proof-of-possession is
 * NOT replayable (Advisor #1628 finding #2). The DB CHECK (v107) enforces this
 * closed set; the distinct kind keeps a nonce minted for one leg from being
 * replayed into another (the consume CAS matches on `kind`). NOTE: unlike the two
 * single-shot kinds, MANY `device_login_challenge` rows are consumed over a
 * machine's lifetime, so the single-owner partial UNIQUE(kind) belt EXCLUDES it
 * (v107) — its single-use guarantee is the per-row CAS, not that index.
 */
export type FridaySetupBootstrapNonceKind =
  | "install_owner_claim"
  | "device_migration_claim"
  | "device_login_challenge";

// ─── Insert / consume inputs ───

export interface InsertFridaySetupBootstrapNonceInput {
  id: string;
  nonceHash: string;
  kind: FridaySetupBootstrapNonceKind;
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
  kind: FridaySetupBootstrapNonceKind;
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

/**
 * SEC-SETUP-BOOTSTRAP-001 (CR-1): insert input for a `device_login_challenge`
 * nonce. UNLIKE the claim/migration challenges (whose device columns are written
 * at CONSUME time), the login challenge binds the device + key hash at ISSUE time
 * so the consume CAS can gate on them — a challenge minted for device A can never
 * be consumed by a login presenting device B (or a different key), even if the raw
 * nonce leaked. Only the nonce HASH is stored; the raw nonce is returned once.
 */
export interface InsertFridayLoginChallengeNonceInput {
  id: string;
  nonceHash: string;
  hubId: string;
  installId: string;
  osUser: string;
  origin: string;
  action: string;
  /** Device identifier the login challenge is bound to (gated at consume). */
  deviceId: string;
  /** Device public key (opaque) recorded at issue for audit. */
  devicePublicKey: string;
  /** Deterministic hash of the bound device public key (gated at consume). */
  devicePublicKeyHash: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * SEC-SETUP-BOOTSTRAP-001 (CR-1): single-use compare-and-consume input for a
 * `device_login_challenge` nonce. The CAS gates on origin + bound deviceId + bound
 * devicePublicKeyHash + single-use (consumed_at IS NULL) + freshness (expires_at >
 * now), so a replayed / expired / cross-origin / wrong-device / wrong-key login
 * yields `changes = 0` and mints nothing.
 */
export interface ConsumeFridayLoginChallengeNonceInput {
  nonceHash: string;
  /** Origin the login is presented from; MUST equal the bound issue origin. */
  origin: string;
  /** Wall-clock ISO used for the `expires_at > now` freshness gate. */
  nowIso: string;
  /** Device identifier presented in the login; MUST equal the bound device. */
  deviceId: string;
  /** Hash of the presented device key; MUST equal the bound key hash. */
  devicePublicKeyHash: string;
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
  /**
   * SEC-SETUP-BOOTSTRAP-001 (CR-1): insert a `device_login_challenge` nonce with
   * its device binding stamped at ISSUE time. Only the nonce HASH is persisted.
   */
  insertLoginChallengeNonce(
    db: Database.Database,
    input: InsertFridayLoginChallengeNonceInput,
  ): void;
  /**
   * SEC-SETUP-BOOTSTRAP-001 (CR-1): single-use compare-and-consume of a
   * `device_login_challenge` nonce.
   *
   * The `WHERE consumed_at IS NULL AND expires_at > :now AND origin = :origin AND
   * device_id = :deviceId AND device_public_key_hash = :devicePublicKeyHash`
   * predicate is the atomic replay/expiry/cross-origin/wrong-device gate: a
   * consumed, expired, origin-mismatched, or device/key-mismatched login yields
   * `changes = 0`. Intended to run in the SAME write transaction that mints the
   * session so a replayed login mints NO second token pair (ZERO state change).
   *
   * Returns the number of affected rows (1 = won, 0 = replay/expired/mismatch).
   */
  consumeLoginChallengeNonce(
    db: Database.Database,
    input: ConsumeFridayLoginChallengeNonceInput,
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

    insertLoginChallengeNonce(db, input) {
      db.prepare(
        `INSERT INTO friday_setup_bootstrap_nonces (
           id, nonce_hash, kind, hub_id, install_id, os_user, origin, action,
           device_id, device_public_key, device_public_key_hash, claimed_user_id,
           created_at, expires_at, consumed_at
         ) VALUES (?, ?, 'device_login_challenge', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
      ).run(
        input.id,
        input.nonceHash,
        input.hubId,
        input.installId,
        input.osUser,
        input.origin,
        input.action,
        input.deviceId,
        input.devicePublicKey,
        input.devicePublicKeyHash,
        input.createdAt,
        input.expiresAt,
      );
    },

    consumeLoginChallengeNonce(db, input) {
      const res = db
        .prepare(
          `UPDATE friday_setup_bootstrap_nonces
              SET consumed_at = :nowIso
            WHERE nonce_hash = :nonceHash
              AND kind = 'device_login_challenge'
              AND origin = :origin
              AND device_id = :deviceId
              AND device_public_key_hash = :devicePublicKeyHash
              AND consumed_at IS NULL
              AND expires_at > :nowIso`,
        )
        .run({
          nowIso: input.nowIso,
          nonceHash: input.nonceHash,
          origin: input.origin,
          deviceId: input.deviceId,
          devicePublicKeyHash: input.devicePublicKeyHash,
        });
      return res.changes;
    },
  };
}
