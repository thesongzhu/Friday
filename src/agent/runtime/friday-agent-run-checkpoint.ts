/**
 * Run Checkpoint Service — GAP 8
 *
 * Snapshots file contents before mutating tool calls.
 * Enables per-run rollback: restoring all changed files to their pre-run state.
 */

import { basename, dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import type { FridaySqliteLayer } from "#state";
import {
  createFridayAgentRunCheckpointRepository,
  type FridayAgentRunCheckpointManifestEntry,
  type FridayAgentRunCheckpointRepository,
} from "../persistence/friday-agent-run-checkpoint-repository.js";

/**
 * Conservative default retention for rollback checkpoint backups: 24 hours.
 *
 * B2 privacy-recovery balance: backup files under
 * `stateDir/agent-snapshots/<runId>/` are secret-bearing transient recovery
 * state (pre-mutation file contents, which may include credentials or PII).
 * Keeping them indefinitely is both disk-bloat and a privacy concern. 24h
 * is generous enough for legitimate post-run rollback while short enough to
 * limit the data-at-rest exposure window. Callers may override via
 * `pruneExpiredAgentRunCheckpoints`'s `maxAgeMs` parameter.
 */
export const FRIDAY_DEFAULT_AGENT_RUN_CHECKPOINT_RETENTION_MS = 24 * 60 * 60 * 1_000;

// ─── Types ───

export interface FridayRunCheckpointEntry {
  /** Canonical absolute path of the original file. */
  filePath: string;
  /** Raw path requested by the mutating tool call. */
  originalPath: string;
  /** Whether the file existed before the write. */
  existed: boolean;
  /** Path to the backup copy (only if existed). */
  backupPath?: string;
  /** Timestamp when snapshot was taken. */
  snapshotAt: string;
  /** Whether the snapshot is still eligible for rollback. */
  rollbackAvailable: boolean;
}

export interface FridayRunCheckpoint {
  /** Take a snapshot of the file before a write. Idempotent per filePath. */
  snapshotBeforeWrite(filePath: string): void;
  /** Restore all snapshotted files to their pre-run state. Returns count of restored files. */
  rollback(): { restoredCount: number; errors: Array<{ filePath: string; error: string }> };
  /** List all snapshotted entries. */
  entries(): FridayRunCheckpointEntry[];
  /** Number of tracked files. */
  readonly size: number;
}

export interface CreateRunCheckpointDeps {
  runId: string;
  stateDir: string;
  db: FridaySqliteLayer;
  nowIso: () => string;
}

function resolveCanonicalCheckpointPath(
  workspaceRoot: string,
  filePath: string,
): string {
  const absolutePath = resolve(workspaceRoot, filePath);

  try {
    return realpathSync(absolutePath);
  } catch {
    let current = absolutePath;
    const pendingSegments: string[] = [];

    while (true) {
      try {
        const resolvedAncestor = realpathSync(current);
        return pendingSegments.length > 0
          ? join(resolvedAncestor, ...pendingSegments.reverse())
          : resolvedAncestor;
      } catch {
        const parent = dirname(current);
        if (parent === current) {
          return absolutePath;
        }
        pendingSegments.push(basename(current));
        current = parent;
      }
    }
  }
}

/**
 * Best-effort: remove `dir` if it is empty. Used to keep
 * `stateDir/agent-snapshots/` tidy after rollback or TTL prune. Errors
 * (ENOTEMPTY, ENOENT, EBUSY) are swallowed — directory cleanliness is not
 * load-bearing for correctness.
 */
function tryRemoveEmptyDir(dir: string): void {
  try {
    if (!existsSync(dir)) return;
    rmdirSync(dir); // throws if not empty; that's fine
  } catch {
    /* best-effort */
  }
}

export function createFridayRunCheckpoint(deps: CreateRunCheckpointDeps): FridayRunCheckpoint {
  const repo = createFridayAgentRunCheckpointRepository({ db: deps.db });
  const snapshots = new Map<string, FridayRunCheckpointEntry>();
  const snapshotDir = join(deps.stateDir, "agent-snapshots", deps.runId);

  for (const entry of repo.listByRunId(deps.runId)) {
    if (!entry.rollbackAvailable) {
      continue;
    }
    snapshots.set(entry.canonicalPath, {
      filePath: entry.canonicalPath,
      originalPath: entry.originalPath,
      existed: entry.existedBefore,
      backupPath: entry.backupPath,
      snapshotAt: entry.snapshotAt,
      rollbackAvailable: entry.rollbackAvailable,
    });
  }

  function snapshotBeforeWrite(filePath: string): void {
    const canonicalPath = resolveCanonicalCheckpointPath(deps.stateDir, filePath);

    // Only snapshot once per file per run
    if (snapshots.has(canonicalPath)) return;

    const existed = existsSync(canonicalPath);
    let backupPath: string | undefined;

    if (existed) {
      try {
        mkdirSync(snapshotDir, { recursive: true });
        // Use a safe filename: replace path separators with underscores
        const safeName = canonicalPath.replace(/[/\\:]/g, "_");
        backupPath = join(snapshotDir, safeName);
        const content = readFileSync(canonicalPath);
        writeFileSync(backupPath, content);
      } catch {
        // If we can't snapshot, still record that the file existed
        backupPath = undefined;
      }
    }

    // Truthful reversibility: never claim rollback is available when it is not.
    //   - A newly-created file (!existed) is reversible by deletion — always true.
    //   - An EXISTING file is reversible ONLY if its pre-mutation backup was
    //     actually captured above. If the backup read/write threw (catch at
    //     the try above → backupPath === undefined), rollback() would
    //     fail-close with "backup unavailable", so advertising availability
    //     here would be an over-claim surfaced to the user via the run
    //     receipt / rollback_available health state.
    // Computed once and used at BOTH persistence sites (in-memory entry and
    // the manifest row) so the claim can never diverge between them.
    const rollbackAvailable = existed ? backupPath !== undefined : true;

    const entry: FridayRunCheckpointEntry = {
      filePath: canonicalPath,
      originalPath: filePath,
      existed,
      backupPath,
      snapshotAt: deps.nowIso(),
      rollbackAvailable,
    };

    snapshots.set(canonicalPath, entry);
    repo.upsert({
      runId: deps.runId,
      canonicalPath,
      originalPath: filePath,
      existedBefore: existed,
      backupPath,
      snapshotAt: entry.snapshotAt,
      rollbackAvailable,
      updatedAt: entry.snapshotAt,
    } satisfies FridayAgentRunCheckpointManifestEntry);
  }

  function rollback(): { restoredCount: number; errors: Array<{ filePath: string; error: string }> } {
    let restoredCount = 0;
    const errors: Array<{ filePath: string; error: string }> = [];

    for (const entry of snapshots.values()) {
      if (!entry.rollbackAvailable) {
        continue;
      }
      try {
        if (entry.existed) {
          // B2 fail-closed: pre-mutation backup is REQUIRED for a faithful
          // restore. If backupPath is absent (snapshot capture failed at
          // write time) or the backup file has been pruned/corrupted away,
          // surface an explicit error instead of writing garbage or leaving
          // the file in the post-mutation state.
          if (!entry.backupPath) {
            errors.push({
              filePath: entry.filePath,
              error: "backup unavailable: snapshot was not captured at write time",
            });
            continue;
          }
          if (!existsSync(entry.backupPath)) {
            errors.push({
              filePath: entry.filePath,
              error: `backup unavailable: pre-mutation snapshot file is missing at ${entry.backupPath} (pruned or corrupted)`,
            });
            continue;
          }
          const content = readFileSync(entry.backupPath);
          writeFileSync(entry.filePath, content);
          restoredCount++;
        } else {
          // File didn't exist before: delete it (if it exists now)
          if (existsSync(entry.filePath)) {
            unlinkSync(entry.filePath);
            restoredCount++;
          }
        }
        entry.rollbackAvailable = false;
        repo.markUnavailable(deps.runId, entry.filePath, deps.nowIso());
        // B2 retention: after a successful rollback the backup is dead by
        // design (its content has just been restored to the canonical path).
        // Delete it immediately so the secret-bearing pre-mutation copy does
        // not linger past its useful life.
        if (entry.backupPath && existsSync(entry.backupPath)) {
          try {
            unlinkSync(entry.backupPath);
          } catch {
            // best-effort: the manifest already records unavailable;
            // TTL prune will sweep stragglers later.
          }
        }
      } catch (err) {
        errors.push({
          filePath: entry.filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Best-effort: remove the now-empty per-run snapshot directory.
    tryRemoveEmptyDir(snapshotDir);

    return { restoredCount, errors };
  }

  function entries(): FridayRunCheckpointEntry[] {
    return [...snapshots.values()];
  }

  return {
    snapshotBeforeWrite,
    rollback,
    entries,
    get size() {
      return snapshots.size;
    },
  };
}

// ─── TTL / Prune ───

export interface PruneExpiredAgentRunCheckpointsOptions {
  stateDir: string;
  db: FridaySqliteLayer;
  nowIso: () => string;
  /**
   * Maximum age (in ms) of a snapshot before it is eligible for prune.
   * Defaults to {@link FRIDAY_DEFAULT_AGENT_RUN_CHECKPOINT_RETENTION_MS}.
   */
  maxAgeMs?: number;
  /** Optional injection seam for tests; defaults to the real repository. */
  repository?: FridayAgentRunCheckpointRepository;
}

export interface PruneExpiredAgentRunCheckpointsResult {
  /** Number of backup files deleted from disk. */
  filesRemoved: number;
  /** Number of manifest rows deleted from the repository. */
  manifestRowsRemoved: number;
  /** Number of distinct per-run snapshot directories removed (best-effort). */
  runDirsRemoved: number;
  /** Per-entry errors (backup unlink failures, manifest delete failures). */
  errors: Array<{ runId: string; canonicalPath: string; error: string }>;
}

/**
 * Sweep expired rollback checkpoint state.
 *
 * For every manifest entry whose `snapshotAt` is older than `maxAgeMs`:
 *   - Delete its `backupPath` file from disk (best-effort; missing OK).
 *   - Delete its manifest row.
 * After processing, attempts to remove now-empty `agent-snapshots/<runId>/`
 * directories so the on-disk layout reflects the retention policy.
 *
 * B2 fail-closed semantics: after this returns, any caller that constructs
 * a `createFridayRunCheckpoint` for a pruned `runId` will load an empty
 * snapshot map (manifest rows gone) and `rollback()` for any in-memory
 * entry will return a fail-closed error because the backup file is gone.
 */
export function pruneExpiredAgentRunCheckpoints(
  options: PruneExpiredAgentRunCheckpointsOptions,
): PruneExpiredAgentRunCheckpointsResult {
  const repo = options.repository
    ?? createFridayAgentRunCheckpointRepository({ db: options.db });
  const maxAgeMs = options.maxAgeMs ?? FRIDAY_DEFAULT_AGENT_RUN_CHECKPOINT_RETENTION_MS;
  const cutoffMs = new Date(options.nowIso()).getTime() - maxAgeMs;
  const cutoffIso = new Date(cutoffMs).toISOString();

  const expired = repo.listOlderThan(cutoffIso);
  const result: PruneExpiredAgentRunCheckpointsResult = {
    filesRemoved: 0,
    manifestRowsRemoved: 0,
    runDirsRemoved: 0,
    errors: [],
  };

  const touchedRunDirs = new Set<string>();
  for (const entry of expired) {
    if (entry.backupPath) {
      touchedRunDirs.add(join(options.stateDir, "agent-snapshots", entry.runId));
      try {
        if (existsSync(entry.backupPath)) {
          unlinkSync(entry.backupPath);
          result.filesRemoved += 1;
        }
      } catch (err) {
        result.errors.push({
          runId: entry.runId,
          canonicalPath: entry.canonicalPath,
          error: `unlink backup failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    try {
      repo.deleteEntry(entry.runId, entry.canonicalPath);
      result.manifestRowsRemoved += 1;
    } catch (err) {
      result.errors.push({
        runId: entry.runId,
        canonicalPath: entry.canonicalPath,
        error: `manifest delete failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Best-effort: drop empty <runId> dirs to keep the on-disk layout aligned
  // with the manifest. We only count true removals (rmdirSync would have
  // thrown if non-empty).
  for (const runDir of touchedRunDirs) {
    try {
      if (existsSync(runDir) && readdirSync(runDir).length === 0) {
        rmdirSync(runDir);
        result.runDirsRemoved += 1;
      }
    } catch {
      /* best-effort */
    }
  }

  return result;
}
