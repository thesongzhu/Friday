import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/friday-ui-device-proof-gap-report.mjs";
const missionId = "mission_cli_ui_device_gap_report";

function evidenceFiles(tempDir: string) {
  const files = {
    mobile: join(tempDir, "mobile.json"),
    desktop: join(tempDir, "desktop.json"),
    channel: join(tempDir, "channel.json"),
    timeline: join(tempDir, "timeline.json"),
  };
  for (const [role, path] of Object.entries(files)) {
    writeFileSync(path, `real same-run ${role} capture for ${missionId}\n`);
  }
  return files;
}

function event(surface: string, name: string, evidenceRef: string, mission = missionId) {
  return { surface, event: name, mission_id: mission, evidence_ref: evidenceRef };
}

function writeJsonl(path: string, rows: unknown[]) {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function partialRows(files: ReturnType<typeof evidenceFiles>) {
  return [
    event("mobile", "mission_intake_submitted", files.mobile),
    event("mobile", "mission_intake_ready", files.mobile),
    event("mobile", "mission_bound_provider_action_visible", files.mobile),
    event("mobile", "proof_receipt_visible_before_done", files.mobile),
    event("desktop", "same_mission_projection_visible", files.desktop),
  ];
}

function completeRows(files: ReturnType<typeof evidenceFiles>) {
  const rows = [
    event("mobile", "mission_intake_submitted", files.mobile),
    event("mobile", "mission_intake_ready", files.mobile),
    event("desktop", "mission_resolve_or_create_visible", files.desktop),
    event("desktop", "duplicate_preflight_visible", files.desktop),
    event("mobile", "duplicate_preflight_visible", files.mobile),
    event("mobile", "mission_bound_provider_action_visible", files.mobile),
    event("desktop", "real_provider_execution_visible", files.desktop),
    event("mobile", "proof_receipt_visible_before_done", files.mobile),
    event("desktop", "same_mission_projection_visible", files.desktop),
    event("desktop", "mission_workbench_visible", files.desktop),
    event("desktop", "transcript_browser_visible", files.desktop),
    event("desktop", "duplicate_blocked_opens_existing", files.desktop),
    event("channel", "same_mission_projection_visible", files.channel),
    event("channel", "same_mission_mobile_desktop_channel_visible", files.channel),
    event("timeline", "bounded_page_1_visible", files.timeline),
    event("timeline", "bounded_page_2_visible", files.timeline),
    event("timeline", "memory_candidate_review_only", files.timeline),
    event("desktop", "provider_ack_not_done_visible", files.desktop),
    event("desktop", "invalid_key_error_visible", files.desktop),
    event("desktop", "quota_error_visible", files.desktop),
    event("desktop", "network_error_visible", files.desktop),
    event("channel", "channel_replay_blocked_visible", files.channel),
    event("desktop", "reconnect_stale_verified", files.desktop),
    event("desktop", "real_provider_execution_receipt_visible", files.desktop),
    event("desktop", "stale_label_visible", files.desktop),
    event("desktop", "offline_label_visible", files.desktop),
    event("desktop", "error_label_visible", files.desktop),
    event("desktop", "no_hidden_fallback_verified", files.desktop),
  ];
  for (let index = 0; index < 20; index += 1) {
    rows.push(event("desktop", "pressure_20_50_consecutive_asks_visible", files.desktop));
  }
  return rows;
}

function completeManifest() {
  return {
    checks: Object.fromEntries([
      "same_mission_id_mobile_desktop",
      "same_mission_id_channel",
      "duplicate_blocked_opens_existing",
      "mission_bound_provider_action_visible",
      "proof_receipt_visible_before_done",
      "provider_ack_not_done",
      "pressure_20_50_consecutive_asks",
      "invalid_key_error_visible",
      "quota_error_visible",
      "network_error_visible",
      "channel_replay_blocked",
      "reconnect_stale_verified",
      "memory_candidate_not_confirmed",
      "no_secret_leak",
      "no_hidden_fallback",
    ].map((check) => [check, true])),
  };
}

function writeSupportingProofs(tempDir: string) {
  const backend = join(tempDir, "backend-live-proof.json");
  const channel = join(tempDir, "channel-live-proof.json");
  writeFileSync(backend, JSON.stringify({
    proof: "mission_spine_backend_api_live_pressure",
    status: "passed",
    remaining_requirement: "real mobile/desktop/channel UI/device consumption evidence must still pass scripts/mission-spine-ui-device-proof-gate.sh",
  }, null, 2));
  writeFileSync(channel, JSON.stringify({
    proof: "mission_spine_channel_live_proof",
    status: "passed",
    remaining_requirement: "real mobile/desktop/channel UI/device consumption evidence must still pass scripts/mission-spine-ui-device-proof-gate.sh",
  }, null, 2));
  return { backend, channel };
}

function run(tempDir: string, files: ReturnType<typeof evidenceFiles>, rows: unknown[], extraArgs: string[] = []) {
  const events = join(tempDir, "events.jsonl");
  writeJsonl(events, rows);
  return spawnSync("node", [
    script,
    `--mission-id=${missionId}`,
    `--events=${events}`,
    `--mobile=${files.mobile}`,
    `--desktop=${files.desktop}`,
    `--channel=${files.channel}`,
    `--timeline=${files.timeline}`,
    ...extraArgs,
  ], { cwd: process.cwd(), encoding: "utf8" });
}

describe("friday-ui-device-proof-gap-report", () => {
  it("reports missing channel/timeline observations without synthesizing a proof", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-gap-report-partial-"));
    try {
      const files = evidenceFiles(tempDir);
      const result = run(tempDir, files, partialRows(files));
      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as {
        truth?: string;
        status?: string;
        gaps?: { missingObservations?: Array<{ surface?: string; event?: string; preferredCapture?: string }> };
        capturePlan?: Array<{
          surface?: string;
          missingEvents?: string[];
          stressRequirements?: string[];
          truth?: string;
        }>;
      };
      expect(output.truth).toBe("ui_device_proof_gap_report_not_proof");
      expect(output.status).toBe("gaps_present");
      expect(output.gaps?.missingObservations).toContainEqual({
        surface: "channel",
        event: "same_mission_projection_visible",
        preferredCapture: "channel",
      });
      expect(output.gaps?.missingObservations).toContainEqual({
        surface: "timeline",
        event: "bounded_page_1_visible",
        preferredCapture: "timeline",
      });
      expect(output.capturePlan).toContainEqual(expect.objectContaining({
        surface: "channel",
        missingEvents: expect.arrayContaining([
          "same_mission_mobile_desktop_channel_visible",
          "same_mission_projection_visible",
        ]),
        truth: "capture_real_same_run_events_only_no_synthetic_rows",
      }));
      expect(output.capturePlan).toContainEqual(expect.objectContaining({
        surface: "desktop",
        stressRequirements: expect.arrayContaining([
          "duplicate_preflight_visible_on_at_least_two_surfaces",
          "pressure_20_50_consecutive_asks_visible",
        ]),
      }));
      expect(output.capturePlan).toContainEqual(expect.objectContaining({
        surface: "timeline",
        stressRequirements: expect.arrayContaining([
          "bounded_page_1_visible_and_bounded_page_2_visible",
        ]),
      }));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps backend and channel supporting proofs separate from UI device evidence", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-gap-report-supporting-"));
    try {
      const files = evidenceFiles(tempDir);
      const proofs = writeSupportingProofs(tempDir);
      const result = run(tempDir, files, partialRows(files), [
        `--backend-live-proof=${proofs.backend}`,
        `--channel-live-proof=${proofs.channel}`,
      ]);
      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as {
        status?: string;
        supportingProofs?: Array<{
          role?: string;
          status?: string;
          countsTowardUiDeviceProof?: boolean;
          failures?: string[];
        }>;
        gaps?: { missingObservations?: unknown[] };
      };
      expect(output.status).toBe("gaps_present");
      expect(output.gaps?.missingObservations?.length).toBeGreaterThan(0);
      expect(output.supportingProofs).toContainEqual(expect.objectContaining({
        role: "backendLiveProof",
        status: "usable_precondition_not_ui_device_evidence",
        countsTowardUiDeviceProof: false,
        failures: [],
      }));
      expect(output.supportingProofs).toContainEqual(expect.objectContaining({
        role: "channelLiveProof",
        status: "usable_precondition_not_ui_device_evidence",
        countsTowardUiDeviceProof: false,
        failures: [],
      }));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("can require complete inputs and fails closed while gaps remain", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-gap-report-require-"));
    try {
      const files = evidenceFiles(tempDir);
      const result = run(tempDir, files, partialRows(files), ["--require-complete"]);
      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { status?: string };
      expect(output.status).toBe("gaps_present");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("marks complete only when required observations and manifest checks are present", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-gap-report-complete-"));
    try {
      const files = evidenceFiles(tempDir);
      const manifest = join(tempDir, "manifest.json");
      const out = join(tempDir, "gap-report.json");
      writeFileSync(manifest, JSON.stringify(completeManifest(), null, 2));
      const result = run(tempDir, files, completeRows(files), [
        `--manifest=${manifest}`,
        `--out=${out}`,
        "--require-complete",
      ]);
      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as {
        status?: string;
        gaps?: { missingObservations?: unknown[] };
        capturePlan?: unknown[];
      };
      expect(output.status).toBe("complete_inputs_observed");
      expect(output.gaps?.missingObservations).toEqual([]);
      expect(output.capturePlan).toEqual([]);
      const written = JSON.parse(readFileSync(out, "utf8")) as { status?: string };
      expect(written.status).toBe("complete_inputs_observed");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("blocks unknown evidence references and mission mismatches", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-gap-report-invalid-"));
    try {
      const files = evidenceFiles(tempDir);
      const rows = completeRows(files);
      rows.push(event("desktop", "real_provider_execution_visible", join(tempDir, "outside.json")));
      rows.push(event("desktop", "quota_error_visible", files.desktop, "mission_other"));
      const result = run(tempDir, files, rows, ["--require-complete"]);
      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { blockers?: Array<{ code?: string }> };
      const codes = output.blockers?.map((blocker) => blocker.code);
      expect(codes).toContain("event_evidence_ref_unknown");
      expect(codes).toContain("event_mission_mismatch");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
