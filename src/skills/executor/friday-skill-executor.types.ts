import type { FridaySqliteLayer } from "#state";
import type { FridaySkillRunStore } from "#ledger";
import type { FridaySkillRegistry } from "../registry/friday-skill-registry.types.js";

// ─── Shell executor types ───

export interface FridayShellRunOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
  signal?: AbortSignal;
}

export interface FridayShellRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

export interface FridayShellExecutor {
  run(options: FridayShellRunOptions): Promise<FridayShellRunResult>;
}

// ─── Node executor types ───

/**
 * Optional AI helper context that can be provided to node-based skills
 * for BYOK AI inference at runtime.
 */
export interface FridaySkillAiHelperContext {
  /** Sends a prompt to the configured provider and returns the response text. */
  infer(prompt: string, requestedModel?: string): Promise<string>;
}

export interface FridayNodeRunOptions {
  entrypoint: string;
  input: Record<string, unknown>;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  aiHelper?: FridaySkillAiHelperContext;
}

export interface FridayNodeRunResult {
  output: Record<string, unknown>;
  timedOut: boolean;
  durationMs: number;
  error?: string;
}

export interface FridayNodeExecutor {
  run(options: FridayNodeRunOptions): Promise<FridayNodeRunResult>;
}

// ─── Skill executor types ───

export interface FridaySkillExecuteRequest {
  skillId: string;
  input: Record<string, unknown>;
  sessionId: string;
  userId: string;
  channel: string;
  timeoutMs?: number;
}

export type FridaySkillExecuteStatus = "completed" | "failed" | "cancelled" | "timeout";

export interface FridaySkillExecuteResult {
  runId: string;
  status: FridaySkillExecuteStatus;
  output: Record<string, unknown>;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface FridaySkillExecuteHandle {
  runId: string;
  result: Promise<FridaySkillExecuteResult>;
}

export interface FridaySkillExecutor {
  execute(request: FridaySkillExecuteRequest): FridaySkillExecuteHandle;
  cancel(runId: string): void;
}

export interface CreateFridaySkillExecutorDeps {
  db: FridaySqliteLayer;
  registry: FridaySkillRegistry;
  runStore: FridaySkillRunStore;
  idGenerator: () => string;
  nowIso: () => string;
  providerService?: FridayProviderServiceLike;
}

/**
 * Lightweight interface for the provider service dependency.
 * Avoids circular #providers import by defining only the method needed.
 */
export interface FridayProviderServiceLike {
  runWithFallback<T>(params: {
    requestedModel?: string;
    run: (
      route: { provider: { kind: string; baseUrl: string; config: { api: string } }; model: string },
      credential: string | null,
    ) => Promise<T>;
  }): Promise<{
    result: T;
    route: { provider: { kind: string }; model: string };
    attempts: Array<{ providerId: string; model: string; error?: string }>;
  }>;
}
