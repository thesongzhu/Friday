import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("proof no-mock leak gate CI wiring", () => {
  it("runs the anti-mock proof contamination gate as a required CI job", async () => {
    const workflowText = await readFile(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
    const packageText = await readFile(path.join(repoRoot, "package.json"), "utf8");

    expect(packageText).toContain("\"check:proof:no-mock-leaks\"");
    expect(workflowText).toMatch(/\n  proof-no-mock-leaks:\n/);
    expect(workflowText).toContain("npm run check:proof:no-mock-leaks");
    expect(workflowText).toMatch(/needs: \[[^\]]*proof-no-mock-leaks[^\]]*\]/);
    expect(workflowText).toContain("Proof No-Mock Leaks:");
  });
});
