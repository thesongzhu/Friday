import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const missionId = "mission_cli_ui_device_readiness";

function writeEvidenceDir(tempDir: string) {
  const files = {
    mobile: join(tempDir, "mobile.json"),
    desktop: join(tempDir, "desktop.json"),
    channel: join(tempDir, "channel.json"),
    timeline: join(tempDir, "timeline.json"),
    manifest: join(tempDir, "observations-manifest.json"),
    out: join(tempDir, "assembled-proof.json"),
  };

  writeFileSync(join(tempDir, "mission-id.txt"), `${missionId}\n`);
  for (const [role, filePath] of Object.entries({
    mobile: files.mobile,
    desktop: files.desktop,
    channel: files.channel,
    timeline: files.timeline,
  })) {
    writeFileSync(filePath, JSON.stringify({ role, mission_id: missionId, capture: "redacted live-capture-shaped qa input" }));
  }
  writeFileSync(files.manifest, JSON.stringify(makeManifest(files), null, 2));
  return files;
}

function observation(surface: string, event: string, evidenceRef: string) {
  return { surface, event, mission_id: missionId, evidence_ref: evidenceRef };
}

function makeManifest(files: ReturnType<typeof writeEvidenceDir>) {
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
    stress: {
      mission_bound_ask_count: 20,
      consecutive: true,
      duplicate_surface_count: 2,
      provider_ack_not_done: true,
      invalid_key_error_visible: true,
      quota_error_visible: true,
      network_error_visible: true,
      long_timeline_pagination_visible: true,
      long_timeline_page_count: 2,
      reconnect_stale_verified: true,
      channel_replay_blocked: true,
      no_secret_leak: true,
      no_hidden_fallback: true,
      evidence_ref: files.timeline,
    },
    timeline: {
      bounded: true,
      page_count: 2,
      cursor_verified: true,
    },
    mission_workbench: {
      visible: true,
      same_mission_projection_visible: true,
      provider_ack_not_done_visible: true,
      memory_candidate_review_only_visible: true,
      evidence_ref: files.desktop,
    },
    transcript_browser: {
      visible: true,
      collapsed_by_default: true,
      redacted: true,
      bounded_timeline_linked: true,
      evidence_ref: files.desktop,
      search_facets: ["mission", "work_item", "surface", "provider", "skill", "channel", "status", "proof_receipt", "time"],
      evidence_facets: ["providerRef", "skillRunRef", "channelRef", "workflowRef", "surfaceThreadRef", "timelineRef", "proofReceiptRef"],
    },
    status_labels: ["stale", "offline", "error"],
    memory_candidates: [
      { id: "memory_candidate_review_only", confirmed: false, grants_memory_authority: false },
    ],
    event_order: [
      "mission_intake_submitted",
      "mission_resolve_or_create",
      "duplicate_preflight",
      "mission_bound_provider_action",
      "real_provider_execution",
      "proof_receipt",
      "timeline_page_1",
      "timeline_page_2",
      "same_mission_mobile_desktop_channel",
      "memory_candidate_review_only",
      "stale_offline_error_labels_verified",
    ],
    observations: [
      observation("mobile", "mission_intake_submitted", files.mobile),
      observation("mobile", "mission_intake_ready", files.mobile),
      observation("desktop", "mission_resolve_or_create_visible", files.desktop),
      observation("desktop", "duplicate_preflight_visible", files.desktop),
      observation("mobile", "mission_bound_provider_action_visible", files.mobile),
      observation("desktop", "real_provider_execution_visible", files.desktop),
      observation("mobile", "proof_receipt_visible_before_done", files.mobile),
      observation("desktop", "same_mission_projection_visible", files.desktop),
      observation("desktop", "mission_workbench_visible", files.desktop),
      observation("desktop", "transcript_browser_visible", files.desktop),
      observation("desktop", "duplicate_blocked_opens_existing", files.desktop),
      observation("channel", "same_mission_projection_visible", files.channel),
      observation("channel", "same_mission_mobile_desktop_channel_visible", files.channel),
      observation("timeline", "bounded_page_1_visible", files.timeline),
      observation("timeline", "bounded_page_2_visible", files.timeline),
      observation("timeline", "memory_candidate_review_only", files.timeline),
      observation("desktop", "provider_ack_not_done_visible", files.desktop),
      observation("desktop", "pressure_20_50_consecutive_asks_visible", files.desktop),
      observation("desktop", "invalid_key_error_visible", files.desktop),
      observation("desktop", "quota_error_visible", files.desktop),
      observation("desktop", "network_error_visible", files.desktop),
      observation("channel", "channel_replay_blocked_visible", files.channel),
      observation("desktop", "reconnect_stale_verified", files.desktop),
      observation("desktop", "real_provider_execution_receipt_visible", files.desktop),
      observation("desktop", "stale_label_visible", files.desktop),
      observation("desktop", "offline_label_visible", files.desktop),
      observation("desktop", "error_label_visible", files.desktop),
      observation("desktop", "no_hidden_fallback_verified", files.desktop),
    ],
  };
}

describe("friday-ui-device-proof-readiness", () => {
  it("does not require final proof mode to be not-ready", () => {
    const source = readFileSync("scripts/ops/friday-ui-device-proof-readiness.sh", "utf8");
    expect(source).toContain("EXPECT_NOT_READY_ARGS=(--expect-not-ready)");
    expect(source).toContain('if [ "${MODE}" = "require-proof" ]; then');
    expect(source).toContain("EXPECT_NOT_READY_ARGS=()");
    expect(source).toContain('check-mission-workbench-live-readiness.mjs" "${EXPECT_NOT_READY_ARGS[@]}"');
    expect(source).toContain('check-mission-workbench-snapshot-contract.mjs"');
    expect(source).not.toContain("check-mission-workbench-live-readiness.mjs\" --expect-not-ready");
  });

  it("discovers a complete evidence dir and delegates to the strict assembler", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-device-readiness-"));
    try {
      const files = writeEvidenceDir(tempDir);
      const stdout = execFileSync("bash", [
        "scripts/ops/friday-ui-device-proof-readiness.sh",
        "--evidence-dir",
        tempDir,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, OUT: files.out },
        encoding: "utf8",
      });

      expect(stdout).toContain('"truth":"assembled_real_ui_device_proof"');
      const proof = JSON.parse(readFileSync(files.out, "utf8")) as {
        proof?: string;
        mission_id?: string;
        surfaces?: { mobile?: { evidence_ref?: string } };
      };
      expect(proof.proof).toBe("mission_spine_ui_device_consumption");
      expect(proof.mission_id).toBe(missionId);
      expect(proof.surfaces?.mobile?.evidence_ref).toBe(files.mobile);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports blocked instead of assembling when the evidence dir is incomplete", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-device-readiness-missing-"));
    try {
      writeFileSync(join(tempDir, "mission-id.txt"), `${missionId}\n`);
      writeFileSync(join(tempDir, "mobile.json"), JSON.stringify({ role: "mobile", mission_id: missionId }));

      const stdout = execFileSync("bash", [
        "scripts/ops/friday-ui-device-proof-readiness.sh",
        "--evidence-dir",
        tempDir,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const result = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
        truth?: string;
        status?: string;
        blockers?: string[];
      };

      expect(result.truth).toBe("report_only_not_ui_device_proof");
      expect(result.status).toBe("blocked");
      expect(result.blockers).toContain("ui_device_proof_evidence:missing_required_real_evidence_env");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
