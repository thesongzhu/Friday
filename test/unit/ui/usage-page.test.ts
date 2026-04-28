import { describe, expect, it } from "vitest";

import { formatTokenSharePercent } from "../../../ui/src/routes/usage-page";

describe("usage page token share formatting", () => {
  it("derives input and output percentages from recorded token totals", () => {
    const inputTokens = 3_740_852;
    const outputTokens = 81_757;
    const totalTokens = 3_822_609;

    expect(formatTokenSharePercent(inputTokens, totalTokens)).toBe("98%");
    expect(formatTokenSharePercent(outputTokens, totalTokens)).toBe("2%");
  });

  it("does not leak stale placeholder percentages when totals are missing", () => {
    expect(formatTokenSharePercent(35, 0)).toBe("0%");
    expect(formatTokenSharePercent(Number.NaN, 100)).toBe("0%");
  });
});
