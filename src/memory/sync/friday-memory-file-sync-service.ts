/**
 * Memory File Sync Service
 *
 * Polls the dirty queue for changes to memory namespaces and session keys,
 * then exports them as files. Uses debouncing, single-flight sync, and
 * hash-based skip to avoid unnecessary writes.
 *
 * Memory namespaces → JSON files (full rewrite on change).
 * Session keys → JSONL files (incremental append when possible).
 *
 * Key invariants (F2–F5):
 *   - Append is only attempted when prefix checksum matches stored contentHash.
 *   - Dirty rows are removed only on acknowledged success ("ack"), never on error or defer.
 *   - Append falls back to full rewrite when existing file cannot be read.
 *   - atomicWrite uses unique temp names and best-effort fsync before rename.
 *
 * Module 8 additions:
 *   - File watcher integration for external edits (chokidar-based).
 *   - reindexNow / reindexAll entry points for importing from exported files.
 *   - Loop suppression via exported hash tracking.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { FridayMemoryFileSyncRepository } from "./friday-memory-file-sync-repository.js";
import { memoryNamespaceExportPath, resolveExportRoot, sessionKeyExportPath } from "./friday-memory-file-sync-paths.js";
import {
  FRIDAY_MEMORY_FILE_SYNC_BATCH_SIZE,
  FRIDAY_MEMORY_FILE_SYNC_DEBOUNCE_MS,
  FRIDAY_MEMORY_FILE_SYNC_POLL_INTERVAL_MS,
  FRIDAY_MEMORY_FILE_SYNC_SESSION_DELTA_BYTES,
  FRIDAY_MEMORY_FILE_SYNC_SESSION_DELTA_MESSAGES,
} from "./friday-memory-file-sync.constants.js";
import type {
  FridayMemoryFileSyncDirtyRow,
  FridayMemoryFileSyncOutcome,
  FridayMemoryFileSyncReindexResult,
  FridayMemoryFileSyncResult,
  FridayMemoryFileSyncService,
  FridayMemoryFileSyncStatus,
  FridayMemorySyncEntityType,
} from "./friday-memory-file-sync.types.js";
import {
  createFridayMemoryFileSyncWatcher,
  type FridayMemoryFileSyncWatcher,
} from "./friday-memory-file-sync-watcher.js";

// ─── Dependencies ───

export interface CreateFridayMemoryFileSyncServiceDeps {
  repository: FridayMemoryFileSyncRepository;
  stateDir: string;
  nowIso?: () => string;
  /** Set to false to disable file watching. Default: true. */
  enableWatcher?: boolean;
  /** Override watcher debounce for testing. */
  watcherDebounceMs?: number;
}

// ─── Factory ───

export function createFridayMemoryFileSyncService(
  deps: CreateFridayMemoryFileSyncServiceDeps,
): FridayMemoryFileSyncService {
  const { repository, stateDir } = deps;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const enableWatcher = deps.enableWatcher ?? true;

  let running = false;
  let syncing = false;
  let lastSyncAt: string | undefined;
  let lastError: string | undefined;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let syncPromise: Promise<FridayMemoryFileSyncResult> | null = null;

  // File watcher (created lazily at start)
  let watcher: FridayMemoryFileSyncWatcher | null = null;

  // ─── Single-flight sync wrapper ───

  function singleFlightSync(force: boolean): Promise<FridayMemoryFileSyncResult> {
    if (syncPromise) return syncPromise;

    syncPromise = doSync(force).finally(() => {
      syncPromise = null;
    });
    return syncPromise;
  }

  // ─── Main sync logic ───

  async function doSync(force: boolean): Promise<FridayMemoryFileSyncResult> {
    syncing = true;

    const result: FridayMemoryFileSyncResult = {
      dirtySeen: 0,
      filesWritten: 0,
      filesDeleted: 0,
      filesSkippedUnchanged: 0,
      filesDeferred: 0,
      errors: [],
    };

    try {
      const dirtyBatch = repository.fetchDirtyBatch(FRIDAY_MEMORY_FILE_SYNC_BATCH_SIZE);
      result.dirtySeen = dirtyBatch.length;

      for (const dirty of dirtyBatch) {
        try {
          let outcome: FridayMemoryFileSyncOutcome;

          if (dirty.entityType === "memory_namespace") {
            outcome = await syncMemoryNamespace(dirty, force, result);
          } else if (dirty.entityType === "session_key") {
            outcome = await syncSessionKey(dirty, force, result);
          } else {
            outcome = "ack";
          }

          // F3: Only remove dirty on acknowledged success
          if (outcome === "ack") {
            repository.removeDirty(dirty.entityType, dirty.entityKey);
          } else {
            result.filesDeferred++;
          }
        } catch (err) {
          // F4: Never remove dirty on error — row persists for retry
          const message = err instanceof Error ? err.message : String(err);
          result.errors.push({
            entityType: dirty.entityType,
            entityKey: dirty.entityKey,
            message,
          });
        }
      }

      lastSyncAt = nowIso();
      lastError = result.errors.length > 0 ? result.errors[0]!.message : undefined;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      syncing = false;
    }

    return result;
  }

  // ─── Memory namespace sync (full rewrite) ───

  async function syncMemoryNamespace(
    dirty: FridayMemoryFileSyncDirtyRow,
    force: boolean,
    result: FridayMemoryFileSyncResult,
  ): Promise<FridayMemoryFileSyncOutcome> {
    const namespace = dirty.entityKey;
    const items = repository.fetchMemoryItems(namespace);
    const existingState = repository.getState("memory_namespace", namespace);
    const filePath = memoryNamespaceExportPath(stateDir, namespace);

    if (items.length === 0) {
      // Namespace is empty — delete file if it exists
      if (existingState) {
        // Clean up both current computed path and legacy stored path (F6)
        await safeUnlink(filePath);
        if (existingState.filePath !== filePath) {
          await safeUnlink(existingState.filePath);
        }
        repository.deleteState("memory_namespace", namespace);
        result.filesDeleted++;
      }
      return "ack";
    }

    // Build items payload (stable for hashing — no timestamp)
    const itemsPayload = items.map((item) => ({
      id: item.id,
      key: item.key,
      value: tryParseJson(item.value_json),
      contentText: item.content_text,
      source: item.source,
      tags: tryParseJson(item.tags_json),
      metadata: tryParseJson(item.metadata_json),
      createdAt: item.created_at,
      updatedAt: item.updated_at,
    }));

    // Hash-based skip (hash data only, not the exportedAt timestamp)
    const contentHash = computeHash(JSON.stringify(itemsPayload));
    if (!force && existingState && existingState.contentHash === contentHash) {
      result.filesSkippedUnchanged++;
      return "ack";
    }

    // Build full content with timestamp for the exported file
    const content = JSON.stringify(
      {
        namespace,
        exportedAt: nowIso(),
        items: itemsPayload,
      },
      null,
      2,
    );

    // Compute file-level hash for loop suppression
    const fileHash = computeHash(content);

    // Atomic write
    await atomicWrite(filePath, content);

    // Get mtime after write for loop suppression
    const mtimeMs = await getFileMtimeMs(filePath);

    // F6: Migrate legacy file path if changed
    if (existingState && existingState.filePath !== filePath) {
      await safeUnlink(existingState.filePath);
    }

    repository.upsertState({
      entityType: "memory_namespace",
      entityKey: namespace,
      filePath,
      contentHash,
      lastExportedSequence: null,
      exportedAt: nowIso(),
      lastExportedHash: fileHash,
      lastExportedMtimeMs: mtimeMs,
    });

    result.filesWritten++;
    return "ack";
  }

  // ─── Session key sync (incremental append when possible) ───

  async function syncSessionKey(
    dirty: FridayMemoryFileSyncDirtyRow,
    force: boolean,
    result: FridayMemoryFileSyncResult,
  ): Promise<FridayMemoryFileSyncOutcome> {
    const sessionKey = dirty.entityKey;
    const filePath = sessionKeyExportPath(stateDir, sessionKey);
    const totalMessages = repository.countSessionMessages(sessionKey);

    if (totalMessages === 0) {
      // No messages — delete file if state exists
      const state = repository.getState("session_key", sessionKey);
      if (state) {
        await safeUnlink(filePath);
        if (state.filePath !== filePath) {
          await safeUnlink(state.filePath);
        }
        repository.deleteState("session_key", sessionKey);
        result.filesDeleted++;
      }
      return "ack";
    }

    const existingState = repository.getState("session_key", sessionKey);

    // ─── Attempt incremental append (F2: checksum-validated) ───

    if (!force && existingState && existingState.lastExportedSequence != null) {
      const newMessages = repository.fetchSessionMessages(sessionKey, existingState.lastExportedSequence);

      if (newMessages.length === 0) {
        // No new messages — but we're dirty, so check for edits/deletes.
        // Verify by rebuilding prefix content and comparing checksum.
        const prefixMessages = repository.fetchSessionMessages(sessionKey);
        const prefixContent = prefixMessages.map((msg) => JSON.stringify(formatSessionMessage(msg))).join("\n") + "\n";
        const prefixHash = computeHash(prefixContent);

        if (prefixHash === existingState.contentHash) {
          result.filesSkippedUnchanged++;
          return "ack";
        }
        // Checksum mismatch — edits or deletes detected, fall through to full rewrite
      } else {
        // We have new messages.
        // L1: Validate prefix integrity BEFORE checking delta thresholds.
        // Edits to old messages must always trigger a full rewrite, regardless of delta size.
        const allMessages = repository.fetchSessionMessages(sessionKey);
        const prefixOnly = allMessages.filter((m) => m.sequence <= existingState.lastExportedSequence!);
        const prefixContent = prefixOnly.map((msg) => JSON.stringify(formatSessionMessage(msg))).join("\n") + "\n";
        const prefixHash = computeHash(prefixContent);

        if (prefixHash !== existingState.contentHash) {
          // Prefix integrity failed — edits detected, skip defer and fall through to full rewrite
        } else {
          // Prefix is intact — now check delta thresholds before writing
          const deltaBytes = newMessages.reduce((sum, m) => sum + (m.content_text?.length ?? m.content_json.length), 0);

          if (deltaBytes < FRIDAY_MEMORY_FILE_SYNC_SESSION_DELTA_BYTES && newMessages.length < FRIDAY_MEMORY_FILE_SYNC_SESSION_DELTA_MESSAGES) {
            // F3: Below threshold — defer, keep dirty row
            return "defer";
          }

          // F2: Prefix is intact — attempt append

          // F5: Read existing file; if missing, fall back to full rewrite
          let existingContent: string | null = null;
          try {
            const readPath = existingState.filePath === filePath ? filePath : existingState.filePath;
            existingContent = await fs.readFile(readPath, "utf8");
          } catch (err) {
            // File missing or unreadable — fall through to full rewrite
            console.warn("[friday][memory-file-sync] read-session-file:", err instanceof Error ? err.message : String(err));
          }

          if (existingContent != null) {
            // Append mode: write full content (existing + new) atomically
            const newLines = newMessages.map((msg) => JSON.stringify(formatSessionMessage(msg)));
            const fullContent = existingContent + newLines.join("\n") + "\n";

            await atomicWrite(filePath, fullContent);

            const lastSeq = newMessages[newMessages.length - 1]!.sequence;
            const contentHash = computeHash(fullContent);
            const fileHash = computeHash(fullContent);
            const mtimeMs = await getFileMtimeMs(filePath);

            // F6: Clean up legacy path
            if (existingState.filePath !== filePath) {
              await safeUnlink(existingState.filePath);
            }

            repository.upsertState({
              entityType: "session_key",
              entityKey: sessionKey,
              filePath,
              contentHash,
              lastExportedSequence: lastSeq,
              exportedAt: nowIso(),
              lastExportedHash: fileHash,
              lastExportedMtimeMs: mtimeMs,
            });

            result.filesWritten++;
            return "ack";
          }
          // existingContent is null — file missing, fall through to full rewrite
        }
        // Prefix validation failed — fall through to full rewrite
      }
    }

    // ─── Full rewrite ───

    const allMessages = repository.fetchSessionMessages(sessionKey);
    const lines = allMessages.map((msg) => JSON.stringify(formatSessionMessage(msg)));
    const content = lines.join("\n") + "\n";

    const contentHash = computeHash(content);
    if (!force && existingState && existingState.contentHash === contentHash) {
      result.filesSkippedUnchanged++;
      return "ack";
    }

    await atomicWrite(filePath, content);

    const fileHash = computeHash(content);
    const mtimeMs = await getFileMtimeMs(filePath);

    // F6: Clean up legacy path
    if (existingState && existingState.filePath !== filePath) {
      await safeUnlink(existingState.filePath);
    }

    const lastSeq = allMessages.length > 0 ? allMessages[allMessages.length - 1]!.sequence : null;

    repository.upsertState({
      entityType: "session_key",
      entityKey: sessionKey,
      filePath,
      contentHash,
      lastExportedSequence: lastSeq,
      exportedAt: nowIso(),
      lastExportedHash: fileHash,
      lastExportedMtimeMs: mtimeMs,
    });

    result.filesWritten++;
    return "ack";
  }

  // ─── Reindex logic (file → DB) ───

  async function reindexEntity(
    entityType: FridayMemorySyncEntityType,
    entityKey: string,
    result: FridayMemoryFileSyncReindexResult,
  ): Promise<void> {
    const state = repository.getState(entityType, entityKey);
    if (!state) return;

    const filePath = state.filePath;

    // Check if file exists
    let fileContent: string;
    try {
      fileContent = await fs.readFile(filePath, "utf8");
    } catch (err) {
      // File was deleted externally — this is a valid case
      // We could delete the DB data too, but for safety we skip
      console.warn("[friday][memory-file-sync] reindex-read-file:", err instanceof Error ? err.message : String(err));
      result.errors.push({
        entityType,
        entityKey,
        message: `File not found: ${filePath}`,
      });
      return;
    }

    // Loop suppression: skip if file hash matches last export
    const fileHash = computeHash(fileContent);
    if (state.lastExportedHash === fileHash) {
      result.filesSkippedUnchanged++;
      return;
    }

    if (entityType === "memory_namespace") {
      try {
        const parsed = JSON.parse(fileContent);
        if (!parsed || !Array.isArray(parsed.items)) {
          result.errors.push({ entityType, entityKey, message: "Invalid namespace export format" });
          return;
        }

        const items = parsed.items.map((item: Record<string, unknown>) => ({
          id: item.id as string,
          key: item.key as string,
          value_json: JSON.stringify(item.value ?? null),
          content_text: (item.contentText as string | null) ?? null,
          source: (item.source as string) ?? "file-import",
          tags_json: JSON.stringify(item.tags ?? []),
          metadata_json: JSON.stringify(item.metadata ?? null),
          created_at: (item.createdAt as string) ?? nowIso(),
          updated_at: (item.updatedAt as string) ?? nowIso(),
        }));

        const { upserted, deleted } = repository.upsertMemoryItemsFromExport(entityKey, items);
        result.itemsUpserted += upserted;
        result.itemsDeleted += deleted;
        result.filesProcessed++;

        // Update state with new hash so we don't reindex our own subsequent export
        repository.upsertState({
          ...state,
          lastExportedHash: fileHash,
          lastExportedMtimeMs: await getFileMtimeMs(filePath),
        });
      } catch (err) {
        result.errors.push({
          entityType,
          entityKey,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      // session_key reindex is read-only for now (sessions are append-only)
      result.filesSkippedUnchanged++;
    }
  }

  // ─── Watcher callback ───

  function onExternalChange(filePath: string): void {
    if (!running) return;

    // Determine entity type and key from file path
    const exportRoot = resolveExportRoot(stateDir);
    const relative = path.relative(exportRoot, filePath);

    // Find matching state by file path
    const allStates = repository.listAllStates();
    const match = allStates.find((s) => s.filePath === filePath);
    if (!match) return;

    // Schedule a reindex
    void reindexEntity(match.entityType, match.entityKey, {
      filesProcessed: 0,
      filesSkippedUnchanged: 0,
      itemsUpserted: 0,
      itemsDeleted: 0,
      errors: [],
    }).catch(() => {
      // Errors are non-fatal for background reindex
    });
  }

  // ─── Poll handler ───

  function onPoll(): void {
    if (!running) return;

    const count = repository.dirtyCount();
    if (count > 0 && !debounceTimer) {
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        singleFlightSync(false).catch(() => {
          // Errors recorded in result.errors / lastError
        });
      }, FRIDAY_MEMORY_FILE_SYNC_DEBOUNCE_MS);
    }
  }

  // ─── Service interface ───

  return {
    async start(): Promise<void> {
      if (running) return;
      running = true;
      pollTimer = setInterval(onPoll, FRIDAY_MEMORY_FILE_SYNC_POLL_INTERVAL_MS);

      // Start file watcher
      if (enableWatcher) {
        watcher = createFridayMemoryFileSyncWatcher({
          repository,
          stateDir,
          onExternalChange,
          debounceMs: deps.watcherDebounceMs,
        });
        await watcher.start();
      }
    },

    async stop(): Promise<void> {
      running = false;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      // Stop file watcher
      if (watcher) {
        await watcher.stop();
        watcher = null;
      }
      // Wait for in-flight sync to finish
      if (syncPromise) {
        await syncPromise.catch((err: unknown) => console.warn("[friday][memory-sync] stop:", err instanceof Error ? err.message : String(err)));
      }
    },

    async syncNow(input?: { force?: boolean }): Promise<FridayMemoryFileSyncResult> {
      return singleFlightSync(input?.force ?? false);
    },

    async reindexNow(
      entityType: FridayMemorySyncEntityType,
      entityKey: string,
    ): Promise<FridayMemoryFileSyncReindexResult> {
      const result: FridayMemoryFileSyncReindexResult = {
        filesProcessed: 0,
        filesSkippedUnchanged: 0,
        itemsUpserted: 0,
        itemsDeleted: 0,
        errors: [],
      };
      await reindexEntity(entityType, entityKey, result);
      return result;
    },

    async reindexAll(): Promise<FridayMemoryFileSyncReindexResult> {
      const result: FridayMemoryFileSyncReindexResult = {
        filesProcessed: 0,
        filesSkippedUnchanged: 0,
        itemsUpserted: 0,
        itemsDeleted: 0,
        errors: [],
      };

      const allStates = repository.listAllStates();
      for (const state of allStates) {
        await reindexEntity(state.entityType, state.entityKey, result);
      }

      return result;
    },

    status(): FridayMemoryFileSyncStatus {
      return {
        running,
        dirtyCount: running ? repository.dirtyCount() : 0,
        syncing,
        lastSyncAt,
        lastError,
        watcherActive: watcher?.isActive() ?? false,
        watcherPendingCount: watcher?.pendingCount() ?? 0,
      };
    },
  };
}

// ─── Helpers ───

function computeHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * F5: Atomic write with unique temp file, best-effort fsync, then rename.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  // Unique temp name to avoid collisions with concurrent writes
  const uniqueSuffix = crypto.randomBytes(8).toString("hex");
  const tmpPath = `${filePath}.tmp.${uniqueSuffix}`;

  let fd: fs.FileHandle | null = null;
  try {
    fd = await fs.open(tmpPath, "w");
    await fd.writeFile(content, "utf8");

    // Best-effort fsync: ensures data is on disk before rename
    try {
      await fd.sync();
    } catch (err) {
      // fsync not critical on all platforms — proceed with rename
      console.warn("[friday][memory-file-sync] fsync:", err instanceof Error ? err.message : String(err));
    }

    await fd.close();
    fd = null;

    await fs.rename(tmpPath, filePath);
  } catch (err) {
    if (fd) {
      try { await fd.close(); } catch (err) { /* ignore */ console.warn("[friday][memory-file-sync] fd-close:", err instanceof Error ? err.message : String(err)); }
    }
    // Clean up temp file on failure
    try { await fs.unlink(tmpPath); } catch (err) { /* ignore */ console.warn("[friday][memory-file-sync] unlink-tmp:", err instanceof Error ? err.message : String(err)); }
    throw err;
  }
}

/** Safely unlink a file, ignoring ENOENT. */
async function safeUnlink(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    // File may not exist — that's fine
    console.warn("[friday][memory-file-sync] safe-unlink:", err instanceof Error ? err.message : String(err));
  }
}

/** Get file mtime in milliseconds, or null if file doesn't exist. */
async function getFileMtimeMs(filePath: string): Promise<number | null> {
  try {
    const stat = await fs.stat(filePath);
    return stat.mtimeMs;
  } catch (err) {
    console.warn("[friday][memory-file-sync] get-file-mtime:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

function formatSessionMessage(msg: {
  id: string;
  session_key: string;
  role: string;
  content_json: string;
  content_text: string | null;
  sequence: number;
  occurred_at: string;
  created_at: string;
}): Record<string, unknown> {
  return {
    id: msg.id,
    role: msg.role,
    content: msg.content_text ?? tryParseJson(msg.content_json),
    sequence: msg.sequence,
    occurredAt: msg.occurred_at,
    createdAt: msg.created_at,
  };
}

function tryParseJson(json: string | null | undefined): unknown {
  if (!json) return null;
  if (!looksLikeJsonValue(json)) return json;
  try {
    return JSON.parse(json);
  } catch (err) {
    console.warn("[friday][memory-file-sync] try-parse-json:", err instanceof Error ? err.message : String(err));
    return json;
  }
}

function looksLikeJsonValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed === "true" || trimmed === "false" || trimmed === "null") return true;
  const first = trimmed[0];
  return (
    first === "{" ||
    first === "[" ||
    first === '"' ||
    first === "-" ||
    (first >= "0" && first <= "9")
  );
}
