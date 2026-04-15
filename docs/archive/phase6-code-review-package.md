> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Phase 6 Code Review Package

## Build & Test Results
- TypeScript: CLEAN
- 817 tests passed (90 files), 0 failures

## Source Code (Phase 6)
### `src/learning/index.ts`
```ts
// Model / types
export * from "./model/friday-learning.types.js";

// Persistence
export { createFridayPreferenceFactRepository } from "./persistence/friday-preference-fact-repository.js";
export type { FridayPreferenceFactRepository } from "./persistence/friday-preference-fact-repository.js";

export { createFridayErrorIncidentRepository } from "./persistence/friday-error-incident-repository.js";
export type { FridayErrorIncidentRepository } from "./persistence/friday-error-incident-repository.js";

export { createFridayDiagnosisRecordRepository } from "./persistence/friday-diagnosis-record-repository.js";
export type { FridayDiagnosisRecordRepository } from "./persistence/friday-diagnosis-record-repository.js";

export { createFridayLearnedLessonRepository } from "./persistence/friday-learned-lesson-repository.js";
export type { FridayLearnedLessonRepository } from "./persistence/friday-learned-lesson-repository.js";

export { createFridayLearningMetricsRepository } from "./persistence/friday-learning-metrics-repository.js";
export type { FridayLearningMetricsRepository } from "./persistence/friday-learning-metrics-repository.js";

// Services
export { createFridayLearningEventCollectionService } from "./services/friday-learning-event-collection-service.js";
export type { FridayLearningEventCollectionService } from "./services/friday-learning-event-collection-service.js";

export { createFridayPreferenceExtractionService } from "./services/friday-preference-extraction-service.js";
export type { FridayPreferenceExtractionService } from "./services/friday-preference-extraction-service.js";

export { createFridayPreferenceFactService } from "./services/friday-preference-fact-service.js";
export type { FridayPreferenceFactService } from "./services/friday-preference-fact-service.js";

export { createFridayLearningPatternRecognitionService } from "./services/friday-learning-pattern-recognition-service.js";
export type { FridayLearningPatternRecognitionService } from "./services/friday-learning-pattern-recognition-service.js";

export { createFridayLearningFeedbackLoopService } from "./services/friday-learning-feedback-loop-service.js";
export type { FridayLearningFeedbackLoopService } from "./services/friday-learning-feedback-loop-service.js";

export { createFridayLearningLifecycleService } from "./services/friday-learning-lifecycle-service.js";
export type { FridayLearningLifecycleService } from "./services/friday-learning-lifecycle-service.js";

export { createFridayLearningContextEnrichmentService } from "./services/friday-learning-context-enrichment-service.js";
export type { FridayLearningContextEnrichmentService } from "./services/friday-learning-context-enrichment-service.js";

export { createFridayLearningMetricsService } from "./services/friday-learning-metrics-service.js";
export type { FridayLearningMetricsService } from "./services/friday-learning-metrics-service.js";

export { createFridaySelfLearningPipelineService } from "./services/friday-self-learning-pipeline-service.js";
export type { FridaySelfLearningPipelineService } from "./services/friday-self-learning-pipeline-service.js";

// Runtime
export * from "./runtime/friday-self-learning-runtime.types.js";
export { createFridaySelfLearningRuntime } from "./runtime/friday-self-learning-runtime.js";
```

### `src/learning/model/friday-learning.types.ts`
```ts
import type {
  FridayLearningEventAppendInput,
  FridayLearningEventKind,
} from "../../ledger/learning/friday-learning-event-ledger.types.js";

export type UUID = string;
export type ISODateTime = string;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type FridayLearningLifecycleState =
  | "cold_start"
  | "warmup"
  | "steady_state";

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
  autoFixEligible: boolean;
  status: "open" | "mitigated" | "resolved";
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface FridayDiagnosisRecordRow {
  id: string;
  incident_id: string | null;
  run_id: string | null;
  node_id: string | null;
  error_fingerprint: string;
  confidence: number;
  diagnosis_json: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
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

export interface FridayLearnedLessonRow {
  id: string;
  fingerprint: string;
  title: string;
  cause: string;
  fix: string;
  mitigation_json: string | null;
  occurrences: number;
  last_seen_at: string;
  source_incident_id: string | null;
  source_diagnosis_id: string | null;
  created_at: string;
  updated_at: string;
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

export interface FridayLearningMetricsRow {
  day: string;
  success_rate: number | null;
  auto_fix_success_rate: number | null;
  rollback_rate: number | null;
  incidents_total: number;
  facts_updated: number;
  actions_executed: number;
  created_at: string;
  updated_at: string;
}

export interface FridayLearningMetricsEntity {
  day: string; // YYYY-MM-DD
  successRate?: number;
  autoFixSuccessRate?: number;
  rollbackRate?: number;
  incidentsTotal: number;
  factsUpdated: number;
  actionsExecuted: number;
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

/** Re-export ledger types for convenience. */
export type {
  FridayLearningEventAppendInput,
  FridayLearningEventKind,
};

/** Confidence model constants. */
export const FRIDAY_LEARNING_DEFAULTS = {
  halfLifeDays: 30,
  minConfidenceFloor: 0.05,
  contextUseThreshold: 0.60,
  steadyStateThreshold: 0.70,
  warmupFactCount: 3,
  steadyStateFactCount: 10,
} as const;
```

### `src/learning/persistence/friday-diagnosis-record-repository.ts`
```ts
import type Database from "better-sqlite3";
import type {
  FridayDiagnosisRecordEntity,
  FridayDiagnosisRecordRow,
  JsonObject,
} from "../model/friday-learning.types.js";

export interface FridayDiagnosisRecordRepository {
  insert(
    db: Database.Database,
    record: FridayDiagnosisRecordEntity,
  ): FridayDiagnosisRecordEntity;

  listByFingerprint(
    db: Database.Database,
    fingerprint: string,
    limit?: number,
  ): FridayDiagnosisRecordEntity[];
}

function rowToEntity(row: FridayDiagnosisRecordRow): FridayDiagnosisRecordEntity {
  return {
    id: row.id,
    incidentId: row.incident_id ?? undefined,
    runId: row.run_id ?? undefined,
    nodeId: row.node_id ?? undefined,
    errorFingerprint: row.error_fingerprint,
    confidence: row.confidence,
    diagnosis: JSON.parse(row.diagnosis_json) as JsonObject,
    resolvedAt: row.resolved_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createFridayDiagnosisRecordRepository(): FridayDiagnosisRecordRepository {
  return {
    insert(db, record) {
      db.prepare(
        `INSERT INTO diagnosis_records
         (id, incident_id, run_id, node_id, error_fingerprint, confidence,
          diagnosis_json, resolved_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.incidentId ?? null,
        record.runId ?? null,
        record.nodeId ?? null,
        record.errorFingerprint,
        record.confidence,
        JSON.stringify(record.diagnosis),
        record.resolvedAt ?? null,
        record.createdAt,
        record.updatedAt,
      );
      return record;
    },

    listByFingerprint(db, fingerprint, limit = 10) {
      const rows = db
        .prepare(
          `SELECT * FROM diagnosis_records
           WHERE error_fingerprint = ?
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(fingerprint, limit) as FridayDiagnosisRecordRow[];
      return rows.map(rowToEntity);
    },
  };
}
```

### `src/learning/persistence/friday-error-incident-repository.ts`
```ts
import type Database from "better-sqlite3";
import type {
  FridayErrorIncidentEntity,
  FridayErrorIncidentRow,
  JsonObject,
} from "../model/friday-learning.types.js";

export interface FridayErrorIncidentRepository {
  insert(
    db: Database.Database,
    incident: FridayErrorIncidentEntity,
  ): FridayErrorIncidentEntity;

  listByUser(
    db: Database.Database,
    input: {
      userId: string;
      status?: "open" | "mitigated" | "resolved";
      fromTs?: string;
      toTs?: string;
      limit?: number;
    },
  ): FridayErrorIncidentEntity[];

  findRecentBySignature(
    db: Database.Database,
    userId: string,
    signature: string,
    limit?: number,
  ): FridayErrorIncidentEntity[];
}

function rowToEntity(row: FridayErrorIncidentRow): FridayErrorIncidentEntity {
  return {
    incidentId: row.incident_id,
    userId: row.user_id,
    runId: row.run_id ?? undefined,
    nodeId: row.node_id ?? undefined,
    ts: row.ts,
    category: row.category,
    severity: row.severity,
    signature: row.signature,
    context: JSON.parse(row.context_json) as JsonObject,
    autoFixEligible: row.auto_fix_eligible === 1,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createFridayErrorIncidentRepository(): FridayErrorIncidentRepository {
  return {
    insert(db, incident) {
      db.prepare(
        `INSERT INTO error_incidents
         (incident_id, user_id, run_id, node_id, ts, category, severity,
          signature, context_json, auto_fix_eligible, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        incident.incidentId,
        incident.userId,
        incident.runId ?? null,
        incident.nodeId ?? null,
        incident.ts,
        incident.category,
        incident.severity,
        incident.signature,
        JSON.stringify(incident.context),
        incident.autoFixEligible ? 1 : 0,
        incident.status,
        incident.createdAt,
        incident.updatedAt,
      );
      return incident;
    },

    listByUser(db, input) {
      let sql = "SELECT * FROM error_incidents WHERE user_id = ?";
      const params: unknown[] = [input.userId];

      if (input.status) {
        sql += " AND status = ?";
        params.push(input.status);
      }
      if (input.fromTs) {
        sql += " AND ts >= ?";
        params.push(input.fromTs);
      }
      if (input.toTs) {
        sql += " AND ts <= ?";
        params.push(input.toTs);
      }

      sql += " ORDER BY ts DESC";

      if (input.limit) {
        sql += " LIMIT ?";
        params.push(input.limit);
      }

      const rows = db.prepare(sql).all(...params) as FridayErrorIncidentRow[];
      return rows.map(rowToEntity);
    },

    findRecentBySignature(db, userId, signature, limit = 10) {
      const rows = db
        .prepare(
          `SELECT * FROM error_incidents
           WHERE user_id = ? AND signature = ?
           ORDER BY ts DESC
           LIMIT ?`,
        )
        .all(userId, signature, limit) as FridayErrorIncidentRow[];
      return rows.map(rowToEntity);
    },
  };
}
```

### `src/learning/persistence/friday-learned-lesson-repository.ts`
```ts
import type Database from "better-sqlite3";
import type {
  FridayLearnedLessonEntity,
  FridayLearnedLessonRow,
  JsonObject,
} from "../model/friday-learning.types.js";

export interface FridayLearnedLessonRepository {
  upsertByFingerprint(
    db: Database.Database,
    input: {
      id: string;
      fingerprint: string;
      title: string;
      cause: string;
      fix: string;
      mitigation?: JsonObject;
      sourceIncidentId?: string;
      sourceDiagnosisId?: string;
      nowIso: string;
    },
  ): FridayLearnedLessonEntity;

  listRecent(
    db: Database.Database,
    limit?: number,
  ): FridayLearnedLessonEntity[];
}

function rowToEntity(row: FridayLearnedLessonRow): FridayLearnedLessonEntity {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    title: row.title,
    cause: row.cause,
    fix: row.fix,
    mitigation: row.mitigation_json
      ? (JSON.parse(row.mitigation_json) as JsonObject)
      : undefined,
    occurrences: row.occurrences,
    lastSeenAt: row.last_seen_at,
    sourceIncidentId: row.source_incident_id ?? undefined,
    sourceDiagnosisId: row.source_diagnosis_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createFridayLearnedLessonRepository(): FridayLearnedLessonRepository {
  return {
    upsertByFingerprint(db, input) {
      const existing = db
        .prepare("SELECT * FROM learned_lessons WHERE fingerprint = ?")
        .get(input.fingerprint) as FridayLearnedLessonRow | undefined;

      if (existing) {
        db.prepare(
          `UPDATE learned_lessons
           SET title = ?,
               cause = ?,
               fix = ?,
               mitigation_json = ?,
               occurrences = occurrences + 1,
               last_seen_at = ?,
               source_incident_id = COALESCE(?, source_incident_id),
               source_diagnosis_id = COALESCE(?, source_diagnosis_id),
               updated_at = ?
           WHERE fingerprint = ?`,
        ).run(
          input.title,
          input.cause,
          input.fix,
          input.mitigation ? JSON.stringify(input.mitigation) : null,
          input.nowIso,
          input.sourceIncidentId ?? null,
          input.sourceDiagnosisId ?? null,
          input.nowIso,
          input.fingerprint,
        );
      } else {
        db.prepare(
          `INSERT INTO learned_lessons
           (id, fingerprint, title, cause, fix, mitigation_json,
            occurrences, last_seen_at, source_incident_id, source_diagnosis_id,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        ).run(
          input.id,
          input.fingerprint,
          input.title,
          input.cause,
          input.fix,
          input.mitigation ? JSON.stringify(input.mitigation) : null,
          input.nowIso,
          input.sourceIncidentId ?? null,
          input.sourceDiagnosisId ?? null,
          input.nowIso,
          input.nowIso,
        );
      }

      const row = db
        .prepare("SELECT * FROM learned_lessons WHERE fingerprint = ?")
        .get(input.fingerprint) as FridayLearnedLessonRow;
      return rowToEntity(row);
    },

    listRecent(db, limit = 20) {
      const rows = db
        .prepare(
          `SELECT * FROM learned_lessons
           ORDER BY last_seen_at DESC
           LIMIT ?`,
        )
        .all(limit) as FridayLearnedLessonRow[];
      return rows.map(rowToEntity);
    },
  };
}
```

### `src/learning/persistence/friday-learning-metrics-repository.ts`
```ts
import type Database from "better-sqlite3";
import type {
  FridayLearningMetricsEntity,
  FridayLearningMetricsRow,
} from "../model/friday-learning.types.js";

export interface FridayLearningMetricsRepository {
  upsertDay(
    db: Database.Database,
    metric: FridayLearningMetricsEntity,
  ): FridayLearningMetricsEntity;

  getDay(
    db: Database.Database,
    day: string,
  ): FridayLearningMetricsEntity | null;

  listDays(
    db: Database.Database,
    fromDay?: string,
    toDay?: string,
    limit?: number,
  ): FridayLearningMetricsEntity[];
}

function rowToEntity(row: FridayLearningMetricsRow): FridayLearningMetricsEntity {
  return {
    day: row.day,
    successRate: row.success_rate ?? undefined,
    autoFixSuccessRate: row.auto_fix_success_rate ?? undefined,
    rollbackRate: row.rollback_rate ?? undefined,
    incidentsTotal: row.incidents_total,
    factsUpdated: row.facts_updated,
    actionsExecuted: row.actions_executed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createFridayLearningMetricsRepository(): FridayLearningMetricsRepository {
  return {
    upsertDay(db, metric) {
      db.prepare(
        `INSERT INTO learning_metrics
         (day, success_rate, auto_fix_success_rate, rollback_rate,
          incidents_total, facts_updated, actions_executed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET
           success_rate = excluded.success_rate,
           auto_fix_success_rate = excluded.auto_fix_success_rate,
           rollback_rate = excluded.rollback_rate,
           incidents_total = excluded.incidents_total,
           facts_updated = excluded.facts_updated,
           actions_executed = excluded.actions_executed,
           updated_at = excluded.updated_at`,
      ).run(
        metric.day,
        metric.successRate ?? null,
        metric.autoFixSuccessRate ?? null,
        metric.rollbackRate ?? null,
        metric.incidentsTotal,
        metric.factsUpdated,
        metric.actionsExecuted,
        metric.createdAt,
        metric.updatedAt,
      );

      return this.getDay(db, metric.day)!;
    },

    getDay(db, day) {
      const row = db
        .prepare("SELECT * FROM learning_metrics WHERE day = ?")
        .get(day) as FridayLearningMetricsRow | undefined;
      return row ? rowToEntity(row) : null;
    },

    listDays(db, fromDay, toDay, limit = 30) {
      let sql = "SELECT * FROM learning_metrics WHERE 1=1";
      const params: unknown[] = [];

      if (fromDay) {
        sql += " AND day >= ?";
        params.push(fromDay);
      }
      if (toDay) {
        sql += " AND day <= ?";
        params.push(toDay);
      }

      sql += " ORDER BY day DESC LIMIT ?";
      params.push(limit);

      const rows = db.prepare(sql).all(...params) as FridayLearningMetricsRow[];
      return rows.map(rowToEntity);
    },
  };
}
```

### `src/learning/persistence/friday-preference-fact-repository.ts`
```ts
import type Database from "better-sqlite3";
import type {
  FridayPreferenceFactEntity,
  FridayPreferenceFactRow,
  JsonValue,
} from "../model/friday-learning.types.js";

export interface FridayPreferenceFactRepository {
  getByUserAndKey(
    db: Database.Database,
    userId: string,
    key: string,
  ): FridayPreferenceFactEntity | null;

  listByUser(
    db: Database.Database,
    userId: string,
    minConfidence?: number,
    limit?: number,
  ): FridayPreferenceFactEntity[];

  upsert(
    db: Database.Database,
    input: {
      factId: string;
      userId: string;
      key: string;
      value: JsonValue;
      confidence: number;
      evidenceCountDelta: number;
      lastConfirmedAt: string;
      sourceEventId: string;
      nowIso: string;
    },
  ): FridayPreferenceFactEntity;

  deleteByUserAndKey(
    db: Database.Database,
    userId: string,
    key: string,
  ): boolean;

  applyDecay(
    db: Database.Database,
    input: {
      userId?: string;
      nowIso: string;
      halfLifeDays: number;
      minConfidenceFloor: number;
    },
  ): number;
}

function rowToEntity(row: FridayPreferenceFactRow): FridayPreferenceFactEntity {
  return {
    factId: row.fact_id,
    userId: row.user_id,
    key: row.key,
    value: JSON.parse(row.value_json) as JsonValue,
    confidence: row.confidence,
    evidenceCount: row.evidence_count,
    lastConfirmedAt: row.last_confirmed_at,
    sourceEventIds: JSON.parse(row.source_event_ids_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createFridayPreferenceFactRepository(): FridayPreferenceFactRepository {
  return {
    getByUserAndKey(db, userId, key) {
      const row = db
        .prepare(
          "SELECT * FROM preference_facts WHERE user_id = ? AND key = ?",
        )
        .get(userId, key) as FridayPreferenceFactRow | undefined;
      return row ? rowToEntity(row) : null;
    },

    listByUser(db, userId, minConfidence = 0, limit = 100) {
      const rows = db
        .prepare(
          `SELECT * FROM preference_facts
           WHERE user_id = ? AND confidence >= ?
           ORDER BY confidence DESC
           LIMIT ?`,
        )
        .all(userId, minConfidence, limit) as FridayPreferenceFactRow[];
      return rows.map(rowToEntity);
    },

    upsert(db, input) {
      const existing = db
        .prepare(
          "SELECT * FROM preference_facts WHERE user_id = ? AND key = ?",
        )
        .get(input.userId, input.key) as FridayPreferenceFactRow | undefined;

      if (existing) {
        const existingSourceIds = JSON.parse(
          existing.source_event_ids_json,
        ) as string[];
        const mergedSourceIds = existingSourceIds.includes(input.sourceEventId)
          ? existingSourceIds
          : [...existingSourceIds, input.sourceEventId].slice(-50);

        db.prepare(
          `UPDATE preference_facts
           SET value_json = ?,
               confidence = ?,
               evidence_count = evidence_count + ?,
               last_confirmed_at = ?,
               source_event_ids_json = ?,
               updated_at = ?
           WHERE user_id = ? AND key = ?`,
        ).run(
          JSON.stringify(input.value),
          input.confidence,
          input.evidenceCountDelta,
          input.lastConfirmedAt,
          JSON.stringify(mergedSourceIds),
          input.nowIso,
          input.userId,
          input.key,
        );
      } else {
        db.prepare(
          `INSERT INTO preference_facts
           (fact_id, user_id, key, value_json, confidence, evidence_count,
            last_confirmed_at, source_event_ids_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.factId,
          input.userId,
          input.key,
          JSON.stringify(input.value),
          input.confidence,
          input.evidenceCountDelta,
          input.lastConfirmedAt,
          JSON.stringify([input.sourceEventId]),
          input.nowIso,
          input.nowIso,
        );
      }

      return this.getByUserAndKey(db, input.userId, input.key)!;
    },

    deleteByUserAndKey(db, userId, key) {
      const result = db
        .prepare("DELETE FROM preference_facts WHERE user_id = ? AND key = ?")
        .run(userId, key);
      return result.changes > 0;
    },

    applyDecay(db, input) {
      // Exponential decay: newConfidence = confidence * exp(-ln(2) * daysSinceLastConfirmed / halfLifeDays)
      // SQLite doesn't have exp(), so we compute in JS
      const userFilter = input.userId ? " AND user_id = ?" : "";
      const params: unknown[] = input.userId ? [input.userId] : [];

      const rows = db
        .prepare(
          `SELECT * FROM preference_facts WHERE 1=1${userFilter}`,
        )
        .all(...params) as FridayPreferenceFactRow[];

      const nowMs = new Date(input.nowIso).getTime();
      let updated = 0;

      const updateStmt = db.prepare(
        `UPDATE preference_facts SET confidence = ?, updated_at = ?
         WHERE fact_id = ?`,
      );

      for (const row of rows) {
        const lastMs = new Date(row.last_confirmed_at).getTime();
        const daysSince = (nowMs - lastMs) / (1000 * 60 * 60 * 24);
        if (daysSince <= 0) continue;

        const decayed =
          row.confidence *
          Math.exp((-Math.LN2 * daysSince) / input.halfLifeDays);
        const clamped = Math.max(input.minConfidenceFloor, decayed);

        if (Math.abs(clamped - row.confidence) > 0.0001) {
          updateStmt.run(clamped, input.nowIso, row.fact_id);
          updated++;
        }
      }

      return updated;
    },
  };
}
```

### `src/learning/runtime/friday-self-learning-runtime.ts`
```ts
import { createFridayLearningEventLedger } from "../../ledger/learning/friday-learning-event-ledger.js";
import { createFridayPreferenceFactRepository } from "../persistence/friday-preference-fact-repository.js";
import { createFridayErrorIncidentRepository } from "../persistence/friday-error-incident-repository.js";
import { createFridayDiagnosisRecordRepository } from "../persistence/friday-diagnosis-record-repository.js";
import { createFridayLearnedLessonRepository } from "../persistence/friday-learned-lesson-repository.js";
import { createFridayLearningMetricsRepository } from "../persistence/friday-learning-metrics-repository.js";
import { createFridayLearningEventCollectionService } from "../services/friday-learning-event-collection-service.js";
import { createFridayPreferenceExtractionService } from "../services/friday-preference-extraction-service.js";
import { createFridayPreferenceFactService } from "../services/friday-preference-fact-service.js";
import { createFridayLearningPatternRecognitionService } from "../services/friday-learning-pattern-recognition-service.js";
import { createFridayLearningFeedbackLoopService } from "../services/friday-learning-feedback-loop-service.js";
import { createFridayLearningLifecycleService } from "../services/friday-learning-lifecycle-service.js";
import { createFridayLearningContextEnrichmentService } from "../services/friday-learning-context-enrichment-service.js";
import { createFridayLearningMetricsService } from "../services/friday-learning-metrics-service.js";
import { createFridaySelfLearningPipelineService } from "../services/friday-self-learning-pipeline-service.js";
import type {
  FridaySelfLearningRuntime,
  CreateFridaySelfLearningRuntimeDeps,
} from "./friday-self-learning-runtime.types.js";

export function createFridaySelfLearningRuntime(
  deps: CreateFridaySelfLearningRuntimeDeps,
): FridaySelfLearningRuntime {
  // 1. Reuse existing learning event ledger
  const ledger = createFridayLearningEventLedger({ db: deps.db });

  // 2. Create repositories
  const factRepo = createFridayPreferenceFactRepository();
  const incidentRepo = createFridayErrorIncidentRepository();
  const diagnosisRepo = createFridayDiagnosisRecordRepository();
  const lessonRepo = createFridayLearnedLessonRepository();
  const metricsRepo = createFridayLearningMetricsRepository();

  // 3. Create extraction service
  const extraction = createFridayPreferenceExtractionService({
    idGenerator: deps.idGenerator,
  });

  // 4. Create fact service
  const facts = createFridayPreferenceFactService({
    db: deps.db,
    factRepo,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  // 5. Create event collection service
  const events = createFridayLearningEventCollectionService({ ledger });

  // 6. Create pattern recognition service
  const patterns = createFridayLearningPatternRecognitionService({
    db: deps.db,
    incidentRepo,
    factRepo,
    idGenerator: deps.idGenerator,
  });

  // 7. Create lifecycle service
  const lifecycle = createFridayLearningLifecycleService({
    db: deps.db,
    factRepo,
  });

  // 8. Create feedback loop service
  const feedback = createFridayLearningFeedbackLoopService({
    db: deps.db,
    factRepo,
    extraction,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  // 9. Create context enrichment service
  const context = createFridayLearningContextEnrichmentService({
    db: deps.db,
    factService: facts,
    patternService: patterns,
    lifecycleService: lifecycle,
  });

  // 10. Create metrics service
  const metrics = createFridayLearningMetricsService({
    db: deps.db,
    metricsRepo,
    nowIso: deps.nowIso,
  });

  // 11. Create pipeline orchestrator
  const pipeline = createFridaySelfLearningPipelineService({
    db: deps.db,
    events,
    extraction,
    facts,
    lifecycle,
    incidentRepo,
    diagnosisRepo,
    lessonRepo,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  return {
    events,
    extraction,
    facts,
    patterns,
    feedback,
    lifecycle,
    context,
    metrics,
    pipeline,
  };
}
```

### `src/learning/runtime/friday-self-learning-runtime.types.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayLearningEventCollectionService } from "../services/friday-learning-event-collection-service.js";
import type { FridayPreferenceExtractionService } from "../services/friday-preference-extraction-service.js";
import type { FridayPreferenceFactService } from "../services/friday-preference-fact-service.js";
import type { FridayLearningPatternRecognitionService } from "../services/friday-learning-pattern-recognition-service.js";
import type { FridayLearningFeedbackLoopService } from "../services/friday-learning-feedback-loop-service.js";
import type { FridayLearningLifecycleService } from "../services/friday-learning-lifecycle-service.js";
import type { FridayLearningContextEnrichmentService } from "../services/friday-learning-context-enrichment-service.js";
import type { FridayLearningMetricsService } from "../services/friday-learning-metrics-service.js";
import type { FridaySelfLearningPipelineService } from "../services/friday-self-learning-pipeline-service.js";

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

### `src/learning/services/friday-learning-context-enrichment-service.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayPreferenceFactService } from "./friday-preference-fact-service.js";
import type { FridayLearningPatternRecognitionService } from "./friday-learning-pattern-recognition-service.js";
import type { FridayLearningLifecycleService } from "./friday-learning-lifecycle-service.js";
import type {
  FridayLearningContext,
  JsonValue,
} from "../model/friday-learning.types.js";
import { FRIDAY_LEARNING_DEFAULTS } from "../model/friday-learning.types.js";

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

export interface CreateContextEnrichmentServiceDeps {
  db: FridaySqliteLayer;
  factService: FridayPreferenceFactService;
  patternService: FridayLearningPatternRecognitionService;
  lifecycleService: FridayLearningLifecycleService;
  contextUseThreshold?: number;
  lookbackDays?: number;
}

export function createFridayLearningContextEnrichmentService(
  deps: CreateContextEnrichmentServiceDeps,
): FridayLearningContextEnrichmentService {
  const contextUseThreshold =
    deps.contextUseThreshold ?? FRIDAY_LEARNING_DEFAULTS.contextUseThreshold;
  const lookbackDays = deps.lookbackDays ?? 30;

  return {
    buildContext(input) {
      const { userId, nowIso, maxFacts = 50 } = input;

      const lifecycleState = deps.lifecycleService.getState(userId);

      const activeFacts = deps.factService.listActiveFacts({
        userId,
        minConfidence: contextUseThreshold,
        limit: maxFacts,
      });

      const preferences: Record<string, JsonValue> = {};
      const appliedFacts: FridayLearningContext["appliedFacts"] = [];

      for (const fact of activeFacts) {
        preferences[fact.key] = fact.value;
        appliedFacts.push({
          factId: fact.factId,
          key: fact.key,
          confidence: fact.confidence,
        });
      }

      const activePatterns = deps.patternService.detectUserPatterns({
        userId,
        nowIso,
        lookbackDays,
      });

      return {
        userId,
        lifecycleState,
        preferences,
        appliedFacts,
        activePatterns,
        generatedAt: nowIso,
      };
    },

    enrichSkillPayload(input) {
      const { userId, payload, nowIso } = input;

      // Skip enrichment when no resolvable userId
      if (!userId) {
        return { ...payload };
      }

      const context = this.buildContext({ userId, nowIso });

      // Do not mutate original payload object
      const enriched = { ...payload };

      // Add reserved envelope
      (enriched as Record<string, unknown>)["__fridayLearning"] = {
        lifecycleState: context.lifecycleState,
        preferences: context.preferences,
        appliedFacts: context.appliedFacts,
        activePatterns: context.activePatterns,
        generatedAt: context.generatedAt,
      };

      return enriched;
    },
  };
}
```

### `src/learning/services/friday-learning-event-collection-service.ts`
```ts
import type { FridayLearningEventLedger } from "../../ledger/learning/friday-learning-event-ledger.js";
import type { FridayLearningEventAppendInput } from "../../ledger/learning/friday-learning-event-ledger.types.js";

export interface FridayLearningEventCollectionService {
  collect(event: FridayLearningEventAppendInput): { inserted: boolean };
  collectBatch(
    events: FridayLearningEventAppendInput[],
  ): Array<{ eventId: string; inserted: boolean }>;
}

export interface CreateLearningEventCollectionServiceDeps {
  ledger: FridayLearningEventLedger;
}

export function createFridayLearningEventCollectionService(
  deps: CreateLearningEventCollectionServiceDeps,
): FridayLearningEventCollectionService {
  return {
    collect(event) {
      return deps.ledger.appendEvent(event);
    },
    collectBatch(events) {
      return deps.ledger.appendBatch(events);
    },
  };
}
```

### `src/learning/services/friday-learning-feedback-loop-service.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayPreferenceFactRepository } from "../persistence/friday-preference-fact-repository.js";
import type { FridayPreferenceExtractionService } from "./friday-preference-extraction-service.js";
import type {
  FridayLearningEventAppendInput,
  FridayPreferenceFactEntity,
  JsonValue,
} from "../model/friday-learning.types.js";

export interface FridayLearningFeedbackLoopService {
  applyCorrection(event: FridayLearningEventAppendInput): {
    accepted: boolean;
    updatedFacts: FridayPreferenceFactEntity[];
  };
}

export interface CreateFeedbackLoopServiceDeps {
  db: FridaySqliteLayer;
  factRepo: FridayPreferenceFactRepository;
  extraction: FridayPreferenceExtractionService;
  idGenerator: () => string;
  nowIso: () => string;
}

export function createFridayLearningFeedbackLoopService(
  deps: CreateFeedbackLoopServiceDeps,
): FridayLearningFeedbackLoopService {
  return {
    applyCorrection(event) {
      if (event.kind !== "user_correction") {
        return { accepted: false, updatedFacts: [] };
      }

      const signals = deps.extraction.extract(event);
      const correctionSignals = signals.filter(
        (s) => s.kind === "correction",
      );

      if (correctionSignals.length === 0) {
        return { accepted: false, updatedFacts: [] };
      }

      const updatedFacts = deps.db.withWriteTransaction((db) => {
        const results: FridayPreferenceFactEntity[] = [];

        for (const signal of correctionSignals) {
          // Corrections always get high confidence (1.0) and overwrite value
          const existing = deps.factRepo.getByUserAndKey(
            db,
            event.userId,
            signal.key,
          );

          const entity = deps.factRepo.upsert(db, {
            factId: existing?.factId ?? deps.idGenerator(),
            userId: event.userId,
            key: signal.key,
            value: signal.value,
            confidence: signal.confidence, // 1.0 for corrections
            evidenceCountDelta: 1,
            lastConfirmedAt: event.ts,
            sourceEventId: event.eventId,
            nowIso: event.ts,
          });

          results.push(entity);
        }

        return results;
      });

      return { accepted: true, updatedFacts };
    },
  };
}
```

### `src/learning/services/friday-learning-lifecycle-service.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayPreferenceFactRepository } from "../persistence/friday-preference-fact-repository.js";
import type {
  FridayLearningLifecycleState,
} from "../model/friday-learning.types.js";
import { FRIDAY_LEARNING_DEFAULTS } from "../model/friday-learning.types.js";

export interface FridayLearningLifecycleService {
  getState(userId: string): FridayLearningLifecycleState;
}

export interface CreateLifecycleServiceDeps {
  db: FridaySqliteLayer;
  factRepo: FridayPreferenceFactRepository;
  warmupFactCount?: number;
  steadyStateFactCount?: number;
  steadyStateThreshold?: number;
}

export function createFridayLearningLifecycleService(
  deps: CreateLifecycleServiceDeps,
): FridayLearningLifecycleService {
  const warmupFactCount =
    deps.warmupFactCount ?? FRIDAY_LEARNING_DEFAULTS.warmupFactCount;
  const steadyStateFactCount =
    deps.steadyStateFactCount ?? FRIDAY_LEARNING_DEFAULTS.steadyStateFactCount;
  const steadyStateThreshold =
    deps.steadyStateThreshold ?? FRIDAY_LEARNING_DEFAULTS.steadyStateThreshold;

  return {
    getState(userId) {
      return deps.db.withReadConnection((db) => {
        // Count high-confidence facts
        const allFacts = deps.factRepo.listByUser(db, userId, 0, 1000);
        const highConfidenceFacts = allFacts.filter(
          (f) => f.confidence >= steadyStateThreshold,
        );

        if (highConfidenceFacts.length >= steadyStateFactCount) {
          return "steady_state";
        }

        if (allFacts.length >= warmupFactCount) {
          return "warmup";
        }

        return "cold_start";
      });
    },
  };
}
```

### `src/learning/services/friday-learning-metrics-service.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayLearningMetricsRepository } from "../persistence/friday-learning-metrics-repository.js";
import type { FridayLearningMetricsEntity } from "../model/friday-learning.types.js";

export interface FridayLearningMetricsService {
  aggregateDay(day: string): FridayLearningMetricsEntity;
  aggregateRange(
    fromDay: string,
    toDay: string,
  ): FridayLearningMetricsEntity[];
}

export interface CreateLearningMetricsServiceDeps {
  db: FridaySqliteLayer;
  metricsRepo: FridayLearningMetricsRepository;
  nowIso: () => string;
}

export function createFridayLearningMetricsService(
  deps: CreateLearningMetricsServiceDeps,
): FridayLearningMetricsService {
  function aggregateSingleDay(day: string): FridayLearningMetricsEntity {
    return deps.db.withWriteTransaction((db) => {
      const dayStart = `${day}T00:00:00.000Z`;
      const dayEnd = `${day}T23:59:59.999Z`;

      // Count incidents for the day
      const incidentCount = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM error_incidents
           WHERE ts >= ? AND ts <= ?`,
        )
        .get(dayStart, dayEnd) as { cnt: number };

      // Count facts updated for the day
      const factsCount = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM preference_facts
           WHERE updated_at >= ? AND updated_at <= ?`,
        )
        .get(dayStart, dayEnd) as { cnt: number };

      // Compute success rate from workflow outcomes
      const totalOutcomes = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM learning_events
           WHERE kind = 'workflow_outcome' AND ts >= ? AND ts <= ?`,
        )
        .get(dayStart, dayEnd) as { cnt: number };

      let successRate: number | undefined;
      if (totalOutcomes.cnt > 0) {
        const successOutcomes = db
          .prepare(
            `SELECT COUNT(*) as cnt FROM learning_events
             WHERE kind = 'workflow_outcome' AND ts >= ? AND ts <= ?
             AND json_extract(payload_json, '$.success') = 1`,
          )
          .get(dayStart, dayEnd) as { cnt: number };
        successRate = successOutcomes.cnt / totalOutcomes.cnt;
      }

      const nowIso = deps.nowIso();

      const metric: FridayLearningMetricsEntity = {
        day,
        successRate,
        autoFixSuccessRate: undefined, // Phase 6: always null
        rollbackRate: undefined, // Phase 6: always null
        incidentsTotal: incidentCount.cnt,
        factsUpdated: factsCount.cnt,
        actionsExecuted: 0, // Phase 6: always 0
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      return deps.metricsRepo.upsertDay(db, metric);
    });
  }

  return {
    aggregateDay: aggregateSingleDay,

    aggregateRange(fromDay, toDay) {
      // Generate day strings from fromDay to toDay
      const results: FridayLearningMetricsEntity[] = [];
      const start = new Date(`${fromDay}T00:00:00.000Z`);
      const end = new Date(`${toDay}T00:00:00.000Z`);

      const current = new Date(start);
      while (current <= end) {
        const dayStr = current.toISOString().slice(0, 10);
        results.push(aggregateSingleDay(dayStr));
        current.setDate(current.getDate() + 1);
      }

      return results;
    },
  };
}
```

### `src/learning/services/friday-learning-pattern-recognition-service.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayErrorIncidentRepository } from "../persistence/friday-error-incident-repository.js";
import type { FridayPreferenceFactRepository } from "../persistence/friday-preference-fact-repository.js";
import type {
  FridayLearningPattern,
  FridayLearningEventKind,
  JsonObject,
} from "../model/friday-learning.types.js";

export interface FridayLearningPatternRecognitionService {
  detectUserPatterns(input: {
    userId: string;
    nowIso: string;
    lookbackDays: number;
  }): FridayLearningPattern[];
}

export interface CreatePatternRecognitionServiceDeps {
  db: FridaySqliteLayer;
  incidentRepo: FridayErrorIncidentRepository;
  factRepo: FridayPreferenceFactRepository;
  idGenerator: () => string;
}

function subtractDays(iso: string, days: number): string {
  const ms = new Date(iso).getTime() - days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

function computeStrength(
  occurrences: number,
  recencyMultiplier: number,
  confidenceMultiplier: number,
): number {
  const raw =
    (Math.log2(1 + occurrences) / 3) *
    recencyMultiplier *
    confidenceMultiplier;
  return Math.min(1, Math.max(0, raw));
}

export function createFridayLearningPatternRecognitionService(
  deps: CreatePatternRecognitionServiceDeps,
): FridayLearningPatternRecognitionService {
  return {
    detectUserPatterns(input) {
      const { userId, nowIso, lookbackDays } = input;
      const patterns: FridayLearningPattern[] = [];
      const windowStart = subtractDays(nowIso, lookbackDays);

      // 1. Recurring incident signatures (>= 3 in lookback window)
      deps.db.withReadConnection((db) => {
        const incidents = deps.incidentRepo.listByUser(db, {
          userId,
          fromTs: windowStart,
          toTs: nowIso,
          limit: 500,
        });

        const signatureCounts = new Map<string, number>();
        for (const inc of incidents) {
          signatureCounts.set(
            inc.signature,
            (signatureCounts.get(inc.signature) ?? 0) + 1,
          );
        }

        for (const [signature, count] of signatureCounts) {
          if (count >= 3) {
            patterns.push({
              patternId: deps.idGenerator(),
              userId,
              kind: "recurring_incident_signature",
              key: signature,
              strength: computeStrength(count, 1.0, 1.0),
              occurrences: count,
              windowStart,
              windowEnd: nowIso,
              evidence: { signature, count } as unknown as JsonObject,
            });
          }
        }

        // 2. Recurring correction keys (>= 2 in 14 days)
        const correctionWindow = subtractDays(nowIso, Math.min(lookbackDays, 14));
        const correctionRows = db
          .prepare(
            `SELECT payload_json FROM learning_events
             WHERE user_id = ? AND kind = 'user_correction'
             AND ts >= ? AND ts <= ?
             ORDER BY ts DESC`,
          )
          .all(userId, correctionWindow, nowIso) as Array<{
          payload_json: string;
        }>;

        const correctionKeyCounts = new Map<string, number>();
        for (const row of correctionRows) {
          const payload = JSON.parse(row.payload_json) as Record<
            string,
            unknown
          >;
          const field = payload["correctedField"] as string | undefined;
          if (field) {
            const normalized = field
              .trim()
              .toLowerCase()
              .replace(/[^a-z0-9_]/g, "_");
            correctionKeyCounts.set(
              normalized,
              (correctionKeyCounts.get(normalized) ?? 0) + 1,
            );
          }
        }

        for (const [key, count] of correctionKeyCounts) {
          if (count >= 2) {
            patterns.push({
              patternId: deps.idGenerator(),
              userId,
              kind: "recurring_correction_key",
              key,
              strength: computeStrength(count, 1.0, 1.0),
              occurrences: count,
              windowStart: correctionWindow,
              windowEnd: nowIso,
              evidence: { correctedField: key, count } as unknown as JsonObject,
            });
          }
        }

        // 3. Stable preference keys (evidence_count >= 4, confidence >= 0.75, no contradictions in 30 days)
        const facts = deps.factRepo.listByUser(db, userId, 0.75, 100);
        for (const fact of facts) {
          if (fact.evidenceCount >= 4) {
            // Check for contradictions: corrections on the same key in last 30 days
            const contradictionWindow = subtractDays(nowIso, 30);
            const contradictions = db
              .prepare(
                `SELECT COUNT(*) as cnt FROM learning_events
                 WHERE user_id = ? AND kind = 'user_correction'
                 AND ts >= ?
                 AND json_extract(payload_json, '$.correctedField') = ?`,
              )
              .get(userId, contradictionWindow, fact.key.replace(/^pref:/, "")) as { cnt: number };

            if (contradictions.cnt === 0) {
              patterns.push({
                patternId: deps.idGenerator(),
                userId,
                kind: "stable_preference_key",
                key: fact.key,
                strength: computeStrength(
                  fact.evidenceCount,
                  1.0,
                  fact.confidence,
                ),
                occurrences: fact.evidenceCount,
                windowStart: fact.createdAt,
                windowEnd: nowIso,
                evidence: {
                  factId: fact.factId,
                  confidence: fact.confidence,
                  evidenceCount: fact.evidenceCount,
                } as unknown as JsonObject,
              });
            }
          }
        }

        // 4. Drifting preference keys (same key changed to >= 2 distinct values in 30 days)
        const driftWindow = subtractDays(nowIso, 30);
        const driftRows = db
          .prepare(
            `SELECT payload_json FROM learning_events
             WHERE user_id = ? AND kind = 'user_correction'
             AND ts >= ? AND ts <= ?`,
          )
          .all(userId, driftWindow, nowIso) as Array<{
          payload_json: string;
        }>;

        const fieldValues = new Map<string, Set<string>>();
        for (const row of driftRows) {
          const payload = JSON.parse(row.payload_json) as Record<
            string,
            unknown
          >;
          const field = payload["correctedField"] as string | undefined;
          const newVal = payload["newValue"];
          if (field && newVal !== undefined) {
            const normalized = field
              .trim()
              .toLowerCase()
              .replace(/[^a-z0-9_]/g, "_");
            if (!fieldValues.has(normalized)) {
              fieldValues.set(normalized, new Set());
            }
            fieldValues.get(normalized)!.add(JSON.stringify(newVal));
          }
        }

        for (const [key, values] of fieldValues) {
          if (values.size >= 2) {
            patterns.push({
              patternId: deps.idGenerator(),
              userId,
              kind: "drifting_preference_key",
              key,
              strength: computeStrength(values.size, 0.8, 0.7),
              occurrences: values.size,
              windowStart: driftWindow,
              windowEnd: nowIso,
              evidence: {
                distinctValues: values.size,
              } as unknown as JsonObject,
            });
          }
        }
      });

      return patterns;
    },
  };
}
```

### `src/learning/services/friday-preference-extraction-service.ts`
```ts
import { createHash } from "node:crypto";
import type {
  FridayExtractedSignal,
  FridayLearningEventAppendInput,
  FridayLearningSignalKind,
} from "../model/friday-learning.types.js";

export interface FridayPreferenceExtractionService {
  extract(event: FridayLearningEventAppendInput): FridayExtractedSignal[];
}

export interface CreatePreferenceExtractionServiceDeps {
  idGenerator: () => string;
}

/** Normalize a field name to a stable preference key. */
function normalizeKey(field: string): string {
  return field
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/** Generate a deterministic signature hash. */
function computeSignature(kind: string, key: string, context: string): string {
  return createHash("sha256")
    .update(`${kind}:${key}:${context}`)
    .digest("hex")
    .slice(0, 16);
}

interface PreferenceRule {
  pattern: RegExp;
  keyExtractor: (match: RegExpMatchArray) => string;
  valueExtractor: (match: RegExpMatchArray) => string;
  confidence: number;
}

const PREFERENCE_RULES: PreferenceRule[] = [
  {
    pattern: /\bprefer\s+(.+?)(?:\s+for\s+(.+?))?$/i,
    keyExtractor: (m) => m[2] ? `pref:${normalizeKey(m[2]!)}` : `pref:${normalizeKey(m[1]!)}`,
    valueExtractor: (m) => m[2] ? m[1]!.trim() : m[1]!.trim(),
    confidence: 0.80,
  },
  {
    pattern: /\balways\s+use\s+(.+?)(?:\s+for\s+(.+?))?$/i,
    keyExtractor: (m) => m[2] ? `pref:${normalizeKey(m[2]!)}` : `pref:${normalizeKey(m[1]!)}`,
    valueExtractor: (m) => m[2] ? m[1]!.trim() : m[1]!.trim(),
    confidence: 0.80,
  },
  {
    pattern: /\bdon'?t\s+use\s+(.+?)$/i,
    keyExtractor: (m) => `pref:avoid_${normalizeKey(m[1]!)}`,
    valueExtractor: (m) => m[1]!.trim(),
    confidence: 0.80,
  },
  {
    pattern: /\bcall\s+me\s+(.+?)$/i,
    keyExtractor: () => "pref:display_name",
    valueExtractor: (m) => m[1]!.trim(),
    confidence: 0.80,
  },
];

export function createFridayPreferenceExtractionService(
  deps: CreatePreferenceExtractionServiceDeps,
): FridayPreferenceExtractionService {
  return {
    extract(event) {
      const signals: FridayExtractedSignal[] = [];

      const makeSignal = (
        kind: FridayLearningSignalKind,
        key: string,
        value: unknown,
        confidence: number,
      ): FridayExtractedSignal => ({
        signalId: deps.idGenerator(),
        kind,
        key,
        value: value as FridayExtractedSignal["value"],
        confidence,
        sourceEventId: event.eventId,
        userId: event.userId,
        sessionId: event.sessionId,
        runId: event.runId,
        ts: event.ts,
      });

      switch (event.kind) {
        case "user_correction": {
          const correctedField = event.payload["correctedField"] as
            | string
            | undefined;
          const newValue = event.payload["newValue"];
          if (correctedField && newValue !== undefined) {
            const key = `pref:${normalizeKey(correctedField)}`;
            signals.push(makeSignal("correction", key, newValue, 1.0));
          }
          break;
        }

        case "user_message": {
          const text = event.payload["text"] as string | undefined;
          if (text) {
            for (const rule of PREFERENCE_RULES) {
              const match = text.match(rule.pattern);
              if (match) {
                const key = rule.keyExtractor(match);
                const value = rule.valueExtractor(match);
                signals.push(
                  makeSignal("preference", key, value, rule.confidence),
                );
                break; // first match wins
              }
            }
          }
          break;
        }

        case "tool_result": {
          const ok = event.payload["ok"];
          const errorPayload = event.payload["error"];
          if (ok === false || errorPayload) {
            const toolName =
              (event.payload["toolName"] as string) ?? "unknown";
            const errorCode =
              (event.payload["errorCode"] as string) ?? "unknown";
            const key = `tool_failure:${normalizeKey(toolName)}:${normalizeKey(errorCode)}`;
            const sig = computeSignature("tool_result", key, toolName);
            signals.push(
              makeSignal("error", key, { toolName, errorCode, signature: sig }, 1.0),
            );
          }
          break;
        }

        case "error_incident": {
          const category =
            (event.payload["category"] as string) ?? "unknown";
          const errorMsg =
            (event.payload["message"] as string) ?? "unknown_error";
          const key = `incident:${normalizeKey(category)}:${normalizeKey(errorMsg)}`;
          const sig = computeSignature(
            "error_incident",
            key,
            category,
          );
          signals.push(
            makeSignal("error", key, { category, message: errorMsg, signature: sig }, 1.0),
          );
          break;
        }

        case "workflow_outcome": {
          const success = event.payload["success"];
          if (success === true) {
            // Low-weight reinforcement for successful outcomes
            const workflowId =
              (event.payload["workflowId"] as string) ?? "unknown";
            const key = `workflow_success:${normalizeKey(workflowId)}`;
            signals.push(
              makeSignal("positive_feedback", key, { workflowId }, 0.55),
            );
          }
          break;
        }

        case "assistant_message":
          // No preference signal to avoid self-reinforcement loops
          break;
      }

      return signals;
    },
  };
}
```

### `src/learning/services/friday-preference-fact-service.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayPreferenceFactRepository } from "../persistence/friday-preference-fact-repository.js";
import type {
  FridayExtractedSignal,
  FridayLearningEventAppendInput,
  FridayPreferenceFactEntity,
  JsonValue,
  FRIDAY_LEARNING_DEFAULTS,
} from "../model/friday-learning.types.js";

export interface FridayPreferenceFactService {
  applySignals(input: {
    event: FridayLearningEventAppendInput;
    signals: FridayExtractedSignal[];
    nowIso: string;
  }): FridayPreferenceFactEntity[];

  listActiveFacts(input: {
    userId: string;
    minConfidence: number;
    limit: number;
  }): FridayPreferenceFactEntity[];

  deleteFact(input: { userId: string; key: string }): boolean;

  runDecay(input: {
    nowIso?: string;
    userId?: string;
  }): { updated: number };
}

export interface CreatePreferenceFactServiceDeps {
  db: FridaySqliteLayer;
  factRepo: FridayPreferenceFactRepository;
  idGenerator: () => string;
  nowIso: () => string;
  halfLifeDays?: number;
  minConfidenceFloor?: number;
}

/**
 * Recompute confidence using the scoring model from the plan:
 *   existingDecayed = existingConfidence * exp(-ln(2) * daysSinceLastConfirmed / halfLifeDays)
 *   evidenceBoost   = min(0.25, 0.04 * log2(1 + newEvidenceCount))
 *   conflictPenalty  = existingValue != incomingValue ? 0.30 : 0.00
 *   newConfidence    = clamp(0.0, 1.0, 0.45 * existingDecayed + 0.55 * signalConfidence + evidenceBoost - conflictPenalty)
 */
function computeNewConfidence(
  existing: FridayPreferenceFactEntity | null,
  signalConfidence: number,
  incomingValue: JsonValue,
  nowIso: string,
  halfLifeDays: number,
): number {
  if (!existing) {
    // First evidence — signal confidence as baseline
    return Math.min(1.0, Math.max(0.0, signalConfidence));
  }

  const lastMs = new Date(existing.lastConfirmedAt).getTime();
  const nowMs = new Date(nowIso).getTime();
  const daysSince = Math.max(0, (nowMs - lastMs) / (1000 * 60 * 60 * 24));

  const existingDecayed =
    existing.confidence *
    Math.exp((-Math.LN2 * daysSince) / halfLifeDays);

  const newEvidenceCount = existing.evidenceCount + 1;
  const evidenceBoost = Math.min(0.25, 0.04 * Math.log2(1 + newEvidenceCount));

  const existingValueStr = JSON.stringify(existing.value);
  const incomingValueStr = JSON.stringify(incomingValue);
  const conflictPenalty = existingValueStr !== incomingValueStr ? 0.30 : 0.00;

  const raw =
    0.45 * existingDecayed +
    0.55 * signalConfidence +
    evidenceBoost -
    conflictPenalty;

  return Math.min(1.0, Math.max(0.0, raw));
}

export function createFridayPreferenceFactService(
  deps: CreatePreferenceFactServiceDeps,
): FridayPreferenceFactService {
  const halfLifeDays = deps.halfLifeDays ?? 30;
  const minConfidenceFloor = deps.minConfidenceFloor ?? 0.05;

  return {
    applySignals(input) {
      const { event, signals, nowIso } = input;
      const preferenceSignals = signals.filter(
        (s) => s.kind === "preference" || s.kind === "correction",
      );

      if (preferenceSignals.length === 0) return [];

      return deps.db.withWriteTransaction((db) => {
        const updated: FridayPreferenceFactEntity[] = [];

        for (const signal of preferenceSignals) {
          const existing = deps.factRepo.getByUserAndKey(
            db,
            event.userId,
            signal.key,
          );

          const newConfidence = computeNewConfidence(
            existing,
            signal.confidence,
            signal.value,
            nowIso,
            halfLifeDays,
          );

          const entity = deps.factRepo.upsert(db, {
            factId: existing?.factId ?? deps.idGenerator(),
            userId: event.userId,
            key: signal.key,
            value: signal.value,
            confidence: newConfidence,
            evidenceCountDelta: 1,
            lastConfirmedAt: nowIso,
            sourceEventId: event.eventId,
            nowIso,
          });

          updated.push(entity);
        }

        return updated;
      });
    },

    listActiveFacts(input) {
      return deps.db.withReadConnection((db) =>
        deps.factRepo.listByUser(
          db,
          input.userId,
          input.minConfidence,
          input.limit,
        ),
      );
    },

    deleteFact(input) {
      return deps.db.withWriteTransaction((db) =>
        deps.factRepo.deleteByUserAndKey(db, input.userId, input.key),
      );
    },

    runDecay(input) {
      const nowIso = input.nowIso ?? deps.nowIso();
      const updated = deps.db.withWriteTransaction((db) =>
        deps.factRepo.applyDecay(db, {
          userId: input.userId,
          nowIso,
          halfLifeDays,
          minConfidenceFloor,
        }),
      );
      return { updated };
    },
  };
}
```

### `src/learning/services/friday-self-learning-pipeline-service.ts`
```ts
import { createHash } from "node:crypto";
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayLearningEventCollectionService } from "./friday-learning-event-collection-service.js";
import type { FridayPreferenceExtractionService } from "./friday-preference-extraction-service.js";
import type { FridayPreferenceFactService } from "./friday-preference-fact-service.js";
import type { FridayLearningLifecycleService } from "./friday-learning-lifecycle-service.js";
import type { FridayErrorIncidentRepository } from "../persistence/friday-error-incident-repository.js";
import type { FridayDiagnosisRecordRepository } from "../persistence/friday-diagnosis-record-repository.js";
import type { FridayLearnedLessonRepository } from "../persistence/friday-learned-lesson-repository.js";
import type {
  FridayLearningEventAppendInput,
  FridaySelfLearningProcessResult,
  FridayErrorIncidentEntity,
  FridayDiagnosisRecordEntity,
  FridayLearnedLessonEntity,
  JsonObject,
} from "../model/friday-learning.types.js";

export interface FridaySelfLearningPipelineService {
  processEvent(
    event: FridayLearningEventAppendInput,
  ): FridaySelfLearningProcessResult;
  processBatch(
    events: FridayLearningEventAppendInput[],
  ): FridaySelfLearningProcessResult[];
}

export interface CreateSelfLearningPipelineServiceDeps {
  db: FridaySqliteLayer;
  events: FridayLearningEventCollectionService;
  extraction: FridayPreferenceExtractionService;
  facts: FridayPreferenceFactService;
  lifecycle: FridayLearningLifecycleService;
  incidentRepo: FridayErrorIncidentRepository;
  diagnosisRepo: FridayDiagnosisRecordRepository;
  lessonRepo: FridayLearnedLessonRepository;
  idGenerator: () => string;
  nowIso: () => string;
}

function computeIncidentSignature(
  category: string,
  key: string,
  context: string,
): string {
  return createHash("sha256")
    .update(`incident:${category}:${key}:${context}`)
    .digest("hex")
    .slice(0, 16);
}

export function createFridaySelfLearningPipelineService(
  deps: CreateSelfLearningPipelineServiceDeps,
): FridaySelfLearningPipelineService {
  function processOne(
    event: FridayLearningEventAppendInput,
  ): FridaySelfLearningProcessResult {
    // 1. Collect event
    const { inserted } = deps.events.collect(event);

    // 2. Extract signals
    const extractedSignals = deps.extraction.extract(event);

    // 3. Update facts
    const nowIso = deps.nowIso();
    const factsUpdated = deps.facts.applySignals({
      event,
      signals: extractedSignals,
      nowIso,
    });

    // 4. Classify/create incidents if error signals exist
    const errorSignals = extractedSignals.filter((s) => s.kind === "error");
    const incidentsCreated: FridayErrorIncidentEntity[] = [];
    const diagnosisCreated: FridayDiagnosisRecordEntity[] = [];
    const lessonsUpdated: FridayLearnedLessonEntity[] = [];

    if (errorSignals.length > 0) {
      deps.db.withWriteTransaction((db) => {
        for (const signal of errorSignals) {
          const signalValue = signal.value as JsonObject;
          const category =
            (signalValue["category"] as string) ??
            (signal.key.startsWith("tool_failure:") ? "tool" : "workflow");
          const signature =
            (signalValue["signature"] as string) ??
            computeIncidentSignature(category, signal.key, signal.sourceEventId);

          // Create incident
          const incident: FridayErrorIncidentEntity = {
            incidentId: deps.idGenerator(),
            userId: signal.userId,
            runId: signal.runId,
            nodeId: undefined,
            ts: signal.ts,
            category: category as FridayErrorIncidentEntity["category"],
            severity: "medium",
            signature,
            context: signalValue,
            autoFixEligible: false, // Phase 6 invariant
            status: "open",
            createdAt: nowIso,
            updatedAt: nowIso,
          };

          deps.incidentRepo.insert(db, incident);
          incidentsCreated.push(incident);

          // 5. Create diagnosis record
          const diagnosis: FridayDiagnosisRecordEntity = {
            id: deps.idGenerator(),
            incidentId: incident.incidentId,
            runId: signal.runId,
            nodeId: undefined,
            errorFingerprint: signature,
            confidence: signal.confidence,
            diagnosis: {
              signalKey: signal.key,
              category,
              autoDetected: true,
            } as unknown as JsonObject,
            createdAt: nowIso,
            updatedAt: nowIso,
          };

          deps.diagnosisRepo.insert(db, diagnosis);
          diagnosisCreated.push(diagnosis);

          // 6. Update learned lessons
          const lesson = deps.lessonRepo.upsertByFingerprint(db, {
            id: deps.idGenerator(),
            fingerprint: signature,
            title: `Error: ${signal.key}`,
            cause: `Detected via ${event.kind} event`,
            fix: `Review ${category} configuration`,
            sourceIncidentId: incident.incidentId,
            sourceDiagnosisId: diagnosis.id,
            nowIso,
          });

          lessonsUpdated.push(lesson);
        }
      });
    }

    // 7. Recompute lifecycle state
    const lifecycleState = deps.lifecycle.getState(event.userId);

    return {
      eventId: event.eventId,
      inserted,
      extractedSignals,
      factsUpdated,
      incidentsCreated,
      diagnosisCreated,
      lessonsUpdated,
      lifecycleState,
    };
  }

  return {
    processEvent: processOne,
    processBatch(events) {
      return events.map(processOne);
    },
  };
}
```

### `src/jobs/learning/friday-learning-metrics-job.ts`
```ts
import type { FridayLearningMetricsService } from "../../learning/services/friday-learning-metrics-service.js";
import type { FridayLearningMetricsJobResult } from "./friday-learning-metrics.types.js";

export interface FridayLearningMetricsJob {
  run(dayOverride?: string): FridayLearningMetricsJobResult;
}

export interface CreateLearningMetricsJobDeps {
  metricsService: FridayLearningMetricsService;
  nowIso: () => string;
}

export function createFridayLearningMetricsJob(
  deps: CreateLearningMetricsJobDeps,
): FridayLearningMetricsJob {
  return {
    run(dayOverride?) {
      const day =
        dayOverride ?? deps.nowIso().slice(0, 10);
      const metric = deps.metricsService.aggregateDay(day);
      return { day, metric };
    },
  };
}
```

### `src/jobs/learning/friday-learning-metrics.types.ts`
```ts
import type { FridayLearningMetricsEntity } from "../../learning/model/friday-learning.types.js";

export interface FridayLearningMetricsJobResult {
  day: string;
  metric: FridayLearningMetricsEntity;
}
```

## Test Code
### `test/unit/learning/persistence/friday-error-incident-repository.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb } from "../../satellites/_helpers/create-test-db.js";
import { createFridayErrorIncidentRepository } from "../../../../src/learning/persistence/friday-error-incident-repository.js";
import type { FridayErrorIncidentRepository } from "../../../../src/learning/persistence/friday-error-incident-repository.js";
import type { FridayErrorIncidentEntity } from "../../../../src/learning/model/friday-learning.types.js";

describe("FridayErrorIncidentRepository", () => {
  let db: FridaySqliteLayer;
  let repo: FridayErrorIncidentRepository;
  const NOW = "2025-06-15T10:00:00.000Z";

  const baseIncident: FridayErrorIncidentEntity = {
    incidentId: "inc-001",
    userId: "test-user",
    ts: NOW,
    category: "tool",
    severity: "medium",
    signature: "sig-abc123",
    context: { toolName: "search", error: "timeout" },
    autoFixEligible: false,
    status: "open",
    createdAt: NOW,
    updatedAt: NOW,
  };

  beforeEach(() => {
    db = createTestDb();
    repo = createFridayErrorIncidentRepository();
  });

  afterEach(() => {
    db.close();
  });

  it("inserts and retrieves an incident", () => {
    repo.insert(db.writer, baseIncident);
    const results = repo.listByUser(db.writer, { userId: "test-user" });
    expect(results).toHaveLength(1);
    expect(results[0]!.incidentId).toBe("inc-001");
    expect(results[0]!.context).toEqual({
      toolName: "search",
      error: "timeout",
    });
    expect(results[0]!.autoFixEligible).toBe(false);
  });

  it("listByUser filters by status", () => {
    repo.insert(db.writer, baseIncident);
    repo.insert(db.writer, {
      ...baseIncident,
      incidentId: "inc-002",
      status: "resolved",
    });

    const open = repo.listByUser(db.writer, {
      userId: "test-user",
      status: "open",
    });
    expect(open).toHaveLength(1);
    expect(open[0]!.incidentId).toBe("inc-001");

    const resolved = repo.listByUser(db.writer, {
      userId: "test-user",
      status: "resolved",
    });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.incidentId).toBe("inc-002");
  });

  it("listByUser filters by time range", () => {
    repo.insert(db.writer, {
      ...baseIncident,
      incidentId: "inc-001",
      ts: "2025-06-15T08:00:00.000Z",
    });
    repo.insert(db.writer, {
      ...baseIncident,
      incidentId: "inc-002",
      ts: "2025-06-15T12:00:00.000Z",
    });
    repo.insert(db.writer, {
      ...baseIncident,
      incidentId: "inc-003",
      ts: "2025-06-15T16:00:00.000Z",
    });

    const filtered = repo.listByUser(db.writer, {
      userId: "test-user",
      fromTs: "2025-06-15T10:00:00.000Z",
      toTs: "2025-06-15T14:00:00.000Z",
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.incidentId).toBe("inc-002");
  });

  it("listByUser respects limit", () => {
    for (let i = 0; i < 5; i++) {
      repo.insert(db.writer, {
        ...baseIncident,
        incidentId: `inc-${i}`,
        ts: `2025-06-15T1${i}:00:00.000Z`,
      });
    }

    const limited = repo.listByUser(db.writer, {
      userId: "test-user",
      limit: 2,
    });
    expect(limited).toHaveLength(2);
  });

  it("findRecentBySignature returns matching incidents", () => {
    repo.insert(db.writer, baseIncident);
    repo.insert(db.writer, {
      ...baseIncident,
      incidentId: "inc-002",
      signature: "sig-abc123",
      ts: "2025-06-15T11:00:00.000Z",
    });
    repo.insert(db.writer, {
      ...baseIncident,
      incidentId: "inc-003",
      signature: "sig-different",
      ts: "2025-06-15T12:00:00.000Z",
    });

    const results = repo.findRecentBySignature(
      db.writer,
      "test-user",
      "sig-abc123",
    );
    expect(results).toHaveLength(2);
    // Most recent first
    expect(results[0]!.incidentId).toBe("inc-002");
  });

  it("handles optional nodeId", () => {
    repo.insert(db.writer, {
      ...baseIncident,
      nodeId: "node-abc",
    });

    const results = repo.listByUser(db.writer, { userId: "test-user" });
    expect(results[0]!.nodeId).toBe("node-abc");
  });

  it("handles missing optional fields as undefined", () => {
    repo.insert(db.writer, baseIncident);

    const results = repo.listByUser(db.writer, { userId: "test-user" });
    expect(results[0]!.runId).toBeUndefined();
    expect(results[0]!.nodeId).toBeUndefined();
  });
});
```

### `test/unit/learning/persistence/friday-learning-metrics-repository.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb } from "../../satellites/_helpers/create-test-db.js";
import { createFridayLearningMetricsRepository } from "../../../../src/learning/persistence/friday-learning-metrics-repository.js";
import type { FridayLearningMetricsRepository } from "../../../../src/learning/persistence/friday-learning-metrics-repository.js";
import type { FridayLearningMetricsEntity } from "../../../../src/learning/model/friday-learning.types.js";

describe("FridayLearningMetricsRepository", () => {
  let db: FridaySqliteLayer;
  let repo: FridayLearningMetricsRepository;
  const NOW = "2025-06-15T10:00:00.000Z";

  const baseMetric: FridayLearningMetricsEntity = {
    day: "2025-06-15",
    successRate: 0.85,
    incidentsTotal: 3,
    factsUpdated: 5,
    actionsExecuted: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };

  beforeEach(() => {
    db = createTestDb();
    repo = createFridayLearningMetricsRepository();
  });

  afterEach(() => {
    db.close();
  });

  it("upsertDay inserts a new day metric", () => {
    const result = repo.upsertDay(db.writer, baseMetric);
    expect(result.day).toBe("2025-06-15");
    expect(result.successRate).toBe(0.85);
    expect(result.incidentsTotal).toBe(3);
    expect(result.factsUpdated).toBe(5);
    expect(result.actionsExecuted).toBe(0);
  });

  it("upsertDay updates existing day metric on conflict", () => {
    repo.upsertDay(db.writer, baseMetric);

    const updated = repo.upsertDay(db.writer, {
      ...baseMetric,
      successRate: 0.90,
      incidentsTotal: 5,
      updatedAt: "2025-06-15T12:00:00.000Z",
    });

    expect(updated.successRate).toBe(0.90);
    expect(updated.incidentsTotal).toBe(5);
  });

  it("getDay returns null for non-existent day", () => {
    const result = repo.getDay(db.writer, "2025-01-01");
    expect(result).toBeNull();
  });

  it("getDay returns the metric for existing day", () => {
    repo.upsertDay(db.writer, baseMetric);
    const result = repo.getDay(db.writer, "2025-06-15");
    expect(result).not.toBeNull();
    expect(result!.day).toBe("2025-06-15");
  });

  it("listDays returns metrics in descending order", () => {
    for (let d = 15; d <= 18; d++) {
      repo.upsertDay(db.writer, {
        ...baseMetric,
        day: `2025-06-${d}`,
        incidentsTotal: d,
      });
    }

    const results = repo.listDays(db.writer);
    expect(results).toHaveLength(4);
    expect(results[0]!.day).toBe("2025-06-18");
    expect(results[3]!.day).toBe("2025-06-15");
  });

  it("listDays filters by date range", () => {
    for (let d = 15; d <= 18; d++) {
      repo.upsertDay(db.writer, {
        ...baseMetric,
        day: `2025-06-${d}`,
      });
    }

    const filtered = repo.listDays(db.writer, "2025-06-16", "2025-06-17");
    expect(filtered).toHaveLength(2);
  });

  it("listDays respects limit", () => {
    for (let d = 10; d <= 20; d++) {
      repo.upsertDay(db.writer, {
        ...baseMetric,
        day: `2025-06-${d}`,
      });
    }

    const limited = repo.listDays(db.writer, undefined, undefined, 3);
    expect(limited).toHaveLength(3);
  });

  it("handles null optional rates", () => {
    const metric: FridayLearningMetricsEntity = {
      day: "2025-06-15",
      incidentsTotal: 0,
      factsUpdated: 0,
      actionsExecuted: 0,
      createdAt: NOW,
      updatedAt: NOW,
    };

    repo.upsertDay(db.writer, metric);
    const result = repo.getDay(db.writer, "2025-06-15");
    expect(result!.successRate).toBeUndefined();
    expect(result!.autoFixSuccessRate).toBeUndefined();
    expect(result!.rollbackRate).toBeUndefined();
  });
});
```

### `test/unit/learning/persistence/friday-preference-fact-repository.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.js";
import { createFridayPreferenceFactRepository } from "../../../../src/learning/persistence/friday-preference-fact-repository.js";
import type { FridayPreferenceFactRepository } from "../../../../src/learning/persistence/friday-preference-fact-repository.js";

describe("FridayPreferenceFactRepository", () => {
  let db: FridaySqliteLayer;
  let repo: FridayPreferenceFactRepository;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    repo = createFridayPreferenceFactRepository();
  });

  afterEach(() => {
    db.close();
  });

  it("upsert inserts a new fact", () => {
    const fact = repo.upsert(db.writer, {
      factId: "fact-001",
      userId: "test-user",
      key: "pref:language",
      value: "TypeScript",
      confidence: 0.85,
      evidenceCountDelta: 1,
      lastConfirmedAt: NOW,
      sourceEventId: "evt-001",
      nowIso: NOW,
    });

    expect(fact.factId).toBe("fact-001");
    expect(fact.key).toBe("pref:language");
    expect(fact.value).toBe("TypeScript");
    expect(fact.confidence).toBe(0.85);
    expect(fact.evidenceCount).toBe(1);
    expect(fact.sourceEventIds).toEqual(["evt-001"]);
  });

  it("upsert updates an existing fact by user+key", () => {
    repo.upsert(db.writer, {
      factId: "fact-001",
      userId: "test-user",
      key: "pref:language",
      value: "TypeScript",
      confidence: 0.85,
      evidenceCountDelta: 1,
      lastConfirmedAt: NOW,
      sourceEventId: "evt-001",
      nowIso: NOW,
    });

    const updated = repo.upsert(db.writer, {
      factId: "fact-002", // different id, same user+key
      userId: "test-user",
      key: "pref:language",
      value: "Python",
      confidence: 0.90,
      evidenceCountDelta: 1,
      lastConfirmedAt: "2025-06-16T10:00:00.000Z",
      sourceEventId: "evt-002",
      nowIso: "2025-06-16T10:00:00.000Z",
    });

    expect(updated.factId).toBe("fact-001"); // keeps original factId
    expect(updated.value).toBe("Python");
    expect(updated.confidence).toBe(0.90);
    expect(updated.evidenceCount).toBe(2);
    expect(updated.sourceEventIds).toEqual(["evt-001", "evt-002"]);
  });

  it("upsert does not duplicate source event ids", () => {
    repo.upsert(db.writer, {
      factId: "fact-001",
      userId: "test-user",
      key: "pref:language",
      value: "TypeScript",
      confidence: 0.85,
      evidenceCountDelta: 1,
      lastConfirmedAt: NOW,
      sourceEventId: "evt-001",
      nowIso: NOW,
    });

    repo.upsert(db.writer, {
      factId: "fact-001",
      userId: "test-user",
      key: "pref:language",
      value: "TypeScript",
      confidence: 0.90,
      evidenceCountDelta: 1,
      lastConfirmedAt: NOW,
      sourceEventId: "evt-001", // same event id
      nowIso: NOW,
    });

    const fact = repo.getByUserAndKey(db.writer, "test-user", "pref:language");
    expect(fact!.sourceEventIds).toEqual(["evt-001"]);
  });

  it("getByUserAndKey returns null for non-existent key", () => {
    const result = repo.getByUserAndKey(db.writer, "test-user", "pref:nonexistent");
    expect(result).toBeNull();
  });

  it("listByUser filters by minConfidence", () => {
    repo.upsert(db.writer, {
      factId: "fact-001",
      userId: "test-user",
      key: "pref:a",
      value: "a",
      confidence: 0.30,
      evidenceCountDelta: 1,
      lastConfirmedAt: NOW,
      sourceEventId: "evt-001",
      nowIso: NOW,
    });
    repo.upsert(db.writer, {
      factId: "fact-002",
      userId: "test-user",
      key: "pref:b",
      value: "b",
      confidence: 0.80,
      evidenceCountDelta: 1,
      lastConfirmedAt: NOW,
      sourceEventId: "evt-002",
      nowIso: NOW,
    });

    const all = repo.listByUser(db.writer, "test-user", 0);
    expect(all).toHaveLength(2);

    const highOnly = repo.listByUser(db.writer, "test-user", 0.50);
    expect(highOnly).toHaveLength(1);
    expect(highOnly[0]!.key).toBe("pref:b");
  });

  it("listByUser respects limit", () => {
    for (let i = 0; i < 5; i++) {
      repo.upsert(db.writer, {
        factId: `fact-${i}`,
        userId: "test-user",
        key: `pref:key${i}`,
        value: `val${i}`,
        confidence: 0.80,
        evidenceCountDelta: 1,
        lastConfirmedAt: NOW,
        sourceEventId: `evt-${i}`,
        nowIso: NOW,
      });
    }

    const limited = repo.listByUser(db.writer, "test-user", 0, 3);
    expect(limited).toHaveLength(3);
  });

  it("deleteByUserAndKey removes fact and returns true", () => {
    repo.upsert(db.writer, {
      factId: "fact-001",
      userId: "test-user",
      key: "pref:language",
      value: "TypeScript",
      confidence: 0.85,
      evidenceCountDelta: 1,
      lastConfirmedAt: NOW,
      sourceEventId: "evt-001",
      nowIso: NOW,
    });

    const deleted = repo.deleteByUserAndKey(db.writer, "test-user", "pref:language");
    expect(deleted).toBe(true);

    const result = repo.getByUserAndKey(db.writer, "test-user", "pref:language");
    expect(result).toBeNull();
  });

  it("deleteByUserAndKey returns false for non-existent", () => {
    const deleted = repo.deleteByUserAndKey(db.writer, "test-user", "pref:nonexistent");
    expect(deleted).toBe(false);
  });

  it("applyDecay reduces confidence over time", () => {
    repo.upsert(db.writer, {
      factId: "fact-001",
      userId: "test-user",
      key: "pref:language",
      value: "TypeScript",
      confidence: 1.0,
      evidenceCountDelta: 1,
      lastConfirmedAt: "2025-01-01T00:00:00.000Z",
      sourceEventId: "evt-001",
      nowIso: "2025-01-01T00:00:00.000Z",
    });

    // 30 days later = one half-life
    const updated = repo.applyDecay(db.writer, {
      userId: "test-user",
      nowIso: "2025-01-31T00:00:00.000Z",
      halfLifeDays: 30,
      minConfidenceFloor: 0.05,
    });

    expect(updated).toBe(1);

    const fact = repo.getByUserAndKey(db.writer, "test-user", "pref:language");
    // After one half-life, confidence should be ~0.5
    expect(fact!.confidence).toBeCloseTo(0.5, 1);
  });

  it("applyDecay respects minimum floor", () => {
    repo.upsert(db.writer, {
      factId: "fact-001",
      userId: "test-user",
      key: "pref:language",
      value: "TypeScript",
      confidence: 0.10,
      evidenceCountDelta: 1,
      lastConfirmedAt: "2024-01-01T00:00:00.000Z",
      sourceEventId: "evt-001",
      nowIso: "2024-01-01T00:00:00.000Z",
    });

    // 365 days later — confidence should decay heavily but not below floor
    repo.applyDecay(db.writer, {
      userId: "test-user",
      nowIso: "2025-01-01T00:00:00.000Z",
      halfLifeDays: 30,
      minConfidenceFloor: 0.05,
    });

    const fact = repo.getByUserAndKey(db.writer, "test-user", "pref:language");
    expect(fact!.confidence).toBeGreaterThanOrEqual(0.05);
  });

  it("applyDecay does not mutate evidence_count", () => {
    repo.upsert(db.writer, {
      factId: "fact-001",
      userId: "test-user",
      key: "pref:language",
      value: "TypeScript",
      confidence: 1.0,
      evidenceCountDelta: 3,
      lastConfirmedAt: "2025-01-01T00:00:00.000Z",
      sourceEventId: "evt-001",
      nowIso: "2025-01-01T00:00:00.000Z",
    });

    repo.applyDecay(db.writer, {
      userId: "test-user",
      nowIso: "2025-02-01T00:00:00.000Z",
      halfLifeDays: 30,
      minConfidenceFloor: 0.05,
    });

    const fact = repo.getByUserAndKey(db.writer, "test-user", "pref:language");
    expect(fact!.evidenceCount).toBe(3);
  });
});
```

### `test/unit/learning/runtime/friday-self-learning-runtime.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.js";
import { createFridaySelfLearningRuntime } from "../../../../src/learning/runtime/friday-self-learning-runtime.js";
import type { FridaySelfLearningRuntime } from "../../../../src/learning/runtime/friday-self-learning-runtime.types.js";
import type { FridayLearningEventAppendInput } from "../../../../src/learning/model/friday-learning.types.js";

describe("FridaySelfLearningRuntime", () => {
  let db: FridaySqliteLayer;
  let runtime: FridaySelfLearningRuntime;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();
    runtime = createFridaySelfLearningRuntime({
      db,
      idGenerator: idGen,
      nowIso: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("composes all services correctly", () => {
    expect(runtime.events).toBeDefined();
    expect(runtime.extraction).toBeDefined();
    expect(runtime.facts).toBeDefined();
    expect(runtime.patterns).toBeDefined();
    expect(runtime.feedback).toBeDefined();
    expect(runtime.lifecycle).toBeDefined();
    expect(runtime.context).toBeDefined();
    expect(runtime.metrics).toBeDefined();
    expect(runtime.pipeline).toBeDefined();
  });

  it("events service collects and deduplicates events", () => {
    const event: FridayLearningEventAppendInput = {
      eventId: "evt-001",
      ts: NOW,
      userId: "test-user",
      kind: "user_message",
      payload: { text: "hello" },
    };

    const r1 = runtime.events.collect(event);
    expect(r1.inserted).toBe(true);

    const r2 = runtime.events.collect(event);
    expect(r2.inserted).toBe(false);
  });

  it("extraction service produces signals deterministically", () => {
    const signals1 = runtime.extraction.extract({
      eventId: "evt-001",
      ts: NOW,
      userId: "test-user",
      kind: "user_correction",
      payload: { correctedField: "theme", newValue: "dark" },
    });

    expect(signals1).toHaveLength(1);
    expect(signals1[0]!.kind).toBe("correction");
    expect(signals1[0]!.key).toBe("pref:theme");
  });

  it("lifecycle starts at cold_start for new users", () => {
    const state = runtime.lifecycle.getState("test-user");
    expect(state).toBe("cold_start");
  });

  it("lifecycle transitions to warmup after enough facts", () => {
    // Insert 3 facts to trigger warmup (default warmupFactCount = 3)
    for (let i = 0; i < 3; i++) {
      runtime.pipeline.processEvent({
        eventId: `evt-${i}`,
        ts: NOW,
        userId: "test-user",
        kind: "user_correction",
        payload: { correctedField: `field${i}`, newValue: `val${i}` },
      });
    }

    const state = runtime.lifecycle.getState("test-user");
    expect(state).toBe("warmup");
  });

  it("feedback service accepts corrections and updates facts", () => {
    const correctionEvent: FridayLearningEventAppendInput = {
      eventId: "evt-feedback-1",
      ts: NOW,
      userId: "test-user",
      kind: "user_correction",
      payload: { correctedField: "timezone", newValue: "UTC" },
    };

    const result = runtime.feedback.applyCorrection(correctionEvent);
    expect(result.accepted).toBe(true);
    expect(result.updatedFacts).toHaveLength(1);
    expect(result.updatedFacts[0]!.key).toBe("pref:timezone");
    expect(result.updatedFacts[0]!.value).toBe("UTC");
  });

  it("feedback service rejects non-correction events", () => {
    const event: FridayLearningEventAppendInput = {
      eventId: "evt-001",
      ts: NOW,
      userId: "test-user",
      kind: "user_message",
      payload: { text: "hello" },
    };

    const result = runtime.feedback.applyCorrection(event);
    expect(result.accepted).toBe(false);
    expect(result.updatedFacts).toHaveLength(0);
  });

  it("context enrichment builds context and enriches payloads", () => {
    // Process a correction to create a fact
    runtime.pipeline.processEvent({
      eventId: "evt-001",
      ts: NOW,
      userId: "test-user",
      kind: "user_correction",
      payload: { correctedField: "language", newValue: "TypeScript" },
    });

    // Enrich a payload
    const enriched = runtime.context.enrichSkillPayload({
      userId: "test-user",
      payload: { task: "compile" },
      nowIso: NOW,
    });

    expect(enriched).toHaveProperty("task", "compile");
    expect(enriched).toHaveProperty("__fridayLearning");
  });

  it("pipeline end-to-end: correction → fact → context", () => {
    // 1. Process correction
    const result = runtime.pipeline.processEvent({
      eventId: "evt-001",
      ts: NOW,
      userId: "test-user",
      kind: "user_correction",
      payload: { correctedField: "editor", newValue: "nvim" },
    });

    expect(result.inserted).toBe(true);
    expect(result.factsUpdated).toHaveLength(1);

    // 2. Verify fact is active
    const facts = runtime.facts.listActiveFacts({
      userId: "test-user",
      minConfidence: 0.0,
      limit: 10,
    });
    expect(facts.some((f) => f.key === "pref:editor")).toBe(true);

    // 3. Verify context includes the preference
    const ctx = runtime.context.buildContext({
      userId: "test-user",
      nowIso: NOW,
    });
    expect(ctx.preferences).toHaveProperty("pref:editor", "nvim");
  });

  it("pipeline end-to-end: error → incident → diagnosis → lesson", () => {
    const result = runtime.pipeline.processEvent({
      eventId: "evt-err-001",
      ts: NOW,
      userId: "test-user",
      kind: "error_incident",
      payload: { category: "tool", message: "api_timeout" },
    });

    expect(result.incidentsCreated).toHaveLength(1);
    expect(result.diagnosisCreated).toHaveLength(1);
    expect(result.lessonsUpdated).toHaveLength(1);
    expect(result.incidentsCreated[0]!.autoFixEligible).toBe(false);
  });
});
```

### `test/unit/learning/services/friday-learning-context-enrichment-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.js";
import { createFridayPreferenceFactRepository } from "../../../../src/learning/persistence/friday-preference-fact-repository.js";
import { createFridayErrorIncidentRepository } from "../../../../src/learning/persistence/friday-error-incident-repository.js";
import { createFridayPreferenceFactService } from "../../../../src/learning/services/friday-preference-fact-service.js";
import { createFridayLearningPatternRecognitionService } from "../../../../src/learning/services/friday-learning-pattern-recognition-service.js";
import { createFridayLearningLifecycleService } from "../../../../src/learning/services/friday-learning-lifecycle-service.js";
import { createFridayLearningContextEnrichmentService } from "../../../../src/learning/services/friday-learning-context-enrichment-service.js";
import type { FridayLearningContextEnrichmentService } from "../../../../src/learning/services/friday-learning-context-enrichment-service.js";

describe("FridayLearningContextEnrichmentService", () => {
  let db: FridaySqliteLayer;
  let service: FridayLearningContextEnrichmentService;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();
    const factRepo = createFridayPreferenceFactRepository();
    const incidentRepo = createFridayErrorIncidentRepository();

    const factService = createFridayPreferenceFactService({
      db,
      factRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
    });

    const patternService = createFridayLearningPatternRecognitionService({
      db,
      incidentRepo,
      factRepo,
      idGenerator: idGen,
    });

    const lifecycleService = createFridayLearningLifecycleService({
      db,
      factRepo,
    });

    service = createFridayLearningContextEnrichmentService({
      db,
      factService,
      patternService,
      lifecycleService,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("buildContext returns cold_start for user with no facts", () => {
    const ctx = service.buildContext({
      userId: "test-user",
      nowIso: NOW,
    });

    expect(ctx.userId).toBe("test-user");
    expect(ctx.lifecycleState).toBe("cold_start");
    expect(ctx.preferences).toEqual({});
    expect(ctx.appliedFacts).toEqual([]);
    expect(ctx.generatedAt).toBe(NOW);
  });

  it("buildContext includes preferences from high-confidence facts", () => {
    const factRepo = createFridayPreferenceFactRepository();

    // Insert a high-confidence fact
    db.withWriteTransaction((writer) => {
      factRepo.upsert(writer, {
        factId: "fact-001",
        userId: "test-user",
        key: "pref:language",
        value: "TypeScript",
        confidence: 0.90,
        evidenceCountDelta: 1,
        lastConfirmedAt: NOW,
        sourceEventId: "evt-001",
        nowIso: NOW,
      });
    });

    const ctx = service.buildContext({
      userId: "test-user",
      nowIso: NOW,
    });

    expect(ctx.preferences).toHaveProperty("pref:language", "TypeScript");
    expect(ctx.appliedFacts).toHaveLength(1);
    expect(ctx.appliedFacts[0]!.key).toBe("pref:language");
    expect(ctx.appliedFacts[0]!.confidence).toBe(0.90);
  });

  it("buildContext excludes low-confidence facts", () => {
    const factRepo = createFridayPreferenceFactRepository();

    // Insert a low-confidence fact (below default threshold of 0.60)
    db.withWriteTransaction((writer) => {
      factRepo.upsert(writer, {
        factId: "fact-001",
        userId: "test-user",
        key: "pref:language",
        value: "TypeScript",
        confidence: 0.30,
        evidenceCountDelta: 1,
        lastConfirmedAt: NOW,
        sourceEventId: "evt-001",
        nowIso: NOW,
      });
    });

    const ctx = service.buildContext({
      userId: "test-user",
      nowIso: NOW,
    });

    expect(ctx.preferences).toEqual({});
    expect(ctx.appliedFacts).toHaveLength(0);
  });

  it("enrichSkillPayload adds __fridayLearning envelope", () => {
    const payload = { task: "compile", target: "main" };
    const enriched = service.enrichSkillPayload({
      userId: "test-user",
      payload,
      nowIso: NOW,
    });

    expect(enriched).toHaveProperty("task", "compile");
    expect(enriched).toHaveProperty("target", "main");
    expect(enriched).toHaveProperty("__fridayLearning");

    const learning = enriched["__fridayLearning"] as Record<string, unknown>;
    expect(learning).toHaveProperty("lifecycleState", "cold_start");
    expect(learning).toHaveProperty("preferences");
    expect(learning).toHaveProperty("generatedAt", NOW);
  });

  it("enrichSkillPayload does not mutate original payload", () => {
    const payload = { task: "compile" };
    const enriched = service.enrichSkillPayload({
      userId: "test-user",
      payload,
      nowIso: NOW,
    });

    expect(payload).not.toHaveProperty("__fridayLearning");
    expect(enriched).toHaveProperty("__fridayLearning");
  });

  it("enrichSkillPayload skips enrichment when no userId", () => {
    const payload = { task: "compile" };
    const enriched = service.enrichSkillPayload({
      payload,
      nowIso: NOW,
    });

    expect(enriched).not.toHaveProperty("__fridayLearning");
    expect(enriched).toEqual({ task: "compile" });
  });

  it("enrichSkillPayload preserves explicit payload values", () => {
    const payload = { task: "compile", __fridayLearning: "should-be-overwritten" };
    const enriched = service.enrichSkillPayload({
      userId: "test-user",
      payload,
      nowIso: NOW,
    });

    // The enrichment overwrites __fridayLearning with the real context
    const learning = enriched["__fridayLearning"] as Record<string, unknown>;
    expect(learning).toHaveProperty("lifecycleState");
  });
});
```

### `test/unit/learning/services/friday-learning-pattern-recognition-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.js";
import { createFridayErrorIncidentRepository } from "../../../../src/learning/persistence/friday-error-incident-repository.js";
import { createFridayPreferenceFactRepository } from "../../../../src/learning/persistence/friday-preference-fact-repository.js";
import { createFridayLearningPatternRecognitionService } from "../../../../src/learning/services/friday-learning-pattern-recognition-service.js";
import type { FridayLearningPatternRecognitionService } from "../../../../src/learning/services/friday-learning-pattern-recognition-service.js";
import type { FridayErrorIncidentEntity } from "../../../../src/learning/model/friday-learning.types.js";
import { createFridayLearningEventLedger } from "../../../../src/ledger/learning/friday-learning-event-ledger.js";

describe("FridayLearningPatternRecognitionService", () => {
  let db: FridaySqliteLayer;
  let service: FridayLearningPatternRecognitionService;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();
    const incidentRepo = createFridayErrorIncidentRepository();
    const factRepo = createFridayPreferenceFactRepository();
    service = createFridayLearningPatternRecognitionService({
      db,
      incidentRepo,
      factRepo,
      idGenerator: idGen,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("detects recurring incident signatures (>= 3 occurrences)", () => {
    const incidentRepo = createFridayErrorIncidentRepository();

    // Insert 3 incidents with same signature
    for (let i = 0; i < 3; i++) {
      db.withWriteTransaction((writer) => {
        incidentRepo.insert(writer, {
          incidentId: `inc-${i}`,
          userId: "test-user",
          ts: `2025-06-1${i + 2}T10:00:00.000Z`,
          category: "tool",
          severity: "medium",
          signature: "sig-recurring",
          context: { error: "timeout" },
          autoFixEligible: false,
          status: "open",
          createdAt: NOW,
          updatedAt: NOW,
        });
      });
    }

    const patterns = service.detectUserPatterns({
      userId: "test-user",
      nowIso: NOW,
      lookbackDays: 30,
    });

    const recurring = patterns.filter(
      (p) => p.kind === "recurring_incident_signature",
    );
    expect(recurring).toHaveLength(1);
    expect(recurring[0]!.key).toBe("sig-recurring");
    expect(recurring[0]!.occurrences).toBe(3);
    expect(recurring[0]!.strength).toBeGreaterThan(0);
    expect(recurring[0]!.strength).toBeLessThanOrEqual(1);
  });

  it("does not detect incident pattern with < 3 occurrences", () => {
    const incidentRepo = createFridayErrorIncidentRepository();

    // Insert only 2 incidents
    for (let i = 0; i < 2; i++) {
      db.withWriteTransaction((writer) => {
        incidentRepo.insert(writer, {
          incidentId: `inc-${i}`,
          userId: "test-user",
          ts: `2025-06-1${i + 2}T10:00:00.000Z`,
          category: "tool",
          severity: "medium",
          signature: "sig-rare",
          context: {},
          autoFixEligible: false,
          status: "open",
          createdAt: NOW,
          updatedAt: NOW,
        });
      });
    }

    const patterns = service.detectUserPatterns({
      userId: "test-user",
      nowIso: NOW,
      lookbackDays: 30,
    });

    const recurring = patterns.filter(
      (p) => p.kind === "recurring_incident_signature",
    );
    expect(recurring).toHaveLength(0);
  });

  it("detects recurring correction keys (>= 2 in 14 days)", () => {
    const ledger = createFridayLearningEventLedger({ db });

    // Insert 2 correction events for same field
    ledger.appendEvent({
      eventId: "evt-corr-1",
      ts: "2025-06-10T10:00:00.000Z",
      userId: "test-user",
      kind: "user_correction",
      payload: { correctedField: "language", newValue: "Python" },
    });
    ledger.appendEvent({
      eventId: "evt-corr-2",
      ts: "2025-06-12T10:00:00.000Z",
      userId: "test-user",
      kind: "user_correction",
      payload: { correctedField: "language", newValue: "TypeScript" },
    });

    const patterns = service.detectUserPatterns({
      userId: "test-user",
      nowIso: NOW,
      lookbackDays: 14,
    });

    const correctionPatterns = patterns.filter(
      (p) => p.kind === "recurring_correction_key",
    );
    expect(correctionPatterns).toHaveLength(1);
    expect(correctionPatterns[0]!.key).toBe("language");
  });

  it("detects stable preference keys (evidence >= 4, confidence >= 0.75)", () => {
    const factRepo = createFridayPreferenceFactRepository();

    db.withWriteTransaction((writer) => {
      factRepo.upsert(writer, {
        factId: "fact-stable",
        userId: "test-user",
        key: "pref:theme",
        value: "dark",
        confidence: 0.90,
        evidenceCountDelta: 5,
        lastConfirmedAt: NOW,
        sourceEventId: "evt-001",
        nowIso: NOW,
      });
    });

    const patterns = service.detectUserPatterns({
      userId: "test-user",
      nowIso: NOW,
      lookbackDays: 30,
    });

    const stable = patterns.filter(
      (p) => p.kind === "stable_preference_key",
    );
    expect(stable).toHaveLength(1);
    expect(stable[0]!.key).toBe("pref:theme");
  });

  it("detects drifting preference keys (>= 2 distinct values in 30 days)", () => {
    const ledger = createFridayLearningEventLedger({ db });

    // Same field corrected to different values
    ledger.appendEvent({
      eventId: "evt-drift-1",
      ts: "2025-06-01T10:00:00.000Z",
      userId: "test-user",
      kind: "user_correction",
      payload: { correctedField: "editor", newValue: "vim" },
    });
    ledger.appendEvent({
      eventId: "evt-drift-2",
      ts: "2025-06-10T10:00:00.000Z",
      userId: "test-user",
      kind: "user_correction",
      payload: { correctedField: "editor", newValue: "vscode" },
    });

    const patterns = service.detectUserPatterns({
      userId: "test-user",
      nowIso: NOW,
      lookbackDays: 30,
    });

    const drifting = patterns.filter(
      (p) => p.kind === "drifting_preference_key",
    );
    expect(drifting).toHaveLength(1);
    expect(drifting[0]!.key).toBe("editor");
    expect(drifting[0]!.occurrences).toBe(2);
  });

  it("returns empty patterns for user with no data", () => {
    const patterns = service.detectUserPatterns({
      userId: "test-user",
      nowIso: NOW,
      lookbackDays: 30,
    });

    expect(patterns).toHaveLength(0);
  });

  it("pattern strength is bounded 0..1", () => {
    const incidentRepo = createFridayErrorIncidentRepository();

    // Insert many incidents to test strength clamping
    for (let i = 0; i < 20; i++) {
      db.withWriteTransaction((writer) => {
        incidentRepo.insert(writer, {
          incidentId: `inc-${i}`,
          userId: "test-user",
          ts: `2025-06-15T0${String(i % 10)}:00:00.000Z`,
          category: "tool",
          severity: "high",
          signature: "sig-many",
          context: {},
          autoFixEligible: false,
          status: "open",
          createdAt: NOW,
          updatedAt: NOW,
        });
      });
    }

    const patterns = service.detectUserPatterns({
      userId: "test-user",
      nowIso: NOW,
      lookbackDays: 30,
    });

    for (const p of patterns) {
      expect(p.strength).toBeGreaterThanOrEqual(0);
      expect(p.strength).toBeLessThanOrEqual(1);
    }
  });
});
```

### `test/unit/learning/services/friday-preference-extraction-service.test.ts`
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createFridayPreferenceExtractionService } from "../../../../src/learning/services/friday-preference-extraction-service.js";
import type { FridayPreferenceExtractionService } from "../../../../src/learning/services/friday-preference-extraction-service.js";
import type { FridayLearningEventAppendInput } from "../../../../src/learning/model/friday-learning.types.js";
import { createTestIdGenerator } from "../../satellites/_helpers/create-test-db.js";

describe("FridayPreferenceExtractionService", () => {
  let service: FridayPreferenceExtractionService;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    idGen = createTestIdGenerator();
    service = createFridayPreferenceExtractionService({
      idGenerator: idGen,
    });
  });

  function makeEvent(
    overrides: Partial<FridayLearningEventAppendInput>,
  ): FridayLearningEventAppendInput {
    return {
      eventId: "evt-001",
      ts: NOW,
      userId: "test-user",
      kind: "user_message",
      payload: {},
      ...overrides,
    };
  }

  describe("user_correction events", () => {
    it("extracts correction signal with confidence 1.0", () => {
      const event = makeEvent({
        kind: "user_correction",
        payload: { correctedField: "language", newValue: "Python" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.kind).toBe("correction");
      expect(signals[0]!.key).toBe("pref:language");
      expect(signals[0]!.value).toBe("Python");
      expect(signals[0]!.confidence).toBe(1.0);
    });

    it("normalizes correctedField key", () => {
      const event = makeEvent({
        kind: "user_correction",
        payload: { correctedField: "Favorite Color", newValue: "blue" },
      });

      const signals = service.extract(event);
      expect(signals[0]!.key).toBe("pref:favorite_color");
    });

    it("returns empty for missing correctedField", () => {
      const event = makeEvent({
        kind: "user_correction",
        payload: { someOtherField: "value" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(0);
    });
  });

  describe("user_message events", () => {
    it("extracts 'prefer X' pattern", () => {
      const event = makeEvent({
        kind: "user_message",
        payload: { text: "I prefer dark mode" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.kind).toBe("preference");
      expect(signals[0]!.key).toBe("pref:dark_mode");
      expect(signals[0]!.value).toBe("dark mode");
      expect(signals[0]!.confidence).toBe(0.80);
    });

    it("extracts 'always use X' pattern", () => {
      const event = makeEvent({
        kind: "user_message",
        payload: { text: "always use TypeScript" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.kind).toBe("preference");
      expect(signals[0]!.value).toBe("TypeScript");
    });

    it("extracts 'don't use X' pattern", () => {
      const event = makeEvent({
        kind: "user_message",
        payload: { text: "don't use Python" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.kind).toBe("preference");
      expect(signals[0]!.key).toContain("avoid");
    });

    it("extracts 'call me X' pattern", () => {
      const event = makeEvent({
        kind: "user_message",
        payload: { text: "call me Captain" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.key).toBe("pref:display_name");
      expect(signals[0]!.value).toBe("Captain");
    });

    it("returns empty for no matching pattern", () => {
      const event = makeEvent({
        kind: "user_message",
        payload: { text: "hello, how are you?" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(0);
    });

    it("returns empty for missing text payload", () => {
      const event = makeEvent({
        kind: "user_message",
        payload: {},
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(0);
    });
  });

  describe("tool_result events", () => {
    it("extracts error signal when ok=false", () => {
      const event = makeEvent({
        kind: "tool_result",
        payload: { ok: false, toolName: "search", errorCode: "timeout" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.kind).toBe("error");
      expect(signals[0]!.key).toContain("tool_failure");
      expect(signals[0]!.key).toContain("search");
      expect(signals[0]!.confidence).toBe(1.0);
    });

    it("extracts error signal when error payload exists", () => {
      const event = makeEvent({
        kind: "tool_result",
        payload: { error: "connection refused", toolName: "api" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.kind).toBe("error");
    });

    it("returns empty for successful tool result", () => {
      const event = makeEvent({
        kind: "tool_result",
        payload: { ok: true, result: "success" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(0);
    });
  });

  describe("error_incident events", () => {
    it("extracts error signal with confidence 1.0", () => {
      const event = makeEvent({
        kind: "error_incident",
        payload: { category: "config", message: "invalid_api_key" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.kind).toBe("error");
      expect(signals[0]!.confidence).toBe(1.0);
      expect(signals[0]!.key).toContain("incident");
    });
  });

  describe("workflow_outcome events", () => {
    it("extracts positive feedback for successful workflow", () => {
      const event = makeEvent({
        kind: "workflow_outcome",
        payload: { success: true, workflowId: "deploy-script" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.kind).toBe("positive_feedback");
      expect(signals[0]!.confidence).toBe(0.55);
    });

    it("returns empty for failed workflow", () => {
      const event = makeEvent({
        kind: "workflow_outcome",
        payload: { success: false },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(0);
    });
  });

  describe("assistant_message events", () => {
    it("returns empty to avoid self-reinforcement", () => {
      const event = makeEvent({
        kind: "assistant_message",
        payload: { text: "prefer TypeScript" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(0);
    });
  });

  it("sets correct signal metadata", () => {
    const event = makeEvent({
      eventId: "evt-123",
      kind: "user_correction",
      userId: "user-456",
      sessionId: "sess-789",
      runId: "run-abc",
      payload: { correctedField: "theme", newValue: "dark" },
    });

    const signals = service.extract(event);
    expect(signals[0]!.sourceEventId).toBe("evt-123");
    expect(signals[0]!.userId).toBe("user-456");
    expect(signals[0]!.sessionId).toBe("sess-789");
    expect(signals[0]!.runId).toBe("run-abc");
    expect(signals[0]!.ts).toBe(NOW);
    expect(signals[0]!.signalId).toBeTruthy();
  });
});
```

### `test/unit/learning/services/friday-preference-fact-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.js";
import { createFridayPreferenceFactRepository } from "../../../../src/learning/persistence/friday-preference-fact-repository.js";
import { createFridayPreferenceFactService } from "../../../../src/learning/services/friday-preference-fact-service.js";
import type { FridayPreferenceFactService } from "../../../../src/learning/services/friday-preference-fact-service.js";
import type {
  FridayExtractedSignal,
  FridayLearningEventAppendInput,
} from "../../../../src/learning/model/friday-learning.types.js";

describe("FridayPreferenceFactService", () => {
  let db: FridaySqliteLayer;
  let service: FridayPreferenceFactService;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();
    const factRepo = createFridayPreferenceFactRepository();
    service = createFridayPreferenceFactService({
      db,
      factRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
  });

  function makeEvent(
    overrides?: Partial<FridayLearningEventAppendInput>,
  ): FridayLearningEventAppendInput {
    return {
      eventId: "evt-001",
      ts: NOW,
      userId: "test-user",
      kind: "user_correction",
      payload: { correctedField: "language", newValue: "TypeScript" },
      ...overrides,
    };
  }

  function makeSignal(
    overrides?: Partial<FridayExtractedSignal>,
  ): FridayExtractedSignal {
    return {
      signalId: "sig-001",
      kind: "correction",
      key: "pref:language",
      value: "TypeScript",
      confidence: 1.0,
      sourceEventId: "evt-001",
      userId: "test-user",
      ts: NOW,
      ...overrides,
    };
  }

  it("applySignals creates new fact from correction signal", () => {
    const event = makeEvent();
    const signals = [makeSignal()];

    const updated = service.applySignals({
      event,
      signals,
      nowIso: NOW,
    });

    expect(updated).toHaveLength(1);
    expect(updated[0]!.key).toBe("pref:language");
    expect(updated[0]!.value).toBe("TypeScript");
    expect(updated[0]!.confidence).toBeGreaterThan(0);
  });

  it("applySignals skips non-preference/correction signals", () => {
    const event = makeEvent();
    const signals = [
      makeSignal({ kind: "error", key: "tool_failure:x:y" }),
      makeSignal({ kind: "positive_feedback", key: "workflow_success:abc" }),
    ];

    const updated = service.applySignals({
      event,
      signals,
      nowIso: NOW,
    });

    expect(updated).toHaveLength(0);
  });

  it("applySignals updates existing fact with higher confidence on same value", () => {
    // First signal
    service.applySignals({
      event: makeEvent(),
      signals: [makeSignal({ confidence: 0.80 })],
      nowIso: NOW,
    });

    // Second signal with same value should boost confidence
    const updated = service.applySignals({
      event: makeEvent({ eventId: "evt-002" }),
      signals: [makeSignal({ confidence: 0.90, sourceEventId: "evt-002" })],
      nowIso: NOW,
    });

    expect(updated).toHaveLength(1);
    // Confidence model: 0.45 * existing + 0.55 * signal + evidenceBoost
    // Should be higher than initial
    expect(updated[0]!.evidenceCount).toBe(2);
  });

  it("applySignals applies conflict penalty when value changes", () => {
    // First signal
    const initial = service.applySignals({
      event: makeEvent(),
      signals: [makeSignal({ value: "TypeScript", confidence: 0.80 })],
      nowIso: NOW,
    });
    const initialConf = initial[0]!.confidence;

    // Second signal with different value
    const updated = service.applySignals({
      event: makeEvent({ eventId: "evt-002" }),
      signals: [
        makeSignal({
          value: "Python",
          confidence: 0.80,
          sourceEventId: "evt-002",
        }),
      ],
      nowIso: NOW,
    });

    // Confidence should be lower due to conflict penalty
    expect(updated[0]!.value).toBe("Python");
    expect(updated[0]!.confidence).toBeLessThan(initialConf);
  });

  it("listActiveFacts returns facts above threshold", () => {
    service.applySignals({
      event: makeEvent(),
      signals: [makeSignal({ key: "pref:a", confidence: 0.90 })],
      nowIso: NOW,
    });
    service.applySignals({
      event: makeEvent({ eventId: "evt-002" }),
      signals: [
        makeSignal({
          key: "pref:b",
          confidence: 0.30,
          sourceEventId: "evt-002",
          kind: "preference",
        }),
      ],
      nowIso: NOW,
    });

    const active = service.listActiveFacts({
      userId: "test-user",
      minConfidence: 0.60,
      limit: 100,
    });

    expect(active).toHaveLength(1);
    expect(active[0]!.key).toBe("pref:a");
  });

  it("deleteFact removes a fact", () => {
    service.applySignals({
      event: makeEvent(),
      signals: [makeSignal()],
      nowIso: NOW,
    });

    const deleted = service.deleteFact({
      userId: "test-user",
      key: "pref:language",
    });
    expect(deleted).toBe(true);

    const remaining = service.listActiveFacts({
      userId: "test-user",
      minConfidence: 0,
      limit: 100,
    });
    expect(remaining).toHaveLength(0);
  });

  it("runDecay reduces confidence of stale facts", () => {
    // Insert fact with old lastConfirmedAt
    service.applySignals({
      event: makeEvent(),
      signals: [makeSignal({ confidence: 1.0 })],
      nowIso: "2025-01-01T00:00:00.000Z",
    });

    // Run decay 60 days later (2 half-lives)
    const result = service.runDecay({
      nowIso: "2025-03-02T00:00:00.000Z",
      userId: "test-user",
    });

    expect(result.updated).toBe(1);

    const facts = service.listActiveFacts({
      userId: "test-user",
      minConfidence: 0,
      limit: 100,
    });
    // After 2 half-lives, confidence should be ~0.25
    expect(facts[0]!.confidence).toBeLessThan(0.50);
  });
});
```

### `test/unit/learning/services/friday-self-learning-pipeline-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.js";
import { createFridayLearningEventLedger } from "../../../../src/ledger/learning/friday-learning-event-ledger.js";
import { createFridayPreferenceFactRepository } from "../../../../src/learning/persistence/friday-preference-fact-repository.js";
import { createFridayErrorIncidentRepository } from "../../../../src/learning/persistence/friday-error-incident-repository.js";
import { createFridayDiagnosisRecordRepository } from "../../../../src/learning/persistence/friday-diagnosis-record-repository.js";
import { createFridayLearnedLessonRepository } from "../../../../src/learning/persistence/friday-learned-lesson-repository.js";
import { createFridayLearningEventCollectionService } from "../../../../src/learning/services/friday-learning-event-collection-service.js";
import { createFridayPreferenceExtractionService } from "../../../../src/learning/services/friday-preference-extraction-service.js";
import { createFridayPreferenceFactService } from "../../../../src/learning/services/friday-preference-fact-service.js";
import { createFridayLearningLifecycleService } from "../../../../src/learning/services/friday-learning-lifecycle-service.js";
import { createFridaySelfLearningPipelineService } from "../../../../src/learning/services/friday-self-learning-pipeline-service.js";
import type { FridaySelfLearningPipelineService } from "../../../../src/learning/services/friday-self-learning-pipeline-service.js";
import type { FridayLearningEventAppendInput } from "../../../../src/learning/model/friday-learning.types.js";

describe("FridaySelfLearningPipelineService", () => {
  let db: FridaySqliteLayer;
  let pipeline: FridaySelfLearningPipelineService;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();

    const ledger = createFridayLearningEventLedger({ db });
    const factRepo = createFridayPreferenceFactRepository();
    const incidentRepo = createFridayErrorIncidentRepository();
    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    const lessonRepo = createFridayLearnedLessonRepository();

    const events = createFridayLearningEventCollectionService({ ledger });
    const extraction = createFridayPreferenceExtractionService({
      idGenerator: idGen,
    });
    const facts = createFridayPreferenceFactService({
      db,
      factRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
    });
    const lifecycle = createFridayLearningLifecycleService({
      db,
      factRepo,
    });

    pipeline = createFridaySelfLearningPipelineService({
      db,
      events,
      extraction,
      facts,
      lifecycle,
      incidentRepo,
      diagnosisRepo,
      lessonRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
  });

  function makeEvent(
    overrides?: Partial<FridayLearningEventAppendInput>,
  ): FridayLearningEventAppendInput {
    return {
      eventId: "evt-001",
      ts: NOW,
      userId: "test-user",
      kind: "user_message",
      payload: {},
      ...overrides,
    };
  }

  it("processEvent collects the event and returns result", () => {
    const event = makeEvent();
    const result = pipeline.processEvent(event);

    expect(result.eventId).toBe("evt-001");
    expect(result.inserted).toBe(true);
    expect(result.lifecycleState).toBe("cold_start");
  });

  it("processEvent is idempotent on duplicate eventId", () => {
    const event = makeEvent();
    pipeline.processEvent(event);
    const result = pipeline.processEvent(event);

    expect(result.inserted).toBe(false);
  });

  it("processEvent extracts correction signals and updates facts", () => {
    const event = makeEvent({
      kind: "user_correction",
      payload: { correctedField: "language", newValue: "Python" },
    });

    const result = pipeline.processEvent(event);

    expect(result.extractedSignals).toHaveLength(1);
    expect(result.extractedSignals[0]!.kind).toBe("correction");
    expect(result.factsUpdated).toHaveLength(1);
    expect(result.factsUpdated[0]!.key).toBe("pref:language");
    expect(result.factsUpdated[0]!.value).toBe("Python");
  });

  it("processEvent creates incidents for error signals", () => {
    const event = makeEvent({
      kind: "tool_result",
      payload: { ok: false, toolName: "search", errorCode: "timeout" },
    });

    const result = pipeline.processEvent(event);

    expect(result.extractedSignals.length).toBeGreaterThan(0);
    expect(result.incidentsCreated).toHaveLength(1);
    expect(result.incidentsCreated[0]!.category).toBe("tool");
    expect(result.incidentsCreated[0]!.autoFixEligible).toBe(false); // Phase 6 invariant
  });

  it("processEvent creates diagnosis records for error signals", () => {
    const event = makeEvent({
      kind: "error_incident",
      payload: { category: "config", message: "missing_key" },
    });

    const result = pipeline.processEvent(event);

    expect(result.diagnosisCreated).toHaveLength(1);
    expect(result.diagnosisCreated[0]!.incidentId).toBe(
      result.incidentsCreated[0]!.incidentId,
    );
  });

  it("processEvent creates learned lessons for error signals", () => {
    const event = makeEvent({
      kind: "error_incident",
      payload: { category: "workflow", message: "step_failed" },
    });

    const result = pipeline.processEvent(event);

    expect(result.lessonsUpdated).toHaveLength(1);
    expect(result.lessonsUpdated[0]!.fingerprint).toBeTruthy();
    expect(result.lessonsUpdated[0]!.occurrences).toBe(1);
  });

  it("processEvent accumulates lesson occurrences on repeated errors", () => {
    const event1 = makeEvent({
      eventId: "evt-001",
      kind: "error_incident",
      payload: { category: "tool", message: "timeout" },
    });
    const event2 = makeEvent({
      eventId: "evt-002",
      kind: "error_incident",
      payload: { category: "tool", message: "timeout" },
    });

    const result1 = pipeline.processEvent(event1);
    const result2 = pipeline.processEvent(event2);

    // Both should have same fingerprint, second should increment occurrences
    expect(result1.lessonsUpdated[0]!.fingerprint).toBe(
      result2.lessonsUpdated[0]!.fingerprint,
    );
    expect(result2.lessonsUpdated[0]!.occurrences).toBe(2);
  });

  it("processEvent returns empty arrays for assistant_message (no signals)", () => {
    const event = makeEvent({
      kind: "assistant_message",
      payload: { text: "I prefer TypeScript" },
    });

    const result = pipeline.processEvent(event);

    expect(result.extractedSignals).toHaveLength(0);
    expect(result.factsUpdated).toHaveLength(0);
    expect(result.incidentsCreated).toHaveLength(0);
  });

  it("processBatch processes multiple events", () => {
    const events = [
      makeEvent({ eventId: "evt-001", kind: "user_message", payload: { text: "hello" } }),
      makeEvent({
        eventId: "evt-002",
        kind: "user_correction",
        payload: { correctedField: "theme", newValue: "dark" },
      }),
      makeEvent({
        eventId: "evt-003",
        kind: "tool_result",
        payload: { ok: false, toolName: "api", errorCode: "500" },
      }),
    ];

    const results = pipeline.processBatch(events);

    expect(results).toHaveLength(3);
    expect(results[0]!.inserted).toBe(true);
    expect(results[1]!.factsUpdated).toHaveLength(1);
    expect(results[2]!.incidentsCreated).toHaveLength(1);
  });

  it("Phase 6 invariant: no auto_fix_actions or approval_requests written", () => {
    const event = makeEvent({
      kind: "error_incident",
      payload: { category: "tool", message: "failure" },
    });

    pipeline.processEvent(event);

    // Verify no rows in auto_fix_actions
    const autoFixCount = db.writer
      .prepare("SELECT COUNT(*) as cnt FROM auto_fix_actions")
      .get() as { cnt: number };
    expect(autoFixCount.cnt).toBe(0);

    // Verify no rows in approval_requests
    const approvalCount = db.writer
      .prepare("SELECT COUNT(*) as cnt FROM approval_requests")
      .get() as { cnt: number };
    expect(approvalCount.cnt).toBe(0);
  });
});
```

