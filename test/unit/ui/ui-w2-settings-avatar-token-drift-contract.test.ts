import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const settingsPageSource = () => readFileSync("ui/src/routes/settings-page.tsx", "utf8");

describe("UI-W2 settings guide avatar token drift", () => {
  it("keeps the guide avatar on selected neutral surface tokens", () => {
    const source = settingsPageSource();

    expect(source).not.toContain("bg-[#c4c7c5]");
    expect(source).toContain("bg-[color:var(--color-bg-surface-strong)]");
    expect(source).toContain("text-[color:var(--color-accent)]");
  });
});
