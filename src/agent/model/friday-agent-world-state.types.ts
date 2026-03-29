/**
 * World Model Readiness — Type definitions for episodic memory,
 * world state representation, and learned patterns.
 *
 * These types form the foundation for Friday's evolution from
 * LLM-driven agent to personal World AI. Initial implementations
 * are transparent pass-throughs that don't alter existing behavior.
 */

// ─── Episode (structured action→observation trajectory) ─────────

export interface FridayEpisode {
  id: string;
  userId: string;
  runId: string;
  taskIntent: string;
  taskProfile?: string;
  outcome: FridayEpisodeOutcome;
  steps: FridayEpisodeStep[];
  toolSequence: string[];
  durationMs: number;
  contextFiles: string[];
  createdAt: string;
}

export type FridayEpisodeOutcome = "success" | "failure" | "partial";

export interface FridayEpisodeStep {
  seq: number;
  action: string;
  category: FridayEpisodeStepCategory;
  observation: string;
  durationMs: number;
}

export type FridayEpisodeStepCategory =
  | "read"
  | "write"
  | "query"
  | "mutate"
  | "navigate"
  | "other";

// ─── World State (structured user-world representation) ─────────

export interface FridayWorldState {
  userId: string;

  entities: FridayWorldEntity[];
  recentActions: FridayEpisodeStep[];
  activeGoals: string[];
  preferences: Record<string, unknown>;
  environmentFacts: Record<string, string>;

  /** Future world-model extension: latent embedding of the world state. */
  embedding?: number[];
  /** Future world-model extension: confidence in current state accuracy. */
  confidence?: number;

  lastUpdated: string;
}

export interface FridayWorldEntity {
  id: string;
  userId: string;
  type: FridayWorldEntityType;
  name: string;
  attributes: Record<string, unknown>;
  relations: FridayWorldEntityRelation[];
  lastMentioned: string;
  mentionCount: number;
}

export type FridayWorldEntityType =
  | "project"
  | "person"
  | "file"
  | "service"
  | "concept"
  | "schedule"
  | "habit";

export interface FridayWorldEntityRelation {
  targetId: string;
  relation: string;
}

// ─── Learned Pattern (extracted from episode trajectories) ───────

export interface FridayLearnedPattern {
  id: string;
  userId: string;
  kind: FridayLearnedPatternKind;
  description: string;
  pattern: Record<string, unknown>;
  confidence: number;
  sampleCount: number;
  lastUpdated: string;
  createdAt: string;
}

export type FridayLearnedPatternKind =
  | "tool_sequence"
  | "failure_mode"
  | "temporal"
  | "preference";
