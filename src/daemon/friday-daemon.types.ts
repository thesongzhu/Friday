/**
 * Daemon Mode — Type definitions for the Friday background service.
 *
 * @module daemon/friday-daemon.types
 */

/** Runtime paths used by the daemon for PID, logs, and socket files. */
export interface FridayDaemonRuntimePaths {
  /** Directory containing all daemon runtime files. */
  readonly runtimeDir: string;
  /** Path to the PID file. */
  readonly pidFile: string;
  /** Path to the stdout log file. */
  readonly stdoutLog: string;
  /** Path to the stderr log file. */
  readonly stderrLog: string;
}

/** PID record written to the PID file. */
export interface FridayDaemonPidRecord {
  readonly pid: number;
  readonly startedAt: string;
  readonly version?: string;
}

/** Daemon status as reported by the `status` command. */
export interface FridayDaemonStatus {
  readonly running: boolean;
  readonly pid: number | null;
  readonly startedAt: string | null;
  readonly uptime: number | null;
}

/** Configuration for the daemon service. */
export interface FridayDaemonConfig {
  /** Paths for runtime files. */
  readonly paths: FridayDaemonRuntimePaths;
  /** Grace period in ms before SIGKILL after SIGTERM. */
  readonly shutdownGraceMs: number;
  /** Application version string to write to PID record. */
  readonly version?: string;
}

/** Result from daemon operations. */
export type FridayDaemonResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };
