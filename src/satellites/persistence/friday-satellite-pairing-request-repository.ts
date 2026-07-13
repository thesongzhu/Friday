import type Database from "better-sqlite3";
import type { FridaySatellitePairingRequestRow } from "../model/friday-satellite.types.js";
import {
  decryptSecret,
  encryptSecret,
  type FridayEncryptedEnvelope,
  getStrictMasterKey,
} from "../../security/friday-secret-crypto.js";

export interface InsertPairingRequestInput {
  id: string;
  satelliteId: string;
  code: string;
  nonce: string;
  requestedByIp?: string;
  requestedByUserAgent?: string;
  expiresAt: string;
  nowIso: string;
}

/**
 * A pairing `code` found at rest as legacy plaintext (not an encrypted
 * envelope). Emitted by {@link FridaySatellitePairingRequestRepository.getRequest}
 * / getRequestBySatelliteId so operators can observe (and audit) plaintext that
 * predates encryption, rather than silently leaking it forever. Such a code is
 * re-encrypted the next time its request row is (re)inserted.
 */
export interface FridaySatellitePairingCodeResidueEntry {
  requestId: string;
  reason: "legacy-plaintext";
}

export interface CreateFridaySatellitePairingRequestRepositoryOptions {
  /**
   * Master key used to encrypt/decrypt the pairing `code` VALUE at rest.
   *
   * Defaults to the hub's fail-closed persistent master key resolver
   * ({@link getStrictMasterKey}) — the same source that guards provider, MCP,
   * and multi-tenant secrets. {@link FridaySatellitePairingRequestRepository.insertRequest}
   * FAILS CLOSED (throws BEFORE the INSERT) when it is unavailable, so a
   * plaintext code is never silently persisted. Tests inject a fixed key here.
   */
  masterKey?: Buffer;
  /**
   * Invoked by getRequest / getRequestBySatelliteId when a legacy plaintext
   * code is encountered at rest. Defaults to a console.warn summary.
   */
  onSecretResidue?: (entry: FridaySatellitePairingCodeResidueEntry) => void;
}

export interface FridaySatellitePairingRequestRepository {
  insertRequest(db: Database.Database, input: InsertPairingRequestInput): void;
  getRequest(db: Database.Database, id: string): FridaySatellitePairingRequestRow | undefined;
  getRequestBySatelliteId(
    db: Database.Database,
    satelliteId: string,
    status: string,
  ): FridaySatellitePairingRequestRow | undefined;
  updateStatus(
    db: Database.Database,
    id: string,
    status: "approved" | "rejected" | "expired",
    resolverUserId: string | null,
    nowIso: string,
  ): void;
  listPendingExpiredBefore(db: Database.Database, cutoffIso: string): FridaySatellitePairingRequestRow[];
  deleteResolvedBefore(db: Database.Database, cutoffIso: string): number;
}

/**
 * Detect an inline encrypted envelope stored in the TEXT `code` column. A
 * 6-digit legacy plaintext code (or any non-JSON-object value) yields `null`,
 * so it is treated as legacy plaintext rather than an envelope.
 */
function parseCodeEnvelope(value: string): FridayEncryptedEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.ciphertext === "string" &&
    typeof obj.iv === "string" &&
    typeof obj.tag === "string"
  ) {
    return { ciphertext: obj.ciphertext, iv: obj.iv, tag: obj.tag };
  }
  return null;
}

export function createFridaySatellitePairingRequestRepository(
  options: CreateFridaySatellitePairingRequestRepositoryOptions = {},
): FridaySatellitePairingRequestRepository {
  function resolveMasterKey(): Buffer {
    return options.masterKey ?? getStrictMasterKey();
  }

  function reportResidue(entry: FridaySatellitePairingCodeResidueEntry): void {
    if (options.onSecretResidue) {
      options.onSecretResidue(entry);
      return;
    }
    console.warn(
      `[friday][satellite-pairing-repo][SECURITY] pairing request ${entry.requestId} has a plaintext ` +
        `code at rest (${entry.reason}); it will be re-encrypted the next time the request is inserted.`,
    );
  }

  /**
   * Restore the plaintext `code` on a fetched row. An envelope is decrypted;
   * a non-envelope value is legacy plaintext → returned as-is + residue
   * reported. FAIL-SAFE: never throws on a key/decrypt failure — the opaque
   * envelope is left in place (mirroring the MCP config-store `load`).
   */
  function restoreCode(
    row: FridaySatellitePairingRequestRow | undefined,
  ): FridaySatellitePairingRequestRow | undefined {
    if (!row) return row;
    const envelope = parseCodeEnvelope(row.code);
    if (!envelope) {
      reportResidue({ requestId: row.id, reason: "legacy-plaintext" });
      return row;
    }
    let key: Buffer;
    try {
      key = resolveMasterKey();
    } catch {
      return row; // fail-safe: key unavailable → leave opaque, never throw
    }
    try {
      row.code = decryptSecret(envelope, key);
    } catch {
      // fail-safe: decrypt failure → leave the opaque envelope in place
    }
    return row;
  }

  return {
    insertRequest(db, input) {
      // Fail-closed: resolve the master key BEFORE the INSERT. When no key is
      // available this throws and NO row (and therefore no plaintext code) is
      // written.
      const key = resolveMasterKey();
      const encryptedCode = JSON.stringify(encryptSecret(input.code, key));
      db.prepare(
        `INSERT INTO satellite_pairing_requests (
          id, satellite_id, code, nonce, requested_by_ip, requested_by_user_agent,
          status, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      ).run(
        input.id,
        input.satelliteId,
        encryptedCode,
        input.nonce,
        input.requestedByIp ?? null,
        input.requestedByUserAgent ?? null,
        input.expiresAt,
        input.nowIso,
        input.nowIso,
      );
    },

    getRequest(db, id) {
      const row = db
        .prepare("SELECT * FROM satellite_pairing_requests WHERE id = ?")
        .get(id) as FridaySatellitePairingRequestRow | undefined;
      return restoreCode(row);
    },

    getRequestBySatelliteId(db, satelliteId, status) {
      const row = db
        .prepare(
          "SELECT * FROM satellite_pairing_requests WHERE satellite_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(satelliteId, status) as FridaySatellitePairingRequestRow | undefined;
      return restoreCode(row);
    },

    updateStatus(db, id, status, resolverUserId, nowIso) {
      db.prepare(
        `UPDATE satellite_pairing_requests
         SET status = ?, resolved_at = ?, resolver_user_id = ?, updated_at = ?
         WHERE id = ?`,
      ).run(status, nowIso, resolverUserId, nowIso, id);
    },

    listPendingExpiredBefore(db, cutoffIso) {
      return db
        .prepare(
          "SELECT * FROM satellite_pairing_requests WHERE status = 'pending' AND expires_at < ?",
        )
        .all(cutoffIso) as FridaySatellitePairingRequestRow[];
    },

    deleteResolvedBefore(db, cutoffIso) {
      const result = db
        .prepare(
          "DELETE FROM satellite_pairing_requests WHERE status IN ('approved', 'rejected', 'expired') AND updated_at < ?",
        )
        .run(cutoffIso);
      return result.changes;
    },
  };
}
