import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeScenario } from "../../../validation/real-world/lib/executors.mjs";

const OLD_ENV = process.env;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeScenario() {
  return {
    id: "l6-discord-channel-roundtrip",
    layer: "L6",
    productArea: "external channels",
    entrySurface: "discord",
    routeFamily: "distributed channel",
    providerLane: "none" as const,
    riskTier: "high",
    expectedEvidence: ["discord proof"],
    execution: {
      kind: "discord_roundtrip",
      tokenEnv: "FRIDAY_DISCORD_BOT_TOKEN",
      setupUserIdEnv: "FRIDAY_DISCORD_SETUP_USER_ID",
      guildIdEnv: "FRIDAY_DISCORD_GUILD_ID",
      channelIdEnv: "FRIDAY_DISCORD_CHANNEL_ID",
    },
  };
}

describe("real-world Discord roundtrip executor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = {
      ...OLD_ENV,
      FRIDAY_DISCORD_BOT_TOKEN: "test-discord-token",
      FRIDAY_DISCORD_SETUP_USER_ID: "370355408730324993",
      FRIDAY_DISCORD_GUILD_ID: "1476443522000486548",
      FRIDAY_DISCORD_CHANNEL_ID: "1476443521543180388",
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = OLD_ENV;
  });

  it("sends and reads channel proof messages without storing token or raw content in artifact evidence", async () => {
    const messages = new Map<string, string>();
    let nextMessageId = 1;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const pathname = new URL(url).pathname;
      if (pathname === "/api/v10/users/@me") {
        return jsonResponse({ id: "bot-user-1", bot: true });
      }
      if (pathname === "/api/v10/guilds/1476443522000486548") {
        return jsonResponse({ id: "1476443522000486548" });
      }
      if (pathname === "/api/v10/channels/1476443521543180388") {
        return jsonResponse({ id: "1476443521543180388", guild_id: "1476443522000486548" });
      }
      if (pathname === "/api/v10/users/@me/channels" && init?.method === "POST") {
        return jsonResponse({ id: "dm-channel-1" });
      }
      if (pathname === "/api/v10/channels/dm-channel-1/messages/welcome-1" && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      if (pathname === "/api/v10/channels/1476443521543180388/messages" && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as { content?: string };
        const id = `msg-${String(nextMessageId)}`;
        nextMessageId += 1;
        messages.set(id, String(body.content ?? ""));
        return jsonResponse({ id });
      }
      const messageMatch = pathname.match(/^\/api\/v10\/channels\/1476443521543180388\/messages\/([^/]+)$/);
      if (messageMatch && init?.method === "DELETE") {
        messages.delete(messageMatch[1]!);
        return new Response(null, { status: 204 });
      }
      if (messageMatch && init?.method !== "POST") {
        const id = messageMatch[1]!;
        return jsonResponse({ id, content: messages.get(id), channel_id: "1476443521543180388", guild_id: "1476443522000486548" });
      }
      return jsonResponse({ code: 10003 }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    let outboundIndex = 1;
    const apiMock = vi.fn(async (method: string, routePath: string, body?: { text?: string }) => {
      if (method === "POST" && routePath === "/v1/setup/channels/discord/verification/begin") {
        return { data: { verificationId: "verify-1" } };
      }
      if (method === "POST" && routePath === "/v1/setup/channels/discord/verification/complete") {
        return { data: { status: "success", dmVerified: true, welcomeMessageId: "welcome-1" } };
      }
      if (method === "POST" && routePath === "/v1/setup/channels") {
        return { data: { savedKinds: ["discord"] } };
      }
      if (method === "POST" && routePath === "/v1/sessions") {
        return { data: { session: { key: "discord:real-world-validation:1476443521543180388" } } };
      }
      if (method === "POST" && routePath.endsWith("/outbound")) {
        const id = `msg-${String(outboundIndex)}`;
        outboundIndex += 1;
        messages.set(id, String(body?.text ?? ""));
        return { data: { delivery: { messageId: id } } };
      }
      throw new Error(`unexpected API call ${method} ${routePath}`);
    });

    const artifact = await executeScenario({
      runId: "run-1",
      suite: "weekly",
      scenario: makeScenario(),
      lane: { laneKey: "none" },
      client: { api: apiMock },
      envTruth: {},
      reportRoot: "/tmp/friday-real-world-test",
      uiBaseUrl: "http://127.0.0.1:3141",
      blockers: [],
    });

    expect(artifact.result).toBe("passed");
    expect(artifact.observedEvidence).toContain("Friday session outbound channel message sent and read back");
    expect(apiMock).toHaveBeenCalledWith(
      "POST",
      expect.stringContaining("/outbound"),
      expect.objectContaining({ text: expect.stringContaining("Friday F-008 live Discord proof") }),
    );
    const raw = JSON.stringify(artifact.raw);
    expect(raw).not.toContain("test-discord-token");
    expect(raw).not.toContain("Friday F-008 live Discord proof");
    expect(raw).toContain("readBackMatched");
    expect(messages.size).toBe(0);
  });

  it("fails honestly when a required Discord proof env var is missing", async () => {
    delete process.env.FRIDAY_DISCORD_CHANNEL_ID;
    vi.stubGlobal("fetch", vi.fn());

    const artifact = await executeScenario({
      runId: "run-1",
      suite: "weekly",
      scenario: makeScenario(),
      lane: { laneKey: "none" },
      client: { api: vi.fn() },
      envTruth: {},
      reportRoot: "/tmp/friday-real-world-test",
      uiBaseUrl: "http://127.0.0.1:3141",
      blockers: [],
    });

    expect(artifact.result).toBe("failed");
    expect(artifact.notes?.join("\n")).toContain("missing required environment variable: FRIDAY_DISCORD_CHANNEL_ID");
  });
});
