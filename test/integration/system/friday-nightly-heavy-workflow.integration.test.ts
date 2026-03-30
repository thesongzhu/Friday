import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

describe("nightly heavy workflow", () => {
  it("auto-skips cloud checks when required cloud inputs are missing while preserving artifacts", async () => {
    const workflow = await fs.readFile(
      path.join(process.cwd(), ".github", "workflows", "nightly-heavy.yml"),
      "utf8",
    );

    expect(workflow).toContain("outputs:");
    expect(workflow).toContain("ready: ${{ steps.contract.outputs.ready }}");
    expect(workflow).toContain('if [ "$status" -eq 78 ]; then');
    expect(workflow).toContain("Nightly cloud contract skipped because required cloud inputs are missing.");
    expect(workflow).toContain("Upload cloud contract artifacts");
    expect(workflow).toContain("needs.cloud-contract-openai.outputs.ready == 'true'");
  });

  it("documents nightly auto-skip without weakening the manual cloud gate", async () => {
    const docs = await fs.readFile(
      path.join(process.cwd(), "docs", "CLOUD-E2E-HARNESS.md"),
      "utf8",
    );

    expect(docs).toContain("Nightly Heavy CI");
    expect(docs).toContain("auto-skips the cloud live leg");
    expect(docs).toContain(".github/workflows/cloud-e2e.yml");
    expect(docs).toContain("hard gate");
  });
});
