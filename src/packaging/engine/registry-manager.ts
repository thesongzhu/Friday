/**
 * Registry Manager — In-memory package registry with versioning, search,
 * and listing.
 *
 * Provides CRUD operations for published packages with semantic versioning,
 * cursor-based pagination, and multi-field search/filtering.
 *
 * @module packaging/engine/registry-manager
 */

import type {
  FridayPackageEngineConfig,
  FridayPackageManifest,
  FridayPackageRegistryEntry,
  FridayPackageSignature,
  ISODateTime,
  UUID,
} from "../model/friday-packaging.types.js";
import { compareSemverStr, maxSatisfying } from "./semver.js";

// ─── Registry Types ───

/** Options for publishing a package to the registry. */
export interface PublishOptions {
  readonly manifest: FridayPackageManifest;
  readonly signature: FridayPackageSignature;
  readonly archiveDigest: string;
  readonly manifestDigest: string;
  readonly sizeBytes: number;
  readonly publishedBy: string;
  readonly tenantId?: string;
}

/** Duplicate detection result. */
export interface DuplicateCheckResult {
  readonly isDuplicate: boolean;
  /** True if the existing entry has the same digest (idempotent re-publish). */
  readonly isSameContent: boolean;
  readonly existingEntry?: FridayPackageRegistryEntry;
}

/** Search/filter criteria for listing packages. */
export interface RegistrySearchCriteria {
  readonly name?: string;
  readonly capability?: string;
  readonly keyword?: string;
  readonly author?: string;
  readonly tenantId?: string;
  readonly sortBy?: "name" | "createdAt" | "updatedAt" | "sizeBytes";
  readonly sortDir?: "asc" | "desc";
}

/** Cursor-based pagination parameters. */
export interface RegistryPagination {
  readonly cursor?: string;
  readonly limit?: number;
}

/** Paginated registry result. */
export interface RegistryPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

/** Conflict raised when publishing an existing version with different content. */
export class RegistryVersionConflictError extends Error {
  readonly code: string;

  constructor(name: string, version: string, tenantId?: string) {
    super(`Package "${name}@${version}" already exists${tenantId ? ` for tenant "${tenantId}"` : ""} with different content`);
    this.name = "RegistryVersionConflictError";
    this.code = "PACKAGING_VERSION_ALREADY_EXISTS";
  }
}

// ─── Registry Manager ───

/** Package registry facade. */
export interface RegistryManager {
  /** Publish a package to the registry. */
  publish(options: PublishOptions): FridayPackageRegistryEntry;

  /** Check if a name+version already exists. */
  checkDuplicate(
    name: string,
    version: string,
    tenantId?: string,
    archiveDigest?: string,
    manifestDigest?: string,
  ): DuplicateCheckResult;

  /** Check for duplicates in a tenant scope. */
  checkDuplicateForTenant(
    tenantId: string,
    name: string,
    version: string,
    archiveDigest?: string,
    manifestDigest?: string,
  ): DuplicateCheckResult;

  /** Get a specific package by ID. */
  getById(id: UUID): FridayPackageRegistryEntry | null;

  /** Get a specific package by name and version (tenant-aware with global fallback). */
  getByNameVersion(name: string, version: string, tenantId?: string): FridayPackageRegistryEntry | null;

  /** Get a specific package by name and version for a tenant. */
  getByNameVersionForTenant(name: string, version: string, tenantId: string): FridayPackageRegistryEntry | null;

  /** Get the latest version of a package by name (tenant-aware with global fallback). */
  getLatest(name: string, tenantId?: string): FridayPackageRegistryEntry | null;

  /** Get the latest version of a package for a tenant. */
  getLatestForTenant(name: string, tenantId: string): FridayPackageRegistryEntry | null;

  /** Get all versions of a package, sorted by version descending. */
  getVersions(name: string, tenantId?: string): readonly FridayPackageRegistryEntry[];

  /** Get all versions of a package for a tenant. */
  getVersionsForTenant(name: string, tenantId: string): readonly FridayPackageRegistryEntry[];

  /** Get the count of published versions for a package name. */
  getVersionCount(name: string, tenantId?: string): number;

  /** Get the count of published versions for a package name for a tenant. */
  getVersionCountForTenant(name: string, tenantId: string): number;

  /** Find the highest version satisfying a semver range. */
  resolveVersion(name: string, range: string, tenantId?: string): FridayPackageRegistryEntry | null;

  /** Find the highest version satisfying a semver range for a tenant. */
  resolveVersionForTenant(name: string, range: string, tenantId: string): FridayPackageRegistryEntry | null;

  /** Search/list packages with filtering and pagination. */
  search(criteria: RegistrySearchCriteria, pagination?: RegistryPagination): RegistryPage<FridayPackageRegistryEntry>;

  /** Remove a package entry (soft delete — marks as deleted). */
  remove(id: UUID): boolean;

  /** Get total count of all non-deleted entries. */
  count(): number;
}

// ─── Implementation ───

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const GLOBAL_SCOPE = "__global__";

interface RegistryRecord {
  readonly entry: FridayPackageRegistryEntry;
  readonly deletedAt: ISODateTime | null;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    const objectValue: object = value;
    for (const nested of Object.values(objectValue)) {
      if (nested !== null && typeof nested === "object" && !Object.isFrozen(nested)) {
        deepFreeze(nested);
      }
    }
    Object.freeze(value);
  }
  return value;
}

function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

/** Create a new in-memory registry manager. */
export function createRegistryManager(
  config?: Partial<FridayPackageEngineConfig>,
): RegistryManager {
  const generateId = config?.generateId ?? (() => crypto.randomUUID());
  const nowIso = config?.nowIso ?? (() => new Date().toISOString());

  // Primary storage: id → record
  const entriesById = new Map<UUID, RegistryRecord>();
  // Index: "scope:name@version" → id
  const nameVersionIndex = new Map<string, UUID>();
  // Index: "scope:name" → Set<id> (all versions)
  const nameIndex = new Map<string, Set<UUID>>();

  function tenantScope(tenantId?: string): string {
    return tenantId ?? GLOBAL_SCOPE;
  }

  function nameKey(name: string, tenantId?: string): string {
    return `${tenantScope(tenantId)}:${name}`;
  }

  function nameVersionKey(name: string, version: string, tenantId?: string): string {
    return `${tenantScope(tenantId)}:${name}@${version}`;
  }

  function addToIndices(entry: FridayPackageRegistryEntry): void {
    nameVersionIndex.set(nameVersionKey(entry.name, entry.version, entry.tenantId), entry.id);

    const scopedName = nameKey(entry.name, entry.tenantId);
    let versions = nameIndex.get(scopedName);
    if (!versions) {
      versions = new Set();
      nameIndex.set(scopedName, versions);
    }
    versions.add(entry.id);
  }

  function removeFromIndices(entry: FridayPackageRegistryEntry): void {
    nameVersionIndex.delete(nameVersionKey(entry.name, entry.version, entry.tenantId));

    const scopedName = nameKey(entry.name, entry.tenantId);
    const versions = nameIndex.get(scopedName);
    if (!versions) return;

    versions.delete(entry.id);
    if (versions.size === 0) {
      nameIndex.delete(scopedName);
    }
  }

  function getActiveRecord(id: UUID): RegistryRecord | null {
    const record = entriesById.get(id);
    if (!record) return null;
    return record.deletedAt === null ? record : null;
  }

  function getActiveEntry(id: UUID): FridayPackageRegistryEntry | null {
    const record = getActiveRecord(id);
    return record ? record.entry : null;
  }

  function getByScopedNameVersion(name: string, version: string, tenantId?: string): FridayPackageRegistryEntry | null {
    const id = nameVersionIndex.get(nameVersionKey(name, version, tenantId));
    if (!id) return null;
    return getActiveEntry(id);
  }

  function getVersionsInScope(name: string, tenantId?: string): FridayPackageRegistryEntry[] {
    const ids = nameIndex.get(nameKey(name, tenantId));
    if (!ids) return [];

    const entries: FridayPackageRegistryEntry[] = [];
    for (const id of ids) {
      const entry = getActiveEntry(id);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  function resolveVersionsForTenant(name: string, tenantId?: string): FridayPackageRegistryEntry[] {
    if (!tenantId) {
      return getVersionsInScope(name, undefined)
        .sort((a, b) => compareSemverStr(b.version, a.version));
    }

    const tenantVersions = getVersionsInScope(name, tenantId);
    const globalVersions = getVersionsInScope(name, undefined);
    const selectedByVersion = new Map<string, FridayPackageRegistryEntry>();

    for (const entry of globalVersions) {
      selectedByVersion.set(entry.version, entry);
    }

    for (const entry of tenantVersions) {
      selectedByVersion.set(entry.version, entry);
    }

    return [...selectedByVersion.values()]
      .sort((a, b) => compareSemverStr(b.version, a.version));
  }

  return {
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

      const duplicate = this.checkDuplicate(
        manifest.name,
        manifest.version,
        tenantId,
        archiveDigest,
        manifestDigest,
      );

      if (duplicate.isDuplicate && duplicate.existingEntry) {
        if (duplicate.isSameContent) {
          return cloneAndFreeze(duplicate.existingEntry);
        }
        throw new RegistryVersionConflictError(manifest.name, manifest.version, tenantId);
      }

      const now = nowIso();
      const id = generateId();
      const etag = generateId();

      const entry: FridayPackageRegistryEntry = {
        id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author: structuredClone(manifest.author),
        license: manifest.license,
        capabilities: structuredClone(manifest.capabilities),
        dependencies: structuredClone(manifest.dependencies),
        peerDependencies: structuredClone(manifest.peerDependencies ?? {}),
        fridayVersionRange: manifest.fridayVersionRange,
        assets: structuredClone(manifest.assets),
        hooks: structuredClone(manifest.hooks ?? {}),
        metadata: structuredClone(manifest.metadata ?? {}),
        sizeBytes,
        archiveDigest,
        manifestDigest,
        signature: structuredClone(signature),
        publishedBy,
        tenantId,
        etag,
        createdAt: now,
        updatedAt: now,
      };

      entriesById.set(id, { entry, deletedAt: null });
      addToIndices(entry);
      return cloneAndFreeze(entry);
    },

    checkDuplicate(
      name: string,
      version: string,
      tenantId?: string,
      archiveDigest?: string,
      manifestDigest?: string,
    ): DuplicateCheckResult {
      const existing = getByScopedNameVersion(name, version, tenantId);
      if (!existing) {
        return { isDuplicate: false, isSameContent: false };
      }

      const isSameContent = archiveDigest !== undefined
        && manifestDigest !== undefined
        && existing.archiveDigest === archiveDigest
        && existing.manifestDigest === manifestDigest;

      return {
        isDuplicate: true,
        isSameContent,
        existingEntry: cloneAndFreeze(existing),
      };
    },

    checkDuplicateForTenant(
      tenantId: string,
      name: string,
      version: string,
      archiveDigest?: string,
      manifestDigest?: string,
    ): DuplicateCheckResult {
      return this.checkDuplicate(name, version, tenantId, archiveDigest, manifestDigest);
    },

    getById(id: UUID): FridayPackageRegistryEntry | null {
      const entry = getActiveEntry(id);
      return entry ? cloneAndFreeze(entry) : null;
    },

    getByNameVersion(name: string, version: string, tenantId?: string): FridayPackageRegistryEntry | null {
      if (tenantId) {
        const tenantEntry = getByScopedNameVersion(name, version, tenantId);
        if (tenantEntry) return cloneAndFreeze(tenantEntry);
      }

      const globalEntry = getByScopedNameVersion(name, version, undefined);
      return globalEntry ? cloneAndFreeze(globalEntry) : null;
    },

    getByNameVersionForTenant(name: string, version: string, tenantId: string): FridayPackageRegistryEntry | null {
      return this.getByNameVersion(name, version, tenantId);
    },

    getLatest(name: string, tenantId?: string): FridayPackageRegistryEntry | null {
      const versions = this.getVersions(name, tenantId);
      if (versions.length === 0) return null;
      return cloneAndFreeze(versions[0]);
    },

    getLatestForTenant(name: string, tenantId: string): FridayPackageRegistryEntry | null {
      return this.getLatest(name, tenantId);
    },

    getVersions(name: string, tenantId?: string): readonly FridayPackageRegistryEntry[] {
      return cloneAndFreeze(resolveVersionsForTenant(name, tenantId));
    },

    getVersionsForTenant(name: string, tenantId: string): readonly FridayPackageRegistryEntry[] {
      return this.getVersions(name, tenantId);
    },

    getVersionCount(name: string, tenantId?: string): number {
      return this.getVersions(name, tenantId).length;
    },

    getVersionCountForTenant(name: string, tenantId: string): number {
      return this.getVersionCount(name, tenantId);
    },

    resolveVersion(name: string, range: string, tenantId?: string): FridayPackageRegistryEntry | null {
      const versions = this.getVersions(name, tenantId);
      if (versions.length === 0) return null;

      const versionStrings = versions.map((v) => v.version);
      const best = maxSatisfying(versionStrings, range);
      if (!best) return null;

      const resolved = versions.find((v) => v.version === best) ?? null;
      return resolved ? cloneAndFreeze(resolved) : null;
    },

    resolveVersionForTenant(name: string, range: string, tenantId: string): FridayPackageRegistryEntry | null {
      return this.resolveVersion(name, range, tenantId);
    },

    search(
      criteria: RegistrySearchCriteria,
      pagination?: RegistryPagination,
    ): RegistryPage<FridayPackageRegistryEntry> {
      let results: FridayPackageRegistryEntry[] = [];

      for (const record of entriesById.values()) {
        if (record.deletedAt !== null) continue;
        results.push(record.entry);
      }

      // Apply filters
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
        results = results.filter((e) => {
          const keywords = e.metadata?.keywords;
          if (!keywords) return false;
          return keywords.some((k) => k.toLowerCase().includes(kw));
        });
      }
      if (criteria.author) {
        const authorPrefix = criteria.author.toLowerCase();
        results = results.filter((e) => e.author.name.toLowerCase().startsWith(authorPrefix));
      }
      if (criteria.tenantId) {
        const tid = criteria.tenantId;
        results = results.filter((e) => {
          if (!e.tenantId) return true; // Global packages are always visible
          return e.tenantId === tid;
        });
      }

      // De-duplicate by tenant scope + name: only keep latest version per scoped package
      const latestByScopedName = new Map<string, FridayPackageRegistryEntry>();
      for (const entry of results) {
        const scopedPackageKey = `${tenantScope(entry.tenantId)}:${entry.name}`;
        const existing = latestByScopedName.get(scopedPackageKey);
        if (!existing || compareSemverStr(entry.version, existing.version) > 0) {
          latestByScopedName.set(scopedPackageKey, entry);
        }
      }
      results = [...latestByScopedName.values()];

      // Sort
      const sortBy = criteria.sortBy ?? "name";
      const sortDir = criteria.sortDir ?? "asc";
      const sortMul = sortDir === "asc" ? 1 : -1;

      results.sort((a, b) => {
        switch (sortBy) {
          case "name":
            return sortMul * a.name.localeCompare(b.name);
          case "createdAt":
            return sortMul * a.createdAt.localeCompare(b.createdAt);
          case "updatedAt":
            return sortMul * a.updatedAt.localeCompare(b.updatedAt);
          case "sizeBytes":
            return sortMul * (a.sizeBytes - b.sizeBytes);
          default:
            return 0;
        }
      });

      // Pagination
      const limit = Math.min(Math.max(pagination?.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
      let startIndex = 0;

      if (pagination?.cursor) {
        const cursorIdx = results.findIndex((e) => e.id === pagination.cursor);
        if (cursorIdx >= 0) startIndex = cursorIdx + 1;
      }

      const page = results.slice(startIndex, startIndex + limit);
      const nextCursor = startIndex + limit < results.length ? page[page.length - 1]?.id : undefined;

      return cloneAndFreeze({ items: page, nextCursor });
    },

    remove(id: UUID): boolean {
      const record = entriesById.get(id);
      if (!record || record.deletedAt !== null) return false;

      removeFromIndices(record.entry);
      entriesById.set(id, { ...record, deletedAt: nowIso() });
      return true;
    },

    count(): number {
      let count = 0;
      for (const record of entriesById.values()) {
        if (record.deletedAt === null) count++;
      }
      return count;
    },
  };
}
