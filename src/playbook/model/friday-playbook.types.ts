/**
 * Playbook Learning System — Domain Model and Data Contract.
 *
 * Canonical types for the Friday Playbook Learning System: playbooks,
 * playbook candidates, versioning, multi-dimensional scoring,
 * context-aware selection, promotion rules, and persistence schema types.
 *
 * @module playbook/model
 */

import type { FridayEvaluationResult } from "../../rules/model/friday-rules-engine.types.js";

// ─── Foundational Value Types (local; mirrors rules/workflow/observability pattern) ───

/** UUID string identifier. */
export type UUID = string;

/** ISO 8601 date-time string. */
export type ISODateTime = string;

/** JSON-safe primitive value. */
export type JsonPrimitive = string | number | boolean | null;

/** Recursive JSON-safe value. */
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

/** JSON-safe object. */
export interface JsonObject {
  [key: string]: JsonValue;
}

// ─── Multi-Dimensional Cost Model (mirrors FridayRetryCostDimensions pattern) ───

/**
 * Multi-dimensional cost tracked per playbook candidate and scoring.
 *
 * Mirrors the `FridayRetryCostDimensions` structure from the Retry module
 * to ensure cross-module cost model compatibility.
 */
export interface FridayPlaybookCostDimensions {
  /** Total LLM tokens consumed. */
  tokenCost: number;
  /** Total external API calls made. */
  apiCallCost: number;
  /** Total execution latency in milliseconds. */
  latencyMs: number;
}

/**
 * Normalization weights for collapsing multi-dimensional cost into a
 * scalar cost-efficiency score. Weights must sum to 1.0.
 */
export const FRIDAY_PLAYBOOK_COST_NORMALIZATION_WEIGHTS: Readonly<
  Record<keyof FridayPlaybookCostDimensions, number>
> = {
  tokenCost: 0.50,
  apiCallCost: 0.30,
  latencyMs: 0.20,
} as const;

// ═══════════════════════════════════════════════════════════════════════
// CORE ENTITIES
// ═══════════════════════════════════════════════════════════════════════

// ─── Playbook Status ───

/**
 * Lifecycle status of a playbook.
 *
 * - `active` — Available for selection.
 * - `archived` — No longer selected; preserved for history (auto-archived after 90 days of disuse).
 * - `rolled_back` — Demoted due to degraded performance; preserved for audit.
 */
export type FridayPlaybookStatus = "active" | "archived" | "rolled_back";

// ─── Playbook ───

/**
 * A promoted, versioned, reusable execution pattern.
 *
 * Playbooks are created from candidates that pass promotion rules.
 * Each playbook has a version history and a composite score that
 * evolves with every execution.
 */
export interface FridayPlaybook {
  /** Unique playbook identifier. */
  id: UUID;
  /** Human-readable name (auto-generated from pattern, editable). */
  name: string;
  /** Optional description. */
  description?: string;
  /** Workflow type this playbook applies to (exact match for selection filtering). */
  workflowType: string;
  /** Tags for filtering and organisation. */
  tags: string[];
  /** Current lifecycle status. */
  status: FridayPlaybookStatus;
  /** Currently active version number (selection always uses this version). */
  activeVersionNumber: number;
  /** ID of the candidate that originally created this playbook. */
  sourceCandidateId: UUID;
  /** Latest composite score (cached; authoritative value is in score history). */
  compositeScore: number;
  /** Total number of times this playbook has been used in selection. */
  totalUses: number;
  /** Total number of successful runs using this playbook. */
  totalSuccesses: number;
  /** Timestamp of the most recent use (selection/execution) of this playbook. */
  lastUsedAt?: ISODateTime;
  /** Timestamp of the most recent successful run for this playbook. */
  lastSuccessfulAt?: ISODateTime;
  /** Optimistic concurrency token. */
  etag: string;
  /** When this playbook was created. */
  createdAt: ISODateTime;
  /** When this playbook was last updated. */
  updatedAt: ISODateTime;
  /** When this playbook was archived (if applicable). */
  archivedAt?: ISODateTime;
}

// ─── Playbook Candidate Status ───

/**
 * Lifecycle status of a playbook candidate.
 *
 * - `observed` — First seen; insufficient evidence for promotion.
 * - `pending` — Meets minimum evidence threshold; queued for promotion evaluation.
 * - `promoted` — Passed all promotion rules; a playbook was created.
 * - `rejected` — Failed promotion rules (non-recoverable).
 * - `rolled_back` — Was promoted but the resulting playbook was rolled back.
 */
export type FridayPlaybookCandidateStatus =
  | "observed"
  | "pending"
  | "promoted"
  | "rejected"
  | "rolled_back";

// ─── Playbook Candidate ───

/**
 * A pre-promotion execution pattern extracted from completed runs.
 *
 * Candidates are created from successful runs and accumulate evidence
 * until they meet promotion criteria. Failed runs matching an existing
 * candidate's fingerprint update failure counters without creating new
 * candidates. Each candidate has a unique fingerprint derived from its
 * normalised execution pattern.
 */
export interface FridayPlaybookCandidate {
  /** Unique candidate identifier. */
  id: UUID;
  /**
   * SHA-256 fingerprint of the normalised execution pattern.
   * Deterministic and order-sensitive; used for deduplication.
   */
  fingerprint: string;
  /** Workflow type extracted from the source runs. */
  workflowType: string;
  /** Tags aggregated from source runs. */
  tags: string[];
  /** Full execution pattern snapshot (node sequence, schemas, tool usage, parameters). */
  pattern: JsonObject;
  /** Current lifecycle status. */
  status: FridayPlaybookCandidateStatus;
  /** Number of successful runs contributing evidence to this candidate. */
  evidenceCount: number;
  /** Number of successful evidence runs. */
  successCount: number;
  /**
   * Number of failed runs matching this candidate's fingerprint.
   * Ingested from failed run completion events to build failure-aware
   * promotion metrics. Failed runs do not create new candidates.
   */
  failureCount: number;
  /** Total execution duration in milliseconds across all evidence runs. */
  totalDurationMs: number;
  /** Multi-dimensional cost totals across all evidence runs. */
  totalCost: FridayPlaybookCostDimensions;
  /** IDs of runs that contributed evidence. */
  sourceRunIds: UUID[];
  /** ID of the playbook created from this candidate (if promoted). */
  promotedPlaybookId?: UUID;
  /** When this candidate was first observed. */
  firstObservedAt: ISODateTime;
  /** When this candidate last received new evidence. */
  lastObservedAt: ISODateTime;
  /** When this record was created. */
  createdAt: ISODateTime;
  /** When this record was last updated. */
  updatedAt: ISODateTime;
}

// ─── Playbook Version ───

/**
 * An immutable snapshot of a playbook's execution pattern at a point in time.
 *
 * Versions are created on initial promotion and on pattern evolution.
 * The active version is determined by `FridayPlaybook.activeVersionNumber`.
 */
export interface FridayPlaybookVersion {
  /** Unique version identifier. */
  id: UUID;
  /** Parent playbook ID. */
  playbookId: UUID;
  /** Monotonically increasing version number. */
  versionNumber: number;
  /** SHA-256 fingerprint of this version's pattern. */
  fingerprint: string;
  /** Full execution pattern snapshot. */
  pattern: JsonObject;
  /** ID of the candidate that produced this version. */
  candidateId: UUID;
  /** Human-readable description of what changed in this version. */
  changeNote?: string;
  /** When this version was created. */
  createdAt: ISODateTime;
}

// ─── Playbook Lifecycle Event ───

/** Lifecycle event type emitted by version operations for auditability. */
export type FridayPlaybookLifecycleEventType = "rollback" | "deactivate";

/**
 * Immutable audit event recorded for rollback/deactivation operations.
 */
export interface FridayPlaybookLifecycleEvent {
  /** Unique event identifier. */
  id: UUID;
  /** Target playbook ID. */
  playbookId: UUID;
  /** Lifecycle event kind. */
  type: FridayPlaybookLifecycleEventType;
  /** Human-readable reason supplied by caller. */
  reason: string;
  /** Version active before the event (null when unavailable). */
  fromVersionNumber: number | null;
  /** Version active after the event (null for deactivation). */
  toVersionNumber: number | null;
  /** Event timestamp. */
  occurredAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// SCORING
// ═══════════════════════════════════════════════════════════════════════

// ─── Score Dimension ───

/**
 * The four scoring dimensions for playbook evaluation.
 *
 * - `success_rate` — Percentage of runs using this playbook that succeeded.
 * - `speed` — Inverse of median execution duration (normalised to [0, 1]).
 * - `cost_efficiency` — Inverse of median total cost (normalised to [0, 1]).
 * - `satisfaction` — Weighted average of user feedback signals (normalised to [0, 1]).
 */
export type FridayPlaybookScoreDimension =
  | "success_rate"
  | "speed"
  | "cost_efficiency"
  | "satisfaction";

/**
 * Default weights for each scoring dimension.
 * Weights must sum to 1.0.
 */
export const FRIDAY_PLAYBOOK_SCORE_DIMENSION_WEIGHTS: Readonly<
  Record<FridayPlaybookScoreDimension, number>
> = {
  success_rate: 0.40,
  speed: 0.20,
  cost_efficiency: 0.25,
  satisfaction: 0.15,
} as const;

/**
 * Default score decay rate (λ) for exponential decay.
 * Half-life ≈ 35 days at λ = 0.02.
 */
export const FRIDAY_PLAYBOOK_SCORE_DECAY_RATE = 0.02 as const;

// ─── Score Snapshot ───

/**
 * A point-in-time score snapshot for a playbook.
 *
 * Persisted after every score recalculation for trend analysis.
 */
export interface FridayPlaybookScore {
  /** Unique score record identifier. */
  id: UUID;
  /** Parent playbook ID (null for candidate-only promotion snapshots). */
  playbookId: UUID | null;
  /** Version number at the time of scoring (null for candidate-only snapshots). */
  versionNumber: number | null;
  /** Composite score (weighted sum of normalised dimensions). */
  compositeScore: number;
  /** Normalised success rate value [0, 1]. */
  successRate: number;
  /** Normalised speed value [0, 1]. */
  speedScore: number;
  /** Normalised cost efficiency value [0, 1]. */
  costEfficiencyScore: number;
  /** Normalised user satisfaction value [0, 1]. */
  satisfactionScore: number;
  /** Number of runs in the scoring sample. */
  sampleSize: number;
  /** When this score was calculated. */
  calculatedAt: ISODateTime;
}

// ─── Score Configuration ───

/**
 * Configuration for the score calculator.
 * Allows per-deployment or per-workflow-type weight overrides.
 */
export interface FridayPlaybookScoreConfig {
  /** Per-dimension weights (must sum to 1.0). */
  weights: Record<FridayPlaybookScoreDimension, number>;
  /** Exponential decay rate λ (default: 0.02). */
  decayRate: number;
  /** Days of inactivity after which a playbook is auto-archived (default: 90). */
  autoArchiveDays: number;
  /** Minimum sample size before score is considered reliable (default: 5). */
  minSampleSize: number;
}

// ═══════════════════════════════════════════════════════════════════════
// SELECTION
// ═══════════════════════════════════════════════════════════════════════

// ─── Selector Context ───

/**
 * Context provided to the playbook selector for matching.
 *
 * Built from the incoming workflow trigger or agent run start event.
 */
export interface FridayPlaybookSelector {
  /** Workflow type (exact match filter). */
  workflowType: string;
  /** Workflow definition ID. */
  workflowId: UUID;
  /** Run ID for correlation. */
  runId: UUID;
  /**
   * Ordered list of `(nodeType, adapterType)` tuples from the workflow graph.
   * Used for Jaccard similarity comparison.
   */
  nodeSequence: Array<{ nodeType: string; adapterType?: string }>;
  /** Input schema shapes (JSON Schema signatures of top-level node inputs). */
  inputSchemas?: JsonObject[];
  /** Tags from the workflow definition and trigger. */
  tags: string[];
  /** Additional metadata for rules evaluation and context matching. */
  metadata?: JsonObject;
}

// ─── Match Result ───

/**
 * Reason for a selection outcome.
 *
 * - `matched` — A playbook was found above the match threshold.
 * - `no_match` — No playbooks exist for the workflow type.
 * - `below_threshold` — Playbooks exist but none scored above the match threshold.
 * - `rules_denied` — A matching playbook was found but the Rules Engine denied selection.
 */
export type FridayPlaybookMatchReason =
  | "matched"
  | "no_match"
  | "below_threshold"
  | "rules_denied";

/**
 * Result of a playbook selection attempt.
 *
 * Always produced (even on miss) for analytics and observability.
 */
export interface FridayPlaybookMatch {
  /** Unique selection record identifier. */
  id: UUID;
  /** Run ID that triggered the selection. */
  runId: UUID;
  /** Workflow definition ID. */
  workflowId: UUID;
  /** Matched playbook ID (null on miss). */
  playbookId: UUID | null;
  /** Matched playbook version number (null on miss). */
  versionNumber: number | null;
  /** Final ranking score combining similarity and composite score (null on miss). */
  matchScore: number | null;
  /** Raw similarity score before score weighting (null on miss). */
  similarity: number | null;
  /** Reason for the selection outcome. */
  reason: FridayPlaybookMatchReason;
  /** Selector context used for the match (persisted for replay/debugging). */
  context: FridayPlaybookSelector;
  /** When the selection was made. */
  selectedAt: ISODateTime;
}

// ─── Selection Configuration ───

/**
 * Tie-break criterion used when multiple playbooks share the same final rank score.
 *
 * - `highest_composite_score` — Prefer the playbook with the highest composite score.
 * - `most_recent_success` — Prefer the playbook most recently used successfully.
 * - `lowest_candidate_id` — Lexicographic tie-break on candidate ID (deterministic).
 */
export type FridayPlaybookTieBreakCriterion =
  | "highest_composite_score"
  | "most_recent_success"
  | "lowest_candidate_id";

/**
 * Default tie-break order:
 * 1. Highest composite score
 * 2. Most recent successful use
 * 3. Lowest candidate ID (deterministic fallback)
 */
export const FRIDAY_PLAYBOOK_TIE_BREAK_ORDER: readonly FridayPlaybookTieBreakCriterion[] = [
  "highest_composite_score",
  "most_recent_success",
  "lowest_candidate_id",
] as const;

/**
 * Configuration for the playbook selector.
 */
export interface FridayPlaybookSelectionConfig {
  /**
   * Minimum final rank score for a match to be returned.
   * Below this threshold, the selector returns a miss.
   * @default 0.60
   */
  matchThreshold: number;
  /**
   * Weight of context similarity in the final rank.
   * @default 0.60
   */
  similarityWeight: number;
  /**
   * Weight of composite score in the final rank.
   * Must equal `1 - similarityWeight`.
   * @default 0.40
   */
  scoreWeight: number;
  /**
   * Minimum tag overlap percentage for candidate filtering.
   * @default 0.50
   */
  minTagOverlap: number;
  /**
   * Maximum number of candidate playbooks to evaluate per selection.
   * Limits compute for workflow types with many playbooks.
   * @default 50
   */
  maxCandidates: number;
  /**
   * Ordered list of tie-break criteria applied when multiple playbooks
   * share the same final rank score. Criteria are applied in order
   * until a winner is determined.
   *
   * @default ["highest_composite_score", "most_recent_success", "lowest_candidate_id"]
   */
  tieBreakOrder: FridayPlaybookTieBreakCriterion[];
}

// ═══════════════════════════════════════════════════════════════════════
// PROMOTION
// ═══════════════════════════════════════════════════════════════════════

// ─── Promotion Rule ───

/**
 * A single promotion criterion with its threshold.
 *
 * All rules must pass for a candidate to be promoted.
 */
export interface FridayPromotionRule {
  /** Unique rule identifier. */
  id: string;
  /** Human-readable rule name. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** The metric this rule evaluates. */
  metric: FridayPromotionMetric;
  /** Comparison operator. */
  operator: FridayPromotionOperator;
  /** Threshold value. */
  threshold: number;
  /** Whether this rule is enabled. */
  enabled: boolean;
}

/**
 * Metrics available for promotion rule evaluation.
 */
export type FridayPromotionMetric =
  | "evidence_count"
  | "success_rate"
  | "min_age_hours"
  | "cost_efficiency_ratio"
  | "failure_count";

/**
 * Comparison operators for promotion rule thresholds.
 */
export type FridayPromotionOperator =
  | "gte"  // greater than or equal
  | "lte"  // less than or equal
  | "gt"   // greater than
  | "lt"   // less than
  | "eq";  // equal

/**
 * Default promotion rules applied when no custom rules are configured.
 */
export const FRIDAY_DEFAULT_PROMOTION_RULES: readonly FridayPromotionRule[] = [
  {
    id: "min-evidence",
    name: "Minimum evidence count",
    description: "Candidate must have at least 5 successful runs as evidence.",
    metric: "evidence_count",
    operator: "gte",
    threshold: 5,
    enabled: true,
  },
  {
    id: "min-success-rate",
    name: "Minimum success rate",
    description: "Candidate must have a success rate of at least 90%.",
    metric: "success_rate",
    operator: "gte",
    threshold: 0.90,
    enabled: true,
  },
  {
    id: "min-age",
    name: "Minimum age",
    description: "Candidate must be at least 24 hours old since first observation.",
    metric: "min_age_hours",
    operator: "gte",
    threshold: 24,
    enabled: true,
  },
  {
    id: "max-cost-ratio",
    name: "Maximum cost efficiency ratio",
    description: "Candidate cost must not exceed 120% of median cost for similar runs.",
    metric: "cost_efficiency_ratio",
    operator: "lte",
    threshold: 1.20,
    enabled: true,
  },
] as const;

// ─── Promotion Decision ───

/**
 * Outcome of a promotion evaluation.
 *
 * - `promote` — Candidate meets all criteria; a playbook will be created.
 * - `reject` — Candidate fails non-recoverable criteria; moves to rejected.
 * - `defer` — Candidate fails recoverable criteria; remains pending for re-evaluation.
 */
export type FridayPromotionDecisionOutcome = "promote" | "reject" | "defer";

/**
 * Individual rule evaluation result within a promotion decision.
 */
export interface FridayPromotionRuleResult {
  /** Rule ID. */
  ruleId: string;
  /** Whether this rule passed. */
  passed: boolean;
  /** Actual metric value at evaluation time. */
  actualValue: number;
  /** Threshold the metric was compared against. */
  threshold: number;
}

/**
 * The result of evaluating a candidate for promotion.
 *
 * Persisted for audit trail and trend analysis.
 */
export interface FridayPromotionDecision {
  /** Unique decision identifier. */
  id: UUID;
  /** Candidate that was evaluated. */
  candidateId: UUID;
  /** Outcome of the evaluation. */
  decision: FridayPromotionDecisionOutcome;
  /** Human-readable reason for the decision. */
  reason: string;
  /** Per-rule evaluation results. */
  ruleResults: FridayPromotionRuleResult[];
  /** Rules Engine evaluation result (if the Rules Engine was consulted). */
  rulesResult?: FridayEvaluationResult;
  /** Score snapshot of the candidate at decision time. */
  scoreSnapshot: FridayPlaybookScore;
  /** When the decision was made. */
  decidedAt: ISODateTime;
}

// ─── Promotion Configuration ───

/**
 * Configuration for the promotion engine.
 */
export interface FridayPromotionConfig {
  /** Promotion rules to apply. */
  rules: FridayPromotionRule[];
  /** Evaluation schedule interval in hours (default: 6). */
  evaluationIntervalHours: number;
  /**
   * Number of consecutive evaluation windows a playbook must remain
   * below the rollback threshold before triggering rollback.
   * Prevents oscillation-driven rollbacks.
   * @default 3
   */
  rollbackConsecutiveWindows: number;
  /**
   * Success rate threshold below which rollback is considered.
   * @default 0.50
   */
  rollbackSuccessRateThreshold: number;
}

// ═══════════════════════════════════════════════════════════════════════
// ENGINE INTERFACES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Candidate generator: extracts playbook candidates from completed runs.
 *
 * Both successful and failed runs are ingested:
 * - **Successful runs** create new candidates or increment evidence on existing ones.
 * - **Failed runs** update failure counters on existing candidates (matched by fingerprint)
 *   but do not create new candidates.
 */
export interface FridayPlaybookCandidateGenerator {
  /**
   * Process a completed run and generate or update a playbook candidate.
   *
   * Successful runs create or update candidates with incremented evidence.
   * Failed runs matching an existing candidate's fingerprint update its
   * failure counter without creating new candidates.
   *
   * @param event - Run completion event with execution details.
   * @returns The created or updated candidate, or null if the run is ineligible.
   */
  processCompletedRun(event: FridayPlaybookRunCompletionEvent): Promise<FridayPlaybookCandidate | null>;
}

/**
 * Event emitted when a run completes successfully.
 * Consumed by the candidate generator.
 */
export interface FridayPlaybookRunCompletionEvent {
  /** Run ID. */
  runId: UUID;
  /** Workflow definition ID. */
  workflowId: UUID;
  /** Workflow type. */
  workflowType: string;
  /** Tags from the workflow definition. */
  tags: string[];
  /** Ordered node execution sequence. */
  nodeSequence: Array<{ nodeType: string; adapterType?: string }>;
  /** Input schemas of top-level nodes. */
  inputSchemas?: JsonObject[];
  /** Tools invoked during execution. */
  toolsUsed: string[];
  /** Configuration parameter keys (values excluded). */
  parameterKeys: string[];
  /** Total execution duration in milliseconds. */
  durationMs: number;
  /** Multi-dimensional cost for this run. */
  cost: FridayPlaybookCostDimensions;
  /** Whether the run succeeded. */
  success: boolean;
  /** When the run completed. */
  completedAt: ISODateTime;
}

/**
 * Promotion engine: evaluates candidates for promotion to playbooks.
 */
export interface FridayPlaybookPromotionEngine {
  /**
   * Evaluate a single candidate for promotion.
   *
   * @param candidateId - ID of the candidate to evaluate.
   * @returns The promotion decision.
   */
  evaluate(candidateId: UUID): Promise<FridayPromotionDecision>;

  /**
   * Evaluate all pending candidates in a batch.
   *
   * @returns Array of promotion decisions.
   */
  evaluateAll(): Promise<FridayPromotionDecision[]>;
}

/**
 * Score calculator: computes and persists playbook scores.
 */
export interface FridayPlaybookScoreCalculator {
  /**
   * Recalculate the score for a single playbook.
   *
   * @param playbookId - ID of the playbook to score.
   * @returns The new score snapshot.
   */
  recalculate(playbookId: UUID): Promise<FridayPlaybookScore>;

  /**
   * Recalculate scores for all active playbooks.
   *
   * @returns Array of score snapshots.
   */
  recalculateAll(): Promise<FridayPlaybookScore[]>;
}

/**
 * Playbook selector: finds the best playbook for an incoming context.
 */
export interface FridayPlaybookSelectorEngine {
  /**
   * Select the best playbook for the given context.
   *
   * @param selector - Context describing the incoming task.
   * @returns Match result (always returned, even on miss).
   */
  select(selector: FridayPlaybookSelector): Promise<FridayPlaybookMatch>;
}

// ─── Engine Configuration ───

/**
 * Configuration for constructing a Playbook Learning System runtime.
 */
export interface FridayPlaybookEngineConfig {
  /** Score calculation configuration. */
  scoring: FridayPlaybookScoreConfig;
  /** Selection configuration. */
  selection: FridayPlaybookSelectionConfig;
  /** Promotion configuration. */
  promotion: FridayPromotionConfig;
  /** Generate a new UUID. */
  generateId: () => UUID;
  /** Get current ISO timestamp. */
  nowIso: () => ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// PERSISTENCE ROW TYPES (SQLite)
// ═══════════════════════════════════════════════════════════════════════

/** SQLite row shape for the `playbooks` table. */
export interface FridayPlaybookRow {
  id: string;
  name: string;
  description: string | null;
  workflow_type: string;
  tags_json: string;
  status: string;
  active_version_number: number;
  source_candidate_id: string;
  composite_score: number;
  total_uses: number;
  total_successes: number;
  last_used_at?: string | null;
  last_successful_at?: string | null;
  etag: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

/** SQLite row shape for the `playbook_versions` table. */
export interface FridayPlaybookVersionRow {
  id: string;
  playbook_id: string;
  version_number: number;
  fingerprint: string;
  pattern_json: string;
  candidate_id: string;
  change_note: string | null;
  created_at: string;
}

/** SQLite row shape for the `playbook_candidates` table. */
export interface FridayPlaybookCandidateRow {
  id: string;
  fingerprint: string;
  workflow_type: string;
  tags_json: string;
  pattern_json: string;
  status: string;
  evidence_count: number;
  success_count: number;
  failure_count: number;
  total_duration_ms: number;
  total_cost_json: string;
  source_run_ids_json: string;
  promoted_playbook_id: string | null;
  first_observed_at: string;
  last_observed_at: string;
  created_at: string;
  updated_at: string;
}

/** SQLite row shape for the `playbook_scores` table. */
export interface FridayPlaybookScoreRow {
  id: string;
  playbook_id: string;
  version_number: number;
  composite_score: number;
  success_rate: number;
  speed_score: number;
  cost_efficiency_score: number;
  satisfaction_score: number;
  sample_size: number;
  calculated_at: string;
}

/** SQLite row shape for the `playbook_selections` table. */
export interface FridayPlaybookSelectionRow {
  id: string;
  run_id: string;
  workflow_id: string;
  playbook_id: string | null;
  version_number: number | null;
  match_score: number | null;
  similarity: number | null;
  reason: string;
  context_json: string;
  selected_at: string;
}

/** SQLite row shape for the `promotion_decisions` table. */
export interface FridayPromotionDecisionRow {
  id: string;
  candidate_id: string;
  decision: string;
  reason: string;
  rule_results_json: string;
  rules_result_json: string | null;
  score_snapshot_json: string;
  decided_at: string;
}

/** SQLite row shape for the `playbook_lifecycle_events` table. */
export interface FridayPlaybookLifecycleEventRow {
  id: string;
  playbook_id: string;
  type: string;
  reason: string;
  from_version_number: number | null;
  to_version_number: number | null;
  occurred_at: string;
}

// ─── Row-to-Entity Mapper Signature ───

/** Generic row-to-entity mapper function type. */
export type FridayPlaybookRowMapper<TRow, TEntity> = (row: TRow) => TEntity;
