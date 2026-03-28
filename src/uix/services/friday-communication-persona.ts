import type { FridayUserPreference } from "../model/friday-uix.types.js";

export type FridayCommunicationMbti =
  | "INTJ" | "INTP" | "ENTJ" | "ENTP"
  | "INFJ" | "INFP" | "ENFJ" | "ENFP"
  | "ISTJ" | "ISFJ" | "ESTJ" | "ESFJ"
  | "ISTP" | "ISFP" | "ESTP" | "ESFP";

export type FridayCommunicationTone = "warm" | "neutral" | "analytical" | "encouraging";
export type FridayCommunicationVerbosity = "concise" | "balanced" | "detailed";
export type FridayCommunicationStructure = "compact" | "balanced" | "structured";
export type FridayCommunicationQuestionStyle = "minimal" | "guided" | "exploratory";
export type FridayCommunicationDirectness = "soft" | "balanced" | "direct";
export type FridayCommunicationEmojiStyle = "none" | "light";
export type FridayCommunicationJargonTolerance = "low" | "medium" | "high";
export type FridayCommunicationAssumptionStyle = "ask_first" | "balanced" | "infer_first";
export type FridayCommunicationConfirmationStyle = "minimal" | "balanced" | "explicit";

export type FridayCommunicationSettingSource = "explicit" | "learned" | "template" | "default";

export interface FridayCommunicationPersonaSettings {
  tone: FridayCommunicationTone;
  verbosity: FridayCommunicationVerbosity;
  structure: FridayCommunicationStructure;
  questionStyle: FridayCommunicationQuestionStyle;
  directness: FridayCommunicationDirectness;
  emojiStyle: FridayCommunicationEmojiStyle;
  jargonTolerance: FridayCommunicationJargonTolerance;
  assumptionStyle: FridayCommunicationAssumptionStyle;
  confirmationStyle: FridayCommunicationConfirmationStyle;
}

export interface FridayCommunicationPersonaPreview {
  styleLabel: string;
  sampleClarifier: string;
  sampleBoundary: string;
}

export interface FridayCommunicationPersona {
  category: "communication";
  mbti: FridayCommunicationMbti | null;
  settings: FridayCommunicationPersonaSettings;
  inheritedFrom: {
    mbti: FridayCommunicationSettingSource;
    settings: Record<keyof FridayCommunicationPersonaSettings, FridayCommunicationSettingSource>;
  };
  preview: FridayCommunicationPersonaPreview;
}

export interface FridayResolveCommunicationPersonaInput {
  explicitPreferences?: FridayUserPreference[];
  learnedPreferences?: Record<string, unknown>;
}

const COMMUNICATION_KEYS = {
  mbti: "persona.mbti",
  tone: "persona.tone",
  verbosity: "persona.verbosity",
  structure: "persona.structure",
  questionStyle: "persona.question_style",
  directness: "persona.directness",
  emojiStyle: "persona.emoji_style",
  jargonTolerance: "persona.jargon_tolerance",
  assumptionStyle: "persona.assumption_style",
  confirmationStyle: "persona.confirmation_style",
} as const;

export const FRIDAY_COMMUNICATION_PREFERENCE_KEYS = COMMUNICATION_KEYS;

type FridayCommunicationTemplate = {
  mbti: FridayCommunicationMbti;
  defaults: FridayCommunicationPersonaSettings;
};

export const FRIDAY_DEFAULT_COMMUNICATION_PERSONA: FridayCommunicationPersonaSettings = {
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

const MBTI_TEMPLATES: readonly FridayCommunicationTemplate[] = [
  { mbti: "INTJ", defaults: { tone: "analytical", verbosity: "concise", structure: "structured", questionStyle: "minimal", directness: "direct", emojiStyle: "none", jargonTolerance: "high", assumptionStyle: "infer_first", confirmationStyle: "minimal" } },
  { mbti: "INTP", defaults: { tone: "analytical", verbosity: "detailed", structure: "structured", questionStyle: "exploratory", directness: "balanced", emojiStyle: "none", jargonTolerance: "high", assumptionStyle: "infer_first", confirmationStyle: "balanced" } },
  { mbti: "ENTJ", defaults: { tone: "analytical", verbosity: "concise", structure: "structured", questionStyle: "minimal", directness: "direct", emojiStyle: "none", jargonTolerance: "high", assumptionStyle: "infer_first", confirmationStyle: "explicit" } },
  { mbti: "ENTP", defaults: { tone: "analytical", verbosity: "balanced", structure: "balanced", questionStyle: "exploratory", directness: "direct", emojiStyle: "light", jargonTolerance: "high", assumptionStyle: "infer_first", confirmationStyle: "minimal" } },
  { mbti: "INFJ", defaults: { tone: "warm", verbosity: "balanced", structure: "structured", questionStyle: "guided", directness: "balanced", emojiStyle: "light", jargonTolerance: "medium", assumptionStyle: "balanced", confirmationStyle: "explicit" } },
  { mbti: "INFP", defaults: { tone: "warm", verbosity: "detailed", structure: "balanced", questionStyle: "guided", directness: "soft", emojiStyle: "light", jargonTolerance: "low", assumptionStyle: "ask_first", confirmationStyle: "explicit" } },
  { mbti: "ENFJ", defaults: { tone: "encouraging", verbosity: "balanced", structure: "structured", questionStyle: "guided", directness: "balanced", emojiStyle: "light", jargonTolerance: "medium", assumptionStyle: "balanced", confirmationStyle: "explicit" } },
  { mbti: "ENFP", defaults: { tone: "encouraging", verbosity: "balanced", structure: "balanced", questionStyle: "exploratory", directness: "balanced", emojiStyle: "light", jargonTolerance: "medium", assumptionStyle: "balanced", confirmationStyle: "balanced" } },
  { mbti: "ISTJ", defaults: { tone: "neutral", verbosity: "concise", structure: "structured", questionStyle: "minimal", directness: "direct", emojiStyle: "none", jargonTolerance: "medium", assumptionStyle: "ask_first", confirmationStyle: "explicit" } },
  { mbti: "ISFJ", defaults: { tone: "warm", verbosity: "balanced", structure: "structured", questionStyle: "guided", directness: "soft", emojiStyle: "light", jargonTolerance: "low", assumptionStyle: "ask_first", confirmationStyle: "explicit" } },
  { mbti: "ESTJ", defaults: { tone: "neutral", verbosity: "concise", structure: "structured", questionStyle: "minimal", directness: "direct", emojiStyle: "none", jargonTolerance: "medium", assumptionStyle: "infer_first", confirmationStyle: "explicit" } },
  { mbti: "ESFJ", defaults: { tone: "encouraging", verbosity: "balanced", structure: "structured", questionStyle: "guided", directness: "balanced", emojiStyle: "light", jargonTolerance: "low", assumptionStyle: "ask_first", confirmationStyle: "explicit" } },
  { mbti: "ISTP", defaults: { tone: "neutral", verbosity: "concise", structure: "compact", questionStyle: "minimal", directness: "direct", emojiStyle: "none", jargonTolerance: "high", assumptionStyle: "infer_first", confirmationStyle: "minimal" } },
  { mbti: "ISFP", defaults: { tone: "warm", verbosity: "balanced", structure: "compact", questionStyle: "guided", directness: "soft", emojiStyle: "light", jargonTolerance: "low", assumptionStyle: "ask_first", confirmationStyle: "balanced" } },
  { mbti: "ESTP", defaults: { tone: "neutral", verbosity: "concise", structure: "compact", questionStyle: "minimal", directness: "direct", emojiStyle: "none", jargonTolerance: "medium", assumptionStyle: "infer_first", confirmationStyle: "minimal" } },
  { mbti: "ESFP", defaults: { tone: "encouraging", verbosity: "balanced", structure: "balanced", questionStyle: "guided", directness: "balanced", emojiStyle: "light", jargonTolerance: "low", assumptionStyle: "balanced", confirmationStyle: "balanced" } },
] as const;

const MBTI_TEMPLATE_MAP = new Map(MBTI_TEMPLATES.map((template) => [template.mbti, template.defaults]));

export function isMbti(value: unknown): value is FridayCommunicationMbti {
  return typeof value === "string" && MBTI_TEMPLATE_MAP.has(value as FridayCommunicationMbti);
}

function pickSetting<T extends string>(
  explicit: FridayUserPreference[] | undefined,
  learned: Record<string, unknown> | undefined,
  key: string,
  valid: readonly T[],
  templateValue: T,
  defaultValue: T,
): { value: T; source: FridayCommunicationSettingSource } {
  const explicitValue = explicit?.find((preference) => preference.key === key)?.value;
  if (typeof explicitValue === "string" && valid.includes(explicitValue as T)) {
    return { value: explicitValue as T, source: "explicit" };
  }
  const learnedValue = learned?.[key];
  if (typeof learnedValue === "string" && valid.includes(learnedValue as T)) {
    return { value: learnedValue as T, source: "learned" };
  }
  if (valid.includes(templateValue)) {
    return { value: templateValue, source: "template" };
  }
  return { value: defaultValue, source: "default" };
}

function resolveMbti(
  explicit: FridayUserPreference[] | undefined,
  learned: Record<string, unknown> | undefined,
): { value: FridayCommunicationMbti | null; source: FridayCommunicationSettingSource } {
  const explicitValue = explicit?.find((preference) => preference.key === COMMUNICATION_KEYS.mbti)?.value;
  if (isMbti(explicitValue)) {
    return { value: explicitValue, source: "explicit" };
  }
  const learnedValue = learned?.[COMMUNICATION_KEYS.mbti];
  if (isMbti(learnedValue)) {
    return { value: learnedValue, source: "learned" };
  }
  return { value: null, source: "default" };
}

function buildPreview(settings: FridayCommunicationPersonaSettings): FridayCommunicationPersonaPreview {
  const styleLabel = `${settings.tone}/${settings.verbosity}/${settings.directness}`;
  const sampleClarifier = settings.questionStyle === "minimal"
    ? "I can do that. Which project should I use first?"
    : settings.questionStyle === "exploratory"
      ? "I can help with that. My current assumption is the active workspace, but what result matters most to you?"
      : "I can help with that. To make the next step safe, which project should Friday use first?";
  const sampleBoundary = settings.directness === "direct"
    ? "This crosses a high-risk boundary, so I need your approval before changing it."
    : settings.directness === "soft"
      ? "I can keep going, but this touches a high-risk area, so I need your approval before I make the change."
      : "This is a high-risk step. I need your approval before I continue.";
  return {
    styleLabel,
    sampleClarifier,
    sampleBoundary,
  };
}

export function getFridayMbtiTemplateDefaults(
  mbti: FridayCommunicationMbti | null,
): FridayCommunicationPersonaSettings {
  return mbti ? { ...(MBTI_TEMPLATE_MAP.get(mbti) ?? FRIDAY_DEFAULT_COMMUNICATION_PERSONA) } : { ...FRIDAY_DEFAULT_COMMUNICATION_PERSONA };
}

export function resolveFridayCommunicationPersona(
  input: FridayResolveCommunicationPersonaInput,
): FridayCommunicationPersona {
  const explicit = input.explicitPreferences;
  const learned = input.learnedPreferences;
  const mbti = resolveMbti(explicit, learned);
  const templateDefaults = getFridayMbtiTemplateDefaults(mbti.value);

  const tone = pickSetting(explicit, learned, COMMUNICATION_KEYS.tone, ["warm", "neutral", "analytical", "encouraging"], templateDefaults.tone, FRIDAY_DEFAULT_COMMUNICATION_PERSONA.tone);
  const verbosity = pickSetting(explicit, learned, COMMUNICATION_KEYS.verbosity, ["concise", "balanced", "detailed"], templateDefaults.verbosity, FRIDAY_DEFAULT_COMMUNICATION_PERSONA.verbosity);
  const structure = pickSetting(explicit, learned, COMMUNICATION_KEYS.structure, ["compact", "balanced", "structured"], templateDefaults.structure, FRIDAY_DEFAULT_COMMUNICATION_PERSONA.structure);
  const questionStyle = pickSetting(explicit, learned, COMMUNICATION_KEYS.questionStyle, ["minimal", "guided", "exploratory"], templateDefaults.questionStyle, FRIDAY_DEFAULT_COMMUNICATION_PERSONA.questionStyle);
  const directness = pickSetting(explicit, learned, COMMUNICATION_KEYS.directness, ["soft", "balanced", "direct"], templateDefaults.directness, FRIDAY_DEFAULT_COMMUNICATION_PERSONA.directness);
  const emojiStyle = pickSetting(explicit, learned, COMMUNICATION_KEYS.emojiStyle, ["none", "light"], templateDefaults.emojiStyle, FRIDAY_DEFAULT_COMMUNICATION_PERSONA.emojiStyle);
  const jargonTolerance = pickSetting(explicit, learned, COMMUNICATION_KEYS.jargonTolerance, ["low", "medium", "high"], templateDefaults.jargonTolerance, FRIDAY_DEFAULT_COMMUNICATION_PERSONA.jargonTolerance);
  const assumptionStyle = pickSetting(explicit, learned, COMMUNICATION_KEYS.assumptionStyle, ["ask_first", "balanced", "infer_first"], templateDefaults.assumptionStyle, FRIDAY_DEFAULT_COMMUNICATION_PERSONA.assumptionStyle);
  const confirmationStyle = pickSetting(explicit, learned, COMMUNICATION_KEYS.confirmationStyle, ["minimal", "balanced", "explicit"], templateDefaults.confirmationStyle, FRIDAY_DEFAULT_COMMUNICATION_PERSONA.confirmationStyle);

  const settings: FridayCommunicationPersonaSettings = {
    tone: tone.value,
    verbosity: verbosity.value,
    structure: structure.value,
    questionStyle: questionStyle.value,
    directness: directness.value,
    emojiStyle: emojiStyle.value,
    jargonTolerance: jargonTolerance.value,
    assumptionStyle: assumptionStyle.value,
    confirmationStyle: confirmationStyle.value,
  };

  return {
    category: "communication",
    mbti: mbti.value,
    settings,
    inheritedFrom: {
      mbti: mbti.source,
      settings: {
        tone: tone.source,
        verbosity: verbosity.source,
        structure: structure.source,
        questionStyle: questionStyle.source,
        directness: directness.source,
        emojiStyle: emojiStyle.source,
        jargonTolerance: jargonTolerance.source,
        assumptionStyle: assumptionStyle.source,
        confirmationStyle: confirmationStyle.source,
      },
    },
    preview: buildPreview(settings),
  };
}

export function getFridayCommunicationPreferenceKeys(): readonly string[] {
  return Object.values(COMMUNICATION_KEYS);
}

export function buildFridayCommunicationPromptFragment(
  persona: FridayCommunicationPersona,
): string {
  const lines = [
    "Communication persona (user-facing guidance only):",
    `- MBTI template: ${persona.mbti ?? "default"}`,
    `- Tone: ${persona.settings.tone}`,
    `- Verbosity: ${persona.settings.verbosity}`,
    `- Structure: ${persona.settings.structure}`,
    `- Question style: ${persona.settings.questionStyle}`,
    `- Directness: ${persona.settings.directness}`,
    `- Emoji style: ${persona.settings.emojiStyle}`,
    `- Jargon tolerance: ${persona.settings.jargonTolerance}`,
    `- Assumption style: ${persona.settings.assumptionStyle}`,
    `- Confirmation style: ${persona.settings.confirmationStyle}`,
    "- These settings affect wording, guidance, and clarification style only.",
    "- They must not weaken approval gates, rollback rules, or destructive-action safeguards.",
  ];
  return lines.join("\n");
}
