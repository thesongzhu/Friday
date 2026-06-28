import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/friday-ui-device-proof-evidence-harvest.mjs";
const missionId = "mission_ui_device_harvest_cli";

function writeJson(path: string, value: unknown) {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeArtifacts(dir: string) {
  const mobile = join(dir, "mobile", "ios-live-write-read-proof.json");
  const desktop = join(dir, "desktop", "macos-live-write-read-proof.json");
  const channel = join(dir, "channel-capture.json");
  const timeline = join(dir, "timeline-capture.json");
  const events = join(dir, "same-run-events.jsonl");
  const backend = join(dir, "backend-live-proof.json");
  const objective = join(dir, "objective-coverage.json");
  const stale = join(dir, "old-timeline-db.json");
  writeJson(mobile, { missionId, truth: "ios_mobile_live_write_read_roundtrip_proof_not_ui_device_proof" });
  writeJson(desktop, { missionId, truth: "macos_live_write_read_roundtrip_proof_not_ui_device_proof" });
  writeJson(channel, { missionId, truth: "real_channel_capture_not_proof" });
  writeJson(timeline, { missionId, truth: "real_timeline_capture_not_proof" });
  writeFileSync(events, `${JSON.stringify({ surface: "mobile", event: "mission_intake_submitted", mission_id: missionId, evidence_ref: mobile })}\n`);
  writeJson(backend, {
    proof: "mission_spine_backend_api_live_pressure",
    status: "passed",
    remaining_requirement: "real UI/device consumption evidence still required",
  });
  writeJson(objective, {
    proof: "mission_spine_objective_backend_wire_coverage",
    remaining_requirement: "UI or device consumption must still pass",
    requirements: [{ required_gate: "scripts/mission-spine-ui-device-proof-gate.sh" }],
  });
  writeJson(stale, {
    missionId,
    truth: "real_db_read_only_partial_not_mission_spine_ui_device_proof",
  });
  writeJson(join(dir, "other-mission-channel.json"), {
    missionId: "mission_elsewhere",
    truth: "real_channel_capture_not_proof",
  });
  writeFileSync(join(dir, "Screenshot 2026-06-26.png"), "not proof\n");
  return { mobile, desktop, channel, timeline, events, backend, objective, stale };
}

describe("friday-ui-device-proof-evidence-harvest", () => {
  it("selects same-mission eligible artifacts and emits strict pipeline commands", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-harvest-"));
    try {
      const artifacts = writeArtifacts(tempDir);
      const out = join(tempDir, "harvest.json");
      const stdout = execFileSync("node", [
        script,
        `--mission-id=${missionId}`,
        `--search-dir=${tempDir}`,
        `--out=${out}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });
      const result = JSON.parse(stdout) as {
        status?: string;
        selected?: Record<string, string | string[]>;
        captureDirCommand?: string;
        proofRunnerCommand?: string;
        rejected?: Array<{ path?: string; rejectReasons?: string[] }>;
      };
      expect(result.status).toBe("ready_for_strict_pipeline");
      expect(result.selected?.mobile).toBe(artifacts.mobile);
      expect(result.selected?.desktop).toBe(artifacts.desktop);
      expect(result.selected?.channel).toBe(artifacts.channel);
      expect(result.selected?.timeline).toBe(artifacts.timeline);
      expect(result.selected?.backendLiveProof).toBe(artifacts.backend);
      expect(result.selected?.objectiveCoverage).toBe(artifacts.objective);
      expect(result.captureDirCommand).toContain("friday-ui-device-capture-dir.mjs");
      expect(result.captureDirCommand).toContain(`--events=${artifacts.events}`);
      expect(result.proofRunnerCommand).toContain("friday-ui-device-proof-shortlist-runner.sh");
      expect(result.rejected).toContainEqual(expect.objectContaining({
        path: artifacts.stale,
        rejectReasons: expect.arrayContaining(["timeline_partial_only"]),
      }));
      expect(JSON.parse(readFileSync(out, "utf8")).status).toBe("ready_for_strict_pipeline");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed when the artifact set cannot feed the strict pipeline", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-harvest-blocked-"));
    try {
      writeJson(join(tempDir, "desktop.json"), { missionId, truth: "desktop_only" });
      const result = spawnSync("node", [
        script,
        `--mission-id=${missionId}`,
        `--search-dir=${tempDir}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { status?: string; blockers?: Array<{ code?: string; detail?: string }> };
      expect(output.status).toBe("partial");
      expect(output.blockers).toContainEqual({ code: "missing_eligible_capture", detail: "mobile" });
      expect(output.blockers).toContainEqual({ code: "missing_eligible_capture", detail: "channel" });
      expect(output.blockers).toContainEqual({ code: "missing_manifest_or_events", detail: "need observations-manifest.json or same-run event jsonl" });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("can report non-channel inputs while channel proof is explicitly deferred", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-harvest-channel-deferred-"));
    try {
      const artifacts = writeArtifacts(tempDir);
      rmSync(artifacts.channel, { force: true });

      const reportOnly = spawnSync("node", [
        script,
        `--mission-id=${missionId}`,
        `--search-dir=${tempDir}`,
        "--defer-channel-proof",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(reportOnly.status).toBe(0);
      const output = JSON.parse(reportOnly.stdout) as {
        status?: string;
        selected?: { channel?: string };
        deferredInputs?: Array<{ role?: string; countsTowardUiDeviceProof?: boolean }>;
        blockers?: Array<{ code?: string; detail?: string }>;
        captureDirCommand?: string | null;
        proofRunnerCommand?: string;
      };
      expect(output.status).toBe("non_channel_inputs_ready_channel_deferred");
      expect(output.selected?.channel).toBe("");
      expect(output.deferredInputs).toContainEqual({
        role: "channel",
        status: "deferred_by_operator",
        countsTowardUiDeviceProof: false,
        caveat: "Channel live proof is intentionally deferred; this harvest can unblock non-channel evidence work but cannot satisfy strict UI/device proof or END-BAR.",
      });
      expect(output.blockers).toEqual([]);
      expect(output.captureDirCommand).toBeNull();
      expect(output.proofRunnerCommand).not.toContain("--channel-capture");

      const strict = spawnSync("node", [
        script,
        `--mission-id=${missionId}`,
        `--search-dir=${tempDir}`,
        "--defer-channel-proof",
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(strict.status).toBe(2);
      expect(JSON.parse(strict.stdout).status).toBe("non_channel_inputs_ready_channel_deferred");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not classify native linkage as objective coverage just because it lists requirements", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-harvest-native-linkage-"));
    try {
      const artifacts = writeArtifacts(tempDir);
      rmSync(artifacts.objective, { force: true });
      writeJson(join(tempDir, "uiux-native-linkage.json"), {
        truth: "uiux_native_linkage_not_screenshot_not_live_tap_not_endbar",
        status: "linked",
        requirements: [{ id: "native_route_present" }],
        remaining_requirement: "UI or device consumption must still pass",
      });

      const output = execFileSync("node", [
        script,
        `--mission-id=${missionId}`,
        `--search-dir=${tempDir}`,
      ], { cwd: process.cwd(), encoding: "utf8" });
      const result = JSON.parse(output) as {
        selected?: { objectiveCoverage?: string };
        rejected?: Array<{ path?: string }>;
      };
      expect(result.selected?.objectiveCoverage).toBe("");
      expect(result.rejected?.some((candidate) => candidate.path?.endsWith("uiux-native-linkage.json"))).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects artifacts and events that carry a mismatched current head", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-harvest-current-head-"));
    try {
      const artifacts = writeArtifacts(tempDir);
      writeJson(artifacts.mobile, {
        missionId,
        headSha: "old-head",
        truth: "ios_mobile_live_write_read_roundtrip_proof_not_ui_device_proof",
      });
      writeFileSync(artifacts.events, `${JSON.stringify({
        surface: "mobile",
        event: "mission_intake_submitted",
        mission_id: missionId,
        headSha: "old-head",
        evidence_ref: artifacts.mobile,
      })}\n`);

      const result = spawnSync("node", [
        script,
        `--mission-id=${missionId}`,
        `--search-dir=${tempDir}`,
        "--current-head=current-head",
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as {
        selected?: { mobile?: string; events?: string[] };
        rejected?: Array<{ path?: string; rejectReasons?: string[] }>;
        blockers?: Array<{ code?: string; detail?: string }>;
      };
      expect(output.selected?.mobile).toBe("");
      expect(output.selected?.events).toEqual([]);
      expect(output.rejected).toContainEqual(expect.objectContaining({
        path: artifacts.mobile,
        rejectReasons: expect.arrayContaining(["head_mismatch:old-head"]),
      }));
      expect(output.rejected).toContainEqual(expect.objectContaining({
        path: artifacts.events,
        rejectReasons: expect.arrayContaining(["events_head_mismatch:old-head"]),
      }));
      expect(output.blockers).toContainEqual({ code: "missing_eligible_capture", detail: "mobile" });
      expect(output.blockers).toContainEqual({ code: "missing_manifest_or_events", detail: "need observations-manifest.json or same-run event jsonl" });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
