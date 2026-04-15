> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Phase 4 Code Review Package

## Build & Test Results
- TypeScript compilation: CLEAN
- Test suite: 584 tests passed (69 test files), 0 failures

## New Files (Phase 4)

### Source Files
- `src/jobs/marketplace/friday-marketplace-sync-job.ts` (     121 lines)
- `src/jobs/marketplace/friday-marketplace-sync.types.ts` (      19 lines)
- `src/skills/marketplace-index.ts` (      20 lines)
- `src/skills/model/friday-skill-marketplace.types.ts` (     305 lines)
- `src/skills/persistence/friday-marketplace-cache-repository.ts` (     213 lines)
- `src/skills/persistence/friday-marketplace-source-repository.ts` (     137 lines)
- `src/skills/persistence/friday-skill-installation-repository.ts` (     134 lines)
- `src/skills/persistence/friday-skill-repository.ts` (     158 lines)
- `src/skills/persistence/friday-skill-version-repository.ts` (     190 lines)
- `src/skills/runtime/friday-skill-marketplace-runtime.ts` (     133 lines)
- `src/skills/runtime/friday-skill-marketplace-runtime.types.ts` (      25 lines)
- `src/skills/services/friday-marketplace-cache-service.ts` (      76 lines)
- `src/skills/services/friday-marketplace-discovery-service.ts` (      70 lines)
- `src/skills/services/friday-marketplace-http-client.ts` (      90 lines)
- `src/skills/services/friday-marketplace-source-service.ts` (      78 lines)
- `src/skills/services/friday-marketplace-sync-service.ts` (     167 lines)
- `src/skills/services/friday-skill-installation-service.ts` (     244 lines)
- `src/skills/services/friday-skill-package-installer.ts` (      71 lines)
- `src/skills/services/friday-skill-permission-check-service.ts` (      45 lines)
- `src/skills/services/friday-skill-signature-verifier.ts` (     186 lines)
- `src/skills/services/friday-skill-trust-scoring-service.ts` (     219 lines)
- `src/skills/services/friday-skill-version-resolution-service.ts` (     168 lines)

### Test Files
- `test/unit/skills/marketplace/_helpers.ts` (     111 lines)
- `test/unit/skills/marketplace/friday-marketplace-cache-repository.test.ts` (     203 lines)
- `test/unit/skills/marketplace/friday-marketplace-discovery-service.test.ts` (      91 lines)
- `test/unit/skills/marketplace/friday-marketplace-source-repository.test.ts` (     138 lines)
- `test/unit/skills/marketplace/friday-marketplace-sync-job.test.ts` (     139 lines)
- `test/unit/skills/marketplace/friday-marketplace-sync-service.test.ts` (     191 lines)
- `test/unit/skills/marketplace/friday-skill-installation-repository.test.ts` (     125 lines)
- `test/unit/skills/marketplace/friday-skill-installation-service.test.ts` (     262 lines)
- `test/unit/skills/marketplace/friday-skill-marketplace-runtime.test.ts` (     169 lines)
- `test/unit/skills/marketplace/friday-skill-signature-verifier.test.ts` (     307 lines)
- `test/unit/skills/marketplace/friday-skill-trust-scoring-service.test.ts` (     238 lines)
- `test/unit/skills/marketplace/friday-skill-version-repository.test.ts` (     139 lines)
- `test/unit/skills/marketplace/friday-skill-version-resolution-service.test.ts` (     172 lines)

## Source Code

### `src/jobs/marketplace/friday-marketplace-sync-job.ts`
```ts
import type { FridayMarketplaceSyncService } from "../../skills/services/friday-marketplace-sync-service.js";
import type { FridayMarketplaceCacheService } from "../../skills/services/friday-marketplace-cache-service.js";
import type {
  FridayMarketplaceSyncJobConfig,
  FridayMarketplaceSyncJobResult,
} from "./friday-marketplace-sync.types.js";
import { FRIDAY_DEFAULT_SYNC_JOB_CONFIG } from "./friday-marketplace-sync.types.js";

// ─── Interface ───

export interface FridayMarketplaceSyncJob {
  /** Run a single sync cycle. */
  runOnce(): Promise<FridayMarketplaceSyncJobResult>;
  /** Start the periodic sync loop. */
  start(): void;
  /** Stop the periodic sync loop. */
  stop(): void;
  /** Whether the job loop is currently active. */
  isRunning(): boolean;
}

// ─── Dependencies ───

export interface CreateMarketplaceSyncJobDeps {
  syncService: FridayMarketplaceSyncService;
  cacheService: FridayMarketplaceCacheService;
  config?: FridayMarketplaceSyncJobConfig;
}

// ─── Factory ───

export function createFridayMarketplaceSyncJob(
  deps: CreateMarketplaceSyncJobDeps,
): FridayMarketplaceSyncJob {
  const config = deps.config ?? FRIDAY_DEFAULT_SYNC_JOB_CONFIG;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let consecutiveFailures = 0;

  function computeDelay(): number {
    const jitter = Math.floor(Math.random() * config.jitterMs);
    if (consecutiveFailures === 0) {
      return config.intervalMs + jitter;
    }
    // Exponential backoff on consecutive failures
    const backoff = Math.min(
      config.intervalMs * Math.pow(2, consecutiveFailures),
      config.maxBackoffMs,
    );
    return backoff + jitter;
  }

  async function runCycle(): Promise<void> {
    if (!running) return;

    try {
      await job.runOnce();
      consecutiveFailures = 0;
    } catch {
      consecutiveFailures++;
    }

    if (running) {
      timer = setTimeout(() => void runCycle(), computeDelay());
    }
  }

  const job: FridayMarketplaceSyncJob = {
    async runOnce() {
      // Prune stale cache entries first
      deps.cacheService.pruneStaleEntries();

      // Sync all enabled sources
      const results = await deps.syncService.syncAllSources();

      const allErrors: string[] = [];
      let sourcesSucceeded = 0;
      let totalSkillsSynced = 0;
      let totalVersionsSynced = 0;

      for (const r of results) {
        if (r.errors.length === 0) {
          sourcesSucceeded++;
        }
        allErrors.push(...r.errors);
        totalSkillsSynced += r.skillsSynced;
        totalVersionsSynced += r.versionsSynced;
      }

      return {
        sourcesAttempted: results.length,
        sourcesSucceeded,
        totalSkillsSynced,
        totalVersionsSynced,
        errors: allErrors,
      };
    },

    start() {
      if (running) return;
      running = true;
      consecutiveFailures = 0;
      // Start first cycle after a small initial delay
      timer = setTimeout(() => void runCycle(), 1000);
    },

    stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },

    isRunning() {
      return running;
    },
  };

  return job;
}
```

### `src/jobs/marketplace/friday-marketplace-sync.types.ts`
```ts
export interface FridayMarketplaceSyncJobConfig {
  intervalMs: number;
  jitterMs: number;
  maxBackoffMs: number;
}

export const FRIDAY_DEFAULT_SYNC_JOB_CONFIG: FridayMarketplaceSyncJobConfig = {
  intervalMs: 6 * 60 * 60 * 1000, // 6 hours
  jitterMs: 5 * 60 * 1000, // 5 minutes
  maxBackoffMs: 24 * 60 * 60 * 1000, // 24 hours
};

export interface FridayMarketplaceSyncJobResult {
  sourcesAttempted: number;
  sourcesSucceeded: number;
  totalSkillsSynced: number;
  totalVersionsSynced: number;
  errors: string[];
}
```

### `src/skills/persistence/friday-marketplace-cache-repository.ts`
```ts
import type Database from "better-sqlite3";
import type {
  FridayMarketplaceCacheRow,
  FridayMarketplaceCacheEntity,
  FridaySkillCatalogQuery,
  UUID,
  JsonValue,
} from "../model/friday-skill-marketplace.types.js";

// ─── Interface ───

export interface FridayMarketplaceCacheRepository {
  upsertCacheEntry(
    db: Database.Database,
    entry: {
      id: UUID;
      sourceId: UUID;
      skillId: string;
      version: string;
      manifestJson: string;
      signatureValid: boolean;
      indexedAt: string;
      trustScore: number;
      nowIso: string;
    },
  ): void;

  upsertCacheBatch(
    db: Database.Database,
    entries: Array<{
      id: UUID;
      sourceId: UUID;
      skillId: string;
      version: string;
      manifestJson: string;
      signatureValid: boolean;
      indexedAt: string;
      trustScore: number;
      nowIso: string;
    }>,
  ): number;

  getCachedVersion(
    db: Database.Database,
    sourceId: UUID,
    skillId: string,
    version: string,
  ): FridayMarketplaceCacheEntity | null;

  listCatalog(
    db: Database.Database,
    query: FridaySkillCatalogQuery,
  ): FridayMarketplaceCacheEntity[];

  listStaleSourceIds(
    db: Database.Database,
    staleCutoff: string,
  ): string[];

  deleteBySourceId(db: Database.Database, sourceId: UUID): number;

  pruneOlderThan(db: Database.Database, cutoff: string): number;
}

// ─── Row Mapper ───

function mapRow(row: FridayMarketplaceCacheRow): FridayMarketplaceCacheEntity {
  return {
    id: row.id,
    sourceId: row.source_id,
    skillId: row.skill_id,
    version: row.version,
    manifestJson: JSON.parse(row.manifest_json) as JsonValue,
    signatureValid: row.signature_valid === 1,
    indexedAt: row.indexed_at,
    trustScore: row.trust_score,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Factory ───

export function createFridayMarketplaceCacheRepository(): FridayMarketplaceCacheRepository {
  return {
    upsertCacheEntry(db, entry) {
      db.prepare(
        `INSERT INTO marketplace_cache (id, source_id, skill_id, version, manifest_json, signature_valid, indexed_at, trust_score, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id, skill_id, version) DO UPDATE SET
           manifest_json = excluded.manifest_json,
           signature_valid = excluded.signature_valid,
           indexed_at = excluded.indexed_at,
           trust_score = excluded.trust_score,
           updated_at = excluded.updated_at`,
      ).run(
        entry.id,
        entry.sourceId,
        entry.skillId,
        entry.version,
        entry.manifestJson,
        entry.signatureValid ? 1 : 0,
        entry.indexedAt,
        entry.trustScore,
        entry.nowIso,
        entry.nowIso,
      );
    },

    upsertCacheBatch(db, entries) {
      const stmt = db.prepare(
        `INSERT INTO marketplace_cache (id, source_id, skill_id, version, manifest_json, signature_valid, indexed_at, trust_score, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id, skill_id, version) DO UPDATE SET
           manifest_json = excluded.manifest_json,
           signature_valid = excluded.signature_valid,
           indexed_at = excluded.indexed_at,
           trust_score = excluded.trust_score,
           updated_at = excluded.updated_at`,
      );

      let count = 0;
      for (const entry of entries) {
        stmt.run(
          entry.id,
          entry.sourceId,
          entry.skillId,
          entry.version,
          entry.manifestJson,
          entry.signatureValid ? 1 : 0,
          entry.indexedAt,
          entry.trustScore,
          entry.nowIso,
          entry.nowIso,
        );
        count++;
      }
      return count;
    },

    getCachedVersion(db, sourceId, skillId, version) {
      const row = db
        .prepare(
          "SELECT * FROM marketplace_cache WHERE source_id = ? AND skill_id = ? AND version = ?",
        )
        .get(sourceId, skillId, version) as FridayMarketplaceCacheRow | undefined;
      return row ? mapRow(row) : null;
    },

    listCatalog(db, query) {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (query.sourceId) {
        conditions.push("mc.source_id = ?");
        params.push(query.sourceId);
      }

      // Only show cache entries from enabled sources unless sourceId explicitly given
      if (!query.sourceId) {
        conditions.push("ms.enabled = 1");
      }

      if (query.q) {
        conditions.push("(mc.skill_id LIKE ? OR mc.manifest_json LIKE ?)");
        const pattern = `%${query.q}%`;
        params.push(pattern, pattern);
      }

      if (query.category) {
        conditions.push("mc.manifest_json LIKE ?");
        params.push(`%"category":"${query.category}"%`);
      }

      const limit = query.limit ?? 50;
      const offset = query.cursor ? parseInt(query.cursor, 10) : 0;

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const sql = `SELECT mc.* FROM marketplace_cache mc
        JOIN marketplace_sources ms ON ms.id = mc.source_id
        ${whereClause}
        ORDER BY mc.trust_score DESC, mc.indexed_at DESC
        LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const rows = db.prepare(sql).all(...params) as FridayMarketplaceCacheRow[];
      return rows.map(mapRow);
    },

    listStaleSourceIds(db, staleCutoff) {
      const rows = db
        .prepare(
          `SELECT DISTINCT source_id FROM marketplace_cache
           WHERE indexed_at < ?`,
        )
        .all(staleCutoff) as Array<{ source_id: string }>;
      return rows.map((r) => r.source_id);
    },

    deleteBySourceId(db, sourceId) {
      return db
        .prepare("DELETE FROM marketplace_cache WHERE source_id = ?")
        .run(sourceId).changes;
    },

    pruneOlderThan(db, cutoff) {
      return db
        .prepare("DELETE FROM marketplace_cache WHERE indexed_at < ?")
        .run(cutoff).changes;
    },
  };
}
```

### `src/skills/persistence/friday-marketplace-source-repository.ts`
```ts
import type Database from "better-sqlite3";
import type {
  FridayMarketplaceSourceRow,
  FridayMarketplaceSourceEntity,
  FridayMarketplaceSourceCreateInput,
  FridayMarketplaceSourcePatchInput,
  FridayMarketplaceTrustPolicy,
  UUID,
} from "../model/friday-skill-marketplace.types.js";

// ─── Interface ───

export interface FridayMarketplaceSourceRepository {
  insertSource(
    db: Database.Database,
    id: UUID,
    input: FridayMarketplaceSourceCreateInput,
    nowIso: string,
  ): FridayMarketplaceSourceEntity;

  getSourceById(
    db: Database.Database,
    id: UUID,
  ): FridayMarketplaceSourceEntity | null;

  listSources(
    db: Database.Database,
    enabledOnly?: boolean,
  ): FridayMarketplaceSourceEntity[];

  updateSource(
    db: Database.Database,
    id: UUID,
    patch: FridayMarketplaceSourcePatchInput,
    nowIso: string,
  ): FridayMarketplaceSourceEntity;

  setEnabled(
    db: Database.Database,
    id: UUID,
    enabled: boolean,
    nowIso: string,
  ): void;

  deleteSource(db: Database.Database, id: UUID): void;
}

// ─── Row Mapper ───

function mapRow(row: FridayMarketplaceSourceRow): FridayMarketplaceSourceEntity {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    enabled: row.enabled === 1,
    trustPolicy: row.trust_policy as FridayMarketplaceTrustPolicy,
    pinnedKeyIds: JSON.parse(row.pinned_key_ids_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Factory ───

export function createFridayMarketplaceSourceRepository(): FridayMarketplaceSourceRepository {
  return {
    insertSource(db, id, input, nowIso) {
      db.prepare(
        `INSERT INTO marketplace_sources (id, name, base_url, enabled, trust_policy, pinned_key_ids_json, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
      ).run(
        id,
        input.name,
        input.baseUrl,
        input.trustPolicy,
        JSON.stringify(input.pinnedKeyIds),
        nowIso,
        nowIso,
      );

      return mapRow(
        db.prepare("SELECT * FROM marketplace_sources WHERE id = ?").get(id) as FridayMarketplaceSourceRow,
      );
    },

    getSourceById(db, id) {
      const row = db
        .prepare("SELECT * FROM marketplace_sources WHERE id = ?")
        .get(id) as FridayMarketplaceSourceRow | undefined;
      return row ? mapRow(row) : null;
    },

    listSources(db, enabledOnly) {
      const sql = enabledOnly
        ? "SELECT * FROM marketplace_sources WHERE enabled = 1 ORDER BY name"
        : "SELECT * FROM marketplace_sources ORDER BY name";
      const rows = db.prepare(sql).all() as FridayMarketplaceSourceRow[];
      return rows.map(mapRow);
    },

    updateSource(db, id, patch, nowIso) {
      db.prepare(
        `UPDATE marketplace_sources SET
         name = COALESCE(?, name),
         base_url = COALESCE(?, base_url),
         enabled = COALESCE(?, enabled),
         trust_policy = COALESCE(?, trust_policy),
         pinned_key_ids_json = COALESCE(?, pinned_key_ids_json),
         updated_at = ?
         WHERE id = ?`,
      ).run(
        patch.name ?? null,
        patch.baseUrl ?? null,
        patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : null,
        patch.trustPolicy ?? null,
        patch.pinnedKeyIds ? JSON.stringify(patch.pinnedKeyIds) : null,
        nowIso,
        id,
      );

      return mapRow(
        db.prepare("SELECT * FROM marketplace_sources WHERE id = ?").get(id) as FridayMarketplaceSourceRow,
      );
    },

    setEnabled(db, id, enabled, nowIso) {
      db.prepare(
        "UPDATE marketplace_sources SET enabled = ?, updated_at = ? WHERE id = ?",
      ).run(enabled ? 1 : 0, nowIso, id);
    },

    deleteSource(db, id) {
      db.prepare("DELETE FROM marketplace_cache WHERE source_id = ?").run(id);
      db.prepare("DELETE FROM marketplace_sources WHERE id = ?").run(id);
    },
  };
}
```

### `src/skills/persistence/friday-skill-installation-repository.ts`
```ts
import type Database from "better-sqlite3";
import type {
  FridaySkillInstallationRow,
  FridaySkillInstallationEntity,
  FridaySkillInstallationStatus,
  UUID,
} from "../model/friday-skill-marketplace.types.js";

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
    permissionsGranted: JSON.parse(row.permissions_granted_json) as string[],
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
```

### `src/skills/persistence/friday-skill-repository.ts`
```ts
import type Database from "better-sqlite3";
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import type { SkillLifecycleStatus } from "../model/friday-skill-lifecycle.types.js";
import type { SkillSource } from "../model/friday-skill-source.types.js";
import type { SkillOrigin } from "../model/friday-skill-source.types.js";
import type {
  FridaySkillRow,
  FridaySkillEntity,
  UUID,
} from "../model/friday-skill-marketplace.types.js";

// ─── Interface ───

export interface FridaySkillRepository {
  upsertSkillFromMarketplace(
    db: Database.Database,
    input: {
      id: string;
      name: string;
      source: SkillSource;
      origin: SkillOrigin;
      publisher?: string;
      latestVersion?: string;
      status: SkillLifecycleStatus;
      currentManifest?: SkillManifestV2;
      nowIso: string;
    },
  ): FridaySkillEntity;

  updateLifecycleStatus(
    db: Database.Database,
    skillId: string,
    status: SkillLifecycleStatus,
    nowIso: string,
  ): void;

  setInstalledVersion(
    db: Database.Database,
    skillId: string,
    version: string,
    manifest: SkillManifestV2,
    nowIso: string,
  ): void;

  clearInstalledVersion(
    db: Database.Database,
    skillId: string,
    nowIso: string,
  ): void;

  getSkillById(
    db: Database.Database,
    skillId: string,
  ): FridaySkillEntity | null;

  listInstalled(db: Database.Database): FridaySkillEntity[];
}

// ─── Row Mapper ───

function mapRow(row: FridaySkillRow): FridaySkillEntity {
  return {
    id: row.id,
    name: row.name,
    source: row.source as SkillSource,
    origin: row.origin as SkillOrigin,
    publisher: row.publisher ?? undefined,
    latestVersion: row.latest_version ?? undefined,
    installedVersion: row.installed_version ?? undefined,
    status: row.status as SkillLifecycleStatus,
    currentManifest: row.current_manifest_json
      ? (JSON.parse(row.current_manifest_json) as SkillManifestV2)
      : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
    deletedBy: row.deleted_by ?? undefined,
  };
}

// ─── Factory ───

export function createFridaySkillRepository(): FridaySkillRepository {
  return {
    upsertSkillFromMarketplace(db, input) {
      db.prepare(
        `INSERT INTO skills (id, name, source, origin, publisher, latest_version, installed_version, status, current_manifest_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           publisher = excluded.publisher,
           latest_version = excluded.latest_version,
           status = CASE WHEN skills.installed_version IS NOT NULL THEN skills.status ELSE excluded.status END,
           current_manifest_json = CASE WHEN skills.current_manifest_json IS NOT NULL THEN skills.current_manifest_json ELSE excluded.current_manifest_json END,
           updated_at = excluded.updated_at`,
      ).run(
        input.id,
        input.name,
        input.source,
        input.origin,
        input.publisher ?? null,
        input.latestVersion ?? null,
        input.status,
        input.currentManifest ? JSON.stringify(input.currentManifest) : null,
        input.nowIso,
        input.nowIso,
      );

      return mapRow(
        db.prepare("SELECT * FROM skills WHERE id = ?").get(input.id) as FridaySkillRow,
      );
    },

    updateLifecycleStatus(db, skillId, status, nowIso) {
      db.prepare(
        "UPDATE skills SET status = ?, updated_at = ? WHERE id = ?",
      ).run(status, nowIso, skillId);
    },

    setInstalledVersion(db, skillId, version, manifest, nowIso) {
      db.prepare(
        `UPDATE skills SET
         installed_version = ?,
         status = 'installed',
         current_manifest_json = ?,
         updated_at = ?
         WHERE id = ?`,
      ).run(version, JSON.stringify(manifest), nowIso, skillId);
    },

    clearInstalledVersion(db, skillId, nowIso) {
      db.prepare(
        `UPDATE skills SET
         installed_version = NULL,
         status = 'not_installed',
         current_manifest_json = NULL,
         updated_at = ?
         WHERE id = ?`,
      ).run(nowIso, skillId);
    },

    getSkillById(db, skillId) {
      const row = db
        .prepare("SELECT * FROM skills WHERE id = ? AND deleted_at IS NULL")
        .get(skillId) as FridaySkillRow | undefined;
      return row ? mapRow(row) : null;
    },

    listInstalled(db) {
      const rows = db
        .prepare(
          "SELECT * FROM skills WHERE installed_version IS NOT NULL AND deleted_at IS NULL ORDER BY name",
        )
        .all() as FridaySkillRow[];
      return rows.map(mapRow);
    },
  };
}
```

### `src/skills/persistence/friday-skill-version-repository.ts`
```ts
import type Database from "better-sqlite3";
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import type {
  FridaySkillVersionRow,
  FridaySkillVersionEntity,
  FridaySkillSignature,
  FridayMarketplaceSignatureAlgorithm,
  UUID,
} from "../model/friday-skill-marketplace.types.js";

// ─── Interface ───

export interface FridaySkillVersionRepository {
  upsertVersion(
    db: Database.Database,
    input: {
      id: UUID;
      skillId: string;
      version: string;
      checksum: string;
      packageUrl?: string;
      signature?: FridaySkillSignature;
      manifest: SkillManifestV2;
      releasedAt: string;
      nowIso: string;
    },
  ): FridaySkillVersionEntity;

  getVersion(
    db: Database.Database,
    skillId: string,
    version: string,
  ): FridaySkillVersionEntity | null;

  listVersions(
    db: Database.Database,
    skillId: string,
    limit?: number,
  ): FridaySkillVersionEntity[];

  listVersionsForResolution(
    db: Database.Database,
    skillId: string,
    includeYanked?: boolean,
  ): FridaySkillVersionEntity[];

  markYanked(
    db: Database.Database,
    skillId: string,
    version: string,
    nowIso: string,
  ): void;

  clearYanked(
    db: Database.Database,
    skillId: string,
    version: string,
    nowIso: string,
  ): void;

  setSignatureFields(
    db: Database.Database,
    skillId: string,
    version: string,
    signature: FridaySkillSignature,
    nowIso: string,
  ): void;
}

// ─── Row Mapper ───

function mapRow(row: FridaySkillVersionRow): FridaySkillVersionEntity {
  const signature: FridaySkillSignature | undefined =
    row.signature_key_id && row.signature_algorithm && row.signature_value
      ? {
          keyId: row.signature_key_id,
          algorithm: row.signature_algorithm as FridayMarketplaceSignatureAlgorithm,
          value: row.signature_value,
        }
      : undefined;

  return {
    id: row.id,
    skillId: row.skill_id,
    version: row.version,
    checksum: row.checksum,
    packageUrl: row.package_url ?? undefined,
    signature,
    manifest: JSON.parse(row.manifest_json) as SkillManifestV2,
    releasedAt: row.released_at,
    yankedAt: row.yanked_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Factory ───

export function createFridaySkillVersionRepository(): FridaySkillVersionRepository {
  return {
    upsertVersion(db, input) {
      db.prepare(
        `INSERT INTO skill_versions (id, skill_id, version, checksum, package_url, signature_key_id, signature_algorithm, signature_value, manifest_json, released_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(skill_id, version) DO UPDATE SET
           checksum = excluded.checksum,
           package_url = excluded.package_url,
           signature_key_id = excluded.signature_key_id,
           signature_algorithm = excluded.signature_algorithm,
           signature_value = excluded.signature_value,
           manifest_json = excluded.manifest_json,
           released_at = excluded.released_at,
           updated_at = excluded.updated_at`,
      ).run(
        input.id,
        input.skillId,
        input.version,
        input.checksum,
        input.packageUrl ?? null,
        input.signature?.keyId ?? null,
        input.signature?.algorithm ?? null,
        input.signature?.value ?? null,
        JSON.stringify(input.manifest),
        input.releasedAt,
        input.nowIso,
        input.nowIso,
      );

      return mapRow(
        db
          .prepare("SELECT * FROM skill_versions WHERE skill_id = ? AND version = ?")
          .get(input.skillId, input.version) as FridaySkillVersionRow,
      );
    },

    getVersion(db, skillId, version) {
      const row = db
        .prepare("SELECT * FROM skill_versions WHERE skill_id = ? AND version = ?")
        .get(skillId, version) as FridaySkillVersionRow | undefined;
      return row ? mapRow(row) : null;
    },

    listVersions(db, skillId, limit) {
      const rows = db
        .prepare(
          "SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY released_at DESC LIMIT ?",
        )
        .all(skillId, limit ?? 50) as FridaySkillVersionRow[];
      return rows.map(mapRow);
    },

    listVersionsForResolution(db, skillId, includeYanked) {
      const sql = includeYanked
        ? "SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY released_at DESC"
        : "SELECT * FROM skill_versions WHERE skill_id = ? AND yanked_at IS NULL ORDER BY released_at DESC";
      const rows = db.prepare(sql).all(skillId) as FridaySkillVersionRow[];
      return rows.map(mapRow);
    },

    markYanked(db, skillId, version, nowIso) {
      db.prepare(
        "UPDATE skill_versions SET yanked_at = ?, updated_at = ? WHERE skill_id = ? AND version = ?",
      ).run(nowIso, nowIso, skillId, version);
    },

    clearYanked(db, skillId, version, nowIso) {
      db.prepare(
        "UPDATE skill_versions SET yanked_at = NULL, updated_at = ? WHERE skill_id = ? AND version = ?",
      ).run(nowIso, skillId, version);
    },

    setSignatureFields(db, skillId, version, signature, nowIso) {
      db.prepare(
        `UPDATE skill_versions SET
         signature_key_id = ?,
         signature_algorithm = ?,
         signature_value = ?,
         updated_at = ?
         WHERE skill_id = ? AND version = ?`,
      ).run(
        signature.keyId,
        signature.algorithm,
        signature.value,
        nowIso,
        skillId,
        version,
      );
    },
  };
}
```

### `src/skills/runtime/friday-skill-marketplace-runtime.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FetchFn } from "../services/friday-marketplace-http-client.js";
import type { FridaySkillMarketplaceRuntime } from "./friday-skill-marketplace-runtime.types.js";

import { createFridayMarketplaceSourceRepository } from "../persistence/friday-marketplace-source-repository.js";
import { createFridayMarketplaceCacheRepository } from "../persistence/friday-marketplace-cache-repository.js";
import { createFridaySkillRepository } from "../persistence/friday-skill-repository.js";
import { createFridaySkillVersionRepository } from "../persistence/friday-skill-version-repository.js";
import { createFridaySkillInstallationRepository } from "../persistence/friday-skill-installation-repository.js";

import { createFridayMarketplaceHttpClient } from "../services/friday-marketplace-http-client.js";
import { createFridayMarketplaceSourceService } from "../services/friday-marketplace-source-service.js";
import { createFridayMarketplaceCacheService } from "../services/friday-marketplace-cache-service.js";
import { createFridayMarketplaceDiscoveryService } from "../services/friday-marketplace-discovery-service.js";
import { createFridayMarketplaceSyncService } from "../services/friday-marketplace-sync-service.js";
import { createFridaySkillSignatureVerifier } from "../services/friday-skill-signature-verifier.js";
import { createFridaySkillTrustScoringService } from "../services/friday-skill-trust-scoring-service.js";
import { createFridaySkillVersionResolutionService } from "../services/friday-skill-version-resolution-service.js";
import { createFridaySkillPermissionCheckService } from "../services/friday-skill-permission-check-service.js";
import { createFridaySkillPackageInstaller } from "../services/friday-skill-package-installer.js";
import { createFridaySkillInstallationService } from "../services/friday-skill-installation-service.js";
import { createFridayMarketplaceSyncJob } from "../../jobs/marketplace/friday-marketplace-sync-job.js";

// ─── Dependencies ───

export interface CreateSkillMarketplaceRuntimeDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
  fetchFn: FetchFn;
  managedSkillsDir: string;
  publishEvent?: (event: string, payload: unknown) => Promise<void>;
}

// ─── Factory ───

export function createFridaySkillMarketplaceRuntime(
  deps: CreateSkillMarketplaceRuntimeDeps,
): FridaySkillMarketplaceRuntime {
  // 1. Repositories
  const sourceRepo = createFridayMarketplaceSourceRepository();
  const cacheRepo = createFridayMarketplaceCacheRepository();
  const skillRepo = createFridaySkillRepository();
  const versionRepo = createFridaySkillVersionRepository();
  const installationRepo = createFridaySkillInstallationRepository();

  // 2. Infrastructure services
  const httpClient = createFridayMarketplaceHttpClient({ fetchFn: deps.fetchFn });
  const signatureVerifier = createFridaySkillSignatureVerifier();
  const trustScoring = createFridaySkillTrustScoringService();
  const permissionCheck = createFridaySkillPermissionCheckService();
  const packageInstaller = createFridaySkillPackageInstaller({
    managedSkillsDir: deps.managedSkillsDir,
  });

  // 3. Source management
  const sources = createFridayMarketplaceSourceService({
    db: deps.db,
    sourceRepo,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  // 4. Cache management
  const cache = createFridayMarketplaceCacheService({
    db: deps.db,
    cacheRepo,
    nowIso: deps.nowIso,
  });

  // 5. Discovery
  const discovery = createFridayMarketplaceDiscoveryService({
    db: deps.db,
    cacheRepo,
  });

  // 6. Sync
  const sync = createFridayMarketplaceSyncService({
    db: deps.db,
    sourceRepo,
    cacheRepo,
    skillRepo,
    versionRepo,
    httpClient,
    trustScoring,
    signatureVerifier,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  // 7. Version resolution
  const versions = createFridaySkillVersionResolutionService({
    db: deps.db,
    versionRepo,
    installationRepo,
    cacheRepo,
  });

  // 8. Installation pipeline
  const installations = createFridaySkillInstallationService({
    db: deps.db,
    skillRepo,
    installationRepo,
    sourceRepo,
    versionResolver: versions,
    signatureVerifier,
    trustScoring,
    permissionCheck,
    packageInstaller,
    httpClient,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
    publishEvent: deps.publishEvent,
  });

  // 9. Sync job
  const syncJob = createFridayMarketplaceSyncJob({
    syncService: sync,
    cacheService: cache,
  });

  return {
    sources,
    discovery,
    cache,
    sync,
    versions,
    installations,
    verify: signatureVerifier,
    trust: trustScoring,
    syncJob,
  };
}
```

### `src/skills/runtime/friday-skill-marketplace-runtime.types.ts`
```ts
import type { FridayMarketplaceSourceService } from "../services/friday-marketplace-source-service.js";
import type { FridayMarketplaceDiscoveryService } from "../services/friday-marketplace-discovery-service.js";
import type { FridayMarketplaceCacheService } from "../services/friday-marketplace-cache-service.js";
import type { FridayMarketplaceSyncService } from "../services/friday-marketplace-sync-service.js";
import type { FridaySkillVersionResolutionService } from "../services/friday-skill-version-resolution-service.js";
import type { FridaySkillInstallationService } from "../services/friday-skill-installation-service.js";
import type { FridaySkillSignatureVerifier } from "../services/friday-skill-signature-verifier.js";
import type { FridaySkillTrustScoringService } from "../services/friday-skill-trust-scoring-service.js";
import type { FridayMarketplaceSyncJob } from "../../jobs/marketplace/friday-marketplace-sync-job.js";

/**
 * Composite runtime surface for the Skill Marketplace subsystem.
 * Follows the same composition pattern as FridayWorkflowRuntime.
 */
export interface FridaySkillMarketplaceRuntime {
  sources: FridayMarketplaceSourceService;
  discovery: FridayMarketplaceDiscoveryService;
  cache: FridayMarketplaceCacheService;
  sync: FridayMarketplaceSyncService;
  versions: FridaySkillVersionResolutionService;
  installations: FridaySkillInstallationService;
  verify: FridaySkillSignatureVerifier;
  trust: FridaySkillTrustScoringService;
  syncJob: FridayMarketplaceSyncJob;
}
```

### `src/skills/services/friday-marketplace-cache-service.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayMarketplaceCacheRepository } from "../persistence/friday-marketplace-cache-repository.js";

// ─── Interface ───

export interface FridayMarketplaceCacheService {
  /** Returns source IDs that have stale cache entries (older than freshTtlHours). */
  getStaleSourceIds(): string[];
  /** Prune cache entries older than pruneDays. */
  pruneStaleEntries(): number;
  /** Delete all cache entries for a specific source. */
  clearSourceCache(sourceId: string): number;
}

// ─── Config ───

export interface FridayMarketplaceCacheTtlConfig {
  freshTtlHours: number;
  staleServeTtlHours: number;
  pruneDays: number;
}

export const FRIDAY_DEFAULT_CACHE_TTL: FridayMarketplaceCacheTtlConfig = {
  freshTtlHours: 6,
  staleServeTtlHours: 24,
  pruneDays: 30,
};

// ─── Dependencies ───

export interface CreateMarketplaceCacheServiceDeps {
  db: FridaySqliteLayer;
  cacheRepo: FridayMarketplaceCacheRepository;
  nowIso: () => string;
  ttlConfig?: FridayMarketplaceCacheTtlConfig;
}

// ─── Factory ───

export function createFridayMarketplaceCacheService(
  deps: CreateMarketplaceCacheServiceDeps,
): FridayMarketplaceCacheService {
  const config = deps.ttlConfig ?? FRIDAY_DEFAULT_CACHE_TTL;

  function subtractHours(isoDate: string, hours: number): string {
    const ms = new Date(isoDate).getTime() - hours * 60 * 60 * 1000;
    return new Date(ms).toISOString();
  }

  function subtractDays(isoDate: string, days: number): string {
    const ms = new Date(isoDate).getTime() - days * 24 * 60 * 60 * 1000;
    return new Date(ms).toISOString();
  }

  return {
    getStaleSourceIds() {
      const cutoff = subtractHours(deps.nowIso(), config.freshTtlHours);
      return deps.db.withReadConnection((conn) =>
        deps.cacheRepo.listStaleSourceIds(conn, cutoff),
      );
    },

    pruneStaleEntries() {
      const cutoff = subtractDays(deps.nowIso(), config.pruneDays);
      return deps.db.withWriteTransaction((conn) =>
        deps.cacheRepo.pruneOlderThan(conn, cutoff),
      );
    },

    clearSourceCache(sourceId) {
      return deps.db.withWriteTransaction((conn) =>
        deps.cacheRepo.deleteBySourceId(conn, sourceId),
      );
    },
  };
}
```

### `src/skills/services/friday-marketplace-discovery-service.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayMarketplaceCacheRepository } from "../persistence/friday-marketplace-cache-repository.js";
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import type {
  FridaySkillCatalogQuery,
  FridaySkillCatalogItem,
  FridayMarketplaceCacheEntity,
} from "../model/friday-skill-marketplace.types.js";

// ─── Interface ───

export interface FridayMarketplaceDiscoveryService {
  search(query: FridaySkillCatalogQuery): FridaySkillCatalogResult;
}

export interface FridaySkillCatalogResult {
  items: FridaySkillCatalogItem[];
  nextCursor?: string;
  total: number;
}

// ─── Dependencies ───

export interface CreateMarketplaceDiscoveryServiceDeps {
  db: FridaySqliteLayer;
  cacheRepo: FridayMarketplaceCacheRepository;
}

// ─── Factory ───

export function createFridayMarketplaceDiscoveryService(
  deps: CreateMarketplaceDiscoveryServiceDeps,
): FridayMarketplaceDiscoveryService {
  function cacheEntityToCatalogItem(entity: FridayMarketplaceCacheEntity): FridaySkillCatalogItem {
    const manifest = entity.manifestJson as unknown as SkillManifestV2;
    return {
      sourceId: entity.sourceId,
      skillId: entity.skillId,
      skillName: manifest?.name ?? entity.skillId,
      publisher: manifest?.author?.name,
      version: entity.version,
      category: manifest?.category,
      releasedAt: entity.indexedAt,
      signatureValid: entity.signatureValid,
      trustScore: entity.trustScore,
      manifest,
    };
  }

  return {
    search(query) {
      const limit = query.limit ?? 50;
      const entities = deps.db.withReadConnection((conn) =>
        deps.cacheRepo.listCatalog(conn, { ...query, limit: limit + 1 }),
      );

      const hasMore = entities.length > limit;
      const items = (hasMore ? entities.slice(0, limit) : entities).map(cacheEntityToCatalogItem);

      const offset = query.cursor ? parseInt(query.cursor, 10) : 0;
      const nextCursor = hasMore ? String(offset + limit) : undefined;

      return {
        items,
        nextCursor,
        total: items.length,
      };
    },
  };
}
```

### `src/skills/services/friday-marketplace-http-client.ts`
```ts
import type {
  FridayMarketplaceIndexDocument,
  FridayMarketplaceSignatureDocument,
  FridayMarketplacePublisherKeyDocument,
} from "../model/friday-skill-marketplace.types.js";

// ─── Interface ───

export interface FridayMarketplaceHttpClient {
  fetchIndex(baseUrl: string): Promise<FridayMarketplaceIndexDocument>;
  fetchManifest(url: string): Promise<unknown>;
  fetchSignature(url: string): Promise<FridayMarketplaceSignatureDocument>;
  fetchPublisherKey(baseUrl: string, keyId: string): Promise<FridayMarketplacePublisherKeyDocument>;
  fetchPackage(url: string): Promise<Buffer>;
}

// ─── Types ───

export type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface CreateMarketplaceHttpClientDeps {
  fetchFn: FetchFn;
  timeoutMs?: number;
}

// ─── Factory ───

export function createFridayMarketplaceHttpClient(
  deps: CreateMarketplaceHttpClientDeps,
): FridayMarketplaceHttpClient {
  const timeoutMs = deps.timeoutMs ?? 30_000;

  async function fetchJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await deps.fetchFn(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching ${url}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchBytes(url: string): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await deps.fetchFn(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching ${url}`);
      }
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    fetchIndex(baseUrl) {
      const url = `${baseUrl.replace(/\/$/, "")}/index.json`;
      return fetchJson<FridayMarketplaceIndexDocument>(url);
    },

    fetchManifest(url) {
      return fetchJson<unknown>(url);
    },

    fetchSignature(url) {
      return fetchJson<FridayMarketplaceSignatureDocument>(url);
    },

    fetchPublisherKey(baseUrl, keyId) {
      const url = `${baseUrl.replace(/\/$/, "")}/keys/${encodeURIComponent(keyId)}`;
      return fetchJson<FridayMarketplacePublisherKeyDocument>(url);
    },

    fetchPackage(url) {
      return fetchBytes(url);
    },
  };
}
```

### `src/skills/services/friday-marketplace-source-service.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayMarketplaceSourceRepository } from "../persistence/friday-marketplace-source-repository.js";
import type {
  FridayMarketplaceSourceEntity,
  FridayMarketplaceSourceCreateInput,
  FridayMarketplaceSourcePatchInput,
} from "../model/friday-skill-marketplace.types.js";

// ─── Interface ───

export interface FridayMarketplaceSourceService {
  addSource(input: FridayMarketplaceSourceCreateInput): FridayMarketplaceSourceEntity;
  getSource(id: string): FridayMarketplaceSourceEntity | null;
  listSources(enabledOnly?: boolean): FridayMarketplaceSourceEntity[];
  updateSource(id: string, patch: FridayMarketplaceSourcePatchInput): FridayMarketplaceSourceEntity;
  enableSource(id: string): void;
  disableSource(id: string): void;
  removeSource(id: string): void;
}

// ─── Dependencies ───

export interface CreateMarketplaceSourceServiceDeps {
  db: FridaySqliteLayer;
  sourceRepo: FridayMarketplaceSourceRepository;
  idGenerator: () => string;
  nowIso: () => string;
}

// ─── Factory ───

export function createFridayMarketplaceSourceService(
  deps: CreateMarketplaceSourceServiceDeps,
): FridayMarketplaceSourceService {
  return {
    addSource(input) {
      return deps.db.withWriteTransaction((conn) =>
        deps.sourceRepo.insertSource(conn, deps.idGenerator(), input, deps.nowIso()),
      );
    },

    getSource(id) {
      return deps.db.withReadConnection((conn) =>
        deps.sourceRepo.getSourceById(conn, id),
      );
    },

    listSources(enabledOnly) {
      return deps.db.withReadConnection((conn) =>
        deps.sourceRepo.listSources(conn, enabledOnly),
      );
    },

    updateSource(id, patch) {
      return deps.db.withWriteTransaction((conn) =>
        deps.sourceRepo.updateSource(conn, id, patch, deps.nowIso()),
      );
    },

    enableSource(id) {
      deps.db.withWriteTransaction((conn) =>
        deps.sourceRepo.setEnabled(conn, id, true, deps.nowIso()),
      );
    },

    disableSource(id) {
      deps.db.withWriteTransaction((conn) =>
        deps.sourceRepo.setEnabled(conn, id, false, deps.nowIso()),
      );
    },

    removeSource(id) {
      deps.db.withWriteTransaction((conn) =>
        deps.sourceRepo.deleteSource(conn, id),
      );
    },
  };
}
```

### `src/skills/services/friday-marketplace-sync-service.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayMarketplaceSourceRepository } from "../persistence/friday-marketplace-source-repository.js";
import type { FridayMarketplaceCacheRepository } from "../persistence/friday-marketplace-cache-repository.js";
import type { FridaySkillRepository } from "../persistence/friday-skill-repository.js";
import type { FridaySkillVersionRepository } from "../persistence/friday-skill-version-repository.js";
import type { FridayMarketplaceHttpClient } from "./friday-marketplace-http-client.js";
import type { FridaySkillTrustScoringService } from "./friday-skill-trust-scoring-service.js";
import type { FridaySkillSignatureVerifier } from "./friday-skill-signature-verifier.js";
import type {
  FridayMarketplaceSourceEntity,
  FridayMarketplaceIndexDocument,
} from "../model/friday-skill-marketplace.types.js";

// ─── Interface ───

export interface FridayMarketplaceSyncService {
  /** Sync all enabled sources. Returns per-source results. */
  syncAllSources(): Promise<FridaySyncResult[]>;
  /** Sync a single source by ID. */
  syncSource(sourceId: string): Promise<FridaySyncResult>;
}

export interface FridaySyncResult {
  sourceId: string;
  sourceName: string;
  skillsSynced: number;
  versionsSynced: number;
  errors: string[];
}

// ─── Dependencies ───

export interface CreateMarketplaceSyncServiceDeps {
  db: FridaySqliteLayer;
  sourceRepo: FridayMarketplaceSourceRepository;
  cacheRepo: FridayMarketplaceCacheRepository;
  skillRepo: FridaySkillRepository;
  versionRepo: FridaySkillVersionRepository;
  httpClient: FridayMarketplaceHttpClient;
  trustScoring: FridaySkillTrustScoringService;
  signatureVerifier: FridaySkillSignatureVerifier;
  idGenerator: () => string;
  nowIso: () => string;
  cacheTtlHours?: number;
}

// ─── Factory ───

export function createFridayMarketplaceSyncService(
  deps: CreateMarketplaceSyncServiceDeps,
): FridayMarketplaceSyncService {
  const cacheTtlHours = deps.cacheTtlHours ?? 6;

  async function syncSingleSource(source: FridayMarketplaceSourceEntity): Promise<FridaySyncResult> {
    const result: FridaySyncResult = {
      sourceId: source.id,
      sourceName: source.name,
      skillsSynced: 0,
      versionsSynced: 0,
      errors: [],
    };

    let indexDoc: FridayMarketplaceIndexDocument;
    try {
      indexDoc = await deps.httpClient.fetchIndex(source.baseUrl);
    } catch (err) {
      result.errors.push(`Failed to fetch index: ${err instanceof Error ? err.message : String(err)}`);
      return result;
    }

    const nowIso = deps.nowIso();

    deps.db.withWriteTransaction((conn) => {
      for (const skill of indexDoc.skills) {
        try {
          // Upsert skill metadata
          deps.skillRepo.upsertSkillFromMarketplace(conn, {
            id: skill.id,
            name: skill.name,
            source: "marketplace",
            origin: "managed",
            publisher: skill.publisher,
            latestVersion: skill.latestVersion,
            status: "not_installed",
            nowIso,
          });
          result.skillsSynced++;

          for (const ver of skill.versions) {
            // Upsert version
            deps.versionRepo.upsertVersion(conn, {
              id: deps.idGenerator(),
              skillId: skill.id,
              version: ver.version,
              checksum: ver.checksum,
              packageUrl: ver.packageUrl,
              manifest: { schemaVersion: "2.0", id: skill.id, name: skill.name } as never,
              releasedAt: ver.releasedAt,
              nowIso,
            });

            // Compute trust score for cache
            const trustBreakdown = deps.trustScoring.computeScore({
              verification: {
                integrityValid: true,
                signatureValid: false,
                checks: ["integrity:pass", "signature:pending"],
              },
              trustPolicy: source.trustPolicy,
              hasPinnedKeys: source.pinnedKeyIds.length > 0,
              keyPinningPassed: false,
              publisherInstallCount: 0,
              indexedAt: nowIso,
              nowIso,
              cacheTtlHours,
            });

            // Upsert cache entry
            deps.cacheRepo.upsertCacheEntry(conn, {
              id: deps.idGenerator(),
              sourceId: source.id,
              skillId: skill.id,
              version: ver.version,
              manifestJson: JSON.stringify({ id: skill.id, name: skill.name, version: ver.version }),
              signatureValid: false,
              indexedAt: nowIso,
              trustScore: trustBreakdown.total,
              nowIso,
            });
            result.versionsSynced++;
          }
        } catch (err) {
          result.errors.push(
            `Error syncing skill ${skill.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    });

    return result;
  }

  return {
    async syncAllSources() {
      const sources = deps.db.withReadConnection((conn) =>
        deps.sourceRepo.listSources(conn, true),
      );

      const results: FridaySyncResult[] = [];
      for (const source of sources) {
        const result = await syncSingleSource(source);
        results.push(result);
      }
      return results;
    },

    async syncSource(sourceId) {
      const source = deps.db.withReadConnection((conn) =>
        deps.sourceRepo.getSourceById(conn, sourceId),
      );
      if (!source) {
        throw new Error(`Source ${sourceId} not found`);
      }
      return syncSingleSource(source);
    },
  };
}
```

### `src/skills/services/friday-skill-installation-service.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridaySkillRepository } from "../persistence/friday-skill-repository.js";
import type { FridaySkillInstallationRepository } from "../persistence/friday-skill-installation-repository.js";
import type { FridaySkillVersionResolutionService } from "./friday-skill-version-resolution-service.js";
import type { FridaySkillSignatureVerifier } from "./friday-skill-signature-verifier.js";
import type { FridaySkillTrustScoringService } from "./friday-skill-trust-scoring-service.js";
import type { FridaySkillPermissionCheckService } from "./friday-skill-permission-check-service.js";
import type { FridaySkillPackageInstaller } from "./friday-skill-package-installer.js";
import type { FridayMarketplaceHttpClient } from "./friday-marketplace-http-client.js";
import type { FridayMarketplaceSourceRepository } from "../persistence/friday-marketplace-source-repository.js";
import type {
  FridaySkillInstallRequest,
  FridaySkillInstallResult,
  FridayMarketplaceTrustPolicy,
} from "../model/friday-skill-marketplace.types.js";

// ─── Interface ───

export interface FridaySkillInstallationService {
  install(request: FridaySkillInstallRequest): Promise<FridaySkillInstallResult>;
  uninstall(skillId: string): void;
}

// ─── Dependencies ───

export interface CreateSkillInstallationServiceDeps {
  db: FridaySqliteLayer;
  skillRepo: FridaySkillRepository;
  installationRepo: FridaySkillInstallationRepository;
  sourceRepo: FridayMarketplaceSourceRepository;
  versionResolver: FridaySkillVersionResolutionService;
  signatureVerifier: FridaySkillSignatureVerifier;
  trustScoring: FridaySkillTrustScoringService;
  permissionCheck: FridaySkillPermissionCheckService;
  packageInstaller: FridaySkillPackageInstaller;
  httpClient: FridayMarketplaceHttpClient;
  idGenerator: () => string;
  nowIso: () => string;
  cacheTtlHours?: number;
  publishEvent?: (event: string, payload: unknown) => Promise<void>;
}

// ─── Factory ───

export function createFridaySkillInstallationService(
  deps: CreateSkillInstallationServiceDeps,
): FridaySkillInstallationService {
  const cacheTtlHours = deps.cacheTtlHours ?? 6;

  return {
    async install(request) {
      // 1. Resolve version
      const resolved = deps.versionResolver.resolve({
        skillId: request.skillId,
        requestedVersion: request.version,
        strategy: "install",
        sourceId: request.sourceId,
      });

      // 2. Create installation rows
      const targets = request.targetSatelliteIds ?? [undefined as unknown as string];
      const installationIds: string[] = [];

      deps.db.withWriteTransaction((conn) => {
        for (const satId of targets) {
          const instId = deps.idGenerator();
          deps.installationRepo.insertInstallation(conn, {
            id: instId,
            skillId: request.skillId,
            version: resolved.version,
            satelliteId: satId || undefined,
            status: "installing",
            permissionsGranted: request.grantPermissions ?? [],
            nowIso: deps.nowIso(),
          });
          installationIds.push(instId);
        }
      });

      // 3. Download package
      let packageBytes: Buffer;
      try {
        packageBytes = await deps.httpClient.fetchPackage(resolved.packageUrl);
      } catch (err) {
        const errorMsg = `Download failed: ${err instanceof Error ? err.message : String(err)}`;
        deps.db.withWriteTransaction((conn) => {
          for (const instId of installationIds) {
            deps.installationRepo.setInstallationError(conn, instId, errorMsg, deps.nowIso());
          }
        });
        throw new Error(errorMsg);
      }

      // 4. Verify integrity + signature
      let signatureDoc = undefined;
      let publisherKey = undefined;
      let trustPolicy: FridayMarketplaceTrustPolicy = "permissive";

      if (resolved.sourceId) {
        const source = deps.db.withReadConnection((conn) =>
          deps.sourceRepo.getSourceById(conn, resolved.sourceId),
        );
        if (source) {
          trustPolicy = source.trustPolicy;
          // Attempt to fetch signature and key
          try {
            const sigUrl = `${source.baseUrl.replace(/\/$/, "")}/skills/${resolved.skillId}/versions/${resolved.version}/signature.json`;
            signatureDoc = await deps.httpClient.fetchSignature(sigUrl);
            publisherKey = await deps.httpClient.fetchPublisherKey(source.baseUrl, signatureDoc.keyId);
          } catch {
            // Signature artifacts optional for non-strict policies
          }
        }
      }

      const pinnedKeyIds = resolved.sourceId
        ? deps.db.withReadConnection((conn) => {
            const source = deps.sourceRepo.getSourceById(conn, resolved.sourceId);
            return source?.pinnedKeyIds ?? [];
          })
        : [];

      const verification = deps.signatureVerifier.verifySignature({
        packageBytes,
        expectedChecksum: resolved.checksum,
        skillId: resolved.skillId,
        version: resolved.version,
        signatureDoc,
        publisherKey,
        pinnedKeyIds,
      });

      // 5. Compute trust score
      const trust = deps.trustScoring.computeScore({
        verification,
        trustPolicy,
        hasPinnedKeys: pinnedKeyIds.length > 0,
        keyPinningPassed: verification.checks.includes("key-pinning:pass"),
        publisherInstallCount: 0,
        indexedAt: deps.nowIso(),
        nowIso: deps.nowIso(),
        cacheTtlHours,
      });

      // 6. Evaluate policy
      const decision = deps.trustScoring.evaluatePolicy(trustPolicy, trust, verification);
      if (!decision.allowed) {
        const errorMsg = `Trust policy rejected: ${decision.reason}`;
        deps.db.withWriteTransaction((conn) => {
          for (const instId of installationIds) {
            deps.installationRepo.setInstallationError(conn, instId, errorMsg, deps.nowIso());
          }
        });
        throw new Error(errorMsg);
      }

      // 7. Permission check
      const permResult = deps.permissionCheck.checkPermissions(
        resolved.manifest,
        request.grantPermissions ?? [],
      );
      if (!permResult.allowed) {
        const errorMsg = `Missing required permissions: ${permResult.missingRequired.join(", ")}`;
        deps.db.withWriteTransaction((conn) => {
          for (const instId of installationIds) {
            deps.installationRepo.setInstallationError(conn, instId, errorMsg, deps.nowIso());
          }
        });
        throw new Error(errorMsg);
      }

      // 8. Stage and activate package
      try {
        deps.packageInstaller.stage(resolved.skillId, resolved.version, packageBytes);
        deps.packageInstaller.activate(resolved.skillId, resolved.version);
      } catch (err) {
        const errorMsg = `Package installation failed: ${err instanceof Error ? err.message : String(err)}`;
        deps.db.withWriteTransaction((conn) => {
          for (const instId of installationIds) {
            deps.installationRepo.setInstallationError(conn, instId, errorMsg, deps.nowIso());
          }
        });
        throw new Error(errorMsg);
      }

      // 9. Update database state
      deps.db.withWriteTransaction((conn) => {
        deps.skillRepo.setInstalledVersion(
          conn,
          resolved.skillId,
          resolved.version,
          resolved.manifest,
          deps.nowIso(),
        );

        for (const instId of installationIds) {
          deps.installationRepo.setInstallationStatus(conn, instId, "installed", deps.nowIso());
        }
      });

      // 10. Publish event if handler provided
      if (deps.publishEvent) {
        await deps.publishEvent("skill.installed", {
          skillId: resolved.skillId,
          version: resolved.version,
          installationIds,
        });
      }

      return {
        installationIds,
        resolvedVersion: resolved.version,
        verification,
        trust,
      };
    },

    uninstall(skillId) {
      deps.db.withWriteTransaction((conn) => {
        const skill = deps.skillRepo.getSkillById(conn, skillId);
        if (!skill) return;

        if (skill.installedVersion) {
          deps.packageInstaller.remove(skillId, skill.installedVersion);
        }

        deps.skillRepo.clearInstalledVersion(conn, skillId, deps.nowIso());

        // Mark current installations as uninstalled
        const installations = deps.installationRepo.listBySkill(conn, skillId);
        for (const inst of installations) {
          if (inst.status === "installed") {
            deps.installationRepo.setInstallationStatus(
              conn,
              inst.id,
              "uninstalled",
              deps.nowIso(),
            );
          }
        }
      });
    },
  };
}
```

### `src/skills/services/friday-skill-package-installer.ts`
```ts
import { mkdirSync, writeFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

// ─── Interface ───

export interface FridaySkillPackageInstaller {
  /** Stage package bytes to a temporary directory. */
  stage(skillId: string, version: string, packageBytes: Buffer): string;
  /** Activate a staged package by moving it to the final location. */
  activate(skillId: string, version: string): string;
  /** Remove installed package directory. */
  remove(skillId: string, version: string): void;
}

// ─── Dependencies ───

export interface CreateSkillPackageInstallerDeps {
  managedSkillsDir: string;
}

// ─── Factory ───

export function createFridaySkillPackageInstaller(
  deps: CreateSkillPackageInstallerDeps,
): FridaySkillPackageInstaller {
  const baseDir = deps.managedSkillsDir;

  function stagingDir(skillId: string, version: string): string {
    return join(baseDir, ".staging", skillId, version);
  }

  function finalDir(skillId: string, version: string): string {
    return join(baseDir, skillId, version);
  }

  return {
    stage(skillId, version, packageBytes) {
      const dir = stagingDir(skillId, version);
      mkdirSync(dir, { recursive: true });
      const packagePath = join(dir, "package.tgz");
      writeFileSync(packagePath, packageBytes);
      return dir;
    },

    activate(skillId, version) {
      const src = stagingDir(skillId, version);
      const dest = finalDir(skillId, version);

      // Remove existing destination if present
      if (existsSync(dest)) {
        rmSync(dest, { recursive: true, force: true });
      }

      mkdirSync(join(baseDir, skillId), { recursive: true });
      renameSync(src, dest);
      return dest;
    },

    remove(skillId, version) {
      const dir = finalDir(skillId, version);
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
      // Clean up staging too
      const staging = stagingDir(skillId, version);
      if (existsSync(staging)) {
        rmSync(staging, { recursive: true, force: true });
      }
    },
  };
}
```

### `src/skills/services/friday-skill-permission-check-service.ts`
```ts
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";

// ─── Interface ───

export interface FridaySkillPermissionCheckService {
  /** Check that all required permissions are granted. Returns missing permissions. */
  checkPermissions(
    manifest: SkillManifestV2,
    grantedPermissions: string[],
  ): FridayPermissionCheckResult;
}

export interface FridayPermissionCheckResult {
  allowed: boolean;
  missingRequired: string[];
  warnings: string[];
}

// ─── Factory ───

export function createFridaySkillPermissionCheckService(): FridaySkillPermissionCheckService {
  return {
    checkPermissions(manifest, grantedPermissions) {
      const required = manifest.permissions.grants
        .filter((g) => g.required)
        .map((g) => `${g.resource}.${g.action}`);

      const granted = new Set(grantedPermissions);
      const missingRequired = required.filter((p) => !granted.has(p));

      const warnings: string[] = [];
      for (const prompt of manifest.permissions.promptOn) {
        if (!granted.has(prompt)) {
          warnings.push(`Permission ${prompt} requires user prompt`);
        }
      }

      return {
        allowed: missingRequired.length === 0,
        missingRequired,
        warnings,
      };
    },
  };
}
```

### `src/skills/services/friday-skill-signature-verifier.ts`
```ts
import { createHash, createPublicKey, verify } from "node:crypto";
import { constants as cryptoConstants } from "node:crypto";
import type {
  FridayMarketplaceSignatureAlgorithm,
  FridayMarketplaceSignatureDocument,
  FridayMarketplacePublisherKeyDocument,
  FridaySignatureVerificationResult,
} from "../model/friday-skill-marketplace.types.js";

// ─── Interface ───

export interface FridaySkillSignatureVerifier {
  /** Compute SHA-256 hex digest of package bytes. */
  computeChecksum(packageBytes: Buffer): string;

  /** Verify integrity (checksum) and cryptographic signature. */
  verifySignature(input: {
    packageBytes: Buffer;
    expectedChecksum: string;
    skillId: string;
    version: string;
    signatureDoc?: FridayMarketplaceSignatureDocument;
    publisherKey?: FridayMarketplacePublisherKeyDocument;
    pinnedKeyIds?: string[];
  }): FridaySignatureVerificationResult;
}

// ─── Canonical Payload ───

function buildCanonicalPayload(skillId: string, version: string, checksumHex: string): Buffer {
  return Buffer.from(`friday-skill-signature-v1\n${skillId}\n${version}\n${checksumHex}`);
}

// ─── Algorithm Verify ───

function verifyByAlgorithm(
  algorithm: FridayMarketplaceSignatureAlgorithm,
  payload: Buffer,
  publicKeyPem: string,
  signatureBuffer: Buffer,
): boolean {
  const key = createPublicKey(publicKeyPem);

  switch (algorithm) {
    case "ed25519":
      return verify(null, payload, key, signatureBuffer);

    case "rsa-sha256":
      return verify("sha256", payload, { key, padding: cryptoConstants.RSA_PKCS1_PADDING }, signatureBuffer);

    case "rsa-pss-sha256":
      return verify(
        "sha256",
        payload,
        { key, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
        signatureBuffer,
      );

    default:
      return false;
  }
}

// ─── Factory ───

export function createFridaySkillSignatureVerifier(): FridaySkillSignatureVerifier {
  return {
    computeChecksum(packageBytes) {
      return createHash("sha256").update(packageBytes).digest("hex");
    },

    verifySignature(input) {
      const checks: string[] = [];

      // 1. Integrity check
      const actualChecksum = createHash("sha256").update(input.packageBytes).digest("hex");
      const integrityValid = actualChecksum === input.expectedChecksum;

      if (integrityValid) {
        checks.push("integrity:pass");
      } else {
        checks.push("integrity:fail");
        return {
          integrityValid: false,
          signatureValid: false,
          checks,
          reason: `Checksum mismatch: expected ${input.expectedChecksum}, got ${actualChecksum}`,
        };
      }

      // 2. If no signature doc, signature cannot be validated
      if (!input.signatureDoc) {
        checks.push("signature:missing");
        return {
          integrityValid: true,
          signatureValid: false,
          checks,
          reason: "No signature document provided",
        };
      }

      // 3. If no publisher key, signature cannot be validated
      if (!input.publisherKey || !input.publisherKey.publicKeyPem) {
        checks.push("signature:no-key");
        return {
          integrityValid: true,
          signatureValid: false,
          checks,
          keyId: input.signatureDoc.keyId,
          algorithm: input.signatureDoc.algorithm,
          reason: "No publisher key available",
        };
      }

      // 4. Check key revocation
      if (input.publisherKey.revokedAt) {
        checks.push("key:revoked");
        return {
          integrityValid: true,
          signatureValid: false,
          checks,
          keyId: input.signatureDoc.keyId,
          algorithm: input.signatureDoc.algorithm,
          reason: `Key ${input.signatureDoc.keyId} has been revoked`,
        };
      }

      // 5. Key pinning check
      if (input.pinnedKeyIds && input.pinnedKeyIds.length > 0) {
        if (input.pinnedKeyIds.includes(input.signatureDoc.keyId)) {
          checks.push("key-pinning:pass");
        } else {
          checks.push("key-pinning:fail");
          return {
            integrityValid: true,
            signatureValid: false,
            checks,
            keyId: input.signatureDoc.keyId,
            algorithm: input.signatureDoc.algorithm,
            reason: `Key ${input.signatureDoc.keyId} is not in pinned key list`,
          };
        }
      } else {
        checks.push("key-pinning:not-configured");
      }

      // 6. Cryptographic verification
      const payload = buildCanonicalPayload(input.skillId, input.version, actualChecksum);
      const signatureBuffer = Buffer.from(input.signatureDoc.value, "base64");

      try {
        const valid = verifyByAlgorithm(
          input.signatureDoc.algorithm,
          payload,
          input.publisherKey.publicKeyPem,
          signatureBuffer,
        );

        if (valid) {
          checks.push("signature:pass");
        } else {
          checks.push("signature:fail");
        }

        return {
          integrityValid: true,
          signatureValid: valid,
          checks,
          keyId: input.signatureDoc.keyId,
          algorithm: input.signatureDoc.algorithm,
          reason: valid ? undefined : "Cryptographic signature verification failed",
        };
      } catch (err) {
        checks.push("signature:error");
        return {
          integrityValid: true,
          signatureValid: false,
          checks,
          keyId: input.signatureDoc.keyId,
          algorithm: input.signatureDoc.algorithm,
          reason: `Signature verification error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
```

### `src/skills/services/friday-skill-trust-scoring-service.ts`
```ts
import type {
  FridayMarketplaceTrustPolicy,
  FridaySignatureVerificationResult,
  FridayTrustScoreBreakdown,
} from "../model/friday-skill-marketplace.types.js";

// ─── Interface ───

export interface FridaySkillTrustScoringService {
  computeScore(input: FridayTrustScoreInput): FridayTrustScoreBreakdown;
  evaluatePolicy(
    trustPolicy: FridayMarketplaceTrustPolicy,
    breakdown: FridayTrustScoreBreakdown,
    verification: FridaySignatureVerificationResult,
  ): FridayTrustPolicyDecision;
}

export interface FridayTrustScoreInput {
  verification: FridaySignatureVerificationResult;
  trustPolicy: FridayMarketplaceTrustPolicy;
  hasPinnedKeys: boolean;
  keyPinningPassed: boolean;
  publisherInstallCount: number;
  indexedAt: string;
  nowIso: string;
  cacheTtlHours: number;
}

export interface FridayTrustPolicyDecision {
  allowed: boolean;
  warnings: string[];
  reason?: string;
}

// ─── Score Constants ───

const SCORE_SIGNATURE_VALID = 40;
const SCORE_INTEGRITY_VALID = 15;
const SCORE_KEY_PINNING_CONFIGURED_PASSED = 20;
const SCORE_KEY_PINNING_NOT_CONFIGURED = 10;

const SCORE_SOURCE_POLICY: Record<FridayMarketplaceTrustPolicy, number> = {
  strict: 15,
  warn: 10,
  permissive: 5,
};

const MAX_PUBLISHER_SCORE = 10;
const MAX_FRESHNESS_SCORE = 10;

// ─── Thresholds ───

const THRESHOLD_STRICT = 85;
const THRESHOLD_WARN = 70;
const THRESHOLD_WARN_LOW = 85;
const THRESHOLD_PERMISSIVE = 40;

// ─── Factory ───

export function createFridaySkillTrustScoringService(): FridaySkillTrustScoringService {
  return {
    computeScore(input) {
      const reasons: string[] = [];

      // Signature
      const signature = input.verification.signatureValid ? SCORE_SIGNATURE_VALID : 0;
      if (input.verification.signatureValid) {
        reasons.push("Valid cryptographic signature (+40)");
      } else {
        reasons.push("Missing or invalid signature (+0)");
      }

      // Integrity
      const integrity = input.verification.integrityValid ? SCORE_INTEGRITY_VALID : 0;
      if (input.verification.integrityValid) {
        reasons.push("Integrity checksum verified (+15)");
      } else {
        reasons.push("Integrity check failed (+0)");
      }

      // Key pinning
      let keyPinning: number;
      if (input.hasPinnedKeys) {
        if (input.keyPinningPassed) {
          keyPinning = SCORE_KEY_PINNING_CONFIGURED_PASSED;
          reasons.push("Key pinning configured and passed (+20)");
        } else {
          keyPinning = 0;
          reasons.push("Key pinning configured but failed (+0)");
        }
      } else {
        keyPinning = SCORE_KEY_PINNING_NOT_CONFIGURED;
        reasons.push("Key pinning not configured (+10)");
      }

      // Source policy baseline
      const sourcePolicy = SCORE_SOURCE_POLICY[input.trustPolicy];
      reasons.push(`Source policy: ${input.trustPolicy} (+${sourcePolicy})`);

      // Publisher reputation (capped at 10, based on install count)
      const publisher = Math.min(input.publisherInstallCount, MAX_PUBLISHER_SCORE);
      reasons.push(`Publisher install count: ${input.publisherInstallCount} (+${publisher})`);

      // Freshness (based on age vs TTL)
      const ageMs = new Date(input.nowIso).getTime() - new Date(input.indexedAt).getTime();
      const ttlMs = input.cacheTtlHours * 60 * 60 * 1000;
      let freshness: number;
      if (ageMs <= 0) {
        freshness = MAX_FRESHNESS_SCORE;
      } else if (ageMs >= ttlMs * 4) {
        freshness = 0;
      } else {
        freshness = Math.round(MAX_FRESHNESS_SCORE * Math.max(0, 1 - ageMs / (ttlMs * 4)));
      }
      reasons.push(`Freshness score (+${freshness})`);

      const total = signature + integrity + keyPinning + sourcePolicy + publisher + freshness;

      return {
        total,
        signature,
        integrity,
        keyPinning,
        sourcePolicy,
        publisher,
        freshness,
        reasons,
      };
    },

    evaluatePolicy(trustPolicy, breakdown, verification) {
      const warnings: string[] = [];

      switch (trustPolicy) {
        case "strict": {
          if (!verification.signatureValid) {
            return {
              allowed: false,
              warnings,
              reason: "Strict policy requires valid signature",
            };
          }
          if (!verification.integrityValid) {
            return {
              allowed: false,
              warnings,
              reason: "Strict policy requires valid integrity",
            };
          }
          if (breakdown.total < THRESHOLD_STRICT) {
            return {
              allowed: false,
              warnings,
              reason: `Trust score ${breakdown.total} below strict threshold ${THRESHOLD_STRICT}`,
            };
          }
          return { allowed: true, warnings };
        }

        case "warn": {
          if (!verification.integrityValid) {
            return {
              allowed: false,
              warnings,
              reason: "Warn policy requires valid integrity",
            };
          }
          if (breakdown.total < THRESHOLD_WARN) {
            return {
              allowed: false,
              warnings,
              reason: `Trust score ${breakdown.total} below warn threshold ${THRESHOLD_WARN}`,
            };
          }
          if (breakdown.total < THRESHOLD_WARN_LOW) {
            warnings.push(`Trust score ${breakdown.total} below recommended threshold ${THRESHOLD_WARN_LOW}`);
          }
          return { allowed: true, warnings };
        }

        case "permissive": {
          if (!verification.integrityValid) {
            return {
              allowed: false,
              warnings,
              reason: "Permissive policy still requires valid integrity",
            };
          }
          // Reject explicit signature fraud (integrity OK but signature explicitly failed)
          if (
            verification.checks.includes("signature:fail") &&
            !verification.checks.includes("signature:missing")
          ) {
            return {
              allowed: false,
              warnings,
              reason: "Signature explicitly invalid (possible tampering)",
            };
          }
          if (breakdown.total < THRESHOLD_PERMISSIVE) {
            return {
              allowed: false,
              warnings,
              reason: `Trust score ${breakdown.total} below permissive threshold ${THRESHOLD_PERMISSIVE}`,
            };
          }
          return { allowed: true, warnings };
        }

        default:
          return {
            allowed: false,
            warnings,
            reason: `Unknown trust policy: ${trustPolicy}`,
          };
      }
    },
  };
}
```

### `src/skills/services/friday-skill-version-resolution-service.ts`
```ts
import semver from "semver";
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridaySkillVersionRepository } from "../persistence/friday-skill-version-repository.js";
import type { FridaySkillInstallationRepository } from "../persistence/friday-skill-installation-repository.js";
import type { FridayMarketplaceCacheRepository } from "../persistence/friday-marketplace-cache-repository.js";
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import type {
  FridaySkillVersionResolutionInput,
  FridaySkillVersionResolutionResult,
  FridaySkillVersionEntity,
  FridaySkillSignature,
} from "../model/friday-skill-marketplace.types.js";

// ─── Interface ───

export interface FridaySkillVersionResolutionService {
  resolve(input: FridaySkillVersionResolutionInput): FridaySkillVersionResolutionResult;
}

// ─── Dependencies ───

export interface CreateVersionResolutionServiceDeps {
  db: FridaySqliteLayer;
  versionRepo: FridaySkillVersionRepository;
  installationRepo: FridaySkillInstallationRepository;
  cacheRepo: FridayMarketplaceCacheRepository;
}

// ─── Factory ───

export function createFridaySkillVersionResolutionService(
  deps: CreateVersionResolutionServiceDeps,
): FridaySkillVersionResolutionService {
  function resolveFromVersions(
    versions: FridaySkillVersionEntity[],
    requestedVersion: string | undefined,
    allowYanked: boolean,
  ): FridaySkillVersionEntity | null {
    const candidates = allowYanked ? versions : versions.filter((v) => !v.yankedAt);
    if (candidates.length === 0) return null;

    if (requestedVersion) {
      // Exact match first
      const exact = candidates.find((v) => v.version === requestedVersion);
      if (exact) return exact;

      // Semver range match
      const matched = candidates
        .filter((v) => semver.valid(v.version) && semver.satisfies(v.version, requestedVersion))
        .sort((a, b) => semver.rcompare(a.version, b.version));
      return matched[0] ?? null;
    }

    // No version requested: pick latest by semver, fall back to release date
    const sorted = [...candidates].sort((a, b) => {
      if (semver.valid(a.version) && semver.valid(b.version)) {
        return semver.rcompare(a.version, b.version);
      }
      return b.releasedAt.localeCompare(a.releasedAt);
    });
    return sorted[0] ?? null;
  }

  return {
    resolve(input) {
      return deps.db.withReadConnection((conn) => {
        const versions = deps.versionRepo.listVersionsForResolution(
          conn,
          input.skillId,
          input.allowYanked,
        );

        switch (input.strategy) {
          case "install":
          case "upgrade": {
            const resolved = resolveFromVersions(
              versions,
              input.requestedVersion,
              input.allowYanked ?? false,
            );

            if (!resolved) {
              throw new Error(
                `No matching version found for ${input.skillId}${input.requestedVersion ? `@${input.requestedVersion}` : ""}`,
              );
            }

            // For upgrade, look in cache for source info
            let sourceId = input.sourceId ?? "";
            if (!sourceId) {
              const cached = deps.cacheRepo.getCachedVersion(
                conn,
                "",
                input.skillId,
                resolved.version,
              );
              if (cached) {
                sourceId = cached.sourceId;
              }
            }

            // If no source found via exact match, search cache broadly
            if (!sourceId) {
              const cacheResults = deps.cacheRepo.listCatalog(conn, {
                q: input.skillId,
                limit: 1,
              });
              if (cacheResults.length > 0) {
                sourceId = cacheResults[0].sourceId;
              }
            }

            return {
              skillId: input.skillId,
              version: resolved.version,
              sourceId,
              manifest: resolved.manifest,
              checksum: resolved.checksum,
              packageUrl: resolved.packageUrl ?? "",
              signature: resolved.signature,
              reason: input.strategy === "upgrade"
                ? `Upgrade to ${resolved.version}`
                : `Install version ${resolved.version}`,
            };
          }

          case "rollback": {
            // Find previous successfully installed version
            const history = deps.installationRepo.listInstalledHistory(
              conn,
              input.skillId,
              10,
            );

            // Skip the current (first) entry, take the next one
            const previousInstall = history.length > 1 ? history[1] : null;
            if (!previousInstall) {
              throw new Error(`No previous installed version found for rollback of ${input.skillId}`);
            }

            const targetVersion = versions.find(
              (v) => v.version === previousInstall.version,
            );
            if (!targetVersion) {
              throw new Error(
                `Previous version ${previousInstall.version} metadata not found for ${input.skillId}`,
              );
            }

            return {
              skillId: input.skillId,
              version: targetVersion.version,
              sourceId: input.sourceId ?? "",
              manifest: targetVersion.manifest,
              checksum: targetVersion.checksum,
              packageUrl: targetVersion.packageUrl ?? "",
              signature: targetVersion.signature,
              reason: `Rollback to ${targetVersion.version}`,
            };
          }

          default:
            throw new Error(`Unknown resolution strategy: ${input.strategy}`);
        }
      });
    },
  };
}
```

### `src/skills/model/friday-skill-marketplace.types.ts`
```ts
import type { SkillManifestV2 } from "./friday-skill-manifest-v2.types.js";
import type { SkillLifecycleStatus } from "./friday-skill-lifecycle.types.js";
import type { SkillOrigin, SkillSource } from "./friday-skill-source.types.js";

// ─── Re-export foundational value types ───

export type UUID = string;
export type ISODateTime = string;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

// ─── Marketplace Enums ───

export type FridayMarketplaceTrustPolicy = "strict" | "warn" | "permissive";
export type FridayMarketplaceSignatureAlgorithm = "ed25519" | "rsa-sha256" | "rsa-pss-sha256";
export type FridaySkillInstallationStatus =
  | "installing"
  | "installed"
  | "failed"
  | "uninstalling"
  | "uninstalled";

// ─── Row Types (SQLite shape) ───

export interface FridayMarketplaceSourceRow {
  id: string;
  name: string;
  base_url: string;
  enabled: number;
  trust_policy: string;
  pinned_key_ids_json: string;
  created_at: string;
  updated_at: string;
}

export interface FridayMarketplaceCacheRow {
  id: string;
  source_id: string;
  skill_id: string;
  version: string;
  manifest_json: string;
  signature_valid: number;
  indexed_at: string;
  trust_score: number;
  created_at: string;
  updated_at: string;
}

export interface FridaySkillRow {
  id: string;
  name: string;
  source: string;
  origin: string;
  publisher: string | null;
  latest_version: string | null;
  installed_version: string | null;
  status: string;
  current_manifest_json: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface FridaySkillVersionRow {
  id: string;
  skill_id: string;
  version: string;
  checksum: string;
  package_url: string | null;
  signature_key_id: string | null;
  signature_algorithm: string | null;
  signature_value: string | null;
  manifest_json: string;
  released_at: string;
  yanked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FridaySkillInstallationRow {
  id: string;
  skill_id: string;
  version: string;
  satellite_id: string | null;
  status: string;
  permissions_granted_json: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Entity Types (Application shape) ───

export interface FridayMarketplaceSourceEntity {
  id: UUID;
  name: string;
  baseUrl: string;
  enabled: boolean;
  trustPolicy: FridayMarketplaceTrustPolicy;
  pinnedKeyIds: string[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface FridayMarketplaceCacheEntity {
  id: UUID;
  sourceId: UUID;
  skillId: string;
  version: string;
  manifestJson: JsonValue;
  signatureValid: boolean;
  indexedAt: ISODateTime;
  trustScore: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface FridaySkillEntity {
  id: string;
  name: string;
  source: SkillSource;
  origin: SkillOrigin;
  publisher?: string;
  latestVersion?: string;
  installedVersion?: string;
  status: SkillLifecycleStatus;
  currentManifest?: SkillManifestV2;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  deletedAt?: ISODateTime;
  deletedBy?: string;
}

export interface FridaySkillSignature {
  keyId: string;
  algorithm: FridayMarketplaceSignatureAlgorithm;
  value: string; // base64
}

export interface FridaySkillVersionEntity {
  id: UUID;
  skillId: string;
  version: string;
  checksum: string;
  packageUrl?: string;
  signature?: FridaySkillSignature;
  manifest: SkillManifestV2;
  releasedAt: ISODateTime;
  yankedAt?: ISODateTime;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface FridaySkillInstallationEntity {
  id: UUID;
  skillId: string;
  version: string;
  satelliteId?: UUID;
  status: FridaySkillInstallationStatus;
  permissionsGranted: string[];
  lastError?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ─── Input / Query Types ───

export interface FridayMarketplaceSourceCreateInput {
  name: string;
  baseUrl: string;
  trustPolicy: FridayMarketplaceTrustPolicy;
  pinnedKeyIds: string[];
}

export interface FridayMarketplaceSourcePatchInput {
  name?: string;
  baseUrl?: string;
  enabled?: boolean;
  trustPolicy?: FridayMarketplaceTrustPolicy;
  pinnedKeyIds?: string[];
}

export interface FridaySkillCatalogQuery {
  sourceId?: string;
  q?: string;
  category?: string;
  cursor?: string;
  limit?: number;
  includeStale?: boolean;
}

export interface FridaySkillCatalogItem {
  sourceId: string;
  skillId: string;
  skillName: string;
  publisher?: string;
  version: string;
  category?: string;
  releasedAt?: string;
  signatureValid: boolean;
  trustScore: number;
  manifest: SkillManifestV2;
}

// ─── Remote Index Documents ───

export interface FridayMarketplaceIndexDocument {
  generatedAt: ISODateTime;
  skills: Array<{
    id: string;
    name: string;
    publisher?: string;
    latestVersion: string;
    versions: Array<{
      version: string;
      checksum: string;
      releasedAt: ISODateTime;
      manifestUrl: string;
      packageUrl: string;
      signatureUrl: string;
    }>;
  }>;
}

export interface FridayMarketplaceSignatureDocument {
  skillId: string;
  version: string;
  keyId: string;
  algorithm: FridayMarketplaceSignatureAlgorithm;
  value: string; // base64
}

export interface FridayMarketplacePublisherKeyDocument {
  keyId: string;
  algorithm: FridayMarketplaceSignatureAlgorithm;
  publicKeyPem?: string;
  publicKeyJwk?: JsonValue;
  rotatedAt?: ISODateTime;
  revokedAt?: ISODateTime;
}

// ─── Verification & Trust ───

export interface FridaySignatureVerificationResult {
  integrityValid: boolean;
  signatureValid: boolean;
  checks: string[];
  keyId?: string;
  algorithm?: FridayMarketplaceSignatureAlgorithm;
  reason?: string;
}

export interface FridayTrustScoreBreakdown {
  total: number;
  signature: number;
  integrity: number;
  keyPinning: number;
  sourcePolicy: number;
  publisher: number;
  freshness: number;
  reasons: string[];
}

// ─── Version Resolution ───

export interface FridaySkillVersionResolutionInput {
  skillId: string;
  requestedVersion?: string;
  strategy: "install" | "upgrade" | "rollback";
  sourceId?: string;
  satelliteId?: string;
  allowYanked?: boolean;
}

export interface FridaySkillVersionResolutionResult {
  skillId: string;
  version: string;
  sourceId: string;
  manifest: SkillManifestV2;
  checksum: string;
  packageUrl: string;
  signature?: FridaySkillSignature;
  reason: string;
}

// ─── Installation ───

export interface FridaySkillInstallRequest {
  skillId: string;
  version?: string;
  targetSatelliteIds?: string[];
  grantPermissions?: string[];
  sourceId?: string;
}

export interface FridaySkillInstallResult {
  installationIds: string[];
  resolvedVersion: string;
  verification: FridaySignatureVerificationResult;
  trust: FridayTrustScoreBreakdown;
}
```

### `src/skills/marketplace-index.ts`
```ts
// Marketplace barrel — re-exports all Phase 4 types, repos, services, and runtime
export * from "./model/friday-skill-marketplace.types.js";
export * from "./persistence/friday-marketplace-source-repository.js";
export * from "./persistence/friday-marketplace-cache-repository.js";
export * from "./persistence/friday-skill-repository.js";
export * from "./persistence/friday-skill-version-repository.js";
export * from "./persistence/friday-skill-installation-repository.js";
export * from "./services/friday-marketplace-http-client.js";
export * from "./services/friday-marketplace-source-service.js";
export * from "./services/friday-marketplace-cache-service.js";
export * from "./services/friday-marketplace-discovery-service.js";
export * from "./services/friday-marketplace-sync-service.js";
export * from "./services/friday-skill-signature-verifier.js";
export * from "./services/friday-skill-trust-scoring-service.js";
export * from "./services/friday-skill-version-resolution-service.js";
export * from "./services/friday-skill-permission-check-service.js";
export * from "./services/friday-skill-package-installer.js";
export * from "./services/friday-skill-installation-service.js";
export * from "./runtime/friday-skill-marketplace-runtime.types.js";
export * from "./runtime/friday-skill-marketplace-runtime.js";
```

## Test Code

### `test/unit/skills/marketplace/_helpers.ts`
```ts
import Database from "better-sqlite3";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { runFridayMigrations } from "../../../../src/state/sqlite/friday-migration-runner.js";
import { FRIDAY_SQLITE_MIGRATIONS } from "../../../../src/state/sqlite/migrations/index.js";
import type { SkillManifestV2 } from "../../../../src/skills/model/friday-skill-manifest-v2.types.js";

/**
 * Creates an in-memory SQLite database with all V001 schema tables
 * and wraps it in a minimal FridaySqliteLayer for testing.
 */
export function createTestDb(): FridaySqliteLayer {
  const db = new Database(":memory:");
  runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

  // Insert a test user for FK constraints
  db.prepare(
    `INSERT OR IGNORE INTO users (id, display_name, role, is_local_only, created_at, updated_at)
     VALUES ('test-user', 'Test User', 'admin', 1, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
  ).run();

  return {
    dbPath: ":memory:",
    writer: db,
    reads: {
      size: 1,
      withReadConnection<T>(fn: (db: Database.Database) => T): T {
        return fn(db);
      },
      close() {},
    },
    withWriteTransaction<T>(fn: (writerDb: Database.Database) => T): T {
      return db.transaction(() => fn(db))();
    },
    withReadConnection<T>(fn: (db: Database.Database) => T): T {
      return fn(db);
    },
    checkpoint() {},
    close() {
      db.close();
    },
  };
}

/** Counter-based ID generator for deterministic tests. */
export function createTestIdGenerator(): () => string {
  let counter = 0;
  return () => `test-id-${String(++counter).padStart(4, "0")}`;
}

/** Deterministic timestamp for tests. */
export const NOW = "2025-06-15T12:00:00.000Z";
export const EARLIER = "2025-06-15T06:00:00.000Z";
export const MUCH_EARLIER = "2025-05-01T00:00:00.000Z";

/** Minimal valid manifest for tests. */
export function createTestManifest(overrides?: Partial<SkillManifestV2>): SkillManifestV2 {
  return {
    schemaVersion: "2.0",
    id: "test-skill",
    name: "Test Skill",
    description: "A test skill",
    version: "1.0.0",
    kind: "conversation",
    category: "utility",
    author: { name: "Test Author" },
    tags: [],
    runtime: {
      kind: "node",
      entrypoint: "index.js",
      minHubVersion: "0.1.0",
      apiVersion: "1",
      timeoutMsDefault: 30000,
    },
    triggers: {
      intents: ["test"],
      phrases: ["test"],
      channels: [],
    },
    invocation: {
      userInvocable: true,
      modelInvocable: false,
      priority: 50,
      modes: ["intent"],
    },
    requirements: {
      bins: [],
      env: [],
      config: [],
      os: ["darwin", "linux"],
    },
    inputs: [],
    outputs: [],
    permissions: {
      grants: [
        {
          id: "net",
          resource: "network",
          action: "connect",
          required: true,
          reason: "Needs network access",
        },
      ],
      promptOn: ["network.connect"],
    },
    executionTargets: {
      allowedSatelliteTypes: ["desktop"],
      requiredCapabilities: [],
    },
    ...overrides,
  };
}
```

### `test/unit/skills/marketplace/friday-marketplace-cache-repository.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridayMarketplaceCacheRepository } from "../../../../src/skills/persistence/friday-marketplace-cache-repository.js";
import { createFridayMarketplaceSourceRepository } from "../../../../src/skills/persistence/friday-marketplace-source-repository.js";
import { createTestDb, NOW, EARLIER, MUCH_EARLIER } from "./_helpers.js";

describe("FridayMarketplaceCacheRepository", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
    // Insert a source for FK
    db.withWriteTransaction((conn) => {
      createFridayMarketplaceSourceRepository().insertSource(conn, "src-1", {
        name: "Test Source",
        baseUrl: "https://test.dev",
        trustPolicy: "warn",
        pinnedKeyIds: [],
      }, NOW);
      createFridayMarketplaceSourceRepository().insertSource(conn, "src-2", {
        name: "Disabled Source",
        baseUrl: "https://disabled.dev",
        trustPolicy: "strict",
        pinnedKeyIds: [],
      }, NOW);
      // Disable src-2
      createFridayMarketplaceSourceRepository().setEnabled(conn, "src-2", false, NOW);
    });
  });

  afterEach(() => {
    db.close();
  });

  function createRepo() {
    return createFridayMarketplaceCacheRepository();
  }

  it("upserts and retrieves a cache entry", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.upsertCacheEntry(conn, {
        id: "c-1",
        sourceId: "src-1",
        skillId: "skill-1",
        version: "1.0.0",
        manifestJson: JSON.stringify({ name: "Skill One" }),
        signatureValid: true,
        indexedAt: NOW,
        trustScore: 85,
        nowIso: NOW,
      });
    });

    const entry = db.withReadConnection((conn) =>
      repo.getCachedVersion(conn, "src-1", "skill-1", "1.0.0"),
    );
    expect(entry).not.toBeNull();
    expect(entry!.skillId).toBe("skill-1");
    expect(entry!.signatureValid).toBe(true);
    expect(entry!.trustScore).toBe(85);
  });

  it("upsert updates on conflict", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.upsertCacheEntry(conn, {
        id: "c-1",
        sourceId: "src-1",
        skillId: "skill-1",
        version: "1.0.0",
        manifestJson: "{}",
        signatureValid: false,
        indexedAt: EARLIER,
        trustScore: 50,
        nowIso: EARLIER,
      });
      repo.upsertCacheEntry(conn, {
        id: "c-2",
        sourceId: "src-1",
        skillId: "skill-1",
        version: "1.0.0",
        manifestJson: JSON.stringify({ updated: true }),
        signatureValid: true,
        indexedAt: NOW,
        trustScore: 90,
        nowIso: NOW,
      });
    });

    const entry = db.withReadConnection((conn) =>
      repo.getCachedVersion(conn, "src-1", "skill-1", "1.0.0"),
    );
    expect(entry!.signatureValid).toBe(true);
    expect(entry!.trustScore).toBe(90);
  });

  it("batch upserts multiple entries", () => {
    const repo = createRepo();
    const count = db.withWriteTransaction((conn) =>
      repo.upsertCacheBatch(conn, [
        { id: "c-1", sourceId: "src-1", skillId: "s1", version: "1.0.0", manifestJson: "{}", signatureValid: true, indexedAt: NOW, trustScore: 80, nowIso: NOW },
        { id: "c-2", sourceId: "src-1", skillId: "s2", version: "2.0.0", manifestJson: "{}", signatureValid: false, indexedAt: NOW, trustScore: 40, nowIso: NOW },
      ]),
    );
    expect(count).toBe(2);
  });

  it("lists catalog with filters", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.upsertCacheEntry(conn, { id: "c-1", sourceId: "src-1", skillId: "weather-skill", version: "1.0.0", manifestJson: JSON.stringify({ name: "Weather", category: "utility" }), signatureValid: true, indexedAt: NOW, trustScore: 90, nowIso: NOW });
      repo.upsertCacheEntry(conn, { id: "c-2", sourceId: "src-1", skillId: "email-skill", version: "1.0.0", manifestJson: JSON.stringify({ name: "Email", category: "communication" }), signatureValid: true, indexedAt: NOW, trustScore: 70, nowIso: NOW });
    });

    // Search by q
    const results = db.withReadConnection((conn) =>
      repo.listCatalog(conn, { q: "weather" }),
    );
    expect(results).toHaveLength(1);
    expect(results[0].skillId).toBe("weather-skill");

    // Search by category
    const commResults = db.withReadConnection((conn) =>
      repo.listCatalog(conn, { category: "communication" }),
    );
    expect(commResults).toHaveLength(1);
    expect(commResults[0].skillId).toBe("email-skill");
  });

  it("listCatalog excludes disabled sources", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.upsertCacheEntry(conn, { id: "c-1", sourceId: "src-1", skillId: "s1", version: "1.0.0", manifestJson: "{}", signatureValid: true, indexedAt: NOW, trustScore: 80, nowIso: NOW });
      repo.upsertCacheEntry(conn, { id: "c-2", sourceId: "src-2", skillId: "s2", version: "1.0.0", manifestJson: "{}", signatureValid: true, indexedAt: NOW, trustScore: 80, nowIso: NOW });
    });

    // Without sourceId filter, only enabled sources shown
    const results = db.withReadConnection((conn) =>
      repo.listCatalog(conn, {}),
    );
    expect(results).toHaveLength(1);
    expect(results[0].skillId).toBe("s1");

    // With explicit sourceId, shows even disabled
    const explicit = db.withReadConnection((conn) =>
      repo.listCatalog(conn, { sourceId: "src-2" }),
    );
    expect(explicit).toHaveLength(1);
  });

  it("detects stale source IDs", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.upsertCacheEntry(conn, { id: "c-1", sourceId: "src-1", skillId: "s1", version: "1.0.0", manifestJson: "{}", signatureValid: true, indexedAt: MUCH_EARLIER, trustScore: 80, nowIso: NOW });
    });

    const stale = db.withReadConnection((conn) =>
      repo.listStaleSourceIds(conn, EARLIER),
    );
    expect(stale).toContain("src-1");
  });

  it("prunes old entries", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.upsertCacheEntry(conn, { id: "c-1", sourceId: "src-1", skillId: "s1", version: "1.0.0", manifestJson: "{}", signatureValid: true, indexedAt: MUCH_EARLIER, trustScore: 80, nowIso: NOW });
      repo.upsertCacheEntry(conn, { id: "c-2", sourceId: "src-1", skillId: "s2", version: "1.0.0", manifestJson: "{}", signatureValid: true, indexedAt: NOW, trustScore: 80, nowIso: NOW });
    });

    const pruned = db.withWriteTransaction((conn) =>
      repo.pruneOlderThan(conn, EARLIER),
    );
    expect(pruned).toBe(1);

    // The fresh entry should remain
    const remaining = db.withReadConnection((conn) =>
      repo.getCachedVersion(conn, "src-1", "s2", "1.0.0"),
    );
    expect(remaining).not.toBeNull();
  });

  it("deletes by source ID", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.upsertCacheEntry(conn, { id: "c-1", sourceId: "src-1", skillId: "s1", version: "1.0.0", manifestJson: "{}", signatureValid: true, indexedAt: NOW, trustScore: 80, nowIso: NOW });
      repo.upsertCacheEntry(conn, { id: "c-2", sourceId: "src-1", skillId: "s2", version: "1.0.0", manifestJson: "{}", signatureValid: true, indexedAt: NOW, trustScore: 80, nowIso: NOW });
    });

    const deleted = db.withWriteTransaction((conn) =>
      repo.deleteBySourceId(conn, "src-1"),
    );
    expect(deleted).toBe(2);
  });

  it("returns null for non-existent cache entry", () => {
    const repo = createRepo();
    const result = db.withReadConnection((conn) =>
      repo.getCachedVersion(conn, "src-1", "no-skill", "1.0.0"),
    );
    expect(result).toBeNull();
  });
});
```

### `test/unit/skills/marketplace/friday-marketplace-discovery-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridayMarketplaceSourceRepository } from "../../../../src/skills/persistence/friday-marketplace-source-repository.js";
import { createFridayMarketplaceCacheRepository } from "../../../../src/skills/persistence/friday-marketplace-cache-repository.js";
import { createFridayMarketplaceDiscoveryService } from "../../../../src/skills/services/friday-marketplace-discovery-service.js";
import { createTestDb, NOW } from "./_helpers.js";

describe("FridayMarketplaceDiscoveryService", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
    const sourceRepo = createFridayMarketplaceSourceRepository();
    const cacheRepo = createFridayMarketplaceCacheRepository();

    db.withWriteTransaction((conn) => {
      sourceRepo.insertSource(conn, "src-1", { name: "Main", baseUrl: "https://main.dev", trustPolicy: "warn", pinnedKeyIds: [] }, NOW);

      cacheRepo.upsertCacheEntry(conn, { id: "c-1", sourceId: "src-1", skillId: "weather-skill", version: "1.0.0", manifestJson: JSON.stringify({ name: "Weather Lookup", category: "utility", author: { name: "Friday Labs" } }), signatureValid: true, indexedAt: NOW, trustScore: 90, nowIso: NOW });
      cacheRepo.upsertCacheEntry(conn, { id: "c-2", sourceId: "src-1", skillId: "email-skill", version: "2.0.0", manifestJson: JSON.stringify({ name: "Email Manager", category: "communication", author: { name: "ACME" } }), signatureValid: true, indexedAt: NOW, trustScore: 75, nowIso: NOW });
      cacheRepo.upsertCacheEntry(conn, { id: "c-3", sourceId: "src-1", skillId: "file-skill", version: "1.0.0", manifestJson: JSON.stringify({ name: "File Manager", category: "utility", author: { name: "DevTools" } }), signatureValid: false, indexedAt: NOW, trustScore: 50, nowIso: NOW });
    });
  });

  afterEach(() => {
    db.close();
  });

  function createService() {
    return createFridayMarketplaceDiscoveryService({
      db,
      cacheRepo: createFridayMarketplaceCacheRepository(),
    });
  }

  it("returns all catalog items", () => {
    const service = createService();
    const result = service.search({});
    expect(result.items).toHaveLength(3);
    expect(result.total).toBe(3);
  });

  it("searches by query string", () => {
    const service = createService();
    const result = service.search({ q: "weather" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].skillId).toBe("weather-skill");
  });

  it("filters by category", () => {
    const service = createService();
    const result = service.search({ category: "communication" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].skillId).toBe("email-skill");
  });

  it("filters by source ID", () => {
    const service = createService();
    const result = service.search({ sourceId: "src-1" });
    expect(result.items).toHaveLength(3);
  });

  it("paginates results", () => {
    const service = createService();
    const page1 = service.search({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();

    const page2 = service.search({ limit: 2, cursor: page1.nextCursor });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeUndefined();
  });

  it("orders by trust score descending", () => {
    const service = createService();
    const result = service.search({});
    const scores = result.items.map((i) => i.trustScore);
    expect(scores[0]).toBeGreaterThanOrEqual(scores[1]);
    expect(scores[1]).toBeGreaterThanOrEqual(scores[2]);
  });

  it("maps manifest fields to catalog item", () => {
    const service = createService();
    const result = service.search({ q: "weather" });
    const item = result.items[0];
    expect(item.skillName).toBe("Weather Lookup");
    expect(item.publisher).toBe("Friday Labs");
    expect(item.signatureValid).toBe(true);
    expect(item.trustScore).toBe(90);
  });
});
```

### `test/unit/skills/marketplace/friday-marketplace-source-repository.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridayMarketplaceSourceRepository } from "../../../../src/skills/persistence/friday-marketplace-source-repository.js";
import { createTestDb, NOW } from "./_helpers.js";

describe("FridayMarketplaceSourceRepository", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  function createRepo() {
    return createFridayMarketplaceSourceRepository();
  }

  it("inserts and retrieves a source", () => {
    const repo = createRepo();
    const entity = db.withWriteTransaction((conn) =>
      repo.insertSource(conn, "src-1", {
        name: "Official",
        baseUrl: "https://marketplace.friday.dev",
        trustPolicy: "strict",
        pinnedKeyIds: ["key-1", "key-2"],
      }, NOW),
    );

    expect(entity.id).toBe("src-1");
    expect(entity.name).toBe("Official");
    expect(entity.baseUrl).toBe("https://marketplace.friday.dev");
    expect(entity.enabled).toBe(true);
    expect(entity.trustPolicy).toBe("strict");
    expect(entity.pinnedKeyIds).toEqual(["key-1", "key-2"]);
    expect(entity.createdAt).toBe(NOW);

    const fetched = db.withReadConnection((conn) => repo.getSourceById(conn, "src-1"));
    expect(fetched).toEqual(entity);
  });

  it("lists all sources", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertSource(conn, "src-1", { name: "Alpha", baseUrl: "https://a.dev", trustPolicy: "strict", pinnedKeyIds: [] }, NOW);
      repo.insertSource(conn, "src-2", { name: "Beta", baseUrl: "https://b.dev", trustPolicy: "warn", pinnedKeyIds: [] }, NOW);
    });

    const all = db.withReadConnection((conn) => repo.listSources(conn));
    expect(all).toHaveLength(2);
    expect(all[0].name).toBe("Alpha");
    expect(all[1].name).toBe("Beta");
  });

  it("lists only enabled sources", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertSource(conn, "src-1", { name: "Enabled", baseUrl: "https://a.dev", trustPolicy: "strict", pinnedKeyIds: [] }, NOW);
      repo.insertSource(conn, "src-2", { name: "Disabled", baseUrl: "https://b.dev", trustPolicy: "warn", pinnedKeyIds: [] }, NOW);
      repo.setEnabled(conn, "src-2", false, NOW);
    });

    const enabled = db.withReadConnection((conn) => repo.listSources(conn, true));
    expect(enabled).toHaveLength(1);
    expect(enabled[0].name).toBe("Enabled");
  });

  it("updates a source", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertSource(conn, "src-1", { name: "Original", baseUrl: "https://a.dev", trustPolicy: "strict", pinnedKeyIds: [] }, NOW);
    });

    const updated = db.withWriteTransaction((conn) =>
      repo.updateSource(conn, "src-1", { name: "Updated", trustPolicy: "permissive" }, "2025-06-15T13:00:00.000Z"),
    );
    expect(updated.name).toBe("Updated");
    expect(updated.trustPolicy).toBe("permissive");
    expect(updated.baseUrl).toBe("https://a.dev");
    expect(updated.updatedAt).toBe("2025-06-15T13:00:00.000Z");
  });

  it("enables and disables a source", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertSource(conn, "src-1", { name: "Test", baseUrl: "https://a.dev", trustPolicy: "strict", pinnedKeyIds: [] }, NOW);
      repo.setEnabled(conn, "src-1", false, NOW);
    });

    let fetched = db.withReadConnection((conn) => repo.getSourceById(conn, "src-1"));
    expect(fetched!.enabled).toBe(false);

    db.withWriteTransaction((conn) => repo.setEnabled(conn, "src-1", true, NOW));
    fetched = db.withReadConnection((conn) => repo.getSourceById(conn, "src-1"));
    expect(fetched!.enabled).toBe(true);
  });

  it("deletes source and its cache entries", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertSource(conn, "src-1", { name: "Test", baseUrl: "https://a.dev", trustPolicy: "strict", pinnedKeyIds: [] }, NOW);
      // Insert a cache entry
      conn.prepare(
        `INSERT INTO marketplace_cache (id, source_id, skill_id, version, manifest_json, signature_valid, indexed_at, trust_score, created_at, updated_at)
         VALUES ('cache-1', 'src-1', 'skill-1', '1.0.0', '{}', 0, ?, 50, ?, ?)`,
      ).run(NOW, NOW, NOW);
    });

    db.withWriteTransaction((conn) => repo.deleteSource(conn, "src-1"));

    const fetched = db.withReadConnection((conn) => repo.getSourceById(conn, "src-1"));
    expect(fetched).toBeNull();

    // Cache entries should also be deleted
    const cacheCount = db.withReadConnection((conn) =>
      (conn.prepare("SELECT COUNT(*) as cnt FROM marketplace_cache WHERE source_id = 'src-1'").get() as { cnt: number }).cnt,
    );
    expect(cacheCount).toBe(0);
  });

  it("round-trips pinned key IDs JSON", () => {
    const repo = createRepo();
    const keys = ["key-abc", "key-def", "key-ghi"];
    db.withWriteTransaction((conn) => {
      repo.insertSource(conn, "src-1", { name: "Test", baseUrl: "https://a.dev", trustPolicy: "strict", pinnedKeyIds: keys }, NOW);
    });

    const fetched = db.withReadConnection((conn) => repo.getSourceById(conn, "src-1"));
    expect(fetched!.pinnedKeyIds).toEqual(keys);
  });

  it("returns null for non-existent source", () => {
    const repo = createRepo();
    const fetched = db.withReadConnection((conn) => repo.getSourceById(conn, "no-such"));
    expect(fetched).toBeNull();
  });
});
```

### `test/unit/skills/marketplace/friday-marketplace-sync-job.test.ts`
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFridayMarketplaceSyncJob } from "../../../../src/jobs/marketplace/friday-marketplace-sync-job.js";
import type { FridayMarketplaceSyncService, FridaySyncResult } from "../../../../src/skills/services/friday-marketplace-sync-service.js";
import type { FridayMarketplaceCacheService } from "../../../../src/skills/services/friday-marketplace-cache-service.js";

describe("FridayMarketplaceSyncJob", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeSyncResult(overrides?: Partial<FridaySyncResult>): FridaySyncResult {
    return {
      sourceId: "src-1",
      sourceName: "Test",
      skillsSynced: 5,
      versionsSynced: 10,
      errors: [],
      ...overrides,
    };
  }

  function createMockSyncService(results: FridaySyncResult[] = [makeSyncResult()]): FridayMarketplaceSyncService {
    return {
      syncAllSources: vi.fn().mockResolvedValue(results),
      syncSource: vi.fn().mockResolvedValue(results[0]),
    };
  }

  function createMockCacheService(): FridayMarketplaceCacheService {
    return {
      getStaleSourceIds: vi.fn().mockReturnValue([]),
      pruneStaleEntries: vi.fn().mockReturnValue(0),
      clearSourceCache: vi.fn().mockReturnValue(0),
    };
  }

  it("runOnce syncs and prunes", async () => {
    const syncService = createMockSyncService();
    const cacheService = createMockCacheService();

    const job = createFridayMarketplaceSyncJob({ syncService, cacheService });
    const result = await job.runOnce();

    expect(cacheService.pruneStaleEntries).toHaveBeenCalled();
    expect(syncService.syncAllSources).toHaveBeenCalled();
    expect(result.sourcesAttempted).toBe(1);
    expect(result.sourcesSucceeded).toBe(1);
    expect(result.totalSkillsSynced).toBe(5);
    expect(result.totalVersionsSynced).toBe(10);
    expect(result.errors).toHaveLength(0);
  });

  it("runOnce reports errors from sources", async () => {
    const syncService = createMockSyncService([
      makeSyncResult({ errors: ["fetch failed"] }),
    ]);
    const cacheService = createMockCacheService();

    const job = createFridayMarketplaceSyncJob({ syncService, cacheService });
    const result = await job.runOnce();

    expect(result.sourcesSucceeded).toBe(0);
    expect(result.errors).toEqual(["fetch failed"]);
  });

  it("start/stop controls running state", () => {
    const syncService = createMockSyncService();
    const cacheService = createMockCacheService();

    const job = createFridayMarketplaceSyncJob({ syncService, cacheService });
    expect(job.isRunning()).toBe(false);

    job.start();
    expect(job.isRunning()).toBe(true);

    job.stop();
    expect(job.isRunning()).toBe(false);
  });

  it("runs cycle after start", async () => {
    const syncService = createMockSyncService();
    const cacheService = createMockCacheService();

    const job = createFridayMarketplaceSyncJob({
      syncService,
      cacheService,
      config: { intervalMs: 60000, jitterMs: 0, maxBackoffMs: 120000 },
    });

    job.start();

    // Initial delay of 1000ms
    await vi.advanceTimersByTimeAsync(1100);
    expect(syncService.syncAllSources).toHaveBeenCalled();

    job.stop();
  });

  it("start is idempotent", () => {
    const syncService = createMockSyncService();
    const cacheService = createMockCacheService();

    const job = createFridayMarketplaceSyncJob({ syncService, cacheService });
    job.start();
    job.start(); // second start should be no-op
    expect(job.isRunning()).toBe(true);
    job.stop();
  });

  it("handles sync failure with backoff", async () => {
    const syncService: FridayMarketplaceSyncService = {
      syncAllSources: vi.fn().mockRejectedValue(new Error("boom")),
      syncSource: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const cacheService = createMockCacheService();

    const job = createFridayMarketplaceSyncJob({
      syncService,
      cacheService,
      config: { intervalMs: 1000, jitterMs: 0, maxBackoffMs: 10000 },
    });

    job.start();

    // First cycle after 1s initial delay
    await vi.advanceTimersByTimeAsync(1100);
    expect(syncService.syncAllSources).toHaveBeenCalledTimes(1);

    // Should schedule next with backoff: 1000 * 2^1 = 2000ms
    await vi.advanceTimersByTimeAsync(2100);
    expect(syncService.syncAllSources).toHaveBeenCalledTimes(2);

    job.stop();
  });
});
```

### `test/unit/skills/marketplace/friday-marketplace-sync-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridayMarketplaceSourceRepository } from "../../../../src/skills/persistence/friday-marketplace-source-repository.js";
import { createFridayMarketplaceCacheRepository } from "../../../../src/skills/persistence/friday-marketplace-cache-repository.js";
import { createFridaySkillRepository } from "../../../../src/skills/persistence/friday-skill-repository.js";
import { createFridaySkillVersionRepository } from "../../../../src/skills/persistence/friday-skill-version-repository.js";
import { createFridayMarketplaceSyncService } from "../../../../src/skills/services/friday-marketplace-sync-service.js";
import { createFridaySkillSignatureVerifier } from "../../../../src/skills/services/friday-skill-signature-verifier.js";
import { createFridaySkillTrustScoringService } from "../../../../src/skills/services/friday-skill-trust-scoring-service.js";
import type { FridayMarketplaceHttpClient } from "../../../../src/skills/services/friday-marketplace-http-client.js";
import type { FridayMarketplaceIndexDocument } from "../../../../src/skills/model/friday-skill-marketplace.types.js";
import { createTestDb, createTestIdGenerator, NOW } from "./_helpers.js";

describe("FridayMarketplaceSyncService", () => {
  let db: FridaySqliteLayer;
  let idGen: () => string;

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();
  });

  afterEach(() => {
    db.close();
  });

  function makeIndexDoc(skills: FridayMarketplaceIndexDocument["skills"]): FridayMarketplaceIndexDocument {
    return { generatedAt: NOW, skills };
  }

  function createMockHttpClient(indexDoc: FridayMarketplaceIndexDocument): FridayMarketplaceHttpClient {
    return {
      async fetchIndex() { return indexDoc; },
      async fetchManifest() { return {}; },
      async fetchSignature() { return { skillId: "", version: "", keyId: "", algorithm: "ed25519" as const, value: "" }; },
      async fetchPublisherKey() { return { keyId: "", algorithm: "ed25519" as const }; },
      async fetchPackage() { return Buffer.alloc(0); },
    };
  }

  function createFailingHttpClient(): FridayMarketplaceHttpClient {
    return {
      async fetchIndex() { throw new Error("Network error"); },
      async fetchManifest() { throw new Error("Network error"); },
      async fetchSignature() { throw new Error("Network error"); },
      async fetchPublisherKey() { throw new Error("Network error"); },
      async fetchPackage() { throw new Error("Network error"); },
    };
  }

  it("syncs enabled sources successfully", async () => {
    const sourceRepo = createFridayMarketplaceSourceRepository();
    db.withWriteTransaction((conn) => {
      sourceRepo.insertSource(conn, "src-1", { name: "Test", baseUrl: "https://test.dev", trustPolicy: "warn", pinnedKeyIds: [] }, NOW);
    });

    const indexDoc = makeIndexDoc([
      {
        id: "weather-skill",
        name: "Weather",
        publisher: "Friday Labs",
        latestVersion: "1.2.0",
        versions: [
          { version: "1.0.0", checksum: "aaa", releasedAt: "2025-01-01T00:00:00.000Z", manifestUrl: "/m", packageUrl: "/p", signatureUrl: "/s" },
          { version: "1.2.0", checksum: "bbb", releasedAt: "2025-06-01T00:00:00.000Z", manifestUrl: "/m", packageUrl: "/p", signatureUrl: "/s" },
        ],
      },
    ]);

    const service = createFridayMarketplaceSyncService({
      db,
      sourceRepo,
      cacheRepo: createFridayMarketplaceCacheRepository(),
      skillRepo: createFridaySkillRepository(),
      versionRepo: createFridaySkillVersionRepository(),
      httpClient: createMockHttpClient(indexDoc),
      trustScoring: createFridaySkillTrustScoringService(),
      signatureVerifier: createFridaySkillSignatureVerifier(),
      idGenerator: idGen,
      nowIso: () => NOW,
    });

    const results = await service.syncAllSources();
    expect(results).toHaveLength(1);
    expect(results[0].skillsSynced).toBe(1);
    expect(results[0].versionsSynced).toBe(2);
    expect(results[0].errors).toHaveLength(0);

    // Verify skill was inserted
    const skill = db.withReadConnection((conn) =>
      createFridaySkillRepository().getSkillById(conn, "weather-skill"),
    );
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("Weather");
    expect(skill!.latestVersion).toBe("1.2.0");
  });

  it("handles partial source failure gracefully", async () => {
    const sourceRepo = createFridayMarketplaceSourceRepository();
    db.withWriteTransaction((conn) => {
      sourceRepo.insertSource(conn, "src-fail", { name: "Failing", baseUrl: "https://fail.dev", trustPolicy: "warn", pinnedKeyIds: [] }, NOW);
    });

    const service = createFridayMarketplaceSyncService({
      db,
      sourceRepo,
      cacheRepo: createFridayMarketplaceCacheRepository(),
      skillRepo: createFridaySkillRepository(),
      versionRepo: createFridaySkillVersionRepository(),
      httpClient: createFailingHttpClient(),
      trustScoring: createFridaySkillTrustScoringService(),
      signatureVerifier: createFridaySkillSignatureVerifier(),
      idGenerator: idGen,
      nowIso: () => NOW,
    });

    const results = await service.syncAllSources();
    expect(results).toHaveLength(1);
    expect(results[0].errors.length).toBeGreaterThan(0);
    expect(results[0].errors[0]).toContain("Network error");
  });

  it("skips disabled sources", async () => {
    const sourceRepo = createFridayMarketplaceSourceRepository();
    db.withWriteTransaction((conn) => {
      sourceRepo.insertSource(conn, "src-disabled", { name: "Disabled", baseUrl: "https://d.dev", trustPolicy: "warn", pinnedKeyIds: [] }, NOW);
      sourceRepo.setEnabled(conn, "src-disabled", false, NOW);
    });

    const service = createFridayMarketplaceSyncService({
      db,
      sourceRepo,
      cacheRepo: createFridayMarketplaceCacheRepository(),
      skillRepo: createFridaySkillRepository(),
      versionRepo: createFridaySkillVersionRepository(),
      httpClient: createFailingHttpClient(), // Would fail if called
      trustScoring: createFridaySkillTrustScoringService(),
      signatureVerifier: createFridaySkillSignatureVerifier(),
      idGenerator: idGen,
      nowIso: () => NOW,
    });

    const results = await service.syncAllSources();
    expect(results).toHaveLength(0); // Disabled sources not attempted
  });

  it("syncs single source by ID", async () => {
    const sourceRepo = createFridayMarketplaceSourceRepository();
    db.withWriteTransaction((conn) => {
      sourceRepo.insertSource(conn, "src-1", { name: "Test", baseUrl: "https://test.dev", trustPolicy: "permissive", pinnedKeyIds: [] }, NOW);
    });

    const indexDoc = makeIndexDoc([
      { id: "s1", name: "Skill 1", latestVersion: "1.0.0", versions: [{ version: "1.0.0", checksum: "x", releasedAt: NOW, manifestUrl: "/m", packageUrl: "/p", signatureUrl: "/s" }] },
    ]);

    const service = createFridayMarketplaceSyncService({
      db,
      sourceRepo,
      cacheRepo: createFridayMarketplaceCacheRepository(),
      skillRepo: createFridaySkillRepository(),
      versionRepo: createFridaySkillVersionRepository(),
      httpClient: createMockHttpClient(indexDoc),
      trustScoring: createFridaySkillTrustScoringService(),
      signatureVerifier: createFridaySkillSignatureVerifier(),
      idGenerator: idGen,
      nowIso: () => NOW,
    });

    const result = await service.syncSource("src-1");
    expect(result.skillsSynced).toBe(1);
    expect(result.sourceName).toBe("Test");
  });

  it("throws for non-existent source", async () => {
    const service = createFridayMarketplaceSyncService({
      db,
      sourceRepo: createFridayMarketplaceSourceRepository(),
      cacheRepo: createFridayMarketplaceCacheRepository(),
      skillRepo: createFridaySkillRepository(),
      versionRepo: createFridaySkillVersionRepository(),
      httpClient: createFailingHttpClient(),
      trustScoring: createFridaySkillTrustScoringService(),
      signatureVerifier: createFridaySkillSignatureVerifier(),
      idGenerator: idGen,
      nowIso: () => NOW,
    });

    await expect(service.syncSource("nonexistent")).rejects.toThrow("not found");
  });
});
```

### `test/unit/skills/marketplace/friday-skill-installation-repository.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridaySkillInstallationRepository } from "../../../../src/skills/persistence/friday-skill-installation-repository.js";
import { createTestDb, NOW } from "./_helpers.js";

describe("FridaySkillInstallationRepository", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
    // Insert a skill for FK
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `INSERT INTO skills (id, name, source, origin, status, created_at, updated_at)
         VALUES ('skill-1', 'Test Skill', 'marketplace', 'managed', 'not_installed', ?, ?)`,
      ).run(NOW, NOW);
    });
  });

  afterEach(() => {
    db.close();
  });

  function createRepo() {
    return createFridaySkillInstallationRepository();
  }

  it("inserts and retrieves an installation", () => {
    const repo = createRepo();
    const entity = db.withWriteTransaction((conn) =>
      repo.insertInstallation(conn, {
        id: "inst-1",
        skillId: "skill-1",
        version: "1.0.0",
        status: "installing",
        permissionsGranted: ["network.connect", "filesystem.read"],
        nowIso: NOW,
      }),
    );

    expect(entity.id).toBe("inst-1");
    expect(entity.skillId).toBe("skill-1");
    expect(entity.status).toBe("installing");
    expect(entity.permissionsGranted).toEqual(["network.connect", "filesystem.read"]);
    expect(entity.satelliteId).toBeUndefined();
    expect(entity.lastError).toBeUndefined();
  });

  it("updates installation status", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertInstallation(conn, { id: "inst-1", skillId: "skill-1", version: "1.0.0", status: "installing", permissionsGranted: [], nowIso: NOW });
      repo.setInstallationStatus(conn, "inst-1", "installed", NOW);
    });

    const installations = db.withReadConnection((conn) => repo.listBySkill(conn, "skill-1"));
    expect(installations[0].status).toBe("installed");
  });

  it("records installation error", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertInstallation(conn, { id: "inst-1", skillId: "skill-1", version: "1.0.0", status: "installing", permissionsGranted: [], nowIso: NOW });
      repo.setInstallationError(conn, "inst-1", "Checksum mismatch", NOW);
    });

    const installations = db.withReadConnection((conn) => repo.listBySkill(conn, "skill-1"));
    expect(installations[0].status).toBe("failed");
    expect(installations[0].lastError).toBe("Checksum mismatch");
  });

  it("lists installed history", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertInstallation(conn, { id: "inst-1", skillId: "skill-1", version: "1.0.0", status: "installed", permissionsGranted: [], nowIso: "2025-01-01T00:00:00.000Z" });
      repo.insertInstallation(conn, { id: "inst-2", skillId: "skill-1", version: "2.0.0", status: "installed", permissionsGranted: [], nowIso: "2025-06-01T00:00:00.000Z" });
      repo.insertInstallation(conn, { id: "inst-3", skillId: "skill-1", version: "3.0.0", status: "failed", permissionsGranted: [], nowIso: NOW });
    });

    const history = db.withReadConnection((conn) =>
      repo.listInstalledHistory(conn, "skill-1"),
    );
    // Only installed status, most recent first
    expect(history).toHaveLength(2);
    expect(history[0].version).toBe("2.0.0");
    expect(history[1].version).toBe("1.0.0");
  });

  it("lists by satellite and status", () => {
    const repo = createRepo();
    // Insert a satellite for FK
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `INSERT INTO satellites (id, type, display_name, pairing_status, trust_level, public_key, platform, arch, app_version, node_version, created_at, updated_at)
         VALUES ('sat-1', 'desktop', 'My Desktop', 'approved', 'standard', 'pk', 'darwin', 'arm64', '0.1.0', '22', ?, ?)`,
      ).run(NOW, NOW);

      repo.insertInstallation(conn, { id: "inst-1", skillId: "skill-1", version: "1.0.0", satelliteId: "sat-1", status: "installed", permissionsGranted: [], nowIso: NOW });
      repo.insertInstallation(conn, { id: "inst-2", skillId: "skill-1", version: "2.0.0", satelliteId: "sat-1", status: "failed", permissionsGranted: [], nowIso: NOW });
    });

    const installed = db.withReadConnection((conn) =>
      repo.listBySatelliteAndStatus(conn, "sat-1", "installed"),
    );
    expect(installed).toHaveLength(1);
    expect(installed[0].version).toBe("1.0.0");
  });

  it("handles installation with satellite ID", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `INSERT INTO satellites (id, type, display_name, pairing_status, trust_level, public_key, platform, arch, app_version, node_version, created_at, updated_at)
         VALUES ('sat-1', 'desktop', 'My Desktop', 'approved', 'standard', 'pk', 'darwin', 'arm64', '0.1.0', '22', ?, ?)`,
      ).run(NOW, NOW);

      repo.insertInstallation(conn, { id: "inst-1", skillId: "skill-1", version: "1.0.0", satelliteId: "sat-1", status: "installing", permissionsGranted: [], nowIso: NOW });
    });

    const inst = db.withReadConnection((conn) =>
      repo.listBySkill(conn, "skill-1"),
    );
    expect(inst[0].satelliteId).toBe("sat-1");
  });
});
```

### `test/unit/skills/marketplace/friday-skill-installation-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridaySkillRepository } from "../../../../src/skills/persistence/friday-skill-repository.js";
import { createFridaySkillInstallationRepository } from "../../../../src/skills/persistence/friday-skill-installation-repository.js";
import { createFridaySkillVersionRepository } from "../../../../src/skills/persistence/friday-skill-version-repository.js";
import { createFridayMarketplaceSourceRepository } from "../../../../src/skills/persistence/friday-marketplace-source-repository.js";
import { createFridayMarketplaceCacheRepository } from "../../../../src/skills/persistence/friday-marketplace-cache-repository.js";
import { createFridaySkillVersionResolutionService } from "../../../../src/skills/services/friday-skill-version-resolution-service.js";
import { createFridaySkillSignatureVerifier } from "../../../../src/skills/services/friday-skill-signature-verifier.js";
import { createFridaySkillTrustScoringService } from "../../../../src/skills/services/friday-skill-trust-scoring-service.js";
import { createFridaySkillPermissionCheckService } from "../../../../src/skills/services/friday-skill-permission-check-service.js";
import { createFridaySkillInstallationService } from "../../../../src/skills/services/friday-skill-installation-service.js";
import type { FridaySkillPackageInstaller } from "../../../../src/skills/services/friday-skill-package-installer.js";
import type { FridayMarketplaceHttpClient } from "../../../../src/skills/services/friday-marketplace-http-client.js";
import { createTestDb, createTestIdGenerator, NOW, createTestManifest } from "./_helpers.js";

describe("FridaySkillInstallationService", () => {
  let db: FridaySqliteLayer;
  let idGen: () => string;

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();

    // Set up a skill and versions
    const skillRepo = createFridaySkillRepository();
    const versionRepo = createFridaySkillVersionRepository();
    const sourceRepo = createFridayMarketplaceSourceRepository();

    db.withWriteTransaction((conn) => {
      sourceRepo.insertSource(conn, "src-1", {
        name: "Test",
        baseUrl: "https://test.dev",
        trustPolicy: "permissive",
        pinnedKeyIds: [],
      }, NOW);

      skillRepo.upsertSkillFromMarketplace(conn, {
        id: "skill-1",
        name: "Test Skill",
        source: "marketplace",
        origin: "managed",
        latestVersion: "1.0.0",
        status: "not_installed",
        nowIso: NOW,
      });

      const manifest = createTestManifest({
        id: "skill-1",
        version: "1.0.0",
        permissions: { grants: [], promptOn: [] },
      });

      versionRepo.upsertVersion(conn, {
        id: "v-1",
        skillId: "skill-1",
        version: "1.0.0",
        checksum: "", // Will be computed from package bytes
        packageUrl: "https://test.dev/packages/skill-1-1.0.0.tgz",
        manifest,
        releasedAt: NOW,
        nowIso: NOW,
      });
    });
  });

  afterEach(() => {
    db.close();
  });

  function createMockPackageInstaller(): FridaySkillPackageInstaller {
    return {
      stage: vi.fn().mockReturnValue("/tmp/staging"),
      activate: vi.fn().mockReturnValue("/tmp/final"),
      remove: vi.fn(),
    };
  }

  function createMockHttpClient(packageContent: string = "test package bytes"): FridayMarketplaceHttpClient {
    const buf = Buffer.from(packageContent);
    return {
      fetchIndex: vi.fn().mockResolvedValue({ generatedAt: NOW, skills: [] }),
      fetchManifest: vi.fn().mockResolvedValue({}),
      fetchSignature: vi.fn().mockRejectedValue(new Error("no sig")),
      fetchPublisherKey: vi.fn().mockRejectedValue(new Error("no key")),
      fetchPackage: vi.fn().mockResolvedValue(buf),
    };
  }

  function createService(
    httpClient?: FridayMarketplaceHttpClient,
    packageInstaller?: FridaySkillPackageInstaller,
  ) {
    const versionRepo = createFridaySkillVersionRepository();
    const installationRepo = createFridaySkillInstallationRepository();
    const cacheRepo = createFridayMarketplaceCacheRepository();

    // We need to fix the checksum to match the mock package
    const verifier = createFridaySkillSignatureVerifier();
    const mockBuf = Buffer.from("test package bytes");
    const correctChecksum = verifier.computeChecksum(mockBuf);

    // Update the version checksum in DB
    db.withWriteTransaction((conn) => {
      conn.prepare(
        "UPDATE skill_versions SET checksum = ? WHERE skill_id = 'skill-1' AND version = '1.0.0'",
      ).run(correctChecksum);
    });

    return createFridaySkillInstallationService({
      db,
      skillRepo: createFridaySkillRepository(),
      installationRepo,
      sourceRepo: createFridayMarketplaceSourceRepository(),
      versionResolver: createFridaySkillVersionResolutionService({
        db,
        versionRepo,
        installationRepo,
        cacheRepo,
      }),
      signatureVerifier: verifier,
      trustScoring: createFridaySkillTrustScoringService(),
      permissionCheck: createFridaySkillPermissionCheckService(),
      packageInstaller: packageInstaller ?? createMockPackageInstaller(),
      httpClient: httpClient ?? createMockHttpClient(),
      idGenerator: idGen,
      nowIso: () => NOW,
    });
  }

  it("installs a skill successfully", async () => {
    const service = createService();
    const result = await service.install({
      skillId: "skill-1",
      version: "1.0.0",
      grantPermissions: [],
    });

    expect(result.resolvedVersion).toBe("1.0.0");
    expect(result.installationIds).toHaveLength(1);
    expect(result.verification.integrityValid).toBe(true);
    expect(result.trust.total).toBeGreaterThan(0);

    // Check skill is now installed
    const skill = db.withReadConnection((conn) =>
      createFridaySkillRepository().getSkillById(conn, "skill-1"),
    );
    expect(skill!.installedVersion).toBe("1.0.0");
    expect(skill!.status).toBe("installed");
  });

  it("fails when download fails", async () => {
    const failingClient: FridayMarketplaceHttpClient = {
      fetchIndex: vi.fn().mockResolvedValue({ generatedAt: NOW, skills: [] }),
      fetchManifest: vi.fn().mockResolvedValue({}),
      fetchSignature: vi.fn().mockRejectedValue(new Error("no sig")),
      fetchPublisherKey: vi.fn().mockRejectedValue(new Error("no key")),
      fetchPackage: vi.fn().mockRejectedValue(new Error("Connection refused")),
    };

    const service = createService(failingClient);
    await expect(
      service.install({ skillId: "skill-1", version: "1.0.0" }),
    ).rejects.toThrow("Download failed");
  });

  it("fails when checksum mismatches", async () => {
    // Create http client with different content than expected
    const tamperClient: FridayMarketplaceHttpClient = {
      fetchIndex: vi.fn().mockResolvedValue({ generatedAt: NOW, skills: [] }),
      fetchManifest: vi.fn().mockResolvedValue({}),
      fetchSignature: vi.fn().mockRejectedValue(new Error("no sig")),
      fetchPublisherKey: vi.fn().mockRejectedValue(new Error("no key")),
      fetchPackage: vi.fn().mockResolvedValue(Buffer.from("tampered content")),
    };

    const service = createService(tamperClient);
    await expect(
      service.install({ skillId: "skill-1", version: "1.0.0" }),
    ).rejects.toThrow("Trust policy rejected");
  });

  it("fails when required permissions missing", async () => {
    // Update the manifest to have required permissions
    db.withWriteTransaction((conn) => {
      const manifest = createTestManifest({
        id: "skill-1",
        version: "1.0.0",
        permissions: {
          grants: [
            { id: "fs", resource: "filesystem", action: "write", required: true, reason: "Need FS" },
          ],
          promptOn: ["filesystem.write"],
        },
      });
      conn.prepare(
        "UPDATE skill_versions SET manifest_json = ? WHERE skill_id = 'skill-1' AND version = '1.0.0'",
      ).run(JSON.stringify(manifest));
    });

    const service = createService();
    await expect(
      service.install({ skillId: "skill-1", version: "1.0.0", grantPermissions: [] }),
    ).rejects.toThrow("Missing required permissions");
  });

  it("uninstalls a skill", async () => {
    const packageInstaller = createMockPackageInstaller();
    const service = createService(undefined, packageInstaller);

    // Install first
    await service.install({ skillId: "skill-1", version: "1.0.0" });

    // Then uninstall
    service.uninstall("skill-1");

    const skill = db.withReadConnection((conn) =>
      createFridaySkillRepository().getSkillById(conn, "skill-1"),
    );
    expect(skill!.installedVersion).toBeUndefined();
    expect(skill!.status).toBe("not_installed");
    expect(packageInstaller.remove).toHaveBeenCalledWith("skill-1", "1.0.0");
  });

  it("publishes event on successful install", async () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const versionRepo = createFridaySkillVersionRepository();
    const installationRepo = createFridaySkillInstallationRepository();
    const cacheRepo = createFridayMarketplaceCacheRepository();
    const verifier = createFridaySkillSignatureVerifier();
    const mockBuf = Buffer.from("test package bytes");
    const correctChecksum = verifier.computeChecksum(mockBuf);

    db.withWriteTransaction((conn) => {
      conn.prepare(
        "UPDATE skill_versions SET checksum = ? WHERE skill_id = 'skill-1' AND version = '1.0.0'",
      ).run(correctChecksum);
    });

    const service = createFridaySkillInstallationService({
      db,
      skillRepo: createFridaySkillRepository(),
      installationRepo,
      sourceRepo: createFridayMarketplaceSourceRepository(),
      versionResolver: createFridaySkillVersionResolutionService({ db, versionRepo, installationRepo, cacheRepo }),
      signatureVerifier: verifier,
      trustScoring: createFridaySkillTrustScoringService(),
      permissionCheck: createFridaySkillPermissionCheckService(),
      packageInstaller: createMockPackageInstaller(),
      httpClient: createMockHttpClient(),
      idGenerator: idGen,
      nowIso: () => NOW,
      publishEvent: async (event, payload) => {
        events.push({ event, payload });
      },
    });

    await service.install({ skillId: "skill-1", version: "1.0.0" });
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("skill.installed");
  });
});
```

### `test/unit/skills/marketplace/friday-skill-marketplace-runtime.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridaySkillMarketplaceRuntime } from "../../../../src/skills/runtime/friday-skill-marketplace-runtime.js";
import { createTestDb, createTestIdGenerator, NOW } from "./_helpers.js";
import type { FetchFn } from "../../../../src/skills/services/friday-marketplace-http-client.js";

describe("FridaySkillMarketplaceRuntime", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function createMockFetch(): FetchFn {
    return async () => ({
      ok: true,
      status: 200,
      json: async () => ({ generatedAt: NOW, skills: [] }),
      arrayBuffer: async () => new ArrayBuffer(0),
    });
  }

  it("creates runtime with all services wired", () => {
    const runtime = createFridaySkillMarketplaceRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      fetchFn: createMockFetch(),
      managedSkillsDir: "/tmp/friday-test-skills",
    });

    expect(runtime.sources).toBeDefined();
    expect(runtime.discovery).toBeDefined();
    expect(runtime.cache).toBeDefined();
    expect(runtime.sync).toBeDefined();
    expect(runtime.versions).toBeDefined();
    expect(runtime.installations).toBeDefined();
    expect(runtime.verify).toBeDefined();
    expect(runtime.trust).toBeDefined();
    expect(runtime.syncJob).toBeDefined();
  });

  it("source service works through runtime", () => {
    const runtime = createFridaySkillMarketplaceRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      fetchFn: createMockFetch(),
      managedSkillsDir: "/tmp/friday-test-skills",
    });

    const source = runtime.sources.addSource({
      name: "Test Source",
      baseUrl: "https://test.dev",
      trustPolicy: "warn",
      pinnedKeyIds: [],
    });

    expect(source.name).toBe("Test Source");
    expect(source.enabled).toBe(true);

    const sources = runtime.sources.listSources();
    expect(sources).toHaveLength(1);
  });

  it("sync service works through runtime", async () => {
    const runtime = createFridaySkillMarketplaceRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      fetchFn: createMockFetch(),
      managedSkillsDir: "/tmp/friday-test-skills",
    });

    // Add a source first
    runtime.sources.addSource({
      name: "Empty Source",
      baseUrl: "https://empty.dev",
      trustPolicy: "permissive",
      pinnedKeyIds: [],
    });

    const results = await runtime.sync.syncAllSources();
    expect(results).toHaveLength(1);
    expect(results[0].errors).toHaveLength(0);
  });

  it("trust scoring service works through runtime", () => {
    const runtime = createFridaySkillMarketplaceRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      fetchFn: createMockFetch(),
      managedSkillsDir: "/tmp/friday-test-skills",
    });

    const score = runtime.trust.computeScore({
      verification: { integrityValid: true, signatureValid: true, checks: ["integrity:pass", "signature:pass"] },
      trustPolicy: "strict",
      hasPinnedKeys: false,
      keyPinningPassed: false,
      publisherInstallCount: 5,
      indexedAt: NOW,
      nowIso: NOW,
      cacheTtlHours: 6,
    });

    expect(score.total).toBeGreaterThan(0);
    expect(score.signature).toBe(40);
  });

  it("verify service works through runtime", () => {
    const runtime = createFridaySkillMarketplaceRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      fetchFn: createMockFetch(),
      managedSkillsDir: "/tmp/friday-test-skills",
    });

    const buf = Buffer.from("test data");
    const checksum = runtime.verify.computeChecksum(buf);
    expect(checksum).toMatch(/^[a-f0-9]{64}$/);

    const result = runtime.verify.verifySignature({
      packageBytes: buf,
      expectedChecksum: checksum,
      skillId: "s1",
      version: "1.0.0",
    });
    expect(result.integrityValid).toBe(true);
  });

  it("syncJob can start and stop", () => {
    const runtime = createFridaySkillMarketplaceRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      fetchFn: createMockFetch(),
      managedSkillsDir: "/tmp/friday-test-skills",
    });

    expect(runtime.syncJob.isRunning()).toBe(false);
    runtime.syncJob.start();
    expect(runtime.syncJob.isRunning()).toBe(true);
    runtime.syncJob.stop();
    expect(runtime.syncJob.isRunning()).toBe(false);
  });

  it("accepts optional publishEvent", () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const runtime = createFridaySkillMarketplaceRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      fetchFn: createMockFetch(),
      managedSkillsDir: "/tmp/friday-test-skills",
      publishEvent: async (event, payload) => {
        events.push({ event, payload });
      },
    });

    expect(runtime).toBeDefined();
  });
});
```

### `test/unit/skills/marketplace/friday-skill-signature-verifier.test.ts`
```ts
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign, createSign, constants } from "node:crypto";
import { createFridaySkillSignatureVerifier } from "../../../../src/skills/services/friday-skill-signature-verifier.js";

describe("FridaySkillSignatureVerifier", () => {
  const verifier = createFridaySkillSignatureVerifier();

  function makePackage(content: string): Buffer {
    return Buffer.from(content);
  }

  describe("computeChecksum", () => {
    it("computes SHA-256 hex digest", () => {
      const buf = makePackage("hello world");
      const checksum = verifier.computeChecksum(buf);
      expect(checksum).toMatch(/^[a-f0-9]{64}$/);
      // Deterministic
      expect(verifier.computeChecksum(buf)).toBe(checksum);
    });
  });

  describe("integrity checks", () => {
    it("passes when checksums match", () => {
      const buf = makePackage("test package");
      const checksum = verifier.computeChecksum(buf);
      const result = verifier.verifySignature({
        packageBytes: buf,
        expectedChecksum: checksum,
        skillId: "s1",
        version: "1.0.0",
      });
      expect(result.integrityValid).toBe(true);
      expect(result.checks).toContain("integrity:pass");
    });

    it("fails when checksums mismatch", () => {
      const buf = makePackage("test package");
      const result = verifier.verifySignature({
        packageBytes: buf,
        expectedChecksum: "0000000000000000000000000000000000000000000000000000000000000000",
        skillId: "s1",
        version: "1.0.0",
      });
      expect(result.integrityValid).toBe(false);
      expect(result.signatureValid).toBe(false);
      expect(result.checks).toContain("integrity:fail");
    });
  });

  describe("Ed25519 signature verification", () => {
    it("verifies a valid Ed25519 signature", () => {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

      const buf = makePackage("ed25519 test");
      const checksum = verifier.computeChecksum(buf);
      const payload = Buffer.from(`friday-skill-signature-v1\nskill-ed\n1.0.0\n${checksum}`);
      const sig = sign(null, payload, privateKey);

      const result = verifier.verifySignature({
        packageBytes: buf,
        expectedChecksum: checksum,
        skillId: "skill-ed",
        version: "1.0.0",
        signatureDoc: {
          skillId: "skill-ed",
          version: "1.0.0",
          keyId: "ed-key-1",
          algorithm: "ed25519",
          value: sig.toString("base64"),
        },
        publisherKey: {
          keyId: "ed-key-1",
          algorithm: "ed25519",
          publicKeyPem: pubPem,
        },
      });

      expect(result.integrityValid).toBe(true);
      expect(result.signatureValid).toBe(true);
      expect(result.checks).toContain("signature:pass");
      expect(result.keyId).toBe("ed-key-1");
      expect(result.algorithm).toBe("ed25519");
    });

    it("rejects an invalid Ed25519 signature", () => {
      const { publicKey } = generateKeyPairSync("ed25519");
      const { privateKey: wrongKey } = generateKeyPairSync("ed25519");
      const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

      const buf = makePackage("tampered");
      const checksum = verifier.computeChecksum(buf);
      const payload = Buffer.from(`friday-skill-signature-v1\nskill-ed\n1.0.0\n${checksum}`);
      const wrongSig = sign(null, payload, wrongKey);

      const result = verifier.verifySignature({
        packageBytes: buf,
        expectedChecksum: checksum,
        skillId: "skill-ed",
        version: "1.0.0",
        signatureDoc: {
          skillId: "skill-ed",
          version: "1.0.0",
          keyId: "ed-key-1",
          algorithm: "ed25519",
          value: wrongSig.toString("base64"),
        },
        publisherKey: {
          keyId: "ed-key-1",
          algorithm: "ed25519",
          publicKeyPem: pubPem,
        },
      });

      expect(result.integrityValid).toBe(true);
      expect(result.signatureValid).toBe(false);
      expect(result.checks).toContain("signature:fail");
    });
  });

  describe("RSA-SHA256 signature verification", () => {
    it("verifies a valid RSA-SHA256 signature", () => {
      const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

      const buf = makePackage("rsa test");
      const checksum = verifier.computeChecksum(buf);
      const payload = Buffer.from(`friday-skill-signature-v1\nskill-rsa\n1.0.0\n${checksum}`);

      const signer = createSign("SHA256");
      signer.update(payload);
      const sig = signer.sign(privateKey);

      const result = verifier.verifySignature({
        packageBytes: buf,
        expectedChecksum: checksum,
        skillId: "skill-rsa",
        version: "1.0.0",
        signatureDoc: {
          skillId: "skill-rsa",
          version: "1.0.0",
          keyId: "rsa-key-1",
          algorithm: "rsa-sha256",
          value: sig.toString("base64"),
        },
        publisherKey: {
          keyId: "rsa-key-1",
          algorithm: "rsa-sha256",
          publicKeyPem: pubPem,
        },
      });

      expect(result.integrityValid).toBe(true);
      expect(result.signatureValid).toBe(true);
      expect(result.checks).toContain("signature:pass");
    });

    it("rejects an invalid RSA-SHA256 signature", () => {
      const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

      const buf = makePackage("rsa invalid");
      const checksum = verifier.computeChecksum(buf);

      const result = verifier.verifySignature({
        packageBytes: buf,
        expectedChecksum: checksum,
        skillId: "skill-rsa",
        version: "1.0.0",
        signatureDoc: {
          skillId: "skill-rsa",
          version: "1.0.0",
          keyId: "rsa-key-1",
          algorithm: "rsa-sha256",
          value: Buffer.from("invalid-signature").toString("base64"),
        },
        publisherKey: {
          keyId: "rsa-key-1",
          algorithm: "rsa-sha256",
          publicKeyPem: pubPem,
        },
      });

      expect(result.integrityValid).toBe(true);
      expect(result.signatureValid).toBe(false);
    });
  });

  describe("RSA-PSS-SHA256 signature verification", () => {
    it("verifies a valid RSA-PSS signature", () => {
      const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

      const buf = makePackage("rsa-pss test");
      const checksum = verifier.computeChecksum(buf);
      const payload = Buffer.from(`friday-skill-signature-v1\nskill-pss\n2.0.0\n${checksum}`);

      const pssSigner = createSign("SHA256");
      pssSigner.update(payload);
      const sig = pssSigner.sign({ key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });

      const result = verifier.verifySignature({
        packageBytes: buf,
        expectedChecksum: checksum,
        skillId: "skill-pss",
        version: "2.0.0",
        signatureDoc: {
          skillId: "skill-pss",
          version: "2.0.0",
          keyId: "pss-key-1",
          algorithm: "rsa-pss-sha256",
          value: sig.toString("base64"),
        },
        publisherKey: {
          keyId: "pss-key-1",
          algorithm: "rsa-pss-sha256",
          publicKeyPem: pubPem,
        },
      });

      expect(result.integrityValid).toBe(true);
      expect(result.signatureValid).toBe(true);
      expect(result.checks).toContain("signature:pass");
    });
  });

  describe("key pinning", () => {
    it("passes when key is in pinned list", () => {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

      const buf = makePackage("pinned test");
      const checksum = verifier.computeChecksum(buf);
      const payload = Buffer.from(`friday-skill-signature-v1\nskill-pin\n1.0.0\n${checksum}`);
      const sig = sign(null, payload, privateKey);

      const result = verifier.verifySignature({
        packageBytes: buf,
        expectedChecksum: checksum,
        skillId: "skill-pin",
        version: "1.0.0",
        signatureDoc: { skillId: "skill-pin", version: "1.0.0", keyId: "pinned-key", algorithm: "ed25519", value: sig.toString("base64") },
        publisherKey: { keyId: "pinned-key", algorithm: "ed25519", publicKeyPem: pubPem },
        pinnedKeyIds: ["pinned-key", "other-key"],
      });

      expect(result.signatureValid).toBe(true);
      expect(result.checks).toContain("key-pinning:pass");
    });

    it("rejects when key is not in pinned list", () => {
      const { publicKey } = generateKeyPairSync("ed25519");
      const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

      const buf = makePackage("unpinned test");
      const checksum = verifier.computeChecksum(buf);

      const result = verifier.verifySignature({
        packageBytes: buf,
        expectedChecksum: checksum,
        skillId: "skill-pin",
        version: "1.0.0",
        signatureDoc: { skillId: "skill-pin", version: "1.0.0", keyId: "wrong-key", algorithm: "ed25519", value: "dummysig" },
        publisherKey: { keyId: "wrong-key", algorithm: "ed25519", publicKeyPem: pubPem },
        pinnedKeyIds: ["pinned-key-only"],
      });

      expect(result.signatureValid).toBe(false);
      expect(result.checks).toContain("key-pinning:fail");
      expect(result.reason).toContain("not in pinned key list");
    });
  });

  describe("edge cases", () => {
    it("handles missing signature document", () => {
      const buf = makePackage("no sig");
      const checksum = verifier.computeChecksum(buf);
      const result = verifier.verifySignature({
        packageBytes: buf,
        expectedChecksum: checksum,
        skillId: "s1",
        version: "1.0.0",
      });
      expect(result.integrityValid).toBe(true);
      expect(result.signatureValid).toBe(false);
      expect(result.checks).toContain("signature:missing");
    });

    it("handles revoked key", () => {
      const { publicKey } = generateKeyPairSync("ed25519");
      const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

      const buf = makePackage("revoked");
      const checksum = verifier.computeChecksum(buf);
      const result = verifier.verifySignature({
        packageBytes: buf,
        expectedChecksum: checksum,
        skillId: "s1",
        version: "1.0.0",
        signatureDoc: { skillId: "s1", version: "1.0.0", keyId: "k1", algorithm: "ed25519", value: "sig" },
        publisherKey: { keyId: "k1", algorithm: "ed25519", publicKeyPem: pubPem, revokedAt: "2025-01-01T00:00:00.000Z" },
      });
      expect(result.signatureValid).toBe(false);
      expect(result.checks).toContain("key:revoked");
    });
  });
});
```

### `test/unit/skills/marketplace/friday-skill-trust-scoring-service.test.ts`
```ts
import { describe, it, expect } from "vitest";
import { createFridaySkillTrustScoringService } from "../../../../src/skills/services/friday-skill-trust-scoring-service.js";
import type { FridaySignatureVerificationResult } from "../../../../src/skills/model/friday-skill-marketplace.types.js";
import { NOW } from "./_helpers.js";

describe("FridaySkillTrustScoringService", () => {
  const service = createFridaySkillTrustScoringService();

  function validVerification(): FridaySignatureVerificationResult {
    return {
      integrityValid: true,
      signatureValid: true,
      checks: ["integrity:pass", "signature:pass", "key-pinning:pass"],
    };
  }

  function noSigVerification(): FridaySignatureVerificationResult {
    return {
      integrityValid: true,
      signatureValid: false,
      checks: ["integrity:pass", "signature:missing"],
    };
  }

  function failedIntegrity(): FridaySignatureVerificationResult {
    return {
      integrityValid: false,
      signatureValid: false,
      checks: ["integrity:fail"],
    };
  }

  function failedSigVerification(): FridaySignatureVerificationResult {
    return {
      integrityValid: true,
      signatureValid: false,
      checks: ["integrity:pass", "signature:fail"],
    };
  }

  describe("computeScore", () => {
    it("computes maximum score for fully valid strict source", () => {
      const score = service.computeScore({
        verification: validVerification(),
        trustPolicy: "strict",
        hasPinnedKeys: true,
        keyPinningPassed: true,
        publisherInstallCount: 10,
        indexedAt: NOW,
        nowIso: NOW,
        cacheTtlHours: 6,
      });

      // 40 (sig) + 15 (integrity) + 20 (pin) + 15 (strict) + 10 (publisher capped) + 10 (fresh) = 110
      expect(score.signature).toBe(40);
      expect(score.integrity).toBe(15);
      expect(score.keyPinning).toBe(20);
      expect(score.sourcePolicy).toBe(15);
      expect(score.publisher).toBe(10);
      expect(score.freshness).toBe(10);
      expect(score.total).toBe(110);
    });

    it("gives 0 for signature when invalid", () => {
      const score = service.computeScore({
        verification: noSigVerification(),
        trustPolicy: "warn",
        hasPinnedKeys: false,
        keyPinningPassed: false,
        publisherInstallCount: 3,
        indexedAt: NOW,
        nowIso: NOW,
        cacheTtlHours: 6,
      });

      expect(score.signature).toBe(0);
      expect(score.integrity).toBe(15);
      expect(score.keyPinning).toBe(10); // not configured
      expect(score.sourcePolicy).toBe(10); // warn
    });

    it("gives 0 for integrity when failed", () => {
      const score = service.computeScore({
        verification: failedIntegrity(),
        trustPolicy: "permissive",
        hasPinnedKeys: false,
        keyPinningPassed: false,
        publisherInstallCount: 0,
        indexedAt: NOW,
        nowIso: NOW,
        cacheTtlHours: 6,
      });

      expect(score.integrity).toBe(0);
    });

    it("reduces freshness for stale entries", () => {
      const staleDate = new Date(new Date(NOW).getTime() - 24 * 60 * 60 * 1000).toISOString();
      const score = service.computeScore({
        verification: validVerification(),
        trustPolicy: "warn",
        hasPinnedKeys: false,
        keyPinningPassed: false,
        publisherInstallCount: 0,
        indexedAt: staleDate,
        nowIso: NOW,
        cacheTtlHours: 6,
      });

      // 24h old with 6h TTL → ageMs = 24h, threshold = 24h → freshness should be 0
      expect(score.freshness).toBe(0);
    });

    it("caps publisher score at 10", () => {
      const score = service.computeScore({
        verification: validVerification(),
        trustPolicy: "strict",
        hasPinnedKeys: true,
        keyPinningPassed: true,
        publisherInstallCount: 999,
        indexedAt: NOW,
        nowIso: NOW,
        cacheTtlHours: 6,
      });

      expect(score.publisher).toBe(10);
    });

    it("gives 0 key pinning when configured but failed", () => {
      const score = service.computeScore({
        verification: validVerification(),
        trustPolicy: "strict",
        hasPinnedKeys: true,
        keyPinningPassed: false,
        publisherInstallCount: 0,
        indexedAt: NOW,
        nowIso: NOW,
        cacheTtlHours: 6,
      });

      expect(score.keyPinning).toBe(0);
    });

    it("gives source policy 5 for permissive", () => {
      const score = service.computeScore({
        verification: validVerification(),
        trustPolicy: "permissive",
        hasPinnedKeys: false,
        keyPinningPassed: false,
        publisherInstallCount: 0,
        indexedAt: NOW,
        nowIso: NOW,
        cacheTtlHours: 6,
      });

      expect(score.sourcePolicy).toBe(5);
    });
  });

  describe("evaluatePolicy", () => {
    it("strict: allows when score high and sig valid", () => {
      const breakdown = service.computeScore({
        verification: validVerification(),
        trustPolicy: "strict",
        hasPinnedKeys: true,
        keyPinningPassed: true,
        publisherInstallCount: 5,
        indexedAt: NOW,
        nowIso: NOW,
        cacheTtlHours: 6,
      });

      const decision = service.evaluatePolicy("strict", breakdown, validVerification());
      expect(decision.allowed).toBe(true);
    });

    it("strict: rejects when signature invalid", () => {
      const breakdown = service.computeScore({
        verification: noSigVerification(),
        trustPolicy: "strict",
        hasPinnedKeys: false,
        keyPinningPassed: false,
        publisherInstallCount: 10,
        indexedAt: NOW,
        nowIso: NOW,
        cacheTtlHours: 6,
      });

      const decision = service.evaluatePolicy("strict", breakdown, noSigVerification());
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("signature");
    });

    it("warn: allows with warning when score between thresholds", () => {
      const verification = validVerification();
      const breakdown = {
        total: 75,
        signature: 40,
        integrity: 15,
        keyPinning: 10,
        sourcePolicy: 10,
        publisher: 0,
        freshness: 0,
        reasons: [],
      };

      const decision = service.evaluatePolicy("warn", breakdown, verification);
      expect(decision.allowed).toBe(true);
      expect(decision.warnings.length).toBeGreaterThan(0);
    });

    it("warn: rejects when integrity fails", () => {
      const breakdown = { total: 50, signature: 0, integrity: 0, keyPinning: 10, sourcePolicy: 10, publisher: 0, freshness: 0, reasons: [] };
      const decision = service.evaluatePolicy("warn", breakdown, failedIntegrity());
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("integrity");
    });

    it("permissive: rejects explicit signature fraud", () => {
      const breakdown = { total: 60, signature: 0, integrity: 15, keyPinning: 10, sourcePolicy: 5, publisher: 10, freshness: 10, reasons: [] };
      const decision = service.evaluatePolicy("permissive", breakdown, failedSigVerification());
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("tampering");
    });

    it("permissive: allows missing signature with good integrity", () => {
      const breakdown = { total: 50, signature: 0, integrity: 15, keyPinning: 10, sourcePolicy: 5, publisher: 10, freshness: 10, reasons: [] };
      const decision = service.evaluatePolicy("permissive", breakdown, noSigVerification());
      expect(decision.allowed).toBe(true);
    });

    it("permissive: rejects below threshold", () => {
      const breakdown = { total: 20, signature: 0, integrity: 15, keyPinning: 0, sourcePolicy: 5, publisher: 0, freshness: 0, reasons: [] };
      const decision = service.evaluatePolicy("permissive", breakdown, noSigVerification());
      expect(decision.allowed).toBe(false);
    });
  });
});
```

### `test/unit/skills/marketplace/friday-skill-version-repository.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridaySkillVersionRepository } from "../../../../src/skills/persistence/friday-skill-version-repository.js";
import { createTestDb, NOW, createTestManifest } from "./_helpers.js";

describe("FridaySkillVersionRepository", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
    // Insert a skill for FK
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `INSERT INTO skills (id, name, source, origin, status, created_at, updated_at)
         VALUES ('skill-1', 'Test Skill', 'marketplace', 'managed', 'not_installed', ?, ?)`,
      ).run(NOW, NOW);
    });
  });

  afterEach(() => {
    db.close();
  });

  function createRepo() {
    return createFridaySkillVersionRepository();
  }

  it("upserts and retrieves a version", () => {
    const repo = createRepo();
    const manifest = createTestManifest({ id: "skill-1", version: "1.0.0" });
    const entity = db.withWriteTransaction((conn) =>
      repo.upsertVersion(conn, {
        id: "v-1",
        skillId: "skill-1",
        version: "1.0.0",
        checksum: "abc123",
        packageUrl: "https://pkg.dev/skill-1-1.0.0.tgz",
        signature: { keyId: "key-1", algorithm: "ed25519", value: "sig-base64" },
        manifest,
        releasedAt: NOW,
        nowIso: NOW,
      }),
    );

    expect(entity.skillId).toBe("skill-1");
    expect(entity.version).toBe("1.0.0");
    expect(entity.checksum).toBe("abc123");
    expect(entity.packageUrl).toBe("https://pkg.dev/skill-1-1.0.0.tgz");
    expect(entity.signature).toEqual({ keyId: "key-1", algorithm: "ed25519", value: "sig-base64" });
    expect(entity.manifest.id).toBe("skill-1");
  });

  it("upsert updates on conflict", () => {
    const repo = createRepo();
    const manifest = createTestManifest({ id: "skill-1", version: "1.0.0" });
    db.withWriteTransaction((conn) => {
      repo.upsertVersion(conn, { id: "v-1", skillId: "skill-1", version: "1.0.0", checksum: "old", manifest, releasedAt: NOW, nowIso: NOW });
      repo.upsertVersion(conn, { id: "v-2", skillId: "skill-1", version: "1.0.0", checksum: "new", manifest, releasedAt: NOW, nowIso: NOW });
    });

    const fetched = db.withReadConnection((conn) => repo.getVersion(conn, "skill-1", "1.0.0"));
    expect(fetched!.checksum).toBe("new");
  });

  it("lists versions sorted by release date", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.upsertVersion(conn, { id: "v-1", skillId: "skill-1", version: "1.0.0", checksum: "a", manifest: createTestManifest({ version: "1.0.0" }), releasedAt: "2025-01-01T00:00:00.000Z", nowIso: NOW });
      repo.upsertVersion(conn, { id: "v-2", skillId: "skill-1", version: "2.0.0", checksum: "b", manifest: createTestManifest({ version: "2.0.0" }), releasedAt: "2025-06-01T00:00:00.000Z", nowIso: NOW });
      repo.upsertVersion(conn, { id: "v-3", skillId: "skill-1", version: "1.5.0", checksum: "c", manifest: createTestManifest({ version: "1.5.0" }), releasedAt: "2025-03-01T00:00:00.000Z", nowIso: NOW });
    });

    const versions = db.withReadConnection((conn) => repo.listVersions(conn, "skill-1"));
    expect(versions).toHaveLength(3);
    expect(versions[0].version).toBe("2.0.0");
    expect(versions[1].version).toBe("1.5.0");
    expect(versions[2].version).toBe("1.0.0");
  });

  it("marks and clears yanked status", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.upsertVersion(conn, { id: "v-1", skillId: "skill-1", version: "1.0.0", checksum: "a", manifest: createTestManifest(), releasedAt: NOW, nowIso: NOW });
      repo.markYanked(conn, "skill-1", "1.0.0", NOW);
    });

    let fetched = db.withReadConnection((conn) => repo.getVersion(conn, "skill-1", "1.0.0"));
    expect(fetched!.yankedAt).toBe(NOW);

    db.withWriteTransaction((conn) => repo.clearYanked(conn, "skill-1", "1.0.0", NOW));
    fetched = db.withReadConnection((conn) => repo.getVersion(conn, "skill-1", "1.0.0"));
    expect(fetched!.yankedAt).toBeUndefined();
  });

  it("listVersionsForResolution excludes yanked by default", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.upsertVersion(conn, { id: "v-1", skillId: "skill-1", version: "1.0.0", checksum: "a", manifest: createTestManifest(), releasedAt: NOW, nowIso: NOW });
      repo.upsertVersion(conn, { id: "v-2", skillId: "skill-1", version: "2.0.0", checksum: "b", manifest: createTestManifest(), releasedAt: NOW, nowIso: NOW });
      repo.markYanked(conn, "skill-1", "1.0.0", NOW);
    });

    const versions = db.withReadConnection((conn) =>
      repo.listVersionsForResolution(conn, "skill-1"),
    );
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe("2.0.0");

    // Including yanked
    const allVersions = db.withReadConnection((conn) =>
      repo.listVersionsForResolution(conn, "skill-1", true),
    );
    expect(allVersions).toHaveLength(2);
  });

  it("sets signature fields", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.upsertVersion(conn, { id: "v-1", skillId: "skill-1", version: "1.0.0", checksum: "a", manifest: createTestManifest(), releasedAt: NOW, nowIso: NOW });
    });

    // Initially no signature
    let fetched = db.withReadConnection((conn) => repo.getVersion(conn, "skill-1", "1.0.0"));
    expect(fetched!.signature).toBeUndefined();

    db.withWriteTransaction((conn) =>
      repo.setSignatureFields(conn, "skill-1", "1.0.0", { keyId: "k1", algorithm: "rsa-sha256", value: "sig" }, NOW),
    );

    fetched = db.withReadConnection((conn) => repo.getVersion(conn, "skill-1", "1.0.0"));
    expect(fetched!.signature).toEqual({ keyId: "k1", algorithm: "rsa-sha256", value: "sig" });
  });

  it("returns null for non-existent version", () => {
    const repo = createRepo();
    const result = db.withReadConnection((conn) => repo.getVersion(conn, "skill-1", "9.9.9"));
    expect(result).toBeNull();
  });
});
```

### `test/unit/skills/marketplace/friday-skill-version-resolution-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridaySkillVersionRepository } from "../../../../src/skills/persistence/friday-skill-version-repository.js";
import { createFridaySkillInstallationRepository } from "../../../../src/skills/persistence/friday-skill-installation-repository.js";
import { createFridayMarketplaceCacheRepository } from "../../../../src/skills/persistence/friday-marketplace-cache-repository.js";
import { createFridaySkillVersionResolutionService } from "../../../../src/skills/services/friday-skill-version-resolution-service.js";
import { createTestDb, NOW, createTestManifest } from "./_helpers.js";

describe("FridaySkillVersionResolutionService", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `INSERT INTO skills (id, name, source, origin, status, created_at, updated_at)
         VALUES ('skill-1', 'Test Skill', 'marketplace', 'managed', 'not_installed', ?, ?)`,
      ).run(NOW, NOW);
    });
  });

  afterEach(() => {
    db.close();
  });

  function setupVersions() {
    const versionRepo = createFridaySkillVersionRepository();
    db.withWriteTransaction((conn) => {
      versionRepo.upsertVersion(conn, { id: "v-1", skillId: "skill-1", version: "1.0.0", checksum: "aaa", packageUrl: "https://pkg/1.0.0.tgz", manifest: createTestManifest({ version: "1.0.0" }), releasedAt: "2025-01-01T00:00:00.000Z", nowIso: NOW });
      versionRepo.upsertVersion(conn, { id: "v-2", skillId: "skill-1", version: "1.5.0", checksum: "bbb", packageUrl: "https://pkg/1.5.0.tgz", manifest: createTestManifest({ version: "1.5.0" }), releasedAt: "2025-03-01T00:00:00.000Z", nowIso: NOW });
      versionRepo.upsertVersion(conn, { id: "v-3", skillId: "skill-1", version: "2.0.0", checksum: "ccc", packageUrl: "https://pkg/2.0.0.tgz", manifest: createTestManifest({ version: "2.0.0" }), releasedAt: "2025-06-01T00:00:00.000Z", nowIso: NOW });
    });
    return versionRepo;
  }

  function createService() {
    return createFridaySkillVersionResolutionService({
      db,
      versionRepo: createFridaySkillVersionRepository(),
      installationRepo: createFridaySkillInstallationRepository(),
      cacheRepo: createFridayMarketplaceCacheRepository(),
    });
  }

  it("resolves exact version for install", () => {
    setupVersions();
    const service = createService();
    const result = service.resolve({
      skillId: "skill-1",
      requestedVersion: "1.5.0",
      strategy: "install",
    });
    expect(result.version).toBe("1.5.0");
    expect(result.checksum).toBe("bbb");
    expect(result.reason).toContain("1.5.0");
  });

  it("resolves latest version when no version requested", () => {
    setupVersions();
    const service = createService();
    const result = service.resolve({
      skillId: "skill-1",
      strategy: "install",
    });
    expect(result.version).toBe("2.0.0");
  });

  it("resolves semver range", () => {
    setupVersions();
    const service = createService();
    const result = service.resolve({
      skillId: "skill-1",
      requestedVersion: "^1.0.0",
      strategy: "install",
    });
    expect(result.version).toBe("1.5.0"); // Highest matching ^1.0.0
  });

  it("upgrade selects latest version", () => {
    setupVersions();
    const service = createService();
    const result = service.resolve({
      skillId: "skill-1",
      strategy: "upgrade",
    });
    expect(result.version).toBe("2.0.0");
    expect(result.reason).toContain("Upgrade");
  });

  it("excludes yanked versions by default", () => {
    const versionRepo = setupVersions();
    db.withWriteTransaction((conn) => {
      versionRepo.markYanked(conn, "skill-1", "2.0.0", NOW);
    });

    const service = createService();
    const result = service.resolve({
      skillId: "skill-1",
      strategy: "install",
    });
    expect(result.version).toBe("1.5.0"); // 2.0.0 yanked
  });

  it("includes yanked versions when allowed", () => {
    const versionRepo = setupVersions();
    db.withWriteTransaction((conn) => {
      versionRepo.markYanked(conn, "skill-1", "2.0.0", NOW);
    });

    const service = createService();
    const result = service.resolve({
      skillId: "skill-1",
      strategy: "install",
      allowYanked: true,
    });
    expect(result.version).toBe("2.0.0");
  });

  it("throws when no matching version found", () => {
    setupVersions();
    const service = createService();
    expect(() =>
      service.resolve({
        skillId: "skill-1",
        requestedVersion: "9.9.9",
        strategy: "install",
      }),
    ).toThrow("No matching version");
  });

  it("rollback resolves previous installed version", () => {
    setupVersions();
    const installationRepo = createFridaySkillInstallationRepository();
    db.withWriteTransaction((conn) => {
      installationRepo.insertInstallation(conn, { id: "i-1", skillId: "skill-1", version: "1.0.0", status: "installed", permissionsGranted: [], nowIso: "2025-01-01T00:00:00.000Z" });
      installationRepo.insertInstallation(conn, { id: "i-2", skillId: "skill-1", version: "2.0.0", status: "installed", permissionsGranted: [], nowIso: "2025-06-01T00:00:00.000Z" });
    });

    const service = createFridaySkillVersionResolutionService({
      db,
      versionRepo: createFridaySkillVersionRepository(),
      installationRepo,
      cacheRepo: createFridayMarketplaceCacheRepository(),
    });

    const result = service.resolve({
      skillId: "skill-1",
      strategy: "rollback",
    });
    expect(result.version).toBe("1.0.0");
    expect(result.reason).toContain("Rollback");
  });

  it("rollback throws when no previous version exists", () => {
    setupVersions();
    const installationRepo = createFridaySkillInstallationRepository();
    db.withWriteTransaction((conn) => {
      installationRepo.insertInstallation(conn, { id: "i-1", skillId: "skill-1", version: "1.0.0", status: "installed", permissionsGranted: [], nowIso: NOW });
    });

    const service = createFridaySkillVersionResolutionService({
      db,
      versionRepo: createFridaySkillVersionRepository(),
      installationRepo,
      cacheRepo: createFridayMarketplaceCacheRepository(),
    });

    expect(() =>
      service.resolve({ skillId: "skill-1", strategy: "rollback" }),
    ).toThrow("No previous installed version");
  });
});
```

