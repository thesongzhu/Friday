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
});
