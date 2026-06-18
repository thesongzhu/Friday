import { isAbsolute, relative, resolve } from "node:path";
import type {
  FridayNodeExecutor,
  FridayNodeRunOptions,
  FridayNodeRunResult,
} from "./friday-skill-executor.types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

export const FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV =
  "FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS";

export const FRIDAY_UNISOLATED_NODE_SKILLS_TEST_HARNESS_ENV =
  "FRIDAY_UNISOLATED_NODE_SKILLS_TEST_HARNESS";

function isEnabledEnvValue(value: string | undefined): boolean {
  return typeof value === "string" && ENABLED_VALUES.has(value.trim().toLowerCase());
}

function isFridayNodeSkillTestHarness(env: NodeJS.ProcessEnv): boolean {
  return isEnabledEnvValue(env[FRIDAY_UNISOLATED_NODE_SKILLS_TEST_HARNESS_ENV])
    || isEnabledEnvValue(env.VITEST);
}

export function isFridayUnisolatedNodeSkillsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isEnabledEnvValue(env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV])
    && isFridayNodeSkillTestHarness(env);
}

export function getFridayUnisolatedNodeSkillsDisabledMessage(): string {
  return `Node-based skills are disabled in production because they execute in-process without OS isolation. ${FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV}=true is accepted only by the test harness.`;
}

export function canRunFridayBundledSystemNodeSkillWithoutGate(input: {
  runtimeKind?: string;
  manifestKind?: string;
  source?: string;
  origin?: string;
}): boolean {
  return input.runtimeKind === "node"
    && input.manifestKind === "system"
    && input.source === "bundled"
    && input.origin === "bundled";
}

/**
 * Creates a node executor that dynamically imports JS modules and calls their
 * exported `execute` function. Handles timeouts via `AbortSignal.timeout`.
 */
export function createFridayNodeExecutor(config?: {
  env?: NodeJS.ProcessEnv;
}): FridayNodeExecutor {
  return {
    async run(options: FridayNodeRunOptions): Promise<FridayNodeRunResult> {
      const startMs = Date.now();
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      if (!options.allowWithoutGate && !isFridayUnisolatedNodeSkillsEnabled(config?.env ?? process.env)) {
        return {
          output: {},
          timedOut: false,
          durationMs: Date.now() - startMs,
          error: getFridayUnisolatedNodeSkillsDisabledMessage(),
        };
      }

      const entrypoint = options.cwd
        ? resolve(options.cwd, options.entrypoint)
        : resolve(options.entrypoint);
      if (options.cwd) {
        const relativeEntrypoint = relative(options.cwd, entrypoint);
        if (relativeEntrypoint.startsWith("..") || isAbsolute(relativeEntrypoint)) {
          return {
            output: {},
            timedOut: false,
            durationMs: Date.now() - startMs,
            error: `Skill entrypoint '${options.entrypoint}' escapes the skill directory sandbox`,
          };
        }
      }

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

        // Build optional runtime context with AI helper plus readonly Friday services.
        const ctx = {
          ...(options.runtimeContext ?? {}),
          ...(options.aiHelper ? { ai: options.aiHelper } : {}),
        };
        const runtimeCtx = Object.keys(ctx).length > 0 ? ctx : undefined;

        // Race between execution, timeout, and external abort signal
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("__TIMEOUT__")), timeoutMs);
        });

        const racers: Promise<unknown>[] = [
          executeFn(options.input, runtimeCtx) as Promise<unknown>,
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
