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

function initFixtureRepo(root: string) {
  writeFile(root, ".fixture", "fixture repo for selected visual proof tests\n");
  execFileSync("git", ["-C", root, "init", "-q"], { encoding: "utf8" });
  execFileSync("git", ["-C", root, "config", "user.email", "friday-fixture@example.invalid"], { encoding: "utf8" });
  execFileSync("git", ["-C", root, "config", "user.name", "Friday Fixture"], { encoding: "utf8" });
  execFileSync("git", ["-C", root, "add", ".fixture", "design"], { encoding: "utf8" });
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"], { encoding: "utf8" });
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function fixtureHead(root: string) {
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "friday-uiux-selected-visual-proof-"));
  const designRoot = join(root, "design");
  writeSelections(designRoot);
  const head = initFixtureRepo(root);
  return { root, designRoot, head };
}

function writeReadyEvidence(root: string, mode = "live-loopback") {
  const evidence = join(root, "evidence");
  const head = fixtureHead(root);
  writeFile(evidence, "ios-design-destination-capture-manifest.json", JSON.stringify({
    truth_label: "ios_selected_design_destination_capture_not_live_closure",
    status: "ready",
    generated_at_utc: "2026-06-27T00:00:00.000Z",
    repo_head: head,
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
    generated_at_utc: "2026-06-27T00:00:00.000Z",
    status: "partial_capture_ready",
    repo: { head },
    mode: "live-loopback",
    live_connection: {
      read_host: "127.0.0.1",
      read_port: "59155",
      workbench_mission_id: "mission_selected_visual_fixture",
      mock: false,
      status: "mission_bound_live_read_requested",
    },
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

function writeDesktopCapture(root: string, relative: string, screens: string[], mission = "mission_selected_visual_fixture") {
  const evidence = join(root, relative);
  const head = fixtureHead(root);
  writeFile(evidence, "desktop-ax-accessibility-capture.json", JSON.stringify({
    truth_label: "ui_device_accessibility_click_capture_real_ui_not_endbar",
    generated_at_utc: "2026-06-27T00:00:00.000Z",
    status: "partial_capture_ready",
    repo: { head },
    mode: "live-loopback",
    live_connection: {
      read_host: "127.0.0.1",
      read_port: "59155",
      workbench_mission_id: mission,
      mock: false,
      status: "mission_bound_live_read_requested",
    },
    ui_actions: screens.map((screen) => ({ screen, status: "pass", runtimeActionId: `desktop/${screen}/check` })),
  }, null, 2));
  return evidence;
}

function writeServedUiReport(root: string, relative = "evidence", overrides: Record<string, unknown> = {}) {
  const evidence = join(root, relative);
  writeFile(evidence, "served-ui-design-fidelity.json", JSON.stringify({
    status: "pass",
    truth_label: "served_desktop_and_ios_design_fidelity_reads_real_selection_and_live_sources",
    generated_at_utc: "2026-06-30T00:00:00.000Z",
    head: fixtureHead(root),
    distRoot: `${root}/dist/ui`,
    iosSourceRoot: `${root}/apps/friday-ios/Sources/FridayMobileShell`,
    failureCount: 0,
    checks: [
      { ok: true, message: "operator-confirmed selections loaded", details: {} },
      { ok: true, message: "iOS source applies selected mobile design system and keeps debug/readiness surfaces out of the user path", details: {} },
      { ok: true, message: "served ui build completed", details: {} },
      { ok: true, message: "built css applies cyan/coral tokens and excludes stale decorative palette remnants", details: {} },
      { ok: true, message: "served desktop rendered structure matches selected design", details: {} },
    ],
    ...overrides,
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

  it("passes when selected desktop visual evidence comes from current served ui fidelity", () => {
    const { root, designRoot } = fixture();
    try {
      const evidence = writeReadyEvidence(root);
      writeFile(evidence, "desktop-ax-accessibility-capture.json", JSON.stringify({
        truth_label: "bad_truth",
        status: "partial_capture_ready",
        ui_actions: [],
      }, null, 2));
      writeServedUiReport(root, "served-ui");
      const output = execFileSync("node", [
        script,
        `--repo-root=${root}`,
        `--design-root=${designRoot}`,
        `--evidence-dir=${evidence}`,
        `--evidence-dir=${join(root, "served-ui")}`,
        "--require-complete",
      ], { cwd: process.cwd(), encoding: "utf8" });
      const report = JSON.parse(output) as {
        status?: string;
        evidence?: { servedUi?: Array<{ status?: string; sourceStatus?: string }> };
      };
      expect(report.status).toBe("selected_visual_proof_ready");
      expect(report.evidence?.servedUi?.[0]).toMatchObject({
        status: "ready",
        sourceStatus: "served_desktop_dist_ui_and_ios_source",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not accept served ui fidelity when the source scope is not the served desktop ui", () => {
    const { root, designRoot } = fixture();
    try {
      const evidence = writeReadyEvidence(root);
      writeFile(evidence, "desktop-ax-accessibility-capture.json", JSON.stringify({
        truth_label: "bad_truth",
        status: "partial_capture_ready",
        ui_actions: [],
      }, null, 2));
      writeServedUiReport(root, "served-ui", {
        distRoot: `${root}/apps/macos/FridayHubConsole`,
      });
      const result = spawnSync("node", [
        script,
        `--repo-root=${root}`,
        `--design-root=${designRoot}`,
        `--evidence-dir=${evidence}`,
        `--evidence-dir=${join(root, "served-ui")}`,
        "--require-complete",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as {
        status?: string;
        evidence?: { servedUi?: Array<{ status?: string; sourceStatus?: string }> };
        blockers?: Array<{ code?: string }>;
      };
      expect(report.status).toBe("selected_visual_proof_gaps_present");
      expect(report.evidence?.servedUi?.[0]).toMatchObject({
        status: "gap",
        sourceStatus: "unexpected_source_scope",
      });
      expect(report.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "desktop_selected_visual_proof_missing" }),
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not accept stale served ui fidelity when the repo head is known", () => {
    const { root, designRoot } = fixture();
    try {
      const evidence = writeReadyEvidence(root);
      writeFile(evidence, "desktop-ax-accessibility-capture.json", JSON.stringify({
        truth_label: "bad_truth",
        status: "partial_capture_ready",
        ui_actions: [],
      }, null, 2));
      writeServedUiReport(root, "served-ui", {
        head: "0000000000000000000000000000000000000000",
        distRoot: `${process.cwd()}/dist/ui`,
        iosSourceRoot: `${process.cwd()}/apps/friday-ios/Sources/FridayMobileShell`,
      });
      const result = spawnSync("node", [
        script,
        `--repo-root=${process.cwd()}`,
        `--design-root=${designRoot}`,
        `--evidence-dir=${evidence}`,
        `--evidence-dir=${join(root, "served-ui")}`,
        "--require-complete",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as {
        evidence?: { servedUi?: Array<{ status?: string; headStatus?: string }> };
        blockers?: Array<{ code?: string }>;
      };
      expect(report.evidence?.servedUi?.[0]).toMatchObject({
        status: "gap",
        headStatus: "stale_or_wrong_head",
      });
      expect(report.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "desktop_selected_visual_proof_missing" }),
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes when same-mission desktop visual evidence is split across live segments", () => {
    const { root, designRoot } = fixture();
    try {
      const evidence = writeReadyEvidence(root);
      writeFile(evidence, "desktop-ax-accessibility-capture.json", JSON.stringify({
        truth_label: "ui_device_accessibility_click_capture_real_ui_not_endbar",
        status: "partial_capture_ready",
        repo: { head: fixtureHead(root) },
        mode: "live-loopback",
        live_connection: {
          read_host: "127.0.0.1",
          read_port: "59155",
          workbench_mission_id: "mission_selected_visual_fixture",
          mock: false,
          status: "mission_bound_live_read_requested",
        },
        ui_actions: ["operations", "chat", "session"].map((screen) => ({ screen, status: "pass", runtimeActionId: `desktop/${screen}/check` })),
      }, null, 2));
      const segmentB = writeDesktopCapture(root, "segment-b", ["pairingProvisioning", "providerAdmin", "parity"]);
      const segmentC = writeDesktopCapture(root, "segment-c", ["workflow", "evidence"]);
      const output = execFileSync("node", [
        script,
        `--repo-root=${root}`,
        `--design-root=${designRoot}`,
        `--evidence-dir=${evidence}`,
        `--evidence-dir=${segmentB}`,
        `--evidence-dir=${segmentC}`,
        "--require-complete",
      ], { cwd: process.cwd(), encoding: "utf8" });
      const report = JSON.parse(output) as {
        status?: string;
        blockers?: unknown[];
        evidence?: { desktopAggregates?: Array<{ status?: string; segmentCount?: number; missingDestinations?: string[] }> };
      };
      expect(report.status).toBe("selected_visual_proof_ready");
      expect(report.blockers).toEqual([]);
      expect(report.evidence?.desktopAggregates?.[0]).toMatchObject({
        status: "ready",
        segmentCount: 3,
        missingDestinations: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not aggregate desktop segments with an invalid proof truth label", () => {
    const { root, designRoot } = fixture();
    try {
      const evidence = writeReadyEvidence(root);
      writeFile(evidence, "desktop-ax-accessibility-capture.json", JSON.stringify({
        truth_label: "bad_truth",
        status: "partial_capture_ready",
        mode: "live-loopback",
        live_connection: {
          read_host: "127.0.0.1",
          read_port: "59155",
          workbench_mission_id: "mission_selected_visual_fixture",
          mock: false,
          status: "mission_bound_live_read_requested",
        },
        ui_actions: ["operations", "chat", "session", "pairingProvisioning", "providerAdmin", "parity", "workflow", "evidence"]
          .map((screen) => ({ screen, status: "pass", runtimeActionId: `desktop/${screen}/check` })),
      }, null, 2));
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
        evidence?: { desktop?: Array<{ eligibleForAggregate?: boolean }>; desktopAggregates?: unknown[] };
      };
      expect(report.status).toBe("selected_visual_proof_gaps_present");
      expect(report.evidence?.desktop?.[0]?.eligibleForAggregate).toBe(false);
      expect(report.evidence?.desktopAggregates).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not promote a desktop live mode declaration without live connection metadata", () => {
    const { root, designRoot } = fixture();
    try {
      const evidence = writeReadyEvidence(root);
      writeFile(evidence, "desktop-ax-accessibility-capture.json", JSON.stringify({
        truth_label: "ui_device_accessibility_click_capture_real_ui_not_endbar",
        status: "partial_capture_ready",
        repo: { head: fixtureHead(root) },
        mode: "live-loopback",
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
      const output = execFileSync("node", [
        script,
        `--repo-root=${root}`,
        `--design-root=${designRoot}`,
        `--evidence-dir=${evidence}`,
        "--require-complete",
      ], { cwd: process.cwd(), encoding: "utf8" });
      const report = JSON.parse(output) as {
        status?: string;
        evidence?: { desktop?: Array<{ mode?: string | null; declaredMode?: string | null; modeStatus?: string }> };
      };
      expect(report.status).toBe("selected_visual_proof_ready");
      expect(report.evidence?.desktop?.[0]?.declaredMode).toBe("live-loopback");
      expect(report.evidence?.desktop?.[0]?.mode).toBeNull();
      expect(report.evidence?.desktop?.[0]?.modeStatus).toBe("declared_mode_not_live_connected");
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
