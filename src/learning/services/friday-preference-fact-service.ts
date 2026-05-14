import type { FridaySqliteLayer } from "#state";
import type { FridayPreferenceFactRepository } from "../persistence/friday-preference-fact-repository.js";
import type {
  FRIDAY_LEARNING_DEFAULTS,
  FridayExtractedSignal,
  FridayLearningEventAppendInput,
  FridayPreferenceFactEntity,
  JsonValue,
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

  updateFact(input: {
    userId: string;
    key: string;
    value?: JsonValue;
    confidence?: number;
  }): FridayPreferenceFactEntity | null;

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

const FIRST_INFERRED_PREFERENCE_CONFIDENCE_CAP = 0.55;
const EXPLICIT_PREFERENCE_CONFIDENCE_FLOOR = 0.8;

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
          const gatedConfidence = !existing
            && signal.kind === "preference"
            && signal.confidence < EXPLICIT_PREFERENCE_CONFIDENCE_FLOOR
            ? Math.min(newConfidence, FIRST_INFERRED_PREFERENCE_CONFIDENCE_CAP)
            : newConfidence;

          const entity = deps.factRepo.upsert(db, {
            factId: existing?.factId ?? deps.idGenerator(),
            userId: event.userId,
            key: signal.key,
            value: signal.value,
            confidence: gatedConfidence,
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

    updateFact(input) {
      return deps.db.withWriteTransaction((db) => {
        const existing = deps.factRepo.getByUserAndKey(db, input.userId, input.key);
        if (!existing) return null;
        const nowIso = deps.nowIso();
        return deps.factRepo.upsert(db, {
          factId: existing.factId,
          userId: input.userId,
          key: input.key,
          value: input.value !== undefined ? input.value : existing.value,
          confidence: input.confidence !== undefined ? input.confidence : existing.confidence,
          evidenceCountDelta: 0,
          lastConfirmedAt: nowIso,
          sourceEventId: deps.idGenerator(),
          nowIso,
        });
      });
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
