/**
 * Production Learning Loop — Composite factory that wires all playbook
 * engine components into a single production-ready learning loop.
 *
 * Implements the full A-006 activation checklist:
 * 1. Playbook entities persisted in SQLite (via store dependency)
 * 2. Matcher invoked during planning/start-run (via `selectPlaybook`)
 * 3. Selection and score trajectory recorded per run
 * 4. Success/failure telemetry ingested into learning engine
 * 5. Promoter job runs on schedule and persists decisions
 *
 * @module playbook/engine
 */

import type { PlaybookStore } from "./playbook-store.js";
import type { PromoterJobRunner, PromotionKpiSnapshot } from "./promoter-job.js";
import type { VersionManager } from "./version-manager.js";

import { createLearningEngine } from "./learning-engine.js";
import { createPlaybookMatcher } from "./playbook-matcher.js";
import { createPromotionEngine, createScoreCalculator } from "./feedback-loop.js";
import { createVersionManager } from "./version-manager.js";
import { createPromoterJobRunner } from "./promoter-job.js";

import type {
  FridayPlaybookCandidate,
  FridayPlaybookCandidateGenerator,
  FridayPlaybookEngineConfig,
  FridayPlaybookMatch,
  FridayPlaybookPromotionEngine,
  FridayPlaybookRunCompletionEvent,
  FridayPlaybookScore,
  FridayPlaybookScoreCalculator,
  FridayPlaybookScoreConfig,
  FridayPlaybookSelectionConfig,
  FridayPlaybookSelector,
  FridayPlaybookSelectorEngine,
  FridayPromotionConfig,
  ISODateTime,
  UUID,
} from "../model/friday-playbook.types.js";

import {
  FRIDAY_DEFAULT_PROMOTION_RULES,
  FRIDAY_PLAYBOOK_SCORE_DECAY_RATE,
  FRIDAY_PLAYBOOK_SCORE_DIMENSION_WEIGHTS,
  FRIDAY_PLAYBOOK_TIE_BREAK_ORDER,
} from "../model/friday-playbook.types.js";

// ─── Dependencies ───

export interface CreatePlaybookLearningLoopDeps {
  /** Playbook store (in-memory or SQLite-backed). */
  store: PlaybookStore;
  /** Generate a new UUID. */
  generateId: () => UUID;
  /** Get current ISO timestamp. */
  nowIso: () => ISODateTime;
  /** KPI supplier for promotion gating. */
  getKpis: () => PromotionKpiSnapshot | Promise<PromotionKpiSnapshot>;
  /** Optional error handler for the promoter job. */
  onError?: (error: unknown) => void | Promise<void>;
  /** Override scoring configuration. */
  scoringConfig?: Partial<FridayPlaybookScoreConfig>;
  /** Override selection configuration. */
  selectionConfig?: Partial<FridayPlaybookSelectionConfig>;
  /** Override promotion configuration. */
  promotionConfig?: Partial<FridayPromotionConfig>;
}

// ─── Learning Loop Interface ───

export interface PlaybookLearningLoop {
  /** Select a playbook for a given workflow run context. Records match. */
  selectPlaybook: (selector: FridayPlaybookSelector) => Promise<FridayPlaybookMatch>;
  /** Ingest a completed run into the learning engine. */
  ingestRunCompletion: (event: FridayPlaybookRunCompletionEvent) => Promise<FridayPlaybookCandidate | null>;
  /** Recalculate score for a specific playbook. */
  recalculateScore: (playbookId: UUID) => Promise<FridayPlaybookScore>;
  /** Recalculate scores for all active playbooks. */
  recalculateAllScores: () => Promise<FridayPlaybookScore[]>;
  /** Start the promoter job on a periodic interval. Returns stop handle. */
  startPromoterJob: (intervalMs: number) => { stop: () => void; isRunning: () => boolean };
  /** Run a single promoter tick (for testing or manual invocation). */
  tickPromoter: (idempotencyKey?: string) => ReturnType<PromoterJobRunner["tick"]>;

  /** Expose underlying components for direct access. */
  readonly store: PlaybookStore;
  readonly learningEngine: FridayPlaybookCandidateGenerator;
  readonly matcher: FridayPlaybookSelectorEngine;
  readonly scoreCalculator: FridayPlaybookScoreCalculator;
  readonly promotionEngine: FridayPlaybookPromotionEngine;
  readonly versionManager: VersionManager;
  readonly promoterJob: PromoterJobRunner;
}

// ─── Default Configuration ───

function buildDefaultConfig(
  deps: CreatePlaybookLearningLoopDeps,
): FridayPlaybookEngineConfig {
  const scoring: FridayPlaybookScoreConfig = {
    weights: { ...FRIDAY_PLAYBOOK_SCORE_DIMENSION_WEIGHTS },
    decayRate: FRIDAY_PLAYBOOK_SCORE_DECAY_RATE,
    autoArchiveDays: 90,
    minSampleSize: 5,
    ...deps.scoringConfig,
  };

  const selection: FridayPlaybookSelectionConfig = {
    matchThreshold: 0.60,
    similarityWeight: 0.60,
    scoreWeight: 0.40,
    minTagOverlap: 0.50,
    maxCandidates: 50,
    tieBreakOrder: [...FRIDAY_PLAYBOOK_TIE_BREAK_ORDER],
    ...deps.selectionConfig,
  };

  const promotion: FridayPromotionConfig = {
    rules: [...FRIDAY_DEFAULT_PROMOTION_RULES],
    evaluationIntervalHours: 6,
    rollbackConsecutiveWindows: 3,
    rollbackSuccessRateThreshold: 0.50,
    ...deps.promotionConfig,
  };

  return {
    scoring,
    selection,
    promotion,
    generateId: deps.generateId,
    nowIso: deps.nowIso,
  };
}

// ─── Factory ───

/**
 * Create a fully wired playbook learning loop.
 *
 * Composes all engine components with a shared store and configuration,
 * returning a unified interface for selection, ingestion, scoring,
 * and promotion.
 */
export function createPlaybookLearningLoop(
  deps: CreatePlaybookLearningLoopDeps,
): PlaybookLearningLoop {
  const { store, getKpis, onError } = deps;
  const config = buildDefaultConfig(deps);

  // Wire engine components
  const learningEngine = createLearningEngine({ store, config });
  const matcher = createPlaybookMatcher({ store, config });
  const scoreCalculator = createScoreCalculator({ store, config });
  const promotionEngine = createPromotionEngine({ store, config });
  const versionManager = createVersionManager({ store, config });
  const promoterJob = createPromoterJobRunner({
    store,
    promotionEngine,
    versionManager,
    getKpis,
    nowIso: () => config.nowIso() as string,
    onError,
  });

  return {
    store,
    learningEngine,
    matcher,
    scoreCalculator,
    promotionEngine,
    versionManager,
    promoterJob,

    async selectPlaybook(selector) {
      const match = await matcher.select(selector);
      // Always persist the selection record for analytics
      store.saveMatch(match);

      // Update playbook usage stats if matched
      if (match.playbookId) {
        const playbook = store.getPlaybook(match.playbookId);
        if (playbook) {
          playbook.totalUses += 1;
          playbook.lastUsedAt = config.nowIso();
          playbook.updatedAt = config.nowIso();
          store.savePlaybook(playbook);
        }
      }

      return match;
    },

    async ingestRunCompletion(event) {
      // 1. Ingest into learning engine (creates/updates candidates)
      const candidate = await learningEngine.processCompletedRun(event);

      // 2. Update playbook success stats if a selection existed for this run
      const selections = store.getMatchesByRunId(event.runId);
      for (const sel of selections) {
        if (sel.playbookId && event.success) {
          const playbook = store.getPlaybook(sel.playbookId);
          if (playbook) {
            playbook.totalSuccesses += 1;
            playbook.lastSuccessfulAt = event.completedAt;
            playbook.updatedAt = config.nowIso();
            store.savePlaybook(playbook);
          }
        }
      }

      // 3. Recalculate scores for matched playbooks
      for (const sel of selections) {
        if (sel.playbookId) {
          try {
            await scoreCalculator.recalculate(sel.playbookId);
          } catch {
            // Score recalculation failure is non-fatal
          }
        }
      }

      return candidate;
    },

    async recalculateScore(playbookId) {
      return scoreCalculator.recalculate(playbookId);
    },

    async recalculateAllScores() {
      return scoreCalculator.recalculateAll();
    },

    startPromoterJob(intervalMs) {
      return promoterJob.start(intervalMs);
    },

    tickPromoter(idempotencyKey?) {
      return promoterJob.tick(idempotencyKey ? { idempotencyKey } : undefined);
    },
  };
}
