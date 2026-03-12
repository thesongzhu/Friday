/**
 * SQLite-backed CRUD repository for installed plugins.
 */

import type Database from "better-sqlite3";

import { FridayDomainError } from "#errors";
import type {
  FridayPluginEntity,
  FridayPluginKind,
  FridayPluginListQuery,
  FridayPluginManifest,
  FridayPluginSource,
  FridayPluginStatus,
  FridayPluginTrustMode,
  FridayUpsertPluginInput,
} from "../model/friday-plugin.types.js";
import { FRIDAY_PLUGIN_ERROR_CODES } from "../model/friday-plugin.types.js";

// ─── Types ───

export interface FridayPluginRepository {
  upsertPlugin(db: Database.Database, input: FridayUpsertPluginInput): FridayPluginEntity;
  getById(db: Database.Database, pluginId: string): FridayPluginEntity | null;
  list(db: Database.Database, query?: FridayPluginListQuery): FridayPluginEntity[];
  setStatus(db: Database.Database, pluginId: string, status: FridayPluginStatus, nowIso: string): void;
  setEnabled(db: Database.Database, pluginId: string, enabled: boolean, nowIso: string): void;
  setError(db: Database.Database, pluginId: string, errorCode: string, errorMessage: string, nowIso: string): void;
  deletePlugin(db: Database.Database, pluginId: string): void;
}

// ─── Row Mapping ───

interface FridayPluginRow {
  id: string;
  name: string;
  description: string;
  version: string;
  source: string;
  status: string;
  enabled: number;
  trust_mode: string;
  install_path: string;
  kinds_json: string;
  manifest_json: string;
  config_json: string;
  signature_algorithm: string | null;
  signature_key_id: string | null;
  signature_value: string | null;
  signature_verified: number;
  trusted_fingerprint_sha256: string | null;
  last_verified_at: string | null;
  installed_at: string;
  updated_at: string;
  last_error_code: string | null;
  last_error_message: string | null;
}

function rowToEntity(row: FridayPluginRow): FridayPluginEntity {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    source: row.source as FridayPluginSource,
    status: row.status as FridayPluginStatus,
    enabled: row.enabled === 1,
    trustMode: row.trust_mode as FridayPluginTrustMode,
    installPath: row.install_path,
    kinds: JSON.parse(row.kinds_json) as FridayPluginKind[],
    manifest: JSON.parse(row.manifest_json) as FridayPluginManifest,
    config: JSON.parse(row.config_json) as Record<string, unknown>,
    signatureAlgorithm: row.signature_algorithm,
    signatureKeyId: row.signature_key_id,
    signatureValue: row.signature_value,
    signatureVerified: row.signature_verified === 1,
    trustedFingerprintSha256: row.trusted_fingerprint_sha256,
    lastVerifiedAt: row.last_verified_at,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
  };
}

// ─── Factory ───

export function createFridayPluginRepository(): FridayPluginRepository {
  return {
    upsertPlugin(db: Database.Database, input: FridayUpsertPluginInput): FridayPluginEntity {
      const stmt = db.prepare(`
        INSERT INTO plugins (
          id, name, description, version, source, status, enabled,
          trust_mode, install_path, kinds_json, manifest_json, config_json,
          signature_algorithm, signature_key_id, signature_value, signature_verified,
          trusted_fingerprint_sha256, last_verified_at,
          installed_at, updated_at
        ) VALUES (
          @id, @name, @description, @version, @source, @status, @enabled,
          @trust_mode, @install_path, @kinds_json, @manifest_json, @config_json,
          @signature_algorithm, @signature_key_id, @signature_value, @signature_verified,
          @trusted_fingerprint_sha256, @last_verified_at,
          @installed_at, @updated_at
        )
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          version = excluded.version,
          source = excluded.source,
          status = excluded.status,
          enabled = excluded.enabled,
          trust_mode = excluded.trust_mode,
          install_path = excluded.install_path,
          kinds_json = excluded.kinds_json,
          manifest_json = excluded.manifest_json,
          config_json = excluded.config_json,
          signature_algorithm = excluded.signature_algorithm,
          signature_key_id = excluded.signature_key_id,
          signature_value = excluded.signature_value,
          signature_verified = excluded.signature_verified,
          trusted_fingerprint_sha256 = excluded.trusted_fingerprint_sha256,
          last_verified_at = excluded.last_verified_at,
          updated_at = excluded.updated_at
      `);

      stmt.run({
        id: input.id,
        name: input.name,
        description: input.description,
        version: input.version,
        source: input.source,
        status: input.status,
        enabled: input.enabled ? 1 : 0,
        trust_mode: input.trustMode,
        install_path: input.installPath,
        kinds_json: JSON.stringify(input.kinds),
        manifest_json: JSON.stringify(input.manifest),
        config_json: JSON.stringify(input.config ?? {}),
        signature_algorithm: input.signatureAlgorithm ?? null,
        signature_key_id: input.signatureKeyId ?? null,
        signature_value: input.signatureValue ?? null,
        signature_verified: input.signatureVerified ? 1 : 0,
        trusted_fingerprint_sha256: input.trustedFingerprintSha256 ?? null,
        last_verified_at: input.lastVerifiedAt ?? null,
        installed_at: input.nowIso,
        updated_at: input.nowIso,
      });

      const entity = this.getById(db, input.id);
      if (!entity) {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.NOT_FOUND,
          `Plugin ${input.id} not found after upsert`,
          { httpStatus: 500 },
        );
      }
      return entity;
    },

    getById(db: Database.Database, pluginId: string): FridayPluginEntity | null {
      const row = db.prepare("SELECT * FROM plugins WHERE id = ?").get(pluginId) as FridayPluginRow | undefined;
      return row ? rowToEntity(row) : null;
    },

    list(db: Database.Database, query?: FridayPluginListQuery): FridayPluginEntity[] {
      const conditions: string[] = [];
      const params: Record<string, unknown> = {};

      if (query?.source) {
        conditions.push("source = @source");
        params.source = query.source;
      }
      if (query?.status) {
        conditions.push("status = @status");
        params.status = query.status;
      }
      if (query?.kind) {
        conditions.push("kinds_json LIKE @kindPattern");
        params.kindPattern = `%"${query.kind}"%`;
      }
      if (query?.enabled !== undefined) {
        conditions.push("enabled = @enabled");
        params.enabled = query.enabled ? 1 : 0;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = db.prepare(`SELECT * FROM plugins ${where} ORDER BY id`).all(params) as FridayPluginRow[];
      return rows.map(rowToEntity);
    },

    setStatus(db: Database.Database, pluginId: string, status: FridayPluginStatus, nowIso: string): void {
      const result = db.prepare(
        "UPDATE plugins SET status = ?, updated_at = ? WHERE id = ?",
      ).run(status, nowIso, pluginId);
      if (result.changes === 0) {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.NOT_FOUND,
          `Plugin ${pluginId} not found`,
          { httpStatus: 404 },
        );
      }
    },

    setEnabled(db: Database.Database, pluginId: string, enabled: boolean, nowIso: string): void {
      const result = db.prepare(
        "UPDATE plugins SET enabled = ?, updated_at = ? WHERE id = ?",
      ).run(enabled ? 1 : 0, nowIso, pluginId);
      if (result.changes === 0) {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.NOT_FOUND,
          `Plugin ${pluginId} not found`,
          { httpStatus: 404 },
        );
      }
    },

    setError(db: Database.Database, pluginId: string, errorCode: string, errorMessage: string, nowIso: string): void {
      const result = db.prepare(
        "UPDATE plugins SET status = 'error', last_error_code = ?, last_error_message = ?, updated_at = ? WHERE id = ?",
      ).run(errorCode, errorMessage, nowIso, pluginId);
      if (result.changes === 0) {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.NOT_FOUND,
          `Plugin ${pluginId} not found`,
          { httpStatus: 404 },
        );
      }
    },

    deletePlugin(db: Database.Database, pluginId: string): void {
      const result = db.prepare("DELETE FROM plugins WHERE id = ?").run(pluginId);
      if (result.changes === 0) {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.NOT_FOUND,
          `Plugin ${pluginId} not found`,
          { httpStatus: 404 },
        );
      }
    },
  };
}
