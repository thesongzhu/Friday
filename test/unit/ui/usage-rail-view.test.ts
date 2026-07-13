import { describe, it, expect } from "vitest";
import {
  deriveUsageRailView,
  emptyUsageRailView,
  formatRailUsd,
} from "../../../ui/src/lib/usage/usage-rail-view";
import type { FridayProviderUsageSummary } from "../../../ui/src/lib/api/types";

// The usage rail must be truthful: figures come from recorded usage data, and a
// zero/absent state shows zero — never a fabricated number.
describe("usage rail view", () => {
  it("zero state (no summary) shows $0.00 and zero tokens", () => {
    const v = deriveUsageRailView(undefined, "2026-02-17");
    expect(v).toEqual(emptyUsageRailView());
    expect(formatRailUsd(v.cumulativeUsd)).toBe("$0.00");
    expect(formatRailUsd(v.todayUsd)).toBe("$0.00");
    expect(v.totalTokens).toBe(0);
  });

  it("an empty (but loaded) summary shows $0.00", () => {
    const summary: FridayProviderUsageSummary = {
      from: "2026-02-01",
      to: "2026-02-17",
      groupBy: "day",
      rows: [],
      totals: {
        callCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        costUsd: 0,
      },
    };
    const v = deriveUsageRailView(summary, "2026-02-17");
    expect(v.hasData).toBe(true);
    expect(formatRailUsd(v.cumulativeUsd)).toBe("$0.00");
    expect(formatRailUsd(v.todayUsd)).toBe("$0.00");
  });

  it("derives cumulative (month-to-date) and today's cost from recorded rows", () => {
    const summary: FridayProviderUsageSummary = {
      from: "2026-02-01",
      to: "2026-02-17",
      groupBy: "day",
      rows: [
        { day: "2026-02-16", callCount: 2, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 150, costUsd: 0.03 },
        { day: "2026-02-17", callCount: 1, inputTokens: 200, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 280, costUsd: 0.05 },
      ],
      totals: {
        callCount: 3,
        inputTokens: 300,
        outputTokens: 130,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 430,
        costUsd: 0.08,
      },
    };
    const v = deriveUsageRailView(summary, "2026-02-17");
    expect(v.cumulativeUsd).toBeCloseTo(0.08, 10);
    expect(v.todayUsd).toBeCloseTo(0.05, 10); // only 2026-02-17's row
    expect(v.callCount).toBe(3);
    expect(v.totalTokens).toBe(430);
    expect(formatRailUsd(v.cumulativeUsd)).toBe("$0.08");
  });

  it("formats a real-but-sub-cent spend as <$0.01 (never rounded to nothing)", () => {
    expect(formatRailUsd(0.0004)).toBe("<$0.01");
    expect(formatRailUsd(0)).toBe("$0.00");
    expect(formatRailUsd(-5)).toBe("$0.00");
  });
});
