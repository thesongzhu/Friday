// Phase 14.5E module_28e Slice 6.7 — per-channel env-truth readers.
// These tests verify the per-channel env tuple readers map each (env
// state) → (status) tuple correctly for Discord, Lark/Feishu, and
// Telegram, and that the aggregate externalChannels prerequisite is
// `ready` only when every declared v1 channel's env tuple is satisfied.

import { describe, expect, it } from "vitest";
import {
  readDiscordChannelsStatus,
  readLarkChannelsStatus,
  readTelegramChannelsStatus,
  collectEnvironmentTruth,
} from "../../../../validation/real-world/lib/env-truth.mjs";

describe("readDiscordChannelsStatus", () => {
  it("returns not_configured when no env is set", () => {
    const status = readDiscordChannelsStatus({});
    expect(status.status).toBe("not_configured");
    expect(status.missingEnv.length).toBe(status.requiredEnv.length);
  });

  it("returns blocked_by_env when only some env vars are set", () => {
    const status = readDiscordChannelsStatus({
      FRIDAY_DISCORD_BOT_TOKEN: "x",
    });
    expect(status.status).toBe("blocked_by_env");
    expect(status.missingEnv).toEqual([
      "FRIDAY_DISCORD_SETUP_USER_ID",
      "FRIDAY_DISCORD_GUILD_ID",
      "FRIDAY_DISCORD_CHANNEL_ID",
    ]);
  });

  it("returns configured when every env var is set", () => {
    const status = readDiscordChannelsStatus({
      FRIDAY_DISCORD_BOT_TOKEN: "t",
      FRIDAY_DISCORD_SETUP_USER_ID: "u",
      FRIDAY_DISCORD_GUILD_ID: "g",
      FRIDAY_DISCORD_CHANNEL_ID: "c",
    });
    expect(status.status).toBe("configured");
    expect(status.missingEnv).toEqual([]);
  });
});

describe("readLarkChannelsStatus", () => {
  it("returns not_configured when no env is set", () => {
    const status = readLarkChannelsStatus({});
    expect(status.status).toBe("not_configured");
    expect(status.requiredEnv).toEqual([
      "FRIDAY_LARK_APP_ID",
      "FRIDAY_LARK_APP_SECRET",
      "FRIDAY_LARK_VERIFICATION_TOKEN",
      "FRIDAY_LARK_ENCRYPT_KEY",
      "FRIDAY_LARK_TEST_CHAT_ID",
    ]);
  });

  it("returns blocked_by_env when env is partially complete", () => {
    const status = readLarkChannelsStatus({
      FRIDAY_LARK_APP_ID: "a",
      FRIDAY_LARK_APP_SECRET: "s",
    });
    expect(status.status).toBe("blocked_by_env");
  });

  it("returns configured when every env var is set", () => {
    const status = readLarkChannelsStatus({
      FRIDAY_LARK_APP_ID: "a",
      FRIDAY_LARK_APP_SECRET: "s",
      FRIDAY_LARK_VERIFICATION_TOKEN: "v",
      FRIDAY_LARK_ENCRYPT_KEY: "k",
      FRIDAY_LARK_TEST_CHAT_ID: "c",
    });
    expect(status.status).toBe("configured");
  });
});

describe("readTelegramChannelsStatus", () => {
  it("returns not_configured when no env is set", () => {
    const status = readTelegramChannelsStatus({});
    expect(status.status).toBe("not_configured");
    expect(status.requiredEnv).toEqual([
      "FRIDAY_TELEGRAM_BOT_TOKEN",
      "FRIDAY_TELEGRAM_TEST_CHAT_ID",
    ]);
  });

  it("returns configured when every env var is set", () => {
    const status = readTelegramChannelsStatus({
      FRIDAY_TELEGRAM_BOT_TOKEN: "t",
      FRIDAY_TELEGRAM_TEST_CHAT_ID: "c",
    });
    expect(status.status).toBe("configured");
  });
});

describe("collectEnvironmentTruth (externalChannels aggregate)", () => {
  // Lightweight stub of the FridayClient interface required by
  // collectEnvironmentTruth — every HTTP request fails fast so the
  // aggregate falls back to the env-truth prerequisite shape.
  function stubClient() {
    return {
      authMode: "anonymous",
      authSource: null,
      authDetails: null,
      user: null,
      async initialize() {
        throw new Error("anonymous-client");
      },
      async request() {
        return { ok: false, status: 0, json: null };
      },
    };
  }

  async function collectWith(processEnv) {
    return collectEnvironmentTruth({
      client: stubClient(),
      baseUrl: "http://localhost:0",
      uiBaseUrl: "http://localhost:0",
      processEnv,
    });
  }

  it("returns externalChannels ready=missing when the master flag is unset", async () => {
    const truth = await collectWith({});
    expect(truth.prerequisites.externalChannels.status).toBe("unknown");
  });

  it("returns externalChannels missing when the master flag is set but Lark env is incomplete", async () => {
    const truth = await collectWith({
      FRIDAY_REAL_WORLD_EXTERNAL_CHANNELS_READY: "true",
      FRIDAY_DISCORD_BOT_TOKEN: "t",
      FRIDAY_DISCORD_SETUP_USER_ID: "u",
      FRIDAY_DISCORD_GUILD_ID: "g",
      FRIDAY_DISCORD_CHANNEL_ID: "c",
      FRIDAY_TELEGRAM_BOT_TOKEN: "t",
      FRIDAY_TELEGRAM_TEST_CHAT_ID: "c",
      // Lark intentionally missing
    });
    expect(truth.prerequisites.externalChannels.status).toBe("missing");
    expect(truth.prerequisites.externalChannels.missingEnv?.length ?? 0).toBeGreaterThan(0);
  });

  it("returns externalChannels ready when every v1 channel env tuple is satisfied", async () => {
    const truth = await collectWith({
      FRIDAY_REAL_WORLD_EXTERNAL_CHANNELS_READY: "true",
      FRIDAY_DISCORD_BOT_TOKEN: "t",
      FRIDAY_DISCORD_SETUP_USER_ID: "u",
      FRIDAY_DISCORD_GUILD_ID: "g",
      FRIDAY_DISCORD_CHANNEL_ID: "c",
      FRIDAY_LARK_APP_ID: "a",
      FRIDAY_LARK_APP_SECRET: "s",
      FRIDAY_LARK_VERIFICATION_TOKEN: "v",
      FRIDAY_LARK_ENCRYPT_KEY: "k",
      FRIDAY_LARK_TEST_CHAT_ID: "c",
      FRIDAY_TELEGRAM_BOT_TOKEN: "t",
      FRIDAY_TELEGRAM_TEST_CHAT_ID: "c",
    });
    expect(truth.prerequisites.externalChannels.status).toBe("ready");
    expect(truth.prerequisites.externalChannels.perChannel).toBeDefined();
  });
});
