import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const topBarPath = path.join(
  process.cwd(),
  "ui/src/components/console/shell/top-bar.tsx",
);

describe("UI-W2 shell top bar token contract", () => {
  it("rejects the bare retired accent alias", () => {
    const retiredAccentSource = 'style={{ color: "var(--accent)" }}';

    expect(retiredAccentSource).toMatch(/--surface-|--ink-|--accent-soft|--accent\b|--rust-500/);
  });

  it("uses selected color tokens instead of retired shell aliases", () => {
    const source = readFileSync(topBarPath, "utf8");

    expect(source).not.toMatch(/--surface-|--ink-|--accent-soft|--accent\b|--rust-500/);
    expect(source).not.toContain("rgba(15, 125, 140");

    expect(source).toContain("--color-bg-chrome");
    expect(source).toContain("--color-bg-subtle");
    expect(source).toContain("--color-border-soft");
    expect(source).toContain("--color-text-primary");
    expect(source).toContain("--color-text-secondary");
    expect(source).toContain("--color-text-tertiary");
    expect(source).toContain("--color-accent");
    expect(source).toContain("--color-accent-soft");
    expect(source).toContain("--color-text-danger");
    expect(source).toContain("--color-text-success");
  });
});
