import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/friday-ui-device-live-write-read-bundle.mjs";

function writeCapture(root: string, role: "mobile" | "desktop", missionId: string) {
  const dir = join(root, role);
  mkdirSync(dir, { recursive: true });
  const proof = join(dir, `${role}-proof.json`);
  const events = join(dir, `${role}-events.jsonl`);
  const actionRuntimeEvidence = join(dir, "action-runtime-evidence.json");
  const workItemId = `work-${role}-${missionId}`;
  writeFileSync(proof, JSON.stringify({
    truth_label: `${role}_live_write_read_roundtrip_proof_not_ui_device_proof`,
    status: "pass",
    mission_id: missionId,
    work_item_id: workItemId,
    surface_kind: role,
  }, null, 2));
  const rows = [
    "mission_intake_submitted",
    "mission_intake_ready",
    "mission_bound_provider_action_visible",
    "proof_receipt_visible_before_done",
    "same_mission_projection_visible",
  ].map((event) => ({
    surface: role,
    event,
    mission_id: missionId,
    evidence_ref: proof,
    work_item_id: workItemId,
  }));
  writeFileSync(events, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  writeFileSync(actionRuntimeEvidence, JSON.stringify({
    truth: `action_runtime_evidence_from_explicit_${role}_ui_actions_not_endbar`,
    status: "ready",
    missionId,
    actions: [{
      surface: role,
      screen: role === "mobile" ? "fridayChat" : "desktopChat",
      action_id: "chat:typing",
      capability_id: "ask_friday_chat",
      status: "pass",
      evidence_ref: `proof://${role}/chat-send`,
      mission_id: missionId,
      work_item_id: workItemId,
    }],
  }, null, 2));
  writeFileSync(join(dir, "capture-index.json"), JSON.stringify({
    truth_label: `${role}_live_write_read_capture_index_not_ui_device_proof`,
    status: "ready",
    mission_id: missionId,
    work_item_id: workItemId,
    [role]: {
      proof,
      events,
      action_runtime_evidence: actionRuntimeEvidence,
      event_count: rows.length,
    },
    blockers: [],
  }, null, 2));
  return dir;
}

describe("friday-ui-device-live-write-read-bundle", () => {
  it("indexes same-mission mobile and desktop live captures without claiming full proof", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-live-bundle-"));
    try {
      const missionId = "mission-live-write-read-bundle";
      const mobileDir = writeCapture(tempDir, "mobile", missionId);
      const desktopDir = writeCapture(tempDir, "desktop", missionId);
      const outDir = join(tempDir, "bundle");

      const stdout = execFileSync("node", [
        script,
        `--out-dir=${outDir}`,
        `--mobile-capture-dir=${mobileDir}`,
        `--desktop-capture-dir=${desktopDir}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });

      const result = JSON.parse(stdout) as {
        truth?: string;
        status?: string;
        missionId?: string;
        combinedEvents?: string;
        actionRuntimeEvidence?: string;
        actionRuntimeEvidenceCount?: number;
        fullProofGaps?: string[];
      };
      expect(result.truth).toBe("ui_device_live_write_read_bundle_not_full_proof");
      expect(result.status).toBe("partial_bundle_ready");
      expect(result.missionId).toBe(missionId);
      expect(result.fullProofGaps).toContain("bounded_timeline_capture");

      const combinedEvents = readFileSync(result.combinedEvents ?? "", "utf8").trim().split("\n");
      expect(combinedEvents).toHaveLength(10);
      expect(result.actionRuntimeEvidenceCount).toBe(2);
      const actionEvidence = JSON.parse(readFileSync(result.actionRuntimeEvidence ?? "", "utf8")) as {
        status?: string;
        actions?: unknown[];
      };
      expect(actionEvidence.status).toBe("ready");
      expect(actionEvidence.actions).toHaveLength(2);

      const index = JSON.parse(readFileSync(join(outDir, "live-write-read-bundle-index.json"), "utf8")) as {
        status?: string;
        actionRuntimeEvidenceCount?: number;
        fullProofGaps?: string[];
      };
      expect(index.status).toBe("partial_bundle_ready");
      expect(index.actionRuntimeEvidenceCount).toBe(2);
      expect(index.fullProofGaps).toContain("strict_observations_manifest_from_same_run_events");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("canonicalizes raw shared mission ids the same way as the live capture clients", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-live-bundle-canonical-"));
    try {
      const rawSharedId = "mission-live-write-read-canonical";
      const canonicalMissionId = `mission_${rawSharedId}`;
      const mobileDir = writeCapture(tempDir, "mobile", canonicalMissionId);
      const desktopDir = writeCapture(tempDir, "desktop", canonicalMissionId);
      const outDir = join(tempDir, "bundle");

      const stdout = execFileSync("node", [
        script,
        `--out-dir=${outDir}`,
        `--mobile-capture-dir=${mobileDir}`,
        `--desktop-capture-dir=${desktopDir}`,
        `--mission-id=${rawSharedId}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });

      const result = JSON.parse(stdout) as { status?: string; missionId?: string; blockers?: unknown[] };
      expect(result.status).toBe("partial_bundle_ready");
      expect(result.missionId).toBe(canonicalMissionId);
      expect(result.blockers).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed when mobile and desktop captures are not the same mission", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-live-bundle-mismatch-"));
    try {
      const mobileDir = writeCapture(tempDir, "mobile", "mission-live-bundle-mobile");
      const desktopDir = writeCapture(tempDir, "desktop", "mission-live-bundle-desktop");
      const result = spawnSync("node", [
        script,
        `--out-dir=${join(tempDir, "bundle")}`,
        `--mobile-capture-dir=${mobileDir}`,
        `--desktop-capture-dir=${desktopDir}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });

      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { status?: string; blockers?: Array<{ code?: string }> };
      expect(output.status).toBe("blocked");
      expect(output.blockers?.map((blocker) => blocker.code)).toContain("mobile_desktop_mission_mismatch");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("requires both live capture dirs and an absolute output dir", () => {
    const result = spawnSync("node", [
      script,
      "--out-dir=relative",
      "--require-ready",
    ], { cwd: process.cwd(), encoding: "utf8" });

    expect(result.status).toBe(2);
    const output = JSON.parse(result.stdout) as { blockers?: Array<{ code?: string }> };
    expect(output.blockers?.map((blocker) => blocker.code)).toContain("out_dir_not_absolute");
    expect(output.blockers?.map((blocker) => blocker.code)).toContain("missing_arg");
  });
});
