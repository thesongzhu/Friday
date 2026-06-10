import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import net from "node:net";
import { createFridayHttpServer } from "#api";
import { createFridayDiscordChannel } from "#channels";
import { createFridayHub } from "#hub";
import type { DiscordGatewayEvent, DiscordGatewayService } from "#channels";
import { acquireLocalBearerToken } from "../../../scripts/ops/lib/phase24-local-auth.mjs";

// Regression guard for the phase24 trusted-inbound proof harness (R5 channel proof).
//
// The hub writes the inbound user-message mirror correctly under
// `channel:<brand>:<chatId>`, but the session read endpoints
// (`sessions.list` / `sessions.messages.list`) require a bound owner/session/channel
// principal (`OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED`). The phase24 listeners therefore
// MUST authenticate (via `acquireLocalBearerToken`) before reading the mirror. This test
// proves both halves of that contract against a real hub driven by a fake gateway (no
// real Discord / credentials / nonce):
//   FAIL-BEFORE: an authless read is rejected with HTTP 401.
//   PASS-AFTER:  an authenticated read returns the mirrored user message (with the
//                nonce, sourceMessageId, and channelKind the listener verifies).
// It does NOT weaken the auth requirement and does NOT touch the mirror producer.

const CHANNEL_ID = "1476443522000486550";
const SETUP_USER_ID = "370355408730324993";
const BOT_USER_ID = "1507102852168814602";
const GUILD_ID = "1476443521543180388";
const NONCE = "phase24b-run-regression-b577f5ea";
const PROBE_BODY = "help me clean up old files in my workspace; ask me before doing anything";
const REQUIRED_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const p = addr.port;
        srv.close(() => resolve(p));
      } else {
        reject(new Error("no port"));
      }
    });
  });
}

function createCapturingGateway(): DiscordGatewayService & { emit: (e: DiscordGatewayEvent) => void } {
  let captured: ((event: DiscordGatewayEvent) => void) | null = null;
  let connected = false;
  return {
    async connect(_token, _intents, onEvent, onStatusChange) {
      captured = onEvent;
      connected = true;
      onStatusChange?.("connected");
    },
    async disconnect() {
      connected = false;
      captured = null;
    },
    isConnected() {
      return connected;
    },
    emit(event: DiscordGatewayEvent) {
      if (captured) captured(event);
    },
  };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("phase24 trusted-inbound session read requires an authenticated principal", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) {
      try { await c(); } catch { /* ignore */ }
    }
  });

  it("authless read is 401; authenticated read returns the inbound user mirror", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase24-auth-"));
    cleanups.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
    process.env.FRIDAY_CHANNEL_DEBOUNCE_MS = "0";
    process.env.FRIDAY_CHANNEL_PROGRESS_RECEIPT_DELAY_MS = "0";

    const hub = await createFridayHub({
      stateDir,
      skillDirs: [],
      port: 0,
      logRequests: false,
      channels: { enabled: false, instances: [] },
      // G5 channel-mirror write guard (TS-retirement): this test asserts the
      // channelMessageHandler mirrors the inbound message into the session store
      // and reads it back; opt in to keep the mirror write path live.
      allowTestOnlySessionExecution: true,
    } as Parameters<typeof createFridayHub>[0]);
    cleanups.push(() => hub.stop?.());

    const gateway = createCapturingGateway();
    const discordPlugin = createFridayDiscordChannel({
      gateway,
      rest: {
        async sendMessage() { return { id: "stub-out-1" }; },
        async sendTyping() { /* no-op */ },
      },
    });
    await discordPlugin.init?.({
      kind: "discord",
      enabled: true,
      token: "fake-token",
      intents: REQUIRED_INTENTS,
      botUserId: BOT_USER_ID,
      allowedUsers: [SETUP_USER_ID],
      allowedChannels: [CHANNEL_ID],
      requireMention: true,
    } as Parameters<NonNullable<typeof discordPlugin.init>>[0]);
    hub.channelRegistry.register(discordPlugin, {
      allowedUsers: [SETUP_USER_ID],
      allowedChats: [CHANNEL_ID],
    });
    await hub.start();

    const port = await findFreePort();
    const server = createFridayHttpServer({
      routes: hub.apiRuntime.routes,
      wsGateway: hub.apiRuntime.wsGateway,
      middleware: hub.apiRuntime.middleware,
      port,
      host: "127.0.0.1",
      logRequests: false,
    });
    await server.listen();
    cleanups.push(() => server.close?.());
    const baseUrl = `http://127.0.0.1:${port}`;
    const sessionKey = `channel:discord:${CHANNEL_ID}`;
    const encoded = encodeURIComponent(sessionKey);

    // Drive a synthetic trusted inbound message through the real channelMessageHandler.
    gateway.emit({
      op: 0,
      t: "MESSAGE_CREATE",
      d: {
        id: "synthetic-msg-1",
        channel_id: CHANNEL_ID,
        guild_id: GUILD_ID,
        author: { id: SETUP_USER_ID, username: "operator", bot: false },
        content: `<@${BOT_USER_ID}> ${PROBE_BODY} ${NONCE}`,
        timestamp: "2026-05-29T00:00:00.000Z",
        mentions: [{ id: BOT_USER_ID }],
      },
    });

    // ── FAIL-BEFORE: the listener's old authless read is rejected. ──
    const authlessResp = await fetch(`${baseUrl}/v1/sessions/${encoded}/messages?limit=30`);
    expect(authlessResp.status).toBe(401);
    expect(await authlessResp.text()).toContain("OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED");

    // ── Authenticate exactly as the patched listeners do (shared helper). ──
    const token = await acquireLocalBearerToken(baseUrl, { passphrase: "phase24-regression-local-passphrase" });
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);

    // ── PASS-AFTER: an authenticated read returns the correctly-mirrored user message. ──
    let mirror: Record<string, unknown> | undefined;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const resp = await fetch(`${baseUrl}/v1/sessions/${encoded}/messages?limit=30`, {
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => null);
      if (resp && resp.ok) {
        const json: unknown = await resp.json().catch(() => null);
        const body = (json && typeof json === "object" && "data" in (json as Record<string, unknown>))
          ? (json as { data: unknown }).data
          : json;
        const items = Array.isArray((body as { items?: unknown })?.items)
          ? (body as { items: Array<Record<string, unknown>> }).items
          : Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [];
        mirror = items.find((m) => {
          const meta = (m.metadata ?? {}) as Record<string, unknown>;
          return (
            m.role === "user"
            && meta.channelKind === "discord"
            && typeof meta.sourceMessageId === "string"
            && String(m.contentText ?? "").includes(PROBE_BODY)
            && String(m.contentText ?? "").includes(NONCE)
          );
        });
        if (mirror) break;
      }
      await delay(500);
    }

    expect(mirror, "authenticated read should return the inbound user mirror").toBeTruthy();
    const meta = (mirror!.metadata ?? {}) as Record<string, unknown>;
    expect(meta.channelKind).toBe("discord");
    expect(meta.sourceMessageId).toBe("synthetic-msg-1");
  }, 60_000);
});
