import { describe, expect, it } from "vitest";
import { summarizeFridaySkillConversionQuality } from "#skills/converter";

describe("summarizeFridaySkillConversionQuality", () => {
  it("returns high quality baseline when validation list is empty", () => {
    const summary = summarizeFridaySkillConversionQuality([]);

    expect(summary).toEqual({
      score: 100,
      status: "high",
      draftPassRate: 1,
      issueCounts: {
        error: 0,
        warning: 0,
        info: 0,
      },
    });
  });

  it("aggregates issue counts and computes medium quality score", () => {
    const summary = summarizeFridaySkillConversionQuality([
      {
        skillId: "skill-a",
        ok: false,
        issues: [
          { stage: "manifest", severity: "error", code: "E1", message: "manifest error" },
          { stage: "manifest", severity: "warning", code: "W1", message: "manifest warning" },
          { stage: "runtime", severity: "info", code: "I1", message: "runtime note" },
        ],
      },
      {
        skillId: "skill-b",
        ok: true,
        issues: [],
      },
    ]);

    expect(summary.issueCounts).toEqual({
      error: 1,
      warning: 1,
      info: 1,
    });
    expect(summary.draftPassRate).toBe(0.5);
    expect(summary.score).toBe(69);
    expect(summary.status).toBe("medium");
  });

  it("clamps score at zero for severe validation failures", () => {
    const summary = summarizeFridaySkillConversionQuality([
      {
        skillId: "skill-hard-fail",
        ok: false,
        issues: Array.from({ length: 8 }, (_, index) => ({
          stage: "manifest" as const,
          severity: "error" as const,
          code: `E-${String(index)}`,
          message: "fatal",
        })),
      },
    ]);

    expect(summary.score).toBe(0);
    expect(summary.status).toBe("low");
  });
});
