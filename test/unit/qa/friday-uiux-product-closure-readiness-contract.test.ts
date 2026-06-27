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

  it("reports non-channel closure without upgrading channel-deferred runs to END-BAR", () => {
    const source = readFileSync("scripts/ops/friday-uiux-product-closure-readiness.mjs", "utf8");

    expect(source).toContain("nonChannelProductClosureReady");
    expect(source).toContain("nonChannelClosure:");
    expect(source).toContain("non_channel_uiux_closure_ready_channel_deferred");
    expect(source).toContain("Non-channel closure is not END-BAR");
    expect(source).toContain("never satisfies strict UI/device proof while channel proof is deferred");
  });

  it("surfaces residual evidence overlays without clearing END-BAR blockers", () => {
    const source = readFileSync("scripts/ops/friday-uiux-product-closure-readiness.mjs", "utf8");

    expect(source).toContain("residualEndBarEvidence");
    expect(source).toContain("does not clear product blockers or satisfy END-BAR by itself");
    expect(source).toContain("residualEndBarBlockers");
  });
});
