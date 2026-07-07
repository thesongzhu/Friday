import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const usagePageSource = () => readFileSync("ui/src/routes/usage-page.tsx", "utf8");

describe("UI-W2 usage page token drift", () => {
  it("keeps token usage bars on selected Friday color tokens", () => {
    const source = usagePageSource();
    const forbiddenLegacyProgressColors = ["#6366f1", "#8b5cf6"];

    expect(forbiddenLegacyProgressColors.filter((fragment) => source.includes(fragment))).toEqual([]);
    expect(source).toContain('const USAGE_INPUT_BAR_COLOR = "var(--color-accent)"');
    expect(source).toContain('const USAGE_OUTPUT_BAR_COLOR = "var(--coral)"');
    expect(source).toContain('const USAGE_PROVIDER_BAR_COLOR = "var(--color-accent)"');
  });
});
