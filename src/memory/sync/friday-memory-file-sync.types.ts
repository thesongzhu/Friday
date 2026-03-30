export type FridayMemorySyncEntityType = "memory_namespace" | "session_key";

export interface FridayMemoryFileSyncService {
  start(): Promise<void>;
  stop(): Promise<void>;
  syncNow(input?: { force?: boolean }): Promise<FridayMemoryFileSyncResult>;
  /** Reindex a single entity from its exported file (external edit). */
  reindexNow(entityType: FridayMemorySyncEntityType, entityKey: string): Promise<FridayMemoryFileSyncReindexResult>;
  /** Reindex all entities from their exported files. */
  reindexAll(): Promise<FridayMemoryFileSyncReindexResult>;
  status(): FridayMemoryFileSyncStatus;
}

/** Outcome of a single entity sync — used to decide dirty-row removal. */
export type FridayMemoryFileSyncOutcome = "ack" | "defer";

export interface FridayMemoryFileSyncResult {
  dirtySeen: number;
  filesWritten: number;
  filesDeleted: number;
  filesSkippedUnchanged: number;
  filesDeferred: number;
  errors: Array<{ entityType: FridayMemorySyncEntityType; entityKey: string; message: string }>;
}

export interface FridayMemoryFileSyncReindexResult {
  filesProcessed: number;
  filesSkippedUnchanged: number;
  itemsUpserted: number;
  itemsDeleted: number;
  errors: Array<{ entityType: FridayMemorySyncEntityType; entityKey: string; message: string }>;
}

export interface FridayMemoryFileSyncStatus {
  running: boolean;
  dirtyCount: number;
  syncing: boolean;
  lastSyncAt?: string;
  lastError?: string;
  /** Whether the file watcher is active. */
  watcherActive: boolean;
  /** Number of pending external-sync events being debounced. */
  watcherPendingCount: number;
}

export interface FridayMemoryFileSyncDirtyRow {
  entityType: FridayMemorySyncEntityType;
  entityKey: string;
  firstDirtyAt: string;
  lastDirtyAt: string;
}

export interface FridayMemoryFileSyncStateRow {
  entityType: FridayMemorySyncEntityType;
  entityKey: string;
  filePath: string;
  contentHash: string;
  lastExportedSequence: number | null;
  exportedAt: string;
  lastExportedHash?: string | null;
  lastExportedMtimeMs?: number | null;
}
