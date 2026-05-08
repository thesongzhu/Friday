import type { FridayUserPreferenceCategory } from "../../uix/model/friday-uix.types.js";

const CONFIRMATION_REQUIRED_REFLEX_KEYS = new Set([
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
