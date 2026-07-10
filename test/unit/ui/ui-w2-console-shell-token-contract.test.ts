import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const consoleShellPath = resolve(
  process.cwd(),
  "ui/src/components/console/shell/console-shell.tsx",
);

describe("UI-W2 console shell token contract", () => {
  it("keeps console shell chrome on selected color tokens", () => {
    const source = readFileSync(consoleShellPath, "utf8");

    expect(source).not.toMatch(/var\(--(?:surface|ink|accent|accent-soft|rust|ok|danger|paper|line|bg|hair|faint|muted)[^)]*\)/);
    expect(source).not.toContain("rgba(15, 125, 140");

    expect(source).toContain("var(--color-bg-base)");
    expect(source).toContain("var(--color-bg-surface)");
    expect(source).toContain("var(--color-bg-subtle)");
    expect(source).toContain("var(--color-border-soft)");
    expect(source).toContain("var(--color-text-primary)");
    expect(source).toContain("var(--color-text-secondary)");
    expect(source).toContain("var(--color-accent)");
    expect(source).toContain("var(--color-text-success)");
    expect(source).toContain("var(--color-text-danger)");
  });
});
