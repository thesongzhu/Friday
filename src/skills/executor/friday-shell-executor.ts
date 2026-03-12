import { spawn } from "node:child_process";
import type {
  FridayShellExecutor,
  FridayShellRunOptions,
  FridayShellRunResult,
} from "./friday-skill-executor.types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 500;

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

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let timedOut = false;
        let cancelled = false;
        let settled = false;
        let terminationFallbackTimer: NodeJS.Timeout | null = null;

        const child = spawn(options.command, options.args ?? [], {
          cwd: options.cwd,
          env: options.env
            ? { ...process.env, ...options.env }
            : process.env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        });

        const killProcessGroup = () => {
          try {
            if (child.pid != null) {
              process.kill(-child.pid, "SIGKILL");
            }
          } catch {
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
            stderrChunks.push(Buffer.from(err instanceof Error ? err.message : String(err)));
          }
        };

        child.stdin.on("error", onStdinError);

        const safeEndStdin = () => {
          if (child.stdin.destroyed || child.stdin.writableEnded) return;
          try {
            child.stdin.end();
          } catch (err) {
            if (!isIgnorableStdinError(err)) {
              stderrChunks.push(Buffer.from(err instanceof Error ? err.message : String(err)));
            }
          }
        };

        if (options.stdin != null) {
          try {
            child.stdin.write(options.stdin, (writeErr) => {
              if (writeErr && !isIgnorableStdinError(writeErr)) {
                stderrChunks.push(Buffer.from(writeErr.message));
              }
              safeEndStdin();
            });
          } catch (err) {
            if (!isIgnorableStdinError(err)) {
              stderrChunks.push(Buffer.from(err instanceof Error ? err.message : String(err)));
            }
            safeEndStdin();
          }
        } else {
          safeEndStdin();
        }

        child.stdout.on("data", (chunk: Buffer) => {
          stdoutChunks.push(chunk);
        });

        child.stderr.on("data", (chunk: Buffer) => {
          stderrChunks.push(chunk);
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
            stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
            stderr: Buffer.concat(stderrChunks).toString("utf-8"),
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
          stderrChunks.push(Buffer.from(err.message));
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
