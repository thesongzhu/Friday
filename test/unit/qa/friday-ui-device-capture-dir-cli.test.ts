import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const missionId = "mission_cli_ui_device_capture_dir";

function writeEvidence(tempDir: string) {
  const files = {
    mobile: join(tempDir, "mobile.png"),
    desktop: join(tempDir, "desktop.json"),
    channel: join(tempDir, "channel.log"),
    timeline: join(tempDir, "timeline.trace"),
  };
  for (const [role, path] of Object.entries(files)) {
    writeFileSync(path, `real capture shaped evidence ${role} ${missionId}\n`);
  }
  return files;
}

function observation(surface: string, event: string, evidenceRef: string) {
  return { surface, event, mission_id: missionId, evidence_ref: evidenceRef };
}

function writeManifest(path: string, evidenceDir: string) {
  const refs = {
    mobile: join(evidenceDir, "mobile.png"),
    desktop: join(evidenceDir, "desktop.json"),
    channel: join(evidenceDir, "channel.log"),
    timeline: join(evidenceDir, "timeline.trace"),
  };
  const checks = [
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
  ];
  const manifest = {
    checks: Object.fromEntries(checks.map((check) => [check, true])),
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
      evidence_ref: refs.timeline,
    },
    timeline: { bounded: true, page_count: 2, cursor_verified: true },
    mission_workbench: {
      visible: true,
      same_mission_projection_visible: true,
      provider_ack_not_done_visible: true,
      memory_candidate_review_only_visible: true,
      evidence_ref: refs.desktop,
    },
    transcript_browser: {
      visible: true,
      collapsed_by_default: true,
      redacted: true,
      bounded_timeline_linked: true,
      evidence_ref: refs.desktop,
      search_facets: ["mission", "work_item", "surface", "provider", "skill", "channel", "status", "proof_receipt", "time"],
      evidence_facets: ["providerRef", "skillRunRef", "channelRef", "workflowRef", "surfaceThreadRef", "timelineRef", "proofReceiptRef"],
    },
    status_labels: ["stale", "offline", "error"],
    memory_candidates: [{ id: "memory_candidate_review_only", confirmed: false, grants_memory_authority: false }],
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
      observation("mobile", "mission_intake_submitted", refs.mobile),
      observation("mobile", "mission_intake_ready", refs.mobile),
      observation("desktop", "mission_resolve_or_create_visible", refs.desktop),
      observation("desktop", "duplicate_preflight_visible", refs.desktop),
      observation("mobile", "mission_bound_provider_action_visible", refs.mobile),
      observation("desktop", "real_provider_execution_visible", refs.desktop),
      observation("mobile", "proof_receipt_visible_before_done", refs.mobile),
      observation("desktop", "same_mission_projection_visible", refs.desktop),
      observation("desktop", "mission_workbench_visible", refs.desktop),
      observation("desktop", "transcript_browser_visible", refs.desktop),
      observation("desktop", "duplicate_blocked_opens_existing", refs.desktop),
      observation("channel", "same_mission_projection_visible", refs.channel),
      observation("channel", "same_mission_mobile_desktop_channel_visible", refs.channel),
      observation("timeline", "bounded_page_1_visible", refs.timeline),
      observation("timeline", "bounded_page_2_visible", refs.timeline),
      observation("timeline", "memory_candidate_review_only", refs.timeline),
      observation("desktop", "provider_ack_not_done_visible", refs.desktop),
      observation("desktop", "pressure_20_50_consecutive_asks_visible", refs.desktop),
      observation("desktop", "invalid_key_error_visible", refs.desktop),
      observation("desktop", "quota_error_visible", refs.desktop),
      observation("desktop", "network_error_visible", refs.desktop),
      observation("channel", "channel_replay_blocked_visible", refs.channel),
      observation("desktop", "reconnect_stale_verified", refs.desktop),
      observation("desktop", "real_provider_execution_receipt_visible", refs.desktop),
      observation("desktop", "stale_label_visible", refs.desktop),
      observation("desktop", "offline_label_visible", refs.desktop),
      observation("desktop", "error_label_visible", refs.desktop),
      observation("desktop", "no_hidden_fallback_verified", refs.desktop),
    ],
  };
  writeFileSync(path, JSON.stringify(manifest, null, 2));
}

function completeEventRows(refs: ReturnType<typeof writeEvidence>) {
  const rows = [
    observation("mobile", "mission_intake_submitted", refs.mobile),
    observation("mobile", "mission_intake_ready", refs.mobile),
    observation("desktop", "mission_resolve_or_create_visible", refs.desktop),
    observation("desktop", "duplicate_preflight_visible", refs.desktop),
    observation("mobile", "duplicate_preflight_visible", refs.mobile),
    observation("mobile", "mission_bound_provider_action_visible", refs.mobile),
    observation("desktop", "real_provider_execution_visible", refs.desktop),
    observation("mobile", "proof_receipt_visible_before_done", refs.mobile),
    observation("desktop", "same_mission_projection_visible", refs.desktop),
    observation("desktop", "mission_workbench_visible", refs.desktop),
    observation("desktop", "transcript_browser_visible", refs.desktop),
    observation("desktop", "duplicate_blocked_opens_existing", refs.desktop),
    observation("channel", "same_mission_projection_visible", refs.channel),
    observation("channel", "same_mission_mobile_desktop_channel_visible", refs.channel),
    observation("timeline", "bounded_page_1_visible", refs.timeline),
    observation("timeline", "bounded_page_2_visible", refs.timeline),
    observation("timeline", "memory_candidate_review_only", refs.timeline),
    observation("desktop", "provider_ack_not_done_visible", refs.desktop),
    observation("desktop", "invalid_key_error_visible", refs.desktop),
    observation("desktop", "quota_error_visible", refs.desktop),
    observation("desktop", "network_error_visible", refs.desktop),
    observation("channel", "channel_replay_blocked_visible", refs.channel),
    observation("desktop", "reconnect_stale_verified", refs.desktop),
    observation("desktop", "real_provider_execution_receipt_visible", refs.desktop),
    observation("desktop", "stale_label_visible", refs.desktop),
    observation("desktop", "offline_label_visible", refs.desktop),
    observation("desktop", "error_label_visible", refs.desktop),
    observation("desktop", "no_hidden_fallback_verified", refs.desktop),
  ];
  for (let index = 0; index < 20; index += 1) {
    rows.push(observation("desktop", "pressure_20_50_consecutive_asks_visible", refs.desktop));
  }
  return rows;
}

function nonChannelEventRows(refs: ReturnType<typeof writeEvidence>) {
  return completeEventRows(refs).filter((row) => {
    const eventRow = row as { surface?: string; event?: string };
    return eventRow.surface !== "channel" && !String(eventRow.event || "").includes("channel");
  });
}

function writeEvents(path: string, refs: ReturnType<typeof writeEvidence>) {
  const rows = completeEventRows(refs);
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function writeNonChannelEvents(path: string, refs: ReturnType<typeof writeEvidence>) {
  const rows = nonChannelEventRows(refs);
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

describe("friday-ui-device-capture-dir", () => {
  it("indexes captures and runs the existing preflight when a real manifest is supplied", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-capture-dir-"));
    try {
      const captures = writeEvidence(tempDir);
      const outDir = join(tempDir, "evidence");
      const manifest = join(tempDir, "observations-source.json");
      writeManifest(manifest, outDir);

      const stdout = execFileSync("node", [
        "scripts/ops/friday-ui-device-capture-dir.mjs",
        `--mission-id=${missionId}`,
        `--out-dir=${outDir}`,
        `--mobile=${captures.mobile}`,
        `--desktop=${captures.desktop}`,
        `--channel=${captures.channel}`,
        `--timeline=${captures.timeline}`,
        `--observations-manifest=${manifest}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });

      const result = JSON.parse(stdout) as {
        status?: string;
        truth?: string;
        preflight?: { status?: number };
        reuseSummary?: {
          truth?: string;
          captures?: Array<{ role?: string; reusableAsUiDeviceEvidenceInput?: boolean; countsAsProofByItself?: boolean }>;
          observationsManifest?: { present?: boolean; reusableForPreflight?: boolean; countsAsProofByItself?: boolean };
        };
      };
      expect(result.truth).toBe("ui_device_capture_dir_driver_not_proof");
      expect(result.status).toBe("ready");
      expect(result.preflight?.status).toBe(0);
      expect(result.reuseSummary?.truth).toBe("ui_device_capture_dir_reuse_summary_not_proof");
      expect(result.reuseSummary?.captures).toContainEqual(expect.objectContaining({
        role: "mobile",
        reusableAsUiDeviceEvidenceInput: true,
        countsAsProofByItself: false,
      }));
      expect(result.reuseSummary?.observationsManifest).toEqual(expect.objectContaining({
        present: true,
        reusableForPreflight: true,
        countsAsProofByItself: false,
      }));

      const index = JSON.parse(readFileSync(join(outDir, "capture-index.json"), "utf8")) as {
        truth?: string;
        reuseSummary?: { nextCommand?: string };
      };
      expect(index.truth).toBe("ui_device_capture_dir_index_not_proof");
      expect(index.reuseSummary?.nextCommand).toBe("scripts/ops/friday-ui-device-proof-readiness.sh --evidence-dir <dir> --require-proof");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("derives a manifest from same-run events and remaps capture refs into the evidence dir", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-capture-dir-events-"));
    try {
      const captures = writeEvidence(tempDir);
      const events = join(tempDir, "same-run-events.jsonl");
      const outDir = join(tempDir, "evidence");
      writeEvents(events, captures);

      const stdout = execFileSync("node", [
        "scripts/ops/friday-ui-device-capture-dir.mjs",
        `--mission-id=${missionId}`,
        `--out-dir=${outDir}`,
        `--mobile=${captures.mobile}`,
        `--desktop=${captures.desktop}`,
        `--channel=${captures.channel}`,
        `--timeline=${captures.timeline}`,
        `--events=${events}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });

      const result = JSON.parse(stdout) as {
        status?: string;
        observationsManifest?: string;
        normalizedEvents?: string;
        preflight?: { status?: number };
      };
      expect(result.status).toBe("ready");
      expect(result.preflight?.status).toBe(0);
      expect(result.observationsManifest).toBe(join(outDir, "observations-manifest.json"));
      expect(result.normalizedEvents).toBe(join(outDir, "same-run-events.normalized.jsonl"));

      const manifest = JSON.parse(readFileSync(join(outDir, "observations-manifest.json"), "utf8")) as {
        observations?: Array<{ evidence_ref?: string }>;
      };
      expect(manifest.observations?.some((row) => row.evidence_ref === captures.mobile)).toBe(false);
      expect(manifest.observations?.some((row) => row.evidence_ref === join(outDir, "mobile.png"))).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("indexes non-channel captures when channel proof is explicitly deferred without claiming strict preflight", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-capture-dir-channel-deferred-"));
    try {
      const captures = writeEvidence(tempDir);
      const events = join(tempDir, "same-run-events.jsonl");
      const outDir = join(tempDir, "evidence");
      writeNonChannelEvents(events, captures);

      const stdout = execFileSync("node", [
        "scripts/ops/friday-ui-device-capture-dir.mjs",
        `--mission-id=${missionId}`,
        `--out-dir=${outDir}`,
        `--mobile=${captures.mobile}`,
        `--desktop=${captures.desktop}`,
        `--timeline=${captures.timeline}`,
        `--events=${events}`,
        "--defer-channel-proof",
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });

      const result = JSON.parse(stdout) as {
        status?: string;
        captures?: Array<{ role?: string }>;
        preflight?: { skipped?: boolean; reason?: string; countsTowardUiDeviceProof?: boolean };
        deferredInputs?: Array<{ role?: string; countsTowardUiDeviceProof?: boolean }>;
        reuseSummary?: { deferredInputs?: Array<{ role?: string; countsTowardUiDeviceProof?: boolean }> };
      };
      expect(result.status).toBe("ready");
      expect(result.captures?.map((capture) => capture.role).sort()).toEqual(["desktop", "mobile", "timeline"]);
      expect(result.preflight).toEqual(expect.objectContaining({
        skipped: true,
        reason: "channel_deferred",
        countsTowardUiDeviceProof: false,
      }));
      expect(result.deferredInputs).toContainEqual(expect.objectContaining({
        role: "channel",
        countsTowardUiDeviceProof: false,
      }));
      expect(result.reuseSummary?.deferredInputs).toContainEqual(expect.objectContaining({
        role: "channel",
        countsTowardUiDeviceProof: false,
      }));

      const manifest = JSON.parse(readFileSync(join(outDir, "observations-manifest.json"), "utf8")) as {
        checks?: Record<string, boolean>;
        deferred_inputs?: Array<{ role?: string; countsTowardUiDeviceProof?: boolean }>;
      };
      expect(manifest.checks?.same_mission_id_channel).toBeUndefined();
      expect(manifest.deferred_inputs).toContainEqual(expect.objectContaining({
        role: "channel",
        countsTowardUiDeviceProof: false,
      }));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("merges multiple same-run event inputs before deriving the manifest", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-capture-dir-multi-events-"));
    try {
      const captures = writeEvidence(tempDir);
      const first = join(tempDir, "mobile-desktop-events.jsonl");
      const eventsDir = join(tempDir, "more-events");
      const second = join(eventsDir, "timeline-channel-events.jsonl");
      const outDir = join(tempDir, "evidence");
      mkdirSync(eventsDir);

      const allRows = completeEventRows(captures);
      writeFileSync(first, `${allRows.slice(0, 10).map((row) => JSON.stringify(row)).join("\n")}\n`);
      writeFileSync(second, `${allRows.slice(10).map((row) => JSON.stringify(row)).join("\n")}\n`);

      const stdout = execFileSync("node", [
        "scripts/ops/friday-ui-device-capture-dir.mjs",
        `--mission-id=${missionId}`,
        `--out-dir=${outDir}`,
        `--mobile=${captures.mobile}`,
        `--desktop=${captures.desktop}`,
        `--channel=${captures.channel}`,
        `--timeline=${captures.timeline}`,
        `--events=${first}`,
        `--events-dir=${eventsDir}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });

      const result = JSON.parse(stdout) as {
        status?: string;
        mergedEvents?: string;
        normalizedEvents?: string;
        preflight?: { status?: number };
      };
      expect(result.status).toBe("ready");
      expect(result.preflight?.status).toBe(0);
      expect(result.mergedEvents).toBe(join(outDir, "same-run-events.merged-source.jsonl"));
      expect(result.normalizedEvents).toBe(join(outDir, "same-run-events.normalized.jsonl"));

      const mergedRows = readFileSync(join(outDir, "same-run-events.merged-source.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(mergedRows).toContainEqual(observation("mobile", "mission_intake_submitted", captures.mobile));
      expect(mergedRows).toContainEqual(observation("channel", "channel_replay_blocked_visible", captures.channel));

      const manifest = JSON.parse(readFileSync(join(outDir, "observations-manifest.json"), "utf8")) as {
        observations?: Array<{ evidence_ref?: string }>;
      };
      expect(manifest.observations?.some((row) => row.evidence_ref === captures.mobile)).toBe(false);
      expect(manifest.observations?.some((row) => row.evidence_ref === join(outDir, "mobile.png"))).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("stays blocked without an observations manifest and does not invent one", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-capture-dir-missing-"));
    try {
      const captures = writeEvidence(tempDir);
      const result = spawnSync("node", [
        "scripts/ops/friday-ui-device-capture-dir.mjs",
        `--mission-id=${missionId}`,
        `--out-dir=${join(tempDir, "evidence")}`,
        `--mobile=${captures.mobile}`,
        `--desktop=${captures.desktop}`,
        `--channel=${captures.channel}`,
        `--timeline=${captures.timeline}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });

      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { status?: string; blockers?: Array<{ code?: string }> };
      expect(output.status).toBe("blocked");
      expect(output.blockers?.map((blocker) => blocker.code)).toContain("observations_manifest_missing");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
