import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/check-friday-uiux-selected-visual-proof.mjs";

function writeFile(root: string, relative: string, body: string) {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
  return target;
}

function writeSelections(designRoot: string) {
  writeFile(designRoot, "saved/mobile-selection.json", JSON.stringify({
    surface: "mobile",
    selectionKind: "mobile-final (operator-confirmed 2026-06-04)",
    operatorConfirmed: true,
    state: {
      truthLabel: "designProofOnly",
      palette: "cyanCoral",
      form: "glassNative",
      petStyle: "retroLcd",
      homeLayout: "chatStatus",
    },
    locked: ["Chat + Status home"],
  }, null, 2));
  writeFile(designRoot, "saved/desktop-selection.json", JSON.stringify({
    surface: "desktop",
    selectionKind: "desktop-final (operator-confirmed 2026-06-09)",
    operatorConfirmed: true,
    state: {
      truthLabel: "designProofOnly",
      palette: "cyanCoral",
      form: "glassNative",
      layout: "threePane",
    },
    locked: ["Desktop localhost remains Hub Console"],
  }, null, 2));
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "friday-uiux-selected-visual-proof-"));
  const designRoot = join(root, "design");
  writeSelections(designRoot);
  return { root, designRoot };
}

function writeReadyEvidence(root: string, mode = "live-loopback") {
  const evidence = join(root, "evidence");
  writeFile(evidence, "ios-design-destination-capture-manifest.json", JSON.stringify({
    truth_label: "ios_selected_design_destination_capture_not_live_closure",
    status: "ready",
    generated_at_utc: "2026-06-27T00:00:00.000Z",
    mode,
    captures: [
      "home",
      "session",
      "contextPassport",
      "tokenLedger",
      "shareIntake",
      "voice",
      "pairing",
      "providerAuth",
      "activity",
      "workflows",
    ].map((destination) => ({ destination, status: "captured", screenshot: `${destination}.png` })),
  }, null, 2));
  writeFile(evidence, "desktop-ax-accessibility-capture.json", JSON.stringify({
    truth_label: "ui_device_accessibility_click_capture_real_ui_not_endbar",
    ui_actions: [
      "operations",
      "chat",
      "session",
      "pairingProvisioning",
      "providerAdmin",
      "parity",
      "workflow",
      "evidence",
    ].map((screen) => ({ screen, status: "pass", runtimeActionId: `desktop/${screen}/check` })),
  }, null, 2));
  return evidence;
}

describe("check-friday-uiux-selected-visual-proof", () => {
  it("reports missing selected visual proof without failing default mode", () => {
    const { root, designRoot } = fixture();
    try {
      const output = execFileSync("node", [
        script,
        `--repo-root=${root}`,
        `--design-root=${designRoot}`,
      ], { cwd: process.cwd(), encoding: "utf8" });
      const report = JSON.parse(output) as { status?: string; blockers?: Array<{ code?: string }> };
      expect(report.status).toBe("selected_visual_proof_gaps_present");
      expect(report.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "mobile_selected_visual_proof_missing" }),
        expect.objectContaining({ code: "desktop_selected_visual_proof_missing" }),
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed in require-complete mode when visual proof is missing", () => {
    const { root, designRoot } = fixture();
    try {
      const result = spawnSync("node", [
        script,
        `--repo-root=${root}`,
        `--design-root=${designRoot}`,
        "--require-complete",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as { status?: string };
      expect(report.status).toBe("selected_visual_proof_gaps_present");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes when current selected mobile and desktop visual evidence is present", () => {
    const { root, designRoot } = fixture();
    try {
      const evidence = writeReadyEvidence(root);
      const output = execFileSync("node", [
        script,
        `--repo-root=${root}`,
        `--design-root=${designRoot}`,
        `--evidence-dir=${evidence}`,
        "--require-complete",
      ], { cwd: process.cwd(), encoding: "utf8" });
      const report = JSON.parse(output) as { status?: string; blockers?: unknown[] };
      expect(report.status).toBe("selected_visual_proof_ready");
      expect(report.blockers).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes when current selected mobile visual evidence is a design-proof sample", () => {
    const { root, designRoot } = fixture();
    try {
      const evidence = writeReadyEvidence(root, "design-proof-sample");
      const output = execFileSync("node", [
        script,
        `--repo-root=${root}`,
        `--design-root=${designRoot}`,
        `--evidence-dir=${evidence}`,
        "--require-complete",
      ], { cwd: process.cwd(), encoding: "utf8" });
      const report = JSON.parse(output) as { status?: string; blockers?: unknown[] };
      expect(report.status).toBe("selected_visual_proof_ready");
      expect(report.blockers).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects offline-truth captures as selected mobile visual proof", () => {
    const { root, designRoot } = fixture();
    try {
      const evidence = writeReadyEvidence(root, "offline-truth");
      const result = spawnSync("node", [
        script,
        `--repo-root=${root}`,
        `--design-root=${designRoot}`,
        `--evidence-dir=${evidence}`,
        "--require-complete",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as {
        status?: string;
        blockers?: Array<{ code?: string }>;
        evidence?: { ios?: Array<{ modeStatus?: string }> };
      };
      expect(report.status).toBe("selected_visual_proof_gaps_present");
      expect(report.evidence?.ios?.[0]?.modeStatus).toBe("negative_control_not_visual_proof");
      expect(report.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "mobile_selected_visual_proof_missing" }),
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
