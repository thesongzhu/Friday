import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/check-friday-ui-real-use-mobile-desktop-report.mjs";

function writeJson(dir: string, name: string, value: unknown) {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function touch(dir: string, name: string) {
  const path = join(dir, name);
  writeFileSync(path, "{}\n");
  return path;
}

function eventsFile(dir: string, name: string, missionId: string, evidenceRef: string) {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify({
    surface: name.includes("mobile") ? "mobile" : "desktop",
    event: name.includes("mobile") ? "mission_intake_submitted" : "mission_workbench_visible",
    mission_id: missionId,
    evidence_ref: evidenceRef,
  })}\n`);
  return path;
}

function actionEvidence(dir: string, name: string, missionId: string, evidenceRef: string) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({
    truth: "accessibility_click_action_runtime_evidence_real_ui_not_endbar",
    status: "ready",
    missionId,
    actions: [
      {
        surface: name.includes("mobile") ? "mobile" : "desktop",
        action_id: `${name}/refresh`,
        status: "pass",
        evidence_ref: evidenceRef,
        mission_id: missionId,
      },
    ],
  }, null, 2));
  return path;
}

function summary(dir: string, overrides: Record<string, unknown> = {}) {
  const missionId = "mission_ui_real_use_cli";
  mkdirSync(join(dir, "mobile"), { recursive: true });
  mkdirSync(join(dir, "desktop"), { recursive: true });
  const mobileProof = touch(join(dir, "mobile"), "proof.json");
  const desktopProof = touch(join(dir, "desktop"), "proof.json");
  const mobileEvents = eventsFile(join(dir, "mobile"), "mobile-events.jsonl", missionId, mobileProof);
  const desktopEvents = eventsFile(join(dir, "desktop"), "desktop-events.jsonl", missionId, desktopProof);
  return {
    truth: "ui_device_shortlist_runner_summary_not_endbar_not_adoption",
    status: "partial_ready",
    missionId,
    captures: {
      mobile: {
        mission_id: missionId,
        proof: mobileProof,
        events: mobileEvents,
        action_runtime_evidence: actionEvidence(join(dir, "mobile"), "mobile-action.json", missionId, mobileProof),
        event_count: 5,
        action_count: 1,
      },
      desktop: {
        mission_id: missionId,
        proof: desktopProof,
        events: desktopEvents,
        action_runtime_evidence: actionEvidence(join(dir, "desktop"), "desktop-action.json", missionId, desktopProof),
        event_count: 5,
        action_count: 1,
      },
    },
    gapStatus: "written",
    accessibilityCaptureStatus: "ready",
    stressCaptureStatus: "ready",
    workbenchTimelineStatus: "snapshot_ready_events_ready",
    productClosureStatus: "uiux_product_closure_evidence_ready",
    readinessStatus: "pass",
    readinessBlockers: [],
    uiDeviceProofReadiness: {
      status: "pass",
      blockers: [],
    },
    ...overrides,
  };
}

function run(args: string[], expectFailure = false) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (!expectFailure) throw error;
    const stdout = (error as { stdout?: Buffer | string }).stdout?.toString() || "";
    return JSON.parse(stdout);
  }
}

describe("Friday UI real-use mobile/desktop report", () => {
  it("passes only when strict UI/device readiness is present with mobile and desktop captures", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-ui-real-use-"));
    const summaryPath = writeJson(dir, "summary.json", summary(dir));

    const report = run([`--ui-device-summary=${summaryPath}`, "--require-ready"]);

    expect(report.truth).toBe("ui_real_use_mobile_desktop_report");
    expect(report.status).toBe("strict_uiux_real_use_ready");
    expect(report.passBar.mobile_and_desktop_real_app_surfaces).toBe(true);
    expect(report.blockers).toEqual([]);
  });

  it("marks channel-deferred summaries as deferred, not strict-ready", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-ui-real-use-"));
    const summaryPath = writeJson(dir, "summary.json", summary(dir, {
      readinessStatus: "blocked",
      readinessBlockers: ["ui_device_proof_evidence:channel_deferred_strict_assembly_blocked"],
      uiDeviceProofReadiness: {
        status: "blocked",
        blockers: ["ui_device_proof_evidence:channel_deferred_strict_assembly_blocked"],
      },
    }));

    const report = run([`--ui-device-summary=${summaryPath}`, "--require-ready"], true);

    expect(report.status).toBe("deferred");
    expect(report.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "strict_ui_device_readiness_passed" }),
      expect.objectContaining({ code: "no_deferred_channel_or_external_input" }),
    ]));
  });

  it("blocks runtime-capture-only product closure status", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-ui-real-use-"));
    const summaryPath = writeJson(dir, "summary.json", summary(dir, {
      productClosureStatus: "ready_for_runtime_capture",
    }));

    const report = run([`--ui-device-summary=${summaryPath}`, "--require-ready"], true);

    expect(report.status).toBe("blocked");
    expect(report.blockers).toContainEqual(expect.objectContaining({
      code: "product_closure_evidence_ready",
      detail: "ready_for_runtime_capture",
    }));
  });

  it("blocks missing same-mission desktop evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-ui-real-use-"));
    const value = summary(dir);
    value.captures.desktop.mission_id = "mission_other";
    value.captures.desktop.events = join(dir, "desktop", "missing.jsonl");
    const summaryPath = writeJson(dir, "summary.json", value);

    const report = run([`--ui-device-summary=${summaryPath}`]);

    expect(report.status).toBe("blocked");
    expect(report.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "desktop_real_surface_capture" }),
    ]));
  });

  it("blocks capture summaries whose action-runtime evidence file is not ready for the same mission", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-ui-real-use-action-evidence-"));
    const value = summary(dir);
    writeFileSync(value.captures.mobile.action_runtime_evidence, JSON.stringify({
      truth: "accessibility_click_action_runtime_evidence_real_ui_not_endbar",
      status: "blocked",
      missionId: "mission_other",
      actions: [],
    }, null, 2));
    const summaryPath = writeJson(dir, "summary.json", value);

    const report = run([`--ui-device-summary=${summaryPath}`, "--require-ready"], true);

    expect(report.status).toBe("blocked");
    expect(report.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "mobile_real_surface_capture",
        detail: expect.stringContaining("action_runtime_evidence_not_ready"),
      }),
    ]));
  });

  it("blocks capture summaries whose event file does not contain same-mission UI events", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-ui-real-use-event-evidence-"));
    const value = summary(dir);
    writeFileSync(value.captures.mobile.events, `${JSON.stringify({
      surface: "mobile",
      mission_id: "mission_other",
      evidence_ref: value.captures.mobile.proof,
    })}\n`);
    const summaryPath = writeJson(dir, "summary.json", value);

    const report = run([`--ui-device-summary=${summaryPath}`, "--require-ready"], true);

    expect(report.status).toBe("blocked");
    expect(report.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "mobile_real_surface_capture",
        detail: expect.stringContaining("event_rows_missing"),
      }),
    ]));
  });
});
