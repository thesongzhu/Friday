import { spawn } from "node:child_process";
import type {
  FridayShellExecutor,
  FridayShellRunOptions,
  FridayShellRunResult,
} from "./friday-skill-executor.types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 500;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const SAFE_PARENT_ENV_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USER",
  "LOGNAME",
  "PWD",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "WINDIR",
] as const;

function buildChildEnv(overrides?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_PARENT_ENV_KEYS) {
    const value = process.env[key];
    if (value != null) {
      env[key] = value;
    }
  }
  return overrides ? { ...env, ...overrides } : env;
}

function createBoundedOutputCollector(streamName: "stdout" | "stderr", maxBytes: number = DEFAULT_MAX_OUTPUT_BYTES) {
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let discardedBytes = 0;

  return {
    append(chunk: Buffer | string): void {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remainingBytes = maxBytes - capturedBytes;
      if (remainingBytes > 0) {
        const captured = buffer.subarray(0, remainingBytes);
        chunks.push(captured);
        capturedBytes += captured.length;
      }
      if (buffer.length > remainingBytes) {
        discardedBytes += buffer.length - Math.max(remainingBytes, 0);
      }
    },
    toString(): string {
      const output = Buffer.concat(chunks).toString("utf-8");
      if (discardedBytes === 0) {
        return output;
      }
      const separator = output.length === 0 || output.endsWith("\n") ? "" : "\n";
      return `${output}${separator}[friday] ${streamName} truncated after ${String(maxBytes)} bytes; discarded ${String(discardedBytes)} bytes.`;
    },
  };
}

/**
 * Creates a shell executor that spawns child processes and captures output.
 * Uses `child_process.spawn` for streaming; never throws on process failure.
 */
export function createFridayShellExecutor(): FridayShellExecutor {
  return {
    run(options: FridayShellRunOptions): Promise<FridayShellRunResult> {
      return new Promise<FridayShellRunResult>((resolve) => {
        const startMs = Date.now();
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

        const stdout = createBoundedOutputCollector("stdout");
        const stderr = createBoundedOutputCollector("stderr");
        let timedOut = false;
        let cancelled = false;
        let settled = false;
        let terminationFallbackTimer: NodeJS.Timeout | null = null;

        const child = spawn(options.command, options.args ?? [], {
          cwd: options.cwd,
          env: buildChildEnv(options.env),
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        });

        const killProcessGroup = () => {
          try {
            if (child.pid != null) {
              process.kill(-child.pid, "SIGKILL");
            }
          } catch (err) {
            console.warn("[friday][shell-executor] operation failed:", err instanceof Error ? err.message : String(err));
            // Process may already be gone
            child.kill("SIGKILL");
          }
        };

        const armTerminationFallback = () => {
          if (terminationFallbackTimer || settled) {
            return;
          }
          terminationFallbackTimer = setTimeout(() => {
            finish(null);
          }, TERMINATION_GRACE_MS);
        };

        const killAndFallback = () => {
          killProcessGroup();
          armTerminationFallback();
        };

        const onAbort = () => {
          if (!settled) {
            cancelled = true;
            killAndFallback();
          }
        };

        // EPIPE/EIO/ERR_STREAM_DESTROYED can occur when child exits before stdin write completes.
        const isIgnorableStdinError = (err: unknown): boolean => {
          const code = (err as NodeJS.ErrnoException | undefined)?.code;
          return code === "EPIPE" || code === "EIO" || code === "ERR_STREAM_DESTROYED";
        };

        const onStdinError = (err: unknown) => {
          if (!isIgnorableStdinError(err)) {
            stderr.append(err instanceof Error ? err.message : String(err));
          }
        };

        child.stdin.on("error", onStdinError);

        const safeEndStdin = () => {
          if (child.stdin.destroyed || child.stdin.writableEnded) return;
          try {
            child.stdin.end();
          } catch (err) {
            if (!isIgnorableStdinError(err)) {
              stderr.append(err instanceof Error ? err.message : String(err));
            }
          }
        };

        if (options.stdin != null) {
          try {
            child.stdin.write(options.stdin, (writeErr) => {
              if (writeErr && !isIgnorableStdinError(writeErr)) {
                stderr.append(writeErr.message);
              }
              safeEndStdin();
            });
          } catch (err) {
            if (!isIgnorableStdinError(err)) {
              stderr.append(err instanceof Error ? err.message : String(err));
            }
            safeEndStdin();
          }
        } else {
          safeEndStdin();
        }

        child.stdout.on("data", (chunk: Buffer) => {
          stdout.append(chunk);
        });

        child.stderr.on("data", (chunk: Buffer) => {
          stderr.append(chunk);
        });

        const timer = setTimeout(() => {
          if (!settled) {
            timedOut = true;
            killAndFallback();
          }
        }, timeoutMs);

        const finish = (exitCode: number | null) => {
          if (settled) return;
          settled = true;
          child.stdin.off("error", onStdinError);
          clearTimeout(timer);
          if (terminationFallbackTimer) {
            clearTimeout(terminationFallbackTimer);
            terminationFallbackTimer = null;
          }
          if (options.signal) {
            options.signal.removeEventListener("abort", onAbort);
          }

          resolve({
            exitCode: exitCode ?? (timedOut ? 124 : cancelled ? 125 : 1),
            stdout: stdout.toString(),
            stderr: stderr.toString(),
            timedOut,
            cancelled,
            durationMs: Date.now() - startMs,
          });
        };

        child.on("close", (code) => {
          finish(code);
        });

        child.on("error", (err) => {
          // Spawn itself failed (e.g. command not found)
          stderr.append(err.message);
          finish(1);
        });

        if (options.signal) {
          if (options.signal.aborted) {
            onAbort();
          } else {
            options.signal.addEventListener("abort", onAbort, { once: true });
          }
        }
      });
    },
  };
}
