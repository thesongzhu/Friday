import type { SkillManifestV2 } from "./friday-skill-manifest-v2.types.js";

export type SkillRunStatus =
  | "running"
  | "waiting_for_user"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type SkillRunState<TState> = {
  runId: string;
  skillId: string;
  version: string;
  status: SkillRunStatus;
  currentStepId: string;
  attemptsByStep: Record<string, number>;
  state: TState;
  startedAt: string;
  updatedAt: string;
};

export type SkillInitContext<TInput> = {
  input: TInput;
  sessionId: string;
  userId: string;
  channel: string;
  nowIso: string;
};

export type ToolRequestItem = {
  requestId: string;
  tool: string;
  args: Record<string, unknown>;
};

export type ToolResultItem = {
  requestId: string;
  tool: string;
  ok: boolean;
  payload: unknown;
};

export type SkillExecuteContext<TInput, TState> = {
  input: TInput;
  run: SkillRunState<TState>;
  userMessage?: string;
  toolResults?: ToolResultItem[];
};

export type SkillExecutionResult<TState, TOutput> = {
  run: SkillRunState<TState>;
  messages: Array<{ role: "assistant" | "system"; text: string }>;
  requestedTools?: ToolRequestItem[];
  output?: TOutput;
};

export type SkillTeardownContext<TState> = {
  run: SkillRunState<TState>;
  reason: "completed" | "failed" | "cancelled";
};

export interface FridaySkill<TInput, TState, TOutput> {
  manifest: SkillManifestV2;
  init(ctx: SkillInitContext<TInput>): Promise<SkillRunState<TState>>;
  execute(ctx: SkillExecuteContext<TInput, TState>): Promise<SkillExecutionResult<TState, TOutput>>;
  teardown(ctx: SkillTeardownContext<TState>): Promise<void>;
}
