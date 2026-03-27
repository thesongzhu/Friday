import type { FridaySqliteLayer } from "#state";
import { safeJsonParse } from "#utilities";
import type { FridayErrorIncidentRepository } from "../persistence/friday-error-incident-repository.js";
import type { FridayPreferenceFactRepository } from "../persistence/friday-preference-fact-repository.js";
import type {
  FridayLearningEventKind,
  FridayLearningPattern,
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

/** Normalize a raw field name to the same form used for preference fact keys (without the pref: prefix). */
function normalizeFieldToKey(field: string): string {
  return field
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function readCorrectionPayload(payload: Record<string, unknown>): {
  correctedField?: string;
  newValue?: unknown;
} {
  const correctedField =
    typeof payload["correctedField"] === "string"
      ? payload["correctedField"]
      : typeof payload["field"] === "string"
        ? payload["field"]
        : undefined;
  const newValue =
    payload["newValue"] !== undefined ? payload["newValue"] : payload["value"];

  return { correctedField, newValue };
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
              evidence: { signature, count } satisfies JsonObject,
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
          const payload = safeJsonParse(row.payload_json) as Record<
            string,
            unknown
          >;
          const field = readCorrectionPayload(payload).correctedField;
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
              evidence: { correctedField: key, count } satisfies JsonObject,
            });
          }
        }

        // 3. Stable preference keys (evidence_count >= 4, confidence >= 0.75, no contradictions in 30 days)
        const facts = deps.factRepo.listByUser(db, userId, 0.75, 100);
        if (facts.length > 0) {
          const contradictionWindow = subtractDays(nowIso, 30);

          const recentCorrections = db
            .prepare(
              `SELECT payload_json
               FROM learning_events
               WHERE user_id = ? AND kind = 'user_correction'
               AND ts >= ?`,
            )
            .all(userId, contradictionWindow) as Array<{ payload_json: string }>;

          const correctedNormalizedKeys = new Set<string>();
          for (const row of recentCorrections) {
            const payload = safeJsonParse(row.payload_json) as Record<string, unknown>;
            const field = readCorrectionPayload(payload).correctedField;
            if (field) {
              correctedNormalizedKeys.add(normalizeFieldToKey(field));
            }
          }

          for (const fact of facts) {
            if (fact.evidenceCount >= 4) {
              // Compare using the normalized key (strip pref: prefix)
              const factBareKey = fact.key.replace(/^pref:/, "");
              const hasContradiction = correctedNormalizedKeys.has(factBareKey);

              if (!hasContradiction) {
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
                  } satisfies JsonObject,
                });
              }
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
          const payload = safeJsonParse(row.payload_json) as Record<
            string,
            unknown
          >;
          const { correctedField: field, newValue: newVal } = readCorrectionPayload(payload);
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
              } satisfies JsonObject,
            });
          }
        }
      });

      return patterns;
    },
  };
}
