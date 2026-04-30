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

async function discordGet(pathname: string): Promise<{ ok: boolean; status: number; json?: unknown }> {
  const res = await fetch(`https://discord.com/api/v10${pathname}`, {
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
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

describe.skipIf(!RUN_LIVE_DISCORD || !DISCORD_SETUP_USER_ID)("Friday live Discord channel closure", () => {
  let stateDir = "";
  let hub: FridayHub | undefined;
  let restartedHub: FridayHub | undefined;
  let httpServer: FridayHttpServer | undefined;

  beforeAll(() => {
    expect(DISCORD_BOT_TOKEN.length).toBeGreaterThan(0);
    expect(DISCORD_SETUP_USER_ID.length).toBeGreaterThan(0);
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-discord-channel-live-"));
  });

  afterAll(async () => {
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
    };

    const verificationBeginRes = await fetch(`${baseUrl}/v1/setup/channels/discord/verification/begin`, {
      method: "POST",
      headers: authHeaders(accessToken!),
      body: JSON.stringify({ token: DISCORD_BOT_TOKEN }),
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
  }, 60_000);
});
