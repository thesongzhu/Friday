import { describe, expect, it } from "vitest";

import {
  buildFridayCommunicationPromptFragment,
  FRIDAY_DEFAULT_COMMUNICATION_PERSONA,
  getFridayMbtiTemplateDefaults,
  resolveFridayCommunicationPersona,
} from "../../../../src/uix/services/friday-communication-persona.js";

describe("friday communication persona", () => {
  it("maps MBTI templates onto canonical communication settings", () => {
    expect(getFridayMbtiTemplateDefaults("INTJ")).toMatchObject({
      tone: "analytical",
      verbosity: "concise",
      directness: "direct",
      assumptionStyle: "infer_first",
    });
    expect(getFridayMbtiTemplateDefaults(null)).toEqual(FRIDAY_DEFAULT_COMMUNICATION_PERSONA);
  });

  it("resolves persona settings using explicit > learned > template > default precedence", () => {
    const resolved = resolveFridayCommunicationPersona({
      explicitPreferences: [
        {
          id: "pref-1",
          principalId: "user-1",
          category: "communication",
          key: "persona.mbti",
          value: "INFJ",
          source: "explicit",
          confidence: 1,
          createdAt: "2026-03-08T00:00:00.000Z",
          updatedAt: "2026-03-08T00:00:00.000Z",
        },
        {
          id: "pref-2",
          principalId: "user-1",
          category: "communication",
          key: "persona.tone",
          value: "analytical",
          source: "explicit",
          confidence: 1,
          createdAt: "2026-03-08T00:00:00.000Z",
          updatedAt: "2026-03-08T00:00:00.000Z",
        },
      ],
      learnedPreferences: {
        "persona.tone": "warm",
        "persona.question_style": "minimal",
      },
    });

    expect(resolved.mbti).toBe("INFJ");
    expect(resolved.settings.tone).toBe("analytical");
    expect(resolved.inheritedFrom.settings.tone).toBe("explicit");
    expect(resolved.settings.questionStyle).toBe("minimal");
    expect(resolved.inheritedFrom.settings.questionStyle).toBe("learned");
    expect(resolved.settings.structure).toBe("structured");
    expect(resolved.inheritedFrom.settings.structure).toBe("template");
  });

  it("builds a communication prompt fragment without touching safety semantics", () => {
    const fragment = buildFridayCommunicationPromptFragment(
      resolveFridayCommunicationPersona({
        explicitPreferences: [
          {
            id: "pref-1",
            principalId: "user-1",
            category: "communication",
            key: "persona.mbti",
            value: "ISTJ",
            source: "explicit",
            confidence: 1,
            createdAt: "2026-03-08T00:00:00.000Z",
            updatedAt: "2026-03-08T00:00:00.000Z",
          },
        ],
      }),
    );

    expect(fragment).toContain("MBTI template: ISTJ");
    expect(fragment).toContain("These settings affect wording, guidance, and clarification style only.");
    expect(fragment).toContain("must not weaken approval gates");
  });
});
