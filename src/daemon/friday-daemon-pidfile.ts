/**
 * Daemon PID File — Read/write/validate the PID file for process ownership.
 *
 * @module daemon/friday-daemon-pidfile
 */

import type { FridayDaemonPidRecord, FridayDaemonResult } from "./friday-daemon.types.js";

// ─── Error Codes ───

export const DAEMON_PID_ERROR_CODES = {
  PID_FILE_NOT_FOUND: "DAEMON_PID_FILE_NOT_FOUND",
  PID_FILE_CORRUPT: "DAEMON_PID_FILE_CORRUPT",
  PID_FILE_WRITE_FAILED: "DAEMON_PID_FILE_WRITE_FAILED",
  PROCESS_NOT_RUNNING: "DAEMON_PROCESS_NOT_RUNNING",
  ALREADY_RUNNING: "DAEMON_ALREADY_RUNNING",
} as const;

// ─── IO Abstraction ───

export interface FridayDaemonPidFileDeps {
  readonly readFile: (path: string) => string | null;
  readonly writeFile: (path: string, content: string) => void;
  readonly removeFile: (path: string) => void;
  readonly mkdirp: (path: string) => void;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly nowIso: () => string;
}

// ─── PID File Operations ───

export function readPidRecord(
  pidFilePath: string,
  deps: FridayDaemonPidFileDeps,
): FridayDaemonResult<FridayDaemonPidRecord> {
  const content = deps.readFile(pidFilePath);
  if (content === null) {
    return {
      ok: false,
      error: {
        code: DAEMON_PID_ERROR_CODES.PID_FILE_NOT_FOUND,
        message: `PID file not found at ${pidFilePath}`,
      },
    };
  }

  try {
    const record = JSON.parse(content) as FridayDaemonPidRecord;
    if (typeof record.pid !== "number" || !Number.isInteger(record.pid)) {
      return {
        ok: false,
        error: {
          code: DAEMON_PID_ERROR_CODES.PID_FILE_CORRUPT,
          message: "PID file contains invalid pid value",
        },
      };
    }
    return { ok: true, value: record };
  } catch {
    return {
      ok: false,
      error: {
        code: DAEMON_PID_ERROR_CODES.PID_FILE_CORRUPT,
        message: "PID file contains invalid JSON",
      },
    };
  }
}

export function writePidRecord(
  pidFilePath: string,
  runtimeDir: string,
  pid: number,
  deps: FridayDaemonPidFileDeps,
  version?: string,
): FridayDaemonResult<FridayDaemonPidRecord> {
  const record: FridayDaemonPidRecord = {
    pid,
    startedAt: deps.nowIso(),
    version,
  };

  try {
    deps.mkdirp(runtimeDir);
    deps.writeFile(pidFilePath, JSON.stringify(record, null, 2));
    return { ok: true, value: record };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: DAEMON_PID_ERROR_CODES.PID_FILE_WRITE_FAILED,
        message: `Failed to write PID file: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

export function removePidFile(
  pidFilePath: string,
  deps: FridayDaemonPidFileDeps,
): void {
  try {
    deps.removeFile(pidFilePath);
  } catch {
    // Ignore — file may already be removed
  }
}

/**
 * Validate that the PID in the file is still alive.
 *
 * Returns the record if alive, cleans up stale PID file otherwise.
 */
export function validatePidFile(
  pidFilePath: string,
  deps: FridayDaemonPidFileDeps,
): FridayDaemonResult<FridayDaemonPidRecord> {
  const readResult = readPidRecord(pidFilePath, deps);
  if (!readResult.ok) return readResult;

  const record = readResult.value;

  if (!deps.isProcessAlive(record.pid)) {
    // Stale PID file — clean up
    removePidFile(pidFilePath, deps);
    return {
      ok: false,
      error: {
        code: DAEMON_PID_ERROR_CODES.PROCESS_NOT_RUNNING,
        message: `Process ${record.pid} is no longer running (stale PID file cleaned)`,
      },
    };
  }

  return { ok: true, value: record };
}
