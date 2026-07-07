import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const providerTruthSourcePath = resolve(
  process.cwd(),
  "ui/src/components/console/shell/provider-truth.tsx",
);

describe("UI-W2 provider truth token contract", () => {
  it("keeps provider truth chrome on selected color tokens", () => {
    const source = readFileSync(providerTruthSourcePath, "utf8");

    expect(source).not.toMatch(/var\(--(?:surface|ink|accent|accent-soft|rust-500)[^)]*\)/);
    expect(source).not.toContain("rgba(15, 125, 140");

    expect(source).toContain("var(--color-bg-subtle)");
    expect(source).toContain("var(--color-text-secondary)");
    expect(source).toContain("var(--color-accent)");
    expect(source).toContain("var(--color-status-danger)");
  });
});
