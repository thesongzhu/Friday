import { describe, expect, it } from "vitest";

import {
  buildPersonaDraft,
  buildPersonaPreview,
  COMMUNICATION_MBTI_OPTIONS,
  getMbtiDefaults,
} from "../../../ui/src/lib/persona/communication-persona";

describe("communication persona view models", () => {
  it("exposes all MBTI starter templates", () => {
    expect(COMMUNICATION_MBTI_OPTIONS).toHaveLength(16);
    expect(COMMUNICATION_MBTI_OPTIONS).toContain("INFJ");
  });

  it("builds a preview for direct and warm settings", () => {
    const preview = buildPersonaPreview({
      tone: "warm",
      verbosity: "balanced",
      structure: "structured",
      questionStyle: "guided",
      directness: "direct",
      emojiStyle: "light",
      jargonTolerance: "medium",
      assumptionStyle: "balanced",
      confirmationStyle: "explicit",
    });

    expect(preview.styleLabel).toContain("warm");
    expect(preview.sampleBoundary).toContain("approval");
  });

  it("builds draft state from persona or MBTI defaults", () => {
    const draft = buildPersonaDraft();
    const defaults = getMbtiDefaults("INTJ");

    expect(draft.mbti).toBe("");
    expect(defaults.directness).toBe("direct");
    expect(defaults.assumptionStyle).toBe("infer_first");
  });
});
