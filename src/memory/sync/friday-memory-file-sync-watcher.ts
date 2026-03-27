/**
 * Memory File Sync — File Watcher
 *
 * Watches the export directory for external edits and queues reindex
 * operations via a debounce mechanism. Uses loop suppression to avoid
 * reindexing files that the service itself just wrote.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FSWatcher } from "chokidar";

import type { FridayMemoryFileSyncRepository } from "./friday-memory-file-sync-repository.js";
import { resolveExportRoot } from "./friday-memory-file-sync-paths.js";

// ─── Constants ───

/** Debounce delay (ms) for external file change events. */
export const FRIDAY_MEMORY_FILE_SYNC_WATCHER_DEBOUNCE_MS = 500;

// ─── Types ───

export interface FridayMemoryFileSyncWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  isActive(): boolean;
  pendingCount(): number;
}

export interface CreateFridayMemoryFileSyncWatcherDeps {
  repository: FridayMemoryFileSyncRepository;
  stateDir: string;
  /** Called when an external change is detected (after debounce and loop suppression). */
  onExternalChange: (filePath: string) => void;
  debounceMs?: number;
}

// ─── Factory ───

export function createFridayMemoryFileSyncWatcher(
  deps: CreateFridayMemoryFileSyncWatcherDeps,
): FridayMemoryFileSyncWatcher {
  const { repository, stateDir, onExternalChange } = deps;
  const debounceMs = deps.debounceMs ?? FRIDAY_MEMORY_FILE_SYNC_WATCHER_DEBOUNCE_MS;

  const exportRoot = resolveExportRoot(stateDir);

  let watcher: FSWatcher | null = null;
  let active = false;

  // Debounce map: filePath → timeout handle
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleExternalSync(filePath: string): void {
    // Clear existing timer for this path
    const existing = pendingTimers.get(filePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      pendingTimers.delete(filePath);
      void handleFileEvent(filePath);
    }, debounceMs);

    pendingTimers.set(filePath, timer);
  }

  async function handleFileEvent(filePath: string): Promise<void> {
    // Resolve the entity from the file path
    const relative = path.relative(exportRoot, filePath);
    if (!relative || relative.startsWith("..")) return;

    // Check loop suppression: compare file hash to last exported hash
    const state = findStateByFilePath(filePath);
    if (state) {
      try {
        const fileContent = await fs.readFile(filePath, "utf8");
        const fileHash = crypto.createHash("sha256").update(fileContent).digest("hex");

        // If the file hash matches what we last exported, skip (it's our own write)
        if (state.lastExportedHash === fileHash) {
          return;
        }
      } catch (err) {
        // File may have been deleted — that's a valid external change
        console.warn("[friday][memory-file-sync-watcher] file read failed:", err instanceof Error ? err.message : String(err));
      }
    }

    onExternalChange(filePath);
  }

  function findStateByFilePath(filePath: string): { lastExportedHash: string | null } | null {
    const allStates = repository.listAllStates();
    const match = allStates.find((s) => s.filePath === filePath);
    if (!match) return null;
    return { lastExportedHash: match.lastExportedHash ?? null };
  }

  function handleUnlink(filePath: string): void {
    scheduleExternalSync(filePath);
  }

  return {
    async start(): Promise<void> {
      if (active) return;

      // Ensure export root exists before watching
      await fs.mkdir(exportRoot, { recursive: true });

      // Dynamic import to keep chokidar lazy
      const { watch } = await import("chokidar");

      watcher = watch(exportRoot, {
        ignoreInitial: true,
        // Ignore temp files from atomic writes
        ignored: /\.tmp\.[a-f0-9]+$/,
        awaitWriteFinish: {
          stabilityThreshold: 200,
          pollInterval: 50,
        },
      });

      watcher.on("change", (filePath: string) => scheduleExternalSync(filePath));
      watcher.on("add", (filePath: string) => scheduleExternalSync(filePath));
      watcher.on("unlink", (filePath: string) => handleUnlink(filePath));

      active = true;
    },

    async stop(): Promise<void> {
      active = false;

      // Clear all pending timers
      for (const timer of pendingTimers.values()) {
        clearTimeout(timer);
      }
      pendingTimers.clear();

      if (watcher) {
        await watcher.close();
        watcher = null;
      }
    },

    isActive(): boolean {
      return active;
    },

    pendingCount(): number {
      return pendingTimers.size;
    },
  };
}
