/**
 * Mock Provider Matrix E2E Tests — parameterized across all 5 provider kinds.
 *
 * Tests the agent LLM client directly (streaming path) and the hub agent API
 * with protocol-accurate mock responses for each provider type.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { createFridayAgentLlmClient } from "#agent";
import type {
  FridayAgentLlmStreamEvent,
  FridayAgentLlmStreamParams,
} from "../../../src/agent/runtime/friday-agent-llm-client.types.js";
import {
  createMockFetch,
  resetMockCounters,
  type MockFetch,
} from "../../_mocks/mock-llm-providers.js";
import {
  STREAMING_PROVIDER_MATRIX,
  type ProviderMatrixEntry,
} from "./_helpers/provider-matrix.js";

// ─── Helpers ───

function makeStreamParams(overrides?: Partial<FridayAgentLlmStreamParams>): FridayAgentLlmStreamParams {
  return {
    model: "mock-model",
    systemPrompt: "You are a helpful assistant.",
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
    signal: AbortSignal.timeout(5_000),
    ...overrides,
  };
}

async function collectEvents(
  stream: AsyncIterable<FridayAgentLlmStreamEvent>,
): Promise<FridayAgentLlmStreamEvent[]> {
  const events: FridayAgentLlmStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

// ─── Streaming Provider Tests (agent LLM client path) ───

describe("Mock Provider Matrix — Streaming (Agent LLM Client)", () => {
  describe.each(STREAMING_PROVIDER_MATRIX)(
    "$kind ($api)",
    (entry: ProviderMatrixEntry) => {
      let mock: MockFetch;

      beforeEach(() => {
        resetMockCounters();
        mock = createMockFetch(entry.api);
      });

      it("basic text completion", async () => {
        mock.setDefault({ type: "text", text: "Hello from mock" });

        const client = createFridayAgentLlmClient({
          baseUrl: entry.baseUrl,
          apiKey: "mock-key",
          api: entry.api,
          fetchImpl: mock,
        });

        const events = await collectEvents(client.stream(makeStreamParams()));

        // Should have at least text_delta and message_end
        const textDeltas = events.filter((e) => e.type === "text_delta");
        const messageEnds = events.filter((e) => e.type === "message_end");

        expect(textDeltas.length).toBeGreaterThanOrEqual(1);
        expect(messageEnds.length).toBe(1);

        const fullText = textDeltas.map((e) => e.type === "text_delta" ? e.text : "").join("");
        expect(fullText).toContain("Hello from mock");

        const end = messageEnds[0]!;
        expect(end.type).toBe("message_end");
        if (end.type === "message_end") {
          expect(end.stopReason).toBe("end_turn");
        }

        // Verify call was recorded
        expect(mock.calls.length).toBe(1);
        expect(mock.calls[0]!.method).toBe("POST");
      });

      it("tool call round-trip", async () => {
        // First reply: tool call
        mock.enqueue({
          type: "tool_use",
          toolName: "get_weather",
          toolInput: { city: "SF" },
        });
        // Second reply: text after tool execution
        mock.enqueue({
          type: "text",
          text: "The weather in SF is 68°F.",
        });

        const client = createFridayAgentLlmClient({
          baseUrl: entry.baseUrl,
          apiKey: "mock-key",
          api: entry.api,
          fetchImpl: mock,
        });

        const params = makeStreamParams({
          tools: [
            {
              name: "get_weather",
              description: "Get weather for a city",
              parameters: {
                properties: {
                  city: { type: "string", description: "City name" },
                },
                required: ["city"],
              },
            },
          ],
        });

        // First call → tool_use
        const events1 = await collectEvents(client.stream(params));
        const toolUses1 = events1.filter((e) => e.type === "tool_use");
        const ends1 = events1.filter((e) => e.type === "message_end");

        expect(toolUses1.length).toBe(1);
        const tu = toolUses1[0]!;
        if (tu.type === "tool_use") {
          expect(tu.name).toBe("get_weather");
          expect(tu.input).toEqual({ city: "SF" });
          expect(tu.id).toBeTruthy();
        }
        expect(ends1.length).toBe(1);
        if (ends1[0]!.type === "message_end") {
          expect(ends1[0]!.stopReason).toBe("tool_use");
        }

        // Second call → text response
        const events2 = await collectEvents(client.stream(makeStreamParams()));
        const textDeltas2 = events2.filter((e) => e.type === "text_delta");
        const fullText2 = textDeltas2.map((e) => e.type === "text_delta" ? e.text : "").join("");
        expect(fullText2).toContain("68°F");

        // Two calls total
        expect(mock.calls.length).toBe(2);
      });

      it("HTTP 429 error", async () => {
        mock.setDefault({
          type: "http_error",
          status: 429,
          body: { error: { message: "Rate limit exceeded" } },
        });

        const client = createFridayAgentLlmClient({
          baseUrl: entry.baseUrl,
          apiKey: "mock-key",
          api: entry.api,
          fetchImpl: mock,
        });

        await expect(
          collectEvents(client.stream(makeStreamParams())),
        ).rejects.toThrow(/429/);

        expect(mock.calls.length).toBe(1);
      });

      it("HTTP 500 error", async () => {
        mock.setDefault({
          type: "http_error",
          status: 500,
          body: { error: { message: "Internal server error" } },
        });

        const client = createFridayAgentLlmClient({
          baseUrl: entry.baseUrl,
          apiKey: "mock-key",
          api: entry.api,
          fetchImpl: mock,
        });

        await expect(
          collectEvents(client.stream(makeStreamParams())),
        ).rejects.toThrow(/500/);
      });

      it("network error", async () => {
        mock.setDefault({
          type: "network_error",
          message: "ECONNREFUSED: mock connection refused",
          code: "ECONNREFUSED",
        });

        const client = createFridayAgentLlmClient({
          baseUrl: entry.baseUrl,
          apiKey: "mock-key",
          api: entry.api,
          fetchImpl: mock,
        });

        await expect(
          collectEvents(client.stream(makeStreamParams())),
        ).rejects.toThrow(/ECONNREFUSED/);
      });

      it("timeout error", async () => {
        mock.setDefault({
          type: "timeout",
          message: "Request timed out",
          code: "ETIMEDOUT",
        });

        const client = createFridayAgentLlmClient({
          baseUrl: entry.baseUrl,
          apiKey: "mock-key",
          api: entry.api,
          fetchImpl: mock,
        });

        await expect(
          collectEvents(client.stream(makeStreamParams())),
        ).rejects.toThrow(/timed out/i);
      });

      it("FIFO queue ordering", async () => {
        mock.enqueue(
          { type: "text", text: "first" },
          { type: "text", text: "second" },
          { type: "text", text: "third" },
        );

        const client = createFridayAgentLlmClient({
          baseUrl: entry.baseUrl,
          apiKey: "mock-key",
          api: entry.api,
          fetchImpl: mock,
        });

        const e1 = await collectEvents(client.stream(makeStreamParams()));
        const e2 = await collectEvents(client.stream(makeStreamParams()));
        const e3 = await collectEvents(client.stream(makeStreamParams()));

        const getText = (events: FridayAgentLlmStreamEvent[]) =>
          events.filter((e) => e.type === "text_delta").map((e) => e.type === "text_delta" ? e.text : "").join("");

        expect(getText(e1)).toContain("first");
        expect(getText(e2)).toContain("second");
        expect(getText(e3)).toContain("third");
        expect(mock.calls.length).toBe(3);
      });

      it("default reply used when queue is empty", async () => {
        mock.setDefault({ type: "text", text: "default response" });
        mock.enqueue({ type: "text", text: "queued response" });

        const client = createFridayAgentLlmClient({
          baseUrl: entry.baseUrl,
          apiKey: "mock-key",
          api: entry.api,
          fetchImpl: mock,
        });

        // First: queued
        const e1 = await collectEvents(client.stream(makeStreamParams()));
        const getText = (events: FridayAgentLlmStreamEvent[]) =>
          events.filter((e) => e.type === "text_delta").map((e) => e.type === "text_delta" ? e.text : "").join("");

        expect(getText(e1)).toContain("queued response");

        // Second: falls through to default
        const e2 = await collectEvents(client.stream(makeStreamParams()));
        expect(getText(e2)).toContain("default response");
      });

      it("reset clears queue, calls, and default", async () => {
        mock.enqueue({ type: "text", text: "will be cleared" });
        mock.setDefault({ type: "text", text: "will be cleared" });

        // Make one call
        const client = createFridayAgentLlmClient({
          baseUrl: entry.baseUrl,
          apiKey: "mock-key",
          api: entry.api,
          fetchImpl: mock,
        });
        await collectEvents(client.stream(makeStreamParams()));
        expect(mock.calls.length).toBe(1);

        // Reset
        mock.reset();
        expect(mock.calls.length).toBe(0);

        // Should throw — no default and no queue
        await expect(
          collectEvents(client.stream(makeStreamParams())),
        ).rejects.toThrow(/No reply queued/);
      });
    },
  );
});

// ─── Non-streaming provider test (Google) ───

describe("Mock Provider Matrix — Google Generative AI (non-streaming)", () => {
  let mock: MockFetch;

  beforeEach(() => {
    resetMockCounters();
    mock = createMockFetch("google-generative-ai");
  });

  it("returns JSON response for text completion", async () => {
    mock.setDefault({ type: "text", text: "Hello from Google mock" });

    const response = await mock("https://mock.google.local/v1beta/models/mock-gemini:generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    const candidates = body.candidates as Array<{
      content: { parts: Array<{ text: string }> };
    }>;
    expect(candidates[0]!.content.parts[0]!.text).toBe("Hello from Google mock");

    expect(mock.calls.length).toBe(1);
  });

  it("returns tool call response", async () => {
    mock.setDefault({
      type: "tool_use",
      toolName: "get_weather",
      toolInput: { city: "SF" },
    });

    const response = await mock("https://mock.google.local/v1beta/models/mock-gemini:generateContent", {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    const candidates = body.candidates as Array<{
      content: { parts: Array<{ functionCall: { name: string; args: unknown } }> };
    }>;
    expect(candidates[0]!.content.parts[0]!.functionCall.name).toBe("get_weather");
    expect(candidates[0]!.content.parts[0]!.functionCall.args).toEqual({ city: "SF" });
  });

  it("HTTP error response", async () => {
    mock.setDefault({
      type: "http_error",
      status: 403,
      body: { error: { message: "Forbidden" } },
    });

    const response = await mock("https://mock.google.local/v1beta/models/mock-gemini:generateContent", {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(403);
  });

  it("network error", async () => {
    mock.setDefault({
      type: "network_error",
      message: "Connection failed",
      code: "ECONNREFUSED",
    });

    await expect(
      mock("https://mock.google.local/v1beta/models/mock-gemini:generateContent", {
        method: "POST",
        body: "{}",
      }),
    ).rejects.toThrow(/Connection failed/);
  });
});

// ─── Failover tests via real hub fallback/cooldown logic ───
// The hub's agentLlmClient uses providerService.runWithFallback() for
// credential resolution. These tests trigger failover at that level.

import {
  createMockHubEnv,
  type MockHubEnv,
} from "./_helpers/mock-env.js";

describe("Mock Provider Matrix — Failover (via Hub)", () => {
  let env: MockHubEnv;

  async function hubApiFetch<T>(
    method: string,
    urlPath: string,
    body?: unknown,
  ): Promise<{ status: number; json: T }> {
    const res = await fetch(`${env.baseUrl}${urlPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.accessToken}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json()) as T;
    return { status: res.status, json };
  }

  beforeAll(async () => {
    // Register only ollama as the working provider
    env = await createMockHubEnv({ providerKinds: ["ollama"] });
  }, 30_000);

  afterAll(async () => {
    if (env) await env.cleanup();
  }, 15_000);

  beforeEach(() => {
    for (const mock of Object.values(env.mocks)) {
      mock.reset();
    }
    resetMockCounters();
  });

  it("falls back from bad credential provider to working Ollama via hub routing", async () => {
    const ollamaMock = env.mockFor("ollama");
    const ollamaProvider = env.providers["ollama"]!;

    // Create a bad provider with an env-ref API key pointing to a nonexistent var.
    // Credential resolution will fail in runWithFallback, triggering fallback.
    const badProviderRes = await hubApiFetch<{
      ok: boolean;
      data: { provider: { id: string } };
    }>("POST", "/v1/providers", {
      kind: "openai-compatible",
      name: "Bad Provider (Failover Test)",
      baseUrl: "https://mock.bad.local",
      authMode: "api-key",
      api: "openai-completions",
      apiKey: "$FRIDAY_MOCK_NONEXISTENT_ENV_VAR_FOR_FAILOVER",
      supportedModels: ["mock-bad"],
      defaultModel: "mock-bad",
      enabled: true,
      validateOnSave: false,
    });
    expect(badProviderRes.status).toBe(200);
    const badProviderId = badProviderRes.json.data.provider.id;

    // Set routing: bad provider primary, ollama fallback
    await hubApiFetch("PUT", "/v1/model-routing", {
      defaultProviderId: badProviderId,
      fallbackProviderIds: [ollamaProvider.providerId],
    });

    // Ollama returns success
    ollamaMock.setDefault({
      type: "text",
      text: "Fallback success from Ollama",
    });

    // Run agent task — bad provider fails at credential resolution, falls back to ollama
    const runRes = await hubApiFetch<{
      ok: boolean;
      data: { runId: string; status: string; response: string };
    }>("POST", "/v1/agent/runs", {
      task: "Say hello",
      timeoutMs: 15_000,
    });

    expect(runRes.status).toBe(200);
    expect(runRes.json.ok).toBe(true);
    expect(runRes.json.data.status).toBe("completed");
    expect(runRes.json.data.response).toContain("Fallback success from Ollama");

    // Verify the working mock was called
    expect(ollamaMock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("falls back from second bad provider to working Ollama", async () => {
    const ollamaMock = env.mockFor("ollama");
    const ollamaProvider = env.providers["ollama"]!;

    // Create another bad provider with missing env var credential
    const badProvider2Res = await hubApiFetch<{
      ok: boolean;
      data: { provider: { id: string } };
    }>("POST", "/v1/providers", {
      kind: "anthropic",
      name: "Bad Anthropic (Failover Test)",
      baseUrl: "https://mock.bad-anthropic.local",
      authMode: "api-key",
      api: "anthropic-messages",
      apiKey: "$FRIDAY_MOCK_NONEXISTENT_ANTHROPIC_KEY",
      supportedModels: ["mock-bad-claude"],
      defaultModel: "mock-bad-claude",
      enabled: true,
      validateOnSave: false,
    });
    expect(badProvider2Res.status).toBe(200);
    const badProvider2Id = badProvider2Res.json.data.provider.id;

    // Set routing: bad anthropic primary, ollama fallback
    await hubApiFetch("PUT", "/v1/model-routing", {
      defaultProviderId: badProvider2Id,
      fallbackProviderIds: [ollamaProvider.providerId],
    });

    ollamaMock.setDefault({
      type: "text",
      text: "Success after credential failover",
    });

    const runRes = await hubApiFetch<{
      ok: boolean;
      data: { runId: string; status: string; response: string };
    }>("POST", "/v1/agent/runs", {
      task: "Say hello",
      timeoutMs: 15_000,
    });

    expect(runRes.status).toBe(200);
    expect(runRes.json.ok).toBe(true);
    expect(runRes.json.data.status).toBe("completed");
    expect(runRes.json.data.response).toContain("Success after credential failover");
  });
});
