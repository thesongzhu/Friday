/** Debounce delay (ms) between dirty detection and sync execution. */
export const FRIDAY_MEMORY_FILE_SYNC_DEBOUNCE_MS = 1500;

/** Poll interval (ms) for checking dirty queue. */
export const FRIDAY_MEMORY_FILE_SYNC_POLL_INTERVAL_MS = 5000;

/** Max dirty entries to process per sync batch. */
export const FRIDAY_MEMORY_FILE_SYNC_BATCH_SIZE = 50;

/** Min accumulated bytes of new session messages before writing. */
export const FRIDAY_MEMORY_FILE_SYNC_SESSION_DELTA_BYTES = 100_000;

/** Min accumulated new session messages before writing. */
export const FRIDAY_MEMORY_FILE_SYNC_SESSION_DELTA_MESSAGES = 50;

/** Export root subdirectory under stateDir. */
export const FRIDAY_MEMORY_FILE_SYNC_EXPORT_DIR = ".friday/exports";

/** Fail-closed code for legacy file -> memory_items reverse imports. */
export const FRIDAY_MEMORY_FILE_IMPORT_RETIRED_ERROR =
  "TS_RUNTIME_MEMORY_FILE_IMPORT_RETIRED: memory file reverse-import into memory_items is disabled by default; use the Rust memory owner/import migration path instead.";
