import type Database from "better-sqlite3";

// ─── SEC-SETUP-BOOTSTRAP-001 · Slice 5 — dual-read migration persistence ───
//
// The durable owner↔device binding record + the (INACTIVE) stage-5 legacy
// credential tombstone. Stage 2 of the operator-locked FIXED order writes ONLY
// a `provisional` binding and leaves users.password_hash = scrypt$… untouched
// (dual-read: the passphrase remains authoritative — no lockout). The activate /
// revoke / tombstone helpers are SCAFFOLDING for a later stage: they exist and
// are typed, but NO live Slice-5 code path calls them, and none flips
// users.password_hash to the device sentinel.

// ─── Binding row + inputs ───

export type FridayDeviceOwnerBindingState = "provisional" | "active" | "revoked";
export type FridayDeviceOwnerBindingMigratedFrom = "passphrase" | "first_boot";

export interface FridayDeviceOwnerBindingRow {
  id: string;
  user_id: string;
  device_id: string;
  device_public_key: string;
  device_public_key_hash: string;
  state: FridayDeviceOwnerBindingState;
  migrated_from: FridayDeviceOwnerBindingMigratedFrom;
  origin: string;
  hub_id: string;
  created_at: string;
  activated_at: string | null;
  revoked_at: string | null;
}

export interface InsertProvisionalDeviceOwnerBindingInput {
  id: string;
  userId: string;
  deviceId: string;
  devicePublicKey: string;
  devicePublicKeyHash: string;
  /** Slice 5 only migrates a known passphrase-owner → always 'passphrase'. */
  migratedFrom: FridayDeviceOwnerBindingMigratedFrom;
  origin: string;
  hubId: string;
  createdAt: string;
}

// ─── Tombstone row + inputs (INACTIVE scaffolding) ───

export type FridayCredentialTombstoneReason =
  | "migrated_to_device"
  | "delete_all"
  | "release_profile_disable";

export interface FridayCredentialTombstoneRow {
  id: string;
  user_id: string;
  credential_kind: "passphrase";
  retired_reason: FridayCredentialTombstoneReason;
  superseded_by_binding_id: string | null;
  origin: string;
  hub_id: string;
  retired_at: string;
}

export interface InsertCredentialTombstoneInput {
  id: string;
  userId: string;
  credentialKind: "passphrase";
  retiredReason: FridayCredentialTombstoneReason;
  supersededByBindingId: string | null;
  origin: string;
  hubId: string;
  retiredAt: string;
}

// ─── Repository interface ───

export interface FridayDeviceOwnerBindingRepository {
  /**
   * ACTIVE in Slice 5. Insert a `provisional` dual-read binding for an
   * authenticated passphrase-owner migration. Does NOT touch users.password_hash
   * — the passphrase stays authoritative until a later stage proves device
   * readback and flips the binding to 'active'.
   */
  insertProvisionalBinding(
    db: Database.Database,
    input: InsertProvisionalDeviceOwnerBindingInput,
  ): void;
  /** All bindings for a user (any state), newest first. */
  findBindingsByUser(db: Database.Database, userId: string): FridayDeviceOwnerBindingRow[];
  /** The single active binding for a user, if any (partial-unique enforced). */
  findActiveBindingByUser(
    db: Database.Database,
    userId: string,
  ): FridayDeviceOwnerBindingRow | null;
  /**
   * The most-relevant binding for a (user, device-public-key-hash) pair,
   * preferring a 'provisional' row (so the readback activates the pending bind),
   * then the newest by created_at. Returns null when the owner has no binding for
   * that key — so a cross-owner or unknown-key readback fails closed. This is a
   * pure read; the provisional → active flip is still gated by the activateBinding
   * compare-and-set.
   */
  findBindingByUserAndKeyHash(
    db: Database.Database,
    userId: string,
    devicePublicKeyHash: string,
  ): FridayDeviceOwnerBindingRow | null;
  /**
   * SCAFFOLDING (stage 3+, INACTIVE in Slice 5). CAS-flip a provisional binding
   * to 'active'. Not called by any Slice-5 live path. Keyed on the exact
   * bindingId + state='provisional' so it can never activate a revoked binding.
   * Returns affected-row count (1 = flipped, 0 = not provisional / not found).
   */
  activateBinding(
    db: Database.Database,
    bindingId: string,
    userId: string,
    activatedAt: string,
  ): number;
  /**
   * SCAFFOLDING (stage 4/5 reversal, INACTIVE in Slice 5). Mark a binding
   * 'revoked'. Not called by any Slice-5 live path.
   */
  revokeBinding(db: Database.Database, bindingId: string, revokedAt: string): number;
  /**
   * SCAFFOLDING (stage 5, INACTIVE in Slice 5). Write a legacy-credential
   * tombstone. Stores NO secret/hash. Not called by any Slice-5 live path.
   */
  insertCredentialTombstone(db: Database.Database, input: InsertCredentialTombstoneInput): void;
  /**
   * SCAFFOLDING (stage 5 fail-closed login defence, INACTIVE in Slice 5). Find
   * the authoritative tombstone for a user's passphrase credential. Not consulted
   * by the Slice-5 login path (the passphrase still works this slice).
   */
  findActiveTombstone(
    db: Database.Database,
    userId: string,
  ): FridayCredentialTombstoneRow | null;
}

// ─── Factory ───

export function createFridayDeviceOwnerBindingRepository(): FridayDeviceOwnerBindingRepository {
  return {
    insertProvisionalBinding(db, input) {
      db.prepare(
        `INSERT INTO friday_device_owner_bindings (
           id, user_id, device_id, device_public_key, device_public_key_hash,
           state, migrated_from, origin, hub_id, created_at, activated_at, revoked_at
         ) VALUES (?, ?, ?, ?, ?, 'provisional', ?, ?, ?, ?, NULL, NULL)`,
      ).run(
        input.id,
        input.userId,
        input.deviceId,
        input.devicePublicKey,
        input.devicePublicKeyHash,
        input.migratedFrom,
        input.origin,
        input.hubId,
        input.createdAt,
      );
    },

    findBindingsByUser(db, userId) {
      return db
        .prepare(
          "SELECT * FROM friday_device_owner_bindings WHERE user_id = ? ORDER BY created_at DESC",
        )
        .all(userId) as FridayDeviceOwnerBindingRow[];
    },

    findActiveBindingByUser(db, userId) {
      return (
        (db
          .prepare(
            "SELECT * FROM friday_device_owner_bindings WHERE user_id = ? AND state = 'active'",
          )
          .get(userId) as FridayDeviceOwnerBindingRow | undefined) ?? null
      );
    },

    findBindingByUserAndKeyHash(db, userId, devicePublicKeyHash) {
      return (
        (db
          .prepare(
            `SELECT * FROM friday_device_owner_bindings
              WHERE user_id = ? AND device_public_key_hash = ?
              ORDER BY (state = 'provisional') DESC, created_at DESC
              LIMIT 1`,
          )
          .get(userId, devicePublicKeyHash) as FridayDeviceOwnerBindingRow | undefined) ?? null
      );
    },

    activateBinding(db, bindingId, userId, activatedAt) {
      return db
        .prepare(
          `UPDATE friday_device_owner_bindings
              SET state = 'active', activated_at = ?
            WHERE id = ? AND user_id = ? AND state = 'provisional'`,
        )
        .run(activatedAt, bindingId, userId).changes;
    },

    revokeBinding(db, bindingId, revokedAt) {
      return db
        .prepare(
          `UPDATE friday_device_owner_bindings
              SET state = 'revoked', revoked_at = ?
            WHERE id = ? AND state != 'revoked'`,
        )
        .run(revokedAt, bindingId).changes;
    },

    insertCredentialTombstone(db, input) {
      db.prepare(
        `INSERT INTO friday_credential_tombstones (
           id, user_id, credential_kind, retired_reason, superseded_by_binding_id,
           origin, hub_id, retired_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.userId,
        input.credentialKind,
        input.retiredReason,
        input.supersededByBindingId,
        input.origin,
        input.hubId,
        input.retiredAt,
      );
    },

    findActiveTombstone(db, userId) {
      return (
        (db
          .prepare(
            `SELECT * FROM friday_credential_tombstones
              WHERE user_id = ? AND credential_kind = 'passphrase'
                AND retired_reason = 'migrated_to_device'
              ORDER BY retired_at DESC LIMIT 1`,
          )
          .get(userId) as FridayCredentialTombstoneRow | undefined) ?? null
      );
    },
  };
}
