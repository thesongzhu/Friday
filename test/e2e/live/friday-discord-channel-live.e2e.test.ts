import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFridayHttpServer, type FridayHttpServer } from "#api";
import { createFridayHub, type FridayHub } from "#hub";

const RUN_LIVE_DISCORD = process.env.FRIDAY_E2E_LIVE_DISCORD === "1";
const DISCORD_BOT_TOKEN = process.env.FRIDAY_DISCORD_BOT_TOKEN?.trim() ?? "";
const DISCORD_SETUP_USER_ID = process.env.FRIDAY_DISCORD_SETUP_USER_ID?.trim() ?? "";
const DISCORD_GUILD_ID = process.env.FRIDAY_DISCORD_GUILD_ID?.trim() ?? "";
const DISCORD_CHANNEL_ID = process.env.FRIDAY_DISCORD_CHANNEL_ID?.trim() ?? "";

function authHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("Could not determine free port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function discordRequest(
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; json?: unknown }> {
  const res = await fetch(`https://discord.com/api/v10${pathname}`, {
    method,
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { ok: res.ok, status: res.status, json };
}

async function discordGet(pathname: string): Promise<{ ok: boolean; status: number; json?: unknown }> {
  return discordRequest("GET", pathname);
}

async function discordDelete(pathname: string): Promise<{ ok: boolean; status: number; json?: unknown }> {
  return discordRequest("DELETE", pathname);
}

describe.skipIf(!RUN_LIVE_DISCORD || !DISCORD_SETUP_USER_ID || !DISCORD_GUILD_ID || !DISCORD_CHANNEL_ID)("Friday live Discord channel closure", () => {
  let stateDir = "";
  let hub: FridayHub | undefined;
  let restartedHub: FridayHub | undefined;
  let httpServer: FridayHttpServer | undefined;
  const sentChannelMessageIds: string[] = [];

  beforeAll(() => {
    expect(DISCORD_BOT_TOKEN.length).toBeGreaterThan(0);
    expect(DISCORD_SETUP_USER_ID.length).toBeGreaterThan(0);
    expect(DISCORD_GUILD_ID.length).toBeGreaterThan(0);
    expect(DISCORD_CHANNEL_ID.length).toBeGreaterThan(0);
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-discord-channel-live-"));
  });

  afterAll(async () => {
    for (const messageId of sentChannelMessageIds.reverse()) {
      await discordDelete(`/channels/${encodeURIComponent(DISCORD_CHANNEL_ID)}/messages/${encodeURIComponent(messageId)}`)
        .catch(() => {});
    }
    if (httpServer) await httpServer.close().catch(() => {});
    if (hub) await hub.stop().catch(() => {});
    if (restartedHub) await restartedHub.stop().catch(() => {});
    if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
  }, 20_000);

  it("verifies token, setup confirmation, encrypted persistence, and gateway startup", async () => {
    const me = await discordGet("/users/@me");
    expect(me.ok, `Discord token must be valid; HTTP ${String(me.status)}`).toBe(true);
    const meJson = me.json as { id?: string; username?: string; bot?: boolean } | undefined;
    expect(meJson?.bot).toBe(true);
    expect(typeof meJson?.id).toBe("string");

    const gateway = await discordGet("/gateway");
    expect(gateway.ok, `Discord gateway discovery must pass; HTTP ${String(gateway.status)}`).toBe(true);
    const guild = await discordGet(`/guilds/${encodeURIComponent(DISCORD_GUILD_ID)}`);
    expect(guild.ok, `Discord sandbox guild must be visible to the bot; HTTP ${String(guild.status)}`).toBe(true);
    const guildJson = guild.json as { id?: string } | undefined;
    expect(guildJson?.id).toBe(DISCORD_GUILD_ID);
    const channel = await discordGet(`/channels/${encodeURIComponent(DISCORD_CHANNEL_ID)}`);
    expect(channel.ok, `Discord sandbox channel must be visible to the bot; HTTP ${String(channel.status)}`).toBe(true);
    const channelJson = channel.json as { id?: string; guild_id?: string } | undefined;
    expect(channelJson?.id).toBe(DISCORD_CHANNEL_ID);
    expect(channelJson?.guild_id).toBe(DISCORD_GUILD_ID);

    hub = await createFridayHub({
      stateDir,
      skillDirs: [],
      port: 0,
      logRequests: false,
    });
    await hub.start();

    const port = await findFreePort();
    httpServer = createFridayHttpServer({
      routes: hub.apiRuntime.routes,
      wsGateway: hub.apiRuntime.wsGateway,
      middleware: hub.apiRuntime.middleware,
      port,
      host: "127.0.0.1",
      logRequests: false,
    });
    await httpServer.listen();

    const baseUrl = `http://127.0.0.1:${String(port)}`;
    const loginRes = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPassphrase: "friday-test-local-passphrase-123" }),
    });
    const loginJson = await loginRes.json() as { ok: boolean; data?: { accessToken?: string } };
    expect(loginJson.ok).toBe(true);
    const accessToken = loginJson.data?.accessToken;
    expect(typeof accessToken).toBe("string");

    const discordConfig = {
      token: DISCORD_BOT_TOKEN,
      intents: 0,
      botUserId: meJson?.id,
      allowedChannels: [DISCORD_CHANNEL_ID],
    };

    const verificationBeginRes = await fetch(`${baseUrl}/v1/setup/channels/discord/verification/begin`, {
      method: "POST",
      headers: authHeaders(accessToken!),
      body: JSON.stringify({ token: DISCORD_BOT_TOKEN, guildId: DISCORD_GUILD_ID }),
    });
    const verificationBeginJson = await verificationBeginRes.json() as { ok: boolean; data?: { verificationId?: string } };
    expect(verificationBeginRes.status).toBe(200);
    expect(verificationBeginJson.ok).toBe(true);
    const setupVerificationId = verificationBeginJson.data?.verificationId;
    expect(typeof setupVerificationId).toBe("string");

    const verificationCompleteRes = await fetch(`${baseUrl}/v1/setup/channels/discord/verification/complete`, {
      method: "POST",
      headers: authHeaders(accessToken!),
      body: JSON.stringify({
        verificationId: setupVerificationId,
        userId: DISCORD_SETUP_USER_ID,
        guildId: DISCORD_GUILD_ID,
      }),
    });
    const verificationCompleteJson = await verificationCompleteRes.json() as { ok: boolean; data?: { status?: string; dmVerified?: boolean } };
    expect(verificationCompleteRes.status).toBe(200);
    expect(verificationCompleteJson.ok).toBe(true);
    expect(verificationCompleteJson.data?.status).toBe("success");
    expect(verificationCompleteJson.data?.dmVerified).toBe(true);

    const verifiedDiscordConfig = {
      ...discordConfig,
      setupVerificationId,
      setupUserId: DISCORD_SETUP_USER_ID,
    };

    const unconfirmedRes = await fetch(`${baseUrl}/v1/setup/channels`, {
      method: "POST",
      headers: authHeaders(accessToken!),
      body: JSON.stringify({
        channels: [{ kind: "discord", enabled: true, config: verifiedDiscordConfig }],
      }),
    });
    expect(unconfirmedRes.status).toBe(400);

    const confirmedRes = await fetch(`${baseUrl}/v1/setup/channels`, {
      method: "POST",
      headers: authHeaders(accessToken!),
      body: JSON.stringify({
        controlConfirmed: true,
        channels: [{ kind: "discord", enabled: true, config: verifiedDiscordConfig }],
      }),
    });
    const confirmedJson = await confirmedRes.json() as { ok: boolean; data?: { savedKinds?: string[] } };
    expect(confirmedRes.status).toBe(200);
    expect(confirmedJson.ok).toBe(true);
    expect(confirmedJson.data?.savedKinds).toContain("discord");

    const dbPath = path.join(stateDir, "friday.db");
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare("SELECT channels_json FROM friday_setup_state WHERE id = 'singleton'")
        .get() as { channels_json: string } | undefined;
      expect(row?.channels_json).toBeTruthy();
      expect(row!.channels_json).not.toContain(DISCORD_BOT_TOKEN);
      expect(row!.channels_json).not.toContain(DISCORD_BOT_TOKEN.slice(0, 12));

      const stored = JSON.parse(row!.channels_json) as Array<{
        kind: string;
        enabled: boolean;
        controlConfirmed?: boolean;
        controlConfirmedAt?: string;
        config?: Record<string, unknown>;
      }>;
      const discord = stored.find((entry) => entry.kind === "discord");
      expect(discord?.enabled).toBe(true);
      expect(discord?.controlConfirmed).toBe(true);
      expect(typeof discord?.controlConfirmedAt).toBe("string");
      expect(String(discord?.config?.token ?? "")).toMatch(/^secret:\/\/channel\//);

      const secretRow = db
        .prepare("SELECT scope, ref_key FROM secrets WHERE scope = 'channel' LIMIT 1")
        .get() as { scope: string; ref_key: string } | undefined;
      expect(secretRow?.scope).toBe("channel");
    } finally {
      db.close();
    }

    await httpServer.close();
    httpServer = undefined;
    await hub.stop();
    hub = undefined;

    restartedHub = await createFridayHub({
      stateDir,
      skillDirs: [],
      port: 0,
      logRequests: false,
    });
    await restartedHub.start();

    expect(restartedHub.channelRegistry.list()).toContain("discord");
    const view = restartedHub.channelRegistry.describe("discord");
    expect(view?.status).toBe("connected");
    expect(view?.running).toBe(true);

    const probeText = `Friday F-008 live Discord channel proof ${Date.now().toString(36)}`;
    const delivery = await restartedHub.channelRegistry.send("discord", {
      chatId: DISCORD_CHANNEL_ID,
      chatType: "group",
      text: probeText,
    });
    sentChannelMessageIds.push(delivery.messageId);
    expect(typeof delivery.messageId).toBe("string");

    const readBack = await discordGet(
      `/channels/${encodeURIComponent(DISCORD_CHANNEL_ID)}/messages/${encodeURIComponent(delivery.messageId)}`,
    );
    expect(readBack.ok, `Discord channel message readback must pass; HTTP ${String(readBack.status)}`).toBe(true);
    const readBackJson = readBack.json as { id?: string; channel_id?: string; guild_id?: string; content?: string } | undefined;
    expect(readBackJson?.id).toBe(delivery.messageId);
    expect(readBackJson?.channel_id).toBe(DISCORD_CHANNEL_ID);
    expect(readBackJson?.guild_id).toBe(DISCORD_GUILD_ID);
    expect(readBackJson?.content).toBe(probeText);

    const replyText = `Friday F-008 live Discord channel reply ${Date.now().toString(36)}`;
    const reply = await restartedHub.channelRegistry.send("discord", {
      chatId: DISCORD_CHANNEL_ID,
      chatType: "group",
      replyTo: delivery.messageId,
      text: replyText,
    });
    sentChannelMessageIds.push(reply.messageId);
    const replyReadBack = await discordGet(
      `/channels/${encodeURIComponent(DISCORD_CHANNEL_ID)}/messages/${encodeURIComponent(reply.messageId)}`,
    );
    expect(replyReadBack.ok, `Discord reply readback must pass; HTTP ${String(replyReadBack.status)}`).toBe(true);
    const replyJson = replyReadBack.json as {
      id?: string;
      channel_id?: string;
      guild_id?: string;
      content?: string;
      message_reference?: { message_id?: string };
    } | undefined;
    expect(replyJson?.id).toBe(reply.messageId);
    expect(replyJson?.channel_id).toBe(DISCORD_CHANNEL_ID);
    expect(replyJson?.guild_id).toBe(DISCORD_GUILD_ID);
    expect(replyJson?.message_reference?.message_id).toBe(delivery.messageId);
    expect(replyJson?.content).toBe(replyText);
  }, 60_000);
});
