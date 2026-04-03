import type Database from "better-sqlite3";

import type {
  FridaySystemApprovalRule,
  FridaySystemApprovalRuleRecord,
  FridaySystemControlLease,
  FridaySystemControlLeaseRecord,
  FridaySystemEvent,
  FridaySystemEventName,
  FridaySystemEventRecord,
  FridaySystemRemoteAssertionGrant,
  FridaySystemRemoteAssertionGrantRecord,
  FridaySystemRemoteAuthChallenge,
  FridaySystemRemoteAuthChallengeRecord,
  FridaySystemRemoteDevice,
  FridaySystemRemoteDeviceRecord,
  FridaySystemRemotePasskey,
  FridaySystemRemotePasskeyRecord,
  FridaySystemRemoteSession,
  FridaySystemRemoteSessionRecord,
} from "../model/friday-system.types.js";
import { safeJsonParse } from "#utilities";

export interface FridaySystemApprovalRuleFilters {
  action?: string;
  appIdentifier?: string;
  decision?: string;
  limit?: number;
  cursor?: string;
}

export interface FridaySystemApprovalRulesSummary {
  total: number;
  highRiskAllowed: number;
}

export interface FridaySystemRemoteDevicesSummary {
  total: number;
  active: number;
}

export interface FridaySystemRemoteSessionsSummary {
  total: number;
  active: number;
  latestSeenAt?: string;
}

export interface FridaySystemRepository {
  listApprovalRules(
    db: Database.Database,
    filters?: FridaySystemApprovalRuleFilters,
  ): FridaySystemApprovalRule[];
  findApprovalRuleById(db: Database.Database, id: string): FridaySystemApprovalRule | null;
  findMatchingApprovalRule(
    db: Database.Database,
    input: { action: string; appIdentifier?: string },
  ): FridaySystemApprovalRule | null;
  insertApprovalRule(db: Database.Database, rule: FridaySystemApprovalRule): FridaySystemApprovalRule;
  updateApprovalRule(
    db: Database.Database,
    id: string,
    patch: Partial<FridaySystemApprovalRule>,
  ): FridaySystemApprovalRule | null;
  summarizeApprovalRules(db: Database.Database): FridaySystemApprovalRulesSummary;

  listRemoteDevices(db: Database.Database): FridaySystemRemoteDevice[];
  summarizeRemoteDevices(db: Database.Database): FridaySystemRemoteDevicesSummary;
  findRemoteDeviceById(db: Database.Database, id: string): FridaySystemRemoteDevice | null;
  findRemoteDeviceByFingerprint(db: Database.Database, fingerprint: string): FridaySystemRemoteDevice | null;
  insertRemoteDevice(db: Database.Database, device: FridaySystemRemoteDevice): FridaySystemRemoteDevice;
  reactivateRemoteDevice(
    db: Database.Database,
    id: string,
    patch: { label: string; platform: FridaySystemRemoteDevice["platform"]; credentialId?: string; lastSeenAt: string },
  ): FridaySystemRemoteDevice | null;
  setRemoteDeviceCredential(
    db: Database.Database,
    id: string,
    input: { credentialId: string; lastSeenAt: string },
  ): FridaySystemRemoteDevice | null;
  clearRemoteDeviceCredential(
    db: Database.Database,
    id: string,
    lastSeenAt: string,
  ): FridaySystemRemoteDevice | null;
  revokeRemoteDevice(db: Database.Database, id: string, revokedAt: string): FridaySystemRemoteDevice | null;
  touchRemoteDevice(db: Database.Database, id: string, lastSeenAt: string): FridaySystemRemoteDevice | null;

  findRemotePasskeyByDeviceId(db: Database.Database, deviceId: string): FridaySystemRemotePasskey | null;
  findRemotePasskeyByCredentialId(db: Database.Database, credentialId: string): FridaySystemRemotePasskey | null;
  upsertRemotePasskey(db: Database.Database, passkey: FridaySystemRemotePasskey): FridaySystemRemotePasskey;
  deleteRemotePasskeyByDeviceId(db: Database.Database, deviceId: string): boolean;
  touchRemotePasskey(
    db: Database.Database,
    deviceId: string,
    input: { counter: number; lastUsedAt: string; backedUp?: boolean },
  ): FridaySystemRemotePasskey | null;

  insertRemoteAuthChallenge(
    db: Database.Database,
    challenge: FridaySystemRemoteAuthChallenge,
  ): FridaySystemRemoteAuthChallenge;
  findRemoteAuthChallengeById(db: Database.Database, id: string): FridaySystemRemoteAuthChallenge | null;
  markRemoteAuthChallengeUsed(
    db: Database.Database,
    id: string,
    usedAt: string,
  ): FridaySystemRemoteAuthChallenge | null;
  deleteRemoteAuthChallengesForDevice(db: Database.Database, deviceId: string): number;

  insertRemoteAssertionGrant(
    db: Database.Database,
    grant: FridaySystemRemoteAssertionGrant & { tokenHash: string },
  ): FridaySystemRemoteAssertionGrant;
  findRemoteAssertionGrantByTokenHash(
    db: Database.Database,
    tokenHash: string,
    nowIso: string,
  ): FridaySystemRemoteAssertionGrant | null;
  consumeRemoteAssertionGrant(
    db: Database.Database,
    id: string,
    consumedAt: string,
  ): FridaySystemRemoteAssertionGrant | null;
  revokeRemoteAssertionGrantsForDevice(
    db: Database.Database,
    deviceId: string,
    consumedAt: string,
  ): FridaySystemRemoteAssertionGrant[];

  listRemoteSessions(
    db: Database.Database,
    input?: { deviceId?: string; status?: string; limit?: number },
  ): FridaySystemRemoteSession[];
  summarizeRemoteSessions(db: Database.Database): FridaySystemRemoteSessionsSummary;
  findRemoteSessionById(db: Database.Database, id: string): FridaySystemRemoteSession | null;
  insertRemoteSession(db: Database.Database, session: FridaySystemRemoteSession): FridaySystemRemoteSession;
  touchRemoteSession(db: Database.Database, id: string, lastSeenAt: string): FridaySystemRemoteSession | null;
  closeRemoteSession(
    db: Database.Database,
    id: string,
    input: { closedAt: string; closedReason?: string },
  ): FridaySystemRemoteSession | null;
  closeActiveRemoteSessionsForDevice(
    db: Database.Database,
    deviceId: string,
    input: { closedAt: string; closedReason?: string },
  ): FridaySystemRemoteSession[];

  appendEvent(
    db: Database.Database,
    input: { id: string; event: FridaySystemEventName; payload: Record<string, unknown>; emittedAt: string },
  ): FridaySystemEvent;
  findLatestEventByName(
    db: Database.Database,
    eventName: FridaySystemEventName,
  ): FridaySystemEvent | null;
  listEvents(
    db: Database.Database,
    input?: { afterSeq?: number; limit?: number },
  ): FridaySystemEvent[];
  getLatestSeq(db: Database.Database): number;

  insertControlLease(db: Database.Database, lease: FridaySystemControlLease): FridaySystemControlLease;
  revokeControlLease(
    db: Database.Database,
    id: string,
    revokedAt: string,
    revokedReason?: string,
  ): FridaySystemControlLease | null;
  getLatestActiveControlLease(db: Database.Database, nowIso: string): FridaySystemControlLease | null;
}

function approvalRowToEntity(row: FridaySystemApprovalRuleRecord): FridaySystemApprovalRule {
  return {
    id: row.id,
    appIdentifier: row.app_identifier ?? undefined,
    action: row.action,
    riskLevel: row.risk_level,
    decision: row.decision,
    rationale: row.rationale ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at ?? undefined,
  };
}

function remoteDeviceRowToEntity(row: FridaySystemRemoteDeviceRecord): FridaySystemRemoteDevice {
  return {
    id: row.id,
    label: row.label,
    fingerprint: row.fingerprint,
    platform: row.platform,
    credentialId: row.credential_id ?? undefined,
    trustScope: row.trust_scope,
    status: row.status,
    registeredAt: row.registered_at,
    lastSeenAt: row.last_seen_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
  };
}

function remoteSessionRowToEntity(row: FridaySystemRemoteSessionRecord): FridaySystemRemoteSession {
  return {
    id: row.id,
    deviceId: row.device_id,
    devicePlatform: row.device_platform ?? undefined,
    status: row.status,
    connectedAt: row.connected_at,
    lastSeenAt: row.last_seen_at,
    closedAt: row.closed_at ?? undefined,
    closedReason: row.closed_reason ?? undefined,
    ipAddress: row.ip_address ?? undefined,
    userAgent: row.user_agent ?? undefined,
  };
}

function remotePasskeyRowToEntity(row: FridaySystemRemotePasskeyRecord): FridaySystemRemotePasskey {
  return {
    deviceId: row.device_id,
    credentialId: row.credential_id,
    publicKey: row.public_key_b64u,
    counter: row.counter,
    transports: safeJsonParse<string[]>(row.transports_json),
    deviceType: row.device_type ?? undefined,
    backedUp: row.backed_up === 1,
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at ?? undefined,
  };
}

function remoteAuthChallengeRowToEntity(
  row: FridaySystemRemoteAuthChallengeRecord,
): FridaySystemRemoteAuthChallenge {
  return {
    id: row.id,
    deviceId: row.device_id,
    kind: row.kind,
    challenge: row.challenge,
    rpId: row.rp_id,
    origin: row.origin,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at ?? undefined,
  };
}

function remoteAssertionGrantRowToEntity(
  row: FridaySystemRemoteAssertionGrantRecord,
): FridaySystemRemoteAssertionGrant {
  return {
    id: row.id,
    deviceId: row.device_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at ?? undefined,
    ipAddress: row.ip_address ?? undefined,
    userAgent: row.user_agent ?? undefined,
  };
}

function controlLeaseRowToEntity(row: FridaySystemControlLeaseRecord): FridaySystemControlLease {
  return {
    id: row.id,
    ownerId: row.owner_id,
    ownerKind: row.owner_kind,
    reason: row.reason ?? undefined,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    revokedReason: row.revoked_reason ?? undefined,
  };
}

function eventRowToEntity(row: FridaySystemEventRecord): FridaySystemEvent {
  return {
    id: row.id,
    seq: row.seq,
    event: row.event_name,
    emittedAt: row.emitted_at,
    payload: safeJsonParse<Record<string, unknown>>(row.payload_json) ?? {},
  };
}

export function createFridaySystemRepository(): FridaySystemRepository {
  return {
    listApprovalRules(db, filters) {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (filters?.action) {
        conditions.push("action = ?");
        params.push(filters.action);
      }
      if (filters?.appIdentifier) {
        conditions.push("(app_identifier = ? OR app_identifier IS NULL)");
        params.push(filters.appIdentifier);
      }
      if (filters?.decision) {
        conditions.push("decision = ?");
        params.push(filters.decision);
      }
      if (filters?.cursor) {
        conditions.push("updated_at < ?");
        params.push(filters.cursor);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = Math.min(filters?.limit ?? 100, 500);
      params.push(limit);

      const rows = db.prepare(
        `SELECT * FROM friday_system_approval_rules ${whereClause} ORDER BY updated_at DESC LIMIT ?`,
      ).all(...params) as FridaySystemApprovalRuleRecord[];
      return rows.map(approvalRowToEntity);
    },

    findApprovalRuleById(db, id) {
      const row = db.prepare(
        "SELECT * FROM friday_system_approval_rules WHERE id = ?",
      ).get(id) as FridaySystemApprovalRuleRecord | undefined;
      return row ? approvalRowToEntity(row) : null;
    },

    findMatchingApprovalRule(db, input) {
      const exact = db.prepare(
        `SELECT * FROM friday_system_approval_rules
         WHERE action = ? AND app_identifier = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
      ).get(input.action, input.appIdentifier ?? null) as FridaySystemApprovalRuleRecord | undefined;
      if (exact) {
        return approvalRowToEntity(exact);
      }
      const fallback = db.prepare(
        `SELECT * FROM friday_system_approval_rules
         WHERE action = ? AND app_identifier IS NULL
         ORDER BY updated_at DESC
         LIMIT 1`,
      ).get(input.action) as FridaySystemApprovalRuleRecord | undefined;
      return fallback ? approvalRowToEntity(fallback) : null;
    },

    insertApprovalRule(db, rule) {
      db.prepare(
        `INSERT INTO friday_system_approval_rules (
          id, app_identifier, action, risk_level, decision, rationale,
          created_at, updated_at, last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        rule.id,
        rule.appIdentifier ?? null,
        rule.action,
        rule.riskLevel,
        rule.decision,
        rule.rationale ?? null,
        rule.createdAt,
        rule.updatedAt,
        rule.lastUsedAt ?? null,
      );
      return this.findApprovalRuleById(db, rule.id)!;
    },

    updateApprovalRule(db, id, patch) {
      const sets: string[] = [];
      const params: unknown[] = [];

      if (patch.appIdentifier !== undefined) {
        sets.push("app_identifier = ?");
        params.push(patch.appIdentifier ?? null);
      }
      if (patch.action !== undefined) {
        sets.push("action = ?");
        params.push(patch.action);
      }
      if (patch.riskLevel !== undefined) {
        sets.push("risk_level = ?");
        params.push(patch.riskLevel);
      }
      if (patch.decision !== undefined) {
        sets.push("decision = ?");
        params.push(patch.decision);
      }
      if (patch.rationale !== undefined) {
        sets.push("rationale = ?");
        params.push(patch.rationale ?? null);
      }
      if (patch.updatedAt !== undefined) {
        sets.push("updated_at = ?");
        params.push(patch.updatedAt);
      }
      if (patch.lastUsedAt !== undefined) {
        sets.push("last_used_at = ?");
        params.push(patch.lastUsedAt ?? null);
      }

      if (sets.length === 0) {
        return this.findApprovalRuleById(db, id);
      }

      params.push(id);
      db.prepare(
        `UPDATE friday_system_approval_rules SET ${sets.join(", ")} WHERE id = ?`,
      ).run(...params);
      return this.findApprovalRuleById(db, id);
    },

    summarizeApprovalRules(db) {
      const row = db.prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE
             WHEN decision = 'allow' AND risk_level IN ('high', 'critical') THEN 1
             ELSE 0
           END), 0) AS high_risk_allowed
         FROM friday_system_approval_rules`,
      ).get() as { total: number; high_risk_allowed: number } | undefined;
      return {
        total: row?.total ?? 0,
        highRiskAllowed: row?.high_risk_allowed ?? 0,
      };
    },

    listRemoteDevices(db) {
      const rows = db.prepare(
        "SELECT * FROM friday_system_remote_devices ORDER BY registered_at DESC",
      ).all() as FridaySystemRemoteDeviceRecord[];
      return rows.map(remoteDeviceRowToEntity);
    },

    summarizeRemoteDevices(db) {
      const row = db.prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active
         FROM friday_system_remote_devices`,
      ).get() as { total: number; active: number } | undefined;
      return {
        total: row?.total ?? 0,
        active: row?.active ?? 0,
      };
    },

    findRemoteDeviceById(db, id) {
      const row = db.prepare(
        "SELECT * FROM friday_system_remote_devices WHERE id = ?",
      ).get(id) as FridaySystemRemoteDeviceRecord | undefined;
      return row ? remoteDeviceRowToEntity(row) : null;
    },

    findRemoteDeviceByFingerprint(db, fingerprint) {
      const row = db.prepare(
        "SELECT * FROM friday_system_remote_devices WHERE fingerprint = ?",
      ).get(fingerprint) as FridaySystemRemoteDeviceRecord | undefined;
      return row ? remoteDeviceRowToEntity(row) : null;
    },

    insertRemoteDevice(db, device) {
      db.prepare(
        `INSERT INTO friday_system_remote_devices (
          id, label, fingerprint, platform, credential_id, trust_scope, status,
          registered_at, last_seen_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        device.id,
        device.label,
        device.fingerprint,
        device.platform,
        device.credentialId ?? null,
        device.trustScope,
        device.status,
        device.registeredAt,
        device.lastSeenAt ?? null,
        device.revokedAt ?? null,
      );
      return this.findRemoteDeviceById(db, device.id)!;
    },

    reactivateRemoteDevice(db, id, patch) {
      db.prepare(
        `UPDATE friday_system_remote_devices
         SET label = ?, platform = ?, credential_id = ?, status = 'active', last_seen_at = ?, revoked_at = NULL
         WHERE id = ?`,
      ).run(
        patch.label,
        patch.platform,
        patch.credentialId ?? null,
        patch.lastSeenAt,
        id,
      );
      return this.findRemoteDeviceById(db, id);
    },

    setRemoteDeviceCredential(db, id, input) {
      db.prepare(
        `UPDATE friday_system_remote_devices
         SET credential_id = ?, last_seen_at = ?
         WHERE id = ?`,
      ).run(
        input.credentialId,
        input.lastSeenAt,
        id,
      );
      return this.findRemoteDeviceById(db, id);
    },

    clearRemoteDeviceCredential(db, id, lastSeenAt) {
      db.prepare(
        `UPDATE friday_system_remote_devices
         SET credential_id = NULL, last_seen_at = ?
         WHERE id = ?`,
      ).run(lastSeenAt, id);
      return this.findRemoteDeviceById(db, id);
    },

    revokeRemoteDevice(db, id, revokedAt) {
      db.prepare(
        `UPDATE friday_system_remote_devices
         SET status = 'revoked', revoked_at = ?, last_seen_at = ?
         WHERE id = ?`,
      ).run(revokedAt, revokedAt, id);
      return this.findRemoteDeviceById(db, id);
    },

    touchRemoteDevice(db, id, lastSeenAt) {
      db.prepare(
        "UPDATE friday_system_remote_devices SET last_seen_at = ? WHERE id = ?",
      ).run(lastSeenAt, id);
      return this.findRemoteDeviceById(db, id);
    },

    findRemotePasskeyByDeviceId(db, deviceId) {
      const row = db.prepare(
        "SELECT * FROM friday_system_remote_passkeys WHERE device_id = ?",
      ).get(deviceId) as FridaySystemRemotePasskeyRecord | undefined;
      return row ? remotePasskeyRowToEntity(row) : null;
    },

    findRemotePasskeyByCredentialId(db, credentialId) {
      const row = db.prepare(
        "SELECT * FROM friday_system_remote_passkeys WHERE credential_id = ?",
      ).get(credentialId) as FridaySystemRemotePasskeyRecord | undefined;
      return row ? remotePasskeyRowToEntity(row) : null;
    },

    upsertRemotePasskey(db, passkey) {
      db.prepare(
        `INSERT INTO friday_system_remote_passkeys (
          device_id, credential_id, public_key_b64u, counter, transports_json,
          device_type, backed_up, registered_at, updated_at, last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
          credential_id = excluded.credential_id,
          public_key_b64u = excluded.public_key_b64u,
          counter = excluded.counter,
          transports_json = excluded.transports_json,
          device_type = excluded.device_type,
          backed_up = excluded.backed_up,
          updated_at = excluded.updated_at,
          last_used_at = excluded.last_used_at`,
      ).run(
        passkey.deviceId,
        passkey.credentialId,
        passkey.publicKey,
        passkey.counter,
        passkey.transports ? JSON.stringify(passkey.transports) : null,
        passkey.deviceType ?? null,
        passkey.backedUp ? 1 : 0,
        passkey.registeredAt,
        passkey.updatedAt,
        passkey.lastUsedAt ?? null,
      );
      return this.findRemotePasskeyByDeviceId(db, passkey.deviceId)!;
    },

    deleteRemotePasskeyByDeviceId(db, deviceId) {
      const result = db.prepare(
        "DELETE FROM friday_system_remote_passkeys WHERE device_id = ?",
      ).run(deviceId);
      return result.changes > 0;
    },

    touchRemotePasskey(db, deviceId, input) {
      db.prepare(
        `UPDATE friday_system_remote_passkeys
         SET counter = ?, backed_up = COALESCE(?, backed_up), updated_at = ?, last_used_at = ?
         WHERE device_id = ?`,
      ).run(
        input.counter,
        typeof input.backedUp === "boolean" ? (input.backedUp ? 1 : 0) : null,
        input.lastUsedAt,
        input.lastUsedAt,
        deviceId,
      );
      return this.findRemotePasskeyByDeviceId(db, deviceId);
    },

    insertRemoteAuthChallenge(db, challenge) {
      db.prepare(
        `INSERT INTO friday_system_remote_auth_challenges (
          id, device_id, kind, challenge, rp_id, origin, created_at, expires_at, used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        challenge.id,
        challenge.deviceId,
        challenge.kind,
        challenge.challenge,
        challenge.rpId,
        challenge.origin,
        challenge.createdAt,
        challenge.expiresAt,
        challenge.usedAt ?? null,
      );
      return this.findRemoteAuthChallengeById(db, challenge.id)!;
    },

    findRemoteAuthChallengeById(db, id) {
      const row = db.prepare(
        "SELECT * FROM friday_system_remote_auth_challenges WHERE id = ?",
      ).get(id) as FridaySystemRemoteAuthChallengeRecord | undefined;
      return row ? remoteAuthChallengeRowToEntity(row) : null;
    },

    markRemoteAuthChallengeUsed(db, id, usedAt) {
      db.prepare(
        `UPDATE friday_system_remote_auth_challenges
         SET used_at = ?
         WHERE id = ?`,
      ).run(usedAt, id);
      return this.findRemoteAuthChallengeById(db, id);
    },

    deleteRemoteAuthChallengesForDevice(db, deviceId) {
      const result = db.prepare(
        "DELETE FROM friday_system_remote_auth_challenges WHERE device_id = ?",
      ).run(deviceId);
      return result.changes;
    },

    insertRemoteAssertionGrant(db, grant) {
      db.prepare(
        `INSERT INTO friday_system_remote_assertion_grants (
          id, device_id, token_hash, created_at, expires_at, consumed_at, ip_address, user_agent
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        grant.id,
        grant.deviceId,
        grant.tokenHash,
        grant.createdAt,
        grant.expiresAt,
        grant.consumedAt ?? null,
        grant.ipAddress ?? null,
        grant.userAgent ?? null,
      );
      const row = db.prepare(
        "SELECT * FROM friday_system_remote_assertion_grants WHERE id = ?",
      ).get(grant.id) as FridaySystemRemoteAssertionGrantRecord | undefined;
      return row ? remoteAssertionGrantRowToEntity(row) : {
        id: grant.id,
        deviceId: grant.deviceId,
        createdAt: grant.createdAt,
        expiresAt: grant.expiresAt,
        consumedAt: grant.consumedAt,
        ipAddress: grant.ipAddress,
        userAgent: grant.userAgent,
      };
    },

    findRemoteAssertionGrantByTokenHash(db, tokenHash, nowIso) {
      const row = db.prepare(
        `SELECT * FROM friday_system_remote_assertion_grants
         WHERE token_hash = ?
           AND consumed_at IS NULL
           AND expires_at > ?
         LIMIT 1`,
      ).get(tokenHash, nowIso) as FridaySystemRemoteAssertionGrantRecord | undefined;
      return row ? remoteAssertionGrantRowToEntity(row) : null;
    },

    consumeRemoteAssertionGrant(db, id, consumedAt) {
      db.prepare(
        `UPDATE friday_system_remote_assertion_grants
         SET consumed_at = ?
         WHERE id = ?`,
      ).run(consumedAt, id);
      const row = db.prepare(
        "SELECT * FROM friday_system_remote_assertion_grants WHERE id = ?",
      ).get(id) as FridaySystemRemoteAssertionGrantRecord | undefined;
      return row ? remoteAssertionGrantRowToEntity(row) : null;
    },

    revokeRemoteAssertionGrantsForDevice(db, deviceId, consumedAt) {
      const rows = db.prepare(
        `SELECT * FROM friday_system_remote_assertion_grants
         WHERE device_id = ? AND consumed_at IS NULL`,
      ).all(deviceId) as FridaySystemRemoteAssertionGrantRecord[];
      db.prepare(
        `UPDATE friday_system_remote_assertion_grants
         SET consumed_at = ?
         WHERE device_id = ? AND consumed_at IS NULL`,
      ).run(consumedAt, deviceId);
      return rows.map((row) => ({
        ...remoteAssertionGrantRowToEntity(row),
        consumedAt,
      }));
    },

    listRemoteSessions(db, input) {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (input?.deviceId) {
        conditions.push("sessions.device_id = ?");
        params.push(input.deviceId);
      }
      if (input?.status) {
        conditions.push("sessions.status = ?");
        params.push(input.status);
      }
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      params.push(Math.min(input?.limit ?? 100, 500));
      const rows = db.prepare(
        `SELECT sessions.*, devices.platform AS device_platform
         FROM friday_system_remote_sessions AS sessions
         LEFT JOIN friday_system_remote_devices AS devices ON devices.id = sessions.device_id
         ${whereClause}
         ORDER BY sessions.connected_at DESC
         LIMIT ?`,
      ).all(...params) as FridaySystemRemoteSessionRecord[];
      return rows.map(remoteSessionRowToEntity);
    },

    summarizeRemoteSessions(db) {
      const row = db.prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active,
           MAX(last_seen_at) AS latest_seen_at
         FROM friday_system_remote_sessions`,
      ).get() as { total: number; active: number; latest_seen_at?: string | null } | undefined;
      return {
        total: row?.total ?? 0,
        active: row?.active ?? 0,
        latestSeenAt: row?.latest_seen_at ?? undefined,
      };
    },

    findRemoteSessionById(db, id) {
      const row = db.prepare(
        `SELECT sessions.*, devices.platform AS device_platform
         FROM friday_system_remote_sessions AS sessions
         LEFT JOIN friday_system_remote_devices AS devices ON devices.id = sessions.device_id
         WHERE sessions.id = ?`,
      ).get(id) as FridaySystemRemoteSessionRecord | undefined;
      return row ? remoteSessionRowToEntity(row) : null;
    },

    insertRemoteSession(db, session) {
      db.prepare(
        `INSERT INTO friday_system_remote_sessions (
          id, device_id, status, connected_at, last_seen_at, closed_at, closed_reason, ip_address, user_agent
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        session.id,
        session.deviceId,
        session.status,
        session.connectedAt,
        session.lastSeenAt,
        session.closedAt ?? null,
        session.closedReason ?? null,
        session.ipAddress ?? null,
        session.userAgent ?? null,
      );
      return this.findRemoteSessionById(db, session.id)!;
    },

    touchRemoteSession(db, id, lastSeenAt) {
      db.prepare(
        `UPDATE friday_system_remote_sessions
         SET last_seen_at = ?
         WHERE id = ?`,
      ).run(lastSeenAt, id);
      return this.findRemoteSessionById(db, id);
    },

    closeRemoteSession(db, id, input) {
      db.prepare(
        `UPDATE friday_system_remote_sessions
         SET status = 'closed', closed_at = ?, closed_reason = ?, last_seen_at = ?
         WHERE id = ?`,
      ).run(input.closedAt, input.closedReason ?? null, input.closedAt, id);
      return this.findRemoteSessionById(db, id);
    },

    closeActiveRemoteSessionsForDevice(db, deviceId, input) {
      const activeRows = db.prepare(
        `SELECT sessions.*, devices.platform AS device_platform
         FROM friday_system_remote_sessions AS sessions
         LEFT JOIN friday_system_remote_devices AS devices ON devices.id = sessions.device_id
         WHERE sessions.device_id = ? AND sessions.status = 'active'`,
      ).all(deviceId) as FridaySystemRemoteSessionRecord[];
      db.prepare(
        `UPDATE friday_system_remote_sessions
         SET status = 'closed', closed_at = ?, closed_reason = ?, last_seen_at = ?
         WHERE device_id = ? AND status = 'active'`,
      ).run(input.closedAt, input.closedReason ?? null, input.closedAt, deviceId);
      return activeRows.map((row) => ({
        ...remoteSessionRowToEntity(row),
        status: "closed",
        closedAt: input.closedAt,
        closedReason: input.closedReason,
        lastSeenAt: input.closedAt,
      }));
    },

    appendEvent(db, input) {
      const currentMaxSeq = this.getLatestSeq(db);
      const nextSeq = currentMaxSeq + 1;
      db.prepare(
        `INSERT INTO friday_system_state_journal (
          id, seq, event_name, payload_json, emitted_at
        ) VALUES (?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        nextSeq,
        input.event,
        JSON.stringify(input.payload),
        input.emittedAt,
      );
      const row = db.prepare(
        "SELECT * FROM friday_system_state_journal WHERE id = ?",
      ).get(input.id) as FridaySystemEventRecord | undefined;
      return row ? eventRowToEntity(row) : {
        id: input.id,
        seq: nextSeq,
        event: input.event,
        emittedAt: input.emittedAt,
        payload: input.payload,
      };
    },

    findLatestEventByName(db, eventName) {
      const row = db.prepare(
        `SELECT * FROM friday_system_state_journal
         WHERE event_name = ?
         ORDER BY seq DESC
         LIMIT 1`,
      ).get(eventName) as FridaySystemEventRecord | undefined;
      return row ? eventRowToEntity(row) : null;
    },

    listEvents(db, input) {
      const limit = Math.min(input?.limit ?? 100, 500);
      const afterSeq = input?.afterSeq ?? 0;
      const rows = db.prepare(
        `SELECT * FROM friday_system_state_journal
         WHERE seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
      ).all(afterSeq, limit) as FridaySystemEventRecord[];
      return rows.map(eventRowToEntity);
    },

    getLatestSeq(db) {
      const row = db.prepare(
        "SELECT MAX(seq) as max_seq FROM friday_system_state_journal",
      ).get() as { max_seq: number | null };
      return row.max_seq ?? 0;
    },

    insertControlLease(db, lease) {
      db.prepare(
        `INSERT INTO friday_system_control_leases (
          id, owner_id, owner_kind, reason, acquired_at, expires_at, revoked_at, revoked_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        lease.id,
        lease.ownerId,
        lease.ownerKind,
        lease.reason ?? null,
        lease.acquiredAt,
        lease.expiresAt ?? null,
        lease.revokedAt ?? null,
        lease.revokedReason ?? null,
      );
      const row = db.prepare(
        "SELECT * FROM friday_system_control_leases WHERE id = ?",
      ).get(lease.id) as FridaySystemControlLeaseRecord | undefined;
      return row ? controlLeaseRowToEntity(row) : lease;
    },

    revokeControlLease(db, id, revokedAt, revokedReason) {
      db.prepare(
        `UPDATE friday_system_control_leases
         SET revoked_at = ?, revoked_reason = ?
         WHERE id = ?`,
      ).run(revokedAt, revokedReason ?? null, id);
      const row = db.prepare(
        "SELECT * FROM friday_system_control_leases WHERE id = ?",
      ).get(id) as FridaySystemControlLeaseRecord | undefined;
      return row ? controlLeaseRowToEntity(row) : null;
    },

    getLatestActiveControlLease(db, nowIso) {
      const row = db.prepare(
        `SELECT * FROM friday_system_control_leases
         WHERE revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY acquired_at DESC
         LIMIT 1`,
      ).get(nowIso) as FridaySystemControlLeaseRecord | undefined;
      return row ? controlLeaseRowToEntity(row) : null;
    },
  };
}
