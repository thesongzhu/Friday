import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const missionId = "mission_cli_ui_device_assemble";

function writeEvidenceFiles(tempDir: string) {
  const files = {
    mobile: join(tempDir, "mobile.trace"),
    desktop: join(tempDir, "desktop.trace"),
    channel: join(tempDir, "channel.trace"),
    timeline: join(tempDir, "timeline.trace"),
  };
  for (const [role, filePath] of Object.entries(files)) {
    writeFileSync(filePath, `real device proof test evidence ${role} ${missionId}\n`);
  }
  return files;
}

function observation(surface: string, event: string, evidenceRef: string) {
  return { surface, event, mission_id: missionId, evidence_ref: evidenceRef };
}

function makeManifest(files: ReturnType<typeof writeEvidenceFiles>) {
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

function runAssembler(files: ReturnType<typeof writeEvidenceFiles>, manifestPath: string, outPath: string) {
  execFileSync("bash", ["rust-core/scripts/mission-spine-ui-device-proof-assemble.sh"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MISSION_ID: missionId,
      MOBILE_EVIDENCE: files.mobile,
      DESKTOP_EVIDENCE: files.desktop,
      CHANNEL_EVIDENCE: files.channel,
      TIMELINE_EVIDENCE: files.timeline,
      OBSERVATIONS_MANIFEST: manifestPath,
      OUT: outPath,
      CAPTURED_AT_UTC: "2026-06-23T13:30:00Z",
      CAPTURE_RUN_ID: "ui-device-assemble-cli-test",
    },
    encoding: "utf8",
  });
}

describe("mission-spine-ui-device-proof-assemble", () => {
  it("carries workbench and transcript browser evidence into the final proof", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-device-assemble-"));
    try {
      const files = writeEvidenceFiles(tempDir);
      const manifestPath = join(tempDir, "observations-manifest.json");
      const outPath = join(tempDir, "proof.json");
      writeFileSync(manifestPath, JSON.stringify(makeManifest(files), null, 2));

      runAssembler(files, manifestPath, outPath);

      const proof = JSON.parse(readFileSync(outPath, "utf8")) as {
        mission_workbench?: { evidence_ref?: string };
        transcript_browser?: { evidence_ref?: string; redacted?: boolean; search_facets?: string[] };
      };
      expect(proof.mission_workbench?.evidence_ref).toBe(files.desktop);
      expect(proof.transcript_browser?.evidence_ref).toBe(files.desktop);
      expect(proof.transcript_browser?.redacted).toBe(true);
      expect(proof.transcript_browser?.search_facets).toContain("proof_receipt");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed when the observations manifest omits desktop workbench proof", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-device-assemble-missing-"));
    try {
      const files = writeEvidenceFiles(tempDir);
      const manifestPath = join(tempDir, "observations-manifest.json");
      const outPath = join(tempDir, "proof.json");
      const manifest = makeManifest(files);
      delete (manifest as { mission_workbench?: unknown }).mission_workbench;
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      const result = spawnSync("bash", ["rust-core/scripts/mission-spine-ui-device-proof-assemble.sh"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MISSION_ID: missionId,
          MOBILE_EVIDENCE: files.mobile,
          DESKTOP_EVIDENCE: files.desktop,
          CHANNEL_EVIDENCE: files.channel,
          TIMELINE_EVIDENCE: files.timeline,
          OBSERVATIONS_MANIFEST: manifestPath,
          OUT: outPath,
        },
        encoding: "utf8",
      });

      expect(result.status).toBe(6);
      expect(result.stderr).toContain("workbench/transcript");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
