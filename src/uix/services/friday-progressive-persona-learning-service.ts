/**
 * Progressive Persona Learning Service — adjusts communication persona
 * dimensions based on session satisfaction trends, writing learned
 * preferences that the existing resolution hierarchy picks up.
 */

import type { FridaySqliteLayer } from "#state";
import type { FridayPreferenceFactRepository } from "../../learning/persistence/friday-preference-fact-repository.js";
import type {
  FridayCommunicationPersona,
  FridayCommunicationPersonaSettings,
} from "./friday-communication-persona.js";

// ─── Types ─────��────────────────────────────────────────────────

export interface FridayCommunicationPersonaAdjustment {
  dimension: keyof FridayCommunicationPersonaSettings;
  fromValue: string;
  toValue: string;
  reason: string;
  confidence: number;
}

export interface FridaySatisfactionTrend {
  average: number;
  trend: "improving" | "declining" | "stable";
  recentSessions: number;
}

// ─── Public interface ───────────────────────────────────────────

export interface FridayProgressivePersonaLearningService {
  computeAdjustments(input: {
    userId: string;
    currentPersona: FridayCommunicationPersona;
    satisfactionTrend: FridaySatisfactionTrend;
    nowIso: string;
  }): FridayCommunicationPersonaAdjustment[];

  applyAdjustments(input: {
    userId: string;
    adjustments: FridayCommunicationPersonaAdjustment[];
    nowIso: string;
  }): void;
}

// ─���─ Deps ���──────────────────────────────────────────────────────

export interface CreateProgressivePersonaLearningServiceDeps {
  db: FridaySqliteLayer;
  factRepo: FridayPreferenceFactRepository;
  idGenerator: () => string;
}

// ─── Dimension escalation maps ──────────────────────────────────

const VERBOSITY_UP: Record<string, string | undefined> = {
  concise: "balanced",
  balanced: "detailed",
};

const DIRECTNESS_DOWN: Record<string, string | undefined> = {
  direct: "balanced",
  balanced: "soft",
};

const CONFIRMATION_UP: Record<string, string | undefined> = {
  minimal: "balanced",
  balanced: "explicit",
};

const ASSUMPTION_RELAX: Record<string, string | undefined> = {
  ask_first: "balanced",
  balanced: "infer_first",
};

const DIMENSION_KEY_MAP: Record<keyof FridayCommunicationPersonaSettings, string> = {
  tone: "persona.tone",
  verbosity: "persona.verbosity",
  structure: "persona.structure",
  questionStyle: "persona.question_style",
  directness: "persona.directness",
  emojiStyle: "persona.emoji_style",
  jargonTolerance: "persona.jargon_tolerance",
  assumptionStyle: "persona.assumption_style",
  confirmationStyle: "persona.confirmation_style",
};

// ─── Factory ───────────────���────────────────────────────────────

export function createFridayProgressivePersonaLearningService(
  deps: CreateProgressivePersonaLearningServiceDeps,
): FridayProgressivePersonaLearningService {
  return {
    computeAdjustments(input) {
      const { currentPersona, satisfactionTrend } = input;
      const adjustments: FridayCommunicationPersonaAdjustment[] = [];
      const sources = currentPersona.inheritedFrom.settings;

      // Never override explicit (user-set) dimensions
      function isAdjustable(dim: keyof FridayCommunicationPersonaSettings): boolean {
        return sources[dim] !== "explicit";
      }

      // Declining satisfaction → increase verbosity, soften directness, add confirmations
      if (
        satisfactionTrend.trend === "declining" &&
        satisfactionTrend.average < -0.2 &&
        satisfactionTrend.recentSessions >= 3
      ) {
        const settings = currentPersona.settings;

        if (isAdjustable("verbosity")) {
          const next = VERBOSITY_UP[settings.verbosity];
          if (next) {
            adjustments.push({
              dimension: "verbosity",
              fromValue: settings.verbosity,
              toValue: next,
              reason: "satisfaction declining — increase detail",
              confidence: 0.65,
            });
          }
        }

        if (isAdjustable("directness")) {
          const next = DIRECTNESS_DOWN[settings.directness];
          if (next) {
            adjustments.push({
              dimension: "directness",
              fromValue: settings.directness,
              toValue: next,
              reason: "satisfaction declining — soften approach",
              confidence: 0.60,
            });
          }
        }

        if (isAdjustable("confirmationStyle")) {
          const next = CONFIRMATION_UP[settings.confirmationStyle];
          if (next) {
            adjustments.push({
              dimension: "confirmationStyle",
              fromValue: settings.confirmationStyle,
              toValue: next,
              reason: "satisfaction declining — confirm more",
              confidence: 0.60,
            });
          }
        }
      }

      // Improving satisfaction → can relax assumption style
      if (
        satisfactionTrend.trend === "improving" &&
        satisfactionTrend.average > 0.3 &&
        satisfactionTrend.recentSessions >= 5
      ) {
        const settings = currentPersona.settings;

        if (isAdjustable("assumptionStyle")) {
          const next = ASSUMPTION_RELAX[settings.assumptionStyle];
          if (next) {
            adjustments.push({
              dimension: "assumptionStyle",
              fromValue: settings.assumptionStyle,
              toValue: next,
              reason: "satisfaction improving — infer more",
              confidence: 0.65,
            });
          }
        }
      }

      return adjustments;
    },

    applyAdjustments(input) {
      const qualifying = input.adjustments.filter((a) => a.confidence >= 0.6);
      if (qualifying.length === 0) return;

      deps.db.withWriteTransaction((db) => {
        for (const adj of qualifying) {
          const key = DIMENSION_KEY_MAP[adj.dimension];
          deps.factRepo.upsert(db, {
            factId: deps.idGenerator(),
            userId: input.userId,
            key,
            value: adj.toValue,
            confidence: adj.confidence,
            evidenceCountDelta: 1,
            lastConfirmedAt: input.nowIso,
            sourceEventId: `persona_adjustment:${adj.dimension}`,
            nowIso: input.nowIso,
            emotionalValence: undefined,
            metadata: {
              source: "progressive_persona_learning",
              reason: adj.reason,
              fromValue: adj.fromValue,
            },
          });
        }
      });
    },
  };
}
