import * as crypto from "node:crypto";
import type Database from "better-sqlite3";
import { FridayDomainError } from "#errors";
import { safeJsonParse } from "#utilities";
import type {
  FridayPolicyBundle,
  FridayPolicyBundleRow,
  ISODateTime,
  JsonObject,
  UUID,
} from "../model/index.js";
import { FRIDAY_RULES_ERROR_CODES } from "../api/index.js";

// ─── Input types ───

export interface CreatePolicyBundleInput {
  id: UUID;
  name: string;
  description?: string;
  priority?: number;
  enabled?: boolean;
  tags?: string[];
  source?: FridayPolicyBundle["source"];
  signatureAlgorithm?: string;
  signatureKeyId?: string;
  signatureValue?: string;
  nowIso: ISODateTime;
  changedBy?: string;
}

export interface UpdatePolicyBundleInput {
  id: UUID;
  name?: string;
  description?: string;
  priority?: number;
  enabled?: boolean;
  tags?: string[];
  etag: string;
  nowIso: ISODateTime;
  changedBy?: string;
  changeNote?: string;
}

export interface ListPolicyBundlesQuery {
  source?: string;
  enabled?: boolean;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

// ─── Repository interface ───

export interface FridayPolicyBundleRepository {
  create(db: Database.Database, input: CreatePolicyBundleInput): FridayPolicyBundle;
  getById(db: Database.Database, id: string): FridayPolicyBundle | null;
  list(db: Database.Database, query?: ListPolicyBundlesQuery): FridayPolicyBundle[];
  update(db: Database.Database, input: UpdatePolicyBundleInput): FridayPolicyBundle;
  softDelete(db: Database.Database, id: string, nowIso: string): void;
  listVersions(db: Database.Database, bundleId: string, limit?: number, offset?: number): BundleVersionRecord[];
}

export interface BundleVersionRecord {
  id: string;
  bundleId: string;
  version: number;
  snapshot: JsonObject;
  changedBy?: string;
  changeNote?: string;
  createdAt: string;
}

// ─── Row mapping ───

function bundleRowToEntity(row: FridayPolicyBundleRow): FridayPolicyBundle {
  const bundle: FridayPolicyBundle = {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    version: row.version,
    priority: row.priority,
    enabled: row.enabled === 1,
    tags: safeJsonParse<string[]>(row.tags_json) ?? [],
    source: row.source as FridayPolicyBundle["source"],
    etag: row.etag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
  };
  return bundle;
}

interface BundleVersionRow {
  id: string;
  bundle_id: string;
  version: number;
  snapshot_json: string;
  changed_by: string | null;
  change_note: string | null;
  created_at: string;
}

function versionRowToRecord(row: BundleVersionRow): BundleVersionRecord {
  return {
    id: row.id,
    bundleId: row.bundle_id,
    version: row.version,
    snapshot: safeJsonParse<JsonObject>(row.snapshot_json) ?? {},
    changedBy: row.changed_by ?? undefined,
    changeNote: row.change_note ?? undefined,
    createdAt: row.created_at,
  };
}

function generateEtag(): string {
  return crypto.randomBytes(16).toString("hex");
}

function computeChecksum(data: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(data))
    .digest("hex");
}

// ─── Factory ───

export function createFridayPolicyBundleRepository(): FridayPolicyBundleRepository {
  return {
    create(db, input) {
      const etag = generateEtag();
      const tagsJson = JSON.stringify(input.tags ?? []);
      const checksum = computeChecksum({
        name: input.name,
        priority: input.priority ?? 100,
        tags: input.tags ?? [],
      });

      db.prepare(`
        INSERT INTO rule_policy_bundles (
          id, name, description, version, priority, enabled,
          tags_json, source, signature_algorithm, signature_key_id,
          signature_value, etag, checksum, created_at, updated_at
        ) VALUES (
          @id, @name, @description, 1, @priority, @enabled,
          @tags_json, @source, @sig_alg, @sig_key, @sig_val,
          @etag, @checksum, @now, @now
        )
      `).run({
        id: input.id,
        name: input.name,
        description: input.description ?? null,
        priority: input.priority ?? 100,
        enabled: (input.enabled ?? true) ? 1 : 0,
        tags_json: tagsJson,
        source: input.source ?? "user",
        sig_alg: input.signatureAlgorithm ?? null,
        sig_key: input.signatureKeyId ?? null,
        sig_val: input.signatureValue ?? null,
        etag,
        checksum,
        now: input.nowIso,
      });

      const entity = this.getById(db, input.id);
      if (!entity) {
        throw new FridayDomainError(
          FRIDAY_RULES_ERROR_CODES.POLICY_BUNDLE_NOT_FOUND,
          `Policy bundle ${input.id} not found after create`,
          { httpStatus: 500 },
        );
      }

      // Record initial version
      db.prepare(`
        INSERT INTO rule_policy_bundle_versions (id, bundle_id, version, snapshot_json, changed_by, change_note, created_at)
        VALUES (@id, @bundle_id, @version, @snapshot_json, @changed_by, @change_note, @created_at)
      `).run({
        id: crypto.randomUUID(),
        bundle_id: input.id,
        version: 1,
        snapshot_json: JSON.stringify(entity),
        changed_by: input.changedBy ?? null,
        change_note: "Initial creation",
        created_at: input.nowIso,
      });

      return entity;
    },

    getById(db, id) {
      const row = db.prepare(
        "SELECT * FROM rule_policy_bundles WHERE id = ?",
      ).get(id) as FridayPolicyBundleRow | undefined;
      return row ? bundleRowToEntity(row) : null;
    },

    list(db, query) {
      const conditions: string[] = [];
      const params: Record<string, unknown> = {};

      if (!query?.includeDeleted) {
        conditions.push("deleted_at IS NULL");
      }
      if (query?.source) {
        conditions.push("source = @source");
        params.source = query.source;
      }
      if (query?.enabled !== undefined) {
        conditions.push("enabled = @enabled");
        params.enabled = query.enabled ? 1 : 0;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = query?.limit ?? 100;
      const offset = query?.offset ?? 0;

      const rows = db.prepare(
        `SELECT * FROM rule_policy_bundles ${where} ORDER BY priority ASC, created_at ASC LIMIT @limit OFFSET @offset`,
      ).all({ ...params, limit, offset }) as FridayPolicyBundleRow[];

      return rows.map(bundleRowToEntity);
    },

    update(db, input) {
      const current = this.getById(db, input.id);
      if (!current) {
        throw new FridayDomainError(
          FRIDAY_RULES_ERROR_CODES.POLICY_BUNDLE_NOT_FOUND,
          `Policy bundle ${input.id} not found`,
          { httpStatus: 404 },
        );
      }
      if (current.etag !== input.etag) {
        throw new FridayDomainError(
          FRIDAY_RULES_ERROR_CODES.RULE_ETAG_MISMATCH,
          `Etag mismatch for bundle ${input.id}: expected ${current.etag}, got ${input.etag}`,
          { httpStatus: 409 },
        );
      }

      const newVersion = current.version + 1;
      const newEtag = generateEtag();
      const tagsJson = input.tags ? JSON.stringify(input.tags) : JSON.stringify(current.tags);
      const checksum = computeChecksum({
        name: input.name ?? current.name,
        priority: input.priority ?? current.priority,
        tags: input.tags ?? current.tags,
      });

      db.prepare(`
        UPDATE rule_policy_bundles SET
          name = @name,
          description = @description,
          priority = @priority,
          enabled = @enabled,
          tags_json = @tags_json,
          version = @version,
          etag = @etag,
          checksum = @checksum,
          updated_at = @now
        WHERE id = @id
      `).run({
        id: input.id,
        name: input.name ?? current.name,
        description: input.description !== undefined ? (input.description ?? null) : (current.description ?? null),
        priority: input.priority ?? current.priority,
        enabled: input.enabled !== undefined ? (input.enabled ? 1 : 0) : (current.enabled ? 1 : 0),
        tags_json: tagsJson,
        version: newVersion,
        etag: newEtag,
        checksum,
        now: input.nowIso,
      });

      const updated = this.getById(db, input.id)!;

      // Record version
      db.prepare(`
        INSERT INTO rule_policy_bundle_versions (id, bundle_id, version, snapshot_json, changed_by, change_note, created_at)
        VALUES (@id, @bundle_id, @version, @snapshot_json, @changed_by, @change_note, @created_at)
      `).run({
        id: crypto.randomUUID(),
        bundle_id: input.id,
        version: newVersion,
        snapshot_json: JSON.stringify(updated),
        changed_by: input.changedBy ?? null,
        change_note: input.changeNote ?? null,
        created_at: input.nowIso,
      });

      return updated;
    },

    softDelete(db, id, nowIso) {
      const result = db.prepare(
        "UPDATE rule_policy_bundles SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
      ).run(nowIso, nowIso, id);
      if (result.changes === 0) {
        throw new FridayDomainError(
          FRIDAY_RULES_ERROR_CODES.POLICY_BUNDLE_NOT_FOUND,
          `Policy bundle ${id} not found or already deleted`,
          { httpStatus: 404 },
        );
      }
    },

    listVersions(db, bundleId, limit = 50, offset = 0) {
      const rows = db.prepare(
        "SELECT * FROM rule_policy_bundle_versions WHERE bundle_id = ? ORDER BY version DESC LIMIT ? OFFSET ?",
      ).all(bundleId, limit, offset) as BundleVersionRow[];
      return rows.map(versionRowToRecord);
    },
  };
}
