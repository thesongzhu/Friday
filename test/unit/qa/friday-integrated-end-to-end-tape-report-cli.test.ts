import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/check-friday-integrated-end-to-end-tape-report.mjs";

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

function summary(dir: string, overrides: Record<string, unknown> = {}) {
  const missionId = "mission_integrated_tape_cli";
  mkdirSync(join(dir, "mobile"), { recursive: true });
  mkdirSync(join(dir, "desktop"), { recursive: true });
  return {
    truth: "ui_device_shortlist_runner_summary_not_endbar_not_adoption",
    status: "partial_ready",
    missionId,
    captures: {
      mobile: {
        mission_id: missionId,
        proof: touch(join(dir, "mobile"), "proof.json"),
        events: touch(join(dir, "mobile"), "events.jsonl"),
        action_runtime_evidence: touch(join(dir, "mobile"), "action.json"),
        event_count: 5,
        action_count: 1,
      },
      desktop: {
        mission_id: missionId,
        proof: touch(join(dir, "desktop"), "proof.json"),
        events: touch(join(dir, "desktop"), "events.jsonl"),
        action_runtime_evidence: touch(join(dir, "desktop"), "action.json"),
        event_count: 5,
        action_count: 1,
      },
    },
    workbenchTimelineStatus: "snapshot_ready_events_ready",
    stressCaptureStatus: "ready",
    accessibilityCaptureStatus: "ready",
    productClosureStatus: "ready_for_runtime_capture",
    readinessStatus: "pass",
    readinessBlockers: [],
    fullProofGaps: [],
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

describe("Friday integrated end-to-end tape report", () => {
  it("passes only when same-mission mobile and desktop strict readiness has no deferred channel or gaps", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-integrated-tape-"));
    const summaryPath = writeJson(dir, "summary.json", summary(dir));

    const report = run([`--ui-device-summary=${summaryPath}`, "--require-ready"]);

    expect(report.truth).toBe("integrated_end_to_end_tape_report");
    expect(report.status).toBe("integrated_end_to_end_tape_ready");
    expect(report.passBar.mobile_and_desktop_same_mission_truth).toBe(true);
    expect(report.passBar.channel_current_and_linked).toBe(true);
    expect(report.blockers).toEqual([]);
  });

  it("blocks channel-deferred summaries instead of counting non-channel UI proof as END-BAR", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-integrated-tape-"));
    const summaryPath = writeJson(dir, "summary.json", summary(dir, {
      readinessStatus: "blocked",
      readinessBlockers: ["ui_device_proof_evidence:channel_deferred_strict_assembly_blocked"],
      fullProofGaps: ["same_mission_mobile_desktop_channel_capture"],
      uiDeviceProofReadiness: {
        status: "blocked",
        blockers: ["ui_device_proof_evidence:channel_deferred_strict_assembly_blocked"],
      },
    }));

    const report = run([`--ui-device-summary=${summaryPath}`, "--require-ready"], true);

    expect(report.status).toBe("blocked");
    expect(report.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "no_channel_deferred_signal" }),
      expect.objectContaining({ code: "strict_ui_device_readiness_passed" }),
      expect.objectContaining({ code: "no_full_proof_gaps" }),
    ]));
  });

  it("blocks cross-mission or missing desktop evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-integrated-tape-"));
    const value = summary(dir);
    value.captures.desktop.mission_id = "mission_other";
    value.captures.desktop.proof = join(dir, "desktop", "missing.json");
    const summaryPath = writeJson(dir, "summary.json", value);

    const report = run([`--ui-device-summary=${summaryPath}`]);

    expect(report.status).toBe("blocked");
    expect(report.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "desktop_capture_same_mission" }),
    ]));
  });
});
