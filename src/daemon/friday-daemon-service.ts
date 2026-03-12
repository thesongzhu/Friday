/**
 * Daemon Service — Start, stop, restart, and query the Friday background service.
 *
 * @module daemon/friday-daemon-service
 */

import type {
  FridayDaemonConfig,
  FridayDaemonResult,
  FridayDaemonStatus,
} from "./friday-daemon.types.js";

import {
  DAEMON_PID_ERROR_CODES,
  readPidRecord,
  removePidFile,
  validatePidFile,
  writePidRecord,
} from "./friday-daemon-pidfile.js";

import type { FridayDaemonPidFileDeps } from "./friday-daemon-pidfile.js";

// ─── Error Codes ───

export const DAEMON_SERVICE_ERROR_CODES = {
  ALREADY_RUNNING: DAEMON_PID_ERROR_CODES.ALREADY_RUNNING,
  NOT_RUNNING: "DAEMON_NOT_RUNNING",
  START_FAILED: "DAEMON_START_FAILED",
  STOP_FAILED: "DAEMON_STOP_FAILED",
} as const;

// ─── Process Control Abstraction ───

export interface FridayDaemonProcessControl {
  /** Spawn a detached child process and return its PID. */
  spawnDaemon(
    stdoutLog: string,
    stderrLog: string,
  ): FridayDaemonResult<{ pid: number }>;

  /** Send SIGTERM to a process. Returns true if signal was sent. */
  sendSignal(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean;

  /** Wait for process to exit up to timeoutMs. Returns true if process exited. */
  waitForExit(pid: number, timeoutMs: number): Promise<boolean>;
}

// ─── Service Deps ───

export interface FridayDaemonServiceDeps {
  readonly config: FridayDaemonConfig;
  readonly pidFileDeps: FridayDaemonPidFileDeps;
  readonly processControl: FridayDaemonProcessControl;
}

// ─── Interface ───

export interface FridayDaemonService {
  /** Start the daemon as a background process. */
  start(): Promise<FridayDaemonResult<{ pid: number }>>;
  /** Stop a running daemon gracefully. */
  stop(): Promise<FridayDaemonResult<void>>;
  /** Restart the daemon (stop + start). */
  restart(): Promise<FridayDaemonResult<{ pid: number }>>;
  /** Query the current daemon status. */
  status(): FridayDaemonStatus;
}

// ─── Factory ───

export function createFridayDaemonService(
  deps: FridayDaemonServiceDeps,
): FridayDaemonService {
  const { config, pidFileDeps, processControl } = deps;
  const { paths } = config;

  return {
    async start() {
      // Check if already running
      const existing = validatePidFile(paths.pidFile, pidFileDeps);
      if (existing.ok) {
        return {
          ok: false,
          error: {
            code: DAEMON_SERVICE_ERROR_CODES.ALREADY_RUNNING,
            message: `Daemon is already running with PID ${existing.value.pid}`,
          },
        };
      }

      // Spawn detached child
      const spawnResult = processControl.spawnDaemon(
        paths.stdoutLog,
        paths.stderrLog,
      );

      if (!spawnResult.ok) {
        return {
          ok: false,
          error: {
            code: DAEMON_SERVICE_ERROR_CODES.START_FAILED,
            message: spawnResult.error.message,
          },
        };
      }

      // Write PID file
      const writeResult = writePidRecord(
        paths.pidFile,
        paths.runtimeDir,
        spawnResult.value.pid,
        pidFileDeps,
        config.version,
      );

      if (!writeResult.ok) {
        // Kill the spawned process since we can't track it
        processControl.sendSignal(spawnResult.value.pid, "SIGKILL");
        return {
          ok: false,
          error: {
            code: DAEMON_SERVICE_ERROR_CODES.START_FAILED,
            message: `Spawned daemon but failed to write PID file: ${writeResult.error.message}`,
          },
        };
      }

      return { ok: true, value: { pid: spawnResult.value.pid } };
    },

    async stop() {
      // Read PID
      const pidResult = validatePidFile(paths.pidFile, pidFileDeps);
      if (!pidResult.ok) {
        return {
          ok: false,
          error: {
            code: DAEMON_SERVICE_ERROR_CODES.NOT_RUNNING,
            message: "Daemon is not running",
          },
        };
      }

      const { pid } = pidResult.value;

      // Send SIGTERM
      const signalSent = processControl.sendSignal(pid, "SIGTERM");
      if (!signalSent) {
        // Process may have already exited
        removePidFile(paths.pidFile, pidFileDeps);
        return { ok: true, value: undefined };
      }

      // Wait for graceful shutdown
      const exited = await processControl.waitForExit(
        pid,
        config.shutdownGraceMs,
      );

      if (!exited) {
        // Force kill
        processControl.sendSignal(pid, "SIGKILL");
        // Brief wait for SIGKILL
        await processControl.waitForExit(pid, 2000);
      }

      removePidFile(paths.pidFile, pidFileDeps);
      return { ok: true, value: undefined };
    },

    async restart() {
      // Stop if running (ignore errors — may not be running)
      const pidResult = validatePidFile(paths.pidFile, pidFileDeps);
      if (pidResult.ok) {
        await this.stop();
      }

      return this.start();
    },

    status() {
      const pidResult = validatePidFile(paths.pidFile, pidFileDeps);

      if (!pidResult.ok) {
        return {
          running: false,
          pid: null,
          startedAt: null,
          uptime: null,
        };
      }

      const record = pidResult.value;
      const uptimeMs = record.startedAt
        ? Date.now() - new Date(record.startedAt).getTime()
        : null;

      return {
        running: true,
        pid: record.pid,
        startedAt: record.startedAt,
        uptime: uptimeMs,
      };
    },
  };
}
