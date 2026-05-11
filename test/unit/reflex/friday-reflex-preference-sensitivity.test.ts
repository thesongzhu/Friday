import { describe, expect, it } from "vitest";

import {
  isFridayReflexConfirmationRequiredKey,
  requiresFridayReflexPreferenceConfirmation,
} from "../../../src/reflex/services/friday-reflex-preference-sensitivity.js";

const KNOWN_HIGH_IMPACT_KEYS: readonly string[] = [
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
];

describe("isFridayReflexConfirmationRequiredKey", () => {
  it("returns true for every known confirmation-required reflex key", () => {
    for (const key of KNOWN_HIGH_IMPACT_KEYS) {
      expect(isFridayReflexConfirmationRequiredKey(key), key).toBe(true);
    }
  });

  it("returns false for benign learned-preference keys", () => {
    const benign = [
      "language",
      "framework",
      "typescript_mode",
      "persona.verbosity",
      "communication.tone",
      "display_name",
      "ui.theme",
      "",
    ];
    for (const key of benign) {
      expect(isFridayReflexConfirmationRequiredKey(key), key).toBe(false);
    }
  });

  it("returns false for keys that look high-impact-shaped but are not in the set", () => {
    const lookalikes = [
      "automation.unknown_policy",
      "memory.unknown_policy",
      "safety.unknown_policy",
      "automation",
      "memory",
      "safety",
    ];
    for (const key of lookalikes) {
      expect(isFridayReflexConfirmationRequiredKey(key), key).toBe(false);
    }
  });
});

describe("requiresFridayReflexPreferenceConfirmation (existing semantics preserved)", () => {
  it("requires both category=reflex and a known key", () => {
    expect(
      requiresFridayReflexPreferenceConfirmation({
        category: "reflex",
        key: "automation.conservatism",
      }),
    ).toBe(true);
  });

  it("returns false when key is known but category is not reflex", () => {
    expect(
      requiresFridayReflexPreferenceConfirmation({
        category: "communication",
        key: "automation.conservatism",
      }),
    ).toBe(false);
  });

  it("returns false when category is reflex but key is benign", () => {
    expect(
      requiresFridayReflexPreferenceConfirmation({
        category: "reflex",
        key: "language",
      }),
    ).toBe(false);
  });

  it("agrees with isFridayReflexConfirmationRequiredKey on the key match for category=reflex", () => {
    for (const key of KNOWN_HIGH_IMPACT_KEYS) {
      expect(
        requiresFridayReflexPreferenceConfirmation({
          category: "reflex",
          key,
        }),
      ).toBe(isFridayReflexConfirmationRequiredKey(key));
    }
  });
});
