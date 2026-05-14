import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createFridayChannelRegistry } from "#channels";
import type { FridayChannelPlugin } from "#channels";
import {
  createFridayApiTestEnv,
  loginTestUser,
  authHeaders,
  type FridayApiTestEnv,
} from "./_helpers/friday-api-test-server.helper.js";

function createTestChannelPlugin(kind: string): FridayChannelPlugin {
  return {
    kind,
    async init() {},
    async start() {},
    async stop() {},
    async send() {
      return { messageId: `test-msg-${Date.now()}` };
    },
    contract: {
      coreAuthority: {
        messageRouting: true,
        sessionMirroring: true,
        audit: true,
        evidence: true,
      },
      pluginResponsibilities: {
        config: true,
        auth: true,
        pairing: false,
        outboundDelivery: true,
        threadResolution: false,
        providerRetries: false,
      },
      supports: {
        directMessages: true,
        groupMessages: false,
        threads: false,
        typing: false,
      },
    },
  };
}

describe("friday-api-channels-routes (E2E)", () => {
  let env: FridayApiTestEnv;
  let token: string;

  beforeAll(async () => {
    const registry = createFridayChannelRegistry();
    registry.register(createTestChannelPlugin("test-channel"), {
      allowedUsers: ["safe-user-1"],
    });

    env = await createFridayApiTestEnv({
      channels: {
        registry,
        supportedKinds: ["test-channel", "discord"],
      },
    });
    const auth = await loginTestUser(env.baseUrl);
    token = auth.accessToken;
  });

  afterAll(async () => {
    await env?.close();
  });

  // ── channels_list_returns_ok_with_items ──────────────────────────────────

  it("channels_list_returns_ok_with_items", async () => {
    const res = await fetch(`${env.baseUrl}/v1/channels`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { items: unknown[] };
    };
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.data.items)).toBe(true);
    expect(json.data.items.length).toBeGreaterThanOrEqual(1);
  });

  // ── channels_list_items_have_supervisor_shape ───────────────────────────

  it("channels_list_items_have_supervisor_health_shape", async () => {
    const res = await fetch(`${env.baseUrl}/v1/channels`, {
      headers: authHeaders(token),
    });
    const json = (await res.json()) as {
      ok: boolean;
      data: {
        items: Array<{
          kind: string;
          running: boolean;
          status: string;
          health: {
            state: string;
            restartCount: number;
            credentialStatus: string;
          };
          allowlist: {
            hasAllowedUsers: boolean;
            allowedUsersCount: number;
            hasAllowedChats: boolean;
            allowedChatsCount: number;
          };
          persona: unknown;
          contract: unknown;
        }>;
      };
    };
    expect(json.ok).toBe(true);

    const testChannel = json.data.items.find((c) => c.kind === "test-channel");
    expect(testChannel).toBeDefined();

    expect(typeof testChannel!.kind).toBe("string");
    expect(typeof testChannel!.running).toBe("boolean");
    expect(typeof testChannel!.status).toBe("string");

    expect(testChannel!.health).toBeDefined();
    expect(typeof testChannel!.health.state).toBe("string");
    expect(typeof testChannel!.health.restartCount).toBe("number");
    expect(typeof testChannel!.health.credentialStatus).toBe("string");

    expect(testChannel!.allowlist).toBeDefined();
    expect(testChannel!.allowlist.hasAllowedUsers).toBe(true);
    expect(testChannel!.allowlist.allowedUsersCount).toBe(1);

    expect(testChannel!.contract).toBeDefined();
  });

  // ── channel_get_returns_detail ──────────────────────────────────────────

  it("channel_get_returns_detail_for_registered_channel", async () => {
    const res = await fetch(`${env.baseUrl}/v1/channels/test-channel`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: {
        channel: {
          kind: string;
          running: boolean;
          health: { state: string; credentialStatus: string };
        };
      };
    };
    expect(json.ok).toBe(true);
    expect(json.data.channel.kind).toBe("test-channel");
    expect(typeof json.data.channel.running).toBe("boolean");
    expect(json.data.channel.health).toBeDefined();
  });

  // ── channel_get_returns_404_for_unknown ──────────────────────────────────

  it("channel_get_returns_404_for_unknown", async () => {
    const res = await fetch(`${env.baseUrl}/v1/channels/nonexistent-kind`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("CHANNEL_NOT_FOUND");
  });

  // ── persona_crud_lifecycle ──────────────────────────────────────────────

  it("persona_crud_lifecycle", async () => {
    const getRes = await fetch(`${env.baseUrl}/v1/channels/test-channel/persona`, {
      headers: authHeaders(token),
    });
    expect(getRes.status).toBe(200);
    const getJson = (await getRes.json()) as {
      ok: boolean;
      data: { kind: string; persona: null | { persona: string } };
    };
    expect(getJson.data.persona).toBeNull();

    const updateRes = await fetch(`${env.baseUrl}/v1/channels/test-channel/persona`, {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify({
        persona: "E2E test persona",
        systemPrompt: "You are a test assistant.",
      }),
    });
    expect(updateRes.status).toBe(200);
    const updateJson = (await updateRes.json()) as {
      ok: boolean;
      data: { kind: string; persona: { persona: string; systemPrompt: string } };
    };
    expect(updateJson.data.persona.persona).toBe("E2E test persona");
    expect(updateJson.data.persona.systemPrompt).toBe("You are a test assistant.");

    const clearRes = await fetch(`${env.baseUrl}/v1/channels/test-channel/persona`, {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify({ persona: "", systemPrompt: "" }),
    });
    expect(clearRes.status).toBe(200);
    const clearJson = (await clearRes.json()) as {
      ok: boolean;
      data: { cleared: boolean };
    };
    expect(clearJson.data.cleared).toBe(true);
  });

  // ── persona_for_supported_kind_without_instance ─────────────────────────

  it("persona_for_supported_kind_without_active_instance", async () => {
    const updateRes = await fetch(`${env.baseUrl}/v1/channels/discord/persona`, {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify({
        persona: "Discord persona before channel is active",
        systemPrompt: "",
      }),
    });
    expect(updateRes.status).toBe(200);
    const updateJson = (await updateRes.json()) as {
      ok: boolean;
      data: { kind: string; persona: { persona: string } };
    };
    expect(updateJson.data.kind).toBe("discord");
    expect(updateJson.data.persona.persona).toBe("Discord persona before channel is active");
  });

  // ── channel_webhook_relay_returns_404_when_no_listeners ─────────────────

  it("channel_webhook_relay_returns_404_when_no_listeners", async () => {
    const res = await fetch(`${env.baseUrl}/v1/channels/webhooks/line`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });
    expect(res.status).toBe(404);
  });
});
