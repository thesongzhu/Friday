import type { FridayUserPreferenceCategory } from "../../uix/model/friday-uix.types.js";
import { FRIDAY_USER_CONSTITUTION_PREFERENCE_KEYS } from "./friday-user-constitution.js";

const CONFIRMATION_REQUIRED_REFLEX_KEYS = new Set([
  FRIDAY_USER_CONSTITUTION_PREFERENCE_KEYS.skepticalMode,
  FRIDAY_USER_CONSTITUTION_PREFERENCE_KEYS.clarificationPolicy,
  FRIDAY_USER_CONSTITUTION_PREFERENCE_KEYS.challengePolicy,
  FRIDAY_USER_CONSTITUTION_PREFERENCE_KEYS.plainLanguagePolicy,
  "memory.explicit_instruction_policy",
  "memory.inferred_preference_policy",
  "automation.repeated_task_policy",
  "skills.existing_skill_policy",
  "skills.generation_policy",
  "workflows.generation_policy",
  "cold_start.scan_scope",
  "skills.import_policy",
  "testing.code_depth",
  "testing.unknown_scenarios",
  "recovery.failure_policy",
  "safety.high_risk_change_policy",
  "recipes.success_summarization_policy",
  "memory.conflict_policy",
  "memory.proactive_search_policy",
  "automation.conservatism",
  "testing.live_llm_policy",
]);

export function requiresFridayReflexPreferenceConfirmation(input: {
  category: FridayUserPreferenceCategory;
  key: string;
}): boolean {
  return input.category === "reflex" && CONFIRMATION_REQUIRED_REFLEX_KEYS.has(input.key);
}

/**
 * Key-only check for membership in the confirmation-required set.
 * For callers that have a preference key but no UIX category — e.g.
 * learned-preference injectors that need to fail closed on high-impact-shaped
 * keys regardless of which surface produced them.
 *
 * Distinct from requiresFridayReflexPreferenceConfirmation, which gates on
 * (category === "reflex") AND key match: that signature stays unchanged so
 * existing UIX preference callers keep their category guard.
 */
export function isFridayReflexConfirmationRequiredKey(key: string): boolean {
  return CONFIRMATION_REQUIRED_REFLEX_KEYS.has(key);
}
