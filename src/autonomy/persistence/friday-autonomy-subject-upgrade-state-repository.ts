import type Database from "better-sqlite3";

import {
  defaultFridayAutonomyUpgradeFields,
  type FridayAutonomyCanaryStats,
  type FridayAutonomyUpgradeFields,
  type FridayAutonomyUpgradePatch,
  mergeFridayAutonomyUpgradeFields,
} from "../model/friday-autonomy-upgrade.types.js";
import type { FridayAutonomySubjectKind } from "../model/friday-autonomy-subject.types.js";
import { safeJsonParse } from "#utilities";

export interface FridayAutonomySubjectUpgradeState extends FridayAutonomyUpgradeFields {
  subjectKind: FridayAutonomySubjectKind;
  subjectId: string;
  createdAt: string;
  updatedAt: string;
}

interface FridayAutonomySubjectUpgradeStateRow {
  subject_kind: string;
  subject_id: string;
  last_verified_at: string | null;
  last_verified_runtime_version: string | null;
  last_verified_provider_model: string | null;
  compatibility_status: string;
  promotion_channel: string;
  shadow_version_id: string | null;
  canary_stats_json: string;
  created_at: string;
  updated_at: string;
}

export interface FridayAutonomySubjectUpgradeStateRepository {
  get(
    db: Database.Database,
    subjectKind: FridayAutonomySubjectKind,
    subjectId: string,
  ): FridayAutonomySubjectUpgradeState | null;
  list(
    db: Database.Database,
    query?: { subjectKind?: FridayAutonomySubjectKind },
  ): FridayAutonomySubjectUpgradeState[];
  setUpgradeMetadata(
    db: Database.Database,
    subjectKind: FridayAutonomySubjectKind,
    subjectId: string,
    patch: FridayAutonomyUpgradePatch,
    nowIso: string,
  ): FridayAutonomySubjectUpgradeState;
}

function rowToEntity(
  row: FridayAutonomySubjectUpgradeStateRow,
): FridayAutonomySubjectUpgradeState {
  const defaults = defaultFridayAutonomyUpgradeFields();
  const canaryStats = safeJsonParse<FridayAutonomyCanaryStats>(row.canary_stats_json);
  return {
    subjectKind: row.subject_kind as FridayAutonomySubjectKind,
    subjectId: row.subject_id,
    lastVerifiedAt: row.last_verified_at ?? undefined,
    lastVerifiedRuntimeVersion: row.last_verified_runtime_version ?? undefined,
    lastVerifiedProviderModel: row.last_verified_provider_model ?? undefined,
    compatibilityStatus: (row.compatibility_status as FridayAutonomyUpgradeFields["compatibilityStatus"] | undefined)
      ?? defaults.compatibilityStatus,
    promotionChannel: (row.promotion_channel as FridayAutonomyUpgradeFields["promotionChannel"] | undefined)
      ?? defaults.promotionChannel,
    shadowVersionId: row.shadow_version_id ?? undefined,
    canaryStats: canaryStats && Object.keys(canaryStats).length > 0 ? canaryStats : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createFridayAutonomySubjectUpgradeStateRepository(): FridayAutonomySubjectUpgradeStateRepository {
  return {
    get(db, subjectKind, subjectId) {
      const row = db.prepare(
        `SELECT *
           FROM autonomy_subject_upgrade_state
          WHERE subject_kind = ?
            AND subject_id = ?`,
      ).get(subjectKind, subjectId) as FridayAutonomySubjectUpgradeStateRow | undefined;
      return row ? rowToEntity(row) : null;
    },

    list(db, query) {
      const rows = query?.subjectKind
        ? db.prepare(
            `SELECT *
               FROM autonomy_subject_upgrade_state
              WHERE subject_kind = ?
              ORDER BY subject_id ASC`,
          ).all(query.subjectKind) as FridayAutonomySubjectUpgradeStateRow[]
        : db.prepare(
            `SELECT *
               FROM autonomy_subject_upgrade_state
              ORDER BY subject_kind ASC, subject_id ASC`,
          ).all() as FridayAutonomySubjectUpgradeStateRow[];
      return rows.map(rowToEntity);
    },

    setUpgradeMetadata(db, subjectKind, subjectId, patch, nowIso) {
      const existing = this.get(db, subjectKind, subjectId);
      const merged = mergeFridayAutonomyUpgradeFields(existing ?? undefined, patch);
      const createdAt = existing?.createdAt ?? nowIso;
      db.prepare(
        `INSERT INTO autonomy_subject_upgrade_state (
           subject_kind,
           subject_id,
           last_verified_at,
           last_verified_runtime_version,
           last_verified_provider_model,
           compatibility_status,
           promotion_channel,
           shadow_version_id,
           canary_stats_json,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(subject_kind, subject_id) DO UPDATE SET
           last_verified_at = excluded.last_verified_at,
           last_verified_runtime_version = excluded.last_verified_runtime_version,
           last_verified_provider_model = excluded.last_verified_provider_model,
           compatibility_status = excluded.compatibility_status,
           promotion_channel = excluded.promotion_channel,
           shadow_version_id = excluded.shadow_version_id,
           canary_stats_json = excluded.canary_stats_json,
           updated_at = excluded.updated_at`,
      ).run(
        subjectKind,
        subjectId,
        merged.lastVerifiedAt ?? null,
        merged.lastVerifiedRuntimeVersion ?? null,
        merged.lastVerifiedProviderModel ?? null,
        merged.compatibilityStatus,
        merged.promotionChannel,
        merged.shadowVersionId ?? null,
        JSON.stringify(merged.canaryStats ?? {}),
        createdAt,
        nowIso,
      );
      return this.get(db, subjectKind, subjectId)!;
    },
  };
}
