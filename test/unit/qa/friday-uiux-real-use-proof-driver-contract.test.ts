import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/friday-uiux-real-use-proof-driver.sh";

function writeDesignFixture(root: string) {
  const saved = join(root, "saved");
  mkdirSync(saved, { recursive: true });
  writeFileSync(join(saved, "mobile-selection.json"), JSON.stringify({
    operatorConfirmed: true,
    state: {
      truthLabel: "designProofOnly",
      homeLayout: "chatStatus",
      menuModel: "commandSheet",
      providerCardOpens: "workspaceHome",
      sessionControlSet: "fullNativeControl",
      approvalDepth: "summaryThenProof",
      entrypointPattern: "fullGridPostV1",
      passportPattern: "checklistSheet",
    },
    locked: [],
  }, null, 2));
  writeFileSync(join(saved, "desktop-selection.json"), JSON.stringify({
    operatorConfirmed: true,
    state: {
      truthLabel: "designProofOnly",
      layout: "threePane",
      providerParityView: "capabilityMatrixAndQueues",
      workflowBuilder: "canvasInspector",
    },
    locked: [],
  }, null, 2));
}

describe("friday-uiux-real-use-proof-driver contract", () => {
  it("orchestrates native linkage, real-use shortlist proof, and accessibility capture inputs without claiming END-BAR", () => {
    const source = readFileSync(script, "utf8");

    expect(source).toContain("check-friday-uiux-native-linkage.mjs");
    expect(source).toContain("friday-action-runtime-evidence-bundle.sh");
    expect(source).toContain("friday-ui-device-proof-shortlist-runner.sh");
    expect(source).toContain("--accessibility-capture");
    expect(source).toContain("uiux_real_use_proof_driver_summary_not_endbar_not_adoption");
    expect(source).toContain("END-BAR requires strict UI/device readiness");
    expect(source).toContain("never fabricates accessibility clicks");
  });

  it("has a plan-only mode that writes a non-proof summary", () => {
    const outDir = join(tmpdir(), `friday-uiux-real-use-proof-driver-plan-${Date.now()}`);
    const designRoot = join(outDir, "design");
    try {
      writeDesignFixture(designRoot);
      const output = execFileSync("bash", [
        script,
        "--plan-only",
        "--out-dir",
        outDir,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          FRIDAY_DESIGN_HANDOFF_ROOT: designRoot,
        },
      });
      const summaryPath = join(outDir, "uiux-real-use-proof-driver-summary.json");
      expect(existsSync(summaryPath)).toBe(true);
      const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as { truth?: string; status?: string; caveat?: string };
      expect(summary.truth).toBe("uiux_real_use_proof_driver_plan_only_not_runtime_proof");
      expect(summary.status).toBe("plan_ready");
      expect(summary.caveat).toContain("not END-BAR");
      expect(output).toContain("plan_ready");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
