import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readRepoFile = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("UI-W2 shell rail token contract", () => {
  it("keeps desktop and mobile shell rails on selected color tokens", () => {
    const source = readRepoFile("ui/src/components/console/shell/rail.tsx");

    const bannedFragments = [
      "var(--surface-1)",
      "var(--surface-border)",
      "var(--ink-900)",
      "var(--ink-700)",
      "var(--ink-500)",
      "var(--ink-300)",
      "var(--accent-soft)",
      "rgba(18, 40, 45, 0.10)",
    ];

    for (const fragment of bannedFragments) {
      expect(source, `shell rail should not use stale token fragment ${fragment}`).not.toContain(fragment);
    }

    const requiredFragments = [
      "var(--color-bg-chrome)",
      "var(--color-border-soft)",
      "var(--color-text-primary)",
      "var(--color-text-secondary)",
      "var(--color-text-tertiary)",
      "var(--color-text-faint)",
      "var(--color-accent-soft)",
    ];

    for (const fragment of requiredFragments) {
      expect(source, `shell rail should use selected token fragment ${fragment}`).toContain(fragment);
    }
  });
});
