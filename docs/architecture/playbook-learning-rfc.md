# RFC: Friday Playbook Learning System

**Status:** Draft  
**Author:** Friday Platform Team  
**Created:** 2026-02-23  
**Tickets:** FRI-PLAT-041, FRI-PLAT-042, FRI-PLAT-043

---

## 1. Summary

The Playbook Learning System converts successful workflow and agent runs into reusable, versioned playbooks that are selected via score-based, context-aware matching. Over time, agents get smarter with use: high-performing execution patterns are promoted to playbooks, scored across multiple dimensions (success rate, speed, cost efficiency, user satisfaction), and automatically selected when similar contexts arise. Bad promotions are detected and rolled back within SLO windows.

## 2. Motivation

Today, Friday agents and workflows execute every task from scratch. Even when a nearly identical task was completed successfully minutes ago, there is no mechanism to capture that successful pattern and reuse it. This leads to:

1. **Wasted compute.** Identical problems are solved independently, consuming tokens and API calls each time.
2. **Inconsistent quality.** The same task type may succeed or fail depending on stochastic LLM variance, with no way to bias toward proven approaches.
3. **No learning loop.** User corrections and positive feedback are captured by the Learning module (`src/learning/`) but not translated into executable reuse patterns.
4. **Operator frustration.** Power users see the same workflows succeed in some runs and fail in others, with no visibility into what makes a run "good."

The Playbook Learning System closes the loop:

- **Candidate generation:** Successful runs are analysed to extract reusable execution patterns (playbook candidates).
- **Promotion:** Candidates that meet threshold criteria (minimum runs, success rate, cost efficiency) are promoted to first-class playbooks.
- **Scoring:** Every playbook carries a multi-dimensional score that evolves with each execution.
- **Selection:** When a new task arrives, the system finds the best-matching playbook for the context and proposes it to the execution pipeline.
- **Versioning:** Playbooks evolve over time; each mutation creates a new version with full lineage.
- **Rollback:** Bad promotions are detected via success-rate degradation and automatically rolled back.

## 3. Goals and Non-Goals

### Goals

- **Reuse hit rate > 35%:** At least 35% of workflow/agent runs should match and use an existing playbook within 90 days of system activation.
- **Success lift > 20%:** Runs that use a playbook should have a success rate at least 20 percentage points higher than runs without a playbook, measured over a rolling 30-day window.
- **Bad promotion rollback < 1%:** Fewer than 1% of promoted playbooks should require rollback due to degraded performance.
- Candidate generation from successful workflow runs and agent runs with no manual authoring required.
- Multi-dimensional scoring: success rate, execution speed, cost efficiency, user satisfaction.
- Context-aware selection: match playbooks to incoming tasks based on workflow type, node types, input schema similarity, tags, and historical context.
- Full version history with diff-friendly snapshots.
- Integration with NodeRunner (execution), Rules Engine (policy gating), and Observability (tracing and audit).
- Cursor-based pagination on all list/search endpoints, consistent with Friday API conventions.
- SQLite persistence for all playbook data.
- Idempotent API write operations with 24-hour key retention (including `select` endpoint via mandatory `idempotencyKey`).

### Non-Goals (Out of Scope)

- **Cross-instance playbook sharing** — federation/marketplace is deferred to multi-tenant phase.
- **Natural-language playbook authoring** — future phase; v1 is purely extraction-based.
- **Real-time collaborative editing** — playbooks are system-generated, not hand-authored.
- **Automatic code generation from playbooks** — playbooks are execution patterns, not code templates.
- **A/B testing framework** — future phase; v1 uses deterministic score-based selection.

## 4. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            Friday Hub                                    │
│                                                                         │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────────────┐  │
│  │  Workflow   │  │   Agent    │  │ NodeRunner │  │   Observability  │  │
│  │  Runtime    │  │  Runtime   │  │            │  │                  │  │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └────────┬─────────┘  │
│        │               │               │                   │            │
│        └───────────────┴───────┬───────┘                   │            │
│                                │                           │            │
│                    ┌───────────▼────────────┐              │            │
│                    │  Playbook Learning     │              │            │
│                    │  System                │              │            │
│                    │                        │              │            │
│                    │  ┌──────────────────┐  │              │            │
│                    │  │ Candidate        │  │  traces &    │            │
│                    │  │ Generator        │◄─┼──────────────┘            │
│                    │  └────────┬─────────┘  │                           │
│                    │           │             │                           │
│                    │  ┌────────▼─────────┐  │                           │
│                    │  │ Promotion        │  │                           │
│                    │  │ Engine           │  │                           │
│                    │  └────────┬─────────┘  │                           │
│                    │           │             │                           │
│                    │  ┌────────▼─────────┐  │                           │
│                    │  │ Score            │  │                           │
│                    │  │ Calculator       │  │                           │
│                    │  └────────┬─────────┘  │                           │
│                    │           │             │                           │
│                    │  ┌────────▼─────────┐  │     ┌──────────────┐      │
│                    │  │ Selector         │──┼────►│ Rules Engine │      │
│                    │  │                  │  │     └──────────────┘      │
│                    │  └────────┬─────────┘  │                           │
│                    │           │             │                           │
│                    │  ┌────────▼─────────┐  │                           │
│                    │  │ Version          │  │                           │
│                    │  │ Manager          │  │                           │
│                    │  └──────────────────┘  │                           │
│                    └───────────────────────-┘                           │
│                                                                         │
│                    ┌───────────────────────┐                            │
│                    │       SQLite          │                            │
│                    │  playbooks            │                            │
│                    │  playbook_versions    │                            │
│                    │  playbook_candidates  │                            │
│                    │  playbook_scores      │                            │
│                    │  playbook_selections  │                            │
│                    │  promotion_decisions  │                            │
│                    └───────────────────────┘                            │
└─────────────────────────────────────────────────────────────────────────┘
```

## 5. Candidate Generation

### 5.1 Trigger

Candidate generation is triggered when:

1. A **workflow run** completes (status `completed` or `failed`).
2. An **agent run** completes (regardless of acceptance test outcome).

The Observability layer emits a `run.completed` trace event. The Candidate Generator subscribes to this event and processes runs as follows:

- **Successful runs** create new candidates or add evidence to existing ones.
- **Failed runs** are fingerprinted and matched against existing candidates. If a match is found, the candidate's `failureCount` is incremented (building failure-aware promotion metrics). Failed runs **do not** create new candidates.

### 5.2 Extraction Process

```
run.completed event
        │
        ▼
┌───────────────────┐
│ 1. Eligibility    │  ─ Duration > minimum? User not opted out?
│    Check          │
└───────┬───────────┘
        │ yes
        ▼
┌───────────────────┐
│ 2. Pattern        │  ─ Extract: node sequence, input schemas,
│    Extraction     │    tool usage, parameters, output shapes
└───────┬───────────┘
        │
        ▼
┌───────────────────┐
│ 3. Fingerprint    │  ─ SHA-256 of normalised pattern
│    Generation     │    (deterministic, order-sensitive)
└───────┬───────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────────┐
│ 4. Deduplication  │  Does a candidate with this fingerprint  │
│    + Ingestion    │  exist?                                  │
│                   │                                          │
│  Successful run:  │  If yes: increment evidenceCount,        │
│                   │          successCount, update stats       │
│                   │  If no:  create new candidate             │
│                   │                                          │
│  Failed run:      │  If yes: increment failureCount only     │
│                   │  If no:  skip (no new candidate)         │
└───────┬───────────────────────────────────────────────────────┘
        │
        ▼
   FridayPlaybookCandidate (created or updated, or null for unmatched failures)
```

### 5.3 Pattern Fingerprinting

The fingerprint is a SHA-256 hash of the normalised execution pattern:

- **Node sequence:** Ordered list of `(nodeType, adapterType)` tuples.
- **Input schema shape:** JSON Schema signatures of node inputs (structure only, no values).
- **Tool usage:** Set of tools invoked during execution.
- **Parameter keys:** Sorted set of configuration parameter keys (values excluded).

Values, timestamps, and execution-specific data are excluded from the fingerprint to ensure that structurally identical patterns produce the same hash.

### 5.4 Candidate Lifecycle

```
┌──────────┐     evidence     ┌─────────┐    promotion    ┌──────────┐
│ observed │ ────────────────►│ pending │ ───────────────►│ promoted │
└──────────┘   (count += 1)   └─────────┘   (rules pass)  └──────────┘
                                   │                            │
                                   │  rejected                  │  rollback
                                   ▼                            ▼
                              ┌──────────┐              ┌────────────┐
                              │ rejected │              │ rolled_back│
                              └──────────┘              └────────────┘
```

- **observed:** First seen; insufficient evidence for promotion.
- **pending:** Meets minimum evidence threshold; queued for promotion evaluation.
- **promoted:** Passed all promotion rules; a `FridayPlaybook` was created from this candidate.
- **rejected:** Failed promotion rules or manually rejected by an operator.
- **rolled_back:** Was promoted but subsequently rolled back due to degraded performance.

## 6. Promotion Rules

### 6.1 Promotion Criteria

A candidate is eligible for promotion when all of the following are true:

| Criterion | Threshold | Rationale |
|---|---|---|
| Evidence count | ≥ 5 successful runs | Avoid promoting one-off successes |
| Success rate | ≥ 90% across evidence runs | High confidence the pattern works |
| Minimum age | ≥ 24 hours since first observation | Prevent flash-in-the-pan patterns |
| Cost efficiency | ≤ 120% of median cost for similar runs | Don't promote expensive outliers |
| No active deny rule | Rules Engine must not deny | Policy compliance |

### 6.2 Promotion Decision

The Promotion Engine evaluates candidates on a configurable schedule (default: every 6 hours) or on-demand via API. Each evaluation produces a `FridayPromotionDecision`:

```typescript
FridayPromotionDecision {
  id:             UUID
  candidateId:    UUID
  decision:       "promote" | "reject" | "defer"
  reason:         string                        // human-readable explanation
  ruleResults:    FridayPromotionRuleResult[]    // per-rule evaluation results
  rulesResult?:   FridayEvaluationResult         // from Rules Engine (typed, not JsonObject)
  scoreSnapshot:  FridayPlaybookScore            // score at decision time
  decidedAt:      ISODateTime
}
```

- **promote:** Candidate meets all criteria. A new `FridayPlaybook` is created with version 1.
- **reject:** Candidate fails one or more criteria and the failure is non-recoverable (e.g., too many failures in evidence set). Candidate moves to `rejected`.
- **defer:** Candidate fails one or more criteria but the failure is recoverable (e.g., not enough evidence yet). Candidate remains `pending` and will be re-evaluated.

### 6.3 Rules Engine Integration

Before promotion, the Promotion Engine consults the Rules Engine with a `FridayEvaluationContext`. The `"playbook"` resource and `"promote"` / `"select"` actions are registered in `FridayRuleResource` and `FridayRuleAction` respectively.

```typescript
{
  resource: "playbook",   // FridayRuleResource
  action: "promote",      // FridayRuleAction
  args: { candidateId, fingerprint, tags, evidenceCount, successRate, costEfficiency },
  source: "system"
}
```

Operators can define deny rules to block promotion of specific patterns (e.g., patterns involving sensitive tools, patterns from specific workflows).

## 7. Score Model

### 7.1 Score Dimensions

Every playbook carries a composite score computed from four dimensions:

| Dimension | Weight (default) | Metric | Source |
|---|---|---|---|
| **Success rate** | 0.40 | % of runs using this playbook that succeeded | Workflow/Agent run status |
| **Speed** | 0.20 | Inverse of median execution duration (normalised) | Observability trace spans |
| **Cost efficiency** | 0.25 | Inverse of median normalised cost (`FridayPlaybookCostDimensions`: tokenCost × 0.50 + apiCallCost × 0.30 + latencyMs × 0.20) | Multi-dimensional cost model (mirrors `FridayRetryCostDimensions` pattern) |
| **User satisfaction** | 0.15 | Weighted average of explicit feedback signals | Learning module signals |

### 7.2 Score Calculation

```
composite_score = Σ (dimension_weight × normalised_dimension_value)
```

Each dimension value is normalised to [0, 1] using min-max scaling within the playbook's category (same workflow type / tag group). Scores are recalculated:

- After every run that uses the playbook.
- On a periodic schedule (default: every 1 hour) for decay.

### 7.3 Score Decay

Scores decay over time to prevent stale playbooks from dominating selection. The decay function is exponential:

```
decayed_value = raw_value × e^(-λ × days_since_last_use)
```

Where `λ` (decay rate) defaults to `0.02` (half-life ≈ 35 days). Playbooks not used for 90 days are automatically archived (not deleted).

### 7.4 Score History

Every score recalculation produces a `FridayPlaybookScore` snapshot that is persisted for trend analysis. The API exposes score history with cursor-based pagination.

## 8. Versioning

### 8.1 Version Creation

A new playbook version is created when:

1. **Promotion:** The initial version (v1) is created from the candidate.
2. **Pattern evolution:** A new candidate with a different fingerprint is matched to an existing playbook via fuzzy matching (Jaccard similarity ≥ 0.85 on node sequences). The new pattern becomes the next version.
3. **Manual update:** An operator triggers a version bump via API (future phase).

### 8.2 Version Schema

```typescript
FridayPlaybookVersion {
  id:              UUID
  playbookId:      UUID
  versionNumber:   number       // monotonically increasing
  fingerprint:     string       // SHA-256 of the pattern
  pattern:         JsonObject   // full execution pattern snapshot
  candidateId:     UUID         // source candidate
  changeNote:      string       // human-readable description of change
  createdAt:       ISODateTime
}
```

### 8.3 Active Version

Each playbook has an `activeVersionNumber` pointer. Selection always uses the active version. Rollback sets the pointer to a previous version.

## 9. Selection Algorithm

### 9.1 Overview

When a new task arrives (workflow trigger or agent run start), the Selector finds the best playbook:

```
Incoming context (workflow type, node types, input schemas, tags)
        │
        ▼
┌───────────────────┐
│ 1. Context        │  ─ Build selector context from trigger payload,
│    Building       │    workflow definition, agent config
└───────┬───────────┘
        │
        ▼
┌───────────────────┐
│ 2. Candidate      │  ─ Query playbooks matching:
│    Filtering      │    • Same workflow type (exact)
│                   │    • Tag overlap ≥ 50%
│                   │    • Status = "active"
└───────┬───────────┘
        │
        ▼
┌───────────────────┐
│ 3. Similarity     │  ─ Rank by context similarity:
│    Ranking        │    • Node sequence Jaccard similarity
│                   │    • Input schema structural similarity
│                   │    • Tag overlap percentage
└───────┬───────────┘
        │
        ▼
┌───────────────────┐
│ 4. Score          │  ─ Weight by composite score:
│    Weighting      │    final_rank = similarity × 0.6 + score × 0.4
└───────┬───────────┘
        │
        ▼
┌───────────────────┐
│ 5. Rules Check    │  ─ Rules Engine evaluation (resource: "playbook",
│                   │    action: "select")
└───────┬───────────┘
        │
        ▼
  FridayPlaybookMatch (or null if no match above threshold)
```

### 9.2 Tie-Breaking

When multiple playbooks share the same `final_rank` score, a deterministic tie-break order is applied:

1. **Highest composite score** — prefer the playbook with the higher `compositeScore`.
2. **Most recent successful use** — prefer the playbook whose most recent successful run is more recent.
3. **Lowest candidate ID** — lexicographic comparison on `sourceCandidateId` (deterministic fallback).

The tie-break order is configurable via `FridayPlaybookSelectionConfig.tieBreakOrder`.

### 9.3 Match Threshold

A match is only returned if `final_rank ≥ 0.60` (configurable). Below this threshold, no playbook is suggested and the run proceeds without one.

### 9.4 Selection Recording

Every selection (hit or miss) is recorded for analytics:

```typescript
FridayPlaybookSelection {
  id:           UUID
  runId:        UUID
  workflowId:   UUID
  playbookId:   UUID | null    // null for misses
  versionNumber: number | null
  matchScore:   number | null
  reason:       string         // "matched", "no_match", "rules_denied", "below_threshold"
  selectedAt:   ISODateTime
}
```

## 10. Integration Points

### 10.1 NodeRunner

The NodeRunner receives a `playbookId` and `playbookVersionNumber` in the execution context when a playbook is selected. The NodeRunner uses the playbook's pattern to:

- Pre-populate node parameters from the playbook pattern.
- Set tool preferences from the playbook's tool usage history.
- Apply timeout hints from the playbook's speed metrics.

Integration is via the existing `FridayNodeExecutionContext.metadata` field — no schema changes to NodeRunner types.

### 10.2 Rules Engine

Two integration points:

1. **Promotion gating:** `resource: "playbook", action: "promote"` — operators can deny promotion of specific patterns.
2. **Selection gating:** `resource: "playbook", action: "select"` — operators can deny selection of specific playbooks for specific contexts.

Both use the existing `FridayEvaluationContext` interface.

### 10.3 Observability

- **Trace correlation:** Playbook selection produces a span in the run's trace (`playbook.select`).
- **Audit logging:** Promotion decisions, rollbacks, and manual overrides are audited.
- **SLI source:** Playbook success rate and reuse hit rate feed into SLO dashboards.

### 10.4 Learning Module

The Learning module's `FridayExtractedSignal` events with `kind: "positive_feedback"` and `kind: "correction"` are consumed by the Score Calculator to update the user satisfaction dimension.

## 11. Non-Functional Requirements

| NFR | Target | Measurement |
|---|---|---|
| Reuse hit rate | > 35% within 90 days | `selections with playbookId / total selections` |
| Success lift | > 20 pp over non-playbook runs | Rolling 30-day comparison |
| Bad promotion rollback rate | < 1% of promotions | `rollbacks / total promotions` |
| Selection latency | p95 < 50 ms | Observability span `playbook.select` |
| Candidate generation latency | p95 < 200 ms | Observability span `playbook.candidate.generate` |
| Promotion evaluation latency | p95 < 500 ms per candidate | Observability span `playbook.promote.evaluate` |
| Score recalculation latency | p95 < 100 ms per playbook | Observability span `playbook.score.recalculate` |
| Storage overhead | < 5% of total DB size | `playbook tables size / total DB size` |
| Version history retention | Unlimited (no auto-pruning) | All versions preserved |

## 12. Persistence Schema

### 12.1 Tables

```sql
-- Core playbook definition
CREATE TABLE playbooks (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  description           TEXT,
  workflow_type         TEXT NOT NULL,
  tags_json             TEXT NOT NULL DEFAULT '[]',
  status                TEXT NOT NULL DEFAULT 'active',  -- active | archived | rolled_back
  active_version_number INTEGER NOT NULL DEFAULT 1,
  source_candidate_id   TEXT NOT NULL,
  composite_score       REAL NOT NULL DEFAULT 0.0,
  total_uses            INTEGER NOT NULL DEFAULT 0,
  total_successes       INTEGER NOT NULL DEFAULT 0,
  etag                  TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  archived_at           TEXT,
  FOREIGN KEY (source_candidate_id) REFERENCES playbook_candidates(id)
);

-- Playbook version snapshots
CREATE TABLE playbook_versions (
  id                TEXT PRIMARY KEY,
  playbook_id       TEXT NOT NULL,
  version_number    INTEGER NOT NULL,
  fingerprint       TEXT NOT NULL,
  pattern_json      TEXT NOT NULL,
  candidate_id      TEXT NOT NULL,
  change_note       TEXT,
  created_at        TEXT NOT NULL,
  FOREIGN KEY (playbook_id) REFERENCES playbooks(id),
  UNIQUE(playbook_id, version_number)
);

-- Playbook candidates (pre-promotion)
CREATE TABLE playbook_candidates (
  id                TEXT PRIMARY KEY,
  fingerprint       TEXT NOT NULL UNIQUE,
  workflow_type     TEXT NOT NULL,
  tags_json         TEXT NOT NULL DEFAULT '[]',
  pattern_json      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'observed',  -- observed | pending | promoted | rejected | rolled_back
  evidence_count    INTEGER NOT NULL DEFAULT 1,
  success_count     INTEGER NOT NULL DEFAULT 1,
  failure_count     INTEGER NOT NULL DEFAULT 0,
  total_duration_ms INTEGER NOT NULL DEFAULT 0,
  total_cost_json   TEXT NOT NULL DEFAULT '{"tokenCost":0,"apiCallCost":0,"latencyMs":0}',
  source_run_ids_json TEXT NOT NULL DEFAULT '[]',
  promoted_playbook_id TEXT,
  first_observed_at TEXT NOT NULL,
  last_observed_at  TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- Score history
CREATE TABLE playbook_scores (
  id                    TEXT PRIMARY KEY,
  playbook_id           TEXT NOT NULL,
  version_number        INTEGER NOT NULL,
  composite_score       REAL NOT NULL,
  success_rate          REAL NOT NULL,
  speed_score           REAL NOT NULL,
  cost_efficiency_score REAL NOT NULL,
  satisfaction_score    REAL NOT NULL,
  sample_size           INTEGER NOT NULL,
  calculated_at         TEXT NOT NULL,
  FOREIGN KEY (playbook_id) REFERENCES playbooks(id)
);

-- Selection log
CREATE TABLE playbook_selections (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  workflow_id     TEXT NOT NULL,
  playbook_id     TEXT,
  version_number  INTEGER,
  match_score     REAL,
  similarity      REAL,
  reason          TEXT NOT NULL,
  context_json    TEXT NOT NULL,
  selected_at     TEXT NOT NULL
);

-- Promotion decisions
CREATE TABLE promotion_decisions (
  id                  TEXT PRIMARY KEY,
  candidate_id        TEXT NOT NULL,
  decision            TEXT NOT NULL,  -- promote | reject | defer
  reason              TEXT NOT NULL,
  rule_results_json   TEXT NOT NULL,      -- per-rule evaluation results (FridayPromotionRuleResult[])
  rules_result_json   TEXT,              -- Rules Engine evaluation result (FridayEvaluationResult, nullable)
  score_snapshot_json  TEXT NOT NULL,
  decided_at          TEXT NOT NULL,
  FOREIGN KEY (candidate_id) REFERENCES playbook_candidates(id)
);
```

### 12.2 Indexes

```sql
CREATE INDEX idx_playbooks_workflow_type ON playbooks(workflow_type);
CREATE INDEX idx_playbooks_status ON playbooks(status);
CREATE INDEX idx_playbooks_composite_score ON playbooks(composite_score DESC);
CREATE INDEX idx_playbook_candidates_fingerprint ON playbook_candidates(fingerprint);
CREATE INDEX idx_playbook_candidates_status ON playbook_candidates(status);
CREATE INDEX idx_playbook_candidates_workflow_type ON playbook_candidates(workflow_type);
CREATE INDEX idx_playbook_scores_playbook_id ON playbook_scores(playbook_id, calculated_at DESC);
CREATE INDEX idx_playbook_selections_run_id ON playbook_selections(run_id);
CREATE INDEX idx_playbook_selections_playbook_id ON playbook_selections(playbook_id);
CREATE INDEX idx_promotion_decisions_candidate_id ON promotion_decisions(candidate_id);
```

## 13. Edge Cases

### 13.1 Fingerprint Collision

Two structurally different patterns could theoretically produce the same SHA-256 fingerprint. Mitigation: on fingerprint match, verify structural equality of the full pattern JSON. If structures differ, append a collision counter to the fingerprint.

### 13.2 Cold Start

When no playbooks exist, the selection always returns a miss. The system degrades gracefully — runs execute without playbook guidance. Candidate generation begins immediately, so playbooks will appear after the first promotion cycle (≥ 24 hours, ≥ 5 evidence runs).

### 13.3 Score Oscillation

If a playbook alternates between success and failure, its score may oscillate around the rollback threshold. Mitigation: require the score to remain below the rollback threshold for 3 consecutive evaluation windows before triggering rollback.

### 13.4 Candidate Explosion

Highly variable workflows (e.g., different node sequences on each run) could generate many candidates that never reach the promotion threshold. Mitigation: candidates in `observed` status with `evidence_count = 1` and older than 30 days are garbage-collected.

### 13.5 Concurrent Promotion

Two promotion evaluations could run concurrently and both decide to promote the same candidate. Mitigation: use optimistic concurrency (etag) on the candidate row. The second promotion attempt fails with a conflict and is retried on the next cycle.

### 13.6 Rollback During Active Use

A playbook is rolled back while a run is actively using it. Mitigation: the run keeps its reference to the version it started with. Rollback only affects future selections.

### 13.7 Circular Evolution

A playbook could evolve to version N, then a candidate matching version N-2's fingerprint could trigger evolution back to an older pattern. Mitigation: version creation checks if the fingerprint already exists in the version history. If so, it reactivates the existing version instead of creating a new one.

## 14. Architecture Decision Records

### ADR-041-01: SQLite Over Dedicated Vector DB for Similarity Search

**Context:** The selection algorithm requires similarity-based matching (Jaccard on node sequences, structural similarity on schemas). A vector database (e.g., Qdrant, Pinecone) could accelerate this.

**Decision:** Use SQLite with application-level similarity computation.

**Rationale:**
- Friday is a single-hub architecture; the playbook corpus is expected to be < 10,000 entries.
- SQLite is the established persistence layer across all modules.
- Jaccard similarity on small sets (< 50 nodes) is O(n) and completes in < 1 ms.
- Adding a vector DB introduces a new operational dependency for marginal benefit.
- If the corpus grows beyond 10,000, we can add an in-memory index (e.g., HNSW) without changing the storage layer.

**Status:** Accepted.

### ADR-041-02: Exponential Score Decay Over Fixed Windows

**Context:** Stale playbooks should lose influence over time. Options: (a) fixed window (scores reset after N days), (b) exponential decay (scores continuously decay).

**Decision:** Exponential decay with configurable half-life.

**Rationale:**
- Exponential decay is smoother and avoids cliff effects where a playbook suddenly drops from high to zero score.
- The half-life parameter (default 35 days) provides a natural forgetting curve.
- Playbooks in active use continuously refresh their score, so decay only affects unused playbooks.
- Fixed windows require choosing a "correct" window size, which varies by use case. Decay adapts naturally.

**Status:** Accepted.

### ADR-041-03: Fingerprint-Based Deduplication Over LLM-Based Semantic Matching

**Context:** When deciding if two runs represent the "same" pattern, we could use: (a) deterministic fingerprinting (SHA-256 of normalised structure), or (b) LLM-based semantic similarity.

**Decision:** Deterministic fingerprinting for exact dedup; Jaccard similarity for fuzzy matching during version evolution.

**Rationale:**
- Deterministic fingerprinting is fast (< 1 ms), free (no LLM calls), and reproducible.
- LLM-based matching introduces latency, cost, and non-determinism into a critical path.
- Jaccard similarity on node sequences provides sufficient fuzzy matching for version evolution without LLM involvement.
- Semantic matching can be added as a future enhancement for cross-workflow playbook discovery.

**Status:** Accepted.

### ADR-041-04: Promotion Schedule Over Real-Time Promotion

**Context:** Should candidates be promoted immediately when they meet criteria, or on a scheduled cadence?

**Decision:** Scheduled promotion (default every 6 hours) with on-demand API override.

**Rationale:**
- Scheduled evaluation batches work efficiently and avoids hot-path latency for candidate generation.
- Prevents promotion oscillation when a candidate temporarily meets criteria then drops below.
- The 24-hour minimum age requirement already prevents instant promotion, so real-time evaluation adds no value.
- On-demand API allows operators to force evaluation when needed.

**Status:** Accepted.

### ADR-041-05: Active Version Pointer Over Latest-Wins

**Context:** When a playbook has multiple versions, which one is used for selection? Options: (a) always use the latest version, (b) explicit active version pointer.

**Decision:** Explicit `activeVersionNumber` pointer on the playbook entity.

**Rationale:**
- An explicit pointer enables rollback by simply changing the pointer, without deleting versions.
- Latest-wins makes rollback destructive (must delete the bad version).
- The pointer also enables A/B testing in future phases (point different contexts at different versions).
- Version history is preserved for audit and analysis regardless of which version is active.

**Status:** Accepted.

## 15. Security Considerations

- **Pattern extraction:** Playbook patterns contain structural information about workflows (node types, tool usage, parameter keys) but not values. Sensitive data (API keys, user inputs) is never included in patterns.
- **Rules Engine gating:** Both promotion and selection are gated by the Rules Engine, allowing operators to block specific patterns from becoming playbooks.
- **Audit trail:** All promotion decisions, rollbacks, and selections are recorded in the Observability audit log.
- **Access control:** Playbook API endpoints require `playbook:read` and `playbook:write` scopes, enforced via the existing RBAC model.

## 16. Rollout Plan

### Phase 1 (This RFC)
- Architecture RFC, domain model, API contract.
- No runtime implementation.

### Phase 2
- Candidate Generator service.
- SQLite persistence layer.
- Promotion Engine with Rules Engine integration.

### Phase 3
- Score Calculator with all four dimensions.
- Selector with context-aware matching.
- NodeRunner integration (pass playbook context to execution).

### Phase 4
- Observability integration (tracing spans, audit entries, SLO dashboards).
- Rollback automation.
- Candidate garbage collection.

## 17. Open Questions

1. **Weight tuning:** Should dimension weights be user-configurable per workflow type, or global? (Leaning toward global with per-type overrides.)
2. **Cross-workflow playbooks:** Can a playbook extracted from workflow A be applied to workflow B if the node sequences are similar? (Deferred to future phase.)
3. **Agent run patterns:** Agent runs are less structured than workflow runs. How should patterns be extracted from freeform agent sessions? (Needs design spike in Phase 2.)
