import type { SkillRunState, SkillRunStatus } from "#skills";

export interface FridaySkillRunSnapshot<TState = unknown> extends SkillRunState<TState> {
  sessionId: string;
  userId: string;
  channel: string;
  lastTransitionAt: string;
  metadata?: Record<string, unknown>;
}

export interface FridaySkillRunListInput {
  skillId?: string;
  status?: SkillRunStatus;
  userId?: string;
  limit?: number;
}
