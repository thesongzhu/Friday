/**
 * A-006 Workflow Playbook Bridge — integrates playbook selection on intake
 * and feedback recording on run completion.
 *
 * On workflow start: selects the best-matching playbook via the
 * PlaybookSelectorEngine and returns the match + execution plan.
 *
 * On workflow completion: records run outcome back to the learning engine
 * for candidate accumulation, score recalculation, and promotion evaluation.
 *
 * @module workflows/engine
 */

import type {
  FridayPlaybookCandidate,
  FridayPlaybookCandidateGenerator,
  FridayPlaybookCostDimensions,
  FridayPlaybookMatch,
  FridayPlaybookPromotionEngine,
  FridayPlaybookRunCompletionEvent,
  FridayPlaybookScore,
  FridayPlaybookScoreCalculator,
  FridayPlaybookSelector,
  FridayPlaybookSelectorEngine,
  FridayPromotionDecision,
  JsonValue,
  UUID,
} from "../../playbook/model/friday-playbook.types.js";

// ─── Bridge Types ───

export type PlaybookIntakeDecision = "matched" | "no_match" | "below_threshold" | "rules_denied" | "skipped";

export interface PlaybookIntakeResult {
  decision: PlaybookIntakeDecision;
  match: FridayPlaybookMatch | null;
  playbookId: UUID | null;
  versionNumber: number | null;
  matchScore: number | null;
  evaluatedAt: string;
}

export interface PlaybookFeedbackResult {
  candidate: FridayPlaybookCandidate | null;
  scoreRecalculated: boolean;
  promotionDecision: FridayPromotionDecision | null;
  updatedScore: FridayPlaybookScore | null;
  recordedAt: string;
}

export interface PlaybookBridgeTrace {
  runId: UUID;
  workflowId: UUID;
  phase: "intake" | "feedback";
  intakeResult?: PlaybookIntakeResult;
  feedbackResult?: PlaybookFeedbackResult;
  timestamp: string;
}

// ─── Dependencies ───

export interface WorkflowPlaybookBridgeDeps {
  /** Playbook selection engine. */
  selector: FridayPlaybookSelectorEngine;
  /** Learning engine for candidate generation. */
  learner: FridayPlaybookCandidateGenerator;
  /** Score calculator for recalculation on feedback. */
  scoreCalculator?: FridayPlaybookScoreCalculator;
  /** Promotion engine for promotion evaluation on feedback. */
  promotionEngine?: FridayPlaybookPromotionEngine;
  /** Whether playbook selection is enabled. Default: true. */
  enabled?: boolean;
  /** Callback on intake/feedback trace events. */
  onTrace?: (trace: PlaybookBridgeTrace) => void;
  /** Clock function. */
  nowIso?: () => string;
}

// ─── Interface ───

export interface FridayWorkflowPlaybookBridge {
  /** Select a playbook on workflow intake. */
  selectOnIntake(params: {
    runId: UUID;
    workflowId: UUID;
    workflowType: string;
    tags: string[];
    nodeSequence: Array<{ nodeType: string; adapterType?: string }>;
    metadata?: Record<string, unknown>;
  }): Promise<PlaybookIntakeResult>;

  /** Record run completion feedback for learning/promotion. */
  recordFeedback(event: FridayPlaybookRunCompletionEvent): Promise<PlaybookFeedbackResult>;

  /** Get all traces for a given run. */
  getTraces(runId: UUID): PlaybookBridgeTrace[];

  /** Check if the bridge is enabled. */
  isEnabled(): boolean;

  /** Clear all internal state. */
  reset(): void;
}

// ─── Factory ───

export function createWorkflowPlaybookBridge(
  deps: WorkflowPlaybookBridgeDeps,
): FridayWorkflowPlaybookBridge {
  const enabled = deps.enabled ?? true;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const traces: PlaybookBridgeTrace[] = [];

  return {
    async selectOnIntake(params) {
      const timestamp = nowIso();

      // If disabled, skip selection
      if (!enabled) {
        const result: PlaybookIntakeResult = {
          decision: "skipped",
          match: null,
          playbookId: null,
          versionNumber: null,
          matchScore: null,
          evaluatedAt: timestamp,
        };
        const trace: PlaybookBridgeTrace = {
          runId: params.runId,
          workflowId: params.workflowId,
          phase: "intake",
          intakeResult: result,
          timestamp,
        };
        traces.push(trace);
        deps.onTrace?.(trace);
        return result;
      }

      // Build selector context
      const selector: FridayPlaybookSelector = {
        workflowType: params.workflowType,
        workflowId: params.workflowId,
        runId: params.runId,
        nodeSequence: params.nodeSequence,
        tags: params.tags,
        metadata: params.metadata as Record<string, JsonValue> | undefined,
      };

      // Call playbook selector
      const match = await deps.selector.select(selector);

      const result: PlaybookIntakeResult = {
        decision: match.reason === "matched" ? "matched" : match.reason as PlaybookIntakeDecision,
        match,
        playbookId: match.playbookId,
        versionNumber: match.versionNumber,
        matchScore: match.matchScore,
        evaluatedAt: timestamp,
      };

      const trace: PlaybookBridgeTrace = {
        runId: params.runId,
        workflowId: params.workflowId,
        phase: "intake",
        intakeResult: result,
        timestamp,
      };
      traces.push(trace);
      deps.onTrace?.(trace);
      return result;
    },

    async recordFeedback(event) {
      const timestamp = nowIso();

      // Always record via learning engine
      const candidate = await deps.learner.processCompletedRun(event);

      let scoreRecalculated = false;
      let updatedScore: FridayPlaybookScore | null = null;
      let promotionDecision: FridayPromotionDecision | null = null;

      // If a candidate was produced or updated, recalculate score and evaluate promotion
      if (candidate) {
        // Recalculate score if calculator available and candidate is promoted
        if (deps.scoreCalculator && candidate.promotedPlaybookId) {
          updatedScore = await deps.scoreCalculator.recalculate(candidate.promotedPlaybookId);
          scoreRecalculated = true;
        }

        // Evaluate promotion if engine available and candidate is pending
        if (deps.promotionEngine && candidate.status === "pending") {
          promotionDecision = await deps.promotionEngine.evaluate(candidate.id);
        }
      }

      const result: PlaybookFeedbackResult = {
        candidate,
        scoreRecalculated,
        promotionDecision,
        updatedScore,
        recordedAt: timestamp,
      };

      const trace: PlaybookBridgeTrace = {
        runId: event.runId,
        workflowId: event.workflowId,
        phase: "feedback",
        feedbackResult: result,
        timestamp,
      };
      traces.push(trace);
      deps.onTrace?.(trace);
      return result;
    },

    getTraces(runId) {
      return traces.filter((t) => t.runId === runId);
    },

    isEnabled() {
      return enabled;
    },

    reset() {
      traces.length = 0;
    },
  };
}
