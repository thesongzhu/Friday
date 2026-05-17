// Phase 14.5E module_28e Slice 6.2 — `GET /v1/setup/channels/status`
// payload composition. These tests verify the per-channel rows surface
// honest proof labels under (a) no env, (b) Discord-only env, and
// (c) all-three env. No real channel adapter is constructed; the
// registry views are plain objects.

import { describe, expect, it } from "vitest";

import {
  buildFridayChannelSetupStatus,
  FRIDAY_CHANNEL_V1_SETUP_DESCRIPTORS,
  type FridayChannelRegistryView,
} from "#channels";

function discordView(overrides: Partial<FridayChannelRegistryView> = {}): FridayChannelRegistryView {
  return {
    kind: "discord",
    running: false,
    status: "disconnected",
    health: {
      state: "disconnected",
      restartCount: 0,
      credentialStatus: "unknown",
      proofLabel: "not_configured",
    },
    allowlist: {
      hasAllowedUsers: false,
      allowedUsersCount: 0,
      hasAllowedChats: false,
      allowedChatsCount: 0,
    },
    ...overrides,
  };
}

describe("buildFridayChannelSetupStatus", () => {
  it("returns one row per v1 channel even when no env or registry is provided", () => {
    const status = buildFridayChannelSetupStatus({ processEnv: {} });
    expect(status.channels.map((row) => row.kind)).toEqual([
      "discord",
      "lark",
      "telegram",
    ]);
    for (const row of status.channels) {
      expect(row.proofLabel).toBe("not_configured");
    }
  });

  it("labels Discord as configured when its env tuple is complete and registry is healthy", () => {
    const env: NodeJS.ProcessEnv = {
      FRIDAY_DISCORD_BOT_TOKEN: "t",
      FRIDAY_DISCORD_SETUP_USER_ID: "u",
      FRIDAY_DISCORD_GUILD_ID: "g",
      FRIDAY_DISCORD_CHANNEL_ID: "c",
    };
    const status = buildFridayChannelSetupStatus({
      views: [discordView({ health: { ...discordView().health, credentialStatus: "configured", proofLabel: "configured" } })],
      processEnv: env,
    });
    const discord = status.channels.find((row) => row.kind === "discord");
    expect(discord?.proofLabel).toBe("configured");
    expect(discord?.missingEnvVars).toEqual([]);
  });

  it("does not let Discord credentials satisfy Lark or Telegram", () => {
    const env: NodeJS.ProcessEnv = {
      FRIDAY_DISCORD_BOT_TOKEN: "t",
      FRIDAY_DISCORD_SETUP_USER_ID: "u",
      FRIDAY_DISCORD_GUILD_ID: "g",
      FRIDAY_DISCORD_CHANNEL_ID: "c",
    };
    const status = buildFridayChannelSetupStatus({
      views: [discordView({ health: { ...discordView().health, credentialStatus: "configured", proofLabel: "configured" } })],
      processEnv: env,
    });
    const lark = status.channels.find((row) => row.kind === "lark");
    const telegram = status.channels.find((row) => row.kind === "telegram");
    expect(lark?.proofLabel).toBe("not_configured");
    expect(lark?.missingEnvVars.length).toBeGreaterThan(0);
    expect(telegram?.proofLabel).toBe("not_configured");
    expect(telegram?.missingEnvVars.length).toBeGreaterThan(0);
  });

  it("labels Lark as blocked_by_env when its env tuple is partially present", () => {
    const env: NodeJS.ProcessEnv = {
      FRIDAY_LARK_APP_ID: "a",
      FRIDAY_LARK_APP_SECRET: "s",
      // FRIDAY_LARK_VERIFICATION_TOKEN, FRIDAY_LARK_ENCRYPT_KEY, FRIDAY_LARK_TEST_CHAT_ID missing
    };
    const status = buildFridayChannelSetupStatus({ processEnv: env });
    const lark = status.channels.find((row) => row.kind === "lark");
    expect(lark?.proofLabel).toBe("blocked_by_env");
    expect(lark?.missingEnvVars).toEqual([
      "FRIDAY_LARK_VERIFICATION_TOKEN",
      "FRIDAY_LARK_ENCRYPT_KEY",
      "FRIDAY_LARK_TEST_CHAT_ID",
    ]);
  });

  it("labels Telegram as configured when env tuple is complete", () => {
    const env: NodeJS.ProcessEnv = {
      FRIDAY_TELEGRAM_BOT_TOKEN: "t",
      FRIDAY_TELEGRAM_TEST_CHAT_ID: "c",
    };
    const status = buildFridayChannelSetupStatus({ processEnv: env });
    const telegram = status.channels.find((row) => row.kind === "telegram");
    expect(telegram?.proofLabel).toBe("configured");
  });

  it("classifies non-v1 channels in registry views as unsupported", () => {
    const slackView: FridayChannelRegistryView = {
      ...discordView(),
      kind: "slack",
    };
    const status = buildFridayChannelSetupStatus({
      views: [slackView],
      processEnv: {},
    });
    const slack = status.channels.find((row) => row.kind === "slack");
    expect(slack?.proofLabel).toBe("unsupported");
  });

  it("treats a Feishu registry view as the Lark/Feishu v1 row, not as an extra unsupported row", () => {
    // The Lark plugin rewrites its own `kind` to "feishu" at runtime when
    // `useFeishu: true` is configured. The setup status surface must not
    // emit a second `unsupported` row for that case — the v1 row carries
    // both kinds.
    const feishuView: FridayChannelRegistryView = {
      ...discordView(),
      kind: "feishu",
      running: true,
      status: "connected",
      health: {
        state: "connected",
        restartCount: 0,
        credentialStatus: "configured",
        proofLabel: "configured",
      },
    };
    const env: NodeJS.ProcessEnv = {
      FRIDAY_LARK_APP_ID: "a",
      FRIDAY_LARK_APP_SECRET: "s",
      FRIDAY_LARK_VERIFICATION_TOKEN: "v",
      FRIDAY_LARK_ENCRYPT_KEY: "k",
      FRIDAY_LARK_TEST_CHAT_ID: "c",
    };
    const status = buildFridayChannelSetupStatus({
      views: [feishuView],
      processEnv: env,
    });
    // The v1 row order is stable: discord, lark, telegram; no extra
    // unsupported row appears for the Feishu view.
    expect(status.channels.map((row) => row.kind)).toEqual([
      "discord",
      "lark",
      "telegram",
    ]);
    const lark = status.channels.find((row) => row.kind === "lark");
    expect(lark?.proofLabel).toBe("configured");
    expect(lark?.credentialStatus).toBe("configured");
    expect(lark?.missingEnvVars).toEqual([]);
  });

  it("uses the Lark registry view when present and the Feishu view when only Feishu is registered", () => {
    // When the lark-kind view is present, it backs the v1 row.
    const larkView: FridayChannelRegistryView = {
      ...discordView(),
      kind: "lark",
      health: {
        state: "disconnected",
        restartCount: 0,
        credentialStatus: "invalid",
        blockedReason: "lark_auth_failed",
        proofLabel: "blocked_by_env",
      },
    };
    const statusWithLark = buildFridayChannelSetupStatus({
      views: [larkView],
      processEnv: {},
    });
    const larkRow = statusWithLark.channels.find((row) => row.kind === "lark");
    expect(larkRow?.proofLabel).toBe("blocked_by_env");
    expect(larkRow?.blockedReason).toBe("lark_auth_failed");

    // When only the feishu-kind view is present, the same v1 row picks
    // it up — there is no parallel unsupported row.
    const feishuOnly: FridayChannelRegistryView = {
      ...discordView(),
      kind: "feishu",
      health: {
        state: "disconnected",
        restartCount: 0,
        credentialStatus: "invalid",
        blockedReason: "feishu_auth_failed",
        proofLabel: "blocked_by_env",
      },
    };
    const statusWithFeishu = buildFridayChannelSetupStatus({
      views: [feishuOnly],
      processEnv: {},
    });
    const feishuRow = statusWithFeishu.channels.find((row) => row.kind === "lark");
    expect(feishuRow?.proofLabel).toBe("blocked_by_env");
    expect(feishuRow?.blockedReason).toBe("feishu_auth_failed");
    expect(
      statusWithFeishu.channels.some((row) => row.kind === "feishu"),
    ).toBe(false);
  });

  it("exposes a stable required env list per v1 channel", () => {
    const requiredVars = new Map(
      FRIDAY_CHANNEL_V1_SETUP_DESCRIPTORS.map((descriptor) => [descriptor.kind, descriptor.requiredEnvVars]),
    );
    expect(requiredVars.get("discord")).toContain("FRIDAY_DISCORD_BOT_TOKEN");
    expect(requiredVars.get("lark")).toContain("FRIDAY_LARK_APP_ID");
    expect(requiredVars.get("telegram")).toContain("FRIDAY_TELEGRAM_BOT_TOKEN");
  });
});
