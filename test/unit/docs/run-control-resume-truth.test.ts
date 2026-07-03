import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("run-control resume truth documentation", () => {
  it("documents that HTTP resume is intentionally narrower than sealed-WS run control", () => {
    const sourceOfTruth = readFileSync("docs/current-source-of-truth.md", "utf8");

    expect(sourceOfTruth).toContain("/v1/agent/runs/:runId/resume");
    expect(sourceOfTruth).toContain("FRIDAY_AGENT_RUN_CONTROL_VIA_RUST");
    expect(sourceOfTruth).toMatch(/sealed-WS/i);
    expect(sourceOfTruth).toMatch(/short-circuit[s]? to 503/i);
    expect(sourceOfTruth).toContain("before any run lookup");
  });
});
