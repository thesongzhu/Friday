import type { JsonValue } from "../../uix/model/friday-uix.types.js";
import type { FridayReflexPreferenceWrite } from "../model/friday-reflex.types.js";

function selectedValue(answer: Record<string, JsonValue>): string | null {
  const value = answer["value"];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function customText(answer: Record<string, JsonValue>): string | null {
  const value = answer["text"];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function resolveFridayReflexOnboardingPreferenceWrites(input: {
  questionId: string;
  answer: Record<string, JsonValue>;
}): FridayReflexPreferenceWrite[] {
  const value = selectedValue(input.answer);
  if (!value) return [];

  switch (input.questionId) {
    case "O1":
      return value === "follow_input"
        ? [{ category: "reflex", key: "communication.language_policy", value }]
        : [
          { category: "reflex", key: "communication.language_policy", value },
          { category: "uix", key: "display.locale", value },
        ];
    case "O2": {
      const text = customText(input.answer);
      return value === "custom" && text
        ? [{ category: "reflex", key: "user.display_name", value: text }]
        : [];
    }
    case "O3":
      return [{ category: "communication", key: "persona.verbosity", value }];
    case "O4":
      return [{ category: "communication", key: "persona.structure", value }];
    case "O5":
      return [{ category: "communication", key: "persona.assumption_style", value }];
    case "O6":
      return [{ category: "reflex", key: "memory.explicit_instruction_policy", value }];
    case "O7":
      return [{ category: "reflex", key: "memory.inferred_preference_policy", value }];
    case "O8":
      return [{ category: "reflex", key: "automation.repeated_task_policy", value }];
    case "O9":
      return [{ category: "reflex", key: "skills.existing_skill_policy", value }];
    case "O10":
      return [{ category: "reflex", key: "skills.generation_policy", value }];
    case "O11":
      return [{ category: "reflex", key: "workflows.generation_policy", value }];
    case "O12":
      return [{ category: "reflex", key: "cold_start.scan_scope", value }];
    case "O13":
      return [{ category: "reflex", key: "skills.import_policy", value }];
    case "O14":
      return [{ category: "reflex", key: "testing.code_depth", value }];
    case "O15":
      return [{ category: "reflex", key: "testing.unknown_scenarios", value }];
    case "O16":
      return [{ category: "reflex", key: "recovery.failure_policy", value }];
    case "O17":
      return [{ category: "reflex", key: "safety.high_risk_change_policy", value }];
    case "O18":
      return [{ category: "reflex", key: "review.notification_surface", value }];
    case "O19":
      return [{ category: "reflex", key: "recipes.success_summarization_policy", value }];
    case "O20":
      return [{ category: "reflex", key: "memory.conflict_policy", value }];
    case "O21":
      return [{ category: "reflex", key: "memory.proactive_search_policy", value }];
    case "O22":
      return [{ category: "reflex", key: "learning.transparency_policy", value }];
    case "O23":
      return [{ category: "reflex", key: "automation.conservatism", value }];
    case "O24":
      return [{ category: "reflex", key: "testing.live_llm_policy", value }];
    default:
      return [];
  }
}

export function isFridayReflexPreferenceKey(key: string): boolean {
  return [
    "user.display_name",
    "communication.language_policy",
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
    "review.notification_surface",
    "recipes.success_summarization_policy",
    "memory.conflict_policy",
    "memory.proactive_search_policy",
    "learning.transparency_policy",
    "automation.conservatism",
    "testing.live_llm_policy",
  ].includes(key);
}
