import type { FridayUserPreference } from "../../uix/model/friday-uix.types.js";

export const FRIDAY_USER_CONSTITUTION_PREFERENCE_KEYS = {
  skepticalMode: "constitution.skeptical_mode",
  clarificationPolicy: "constitution.clarification_policy",
  challengePolicy: "constitution.challenge_policy",
  plainLanguagePolicy: "constitution.plain_language_policy",
} as const;

export const FRIDAY_USER_CONSTITUTION_KEY_SET = new Set<string>(
  Object.values(FRIDAY_USER_CONSTITUTION_PREFERENCE_KEYS),
);

export const FRIDAY_USER_CONSTITUTION_DEFAULTS = {
  [FRIDAY_USER_CONSTITUTION_PREFERENCE_KEYS.skepticalMode]: "enabled",
  [FRIDAY_USER_CONSTITUTION_PREFERENCE_KEYS.clarificationPolicy]: "ask_when_uncertain",
  [FRIDAY_USER_CONSTITUTION_PREFERENCE_KEYS.challengePolicy]: "challenge_risky_or_inconsistent",
  [FRIDAY_USER_CONSTITUTION_PREFERENCE_KEYS.plainLanguagePolicy]: "plain_language_for_decisions",
} as const;

export function isFridayUserConstitutionPreferenceKey(key: string): boolean {
  return FRIDAY_USER_CONSTITUTION_KEY_SET.has(key);
}

export function buildFridayUserConstitutionPromptFragment(): string {
  return [
    "[User Constitution / Skeptical Mode]",
    "- Ask the smallest useful clarifying question when intent, target, risk, or evidence is ambiguous.",
    "- Challenge requests that appear risky, internally inconsistent, unsupported by evidence, or likely to create false success.",
    "- Explain important tradeoffs and blockers in plain language before irreversible or high-impact actions.",
    "- Avoid guessing when a wrong assumption could affect user data, safety, cost, credentials, approval, memory, provider behavior, or release proof.",
    "- These rules guide planning and execution choices; they must not write memory, weaken approval gates, bypass safety policy, or lower release-proof standards.",
  ].join("\n");
}

export function buildFridayUserConstitutionPreferencePromptFragment(
  preferences: readonly FridayUserPreference[],
): string | null {
  const constitutionPreferences = preferences.filter((preference) =>
    preference.category === "reflex" && isFridayUserConstitutionPreferenceKey(preference.key),
  );
  if (constitutionPreferences.length === 0) return null;

  const lines = constitutionPreferences
    .slice()
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((preference) => `- ${preference.key}: ${JSON.stringify(preference.value)}`);
  return `Confirmed User Constitution settings:\n${lines.join("\n")}`;
}
