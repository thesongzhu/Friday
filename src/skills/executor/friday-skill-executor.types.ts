import type { FridaySqliteLayer } from "#state";
import type { FridaySkillRunStore } from "#ledger";
import type { FridayBrowserManager } from "#browser";
import type {
  FridayChannelCapabilityContract,
  FridayChannelRegistry,
  FridayChannelStatus,
} from "#channels";
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

export interface FridaySkillReadonlySystemContext {
  getSnapshot(): Promise<Record<string, unknown>>;
}

export interface FridaySkillReadonlyDiagnosisContext {
  listIssueCards(limit?: number): Promise<Record<string, unknown>[]>;
  listIncidents(limit?: number): Promise<Record<string, unknown>[]>;
  getIncident(incidentId: string): Promise<Record<string, unknown> | null>;
}

export interface FridaySkillReadonlyAutofixContext {
  listActions(limit?: number, status?: string): Promise<Record<string, unknown>[]>;
  getAction(actionId: string): Promise<Record<string, unknown> | null>;
}

export interface FridaySkillReadonlyBrowserInspectOptions {
  url: string;
  sessionId?: string;
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  timeoutMs?: number;
  screenshotName?: string;
  viewport?: {
    width: number;
    height: number;
  };
}

export interface FridaySkillReadonlyBrowserInspection {
  sessionId: string;
  tabId: string;
  title: string;
  finalUrl: string;
  requestedUrl: string;
  status: number | null;
  snapshot: string;
  screenshotPath: string | null;
  consoleErrors: Array<{ type: string; text: string }>;
  consoleWarnings: Array<{ type: string; text: string }>;
  pageErrors: string[];
  requestFailures: Array<{ url: string; method: string; failureText: string | null }>;
  timings: {
    domContentLoadedMs: number | null;
    loadMs: number | null;
  };
}

export interface FridaySkillReadonlyBrowserContext {
  inspectPage(
    input: FridaySkillReadonlyBrowserInspectOptions,
  ): Promise<FridaySkillReadonlyBrowserInspection>;
  closeSession(sessionId: string): Promise<void>;
}

export interface FridaySkillReadonlyChannelView {
  kind: string;
  running: boolean;
  status: FridayChannelStatus;
  diagnostics?: Record<string, unknown>;
  contract?: FridayChannelCapabilityContract;
  allowlist: {
    hasAllowedUsers: boolean;
    allowedUsersCount: number;
    hasAllowedChats: boolean;
    allowedChatsCount: number;
  };
}

export interface FridaySkillReadonlyChannelsContext {
  listChannels(): Promise<FridaySkillReadonlyChannelView[]>;
  getChannel(kind: string): Promise<FridaySkillReadonlyChannelView | null>;
}

export interface FridaySkillNodeRuntimeContext {
  ai?: FridaySkillAiHelperContext;
  system?: FridaySkillReadonlySystemContext;
  diagnosis?: FridaySkillReadonlyDiagnosisContext;
  autofix?: FridaySkillReadonlyAutofixContext;
  browser?: FridaySkillReadonlyBrowserContext;
  channels?: FridaySkillReadonlyChannelsContext;
}

export interface FridaySkillReadonlySystemServiceLike {
  getState(): Promise<unknown>;
}

export interface FridaySkillReadonlySelfHealingServiceLike {
  listIssueCards(input: { userId: string; limit?: number }): unknown[];
  listIncidents(input: { userId: string; limit?: number }): unknown[];
  getIncident(input: { incidentId: string }): unknown | null;
  listActions(input: { userId: string; status?: string; limit?: number }): unknown[];
  getAction(input: { actionId: string }): unknown | null;
}

export interface FridayNodeRunOptions {
  entrypoint: string;
  input: Record<string, unknown>;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  aiHelper?: FridaySkillAiHelperContext;
  runtimeContext?: Omit<FridaySkillNodeRuntimeContext, "ai">;
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
  getSystemService?: () => FridaySkillReadonlySystemServiceLike | undefined;
  getSelfHealingService?: () => FridaySkillReadonlySelfHealingServiceLike | undefined;
  getBrowserManager?: () => FridayBrowserManager | undefined;
  getChannelRegistry?: () => FridayChannelRegistry | undefined;
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
