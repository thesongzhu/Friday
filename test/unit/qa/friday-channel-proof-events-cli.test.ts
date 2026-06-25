import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/friday-channel-proof-events.mjs";
const missionId = "mission_cli_channel_proof_events";

function writeChannelProof(path: string, overrides: Record<string, unknown> = {}) {
  writeFileSync(path, JSON.stringify({
    proof: "mission_spine_channel_live_proof",
    generated_at_utc: "2026-06-24T23:59:00.000Z",
    status: "passed",
    scope: "real Telegram/channel inbound proof through Rust channel auth and redaction pipeline; not real UI/device consumption proof",
    telegram_live: {
      status: "passed",
      proof: "telegram_inbound_through_rust_channels_pipeline",
      bot_identity_verified: true,
      channel_binding_created: true,
      sender_allowlisted: true,
      forged_bearer_rejected: true,
      non_allowlisted_sender_rejected: true,
    },
    secret_policy: {
      artifact_contains_redacted_text_only: true,
    },
    remaining_requirement: "real mobile/desktop/channel UI/device consumption evidence must still pass scripts/mission-spine-ui-device-proof-gate.sh",
    ...overrides,
  }, null, 2));
}

describe("friday-channel-proof-events", () => {
  it("emits only the conservative channel same-mission projection event", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-channel-proof-events-"));
    try {
      const proof = join(tempDir, "channel-live-proof.json");
      const channelCapture = join(tempDir, "channel-capture.json");
      const out = join(tempDir, "channel-events.jsonl");
      writeChannelProof(proof);
      writeFileSync(channelCapture, JSON.stringify({ truth: "redacted_channel_capture" }));

      const stdout = execFileSync("node", [
        script,
        `--mission-id=${missionId}`,
        `--channel-live-proof=${proof}`,
        `--channel-capture=${channelCapture}`,
        `--out=${out}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });

      const result = JSON.parse(stdout) as {
        truth?: string;
        status?: string;
        outputRows?: number;
        emittedEvents?: string[];
        caveat?: string;
      };
      const rows = readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line));

      expect(result.truth).toBe("channel_proof_events_not_ui_device_proof");
      expect(result.status).toBe("ready");
      expect(result.outputRows).toBe(1);
      expect(result.emittedEvents).toEqual(["channel:same_mission_projection_visible"]);
      expect(result.caveat).toContain("does not claim replay proof");
      expect(rows).toEqual([{
        surface: "channel",
        event: "same_mission_projection_visible",
        mission_id: missionId,
        evidence_ref: channelCapture,
        truth_label: "derived_from_redacted_channel_live_proof_not_final_ui_device_proof",
        source: "mission_spine_channel_live_proof",
        captured_at: "2026-06-24T23:59:00.000Z",
      }]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed when the channel proof wrapper is not passed or redacted", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-channel-proof-events-blocked-"));
    try {
      const proof = join(tempDir, "channel-live-proof.json");
      const channelCapture = join(tempDir, "channel-capture.json");
      const out = join(tempDir, "channel-events.jsonl");
      writeChannelProof(proof, {
        status: "blocked",
        secret_policy: { artifact_contains_redacted_text_only: false },
      });
      writeFileSync(channelCapture, JSON.stringify({ truth: "redacted_channel_capture" }));

      const result = spawnSync("node", [
        script,
        `--mission-id=${missionId}`,
        `--channel-live-proof=${proof}`,
        `--channel-capture=${channelCapture}`,
        `--out=${out}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });

      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { status?: string; blockers?: Array<{ code?: string }> };
      expect(output.status).toBe("blocked");
      expect(output.blockers?.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
        "channel_live_proof_not_passed",
        "channel_live_proof_secret_policy_not_redacted",
      ]));
      expect(() => readFileSync(out, "utf8")).toThrow();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
