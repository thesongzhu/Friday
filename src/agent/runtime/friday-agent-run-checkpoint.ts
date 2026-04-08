/**
 * Run Checkpoint Service — GAP 8
 *
 * Snapshots file contents before mutating tool calls.
 * Enables per-run rollback: restoring all changed files to their pre-run state.
 */

import { basename, dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import type { FridaySqliteLayer } from "#state";
import {
  createFridayAgentRunCheckpointRepository,
  type FridayAgentRunCheckpointManifestEntry,
} from "../persistence/friday-agent-run-checkpoint-repository.js";

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

    const entry: FridayRunCheckpointEntry = {
      filePath: canonicalPath,
      originalPath: filePath,
      existed,
      backupPath,
      snapshotAt: deps.nowIso(),
      rollbackAvailable: true,
    };

    snapshots.set(canonicalPath, entry);
    repo.upsert({
      runId: deps.runId,
      canonicalPath,
      originalPath: filePath,
      existedBefore: existed,
      backupPath,
      snapshotAt: entry.snapshotAt,
      rollbackAvailable: true,
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
        if (entry.existed && entry.backupPath) {
          // File existed before: restore from backup
          const content = readFileSync(entry.backupPath);
          writeFileSync(entry.filePath, content);
          restoredCount++;
        } else if (!entry.existed) {
          // File didn't exist before: delete it (if it exists now)
          if (existsSync(entry.filePath)) {
            unlinkSync(entry.filePath);
            restoredCount++;
          }
        }
        entry.rollbackAvailable = false;
        repo.markUnavailable(deps.runId, entry.filePath, deps.nowIso());
      } catch (err) {
        errors.push({
          filePath: entry.filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

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
