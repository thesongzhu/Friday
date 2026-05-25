/**
 * Playbook Learning System — Core Runtime Engine.
 *
 * Exports the seven engine modules that form the runtime:
 *
 * 1. **Playbook Store** — In-memory and SQLite-backed CRUD persistence for playbook entities.
 * 2. **Learning Engine** — Pattern extraction, fingerprinting, candidate generation.
 * 3. **Playbook Matcher** — Context-aware selection with Jaccard similarity.
 * 4. **Step Executor** — Execution plan generation with parameter substitution.
 * 5. **Feedback Loop** — Score calculation, decay, and promotion evaluation.
 * 6. **Version Manager** — Versioning, evolution, rollback, and diff tracking.
 * 7. **Promoter Job Runner** — KPI-gated interval/tick orchestration for promotions.
 *
 * @module playbook/engine
 */

// ─── Playbook Store ───
export { createPlaybookStore } from "./playbook-store.js";
export { createSqlitePlaybookStore } from "./playbook-sqlite-store.js";
export type { PlaybookStore } from "./playbook-store.js";

// ─── Learning Engine ───
export {
  createLearningEngine,
  extractPattern,
  canonicalizePattern,
  computeStableFingerprint,
} from "./learning-engine.js";
export type { ExecutionPattern, LearningEngineDeps } from "./learning-engine.js";

// ─── Playbook Matcher ───
export {
  createPlaybookMatcher,
  jaccardSimilarity,
  computeNodeSequenceSimilarity,
  computeTagOverlap,
  extractNodeSequenceFromPattern,
} from "./playbook-matcher.js";
export type { PlaybookMatcherDeps } from "./playbook-matcher.js";

// ─── Step Executor ───
export { createStepExecutor, resolveParameters } from "./step-executor.js";
export type {
  PlaybookStep,
  PlaybookExecutionPlan,
  StepExecutionResult,
  ParameterContext,
  StepExecutor,
  StepExecutorDeps,
} from "./step-executor.js";

// ─── Feedback Loop ───
export {
  createScoreCalculator,
  createPromotionEngine,
  normalizeCost,
  computeDaysSince,
  clamp,
} from "./feedback-loop.js";
export type { ScoreCalculatorDeps, PromotionEngineDeps } from "./feedback-loop.js";

// ─── Version Manager ───
export { createVersionManager } from "./version-manager.js";
export type {
  VersionDiffKind,
  VersionDiffEntry,
  VersionDiff,
  VersionManager,
  VersionManagerDeps,
} from "./version-manager.js";

// ─── Promoter Job Runner ───
export {
  createPromoterJobRunner,
  validatePromotionKpis,
  DEFAULT_PROMOTION_KPI_THRESHOLDS,
} from "./promoter-job.js";
export type {
  PromotionKpiSnapshot,
  PromotionKpiThresholds,
  PromotionKpiValidation,
  PromoterJobRunnerDeps,
  PromoterJobTickOptions,
  PromoterJobTickResult,
  PromoterJobRunner,
} from "./promoter-job.js";

// ─── Production Learning Loop ───

export { createPlaybookLearningLoop } from "./playbook-learning-loop.js";
export type {
  PlaybookLearningLoop,
  CreatePlaybookLearningLoopDeps,
} from "./playbook-learning-loop.js";
