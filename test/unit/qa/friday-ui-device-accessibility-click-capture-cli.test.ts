import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/friday-ui-device-accessibility-click-capture.mjs";
const missionId = "mission_ui_device_accessibility_click_capture";

function writeEvidence(root: string, name: string) {
  const path = join(root, name);
  writeFileSync(path, `real accessibility capture bytes for ${name}\n`);
  return path;
}

function capture(root: string, overrides: Record<string, unknown> = {}) {
  const mobileEvidence = writeEvidence(root, "mobile-accessibility.log");
  const desktopEvidence = writeEvidence(root, "desktop-accessibility.log");
  const mobile = join(root, "mobile-capture.json");
  const desktop = join(root, "desktop-capture.json");
  writeFileSync(mobile, JSON.stringify({
    truth_label: "ui_device_accessibility_click_capture_real_ui_not_endbar",
    mission_id: missionId,
    surface: "mobile",
    capture_method: "ios_simulator_accessibility",
    evidence_ref: mobileEvidence,
    ui_actions: [
      {
        screen: "fridayChat",
        runtimeActionId: "mobile/home/refresh",
        accessibility_id: "friday.chat.send",
        interaction: "tap",
        status: "pass",
        event: "mission_intake_submitted",
      },
      {
        screen: "fridayChat",
        runtimeActionId: "mobile/approval/check",
        capability_id: "security_approval_bound_principal_gate_cat10_netnew",
        accessibility_id: "friday.chat.approval-card",
        interaction: "visible",
        status: "pass",
        event: "proof_receipt_visible_before_done",
      },
    ],
    ...overrides,
  }, null, 2));
  writeFileSync(desktop, JSON.stringify({
    truth_label: "ui_device_accessibility_click_capture_real_ui_not_endbar",
    mission_id: missionId,
    surface: "desktop",
    capture_method: "macos_accessibility",
    evidence_ref: desktopEvidence,
    ui_actions: [
      {
        screen: "operations",
        runtimeActionId: "desktop/operations/refresh",
        accessibility_id: "friday.desktop.refresh",
        interaction: "tap",
        status: "pass",
        event: "mission_workbench_visible",
      },
    ],
  }, null, 2));
  return { mobile, desktop };
}

describe("friday-ui-device-accessibility-click-capture", () => {
  it("normalizes real accessibility captures into same-run events and action runtime evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-ui-accessibility-click-"));
    try {
      const outDir = join(root, "out");
      const captures = capture(root);
      const stdout = execFileSync("node", [
        script,
        `--mission-id=${missionId}`,
        `--out-dir=${outDir}`,
        `--capture=${captures.mobile}`,
        `--capture=${captures.desktop}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });
      const result = JSON.parse(stdout) as {
        truth?: string;
        status?: string;
        counts?: { eventRows?: number; actionRuntimeRows?: number };
        outputs?: { events?: string; actionRuntimeEvidence?: string; runtimeEvidencePaths?: string };
      };
      expect(result.truth).toBe("ui_device_accessibility_click_capture_normalized_not_proof_not_endbar");
      expect(result.status).toBe("ready");
      expect(result.counts?.eventRows).toBe(3);
      expect(result.counts?.actionRuntimeRows).toBe(3);

      const events = readFileSync(result.outputs?.events || "", "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(events).toContainEqual(expect.objectContaining({
        surface: "mobile",
        event: "mission_intake_submitted",
        mission_id: missionId,
        source: "ios_simulator_accessibility:friday.chat.send",
      }));
      expect(events).toContainEqual(expect.objectContaining({
        surface: "desktop",
        event: "mission_workbench_visible",
        source: "macos_accessibility:friday.desktop.refresh",
      }));

      const actionEvidence = JSON.parse(readFileSync(result.outputs?.actionRuntimeEvidence || "", "utf8")) as {
        truth?: string;
        actions?: Array<{ surface?: string; action_id?: string; evidence_ref?: string; truth_label?: string }>;
      };
      expect(actionEvidence.truth).toBe("accessibility_click_action_runtime_evidence_real_ui_not_endbar");
      expect(actionEvidence.actions?.map((row) => row.action_id)).toEqual([
        "mobile/home/refresh",
        "mobile/approval/check",
        "desktop/operations/refresh",
      ]);
      expect(actionEvidence.actions?.every((row) => row.truth_label === "accessibility_click_action_runtime_evidence_real_ui_not_endbar")).toBe(true);
      expect(readFileSync(result.outputs?.runtimeEvidencePaths || "", "utf8")).toContain(result.outputs?.actionRuntimeEvidence);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps legacy desktop diagnostics proof receipt labels to the strict provider receipt event", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-ui-accessibility-click-legacy-desktop-"));
    try {
      const evidence = writeEvidence(root, "desktop-diagnostics.log");
      const desktop = join(root, "desktop-capture.json");
      writeFileSync(desktop, JSON.stringify({
        truth_label: "ui_device_accessibility_click_capture_real_ui_not_endbar",
        mission_id: missionId,
        surface: "desktop",
        capture_method: "macos_accessibility",
        evidence_ref: evidence,
        ui_actions: [
          {
            screen: "diagnostics",
            runtimeActionId: "desktop/diagnostics/proof-refs",
            accessibility_id: "friday.desktop.evidence.timeline-pages",
            interaction: "read",
            status: "pass",
            event: "proof_receipt_visible_before_done",
          },
        ],
      }, null, 2));
      const outDir = join(root, "out");
      const stdout = execFileSync("node", [
        script,
        `--mission-id=${missionId}`,
        `--out-dir=${outDir}`,
        `--capture=${desktop}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });
      const result = JSON.parse(stdout) as { outputs?: { events?: string } };
      const events = readFileSync(result.outputs?.events || "", "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(events).toContainEqual(expect.objectContaining({
        surface: "desktop",
        event: "real_provider_execution_receipt_visible",
      }));
      expect(events).not.toContainEqual(expect.objectContaining({
        surface: "desktop",
        event: "proof_receipt_visible_before_done",
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on synthetic or screenshot-only truth labels without writing outputs", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-ui-accessibility-click-blocked-"));
    try {
      const outDir = join(root, "out");
      const captures = capture(root, {
        truth_label: "synthetic_screenshot_only_accessibility_sample",
      });
      const result = spawnSync("node", [
        script,
        `--mission-id=${missionId}`,
        `--out-dir=${outDir}`,
        `--capture=${captures.mobile}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { status?: string; blockers?: Array<{ code?: string }> };
      expect(output.status).toBe("blocked");
      expect(output.blockers?.map((blocker) => blocker.code)).toContain("truth_label_forbidden");
      expect(existsSync(join(outDir, "accessibility-click-events.jsonl"))).toBe(false);
      expect(existsSync(join(outDir, "action-runtime-evidence.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects cross-mission captures and unsupported proof events", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-ui-accessibility-click-mismatch-"));
    try {
      const outDir = join(root, "out");
      const captures = capture(root, {
        mission_id: "mission_other",
        ui_actions: [{
          screen: "fridayChat",
          runtimeActionId: "mobile/home/refresh",
          accessibility_id: "friday.chat.send",
          interaction: "tap",
          status: "pass",
          event: "unknown_visible_event",
        }],
      });
      const result = spawnSync("node", [
        script,
        `--mission-id=${missionId}`,
        `--out-dir=${outDir}`,
        `--capture=${captures.mobile}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { blockers?: Array<{ code?: string }> };
      expect(output.blockers?.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
        "mission_id_mismatch",
        "event_not_supported",
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects passed accessibility actions without a per-action proof event", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-ui-accessibility-click-missing-event-"));
    try {
      const outDir = join(root, "out");
      const captures = capture(root, {
        ui_actions: [
          {
            screen: "fridayChat",
            runtimeActionId: "mobile/home/refresh",
            accessibility_id: "friday.chat.send",
            interaction: "tap",
            status: "pass",
            event: "mission_intake_submitted",
          },
          {
            screen: "fridayChat",
            runtimeActionId: "mobile/memory/confirm",
            accessibility_id: "friday.chat.memory-card.keep",
            interaction: "tap",
            status: "pass",
          },
        ],
      });
      const result = spawnSync("node", [
        script,
        `--mission-id=${missionId}`,
        `--out-dir=${outDir}`,
        `--capture=${captures.mobile}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { blockers?: Array<{ code?: string }> };
      expect(output.blockers?.map((blocker) => blocker.code)).toContain("action_event_missing");
      expect(existsSync(join(outDir, "accessibility-click-events.jsonl"))).toBe(false);
      expect(existsSync(join(outDir, "action-runtime-evidence.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
