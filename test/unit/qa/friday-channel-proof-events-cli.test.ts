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

function writePhase24DiscordProof(path: string, overrides: Record<string, unknown> = {}) {
  writeFileSync(path, JSON.stringify({
    schemaVersion: "friday.phase24b.discord_trusted_inbound_proof.v1",
    phase: "phase24b",
    scope: "Discord live trusted user inbound proof",
    status: "passed",
    startedAt: "2026-06-30T11:20:00.000Z",
    completedAt: "2026-06-30T11:21:00.000Z",
    reportPath: "/tmp/phase24b-discord-trusted-inbound-proof.json",
    environment: {
      commit_sha: "095811ada740d342e181f91ac38b5d8fac2ee768", // pragma: allowlist secret
    },
    criteria: {
      artifactHasNoToken: true,
      channelBoundaryConsumable: true,
      channelBoundaryNoLiveClaim: true,
      fullEvidenceSurfaceExported: true,
    },
    diagnostics: {},
    evidenceSurface: {
      runEndpoint: "/v1/agent/runs/example",
      auditEndpoint: "/v1/agent/runs/example/audit",
    },
    observedDiscordEvent: {
      type: "MESSAGE_CREATE",
      authorBotFalse: true,
      senderMatched: true,
      channelMatched: true,
      nonceMatched: true,
    },
    failures: [],
    ...overrides,
  }, null, 2));
}

describe("friday-channel-proof-events", () => {
  it("emits conservative channel projection and replay-blocked events from a passed wrapper", () => {
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
      expect(result.outputRows).toBe(2);
      expect(result.emittedEvents).toEqual([
        "channel:same_mission_projection_visible",
        "channel:channel_replay_blocked_visible",
      ]);
      expect(result.caveat).toContain("Replay-blocked visibility is emitted only");
      expect(rows).toEqual([
        {
          surface: "channel",
          event: "same_mission_projection_visible",
          mission_id: missionId,
          evidence_ref: channelCapture,
          truth_label: "derived_from_redacted_channel_live_proof_not_final_ui_device_proof",
          source: "mission_spine_channel_live_proof",
          captured_at: "2026-06-24T23:59:00.000Z",
        },
        {
          surface: "channel",
          event: "channel_replay_blocked_visible",
          mission_id: missionId,
          evidence_ref: channelCapture,
          truth_label: "derived_from_redacted_channel_live_proof_negative_controls_not_final_ui_device_proof",
          source: "mission_spine_channel_live_proof",
          captured_at: "2026-06-24T23:59:00.000Z",
        },
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("emits only channel projection for a passed Phase24 trusted-inbound artifact", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-channel-proof-events-phase24-"));
    try {
      const proof = join(tempDir, "phase24b-discord-trusted-inbound-proof.json");
      const channelCapture = join(tempDir, "channel-capture.json");
      const out = join(tempDir, "channel-events.jsonl");
      writePhase24DiscordProof(proof);
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
        status?: string;
        outputRows?: number;
        emittedEvents?: string[];
        caveat?: string;
      };
      const rows = readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line));

      expect(result.status).toBe("ready");
      expect(result.outputRows).toBe(1);
      expect(result.emittedEvents).toEqual(["channel:same_mission_projection_visible"]);
      expect(result.caveat).toContain("do not emit replay-blocked");
      expect(rows[0]).toMatchObject({
        surface: "channel",
        event: "same_mission_projection_visible",
        mission_id: missionId,
        evidence_ref: channelCapture,
        truth_label: "derived_from_phase24_trusted_inbound_channel_proof_not_final_ui_device_proof",
        source: "friday.phase24b.discord_trusted_inbound_proof.v1",
        captured_at: "2026-06-30T11:21:00.000Z",
      });
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

  it("fails closed when replay negative controls are absent", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-channel-proof-events-replay-"));
    try {
      const proof = join(tempDir, "channel-live-proof.json");
      const channelCapture = join(tempDir, "channel-capture.json");
      const out = join(tempDir, "channel-events.jsonl");
      writeChannelProof(proof, {
        telegram_live: {
          status: "passed",
          proof: "telegram_inbound_through_rust_channels_pipeline",
          bot_identity_verified: true,
          channel_binding_created: true,
          sender_allowlisted: true,
        },
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
      expect(output.blockers?.map((blocker) => blocker.code)).toContain("channel_live_proof_replay_controls_missing");
      expect(() => readFileSync(out, "utf8")).toThrow();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed when a Phase24 channel artifact is not passed", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-channel-proof-events-phase24-blocked-"));
    try {
      const proof = join(tempDir, "phase24b-discord-trusted-inbound-proof.json");
      const channelCapture = join(tempDir, "channel-capture.json");
      const out = join(tempDir, "channel-events.jsonl");
      writePhase24DiscordProof(proof, {
        status: "blocked",
        failures: ["No trusted user-origin message arrived"],
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
        "phase24_channel_status_not_passed",
        "phase24_channel_failures_present",
      ]));
      expect(() => readFileSync(out, "utf8")).toThrow();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
