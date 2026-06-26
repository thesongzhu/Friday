import { execFileSync as execFile, spawnSync as spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/friday-ui-device-live-write-read-capture-bundle.sh";
const sharedId = "mission-ui-device-live-write-read-test";
const canonicalMissionId = `mission_${sharedId}`;
const exactMissionId = "codex-organic-mission-contract";
const workItemId = "work-ui-device-live-write-read-test";

function fakeSwiftScript(
  dir: string,
  expectedSharedId = sharedId,
  expectedMissionId = "",
  emittedMissionId = canonicalMissionId,
) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const path = join(bin, "swift");
  writeFileSync(path, `#!/usr/bin/env bash
set -euo pipefail
[ "$1" = "test" ] || exit 42
if [ -n "${expectedSharedId}" ] && [ "\${FRIDAY_MISSION_SPINE_UI_PROOF_SHARED_ID:-}" != "${expectedSharedId}" ]; then exit 44; fi
if [ -n "${expectedMissionId}" ] && [ "\${FRIDAY_MISSION_SPINE_UI_PROOF_MISSION_ID:-}" != "${expectedMissionId}" ]; then exit 45; fi
if [ -n "\${FRIDAY_MOBILE_LIVE_WRITE_READ_ROUNDTRIP_PROOF_OUT:-}" ]; then
  surface_kind="mobile"
  truth_label="ios_mobile_live_write_read_roundtrip_proof_not_ui_device_proof"
  route="ios://friday-mobile/live-write-read-roundtrip/wrapper"
  proof_out="\${FRIDAY_MOBILE_LIVE_WRITE_READ_ROUNDTRIP_PROOF_OUT}"
else
  [ -n "\${FRIDAY_DESKTOP_LIVE_WRITE_READ_ROUNDTRIP_PROOF_OUT:-}" ] || exit 43
  surface_kind="desktop"
  truth_label="macos_desktop_live_write_read_roundtrip_proof_not_ui_device_proof"
  route="desktop://hub-console/live-write-read-roundtrip/wrapper"
  proof_out="\${FRIDAY_DESKTOP_LIVE_WRITE_READ_ROUNDTRIP_PROOF_OUT}"
fi
cat >"\${proof_out}" <<JSON
{
  "truth_label": "\${truth_label}",
  "status": "pass",
  "generated_at_utc": "2026-06-24T12:00:00Z",
  "mission_id": "${emittedMissionId}",
  "work_item_id": "${workItemId}",
  "surface_kind": "\${surface_kind}",
  "delivery_route": "\${route}",
  "write": {
    "status": "ready",
    "created_or_ready": true,
    "mission_id": "${emittedMissionId}",
    "work_item_id": "${workItemId}",
    "endpoint": { "host": "127.0.0.1", "port": 48750 }
  },
  "read_projection": {
    "mission_id": "${emittedMissionId}",
    "work_item_ids": ["${workItemId}"],
    "contains_written_work_item": true,
    "generated_at_ms": 1782290000000,
    "endpoint": { "host": "127.0.0.1", "port": 48751 }
  },
  "caveat": "Live write-read artifact only; not END-BAR, not GO-LIVE, not UI/device proof."
}
JSON
`, { mode: 0o755 });
  return bin;
}

function event(surface: string, name: string, evidenceRef: string) {
  return { surface, event: name, mission_id: canonicalMissionId, evidence_ref: evidenceRef };
}

function writeCompleteSameRunEvents(path: string, refs: { mobile: string; desktop: string; channel: string; timeline: string }) {
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
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function writeDesignActionContract(path: string) {
  writeFileSync(path, `# Friday Action Contract — test

Every row is design-proof; wired_registry ≠ runtime PASS.

| Surface | Screen [state] | action_id | Label | capability_id | reg | reg_status | truth_status | result/target | Rust/Hub owner · gate · test expectation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mobile | fridayChat [typing] | chat:typing | Ask | ask_friday_chat | ✓ | wired | design_proof | — | Runtime test must prove action. |
| desktop | fridayChat | caprow | Ask row | ask_friday_chat_compose_send | ✓ | wired | design_proof | — | Capability row only. |
`);
}

describe("friday-ui-device-live-write-read-capture-bundle", () => {
  it("runs mobile and desktop captures with the same mission id, then writes a partial bundle", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-device-orchestrator-"));
    try {
      const outDir = join(tempDir, "capture");
      const contract = join(tempDir, "ACTION-CONTRACT.md");
      const extraActionRuntime = join(tempDir, "extra-action-runtime-evidence.json");
      const fakeBin = fakeSwiftScript(tempDir);
      writeDesignActionContract(contract);
      writeFileSync(extraActionRuntime, JSON.stringify({
        actions: [{
          surface: "mobile",
          screen: "fridayChat",
          action_id: "chat:typing",
          status: "pass",
          evidence_ref: "proof://mobile/chat-typing",
        }],
      }, null, 2));

      const stdout = execFile("bash", [
        script,
        `--out-dir=${outDir}`,
        `--shared-id=${sharedId}`,
        "--read-port=59151",
        `--design-action-contract=${contract}`,
        `--extra-action-runtime-evidence=${extraActionRuntime}`,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      });

      expect(stdout).toContain("PASS - same-mission mobile+desktop live write-read capture bundle written");
      expect(stdout).toContain(`design_action_runtime=${join(outDir, "bundle", "design-action-runtime-gap.json")}`);
      const index = JSON.parse(readFileSync(join(outDir, "bundle", "live-write-read-bundle-index.json"), "utf8")) as {
        status?: string;
        missionId?: string;
        captures?: Record<string, { event_count?: number }>;
        fullProofGaps?: string[];
      };
      expect(index.status).toBe("partial_bundle_ready");
      expect(index.missionId).toBe(canonicalMissionId);
      expect(index.captures?.mobile?.event_count).toBe(5);
      expect(index.captures?.desktop?.event_count).toBe(5);
      expect(index.fullProofGaps).toContain("bounded_timeline_capture");
      const combinedEvents = readFileSync(join(outDir, "bundle", "mobile-desktop-live-write-read-events.jsonl"), "utf8")
        .trim()
        .split(/\n/)
        .map((line) => JSON.parse(line) as { surface?: string; evidence_ref?: string });
      expect(combinedEvents).toContainEqual(expect.objectContaining({
        surface: "mobile",
        evidence_ref: join(outDir, "bundle", "mobile", "ios-live-write-read-proof.json"),
      }));
      expect(combinedEvents).toContainEqual(expect.objectContaining({
        surface: "desktop",
        evidence_ref: join(outDir, "bundle", "desktop", "macos-live-write-read-proof.json"),
      }));
      const designReport = JSON.parse(readFileSync(join(outDir, "bundle", "design-action-runtime-gap.json"), "utf8")) as {
        runtimeEvidenceInputs?: string[];
        counts?: { uniqueActionableRows?: number; missingUniqueRuntimeEvidence?: number };
      };
      expect(designReport.counts?.uniqueActionableRows).toBe(1);
      expect(designReport.counts?.missingUniqueRuntimeEvidence).toBe(0);
      expect(designReport.runtimeEvidenceInputs).toContain(extraActionRuntime);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("delegates to the capture-dir preflight when real channel and timeline inputs are supplied", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-device-orchestrator-full-"));
    try {
      const outDir = join(tempDir, "capture");
      const channel = join(tempDir, "channel.log");
      const timeline = join(tempDir, "timeline.trace");
      const events = join(tempDir, "same-run-events.jsonl");
      const fakeBin = fakeSwiftScript(tempDir);
      writeFileSync(channel, "real channel capture\n");
      writeFileSync(timeline, "real timeline capture\n");
      writeCompleteSameRunEvents(events, {
        mobile: join(outDir, "mobile", "ios-live-write-read-proof.json"),
        desktop: join(outDir, "desktop", "macos-live-write-read-proof.json"),
        channel,
        timeline,
      });

      const stdout = execFile("bash", [
        script,
        `--out-dir=${outDir}`,
        `--shared-id=${sharedId}`,
        `--channel-capture=${channel}`,
        `--timeline-capture=${timeline}`,
        `--same-run-events=${events}`,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      });

      expect(stdout).toContain("evidence=");
      const captureIndex = JSON.parse(readFileSync(join(outDir, "evidence", "capture-index.json"), "utf8")) as {
        status?: string;
        observationsManifest?: string;
      };
      expect(captureIndex.status).toBe("ready_for_preflight");
      expect(captureIndex.observationsManifest).toContain("observations-manifest.json");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("binds mobile and desktop captures to an exact existing mission id", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-device-orchestrator-exact-mission-"));
    try {
      const outDir = join(tempDir, "capture");
      const fakeBin = fakeSwiftScript(tempDir, "", exactMissionId, exactMissionId);

      const stdout = execFile("bash", [
        script,
        `--out-dir=${outDir}`,
        `--mission-id=${exactMissionId}`,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      });

      expect(stdout).toContain("PASS - same-mission mobile+desktop live write-read capture bundle written");
      const index = JSON.parse(readFileSync(join(outDir, "bundle", "live-write-read-bundle-index.json"), "utf8")) as {
        missionId?: string;
      };
      expect(index.missionId).toBe(exactMissionId);
      const mobileProof = JSON.parse(readFileSync(join(outDir, "mobile", "ios-live-write-read-proof.json"), "utf8")) as {
        mission_id?: string;
      };
      const desktopProof = JSON.parse(readFileSync(join(outDir, "desktop", "macos-live-write-read-proof.json"), "utf8")) as {
        mission_id?: string;
      };
      expect(mobileProof.mission_id).toBe(exactMissionId);
      expect(desktopProof.mission_id).toBe(exactMissionId);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects relative output directories and malformed shared ids before running captures", () => {
    const relative = spawn("bash", [script, "--out-dir=relative"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(relative.status).toBe(2);
    expect(relative.stderr).toContain("--out-dir must be absolute");

    const malformed = spawn("bash", [script, `--out-dir=${tmpdir()}`, "--shared-id=not-a-valid-id"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(malformed.status).toBe(2);
    expect(malformed.stderr).toContain("--shared-id must contain mission");

    const ambiguous = spawn("bash", [
      script,
      `--out-dir=${tmpdir()}`,
      `--shared-id=${sharedId}`,
      `--mission-id=${exactMissionId}`,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(ambiguous.status).toBe(2);
    expect(ambiguous.stderr).toContain("--mission-id and --shared-id are mutually exclusive");
  });
});
