import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const TASK_WORKFLOWS_PAGE = "ui/src/routes/task-workflows-page.tsx";

const forbiddenNeutralHex = [
  "#666",
  "#999",
  "#ccc",
] as const;

describe("UI-W2 task workflows selected token drift contract", () => {
  it("keeps the legacy task workflows screen on selected neutral tokens", () => {
    const source = readFileSync(TASK_WORKFLOWS_PAGE, "utf8");

    expect(forbiddenNeutralHex.filter((fragment) => source.includes(fragment))).toEqual([]);
    expect(source).toContain("var(--color-text-secondary)");
    expect(source).toContain("var(--color-text-tertiary)");
    expect(source).toContain("var(--color-border-soft)");
  });
});
