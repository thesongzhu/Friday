import { describe, it, expect } from "vitest";
import { buildFridayLearningContextFragment } from "../../../../src/agent/runtime/friday-agent-workspace-context.js";

describe("buildFridayLearningContextFragment", () => {
  it("returns empty string when no input data is provided", () => {
    const result = buildFridayLearningContextFragment({});
    expect(result).toBe("");
  });

  it("renders individuation stage", () => {
    const result = buildFridayLearningContextFragment({
      individuationStage: "familiar",
    });
    expect(result).toContain("<learning-context>");
    expect(result).toContain("**Individuation stage**: familiar");
    expect(result).toContain("</learning-context>");
  });

  it("renders active patterns sorted by strength", () => {
    const result = buildFridayLearningContextFragment({
      activePatterns: [
        { kind: "preference_drift", key: "lang.preference", strength: 0.5 },
        { kind: "failure_cluster", key: "timeout_errors", strength: 0.9 },
        { kind: "stable_preference", key: "format.json", strength: 0.7 },
      ],
    });

    expect(result).toContain("**Active patterns**:");
    // Highest strength first
    const timeoutIdx = result.indexOf("timeout_errors");
    const formatIdx = result.indexOf("format.json");
    const langIdx = result.indexOf("lang.preference");
    expect(timeoutIdx).toBeLessThan(formatIdx);
    expect(formatIdx).toBeLessThan(langIdx);
  });

  it("limits patterns to top 5", () => {
    const patterns = Array.from({ length: 8 }, (_, i) => ({
      kind: "test",
      key: `pattern-${i}`,
      strength: i * 0.1,
    }));
    const result = buildFridayLearningContextFragment({ activePatterns: patterns });

    // Should only have 5 pattern lines
    const patternLines = result.split("\n").filter((l) => l.startsWith("- ["));
    expect(patternLines.length).toBe(5);
  });

  it("renders satisfaction trend", () => {
    const result = buildFridayLearningContextFragment({
      satisfactionTrend: { average: 0.42, trend: "improving", recentSessions: 12 },
    });
    expect(result).toContain("**Satisfaction**: avg 0.42, trend improving (12 sessions)");
  });

  it("skips satisfaction when recentSessions is 0", () => {
    const result = buildFridayLearningContextFragment({
      satisfactionTrend: { average: 0, trend: "stable", recentSessions: 0 },
    });
    expect(result).toBe("");
  });

  it("respects maxChars limit", () => {
    const result = buildFridayLearningContextFragment({
      individuationStage: "companion",
      activePatterns: Array.from({ length: 5 }, (_, i) => ({
        kind: "test",
        key: `very-long-pattern-name-${i}-extra-text-here`,
        strength: 0.8,
      })),
      maxChars: 100,
    });

    expect(result.length).toBeLessThanOrEqual(100);
  });

  it("combines all elements in a single fragment", () => {
    const result = buildFridayLearningContextFragment({
      individuationStage: "acquaintance",
      activePatterns: [
        { kind: "error_cluster", key: "rate_limit", strength: 0.8 },
      ],
      satisfactionTrend: { average: 0.15, trend: "stable", recentSessions: 5 },
    });

    expect(result).toContain("Individuation stage");
    expect(result).toContain("Satisfaction");
    expect(result).toContain("Active patterns");
  });
});
