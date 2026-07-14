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

// ─── Repository interface ───

export interface FridaySetupBootstrapNonceRepository {
  insertNonce(db: Database.Database, input: InsertFridaySetupBootstrapNonceInput): void;
  findByHash(db: Database.Database, nonceHash: string): FridaySetupBootstrapNonceRow | null;
  findById(db: Database.Database, id: string): FridaySetupBootstrapNonceRow | null;
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
