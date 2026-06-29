import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const missionId = "mission_cli_ui_device_observations";

function writeEvidence(tempDir: string) {
  const files = {
    mobile: join(tempDir, "mobile.png"),
    desktop: join(tempDir, "desktop.json"),
    channel: join(tempDir, "channel.log"),
    timeline: join(tempDir, "timeline.trace"),
  };
  for (const [role, path] of Object.entries(files)) {
    writeFileSync(path, `real same-run ${role} evidence for ${missionId}\n`);
  }
  return files;
}

function event(surface: string, name: string, evidenceRef: string, mission = missionId) {
  return { surface, event: name, mission_id: mission, evidence_ref: evidenceRef };
}

function writeJsonl(path: string, rows: unknown[]) {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function completeEvents(refs: ReturnType<typeof writeEvidence>) {
  const rows = [
    event("mobile", "mission_intake_submitted", refs.mobile),
    event("mobile", "mission_intake_ready", refs.mobile),
    event("desktop", "mission_resolve_or_create_visible", refs.desktop),
    event("desktop", "duplicate_preflight_visible", refs.desktop),
    event("mobile", "duplicate_preflight_visible", refs.mobile),
    event("mobile", "mission_bound_provider_action_visible", refs.mobile),
    event("desktop", "real_provider_execution_visible", refs.desktop),
    event("mobile", "proof_receipt_visible_before_done", refs.mobile),
    event("desktop", "same_mission_projection_visible", refs.desktop),
    event("desktop", "mission_workbench_visible", refs.desktop),
    event("desktop", "transcript_browser_visible", refs.desktop),
    event("desktop", "duplicate_blocked_opens_existing", refs.desktop),
    event("channel", "same_mission_projection_visible", refs.channel),
    event("channel", "same_mission_mobile_desktop_channel_visible", refs.channel),
    event("timeline", "bounded_page_1_visible", refs.timeline),
    event("timeline", "bounded_page_2_visible", refs.timeline),
    event("timeline", "memory_candidate_review_only", refs.timeline),
    event("desktop", "provider_ack_not_done_visible", refs.desktop),
    event("desktop", "invalid_key_error_visible", refs.desktop),
    event("desktop", "quota_error_visible", refs.desktop),
    event("desktop", "network_error_visible", refs.desktop),
    event("channel", "channel_replay_blocked_visible", refs.channel),
    event("desktop", "reconnect_stale_verified", refs.desktop),
    event("desktop", "real_provider_execution_receipt_visible", refs.desktop),
    event("desktop", "stale_label_visible", refs.desktop),
    event("desktop", "offline_label_visible", refs.desktop),
    event("desktop", "error_label_visible", refs.desktop),
    event("desktop", "no_hidden_fallback_verified", refs.desktop),
  ];
  for (let index = 0; index < 20; index += 1) {
    rows.push(event("desktop", "pressure_20_50_consecutive_asks_visible", refs.desktop));
  }
  return rows;
}

function nonChannelEvents(refs: ReturnType<typeof writeEvidence>) {
  return completeEvents(refs).filter((row) => {
    const eventRow = row as { surface?: string; event?: string };
    return eventRow.surface !== "channel" && !String(eventRow.event || "").includes("channel");
  });
}

function runManifest(tempDir: string, refs: ReturnType<typeof writeEvidence>, rows: unknown[], extraArgs: string[] = []) {
  const events = join(tempDir, "same-run-events.jsonl");
  const out = join(tempDir, "observations-manifest.json");
  writeJsonl(events, rows);
  const result = spawnSync("node", [
    "scripts/ops/friday-ui-device-observations-manifest.mjs",
    `--mission-id=${missionId}`,
    `--mobile=${refs.mobile}`,
    `--desktop=${refs.desktop}`,
    `--channel=${refs.channel}`,
    `--timeline=${refs.timeline}`,
    `--events=${events}`,
    `--out=${out}`,
    ...extraArgs,
  ], { cwd: process.cwd(), encoding: "utf8" });
  return { result, out };
}

describe("friday-ui-device-observations-manifest", () => {
  it("derives a same-run manifest that passes the strict UI proof input checker", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-observations-"));
    try {
      const refs = writeEvidence(tempDir);
      const { result, out } = runManifest(tempDir, refs, completeEvents(refs), ["--require-ready"]);

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as { truth?: string; status?: string; blockers?: unknown[] };
      expect(output.truth).toBe("ui_device_observations_manifest_driver_not_proof");
      expect(output.status).toBe("ready");
      expect(output.blockers).toEqual([]);

      const manifest = JSON.parse(readFileSync(out, "utf8")) as { truth_label?: string; stress?: { mission_bound_ask_count?: number; duplicate_surface_count?: number } };
      expect(manifest.truth_label).toBe("ui_device_observations_manifest_derived_from_same_run_events_not_proof");
      expect(manifest.stress?.mission_bound_ask_count).toBe(20);
      expect(manifest.stress?.duplicate_surface_count).toBe(2);

      const preflight = JSON.parse(execFileSync("node", [
        "scripts/qa/check-mission-spine-ui-proof-inputs.mjs",
        `--mission-id=${missionId}`,
        `--mobile=${refs.mobile}`,
        `--desktop=${refs.desktop}`,
        `--channel=${refs.channel}`,
        `--timeline=${refs.timeline}`,
        `--manifest=${out}`,
      ], { cwd: process.cwd(), encoding: "utf8" })) as { readyForAssemble?: boolean; failures?: unknown[] };
      expect(preflight.readyForAssemble).toBe(true);
      expect(preflight.failures).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts evidence refs that resolve to the same file through a symlink", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-observations-realpath-"));
    try {
      const refs = writeEvidence(tempDir);
      const alias = join(tempDir, "desktop-alias.json");
      symlinkSync(refs.desktop, alias);
      const rows = completeEvents({ ...refs, desktop: alias });
      const { result, out } = runManifest(tempDir, refs, rows, ["--require-ready"]);

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as { status?: string; blockers?: unknown[] };
      expect(output.status).toBe("ready");
      expect(output.blockers).toEqual([]);
      const manifest = JSON.parse(readFileSync(out, "utf8")) as { transcript_browser?: { evidence_ref?: string } };
      expect(manifest.transcript_browser?.evidence_ref).toBe(alias);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts explicitly declared extra evidence refs without assigning them to a surface role", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-observations-extra-evidence-"));
    try {
      const refs = writeEvidence(tempDir);
      const extra = join(tempDir, "desktop-ax-tree.raw.txt");
      writeFileSync(extra, "real desktop AX tree bytes\n");
      const rows = completeEvents(refs).map((row) => {
        const eventRow = row as { event?: string };
        if (eventRow.event === "mission_resolve_or_create_visible") {
          return event("desktop", "mission_resolve_or_create_visible", extra);
        }
        return row;
      });
      const blocked = runManifest(tempDir, refs, rows, ["--require-ready"]);
      const blockedOutput = JSON.parse(blocked.result.stdout) as { blockers?: Array<{ code?: string }> };
      expect(blocked.result.status).toBe(2);
      expect(blockedOutput.blockers?.map((blocker) => blocker.code)).toContain("event_evidence_ref_unknown");

      const { result, out } = runManifest(tempDir, refs, rows, [
        `--extra-evidence-ref=${extra}`,
        "--require-ready",
      ]);

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as { status?: string; extraEvidenceRefs?: string[]; blockers?: unknown[] };
      expect(output.status).toBe("ready");
      expect(output.extraEvidenceRefs).toContain(extra);
      expect(output.blockers).toEqual([]);
      const manifest = JSON.parse(readFileSync(out, "utf8")) as { extra_evidence_refs?: string[] };
      expect(manifest.extra_evidence_refs).toContain(extra);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("derives non-channel manifest inputs when channel proof is explicitly deferred", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-observations-channel-deferred-"));
    try {
      const refs = writeEvidence(tempDir);
      const events = join(tempDir, "same-run-events.jsonl");
      const out = join(tempDir, "observations-manifest.json");
      writeJsonl(events, nonChannelEvents(refs));

      const result = spawnSync("node", [
        "scripts/ops/friday-ui-device-observations-manifest.mjs",
        `--mission-id=${missionId}`,
        `--mobile=${refs.mobile}`,
        `--desktop=${refs.desktop}`,
        `--timeline=${refs.timeline}`,
        `--events=${events}`,
        `--out=${out}`,
        "--defer-channel-proof",
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as {
        status?: string;
        deferredInputs?: Array<{ role?: string; countsTowardUiDeviceProof?: boolean }>;
      };
      expect(output.status).toBe("ready");
      expect(output.deferredInputs).toContainEqual(expect.objectContaining({
        role: "channel",
        countsTowardUiDeviceProof: false,
      }));

      const manifest = JSON.parse(readFileSync(out, "utf8")) as {
        checks?: Record<string, boolean>;
        event_order?: string[];
        deferred_inputs?: Array<{ role?: string; countsTowardUiDeviceProof?: boolean }>;
        observations?: Array<{ surface?: string; event?: string }>;
      };
      expect(manifest.checks?.same_mission_id_channel).toBeUndefined();
      expect(manifest.checks?.channel_replay_blocked).toBeUndefined();
      expect(manifest.event_order).not.toContain("same_mission_mobile_desktop_channel");
      expect(manifest.observations?.some((row) => row.surface === "channel" || String(row.event).includes("channel"))).toBe(false);
      expect(manifest.deferred_inputs).toContainEqual(expect.objectContaining({
        role: "channel",
        countsTowardUiDeviceProof: false,
      }));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps multiple negative-control missions as separate fail-closed segments", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-observations-multi-negative-"));
    try {
      const refs = writeEvidence(tempDir);
      const events = join(tempDir, "same-run-events.jsonl");
      const out = join(tempDir, "observations-manifest.json");
      const negativeStatus = join(tempDir, "negative-status.jsonl");
      const negativeStress = join(tempDir, "negative-stress.jsonl");
      const statusEvidence = join(tempDir, "desktop-status.raw.txt");
      const stressEvidence = join(tempDir, "real-stress-source-report.json");
      writeFileSync(statusEvidence, "real desktop status negative-control evidence\n");
      writeFileSync(stressEvidence, "real stress negative-control evidence\n");
      writeJsonl(events, nonChannelEvents(refs).filter((row) => {
        const eventRow = row as { event?: string };
        return ![
          "provider_ack_not_done_visible",
          "pressure_20_50_consecutive_asks_visible",
          "invalid_key_error_visible",
          "quota_error_visible",
          "network_error_visible",
          "reconnect_stale_verified",
          "stale_label_visible",
          "offline_label_visible",
          "error_label_visible",
          "no_hidden_fallback_verified",
        ].includes(String(eventRow.event || ""));
      }));
      writeJsonl(negativeStatus, [
        event("desktop", "stale_label_visible", statusEvidence, "mission_negative_status"),
        event("desktop", "offline_label_visible", statusEvidence, "mission_negative_status"),
        event("desktop", "error_label_visible", statusEvidence, "mission_negative_status"),
      ]);
      writeJsonl(negativeStress, [
        event("desktop", "provider_ack_not_done_visible", stressEvidence, "mission_negative_stress"),
        event("desktop", "invalid_key_error_visible", stressEvidence, "mission_negative_stress"),
        event("desktop", "quota_error_visible", stressEvidence, "mission_negative_stress"),
        event("desktop", "network_error_visible", stressEvidence, "mission_negative_stress"),
        event("desktop", "reconnect_stale_verified", stressEvidence, "mission_negative_stress"),
        event("timeline", "no_hidden_fallback_verified", stressEvidence, "mission_negative_stress"),
        ...Array.from({ length: 20 }, () => event("desktop", "pressure_20_50_consecutive_asks_visible", stressEvidence, "mission_negative_stress")),
      ]);

      const result = spawnSync("node", [
        "scripts/ops/friday-ui-device-observations-manifest.mjs",
        `--mission-id=${missionId}`,
        `--mobile=${refs.mobile}`,
        `--desktop=${refs.desktop}`,
        `--timeline=${refs.timeline}`,
        `--events=${events}`,
        `--negative-control-events=${negativeStatus}`,
        `--negative-control-events=${negativeStress}`,
        `--extra-evidence-ref=${statusEvidence}`,
        `--extra-evidence-ref=${stressEvidence}`,
        `--out=${out}`,
        "--defer-channel-proof",
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as { status?: string; blockers?: unknown[] };
      expect(output.status).toBe("ready");
      expect(output.blockers).toEqual([]);

      const manifest = JSON.parse(readFileSync(out, "utf8")) as {
        negative_control_segments?: Array<{ mission_id?: string; observations?: unknown[] }>;
        stress?: { mission_bound_ask_count?: number };
        event_order?: string[];
      };
      expect(manifest.negative_control_segments).toHaveLength(2);
      expect(manifest.negative_control_segments?.map((segment) => segment.mission_id).sort()).toEqual([
        "mission_negative_status",
        "mission_negative_stress",
      ]);
      expect(manifest.stress?.mission_bound_ask_count).toBe(20);
      expect(manifest.event_order).not.toContain("stale_offline_error_labels_verified");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("blocks an explicit single negative-control mission when rows contain another mission", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-observations-negative-mismatch-"));
    try {
      const refs = writeEvidence(tempDir);
      const negative = join(tempDir, "negative.jsonl");
      writeJsonl(negative, [
        event("desktop", "stale_label_visible", refs.desktop, "mission_negative_one"),
        event("desktop", "offline_label_visible", refs.desktop, "mission_negative_two"),
      ]);
      const { result } = runManifest(tempDir, refs, completeEvents(refs), [
        `--negative-control-events=${negative}`,
        "--negative-control-mission-id=mission_negative_one",
        "--require-ready",
      ]);

      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { blockers?: Array<{ code?: string }> };
      expect(output.blockers?.map((blocker) => blocker.code)).toContain("negative_control_mission_id_mismatch");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("blocks and does not write a manifest when required observations are missing", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-observations-missing-"));
    try {
      const refs = writeEvidence(tempDir);
      const rows = completeEvents(refs).filter((row) => (row as { event?: string }).event !== "proof_receipt_visible_before_done");
      const { result, out } = runManifest(tempDir, refs, rows, ["--require-ready"]);

      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { status?: string; blockers?: Array<{ code?: string; detail?: string }> };
      expect(output.status).toBe("blocked");
      expect(output.blockers).toContainEqual({ code: "missing_observation", detail: "mobile:proof_receipt_visible_before_done" });
      expect(() => readFileSync(out, "utf8")).toThrow();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("blocks unknown evidence references and mission mismatches", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-observations-badref-"));
    try {
      const refs = writeEvidence(tempDir);
      const rows = completeEvents(refs);
      rows.push(event("desktop", "real_provider_execution_visible", join(tempDir, "outside.log")));
      rows.push(event("desktop", "reconnect_stale_verified", refs.desktop, "mission_other_run"));
      const { result } = runManifest(tempDir, refs, rows, ["--require-ready"]);

      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { blockers?: Array<{ code?: string }> };
      const codes = output.blockers?.map((blocker) => blocker.code);
      expect(codes).toContain("event_evidence_ref_unknown");
      expect(codes).toContain("event_mission_mismatch");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("requires the same stress floor as the strict proof preflight", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-observations-stress-"));
    try {
      const refs = writeEvidence(tempDir);
      const rows = completeEvents(refs).filter((row) => (row as { event?: string }).event !== "pressure_20_50_consecutive_asks_visible");
      rows.push(event("desktop", "pressure_20_50_consecutive_asks_visible", refs.desktop));
      const { result } = runManifest(tempDir, refs, rows, ["--require-ready"]);

      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { blockers?: Array<{ code?: string; detail?: string }> };
      expect(output.blockers).toContainEqual({ code: "stress_ask_count_out_of_range", detail: "1" });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
