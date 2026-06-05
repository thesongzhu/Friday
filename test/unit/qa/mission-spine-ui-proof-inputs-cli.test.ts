import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const missionId = "mission_cli_ui_proof_inputs";

function writeEvidenceFiles(tempDir: string) {
  const files = {
    mobile: join(tempDir, "mobile-real-consumption.json"),
    desktop: join(tempDir, "desktop-real-consumption.json"),
    channel: join(tempDir, "channel-real-consumption.json"),
    timeline: join(tempDir, "bounded-timeline-real-consumption.json"),
  };

  for (const [role, filePath] of Object.entries(files)) {
    writeFileSync(filePath, JSON.stringify({
      role,
      mission_id: missionId,
      capture: "redacted pre-assemble CLI fixture for harness validation only",
    }));
  }

  return files;
}

function makeObservation(surface: string, event: string, evidenceRef: string) {
  return {
    surface,
    event,
    mission_id: missionId,
    evidence_ref: evidenceRef,
  };
}

function makeManifest(evidenceRefs: ReturnType<typeof writeEvidenceFiles>, overrides: Record<string, unknown> = {}) {
  const checks = Object.fromEntries([
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
  ].map((check) => [check, true]));

  const stress = {
    mission_bound_ask_count: 20,
    duplicate_surface_count: 2,
    long_timeline_page_count: 2,
    evidence_ref: evidenceRefs.timeline,
    consecutive: true,
    provider_ack_not_done: true,
    invalid_key_error_visible: true,
    quota_error_visible: true,
    network_error_visible: true,
    long_timeline_pagination_visible: true,
    reconnect_stale_verified: true,
    channel_replay_blocked: true,
    no_secret_leak: true,
    no_hidden_fallback: true,
  };

  const observations = [
    makeObservation("mobile", "mission_intake_submitted", evidenceRefs.mobile),
    makeObservation("mobile", "mission_intake_ready", evidenceRefs.mobile),
    makeObservation("desktop", "mission_resolve_or_create_visible", evidenceRefs.desktop),
    makeObservation("desktop", "duplicate_preflight_visible", evidenceRefs.desktop),
    makeObservation("mobile", "mission_bound_provider_action_visible", evidenceRefs.mobile),
    makeObservation("desktop", "real_provider_execution_visible", evidenceRefs.desktop),
    makeObservation("mobile", "proof_receipt_visible_before_done", evidenceRefs.mobile),
    makeObservation("desktop", "same_mission_projection_visible", evidenceRefs.desktop),
    makeObservation("desktop", "mission_workbench_visible", evidenceRefs.desktop),
    makeObservation("desktop", "transcript_browser_visible", evidenceRefs.desktop),
    makeObservation("desktop", "duplicate_blocked_opens_existing", evidenceRefs.desktop),
    makeObservation("channel", "same_mission_projection_visible", evidenceRefs.channel),
    makeObservation("channel", "same_mission_mobile_desktop_channel_visible", evidenceRefs.channel),
    makeObservation("timeline", "bounded_page_1_visible", evidenceRefs.timeline),
    makeObservation("timeline", "bounded_page_2_visible", evidenceRefs.timeline),
    makeObservation("timeline", "memory_candidate_review_only", evidenceRefs.timeline),
    makeObservation("desktop", "provider_ack_not_done_visible", evidenceRefs.desktop),
    makeObservation("desktop", "pressure_20_50_consecutive_asks_visible", evidenceRefs.desktop),
    makeObservation("desktop", "invalid_key_error_visible", evidenceRefs.desktop),
    makeObservation("desktop", "quota_error_visible", evidenceRefs.desktop),
    makeObservation("desktop", "network_error_visible", evidenceRefs.desktop),
    makeObservation("channel", "channel_replay_blocked_visible", evidenceRefs.channel),
    makeObservation("desktop", "reconnect_stale_verified", evidenceRefs.desktop),
    makeObservation("desktop", "real_provider_execution_receipt_visible", evidenceRefs.desktop),
    makeObservation("desktop", "stale_label_visible", evidenceRefs.desktop),
    makeObservation("desktop", "offline_label_visible", evidenceRefs.desktop),
    makeObservation("desktop", "error_label_visible", evidenceRefs.desktop),
    makeObservation("desktop", "no_hidden_fallback_verified", evidenceRefs.desktop),
  ];

  return {
    mission_workbench: {
      visible: true,
      same_mission_projection_visible: true,
      provider_ack_not_done_visible: true,
      memory_candidate_review_only_visible: true,
      evidence_ref: evidenceRefs.desktop,
    },
    transcript_browser: {
      visible: true,
      collapsed_by_default: true,
      redacted: true,
      bounded_timeline_linked: true,
      evidence_ref: evidenceRefs.desktop,
      search_facets: ["mission", "work_item", "surface", "provider", "skill", "channel", "status", "proof_receipt", "time"],
      evidence_facets: ["providerRef", "skillRunRef", "channelRef", "workflowRef", "surfaceThreadRef", "timelineRef", "proofReceiptRef"],
    },
    checks,
    stress,
    timeline: {
      bounded: true,
      page_count: 2,
      cursor_verified: true,
    },
    status_labels: ["stale", "offline", "error"],
    memory_candidates: [
      {
        id: "memory_candidate_review_only",
        confirmed: false,
        grants_memory_authority: false,
      },
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
    observations,
    ...overrides,
  };
}

function runInputsCli(
  files: ReturnType<typeof writeEvidenceFiles>,
  manifestPath: string,
  extraArgs: string[] = [],
  missionIdOverride = missionId,
) {
  const stdout = execFileSync(process.execPath, [
    "scripts/qa/check-mission-spine-ui-proof-inputs.mjs",
    `--mission-id=${missionIdOverride}`,
    `--mobile=${files.mobile}`,
    `--desktop=${files.desktop}`,
    `--channel=${files.channel}`,
    `--timeline=${files.timeline}`,
    `--manifest=${manifestPath}`,
    ...extraArgs,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return JSON.parse(stdout) as {
    proof: string;
    proof_source: string;
    readyForAssemble: boolean;
    failures: Array<{ code: string; detail: string }>;
    evidence: Array<{ role: string; path: string; sha256: string; bytes: number }>;
  };
}

describe("check-mission-spine-ui-proof-inputs CLI", () => {
  it("accepts complete pre-assemble inputs without producing final proof", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-proof-inputs-"));
    try {
      const files = writeEvidenceFiles(tempDir);
      const manifestPath = join(tempDir, "observations-manifest.json");
      writeFileSync(manifestPath, JSON.stringify(makeManifest(files), null, 2));

      const result = runInputsCli(files, manifestPath);

      expect(result).toMatchObject({
        proof: "mission_spine_ui_device_inputs_preflight",
        proof_source: "pre_assemble_readiness_only_not_ui_device_proof",
        readyForAssemble: true,
        failures: [],
      });
      expect(result.evidence.map((entry) => entry.role)).toEqual(["mobile", "desktop", "channel", "timeline"]);
      expect(result.evidence.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256) && entry.bytes > 0)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed for template or weak manifest inputs in expect-not-ready mode", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-proof-inputs-invalid-"));
    try {
      const files = writeEvidenceFiles(tempDir);
      const manifestPath = join(tempDir, "observations-manifest-invalid.json");
      const manifest = makeManifest(files, {
        template: true,
        mission_workbench: {
          visible: false,
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
          search_facets: ["mission"],
          evidence_facets: ["providerRef"],
        },
      });
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      const result = runInputsCli(files, manifestPath, ["--expect-not-ready"]);
      const failureCodes = result.failures.map((failure) => failure.code);

      expect(result.readyForAssemble).toBe(false);
      expect(failureCodes).toContain("placeholder_marker_present");
      expect(failureCodes).toContain("manifest_marked_non_real");
      expect(failureCodes).toContain("mission_workbench_not_visible");
      expect(failureCodes).toContain("transcript_browser_search_facet_missing");
      expect(failureCodes).toContain("transcript_browser_evidence_facet_missing");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed when manifest events point at the wrong evidence role", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-proof-inputs-role-mismatch-"));
    try {
      const files = writeEvidenceFiles(tempDir);
      const manifestPath = join(tempDir, "observations-manifest-role-mismatch.json");
      const manifest = makeManifest(files, {
        mission_workbench: {
          visible: true,
          same_mission_projection_visible: true,
          provider_ack_not_done_visible: true,
          memory_candidate_review_only_visible: true,
          evidence_ref: files.mobile,
        },
        transcript_browser: {
          visible: true,
          collapsed_by_default: true,
          redacted: true,
          bounded_timeline_linked: true,
          evidence_ref: files.channel,
          search_facets: ["mission", "work_item", "surface", "provider", "skill", "channel", "status", "proof_receipt", "time"],
          evidence_facets: ["providerRef", "skillRunRef", "channelRef", "workflowRef", "surfaceThreadRef", "timelineRef", "proofReceiptRef"],
        },
        stress: {
          ...makeManifest(files).stress,
          evidence_ref: files.desktop,
        },
        observations: makeManifest(files).observations.map((observation) => (
          observation.event === "mission_intake_submitted"
            ? { ...observation, evidence_ref: files.desktop }
            : observation
        )),
      });
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      const result = runInputsCli(files, manifestPath, ["--expect-not-ready"]);
      const failureCodes = result.failures.map((failure) => failure.code);

      expect(result.readyForAssemble).toBe(false);
      expect(failureCodes).toContain("mission_workbench_evidence_ref_not_desktop");
      expect(failureCodes).toContain("transcript_browser_evidence_ref_not_desktop");
      expect(failureCodes).toContain("stress_evidence_ref_not_timeline");
      expect(failureCodes).toContain("observation_evidence_ref_role_mismatch");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed when the requested mission id is not canonical", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-proof-inputs-mission-shape-"));
    try {
      const files = writeEvidenceFiles(tempDir);
      const manifestPath = join(tempDir, "observations-manifest-mission-shape.json");
      writeFileSync(manifestPath, JSON.stringify(makeManifest(files), null, 2));

      const result = runInputsCli(files, manifestPath, ["--expect-not-ready"], "capture_target_without_prefix");
      const failureCodes = result.failures.map((failure) => failure.code);

      expect(result.readyForAssemble).toBe(false);
      expect(failureCodes).toContain("mission_id_unexpected_shape");
      expect(failureCodes).toContain("observation_mission_mismatch");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
