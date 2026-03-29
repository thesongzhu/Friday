/**
 * Decision Engine — pluggable interface for action selection.
 *
 * Current default: all decisions defer to LLM (transparent pass-through).
 * Future: world-model-based local decisions, tool ranking, outcome prediction.
 */

import type { FridayAgentToolDefinition } from "../model/friday-agent.types.js";
import type { FridayEpisodeStep, FridayWorldState } from "../model/friday-agent-world-state.types.js";

// ─── Decision Engine Interface ──────────────────────────────────

export interface FridayDecisionEngine {
  /** Can the engine decide without calling the LLM? */
  canDecideLocally(context: FridayDecisionContext): boolean;

  /** Produce a local decision (only called when canDecideLocally returns true). */
  decideLocally(context: FridayDecisionContext): Promise<FridayLocalDecision>;

  /** Rank/filter tools to reduce schema size sent to LLM. */
  rankTools(
    context: FridayDecisionContext,
    tools: FridayAgentToolDefinition[],
  ): FridayAgentToolDefinition[];

  /** Predict the outcome of an action before executing it (future). */
  predictOutcome?(
    action: string,
    args: Record<string, unknown>,
  ): Promise<FridayOutcomePrediction>;
}

// ─── Supporting Types ───────────────────────────────────────────

export interface FridayDecisionContext {
  task: string;
  turnIndex: number;
  history: FridayEpisodeStep[];
  worldState?: FridayWorldState;
  availableTools: string[];
  taskProfile?: string;
}

export interface FridayLocalDecision {
  action: "use_tool" | "respond" | "delegate" | "defer_to_llm";
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  response?: string;
  confidence: number;
  reason?: string;
}

export interface FridayOutcomePrediction {
  predictedOutcome: "success" | "failure" | "uncertain";
  confidence: number;
  explanation?: string;
}
