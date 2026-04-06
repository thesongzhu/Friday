/**
 * Run Checkpoint Service — GAP 8
 *
 * Snapshots file contents before mutating tool calls.
 * Enables per-run rollback: restoring all changed files to their pre-run state.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ─── Types ───

export interface FridayRunCheckpointEntry {
  /** Absolute path of the original file. */
  filePath: string;
  /** Whether the file existed before the write. */
  existed: boolean;
  /** Path to the backup copy (only if existed). */
  backupPath?: string;
  /** Timestamp when snapshot was taken. */
  snapshotAt: string;
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
  nowIso: () => string;
}

export function createFridayRunCheckpoint(deps: CreateRunCheckpointDeps): FridayRunCheckpoint {
  const snapshots = new Map<string, FridayRunCheckpointEntry>();
  const snapshotDir = join(deps.stateDir, "agent-snapshots", deps.runId);

  function snapshotBeforeWrite(filePath: string): void {
    // Only snapshot once per file per run
    if (snapshots.has(filePath)) return;

    const existed = existsSync(filePath);
    let backupPath: string | undefined;

    if (existed) {
      try {
        mkdirSync(snapshotDir, { recursive: true });
        // Use a safe filename: replace path separators with underscores
        const safeName = filePath.replace(/[/\\:]/g, "_");
        backupPath = join(snapshotDir, safeName);
        const content = readFileSync(filePath);
        writeFileSync(backupPath, content);
      } catch {
        // If we can't snapshot, still record that the file existed
        backupPath = undefined;
      }
    }

    snapshots.set(filePath, {
      filePath,
      existed,
      backupPath,
      snapshotAt: deps.nowIso(),
    });
  }

  function rollback(): { restoredCount: number; errors: Array<{ filePath: string; error: string }> } {
    let restoredCount = 0;
    const errors: Array<{ filePath: string; error: string }> = [];

    for (const entry of snapshots.values()) {
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
