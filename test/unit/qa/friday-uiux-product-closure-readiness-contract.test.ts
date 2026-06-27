import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("friday-uiux-product-closure-readiness contract", () => {
  it("evaluates UI/device evidence candidates instead of letting repeated evidence-dir args overwrite each other", () => {
    const source = readFileSync("scripts/ops/friday-uiux-product-closure-readiness.mjs", "utf8");

    expect(source).toContain("function uiDeviceEvidenceDirCandidates");
    expect(source).toContain('resolve(resolved, "evidence")');
    expect(source).toContain("uiDeviceReadinessCandidates.push(runReadiness(candidateDir))");
    expect(source).toContain("sort((left, right) => right.score - left.score)");
    expect(source).toContain("selectedEvidenceDir");
  });

  it("keeps channel deferral explicit and blocked", () => {
    const source = readFileSync("scripts/ops/friday-uiux-product-closure-readiness.mjs", "utf8");

    expect(source).toContain("--defer-channel-proof");
    expect(source).toContain("FRIDAY_UI_DEVICE_DEFER_CHANNEL_PROOF");
    expect(source).toContain("channel_deferred_strict_assembly_blocked");
    expect(source).not.toContain('report.status === "blocked" && deferChannelProof');
  });
});
