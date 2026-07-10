import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const usageRailSourcePath = resolve(
  process.cwd(),
  "ui/src/components/console/shell/right-rail-slots/usage.tsx",
);

describe("UI-W2 usage right rail token contract", () => {
  it("keeps usage right rail rows on selected color tokens", () => {
    const source = readFileSync(usageRailSourcePath, "utf8");

    expect(source).not.toMatch(/var\(--(?:surface|ink|accent|accent-soft)[^)]*\)/);

    expect(source).toContain("var(--color-bg-subtle)");
    expect(source).toContain("var(--color-border-soft)");
    expect(source).toContain("var(--color-text-primary)");
    expect(source).toContain("var(--color-text-secondary)");
    expect(source).toContain("var(--color-accent)");
  });
});
