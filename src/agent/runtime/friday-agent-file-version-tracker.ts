/**
 * File Version Tracker — Initiative B.2
 *
 * Tracks file mtime and inode across a single agent run to detect
 * concurrent modifications. Before a write/edit, the caller checks
 * whether the file has changed since it was last read in this run.
 *
 * This is a per-run in-memory structure — no persistence required.
 */

import { statSync } from "node:fs";

// ─── Types ───

export interface FridayFileSnapshot {
  /** Absolute file path. */
  filePath: string;
  /** Modification time (ms since epoch). */
  mtimeMs: number;
  /** Inode number (for rename/swap detection). */
  ino: number;
  /** Size in bytes at snapshot time. */
  size: number;
  /** When this snapshot was taken (ISO). */
  snapshotAt: string;
}

export type FridayFileConflictResult =
  | { conflict: false }
  | { conflict: true; reason: "mtime_changed" | "inode_changed" | "size_changed" | "file_deleted"; snapshot: FridayFileSnapshot };

// ─── Tracker ───

export interface FridayFileVersionTracker {
  /** Record a file snapshot after a successful read. */
  recordRead(filePath: string): void;
  /** Check whether a file has changed since last read. Returns conflict details if so. */
  checkBeforeWrite(filePath: string): FridayFileConflictResult;
  /** Clear all tracked files (e.g. at run end). */
  clear(): void;
  /** Number of files being tracked. */
  readonly size: number;
}

export function createFridayFileVersionTracker(): FridayFileVersionTracker {
  const snapshots = new Map<string, FridayFileSnapshot>();

  function takeSnapshot(filePath: string): FridayFileSnapshot | null {
    try {
      const stat = statSync(filePath);
      return {
        filePath,
        mtimeMs: stat.mtimeMs,
        ino: stat.ino,
        size: stat.size,
        snapshotAt: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  function recordRead(filePath: string): void {
    const snap = takeSnapshot(filePath);
    if (snap) {
      snapshots.set(filePath, snap);
    }
  }

  function checkBeforeWrite(filePath: string): FridayFileConflictResult {
    const previous = snapshots.get(filePath);
    if (!previous) {
      // No prior read recorded — no conflict to detect
      return { conflict: false };
    }

    const current = takeSnapshot(filePath);
    if (!current) {
      return { conflict: true, reason: "file_deleted", snapshot: previous };
    }

    if (current.ino !== previous.ino) {
      return { conflict: true, reason: "inode_changed", snapshot: previous };
    }
    if (current.mtimeMs !== previous.mtimeMs) {
      return { conflict: true, reason: "mtime_changed", snapshot: previous };
    }
    if (current.size !== previous.size) {
      return { conflict: true, reason: "size_changed", snapshot: previous };
    }

    return { conflict: false };
  }

  function clear(): void {
    snapshots.clear();
  }

  return {
    recordRead,
    checkBeforeWrite,
    clear,
    get size() {
      return snapshots.size;
    },
  };
}
