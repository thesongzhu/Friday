// Phase 14.5E module_28e Slice 6.2/6.8 — route handler test for
// `GET /v1/setup/channels/status`. The route handler is invoked through
// a lightweight in-memory wrapper so the test does not need to boot the
// full HTTP server or open a SQLite file.

import { describe, expect, it } from "vitest";

import {
  buildFridayChannelSetupStatus,
  type FridayChannelRegistryView,
  type FridayChannelSetupStatusResponse,
} from "#channels";

// The setup status route is a thin pass-through to
// buildFridayChannelSetupStatus. We test the projection here so the
// route + helper contract is anchored.

describe("GET /v1/setup/channels/status — projection", () => {
  it("renders all v1 channels regardless of registry contents", () => {
    const response: FridayChannelSetupStatusResponse = buildFridayChannelSetupStatus({
      views: [],
      processEnv: {},
    });
    expect(response.channels.map((row) => row.kind)).toEqual([
      "discord",
      "lark",
      "telegram",
    ]);
  });

  it("renders honest blocked_by_env for partially-set env", () => {
    const response = buildFridayChannelSetupStatus({
      processEnv: {
        FRIDAY_DISCORD_BOT_TOKEN: "x",
      },
    });
    const discord = response.channels.find((row) => row.kind === "discord");
    expect(discord?.proofLabel).toBe("blocked_by_env");
  });

  it("renders configured when every env tuple is satisfied", () => {
    const response = buildFridayChannelSetupStatus({
      processEnv: {
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
      },
    });
    for (const row of response.channels) {
      expect(row.proofLabel).toBe("configured");
    }
  });

  it("preserves registry blockedReason as user-facing blockedReason", () => {
    const view: FridayChannelRegistryView = {
      kind: "discord",
      running: false,
      status: "error",
      health: {
        state: "error",
        restartCount: 1,
        blockedReason: "start_failed",
        credentialStatus: "invalid",
        proofLabel: "blocked_by_env",
      },
      allowlist: {
        hasAllowedUsers: false,
        allowedUsersCount: 0,
        hasAllowedChats: false,
        allowedChatsCount: 0,
      },
    };
    const response = buildFridayChannelSetupStatus({
      views: [view],
      processEnv: {
        FRIDAY_DISCORD_BOT_TOKEN: "t",
        FRIDAY_DISCORD_SETUP_USER_ID: "u",
        FRIDAY_DISCORD_GUILD_ID: "g",
        FRIDAY_DISCORD_CHANNEL_ID: "c",
      },
    });
    const discord = response.channels.find((row) => row.kind === "discord");
    expect(discord?.blockedReason).toBe("start_failed");
    expect(discord?.proofLabel).toBe("blocked_by_env");
  });
});
