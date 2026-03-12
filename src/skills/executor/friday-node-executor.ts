import { resolve } from "node:path";
import type {
  FridayNodeExecutor,
  FridayNodeRunOptions,
  FridayNodeRunResult,
} from "./friday-skill-executor.types.js";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Creates a node executor that dynamically imports JS modules and calls their
 * exported `execute` function. Handles timeouts via `AbortSignal.timeout`.
 */
export function createFridayNodeExecutor(): FridayNodeExecutor {
  return {
    async run(options: FridayNodeRunOptions): Promise<FridayNodeRunResult> {
      const startMs = Date.now();
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      const entrypoint = options.cwd
        ? resolve(options.cwd, options.entrypoint)
        : resolve(options.entrypoint);

      try {
        // Dynamic import of the skill module
        const mod: Record<string, unknown> = await import(entrypoint);

        const executeFn = mod["execute"] ?? mod["default"];
        if (typeof executeFn !== "function") {
          return {
            output: {},
            timedOut: false,
            durationMs: Date.now() - startMs,
            error: `Module '${options.entrypoint}' does not export an 'execute' or 'default' function`,
          };
        }

        // Build optional runtime context with AI helper
        const ctx = options.aiHelper ? { ai: options.aiHelper } : undefined;

        // Race between execution, timeout, and external abort signal
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("__TIMEOUT__")), timeoutMs);
        });

        const racers: Promise<unknown>[] = [
          executeFn(options.input, ctx) as Promise<unknown>,
          timeoutPromise,
        ];

        // If an external abort signal is provided, race against it too
        if (options.signal) {
          racers.push(
            new Promise<never>((_, reject) => {
              if (options.signal!.aborted) {
                reject(new Error("__CANCELLED__"));
              } else {
                options.signal!.addEventListener(
                  "abort",
                  () => reject(new Error("__CANCELLED__")),
                  { once: true },
                );
              }
            }),
          );
        }

        let result: unknown;
        try {
          result = await Promise.race(racers);
        } finally {
          // Issue 3 fix: always clear the timer to prevent leaks
          clearTimeout(timer);
        }

        const output =
          result != null && typeof result === "object" && !Array.isArray(result)
            ? (result as Record<string, unknown>)
            : { result };

        return {
          output,
          timedOut: false,
          durationMs: Date.now() - startMs,
        };
      } catch (err) {
        const isTimeout =
          err instanceof Error && err.message === "__TIMEOUT__";
        const isCancelled =
          err instanceof Error && err.message === "__CANCELLED__";

        return {
          output: {},
          timedOut: isTimeout,
          durationMs: Date.now() - startMs,
          error: isTimeout
            ? `Node execution timed out after ${timeoutMs}ms`
            : isCancelled
              ? "Execution cancelled"
              : err instanceof Error
                ? err.message
                : String(err),
        };
      }
    },
  };
}
