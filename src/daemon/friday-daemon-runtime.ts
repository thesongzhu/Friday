import { spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveFridayDaemonPaths } from "./friday-daemon-paths.js";
import { createFridayDaemonService } from "./friday-daemon-service.js";
import type { FridayDaemonService } from "./friday-daemon-service.js";
import type { FridayDaemonStatus } from "./friday-daemon.types.js";

export interface FridayDaemonLaunchSpec {
  readonly repoRoot: string;
  readonly runnerPath: string;
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface ResolveFridayDaemonLaunchSpecInput {
  readonly moduleUrl: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly command?: string;
}

export interface CreateFridayLocalDaemonServiceInput {
  readonly moduleUrl: string;
  readonly stateDir: string;
  readonly version?: string;
  readonly shutdownGraceMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly command?: string;
}

export function resolveFridayRepoRootFromModuleUrl(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "..", "..");
}

export function resolveFridayDaemonLaunchSpec(
  input: ResolveFridayDaemonLaunchSpecInput,
): FridayDaemonLaunchSpec {
  const repoRoot = resolveFridayRepoRootFromModuleUrl(input.moduleUrl);
  const runnerPath = join(repoRoot, "scripts", "ops", "friday-service-run.sh");

  return {
    repoRoot,
    runnerPath,
    command: input.command ?? "bash",
    args: [runnerPath, repoRoot],
    cwd: repoRoot,
    env: input.env ?? process.env,
  };
}

export function formatFridayDaemonStatus(status: FridayDaemonStatus): string {
  if (status.running) {
    const uptimeStr = status.uptime !== null
      ? `${String(Math.floor(status.uptime / 1000))}s`
      : "unknown";
    return `Friday daemon: running (PID ${String(status.pid)}, uptime ${uptimeStr})`;
  }
  return "Friday daemon: stopped";
}

export function createFridayLocalDaemonService(
  input: CreateFridayLocalDaemonServiceInput,
): FridayDaemonService {
  const paths = resolveFridayDaemonPaths(input.stateDir);
  mkdirSync(paths.runtimeDir, { recursive: true });

  const launchSpec = resolveFridayDaemonLaunchSpec({
    moduleUrl: input.moduleUrl,
    env: input.env,
    command: input.command,
  });

  return createFridayDaemonService({
    config: {
      paths,
      shutdownGraceMs: input.shutdownGraceMs ?? 5000,
      version: input.version,
    },
    pidFileDeps: {
      readFile: (filePath: string) => {
        try {
          return readFileSync(filePath, "utf-8");
        } catch {
          return null;
        }
      },
      writeFile: (filePath: string, content: string) => {
        writeFileSync(filePath, content, "utf-8");
      },
      removeFile: (filePath: string) => {
        try {
          unlinkSync(filePath);
        } catch {
          // Ignore if the file is already gone.
        }
      },
      mkdirp: (dirPath: string) => {
        mkdirSync(dirPath, { recursive: true });
      },
      isProcessAlive: (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
      nowIso: () => new Date().toISOString(),
    },
    processControl: {
      spawnDaemon: (stdoutLog: string, stderrLog: string) => {
        let stdoutFd: number | undefined;
        let stderrFd: number | undefined;
        try {
          stdoutFd = openSync(stdoutLog, "a");
          stderrFd = openSync(stderrLog, "a");
          const child = spawn(launchSpec.command, launchSpec.args, {
            detached: true,
            stdio: ["ignore", stdoutFd, stderrFd],
            env: launchSpec.env,
            cwd: launchSpec.cwd,
          });
          child.unref();
          const pid = child.pid;
          if (pid === undefined) {
            return {
              ok: false as const,
              error: { code: "SPAWN_FAILED", message: "Failed to obtain child PID" },
            };
          }
          return { ok: true as const, value: { pid } };
        } catch (err) {
          return {
            ok: false as const,
            error: {
              code: "SPAWN_FAILED",
              message: err instanceof Error ? err.message : String(err),
            },
          };
        } finally {
          if (typeof stdoutFd === "number") {
            closeSync(stdoutFd);
          }
          if (typeof stderrFd === "number") {
            closeSync(stderrFd);
          }
        }
      },
      sendSignal: (pid: number, signal: "SIGTERM" | "SIGKILL") => {
        try {
          process.kill(pid, signal);
          return true;
        } catch {
          return false;
        }
      },
      waitForExit: async (pid: number, timeoutMs: number) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          try {
            process.kill(pid, 0);
          } catch {
            return true;
          }
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
        }
        return false;
      },
    },
  });
}
