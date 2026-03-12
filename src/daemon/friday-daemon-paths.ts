/**
 * Daemon Paths — Resolves runtime file paths for the daemon.
 *
 * @module daemon/friday-daemon-paths
 */

import { join } from "node:path";
import type { FridayDaemonRuntimePaths } from "./friday-daemon.types.js";

/**
 * Resolves daemon runtime paths relative to a state directory.
 *
 * Creates a deterministic layout:
 * ```
 * {stateDir}/daemon/
 *   friday.pid
 *   stdout.log
 *   stderr.log
 * ```
 */
export function resolveFridayDaemonPaths(stateDir: string): FridayDaemonRuntimePaths {
  const runtimeDir = join(stateDir, "daemon");
  return {
    runtimeDir,
    pidFile: join(runtimeDir, "friday.pid"),
    stdoutLog: join(runtimeDir, "stdout.log"),
    stderrLog: join(runtimeDir, "stderr.log"),
  };
}
