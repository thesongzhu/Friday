import type {
  FridayCommunicationMbti,
  FridayCommunicationPersona,
  FridayCommunicationPersonaSettings,
} from "@friday-operator-client";

export const COMMUNICATION_MBTI_OPTIONS: readonly FridayCommunicationMbti[] = [
  "INTJ", "INTP", "ENTJ", "ENTP",
  "INFJ", "INFP", "ENFJ", "ENFP",
  "ISTJ", "ISFJ", "ESTJ", "ESFJ",
  "ISTP", "ISFP", "ESTP", "ESFP",
];

export const DEFAULT_COMMUNICATION_SETTINGS: FridayCommunicationPersonaSettings = {
  tone: "neutral",
  verbosity: "balanced",
  structure: "balanced",
  questionStyle: "guided",
  directness: "balanced",
  emojiStyle: "none",
  jargonTolerance: "medium",
  assumptionStyle: "balanced",
  confirmationStyle: "balanced",
};

const MBTI_TEMPLATE_MAP: Record<FridayCommunicationMbti, FridayCommunicationPersonaSettings> = {
  INTJ: { tone: "analytical", verbosity: "concise", structure: "structured", questionStyle: "minimal", directness: "direct", emojiStyle: "none", jargonTolerance: "high", assumptionStyle: "infer_first", confirmationStyle: "minimal" },
  INTP: { tone: "analytical", verbosity: "detailed", structure: "structured", questionStyle: "exploratory", directness: "balanced", emojiStyle: "none", jargonTolerance: "high", assumptionStyle: "infer_first", confirmationStyle: "balanced" },
  ENTJ: { tone: "analytical", verbosity: "concise", structure: "structured", questionStyle: "minimal", directness: "direct", emojiStyle: "none", jargonTolerance: "high", assumptionStyle: "infer_first", confirmationStyle: "explicit" },
  ENTP: { tone: "analytical", verbosity: "balanced", structure: "balanced", questionStyle: "exploratory", directness: "direct", emojiStyle: "light", jargonTolerance: "high", assumptionStyle: "infer_first", confirmationStyle: "minimal" },
  INFJ: { tone: "warm", verbosity: "balanced", structure: "structured", questionStyle: "guided", directness: "balanced", emojiStyle: "light", jargonTolerance: "medium", assumptionStyle: "balanced", confirmationStyle: "explicit" },
  INFP: { tone: "warm", verbosity: "detailed", structure: "balanced", questionStyle: "guided", directness: "soft", emojiStyle: "light", jargonTolerance: "low", assumptionStyle: "ask_first", confirmationStyle: "explicit" },
  ENFJ: { tone: "encouraging", verbosity: "balanced", structure: "structured", questionStyle: "guided", directness: "balanced", emojiStyle: "light", jargonTolerance: "medium", assumptionStyle: "balanced", confirmationStyle: "explicit" },
  ENFP: { tone: "encouraging", verbosity: "balanced", structure: "balanced", questionStyle: "exploratory", directness: "balanced", emojiStyle: "light", jargonTolerance: "medium", assumptionStyle: "balanced", confirmationStyle: "balanced" },
  ISTJ: { tone: "neutral", verbosity: "concise", structure: "structured", questionStyle: "minimal", directness: "direct", emojiStyle: "none", jargonTolerance: "medium", assumptionStyle: "ask_first", confirmationStyle: "explicit" },
  ISFJ: { tone: "warm", verbosity: "balanced", structure: "structured", questionStyle: "guided", directness: "soft", emojiStyle: "light", jargonTolerance: "low", assumptionStyle: "ask_first", confirmationStyle: "explicit" },
  ESTJ: { tone: "neutral", verbosity: "concise", structure: "structured", questionStyle: "minimal", directness: "direct", emojiStyle: "none", jargonTolerance: "medium", assumptionStyle: "infer_first", confirmationStyle: "explicit" },
  ESFJ: { tone: "encouraging", verbosity: "balanced", structure: "structured", questionStyle: "guided", directness: "balanced", emojiStyle: "light", jargonTolerance: "low", assumptionStyle: "ask_first", confirmationStyle: "explicit" },
  ISTP: { tone: "neutral", verbosity: "concise", structure: "compact", questionStyle: "minimal", directness: "direct", emojiStyle: "none", jargonTolerance: "high", assumptionStyle: "infer_first", confirmationStyle: "minimal" },
  ISFP: { tone: "warm", verbosity: "balanced", structure: "compact", questionStyle: "guided", directness: "soft", emojiStyle: "light", jargonTolerance: "low", assumptionStyle: "ask_first", confirmationStyle: "balanced" },
  ESTP: { tone: "neutral", verbosity: "concise", structure: "compact", questionStyle: "minimal", directness: "direct", emojiStyle: "none", jargonTolerance: "medium", assumptionStyle: "infer_first", confirmationStyle: "minimal" },
  ESFP: { tone: "encouraging", verbosity: "balanced", structure: "balanced", questionStyle: "guided", directness: "balanced", emojiStyle: "light", jargonTolerance: "low", assumptionStyle: "balanced", confirmationStyle: "balanced" },
};

export function getMbtiDefaults(mbti: FridayCommunicationMbti | null): FridayCommunicationPersonaSettings {
  return mbti ? { ...MBTI_TEMPLATE_MAP[mbti] } : { ...DEFAULT_COMMUNICATION_SETTINGS };
}

export function buildPersonaPreview(settings: FridayCommunicationPersonaSettings): FridayCommunicationPersona["preview"] {
  return {
    styleLabel: `${settings.tone}/${settings.verbosity}/${settings.directness}`,
    sampleClarifier: settings.questionStyle === "minimal"
      ? "I can do that. Which project should I use first?"
      : settings.questionStyle === "exploratory"
        ? "I can help with that. My current assumption is the active workspace, but what result matters most to you?"
        : "I can help with that. To make the next step safe, which project should Friday use first?",
    sampleBoundary: settings.directness === "direct"
      ? "This crosses a high-risk boundary, so I need your approval before changing it."
      : settings.directness === "soft"
        ? "I can keep going, but this touches a high-risk area, so I need your approval before I make the change."
        : "This is a high-risk step. I need your approval before I continue.",
  };
}

export function buildPersonaDraft(persona?: FridayCommunicationPersona): {
  mbti: FridayCommunicationMbti | "";
  settings: FridayCommunicationPersonaSettings;
} {
  return {
    mbti: persona?.mbti ?? "",
    settings: { ...(persona?.settings ?? DEFAULT_COMMUNICATION_SETTINGS) },
  };
}
