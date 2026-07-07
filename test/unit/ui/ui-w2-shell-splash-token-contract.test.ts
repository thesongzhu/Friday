import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readRepoFile = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("UI-W2 shell splash token contract", () => {
  it("keeps splash shell surfaces and error accents on selected color tokens", () => {
    const files = [
      "ui/src/components/console/shell/splash/shell.tsx",
      "ui/src/components/console/shell/splash/auth-error.tsx",
      "ui/src/components/console/shell/splash/network-error.tsx",
    ];
    const source = files.map((file) => readRepoFile(file)).join("\n");

    const bannedFragments = [
      "var(--surface-0)",
      "var(--surface-2)",
      "var(--ink-900)",
      "var(--ink-700)",
      "var(--ink-500)",
      "var(--ink-300)",
      "var(--rust-500)",
      "rgba(176, 80, 58, 0.14)",
      "rgba(15, 125, 140, 0.22)",
    ];

    for (const fragment of bannedFragments) {
      expect(source, `splash shell should not use stale token fragment ${fragment}`).not.toContain(fragment);
    }

    const requiredFragments = [
      "var(--color-bg-base)",
      "var(--color-bg-surface-strong)",
      "var(--color-text-primary)",
      "var(--color-text-secondary)",
      "var(--color-text-tertiary)",
      "var(--color-text-faint)",
      "var(--color-text-danger)",
      "var(--color-bg-danger-subtle)",
      "var(--color-border-strong)",
    ];

    for (const fragment of requiredFragments) {
      expect(source, `splash shell should use selected token fragment ${fragment}`).toContain(fragment);
    }
  });
});
