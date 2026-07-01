import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/friday-channel-live-artifact-ingest.mjs";
const currentHead = "test-current-head";

function writeRaw(path: string) {
  writeFileSync(path, JSON.stringify({
    proof: "telegram_inbound_through_rust_channels_pipeline",
    sender_id: 123,
    sender_id_present: true,
    sender_allowlisted: true,
    bearer_auth_accepted_correct: true,
    forged_bearer_rejected: true,
    non_allowlisted_sender_rejected: true,
    bot_identity_verified: true,
    channel_binding_created: true,
    pii_kinds_redacted: [],
    raw_text_chars: 24,
    redacted_text: "[redacted]",
  }, null, 2));
}

function writeWrapper(path: string, overrides: Record<string, unknown> = {}) {
  writeFileSync(path, JSON.stringify({
    proof: "mission_spine_channel_live_proof",
    head: currentHead,
    generated_at_utc: "2026-06-26T17:35:00Z",
    status: "passed",
    capture_mode: "--live",
    scope: "real Telegram/channel inbound proof through Rust channel auth and redaction pipeline; not real UI/device consumption proof",
    telegram_live: {
      status: "passed",
      proof: "telegram_inbound_through_rust_channels_pipeline",
      bot_identity_verified: true,
      channel_binding_created: true,
      sender_id_present: true,
      sender_allowlisted: true,
      bearer_auth_accepted_correct: true,
      forged_bearer_rejected: true,
      non_allowlisted_sender_rejected: true,
      pii_kinds_redacted: [],
      raw_text_chars: 24,
    },
    secret_policy: {
      token_logged: false,
      token_written_to_artifact: false,
      provider_or_channel_id_written: false,
      raw_sender_id_written: false,
      artifact_contains_redacted_text_only: true,
    },
    remaining_requirement: "real mobile/desktop/channel UI/device consumption evidence must still pass scripts/mission-spine-ui-device-proof-gate.sh",
    ...overrides,
  }, null, 2));
}

describe("friday-channel-live-artifact-ingest", () => {
  it("validates a current compatible GitHub channel wrapper without reading secrets", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-channel-artifact-ingest-"));
    try {
      const artifact = join(root, "telegram-live-proof-current");
      const wrapper = join(artifact, "mission_spine_channel_live_proof.json");
      const raw = join(artifact, "telegram_live_proof.json");
      execFileSync("mkdir", ["-p", artifact]);
      writeWrapper(wrapper);
      writeRaw(raw);

      const stdout = execFileSync("node", [
        script,
        `--artifact-dir=${root}`,
        "--require-compatible",
      ], { cwd: process.cwd(), encoding: "utf8" });
      const result = JSON.parse(stdout) as { status?: string; notes?: string[]; channelLiveProof?: string };
      expect(result.status).toBe("wrapper_compatible");
      expect(result.channelLiveProof).toBe(wrapper);
      expect(result.notes).toContain("raw_sender_id_present_in_raw_artifact_not_wrapper");
      expect(JSON.stringify(result)).not.toContain("123");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks old raw-only artifacts instead of upgrading them to wrapper proof", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-channel-artifact-raw-only-"));
    try {
      const artifact = join(root, "telegram-live-proof-old");
      execFileSync("mkdir", ["-p", artifact]);
      writeRaw(join(artifact, "telegram_live_proof.json"));

      const result = spawnSync("node", [
        script,
        `--artifact-dir=${root}`,
        "--require-compatible",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { status?: string; blockers?: Array<{ code?: string }> };
      expect(output.status).toBe("blocked");
      expect(output.blockers?.map((blocker) => blocker.code)).toContain("channel_live_proof_missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when strict current-head validation sees a stale wrapper", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-channel-artifact-stale-head-"));
    try {
      const wrapper = join(root, "mission_spine_channel_live_proof.json");
      writeWrapper(wrapper, { head: "test-stale-head" });

      const result = spawnSync("node", [
        script,
        `--channel-live-proof=${wrapper}`,
        "--require-compatible",
        "--require-current-head",
        `--current-head=${currentHead}`,
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as {
        status?: string;
        currentHeadRequired?: boolean;
        wrapperHead?: string;
        blockers?: Array<{ code?: string }>;
      };
      expect(output.status).toBe("blocked");
      expect(output.currentHeadRequired).toBe(true);
      expect(output.wrapperHead).toBe("test-stale-head");
      expect(output.blockers?.map((blocker) => blocker.code)).toContain("wrapper_head_mismatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when identity binding or replay controls are absent", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-channel-artifact-blocked-"));
    try {
      const wrapper = join(root, "mission_spine_channel_live_proof.json");
      writeWrapper(wrapper, {
        telegram_live: {
          status: "passed",
          proof: "telegram_inbound_through_rust_channels_pipeline",
          sender_allowlisted: true,
          bearer_auth_accepted_correct: true,
        },
      });

      const result = spawnSync("node", [
        script,
        `--channel-live-proof=${wrapper}`,
        "--require-compatible",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { blockers?: Array<{ code?: string }> };
      expect(output.blockers?.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
        "telegram_bot_identity_not_verified",
        "telegram_channel_binding_missing",
        "telegram_forged_bearer_not_rejected",
        "telegram_non_allowlisted_not_rejected",
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
