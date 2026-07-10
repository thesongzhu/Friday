import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOW_BUILDER_SOURCE = resolve(
  process.cwd(),
  "ui/src/components/workflows/workflow-builder-workspace.tsx",
);

describe("UI-W2 workflow builder token contract", () => {
  it("uses Friday tokens for workflow canvas edge colors", () => {
    const source = readFileSync(WORKFLOW_BUILDER_SOURCE, "utf8");

    expect(source).not.toContain("rgba(251, 113, 133");
    expect(source).not.toContain("rgba(251, 191, 36");
    expect(source).not.toContain("rgba(110, 231, 183");
    expect(source).not.toContain("rgba(125, 211, 252");
    expect(source).not.toContain("rgba(236, 245, 255");

    expect(source).toContain("WORKFLOW_BUILDER_EDGE_COLORS");
    expect(source).toContain("var(--color-text-danger)");
    expect(source).toContain("var(--color-text-warning)");
    expect(source).toContain("var(--color-accent)");
    expect(source).toContain("var(--color-border-soft)");
  });
});
