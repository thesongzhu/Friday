import type Database from "better-sqlite3";
import { safeJsonParse } from "#utilities";
import type {
  FridaySkillInstallationEntity,
  FridaySkillInstallationRow,
  FridaySkillInstallationStatus,
  UUID,
} from "../model/friday-skill-catalog.types.js";

// ─── Interface ───

export interface FridaySkillInstallationRepository {
  insertInstallation(
    db: Database.Database,
    input: {
      id: UUID;
      skillId: string;
      version: string;
      satelliteId?: string;
      status: FridaySkillInstallationStatus;
      permissionsGranted: string[];
      nowIso: string;
    },
  ): FridaySkillInstallationEntity;

  setInstallationStatus(
    db: Database.Database,
    id: UUID,
    status: FridaySkillInstallationStatus,
    nowIso: string,
  ): void;

  setInstallationError(
    db: Database.Database,
    id: UUID,
    error: string,
    nowIso: string,
  ): void;

  listBySkill(
    db: Database.Database,
    skillId: string,
  ): FridaySkillInstallationEntity[];

  listInstalledHistory(
    db: Database.Database,
    skillId: string,
    limit?: number,
  ): FridaySkillInstallationEntity[];

  listBySatelliteAndStatus(
    db: Database.Database,
    satelliteId: string,
    status: FridaySkillInstallationStatus,
  ): FridaySkillInstallationEntity[];
}

// ─── Row Mapper ───

function mapRow(row: FridaySkillInstallationRow): FridaySkillInstallationEntity {
  return {
    id: row.id,
    skillId: row.skill_id,
    version: row.version,
    satelliteId: row.satellite_id ?? undefined,
    status: row.status as FridaySkillInstallationStatus,
    permissionsGranted: safeJsonParse<string[]>(row.permissions_granted_json) ?? [],
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Factory ───

export function createFridaySkillInstallationRepository(): FridaySkillInstallationRepository {
  return {
    insertInstallation(db, input) {
      db.prepare(
        `INSERT INTO skill_installations (id, skill_id, version, satellite_id, status, permissions_granted_json, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(
        input.id,
        input.skillId,
        input.version,
        input.satelliteId ?? null,
        input.status,
        JSON.stringify(input.permissionsGranted),
        input.nowIso,
        input.nowIso,
      );

      return mapRow(
        db.prepare("SELECT * FROM skill_installations WHERE id = ?").get(input.id) as FridaySkillInstallationRow,
      );
    },

    setInstallationStatus(db, id, status, nowIso) {
      db.prepare(
        "UPDATE skill_installations SET status = ?, updated_at = ? WHERE id = ?",
      ).run(status, nowIso, id);
    },

    setInstallationError(db, id, error, nowIso) {
      db.prepare(
        "UPDATE skill_installations SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?",
      ).run(error, nowIso, id);
    },

    listBySkill(db, skillId) {
      const rows = db
        .prepare("SELECT * FROM skill_installations WHERE skill_id = ? ORDER BY created_at DESC")
        .all(skillId) as FridaySkillInstallationRow[];
      return rows.map(mapRow);
    },

    listInstalledHistory(db, skillId, limit) {
      const rows = db
        .prepare(
          "SELECT * FROM skill_installations WHERE skill_id = ? AND status = 'installed' ORDER BY created_at DESC LIMIT ?",
        )
        .all(skillId, limit ?? 10) as FridaySkillInstallationRow[];
      return rows.map(mapRow);
    },

    listBySatelliteAndStatus(db, satelliteId, status) {
      const rows = db
        .prepare(
          "SELECT * FROM skill_installations WHERE satellite_id = ? AND status = ? ORDER BY created_at DESC",
        )
        .all(satelliteId, status) as FridaySkillInstallationRow[];
      return rows.map(mapRow);
    },
  };
}
