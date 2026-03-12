/**
 * Version Manager — Playbook versioning with diff tracking.
 *
 * Manages the lifecycle of playbook versions: creation on promotion,
 * pattern evolution, rollback, and diff computation between versions.
 *
 * @module playbook/engine
 */

import type {
  FridayPlaybook,
  FridayPlaybookCandidate,
  FridayPlaybookEngineConfig,
  FridayPlaybookLifecycleEvent,
  FridayPlaybookStatus,
  FridayPlaybookVersion,
  JsonObject,
  JsonValue,
  UUID,
} from "../model/friday-playbook.types.js";

import type { PlaybookStore } from "./playbook-store.js";
import { computeNodeSequenceSimilarity, extractNodeSequenceFromPattern } from "./playbook-matcher.js";

// ─── Version Diff Types ───

/** Type of change detected between two versions. */
export type VersionDiffKind = "added" | "removed" | "changed";

/** A single difference between two version patterns. */
export interface VersionDiffEntry {
  /** Dotted path within the pattern. */
  path: string;
  /** Kind of change. */
  kind: VersionDiffKind;
  /** Old value (undefined for additions). */
  oldValue?: JsonValue;
  /** New value (undefined for removals). */
  newValue?: JsonValue;
}

/** Full diff result between two versions. */
export interface VersionDiff {
  /** Source (older) version number. */
  fromVersion: number;
  /** Target (newer) version number. */
  toVersion: number;
  /** Individual diff entries. */
  entries: VersionDiffEntry[];
  /** Whether the versions are structurally identical. */
  identical: boolean;
}

// ─── Version Manager Interface ───

/** Version manager for playbook lifecycle operations. */
export interface VersionManager {
  /**
   * Create a new playbook from a promoted candidate.
   * Creates the playbook entity and its initial version (v1).
   */
  createFromCandidate(candidate: FridayPlaybookCandidate): {
    playbook: FridayPlaybook;
    version: FridayPlaybookVersion;
  };

  /**
   * Evolve a playbook by creating a new version from a candidate
   * with a different pattern. Only proceeds if the candidate's pattern
   * is similar enough (Jaccard ≥ evolutionThreshold) to the active version.
   *
   * Returns the new version, or null if evolution was rejected.
   */
  evolve(
    playbookId: UUID,
    candidate: FridayPlaybookCandidate,
    changeNote?: string,
  ): FridayPlaybookVersion | null;

  /**
   * Roll back a playbook to a specific version number.
   * Returns the updated playbook, or null if the version doesn't exist.
   */
  rollback(playbookId: UUID, targetVersionNumber: number, reason: string): FridayPlaybook | null;

  /**
   * Deactivate a playbook entirely (set status to "rolled_back").
   */
  deactivate(playbookId: UUID, reason: string): FridayPlaybook | null;

  /**
   * Compute the diff between two versions of a playbook.
   */
  diff(playbookId: UUID, fromVersion: number, toVersion: number): VersionDiff | null;

  /**
   * Get the full version history for a playbook.
   */
  getHistory(playbookId: UUID): FridayPlaybookVersion[];
}

// ─── Implementation ───

/** Dependencies for creating a version manager. */
export interface VersionManagerDeps {
  store: PlaybookStore;
  config: FridayPlaybookEngineConfig;
  /** Minimum Jaccard similarity for pattern evolution (default: 0.85). */
  evolutionThreshold?: number;
}

/** Create a version manager instance. */
export function createVersionManager(deps: VersionManagerDeps): VersionManager {
  const { store, config, evolutionThreshold = 0.85 } = deps;

  return {
    createFromCandidate(candidate) {
      const now = config.nowIso();
      const playbookId = config.generateId();

      const playbook: FridayPlaybook = {
        id: playbookId,
        name: generatePlaybookName(candidate),
        workflowType: candidate.workflowType,
        tags: [...candidate.tags],
        status: "active",
        activeVersionNumber: 1,
        sourceCandidateId: candidate.id,
        compositeScore: 0,
        totalUses: 0,
        totalSuccesses: 0,
        etag: config.generateId(),
        createdAt: now,
        updatedAt: now,
      };

      const version: FridayPlaybookVersion = {
        id: config.generateId(),
        playbookId,
        versionNumber: 1,
        fingerprint: candidate.fingerprint,
        pattern: candidate.pattern,
        candidateId: candidate.id,
        changeNote: "Initial version from promoted candidate.",
        createdAt: now,
      };

      store.savePlaybook(playbook);
      store.saveVersion(version);
      linkCandidateToPlaybook(candidate, playbookId, now);

      return { playbook, version };
    },

    evolve(playbookId, candidate, changeNote) {
      const playbook = store.getPlaybook(playbookId);
      if (!playbook) return null;

      const activeVersion = store.getVersionByNumber(playbookId, playbook.activeVersionNumber);
      if (!activeVersion) return null;

      // Check for fingerprint reuse in version history
      const existingVersions = store.getVersionsByPlaybookId(playbookId);
      const existingWithFingerprint = existingVersions.find(
        (v) => v.fingerprint === candidate.fingerprint,
      );

      if (existingWithFingerprint) {
        // Reactivate existing version instead of creating a new one
        const updated: FridayPlaybook = {
          ...playbook,
          activeVersionNumber: existingWithFingerprint.versionNumber,
          updatedAt: config.nowIso(),
          etag: config.generateId(),
        };
        store.savePlaybook(updated);
        linkCandidateToPlaybook(candidate, playbookId, updated.updatedAt);
        return existingWithFingerprint;
      }

      // Check similarity threshold
      const activeNodes = extractNodeSequenceFromPattern(activeVersion.pattern);
      const candidateNodes = extractNodeSequenceFromPattern(candidate.pattern);
      const similarity = computeNodeSequenceSimilarity(activeNodes, candidateNodes);

      if (similarity < evolutionThreshold) return null;

      // Create new version
      const newVersionNumber = existingVersions.length + 1;
      const now = config.nowIso();

      const version: FridayPlaybookVersion = {
        id: config.generateId(),
        playbookId,
        versionNumber: newVersionNumber,
        fingerprint: candidate.fingerprint,
        pattern: candidate.pattern,
        candidateId: candidate.id,
        changeNote: changeNote ?? `Evolved from candidate ${candidate.id}.`,
        createdAt: now,
      };

      store.saveVersion(version);

      // Update playbook to point to new version
      const updated: FridayPlaybook = {
        ...playbook,
        activeVersionNumber: newVersionNumber,
        updatedAt: now,
        etag: config.generateId(),
      };
      store.savePlaybook(updated);
      linkCandidateToPlaybook(candidate, playbookId, now);

      return version;
    },

    rollback(playbookId, targetVersionNumber, reason) {
      const playbook = store.getPlaybook(playbookId);
      if (!playbook) return null;

      const targetVersion = store.getVersionByNumber(playbookId, targetVersionNumber);
      if (!targetVersion) return null;

      if (playbook.activeVersionNumber === targetVersionNumber) return null;

      const now = config.nowIso();
      const previousVersionNumber = playbook.activeVersionNumber;
      const updated: FridayPlaybook = {
        ...playbook,
        activeVersionNumber: targetVersionNumber,
        status: "active" as FridayPlaybookStatus,
        updatedAt: now,
        etag: config.generateId(),
      };

      store.savePlaybook(updated);
      const event: FridayPlaybookLifecycleEvent = {
        id: config.generateId(),
        playbookId,
        type: "rollback",
        reason,
        fromVersionNumber: previousVersionNumber,
        toVersionNumber: targetVersionNumber,
        occurredAt: now,
      };
      store.saveLifecycleEvent(event);
      return updated;
    },

    deactivate(playbookId, reason) {
      const playbook = store.getPlaybook(playbookId);
      if (!playbook) return null;

      const now = config.nowIso();
      const previousVersionNumber = playbook.activeVersionNumber;
      const updated: FridayPlaybook = {
        ...playbook,
        status: "rolled_back" as FridayPlaybookStatus,
        updatedAt: now,
        archivedAt: now,
        etag: config.generateId(),
      };

      store.savePlaybook(updated);

      // Update source candidate status
      const candidate = store.getCandidate(playbook.sourceCandidateId);
      if (candidate) {
        store.saveCandidate({ ...candidate, status: "rolled_back", updatedAt: now });
      }

      const event: FridayPlaybookLifecycleEvent = {
        id: config.generateId(),
        playbookId,
        type: "deactivate",
        reason,
        fromVersionNumber: previousVersionNumber,
        toVersionNumber: null,
        occurredAt: now,
      };
      store.saveLifecycleEvent(event);

      return updated;
    },

    diff(playbookId, fromVersion, toVersion) {
      const fromVer = store.getVersionByNumber(playbookId, fromVersion);
      const toVer = store.getVersionByNumber(playbookId, toVersion);

      if (!fromVer || !toVer) return null;

      const entries = diffObjects(fromVer.pattern, toVer.pattern, "");

      return {
        fromVersion,
        toVersion,
        entries,
        identical: entries.length === 0,
      };
    },

    getHistory(playbookId) {
      return store.getVersionsByPlaybookId(playbookId);
    },
  };

  function linkCandidateToPlaybook(
    candidate: FridayPlaybookCandidate,
    playbookId: UUID,
    nowIso: string,
  ): void {
    const latest = store.getCandidate(candidate.id) ?? candidate;
    const updatedCandidate: FridayPlaybookCandidate = {
      ...latest,
      promotedPlaybookId: playbookId,
      status: "promoted",
      updatedAt: nowIso,
    };
    store.saveCandidate(updatedCandidate);
  }
}

// ─── Diff Algorithm ───

/**
 * Recursively diff two JSON objects and produce a flat list of change entries.
 */
function diffObjects(oldObj: JsonObject, newObj: JsonObject, prefix: string): VersionDiffEntry[] {
  const entries: VersionDiffEntry[] = [];
  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);

  for (const key of allKeys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const oldVal = oldObj[key];
    const newVal = newObj[key];

    if (oldVal === undefined && newVal !== undefined) {
      entries.push({ path, kind: "added", newValue: newVal });
    } else if (oldVal !== undefined && newVal === undefined) {
      entries.push({ path, kind: "removed", oldValue: oldVal });
    } else if (
      oldVal !== null && newVal !== null &&
      typeof oldVal === "object" && typeof newVal === "object" &&
      !Array.isArray(oldVal) && !Array.isArray(newVal)
    ) {
      entries.push(...diffObjects(oldVal as JsonObject, newVal as JsonObject, path));
    } else if (!deepEqual(oldVal, newVal)) {
      entries.push({ path, kind: "changed", oldValue: oldVal, newValue: newVal });
    }
  }

  return entries;
}

/**
 * Deep equality check for JSON values.
 */
function deepEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, i) => deepEqual(val, b[i]));
  }

  if (typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => deepEqual((a as JsonObject)[key], (b as JsonObject)[key]));
  }

  return a === b;
}

// ─── Helpers ───

/**
 * Generate a human-readable playbook name from a candidate.
 */
function generatePlaybookName(candidate: FridayPlaybookCandidate): string {
  const pattern = candidate.pattern;
  const nodeSequence = pattern["nodeSequence"];
  if (Array.isArray(nodeSequence) && nodeSequence.length > 0) {
    const firstNode = nodeSequence[0] as JsonObject;
    const lastNode = nodeSequence[nodeSequence.length - 1] as JsonObject;
    const firstName = String(firstNode["nodeType"] ?? "unknown");
    const lastName = String(lastNode["nodeType"] ?? "unknown");
    if (nodeSequence.length === 1) {
      return `${candidate.workflowType}/${firstName}`;
    }
    return `${candidate.workflowType}/${firstName}→${lastName}`;
  }
  return `${candidate.workflowType}/playbook-${candidate.fingerprint.substring(0, 8)}`;
}
