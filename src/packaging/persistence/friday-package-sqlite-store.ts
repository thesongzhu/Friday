/**
 * SQLite-backed persistence for Friday package registry, install lifecycle,
 * trusted keys, rollbacks and lifecycle audit log (Phase 11 Module 16).
 *
 * Provides drop-in replacements for the in-memory {@link RegistryManager} and
 * {@link PackageInstaller} surfaces that live in
 * `src/packaging/engine/*`.  The schema is defined in migration v079.
 *
 * Tables (see migration v079):
 * - package_registry
 * - package_installs
 * - package_rollbacks
 * - package_trusted_keys
 * - package_lifecycle_log
 *
 * @module packaging/persistence
 */

import type Database from "better-sqlite3";
import * as crypto from "node:crypto";

import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type {
  FridayPackageEngineConfig,
  FridayPackageInstall,
  FridayPackageInstallRow,
  FridayPackageInstallState,
  FridayPackageLifecycleEvent,
  FridayPackageLifecycleLogRow,
  FridayPackageLifecycleOperation,
  FridayPackageRegistryEntry,
  FridayPackageRegistryRow,
  FridayPackageRollback,
  FridayPackageRollbackRow,
  FridayPackageRollbackState,
  FridayPackageSignature,
  FridayPackageTrustedKey,
  FridayPackageTrustedKeyRow,
  FridayPackageVerificationResult,
  ISODateTime,
  JsonObject,
  UUID,
} from "../model/friday-packaging.types.js";

import { compareSemverStr, maxSatisfying } from "../engine/semver.js";
import {
  type DuplicateCheckResult,
  type PublishOptions,
  type RegistryManager,
  type RegistryPage,
  type RegistryPagination,
  type RegistrySearchCriteria,
  RegistryVersionConflictError,
} from "../engine/registry-manager.js";
import type {
  InstallOptions,
  InstallResult,
  LifecycleEventQuery,
  PackageInstaller,
  PackageVerifier,
  RollbackOptions,
  RollbackResult,
  UninstallOptions,
  UninstallResult,
  UpgradeOptions,
  UpgradeResult,
} from "../engine/package-installer.js";
import {
  isValidInstallTransition,
} from "../engine/package-installer.js";

// ─── Shared helpers ───

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function safeJsonParse<T>(input: string | null | undefined, fallback: T): T {
  if (!input) return fallback;
  try {
    return JSON.parse(input) as T;
  } catch {
    return fallback;
  }
}

function defaultConfig(): Pick<FridayPackageEngineConfig, "generateId" | "nowIso"> {
  return {
    generateId: () => crypto.randomUUID(),
    nowIso: () => new Date().toISOString(),
  };
}

// ─── Registry repository ───

function rowToRegistryEntry(row: FridayPackageRegistryRow): FridayPackageRegistryEntry {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description ?? undefined,
    author: safeJsonParse(row.author_json, { name: "unknown" }),
    license: row.license ?? undefined,
    capabilities: safeJsonParse(row.capabilities_json, [] as string[]),
    dependencies: safeJsonParse(row.dependencies_json, {} as Record<string, string>),
    peerDependencies: safeJsonParse(row.peer_deps_json, {} as Record<string, string>),
    fridayVersionRange: row.friday_version,
    assets: safeJsonParse(row.assets_json, {}),
    hooks: safeJsonParse(row.hooks_json, {}),
    metadata: safeJsonParse(row.metadata_json, {}),
    sizeBytes: row.size_bytes,
    archiveDigest: row.archive_digest,
    manifestDigest: row.manifest_digest,
    signature: safeJsonParse(row.signature_json, {}) as FridayPackageSignature,
    publishedBy: row.published_by,
    tenantId: row.tenant_id ?? undefined,
    etag: row.etag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function registryEntryToRow(entry: FridayPackageRegistryEntry): FridayPackageRegistryRow {
  return {
    id: entry.id,
    name: entry.name,
    version: entry.version,
    description: entry.description ?? null,
    author_json: JSON.stringify(entry.author),
    license: entry.license ?? null,
    capabilities_json: JSON.stringify(entry.capabilities),
    dependencies_json: JSON.stringify(entry.dependencies ?? {}),
    peer_deps_json: JSON.stringify(entry.peerDependencies ?? {}),
    friday_version: entry.fridayVersionRange,
    assets_json: JSON.stringify(entry.assets ?? {}),
    hooks_json: JSON.stringify(entry.hooks ?? {}),
    metadata_json: JSON.stringify(entry.metadata ?? {}),
    size_bytes: entry.sizeBytes,
    archive_digest: entry.archiveDigest,
    manifest_digest: entry.manifestDigest,
    signature_json: JSON.stringify(entry.signature),
    published_by: entry.publishedBy,
    tenant_id: entry.tenantId ?? null,
    etag: entry.etag,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
    deleted_at: null,
  };
}

export interface SqliteRegistryManagerConfig {
  readonly sqlite: FridaySqliteLayer;
  readonly generateId?: () => UUID;
  readonly nowIso?: () => ISODateTime;
}

export function createSqliteRegistryManager(
  config: SqliteRegistryManagerConfig,
): RegistryManager {
  const { sqlite } = config;
  const generateId = config.generateId ?? defaultConfig().generateId;
  const nowIso = config.nowIso ?? defaultConfig().nowIso;

  function readActiveById(id: UUID): FridayPackageRegistryEntry | null {
    const row = sqlite.withReadConnection((db) =>
      db.prepare("SELECT * FROM package_registry WHERE id = ? AND deleted_at IS NULL").get(id) as FridayPackageRegistryRow | undefined,
    );
    return row ? rowToRegistryEntry(row) : null;
  }

  function readByNameVersion(name: string, version: string, tenantId?: string): FridayPackageRegistryEntry | null {
    const row = sqlite.withReadConnection((db) =>
      db.prepare(
        `SELECT * FROM package_registry
         WHERE name = ? AND version = ?
           AND IFNULL(tenant_id,'__global__') = IFNULL(?, '__global__')
           AND deleted_at IS NULL`,
      ).get(name, version, tenantId ?? null) as FridayPackageRegistryRow | undefined,
    );
    return row ? rowToRegistryEntry(row) : null;
  }

  function readAllVersionsForScope(name: string, tenantId?: string): FridayPackageRegistryEntry[] {
    const rows = sqlite.withReadConnection((db) =>
      db.prepare(
        `SELECT * FROM package_registry
         WHERE name = ? AND IFNULL(tenant_id,'__global__') = IFNULL(?, '__global__')
           AND deleted_at IS NULL`,
      ).all(name, tenantId ?? null) as FridayPackageRegistryRow[],
    );
    return rows.map(rowToRegistryEntry);
  }

  function readMergedVersionsForTenant(name: string, tenantId?: string): FridayPackageRegistryEntry[] {
    if (!tenantId) {
      return readAllVersionsForScope(name, undefined)
        .sort((a, b) => compareSemverStr(b.version, a.version));
    }
    const tenantVersions = readAllVersionsForScope(name, tenantId);
    const globalVersions = readAllVersionsForScope(name, undefined);
    const merged = new Map<string, FridayPackageRegistryEntry>();
    for (const v of globalVersions) merged.set(v.version, v);
    for (const v of tenantVersions) merged.set(v.version, v);
    return [...merged.values()].sort((a, b) => compareSemverStr(b.version, a.version));
  }

  const manager: RegistryManager = {
    publish(options: PublishOptions): FridayPackageRegistryEntry {
      const {
        manifest,
        signature,
        archiveDigest,
        manifestDigest,
        sizeBytes,
        publishedBy,
        tenantId,
      } = options;

      const duplicate = manager.checkDuplicate(
        manifest.name,
        manifest.version,
        tenantId,
        archiveDigest,
        manifestDigest,
      );
      if (duplicate.isDuplicate && duplicate.existingEntry) {
        if (duplicate.isSameContent) return duplicate.existingEntry;
        throw new RegistryVersionConflictError(manifest.name, manifest.version, tenantId);
      }

      const now = nowIso();
      const entry: FridayPackageRegistryEntry = {
        id: generateId(),
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author: structuredClone(manifest.author),
        license: manifest.license,
        capabilities: structuredClone(manifest.capabilities),
        dependencies: structuredClone(manifest.dependencies),
        peerDependencies: structuredClone(manifest.peerDependencies ?? {}),
        fridayVersionRange: manifest.fridayVersionRange,
        assets: structuredClone(manifest.assets ?? {}),
        hooks: structuredClone(manifest.hooks ?? {}),
        metadata: structuredClone(manifest.metadata ?? {}),
        sizeBytes,
        archiveDigest,
        manifestDigest,
        signature: structuredClone(signature),
        publishedBy,
        tenantId,
        etag: generateId(),
        createdAt: now,
        updatedAt: now,
      };

      const row = registryEntryToRow(entry);
      sqlite.withWriteTransaction((db) => {
        db.prepare(
          `INSERT INTO package_registry (
             id, name, version, description, author_json, license,
             capabilities_json, dependencies_json, peer_deps_json,
             friday_version, assets_json, hooks_json, metadata_json,
             size_bytes, archive_digest, manifest_digest, signature_json,
             published_by, tenant_id, etag, created_at, updated_at, deleted_at
           ) VALUES (
             @id, @name, @version, @description, @author_json, @license,
             @capabilities_json, @dependencies_json, @peer_deps_json,
             @friday_version, @assets_json, @hooks_json, @metadata_json,
             @size_bytes, @archive_digest, @manifest_digest, @signature_json,
             @published_by, @tenant_id, @etag, @created_at, @updated_at, @deleted_at
           )`,
        ).run(row);
      });
      return entry;
    },

    checkDuplicate(
      name: string,
      version: string,
      tenantId?: string,
      archiveDigest?: string,
      manifestDigest?: string,
    ): DuplicateCheckResult {
      const existing = readByNameVersion(name, version, tenantId);
      if (!existing) return { isDuplicate: false, isSameContent: false };
      const isSameContent = archiveDigest !== undefined
        && manifestDigest !== undefined
        && existing.archiveDigest === archiveDigest
        && existing.manifestDigest === manifestDigest;
      return { isDuplicate: true, isSameContent, existingEntry: existing };
    },

    checkDuplicateForTenant(tenantId: string, name: string, version: string, archiveDigest?: string, manifestDigest?: string): DuplicateCheckResult {
      return manager.checkDuplicate(name, version, tenantId, archiveDigest, manifestDigest);
    },

    getById(id: UUID): FridayPackageRegistryEntry | null {
      return readActiveById(id);
    },

    getByNameVersion(name: string, version: string, tenantId?: string): FridayPackageRegistryEntry | null {
      if (tenantId) {
        const tenantEntry = readByNameVersion(name, version, tenantId);
        if (tenantEntry) return tenantEntry;
      }
      return readByNameVersion(name, version, undefined);
    },

    getByNameVersionForTenant(name, version, tenantId) {
      return manager.getByNameVersion(name, version, tenantId);
    },

    getLatest(name: string, tenantId?: string): FridayPackageRegistryEntry | null {
      const versions = readMergedVersionsForTenant(name, tenantId);
      return versions[0] ?? null;
    },

    getLatestForTenant(name, tenantId) {
      return manager.getLatest(name, tenantId);
    },

    getVersions(name: string, tenantId?: string): readonly FridayPackageRegistryEntry[] {
      return readMergedVersionsForTenant(name, tenantId);
    },

    getVersionsForTenant(name, tenantId) {
      return manager.getVersions(name, tenantId);
    },

    getVersionCount(name, tenantId) {
      return manager.getVersions(name, tenantId).length;
    },

    getVersionCountForTenant(name, tenantId) {
      return manager.getVersionCount(name, tenantId);
    },

    resolveVersion(name: string, range: string, tenantId?: string): FridayPackageRegistryEntry | null {
      const versions = manager.getVersions(name, tenantId);
      if (versions.length === 0) return null;
      const best = maxSatisfying(versions.map((v) => v.version), range);
      if (!best) return null;
      return versions.find((v) => v.version === best) ?? null;
    },

    resolveVersionForTenant(name, range, tenantId) {
      return manager.resolveVersion(name, range, tenantId);
    },

    search(criteria: RegistrySearchCriteria, pagination?: RegistryPagination): RegistryPage<FridayPackageRegistryEntry> {
      const rows = sqlite.withReadConnection((db) =>
        db.prepare("SELECT * FROM package_registry WHERE deleted_at IS NULL").all() as FridayPackageRegistryRow[],
      );
      let results = rows.map(rowToRegistryEntry);

      if (criteria.name) {
        const prefix = criteria.name.toLowerCase();
        results = results.filter((e) => e.name.toLowerCase().startsWith(prefix));
      }
      if (criteria.capability) {
        const cap = criteria.capability;
        results = results.filter((e) => e.capabilities.includes(cap));
      }
      if (criteria.keyword) {
        const kw = criteria.keyword.toLowerCase();
        results = results.filter((e) => e.metadata?.keywords?.some((k) => k.toLowerCase().includes(kw)) ?? false);
      }
      if (criteria.author) {
        const ap = criteria.author.toLowerCase();
        results = results.filter((e) => e.author.name.toLowerCase().startsWith(ap));
      }
      if (criteria.tenantId) {
        const tid = criteria.tenantId;
        results = results.filter((e) => !e.tenantId || e.tenantId === tid);
      }

      // De-duplicate by scope+name (keep latest version per scoped package)
      const latestByScopedName = new Map<string, FridayPackageRegistryEntry>();
      for (const entry of results) {
        const key = `${entry.tenantId ?? "__global__"}:${entry.name}`;
        const existing = latestByScopedName.get(key);
        if (!existing || compareSemverStr(entry.version, existing.version) > 0) {
          latestByScopedName.set(key, entry);
        }
      }
      results = [...latestByScopedName.values()];

      const sortBy = criteria.sortBy ?? "name";
      const sortDir = criteria.sortDir ?? "asc";
      const sortMul = sortDir === "asc" ? 1 : -1;
      results.sort((a, b) => {
        switch (sortBy) {
          case "name": return sortMul * a.name.localeCompare(b.name);
          case "createdAt": return sortMul * a.createdAt.localeCompare(b.createdAt);
          case "updatedAt": return sortMul * a.updatedAt.localeCompare(b.updatedAt);
          case "sizeBytes": return sortMul * (a.sizeBytes - b.sizeBytes);
          default: return 0;
        }
      });

      const limit = Math.min(Math.max(pagination?.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
      let startIndex = 0;
      if (pagination?.cursor) {
        const idx = results.findIndex((e) => e.id === pagination.cursor);
        if (idx >= 0) startIndex = idx + 1;
      }
      const page = results.slice(startIndex, startIndex + limit);
      const nextCursor = startIndex + limit < results.length ? page[page.length - 1]?.id : undefined;
      return { items: page, nextCursor };
    },

    remove(id: UUID): boolean {
      const existing = readActiveById(id);
      if (!existing) return false;
      sqlite.withWriteTransaction((db) => {
        db.prepare("UPDATE package_registry SET deleted_at = ?, updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), id);
      });
      return true;
    },

    count(): number {
      return sqlite.withReadConnection((db) =>
        (db.prepare("SELECT COUNT(*) AS cnt FROM package_registry WHERE deleted_at IS NULL").get() as { cnt: number }).cnt,
      );
    },
  };

  return manager;
}

// ─── Install repository ───

function rowToInstall(row: FridayPackageInstallRow): FridayPackageInstall {
  return {
    id: row.id,
    packageId: row.package_id,
    packageName: row.package_name,
    packageVersion: row.package_version,
    tenantId: row.tenant_id,
    state: row.state as FridayPackageInstallState,
    installDir: row.install_dir ?? undefined,
    errorMessage: row.error_message ?? undefined,
    errorCode: row.error_code ?? undefined,
    previousVersion: row.previous_version ?? undefined,
    etag: row.etag,
    version: row.version,
    installedBy: row.installed_by,
    idempotencyKey: row.idempotency_key ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function installToRow(install: FridayPackageInstall, packageId: string): FridayPackageInstallRow {
  return {
    id: install.id,
    package_id: packageId,
    package_name: install.packageName,
    package_version: install.packageVersion,
    tenant_id: install.tenantId,
    state: install.state,
    install_dir: install.installDir ?? null,
    error_message: install.errorMessage ?? null,
    error_code: install.errorCode ?? null,
    previous_version: install.previousVersion ?? null,
    etag: install.etag,
    version: install.version,
    installed_by: install.installedBy,
    idempotency_key: install.idempotencyKey ?? null,
    created_at: install.createdAt,
    updated_at: install.updatedAt,
  };
}

function rowToRollback(row: FridayPackageRollbackRow): FridayPackageRollback {
  return {
    id: row.id,
    installId: row.install_id,
    packageName: row.package_name,
    fromVersion: row.from_version,
    toVersion: row.to_version,
    reason: row.reason,
    initiatedBy: row.initiated_by,
    state: row.state as FridayPackageRollbackState,
    errorMessage: row.error_message ?? undefined,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function rowToLifecycleEvent(row: FridayPackageLifecycleLogRow): FridayPackageLifecycleEvent {
  return {
    id: row.id,
    packageName: row.package_name,
    packageVersion: row.package_version ?? undefined,
    operation: row.operation as FridayPackageLifecycleOperation,
    stateFrom: (row.state_from as FridayPackageInstallState | undefined) ?? undefined,
    stateTo: row.state_to as FridayPackageInstallState,
    principalId: row.principal_id ?? undefined,
    tenantId: row.tenant_id ?? undefined,
    details: safeJsonParse(row.details_json, {} as JsonObject),
    createdAt: row.created_at,
  };
}

export interface SqlitePackageInstallerConfig {
  readonly sqlite: FridaySqliteLayer;
  readonly registry: RegistryManager;
  readonly generateId?: () => UUID;
  readonly nowIso?: () => ISODateTime;
  readonly verifyPackage?: PackageVerifier;
}

export function createSqlitePackageInstaller(
  config: SqlitePackageInstallerConfig,
): PackageInstaller {
  const { sqlite, registry } = config;
  const generateId = config.generateId ?? defaultConfig().generateId;
  const nowIso = config.nowIso ?? defaultConfig().nowIso;

  function appendLifecycleEvent(input: Omit<FridayPackageLifecycleEvent, "id" | "createdAt"> & { createdAt?: ISODateTime }): void {
    const row: FridayPackageLifecycleLogRow = {
      id: generateId(),
      package_name: input.packageName,
      package_version: input.packageVersion ?? null,
      operation: input.operation,
      state_from: input.stateFrom ?? null,
      state_to: input.stateTo,
      principal_id: input.principalId ?? null,
      tenant_id: input.tenantId ?? null,
      details_json: JSON.stringify(input.details ?? {}),
      created_at: input.createdAt ?? nowIso(),
    };
    sqlite.withWriteTransaction((db) => {
      db.prepare(
        `INSERT INTO package_lifecycle_log (
           id, package_name, package_version, operation, state_from, state_to,
           principal_id, tenant_id, details_json, created_at
         ) VALUES (
           @id, @package_name, @package_version, @operation, @state_from, @state_to,
           @principal_id, @tenant_id, @details_json, @created_at
         )`,
      ).run(row);
    });
  }

  function persistInstall(install: FridayPackageInstall, packageId: string, insert: boolean): void {
    const row = installToRow(install, packageId);
    sqlite.withWriteTransaction((db) => {
      if (insert) {
        db.prepare(
          `INSERT INTO package_installs (
             id, package_id, package_name, package_version, tenant_id, state,
             install_dir, error_message, error_code, previous_version, etag,
             version, installed_by, idempotency_key, created_at, updated_at
           ) VALUES (
             @id, @package_id, @package_name, @package_version, @tenant_id, @state,
             @install_dir, @error_message, @error_code, @previous_version, @etag,
             @version, @installed_by, @idempotency_key, @created_at, @updated_at
           )`,
        ).run(row);
      } else {
        db.prepare(
          `UPDATE package_installs SET
             state = @state, install_dir = @install_dir, error_message = @error_message,
             error_code = @error_code, previous_version = @previous_version, etag = @etag,
             version = @version, updated_at = @updated_at WHERE id = @id`,
        ).run(row);
      }
    });
  }

  function loadActiveInstall(packageName: string, tenantId: string): FridayPackageInstall | null {
    const row = sqlite.withReadConnection((db) =>
      db.prepare(
        `SELECT * FROM package_installs
         WHERE package_name = ? AND tenant_id = ? AND state IN ('active')
         ORDER BY updated_at DESC LIMIT 1`,
      ).get(packageName, tenantId) as FridayPackageInstallRow | undefined,
    );
    return row ? rowToInstall(row) : null;
  }

  function loadInstall(installId: UUID): FridayPackageInstall | null {
    const row = sqlite.withReadConnection((db) =>
      db.prepare("SELECT * FROM package_installs WHERE id = ?").get(installId) as FridayPackageInstallRow | undefined,
    );
    return row ? rowToInstall(row) : null;
  }

  function transition(install: FridayPackageInstall, next: FridayPackageInstallState, opts?: { error?: string; errorCode?: string }): FridayPackageInstall {
    if (!isValidInstallTransition(install.state, next)) {
      throw new Error(`Invalid install state transition ${install.state} -> ${next}`);
    }
    const updated: FridayPackageInstall = {
      ...install,
      state: next,
      errorMessage: opts?.error,
      errorCode: opts?.errorCode,
      etag: generateId(),
      version: install.version + 1,
      updatedAt: nowIso(),
    };
    return updated;
  }

  const installer: PackageInstaller = {
    install(options: InstallOptions): InstallResult {
      const tenantId = options.tenantId;
      const packageName = options.packageName;

      const targetEntry = options.version
        ? registry.getByNameVersion(packageName, options.version, tenantId)
        : registry.getLatest(packageName, tenantId);
      if (!targetEntry) {
        return {
          success: false,
          install: null,
          dependencies: null,
          verification: null,
          error: `Package "${packageName}" not found`,
          errorCode: "PACKAGING_NOT_FOUND",
        };
      }

      const verifier = config.verifyPackage;
      const verification: FridayPackageVerificationResult = verifier
        ? verifier({
            entry: targetEntry,
            tenantId,
            platformVersion: options.platformVersion,
            initiatedBy: options.installedBy,
            verifiedAt: nowIso(),
          })
        : {
            valid: false,
            outcome: "signature_invalid",
            message: "Package verifier is required for SQLite installs.",
            keyId: targetEntry.signature.keyId,
            verifiedAt: nowIso(),
            durationMs: 0,
          };

      const baseInstall: FridayPackageInstall = {
        id: generateId(),
        packageId: targetEntry.id,
        packageName,
        packageVersion: targetEntry.version,
        tenantId,
        state: "downloading",
        etag: generateId(),
        version: 1,
        installedBy: options.installedBy,
        idempotencyKey: options.idempotencyKey,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };

      persistInstall(baseInstall, targetEntry.id, true);
      appendLifecycleEvent({
        packageName,
        packageVersion: targetEntry.version,
        operation: "install",
        stateTo: "downloading",
        principalId: options.installedBy,
        tenantId,
        details: { installId: baseInstall.id },
      });

      if (!verification.valid) {
        const failedInstall = transition(transition(baseInstall, "verifying"), "verification_failed", {
          error: verification.message,
          errorCode: `PACKAGING_${verification.outcome.toUpperCase()}`,
        });
        persistInstall(failedInstall, targetEntry.id, false);
        appendLifecycleEvent({
          packageName,
          packageVersion: targetEntry.version,
          operation: "install",
          stateFrom: "verifying",
          stateTo: "verification_failed",
          principalId: options.installedBy,
          tenantId,
          details: { installId: failedInstall.id, verification: verification as unknown as JsonObject },
        });
        return {
          success: false,
          install: failedInstall,
          dependencies: null,
          verification,
          error: verification.message,
          errorCode: failedInstall.errorCode,
        };
      }

      const verifying = transition(baseInstall, "verifying");
      persistInstall(verifying, targetEntry.id, false);
      const extracting = transition(verifying, "extracting");
      persistInstall(extracting, targetEntry.id, false);
      const activating = transition(extracting, "activating");
      persistInstall(activating, targetEntry.id, false);
      const active = transition(activating, "active");
      persistInstall(active, targetEntry.id, false);
      appendLifecycleEvent({
        packageName,
        packageVersion: targetEntry.version,
        operation: "install",
        stateFrom: "activating",
        stateTo: "active",
        principalId: options.installedBy,
        tenantId,
        details: { installId: active.id },
      });

      return {
        success: true,
        install: active,
        dependencies: null,
        verification,
      };
    },

    upgrade(options: UpgradeOptions): UpgradeResult {
      const current = loadActiveInstall(options.packageName, options.tenantId);
      if (!current) {
        return {
          success: false,
          install: null,
          dependencies: null,
          verification: null,
          error: `No active install for "${options.packageName}"`,
          errorCode: "PACKAGING_NOT_FOUND",
        };
      }
      if (current.etag !== options.etag) {
        return {
          success: false,
          install: null,
          dependencies: null,
          verification: null,
          error: "etag mismatch",
          errorCode: "PACKAGING_ETAG_MISMATCH",
        };
      }

      const target = options.targetVersion
        ? registry.getByNameVersion(options.packageName, options.targetVersion, options.tenantId)
        : registry.getLatest(options.packageName, options.tenantId);
      if (!target) {
        return {
          success: false,
          install: null,
          dependencies: null,
          verification: null,
          error: `Target version not found`,
          errorCode: "PACKAGING_NOT_FOUND",
        };
      }
      if (target.id === current.packageId) {
        return {
          success: false,
          install: current,
          dependencies: null,
          verification: null,
          error: "Already at requested version",
          errorCode: "PACKAGING_NO_CHANGE",
        };
      }

      // Mark old install as rolling_back -> rolled_back to keep historical track
      const rollingBack = transition(current, "rolling_back");
      persistInstall(rollingBack, current.packageId, false);
      const rolledBack = transition(rollingBack, "rolled_back");
      persistInstall(rolledBack, current.packageId, false);
      appendLifecycleEvent({
        packageName: options.packageName,
        packageVersion: current.packageVersion,
        operation: "upgrade",
        stateFrom: "rolling_back",
        stateTo: "rolled_back",
        principalId: options.upgradedBy,
        tenantId: options.tenantId,
        details: { previousInstallId: current.id },
      });

      // Install new version
      const result = installer.install({
        packageName: options.packageName,
        version: target.version,
        tenantId: options.tenantId,
        installedBy: options.upgradedBy,
        idempotencyKey: options.idempotencyKey,
        platformVersion: options.platformVersion,
      });
      if (!result.success || !result.install) {
        return {
          success: false,
          install: result.install,
          previousVersion: current.packageVersion,
          dependencies: result.dependencies,
          verification: result.verification,
          error: result.error,
          errorCode: result.errorCode,
        };
      }
      const updatedNew: FridayPackageInstall = {
        ...result.install,
        previousVersion: current.packageVersion,
        etag: generateId(),
        version: result.install.version + 1,
        updatedAt: nowIso(),
      };
      persistInstall(updatedNew, updatedNew.packageId, false);
      return {
        success: true,
        install: updatedNew,
        previousVersion: current.packageVersion,
        dependencies: result.dependencies,
        verification: result.verification,
      };
    },

    uninstall(options: UninstallOptions): UninstallResult {
      const current = loadActiveInstall(options.packageName, options.tenantId);
      if (!current) {
        return {
          success: false,
          install: null,
          error: `No active install for "${options.packageName}"`,
          errorCode: "PACKAGING_NOT_FOUND",
        };
      }
      if (current.etag !== options.etag) {
        return {
          success: false,
          install: null,
          error: "etag mismatch",
          errorCode: "PACKAGING_ETAG_MISMATCH",
        };
      }
      const uninstalling = transition(current, "uninstalling");
      persistInstall(uninstalling, current.packageId, false);
      const uninstalled = transition(uninstalling, "uninstalled");
      persistInstall(uninstalled, current.packageId, false);
      appendLifecycleEvent({
        packageName: options.packageName,
        packageVersion: current.packageVersion,
        operation: "uninstall",
        stateFrom: "uninstalling",
        stateTo: "uninstalled",
        principalId: options.uninstalledBy ?? "system",
        tenantId: options.tenantId,
        details: { installId: current.id, reason: options.reason ?? null },
      });
      return { success: true, install: uninstalled };
    },

    rollback(options: RollbackOptions): RollbackResult {
      const current = loadActiveInstall(options.packageName, options.tenantId);
      if (!current) {
        return {
          success: false,
          install: null,
          rollback: null,
          error: `No active install for "${options.packageName}"`,
          errorCode: "PACKAGING_NOT_FOUND",
        };
      }
      if (current.etag !== options.etag) {
        return {
          success: false,
          install: null,
          rollback: null,
          error: "etag mismatch",
          errorCode: "PACKAGING_ETAG_MISMATCH",
        };
      }
      const target = registry.getByNameVersion(options.packageName, options.targetVersion, options.tenantId);
      if (!target) {
        return {
          success: false,
          install: null,
          rollback: null,
          error: `Target rollback version "${options.targetVersion}" not found`,
          errorCode: "PACKAGING_NOT_FOUND",
        };
      }

      const rollbackId = generateId();
      const startedAt = nowIso();
      const rollbackRow: FridayPackageRollbackRow = {
        id: rollbackId,
        install_id: current.id,
        package_name: options.packageName,
        from_version: current.packageVersion,
        to_version: options.targetVersion,
        reason: options.reason,
        initiated_by: options.initiatedBy,
        state: "initiated",
        error_message: null,
        started_at: startedAt,
        completed_at: null,
      };
      sqlite.withWriteTransaction((db) => {
        db.prepare(
          `INSERT INTO package_rollbacks (
             id, install_id, package_name, from_version, to_version, reason,
             initiated_by, state, error_message, started_at, completed_at
           ) VALUES (
             @id, @install_id, @package_name, @from_version, @to_version, @reason,
             @initiated_by, @state, @error_message, @started_at, @completed_at
           )`,
        ).run(rollbackRow);
      });

      const rollingBack = transition(current, "rolling_back");
      persistInstall(rollingBack, current.packageId, false);
      const rolledBack = transition(rollingBack, "rolled_back");
      persistInstall(rolledBack, current.packageId, false);

      // Reinstall target version
      const reinstallResult = installer.install({
        packageName: options.packageName,
        version: options.targetVersion,
        tenantId: options.tenantId,
        installedBy: options.initiatedBy,
        platformVersion: target.fridayVersionRange,
      });

      const completedAt = nowIso();
      sqlite.withWriteTransaction((db) => {
        db.prepare(
          "UPDATE package_rollbacks SET state = ?, completed_at = ?, error_message = ? WHERE id = ?",
        ).run(reinstallResult.success ? "completed" : "failed", completedAt, reinstallResult.error ?? null, rollbackId);
      });
      const finalRollback = { ...rollbackRow, state: reinstallResult.success ? "completed" : "failed", completed_at: completedAt, error_message: reinstallResult.error ?? null };

      appendLifecycleEvent({
        packageName: options.packageName,
        packageVersion: options.targetVersion,
        operation: "rollback",
        stateFrom: current.state,
        stateTo: reinstallResult.success ? "active" : "failed",
        principalId: options.initiatedBy,
        tenantId: options.tenantId,
        details: { rollbackId, fromVersion: current.packageVersion, toVersion: options.targetVersion },
      });

      return {
        success: reinstallResult.success,
        install: reinstallResult.install,
        rollback: rowToRollback(finalRollback as FridayPackageRollbackRow),
        error: reinstallResult.error,
        errorCode: reinstallResult.errorCode,
      };
    },

    getInstall(installId: UUID): FridayPackageInstall | null {
      return loadInstall(installId);
    },

    getVerification(_installId: UUID): FridayPackageVerificationResult | null {
      return null;
    },

    getActiveInstall(packageName: string, tenantId: string): FridayPackageInstall | null {
      return loadActiveInstall(packageName, tenantId);
    },

    listInstalls(tenantId: string): readonly FridayPackageInstall[] {
      const rows = sqlite.withReadConnection((db) =>
        db.prepare("SELECT * FROM package_installs WHERE tenant_id = ? ORDER BY updated_at DESC").all(tenantId) as FridayPackageInstallRow[],
      );
      return rows.map(rowToInstall);
    },

    listRollbacks(installId: UUID): readonly FridayPackageRollback[] {
      const rows = sqlite.withReadConnection((db) =>
        db.prepare("SELECT * FROM package_rollbacks WHERE install_id = ? ORDER BY started_at DESC").all(installId) as FridayPackageRollbackRow[],
      );
      return rows.map(rowToRollback);
    },

    listLifecycleEvents(criteria?: LifecycleEventQuery): readonly FridayPackageLifecycleEvent[] {
      const where: string[] = [];
      const params: Record<string, unknown> = {};
      if (criteria?.packageName) { where.push("package_name = @packageName"); params.packageName = criteria.packageName; }
      if (criteria?.operation) { where.push("operation = @operation"); params.operation = criteria.operation; }
      if (criteria?.tenantId) { where.push("tenant_id = @tenantId"); params.tenantId = criteria.tenantId; }
      if (criteria?.after) { where.push("created_at >= @after"); params.after = criteria.after; }
      if (criteria?.before) { where.push("created_at <= @before"); params.before = criteria.before; }
      const sql = `SELECT * FROM package_lifecycle_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT 500`;
      const rows = sqlite.withReadConnection((db) => db.prepare(sql).all(params) as FridayPackageLifecycleLogRow[]);
      return rows.map(rowToLifecycleEvent);
    },

    activeInstallCount(): number {
      return sqlite.withReadConnection((db) =>
        (db.prepare("SELECT COUNT(*) AS cnt FROM package_installs WHERE state = 'active'").get() as { cnt: number }).cnt,
      );
    },

    transitionState(installId: UUID, newState: FridayPackageInstallState, error?: string): FridayPackageInstall | null {
      const current = loadInstall(installId);
      if (!current) return null;
      const next = transition(current, newState, { error });
      persistInstall(next, current.packageId, false);
      return next;
    },
  };

  return installer;
}

// ─── Trusted key store ───

function rowToTrustedKey(row: FridayPackageTrustedKeyRow): FridayPackageTrustedKey {
  return {
    id: row.id,
    keyId: row.key_id,
    publicKey: row.public_key,
    algorithm: row.algorithm as FridayPackageTrustedKey["algorithm"],
    owner: row.owner,
    tenantId: row.tenant_id ?? undefined,
    trustedAt: row.trusted_at,
    expiresAt: row.expires_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    revocationReason: row.revocation_reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface SqliteTrustedKeyStoreOptions {
  readonly tenantId?: string;
  readonly includeRevoked?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SqliteTrustedKeyStore {
  list(opts?: SqliteTrustedKeyStoreOptions): { items: readonly FridayPackageTrustedKey[]; nextCursor?: string };
  listAll(): readonly FridayPackageTrustedKey[];
  findByKeyId(keyId: string): FridayPackageTrustedKey | null;
  add(input: {
    keyId: string;
    publicKey: string;
    algorithm?: FridayPackageTrustedKey["algorithm"];
    owner: string;
    tenantId?: string;
    expiresAt?: string;
  }): FridayPackageTrustedKey;
  revoke(keyId: string, reason: string): FridayPackageTrustedKey | null;
  rotate(input: {
    oldKeyId: string;
    newKeyId: string;
    newPublicKey: string;
    owner: string;
    expiresAt?: string;
  }): { newKey: FridayPackageTrustedKey; oldKey: FridayPackageTrustedKey; gracePeriodEndsAt: string };
}

export function createSqliteTrustedKeyStore(config: {
  sqlite: FridaySqliteLayer;
  generateId?: () => UUID;
  nowIso?: () => ISODateTime;
}): SqliteTrustedKeyStore {
  const { sqlite } = config;
  const generateId = config.generateId ?? defaultConfig().generateId;
  const nowIso = config.nowIso ?? defaultConfig().nowIso;

  function insertRow(row: FridayPackageTrustedKeyRow): void {
    sqlite.withWriteTransaction((db) => {
      db.prepare(
        `INSERT INTO package_trusted_keys (
           id, key_id, public_key, algorithm, owner, tenant_id,
           trusted_at, expires_at, revoked_at, revocation_reason,
           created_at, updated_at
         ) VALUES (
           @id, @key_id, @public_key, @algorithm, @owner, @tenant_id,
           @trusted_at, @expires_at, @revoked_at, @revocation_reason,
           @created_at, @updated_at
         )`,
      ).run(row);
    });
  }

  return {
    list(opts?: SqliteTrustedKeyStoreOptions) {
      const where: string[] = [];
      const params: Record<string, unknown> = {};
      if (opts?.tenantId) {
        where.push("(tenant_id = @tenantId OR tenant_id IS NULL)");
        params.tenantId = opts.tenantId;
      }
      if (!opts?.includeRevoked) {
        where.push("revoked_at IS NULL");
      }
      const sql = `SELECT * FROM package_trusted_keys ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC`;
      const rows = sqlite.withReadConnection((db) => db.prepare(sql).all(params) as FridayPackageTrustedKeyRow[]);
      const items = rows.map(rowToTrustedKey);
      const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);
      let startIndex = 0;
      if (opts?.cursor) {
        const idx = items.findIndex((k) => k.id === opts.cursor);
        if (idx >= 0) startIndex = idx + 1;
      }
      const paged = items.slice(startIndex, startIndex + limit);
      const nextCursor = startIndex + limit < items.length ? paged[paged.length - 1]?.id : undefined;
      return { items: paged, nextCursor };
    },
    listAll() {
      const rows = sqlite.withReadConnection((db) =>
        db.prepare("SELECT * FROM package_trusted_keys").all() as FridayPackageTrustedKeyRow[],
      );
      return rows.map(rowToTrustedKey);
    },
    findByKeyId(keyId: string): FridayPackageTrustedKey | null {
      const row = sqlite.withReadConnection((db) =>
        db.prepare("SELECT * FROM package_trusted_keys WHERE key_id = ?").get(keyId) as FridayPackageTrustedKeyRow | undefined,
      );
      return row ? rowToTrustedKey(row) : null;
    },
    add(input) {
      const existing = sqlite.withReadConnection((db) =>
        db.prepare("SELECT * FROM package_trusted_keys WHERE key_id = ?").get(input.keyId) as FridayPackageTrustedKeyRow | undefined,
      );
      if (existing) {
        throw new Error(`Key "${input.keyId}" already exists`);
      }
      const now = nowIso();
      const row: FridayPackageTrustedKeyRow = {
        id: generateId(),
        key_id: input.keyId,
        public_key: input.publicKey,
        algorithm: input.algorithm ?? "Ed25519",
        owner: input.owner,
        tenant_id: input.tenantId ?? null,
        trusted_at: now,
        expires_at: input.expiresAt ?? null,
        revoked_at: null,
        revocation_reason: null,
        created_at: now,
        updated_at: now,
      };
      insertRow(row);
      return rowToTrustedKey(row);
    },
    revoke(keyId: string, reason: string) {
      const existing = sqlite.withReadConnection((db) =>
        db.prepare("SELECT * FROM package_trusted_keys WHERE key_id = ?").get(keyId) as FridayPackageTrustedKeyRow | undefined,
      );
      if (!existing) return null;
      if (existing.revoked_at) return rowToTrustedKey(existing);
      const now = nowIso();
      sqlite.withWriteTransaction((db) => {
        db.prepare(
          "UPDATE package_trusted_keys SET revoked_at = ?, revocation_reason = ?, updated_at = ? WHERE key_id = ?",
        ).run(now, reason, now, keyId);
      });
      const updated = { ...existing, revoked_at: now, revocation_reason: reason, updated_at: now };
      return rowToTrustedKey(updated as FridayPackageTrustedKeyRow);
    },
    rotate(input) {
      const oldRow = sqlite.withReadConnection((db) =>
        db.prepare("SELECT * FROM package_trusted_keys WHERE key_id = ?").get(input.oldKeyId) as FridayPackageTrustedKeyRow | undefined,
      );
      if (!oldRow) {
        throw new Error(`Key "${input.oldKeyId}" not found`);
      }
      const now = nowIso();
      const newRow: FridayPackageTrustedKeyRow = {
        id: generateId(),
        key_id: input.newKeyId,
        public_key: input.newPublicKey,
        algorithm: "Ed25519",
        owner: input.owner,
        tenant_id: oldRow.tenant_id,
        trusted_at: now,
        expires_at: input.expiresAt ?? null,
        revoked_at: null,
        revocation_reason: null,
        created_at: now,
        updated_at: now,
      };
      insertRow(newRow);
      sqlite.withWriteTransaction((db) => {
        db.prepare("UPDATE package_trusted_keys SET updated_at = ? WHERE id = ?").run(now, oldRow.id);
      });
      const gracePeriodEndsAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
      return {
        newKey: rowToTrustedKey(newRow),
        oldKey: rowToTrustedKey({ ...oldRow, updated_at: now }),
        gracePeriodEndsAt,
      };
    },
  };
}

// ─── Convenience helpers ───

/** Internal helper for tests: reads a single registry row directly from SQLite. */
export function debugReadPackageRegistry(db: Database.Database, id: string): FridayPackageRegistryRow | null {
  const row = db.prepare("SELECT * FROM package_registry WHERE id = ?").get(id) as FridayPackageRegistryRow | undefined;
  return row ?? null;
}

/** Internal helper for tests: reads a single install row directly from SQLite. */
export function debugReadPackageInstall(db: Database.Database, id: string): FridayPackageInstallRow | null {
  const row = db.prepare("SELECT * FROM package_installs WHERE id = ?").get(id) as FridayPackageInstallRow | undefined;
  return row ?? null;
}
