import { createHash } from "node:crypto";
import type {
  FridayExtractedSignal,
  FridayLearningEventAppendInput,
  FridayLearningSignalKind,
} from "../model/friday-learning.types.js";
import { isFridaySensitiveLearningCandidate } from "./friday-sensitive-learning-guard.js";

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

function isSensitiveLearnedPreference(key: string, value: unknown): boolean {
  return isFridaySensitiveLearningCandidate(key, value);
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

/** V001 DDL-allowed incident categories. */
const VALID_INCIDENT_CATEGORIES = new Set([
  "tool",
  "model",
  "routing",
  "config",
  "workflow",
]);

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

/**
 * Communication persona preference rules.
 * These produce keys matching FRIDAY_COMMUNICATION_PREFERENCE_KEYS
 * (e.g., "persona.verbosity", "persona.tone") so they flow through
 * the learning context into persona resolution automatically.
 */
const PERSONA_PREFERENCE_RULES: PreferenceRule[] = [
  {
    // Matches imperative requests like "please be more concise" but not
    // conversational mentions like "the report was more concise".
    // Confidence kept below auto-use threshold so repeated signals accumulate.
    pattern: /(?:^|please\s+|can\s+you\s+|could\s+you\s+|i\s+(?:want|need|prefer)\s+(?:you\s+to\s+)?)be\s+more\s+(concise|brief|short|detailed|verbose)\b/i,
    keyExtractor: () => "persona.verbosity",
    valueExtractor: (m) => {
      const word = m[1]!.toLowerCase();
      return ["concise", "brief", "short"].includes(word) ? "concise" : "detailed";
    },
    confidence: 0.65,
  },
  {
    pattern: /(?:^|please\s+|can\s+you\s+|could\s+you\s+|i\s+(?:want|need|prefer)\s+(?:you\s+to\s+)?)be\s+more\s+(formal|professional|casual|friendly|warm)\b/i,
    keyExtractor: () => "persona.tone",
    valueExtractor: (m) => {
      const word = m[1]!.toLowerCase();
      if (["formal", "professional"].includes(word)) return "analytical";
      if (["casual", "friendly", "warm"].includes(word)) return "warm";
      return "neutral";
    },
    confidence: 0.65,
  },
  {
    pattern: /(?:^|please\s+)(?:don'?t|stop)\s+(?:ask(?:ing)?)\s+(?:so\s+many\s+)?questions?\b/i,
    keyExtractor: () => "persona.question_style",
    valueExtractor: () => "minimal",
    confidence: 0.65,
  },
  {
    pattern: /(?:^|please\s+|can\s+you\s+|could\s+you\s+|i\s+(?:want|need|prefer)\s+(?:you\s+to\s+)?)be\s+more\s+(direct|straightforward|blunt)\b/i,
    keyExtractor: () => "persona.directness",
    valueExtractor: () => "direct",
    confidence: 0.65,
  },
  // Chinese persona rules — imperative context (请/回答/你)
  {
    pattern: /(?:请|回答|你).*(?:简洁|简短|精炼)(?:一点|些|点)/,
    keyExtractor: () => "persona.verbosity",
    valueExtractor: () => "concise",
    confidence: 0.65,
  },
  {
    pattern: /(?:请|回答|你).*(?:详细|展开|多说)(?:一点|些|点)/,
    keyExtractor: () => "persona.verbosity",
    valueExtractor: () => "detailed",
    confidence: 0.65,
  },
  {
    pattern: /(?:请|回答|你).*(?:直接|干脆)(?:一点|些|点)/,
    keyExtractor: () => "persona.directness",
    valueExtractor: () => "direct",
    confidence: 0.65,
  },
  {
    pattern: /(?:别|不要|少|请.*别)问(?:那么多|这么多)?(?:问题)?/,
    keyExtractor: () => "persona.question_style",
    valueExtractor: () => "minimal",
    confidence: 0.65,
  },
];

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
  {
    pattern: /(?:请叫我|叫我|称呼我为|把我叫做|被称为|我的名字是|我叫|我的昵称是|名字叫|昵称是|以后叫我|以后称呼我为)\s*["“]?([^"”'。！？!,，\n]+)["”']?/u,
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
          const { correctedField, newValue } = readCorrectionPayload(event.payload);
          if (correctedField && newValue !== undefined) {
            const key = `pref:${normalizeKey(correctedField)}`;
            if (!isSensitiveLearnedPreference(key, newValue)) {
              signals.push(makeSignal("correction", key, newValue, 1.0));
            }
          }
          break;
        }

        case "user_message": {
          const text = event.payload["text"] as string | undefined;
          if (text) {
            let matched = false;
            for (const rule of PREFERENCE_RULES) {
              const match = text.match(rule.pattern);
              if (match) {
                const key = rule.keyExtractor(match);
                const value = rule.valueExtractor(match);
                if (!isSensitiveLearnedPreference(key, value)) {
                  signals.push(
                    makeSignal("preference", key, value, rule.confidence),
                  );
                }
                matched = true;
                break; // first match wins
              }
            }
            // Try persona rules if no general preference rule matched
            if (!matched) {
              for (const rule of PERSONA_PREFERENCE_RULES) {
                const match = text.match(rule.pattern);
                if (match) {
                  const key = rule.keyExtractor(match);
                  const value = rule.valueExtractor(match);
                  if (!isSensitiveLearnedPreference(key, value)) {
                    signals.push(
                      makeSignal("preference", key, value, rule.confidence),
                    );
                  }
                  break;
                }
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
          const rawCategory =
            (event.payload["category"] as string) ?? "unknown";
          const category = VALID_INCIDENT_CATEGORIES.has(rawCategory)
            ? rawCategory
            : "tool"; // default to most generic allowed value
          const errorMsg =
            (event.payload["message"] as string)
            ?? (event.payload["errorMessage"] as string)
            ?? "unknown_error";
          const key = `incident:${normalizeKey(category)}:${normalizeKey(errorMsg)}`;
          const sig = computeSignature(
            "error_incident",
            key,
            category,
          );
          const errorValue: Record<string, unknown> = {
            ...event.payload,
            category,
            message: errorMsg,
            signature: sig,
          };
          // Pass through severity if provided
          if (event.payload["severity"] !== undefined) {
            errorValue["severity"] = event.payload["severity"];
          }
          signals.push(
            makeSignal("error", key, errorValue, 1.0),
          );
          break;
        }

        case "workflow_outcome": {
          const success = event.payload["success"];
          const workflowId =
            (event.payload["workflowId"] as string) ?? "unknown";
          if (success === true) {
            // Low-weight reinforcement for successful outcomes
            const key = `workflow_success:${normalizeKey(workflowId)}`;
            signals.push(
              makeSignal("positive_feedback", key, { workflowId }, 0.55),
            );
          } else if (
            success === false ||
            event.payload["status"] === "failed" ||
            event.payload["error"] !== undefined
          ) {
            // Failure-path correction candidate
            const key = `workflow:${normalizeKey(workflowId)}:success_rate`;
            const errorMsg =
              (event.payload["error"] as string) ??
              (event.payload["message"] as string) ??
              "unknown";
            signals.push(
              makeSignal(
                "correction",
                key,
                { workflowId, value: "low", error: errorMsg },
                0.3,
              ),
            );
          }
          break;
        }

        case "outcome_confirmed": {
          const outcomeType = typeof event.payload["type"] === "string"
            ? event.payload["type"]
            : undefined;
          if (outcomeType === "autofix_rejected") {
            const reasonCode =
              typeof event.payload["reasonCode"] === "string"
                ? event.payload["reasonCode"]
                : "unspecified";
            signals.push(
              makeSignal(
                "correction",
                `autofix:rejection_reason:${normalizeKey(reasonCode)}`,
                {
                  reasonCode,
                  reason: event.payload["reason"],
                  fingerprint: event.payload["fingerprint"],
                },
                0.85,
              ),
            );

            const taskProfileId =
              typeof event.payload["taskProfileId"] === "string"
                ? event.payload["taskProfileId"]
                : "global";
            const providerId =
              typeof event.payload["actualProviderId"] === "string"
                ? event.payload["actualProviderId"]
                : undefined;
            const model =
              typeof event.payload["actualModel"] === "string"
                ? event.payload["actualModel"]
                : undefined;
            const backendKind =
              typeof event.payload["backendKind"] === "string"
                ? event.payload["backendKind"]
                : undefined;

            if (providerId && model && backendKind) {
              signals.push(
                makeSignal(
                  "correction",
                  `route_penalty:${normalizeKey(taskProfileId)}:${normalizeKey(providerId)}:${normalizeKey(backendKind)}:${normalizeKey(model)}`,
                  {
                    providerId,
                    model,
                    backendKind,
                    taskProfileId,
                    reasonCode,
                    actionId: event.payload["actionId"],
                    fingerprint: event.payload["fingerprint"],
                  },
                  0.75,
                ),
              );
            }
          } else if (outcomeType === "manual_resolved") {
            const fingerprint =
              typeof event.payload["fingerprint"] === "string"
                ? event.payload["fingerprint"]
                : "unknown";
            signals.push(
              makeSignal(
                "correction",
                `manual_resolution:${normalizeKey(fingerprint)}`,
                {
                  fix: event.payload["fix"],
                  cause: event.payload["cause"],
                  verificationSummary: event.payload["verificationSummary"],
                },
                0.9,
              ),
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
