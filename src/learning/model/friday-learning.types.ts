import type {
  FridayLearningEventAppendInput,
  FridayLearningEventKind,
} from "#ledger";

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
  emotionalValence?: number; // -1.0 (negative) to 1.0 (positive)
  situationalContext?: Record<string, unknown>;
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
  emotional_valence: number | null;
  metadata_json: string | null;
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
  emotionalValence?: number;
  metadata?: Record<string, unknown>;
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
  activation_rate: number | null;
  save_rate: number | null;
  reuse_rate: number | null;
  promotion_rate: number | null;
  support_conversion_rate: number | null;
  request_fulfillment_rate: number | null;
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
  activationRate?: number;
  saveRate?: number;
  reuseRate?: number;
  promotionRate?: number;
  supportConversionRate?: number;
  requestFulfillmentRate?: number;
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

export interface FridayLearningAppliedFact {
  factId: string;
  key: string;
  confidence: number;
  evidenceCount: number;
  lastConfirmedAt: ISODateTime;
  sourceEventIds: string[];
  reviewBoundary: string;
  contextUseBoundary: "learning_context_service_gated";
  provenance: {
    source: "preference_fact";
    reviewBoundary: string;
    reviewCenterCandidateId?: string;
    reviewCenterOrigin?: string;
  };
}

export interface FridayLearningContext {
  userId: string;
  lifecycleState: FridayLearningLifecycleState;
  preferences: Record<string, JsonValue>;
  appliedFacts: FridayLearningAppliedFact[];
  activePatterns: FridayLearningPattern[];
  individuationStage?: string;
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
