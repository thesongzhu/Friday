> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

Reading only the five requested sources now and extracting the exact table/type constraints so the Phase 6 plan aligns with existing architecture and V001 schema.

---

I have the key anchors; now I’m pulling the exact surrounding sections so the plan can map directly to Phase 6 scope and existing schema fields.

---

I’m checking the existing `FridaySqliteLayer` and adjacent ledger/runtime naming so the proposed file layout and signatures fit current conventions exactly.

---

## Phase 6 Implementation Plan: Self-Learning System

### 1. File Structure

```text
src/learning
src/learning/model
src/learning/persistence
src/learning/services
src/learning/runtime
```

```text
src/learning/index.ts
src/learning/model/friday-learning.types.ts
src/learning/persistence/friday-preference-fact-repository.ts
src/learning/persistence/friday-error-incident-repository.ts
src/learning/persistence/friday-diagnosis-record-repository.ts
src/learning/persistence/friday-learned-lesson-repository.ts
src/learning/persistence/friday-learning-metrics-repository.ts
src/learning/services/friday-learning-event-collection-service.ts
src/learning/services/friday-preference-extraction-service.ts
src/learning/services/friday-preference-fact-service.ts
src/learning/services/friday-learning-pattern-recognition-service.ts
src/learning/services/friday-learning-feedback-loop-service.ts
src/learning/services/friday-learning-context-enrichment-service.ts
src/learning/services/friday-learning-lifecycle-service.ts
src/learning/services/friday-learning-metrics-service.ts
src/learning/services/friday-self-learning-pipeline-service.ts
src/learning/runtime/friday-self-learning-runtime.types.ts
src/learning/runtime/friday-self-learning-runtime.ts
src/jobs/learning/friday-learning-metrics-job.ts
src/jobs/learning/friday-learning-metrics.types.ts
```

```text
src/jobs/index.ts                  (export new learning job)
src/ledger/index.ts                (re-export learning runtime types if desired)
src/workflows/runtime/...          (integration via wrapped invokeSkill, no schema change)
test/unit/learning/...
```

Constraints honored:
- No new migration files.
- Reuse `learning_events`, `preference_facts`, `learning_metrics`, `error_incidents`, `diagnosis_records`, `learned_lessons`.
- Use `FridaySqliteLayer`.
- Reuse Phase 2 ledger event types.

---

### 2. Type Definitions (Full Signatures)

```ts
import type Database from "better-sqlite3";
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type {
  FridayLearningEventAppendInput,
  FridayLearningEventKind,
} from "../../ledger/learning/friday-learning-event-ledger.types.js";

export type UUID = string;
export type ISODateTime = string;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue; }

export type FridayLearningLifecycleState = "cold_start" | "warmup" | "steady_state";

export type FridayLearningSignalKind =
  | "preference"
  | "correction"
  | "error"
  | "positive_feedback";

export interface FridayExtractedSignal {
  signalId: string;
  kind: FridayLearningSignalKind;
  key: string;
  value: JsonValue;
  confidence: number;
  sourceEventId: string;
  userId: string;
  sessionId?: string;
  runId?: string;
  ts: ISODateTime;
}

export interface FridayPreferenceFactRow {
  fact_id: string;
  user_id: string;
  key: string;
  value_json: string;
  confidence: number;
  evidence_count: number;
  last_confirmed_at: string;
  source_event_ids_json: string;
  created_at: string;
  updated_at: string;
}

export interface FridayPreferenceFactEntity {
  factId: UUID;
  userId: UUID;
  key: string;
  value: JsonValue;
  confidence: number;
  evidenceCount: number;
  lastConfirmedAt: ISODateTime;
  sourceEventIds: string[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface FridayErrorIncidentRow {
  incident_id: string;
  user_id: string;
  run_id: string | null;
  node_id: string | null;
  ts: string;
  category: "tool" | "model" | "routing" | "config" | "workflow";
  severity: "low" | "medium" | "high";
  signature: string;
  context_json: string;
  auto_fix_eligible: number;
  status: "open" | "mitigated" | "resolved";
  created_at: string;
  updated_at: string;
}

export interface FridayErrorIncidentEntity {
  incidentId: UUID;
  userId: UUID;
  runId?: UUID;
  nodeId?: string;
  ts: ISODateTime;
  category: "tool" | "model" | "routing" | "config" | "workflow";
  severity: "low" | "medium" | "high";
  signature: string;
  context: JsonObject;
  autoFixEligible: boolean; // always false in Phase 6 execution path
  status: "open" | "mitigated" | "resolved";
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface FridayDiagnosisRecordEntity {
  id: UUID;
  incidentId?: UUID;
  runId?: UUID;
  nodeId?: string;
  errorFingerprint: string;
  confidence: number;
  diagnosis: JsonObject;
  resolvedAt?: ISODateTime;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface FridayLearnedLessonEntity {
  id: UUID;
  fingerprint: string;
  title: string;
  cause: string;
  fix: string;
  mitigation?: JsonObject;
  occurrences: number;
  lastSeenAt: ISODateTime;
  sourceIncidentId?: UUID;
  sourceDiagnosisId?: UUID;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface FridayLearningMetricsEntity {
  day: string; // YYYY-MM-DD
  successRate?: number;
  autoFixSuccessRate?: number; // null in Phase 6
  rollbackRate?: number;       // null in Phase 6
  incidentsTotal: number;
  factsUpdated: number;
  actionsExecuted: number;     // always 0 in Phase 6
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface FridayLearningPattern {
  patternId: string;
  userId: string;
  kind:
    | "recurring_incident_signature"
    | "recurring_correction_key"
    | "stable_preference_key"
    | "drifting_preference_key";
  key: string;
  strength: number; // 0..1
  occurrences: number;
  windowStart: ISODateTime;
  windowEnd: ISODateTime;
  evidence: JsonObject;
}

export interface FridayLearningContext {
  userId: string;
  lifecycleState: FridayLearningLifecycleState;
  preferences: Record<string, JsonValue>;
  appliedFacts: Array<{ factId: string; key: string; confidence: number }>;
  activePatterns: FridayLearningPattern[];
  generatedAt: ISODateTime;
}

export interface FridaySelfLearningProcessResult {
  eventId: string;
  inserted: boolean;
  extractedSignals: FridayExtractedSignal[];
  factsUpdated: FridayPreferenceFactEntity[];
  incidentsCreated: FridayErrorIncidentEntity[];
  diagnosisCreated: FridayDiagnosisRecordEntity[];
  lessonsUpdated: FridayLearnedLessonEntity[];
  lifecycleState: FridayLearningLifecycleState;
}
```

---

### 3. Persistence Layer

Use repository-per-table + existing event ledger.

```ts
export interface FridayPreferenceFactRepository {
  getByUserAndKey(db: Database.Database, userId: string, key: string): FridayPreferenceFactEntity | null;
  listByUser(db: Database.Database, userId: string, minConfidence?: number, limit?: number): FridayPreferenceFactEntity[];
  upsert(db: Database.Database, input: {
    factId: string;
    userId: string;
    key: string;
    value: JsonValue;
    confidence: number;
    evidenceCountDelta: number;
    lastConfirmedAt: string;
    sourceEventId: string;
    nowIso: string;
  }): FridayPreferenceFactEntity;
  deleteByUserAndKey(db: Database.Database, userId: string, key: string): boolean;
  applyDecay(db: Database.Database, input: {
    userId?: string;
    nowIso: string;
    halfLifeDays: number;
    minConfidenceFloor: number;
  }): number;
}

export interface FridayErrorIncidentRepository {
  insert(db: Database.Database, incident: FridayErrorIncidentEntity): FridayErrorIncidentEntity;
  listByUser(db: Database.Database, input: {
    userId: string;
    status?: "open" | "mitigated" | "resolved";
    fromTs?: string;
    toTs?: string;
    limit?: number;
  }): FridayErrorIncidentEntity[];
  findRecentBySignature(db: Database.Database, userId: string, signature: string, limit?: number): FridayErrorIncidentEntity[];
}

export interface FridayDiagnosisRecordRepository {
  insert(db: Database.Database, record: FridayDiagnosisRecordEntity): FridayDiagnosisRecordEntity;
  listByFingerprint(db: Database.Database, fingerprint: string, limit?: number): FridayDiagnosisRecordEntity[];
}

export interface FridayLearnedLessonRepository {
  upsertByFingerprint(db: Database.Database, input: {
    id: string;
    fingerprint: string;
    title: string;
    cause: string;
    fix: string;
    mitigation?: JsonObject;
    sourceIncidentId?: string;
    sourceDiagnosisId?: string;
    nowIso: string;
  }): FridayLearnedLessonEntity;
  listRecent(db: Database.Database, limit?: number): FridayLearnedLessonEntity[];
}

export interface FridayLearningMetricsRepository {
  upsertDay(db: Database.Database, metric: FridayLearningMetricsEntity): FridayLearningMetricsEntity;
  getDay(db: Database.Database, day: string): FridayLearningMetricsEntity | null;
  listDays(db: Database.Database, fromDay?: string, toDay?: string, limit?: number): FridayLearningMetricsEntity[];
}
```

Transaction rules:
- `learning_events` insert remains idempotent (`INSERT OR IGNORE`) via existing ledger.
- Pipeline writes facts/incidents/diagnosis/lessons in one `withWriteTransaction`.
- Daily metrics uses `INSERT ... ON CONFLICT(day) DO UPDATE`.
- Phase 6 does not write `auto_fix_actions` or `approval_requests`.

---

### 4. Services

```ts
export interface FridayLearningEventCollectionService {
  collect(event: FridayLearningEventAppendInput): { inserted: boolean };
  collectBatch(events: FridayLearningEventAppendInput[]): Array<{ eventId: string; inserted: boolean }>;
}

export interface FridayPreferenceExtractionService {
  extract(event: FridayLearningEventAppendInput): FridayExtractedSignal[];
}

export interface FridayPreferenceFactService {
  applySignals(input: {
    event: FridayLearningEventAppendInput;
    signals: FridayExtractedSignal[];
    nowIso: string;
  }): FridayPreferenceFactEntity[];
  listActiveFacts(input: { userId: string; minConfidence: number; limit: number }): FridayPreferenceFactEntity[];
  deleteFact(input: { userId: string; key: string }): boolean;
  runDecay(input: { nowIso?: string; userId?: string }): { updated: number };
}

export interface FridayLearningPatternRecognitionService {
  detectUserPatterns(input: {
    userId: string;
    nowIso: string;
    lookbackDays: number;
  }): FridayLearningPattern[];
}

export interface FridayLearningFeedbackLoopService {
  applyCorrection(event: FridayLearningEventAppendInput): {
    accepted: boolean;
    updatedFacts: FridayPreferenceFactEntity[];
  };
}

export interface FridayLearningLifecycleService {
  getState(userId: string): FridayLearningLifecycleState;
}

export interface FridayLearningContextEnrichmentService {
  buildContext(input: {
    userId: string;
    nowIso: string;
    maxFacts?: number;
  }): FridayLearningContext;
  enrichSkillPayload(input: {
    userId?: string;
    runId?: string;
    nodeId?: string;
    payload: Record<string, unknown>;
    nowIso: string;
  }): Record<string, unknown>;
}

export interface FridayLearningMetricsService {
  aggregateDay(day: string): FridayLearningMetricsEntity;
  aggregateRange(fromDay: string, toDay: string): FridayLearningMetricsEntity[];
}

export interface FridaySelfLearningPipelineService {
  processEvent(event: FridayLearningEventAppendInput): FridaySelfLearningProcessResult;
  processBatch(events: FridayLearningEventAppendInput[]): FridaySelfLearningProcessResult[];
}
```

Service call order in `processEvent`:
1. Collect event.
2. Extract deterministic signals.
3. Update facts (with confidence recompute/decay-aware merge).
4. Classify/create incidents if error signals exist.
5. Create diagnosis and update learned lessons.
6. Recompute lifecycle state.
7. Return structured result (metrics aggregation remains async/daily job).

---

### 5. Preference Extraction Algorithm

Deterministic rules by `event.kind`:

1. `user_correction`
- Require payload keys: `correctedField`, `newValue`.
- Emit signal:
  - `kind: "correction"`
  - `key: "pref:<normalizedField>"`
  - `confidence: 1.0`
- Also emit contradiction marker if old value present.

2. `user_message`
- Parse text using fixed regex/keyword rules only (no stochastic model).
- Example intents:
  - “prefer X”, “always use X”, “don’t use Y”, “call me Z”.
- Emit `kind: "preference"` signals with confidence by rule class.

3. `tool_result`
- If `ok=false` or error payload exists, emit `kind: "error"` signal.
- Generate incident candidate key: `tool_failure:<toolName>:<errorCode|unknown>`.

4. `error_incident`
- Emit `kind: "error"` with confidence `1.0`.
- Incident signature computed by deterministic hash.

5. `workflow_outcome`
- If successful outcome with user approval markers, emit low-weight reinforcement for active preferences.
- If failed and tied to known preference mismatch, emit correction candidate.

6. `assistant_message`
- No preference signal by default (avoids self-reinforcement loops).

Signature:
- `sha256(kind + ":" + key + ":" + normalizedContext)` from `node:crypto`.
- Truncate to stable short id for incident grouping.

---

### 6. Confidence Scoring Model

For fact updates:

```text
existingDecayed = existingConfidence * exp(-ln(2) * daysSinceLastConfirmed / halfLifeDays)
evidenceBoost   = min(0.25, 0.04 * log2(1 + newEvidenceCount))
conflictPenalty = existingValue != incomingValue ? 0.30 : 0.00
newConfidence   = clamp(0.0, 1.0, 0.45 * existingDecayed + 0.55 * signalConfidence + evidenceBoost - conflictPenalty)
```

Defaults:
- `halfLifeDays = 30`
- `minConfidenceFloor = 0.05`
- `contextUseThreshold = 0.60`
- `steadyStateThreshold = 0.70`

Signal priors:
- correction: `1.00`
- explicit preference phrase: `0.80`
- implicit preference hint: `0.60`
- reinforcement from positive outcome: `0.55`

Decay job:
- Daily, recompute confidence from `last_confirmed_at`.
- Does not mutate `evidence_count`.
- Facts below threshold are retained but excluded from enrichment.

---

### 7. Pattern Recognition

Windows:
- Short window: 7 days.
- Medium window: 30 days.

Detectors:
1. Recurring incident signatures.
- Source: `error_incidents`.
- Rule: same `signature` count >= 3 in lookback window.
- Output: `recurring_incident_signature`.

2. Recurring correction keys.
- Source: `learning_events` where `kind='user_correction'`.
- Rule: same normalized field corrected >= 2 times in 14 days.
- Output: `recurring_correction_key`.

3. Stable preference keys.
- Source: `preference_facts`.
- Rule: evidence_count >= 4 and confidence >= 0.75 with no contradiction events in 30 days.
- Output: `stable_preference_key`.

4. Drifting preference keys.
- Source: correction history + fact overwrites.
- Rule: same key changed to >= 2 distinct values in 30 days.
- Output: `drifting_preference_key`.

Pattern strength:
- `strength = clamp(0,1, log2(1+occurrences)/3 * recencyMultiplier * confidenceMultiplier)`.

---

### 8. Context Enrichment

Injection target:
- Skill/workflow payloads before `invokeSkill`.

Payload contract:
- Add reserved envelope:

```ts
{
  ...payload,
  __fridayLearning: {
    lifecycleState,
    preferences,
    appliedFacts,
    activePatterns,
    generatedAt
  }
}
```

Precedence:
1. Explicit user/runtime payload values.
2. Learned preferences (only confidence >= threshold).
3. Skill/workflow defaults.

Safety:
- Do not mutate original payload object.
- Skip enrichment when no resolvable `userId`.
- Strip low-confidence or stale facts.

Integration path:
- Wrap base `invokeSkill` in learning runtime wrapper.
- Use wrapper when wiring workflow runtime and direct skill execution runtime.

---

### 9. Runtime Compositor

```ts
export interface FridaySelfLearningRuntime {
  events: FridayLearningEventCollectionService;
  extraction: FridayPreferenceExtractionService;
  facts: FridayPreferenceFactService;
  patterns: FridayLearningPatternRecognitionService;
  feedback: FridayLearningFeedbackLoopService;
  lifecycle: FridayLearningLifecycleService;
  context: FridayLearningContextEnrichmentService;
  metrics: FridayLearningMetricsService;
  pipeline: FridaySelfLearningPipelineService;
}

export interface CreateFridaySelfLearningRuntimeDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
  publishEvent?: (event: string, payload: unknown) => Promise<void>;
}
```

Composition order:
1. Reuse `createFridayLearningEventLedger`.
2. Create learning repositories (facts/incidents/diagnosis/lessons/metrics).
3. Create extraction + confidence/decay utilities.
4. Create fact/pattern/feedback/lifecycle/context services.
5. Create pipeline orchestrator.
6. Create daily metrics job.

Phase 6 guardrails in compositor:
- Disable auto-fix execution path entirely.
- `actions_executed` remains `0`.
- Incident classification + lesson updates are enabled.

---

### 10. Unit Test Plan

Test files:
- `test/unit/learning/persistence/friday-preference-fact-repository.test.ts`
- `test/unit/learning/persistence/friday-error-incident-repository.test.ts`
- `test/unit/learning/persistence/friday-learning-metrics-repository.test.ts`
- `test/unit/learning/services/friday-preference-extraction-service.test.ts`
- `test/unit/learning/services/friday-preference-fact-service.test.ts`
- `test/unit/learning/services/friday-learning-pattern-recognition-service.test.ts`
- `test/unit/learning/services/friday-learning-context-enrichment-service.test.ts`
- `test/unit/learning/services/friday-self-learning-pipeline-service.test.ts`
- `test/unit/learning/runtime/friday-self-learning-runtime.test.ts`
- `test/unit/jobs/learning/friday-learning-metrics-job.test.ts`

Core cases:
1. Event dedup by `event_id` and idempotent pipeline behavior.
2. Deterministic extraction for each `FridayLearningEventKind`.
3. Confidence recompute with contradiction penalty and decay.
4. `preference_facts` upsert merge of evidence + source event ids.
5. Incident signature dedup and recurring pattern detection.
6. Diagnosis + lesson upsert on recurring incidents.
7. Context enrichment precedence and low-confidence filtering.
8. Lifecycle transitions: cold start -> warmup -> steady state.
9. Daily metrics aggregation correctness (`learning_metrics` upsert).
10. Phase 6 invariant: no writes to `auto_fix_actions`/`approval_requests`.

This plan is fully compatible with V001 schema and existing runtime conventions.