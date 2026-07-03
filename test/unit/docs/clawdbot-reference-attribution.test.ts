import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const referenceDir = "docs/clawdbot-reference";
const noticePath = join(referenceDir, "NOTICE.md");

describe("Clawdbot reference attribution", () => {
  it("keeps vendored Clawdbot reference files covered by an explicit attribution notice", () => {
    const referenceFiles = readdirSync(referenceDir)
      .filter((file) => file.endsWith(".ts"))
      .sort();

    expect(referenceFiles).toHaveLength(8);
    expect(existsSync(noticePath)).toBe(true);

    const notice = readFileSync(noticePath, "utf8");
    expect(notice).toContain("OpenClaw / Clawdbot");
    expect(notice).toContain("MIT License");
    expect(notice).toMatch(/Copyright \(c\) 2025 Peter Steinberger/);

    for (const file of referenceFiles) {
      expect(notice).toContain(file);
    }
  });

  it("links the BYOK reuse map to the attribution notice", () => {
    const byokDesign = readFileSync("docs/byok-design.md", "utf8");

    expect(byokDesign).toContain("docs/clawdbot-reference/NOTICE.md");
  });
});
