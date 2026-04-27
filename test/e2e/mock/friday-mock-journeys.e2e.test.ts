/**
 * Mock E2E Journey Tests — deterministic, no real LLM required.
 *
 * Ports key journeys from the real E2E suite using mock providers.
 * Parameterized across all 5 provider kinds via PROVIDER_MATRIX.
 * Each test completes in < 1s with deterministic outputs.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import {
  createMockHubEnv,
  type MockHubEnv,
} from "./_helpers/mock-env.js";
import { resetMockCounters } from "../../_mocks/mock-llm-providers.js";
import { STREAMING_PROVIDER_MATRIX, type ProviderMatrixEntry } from "./_helpers/provider-matrix.js";
import type { MockFetchRouter } from "./_helpers/mock-fetch-router.js";
import type { FridayProviderKind } from "../../../src/providers/model/friday-provider.types.js";

const MOCK_E2E_TIMEOUT_MS = 20_000;

// ─── Helpers ───

async function apiFetch<T>(
  baseUrl: string,
  token: string,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json()) as T;
  return { status: res.status, json };
}

// ─── Setup wizard (provider-independent, run once) ───

describe("Friday Mock Journeys E2E — Setup Wizard", () => {
  let env: MockHubEnv;

  beforeAll(async () => {
    env = await createMockHubEnv({ providerKinds: ["ollama"] });
  }, 30_000);

  afterAll(async () => {
    if (env) await env.cleanup();
  }, 15_000);

  it("Scenario 1: Setup wizard journey (status → network → channels → complete)", async () => {
    // 1. Check initial setup status
    const statusRes = await apiFetch<{
      ok: boolean;
      data: { needsSetup: boolean; setupCompletedAt: string | null };
    }>(env.baseUrl, env.accessToken, "GET", "/v1/setup/status");
    expect(statusRes.status).toBe(200);
    expect(statusRes.json.ok).toBe(true);

    // 2. Set network config
    const networkRes = await apiFetch<{
      ok: boolean;
      data: { host: string; port: number; mode: string };
    }>(env.baseUrl, env.accessToken, "POST", "/v1/setup/network", {
      mode: "local",
      port: 3141,
    });
    expect(networkRes.status).toBe(200);
    expect(networkRes.json.ok).toBe(true);
    expect(networkRes.json.data.mode).toBe("local");

    // 3. Verify and save channels config
    const fetchBeforeDiscordMock = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://discord.com/api/v10/users/@me") {
        return new Response(JSON.stringify({ id: "bot-mock", username: "FridayBot", bot: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://discord.com/api/v10/oauth2/applications/@me") {
        return new Response(JSON.stringify({ id: "app-mock", bot: { id: "bot-mock", username: "FridayBot" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://discord.com/api/v10/users/@me/channels") {
        return new Response(JSON.stringify({ id: "dm-mock" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://discord.com/api/v10/channels/dm-mock/messages") {
        return new Response(JSON.stringify({ id: "msg-mock" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return fetchBeforeDiscordMock(input, init);
    }) as typeof fetch;

    let discordVerificationId = "";
    try {
      const beginDiscord = await apiFetch<{
        ok: boolean;
        data: { verificationId: string };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/setup/channels/discord/verification/begin", {
        token: "fake-mock-token",
      });
      expect(beginDiscord.status).toBe(200);
      discordVerificationId = beginDiscord.json.data.verificationId;

      const completeDiscord = await apiFetch<{
        ok: boolean;
        data: { status: string; dmVerified?: boolean };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/setup/channels/discord/verification/complete", {
        verificationId: discordVerificationId,
        userId: "10001",
      });
      expect(completeDiscord.status).toBe(200);
      expect(completeDiscord.json.data.status).toBe("success");
      expect(completeDiscord.json.data.dmVerified).toBe(true);
    } finally {
      globalThis.fetch = fetchBeforeDiscordMock;
    }

    const channelsRes = await apiFetch<{
      ok: boolean;
      data: { savedKinds: string[] };
    }>(env.baseUrl, env.accessToken, "POST", "/v1/setup/channels", {
      controlConfirmed: true,
      channels: [
        {
          kind: "discord",
          enabled: true,
          config: {
            token: "fake-mock-token",
            setupVerificationId: discordVerificationId,
            setupUserId: "10001",
          },
        },
      ],
    });
    expect(channelsRes.status).toBe(200);
    expect(channelsRes.json.ok).toBe(true);
    expect(channelsRes.json.data.savedKinds).toContain("discord");

    // 4. Complete setup
    const completeRes = await apiFetch<{
      ok: boolean;
      data: { setupCompletedAt: string };
    }>(env.baseUrl, env.accessToken, "POST", "/v1/setup/complete", {
      completedSteps: [
        "welcome", "security", "provider", "network", "channels", "skills", "done",
      ],
      skippedSteps: [],
    });
    expect(completeRes.status).toBe(200);
    expect(completeRes.json.ok).toBe(true);
    expect(typeof completeRes.json.data.setupCompletedAt).toBe("string");

    // 5. Verify needsSetup = false
    const finalStatusRes = await apiFetch<{
      ok: boolean;
      data: { needsSetup: boolean; setupCompletedAt: string | null };
    }>(env.baseUrl, env.accessToken, "GET", "/v1/setup/status");
    expect(finalStatusRes.status).toBe(200);
    expect(finalStatusRes.json.data.needsSetup).toBe(false);
    expect(finalStatusRes.json.data.setupCompletedAt).not.toBeNull();
  });
});

// ─── Agent journeys parameterized across streaming-capable providers ───
// Google Generative AI is excluded — it uses non-streaming JSON and isn't
// supported by the agent LLM client's streaming path. It's tested separately
// in the provider-matrix test suite.

describe.each(STREAMING_PROVIDER_MATRIX)(
  "Friday Mock Journeys E2E — $kind ($api)",
  (entry: ProviderMatrixEntry) => {
    let env: MockHubEnv;

    beforeAll(async () => {
      env = await createMockHubEnv({ providerKinds: [entry.kind] });
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

    it("Agent conversation with mock LLM response", async () => {
      const mock = env.mockFor(entry.kind);
      const provider = env.providers[entry.kind]!;

      // Enqueue deterministic response
      mock.setDefault({
        type: "text",
        text: "Here are 3 facts about octopuses: They have 3 hearts, blue blood, and 8 arms.",
      });

      // 1. Start agent run
      const runRes = await apiFetch<{
        ok: boolean;
        data: {
          runId: string;
          status: string;
          response: string;
          toolCallCount: number;
          durationMs: number;
        };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/agent/runs", {
        task: "Tell me 3 interesting facts about octopuses.",
        providerId: provider.providerId,
        model: provider.model,
        timeoutMs: MOCK_E2E_TIMEOUT_MS,
      });

      expect(runRes.status).toBe(200);
      expect(runRes.json.ok).toBe(true);
      expect(runRes.json.data.runId).toBeTruthy();
      expect(runRes.json.data.status).toBe("completed");
      expect(runRes.json.data.response).toContain("octopus");

      // 2. Verify mock was called
      expect(mock.calls.length).toBeGreaterThanOrEqual(1);

      // 3. Verify run is persisted
      const getRunRes = await apiFetch<{
        ok: boolean;
        data: { run: { id: string; status: string; task: string } };
      }>(env.baseUrl, env.accessToken, "GET", `/v1/agent/runs/${runRes.json.data.runId}`);
      expect(getRunRes.status).toBe(200);
      expect(getRunRes.json.data.run.status).toBe("completed");

      // 4. Store and search memory
      const storeRes = await apiFetch<{
        ok: boolean;
        data: { item: { id: string } };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/memory/store", {
        namespace: `mock-e2e-${entry.kind}`,
        content: `Agent said: ${runRes.json.data.response.slice(0, 500)}`,
        source: "agent-run",
        tags: ["agent", "octopus"],
      });
      expect(storeRes.status).toBe(200);
      expect(storeRes.json.ok).toBe(true);

      const searchRes = await apiFetch<{
        ok: boolean;
        data: { items: Array<{ item: { content: string }; score: number }> };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/memory/search", {
        query: "octopus facts",
        namespace: `mock-e2e-${entry.kind}`,
      });
      expect(searchRes.status).toBe(200);
      expect(searchRes.json.data.items.length).toBeGreaterThanOrEqual(1);
    });

    it("Self-diagnosis with mock LLM", async () => {
      const mock = env.mockFor(entry.kind);
      const provider = env.providers[entry.kind]!;

      // Enqueue diagnosis response
      mock.setDefault({
        type: "text",
        text: "The workflow references a nonexistent skill 'nonexistent-skill-xyz'. This will cause a runtime error because the skill cannot be found. Fix: replace with a valid skill ID or create the missing skill.",
      });

      // Ask the agent to diagnose
      const diagRunRes = await apiFetch<{
        ok: boolean;
        data: { runId: string; status: string; response: string };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/agent/runs", {
        task: 'Analyze this workflow: it references "nonexistent-skill-xyz" which does not exist. What problems would this cause?',
        providerId: provider.providerId,
        model: provider.model,
        timeoutMs: MOCK_E2E_TIMEOUT_MS,
      });

      expect(diagRunRes.status).toBe(200);
      expect(diagRunRes.json.ok).toBe(true);
      expect(diagRunRes.json.data.status).toBe("completed");

      // Agent should mention the missing skill issue
      const response = diagRunRes.json.data.response.toLowerCase();
      expect(
        response.includes("nonexist") ||
        response.includes("not found") ||
        response.includes("missing") ||
        response.includes("skill"),
      ).toBe(true);

      // Verify mock calls
      expect(mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it("Automation lifecycle (create → run → disable → re-enable → run)", { timeout: MOCK_E2E_TIMEOUT_MS }, async () => {
      const mock = env.mockFor(entry.kind);
      const provider = env.providers[entry.kind]!;

      mock.setDefault({
        type: "text",
        text: "Today's weather summary: Clear skies, 72°F with light breeze.",
      });

      // 1. Create automation
      const createRes = await apiFetch<{
        ok: boolean;
        data: {
          automation: { id: string; name: string; enabled: boolean; runCount: number };
        };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/agent/automations", {
        name: `Mock Report (${entry.kind})`,
        description: "Automated summary for mock E2E testing",
        taskTemplate: "Generate a one-sentence weather summary.",
        enabled: true,
      });
      expect(createRes.status).toBe(200);
      expect(createRes.json.ok).toBe(true);
      const automationId = createRes.json.data.automation.id;
      expect(createRes.json.data.automation.enabled).toBe(true);
      expect(createRes.json.data.automation.runCount).toBe(0);

      // 2. Run the automation
      const run1Res = await apiFetch<{
        ok: boolean;
        data: { result: { runId: string; status: string; response: string } };
      }>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/agent/automations/${automationId}/run`,
        {
          providerId: provider.providerId,
          model: provider.model,
          timeoutMs: MOCK_E2E_TIMEOUT_MS,
        },
      );
      expect(run1Res.status).toBe(200);
      expect(run1Res.json.ok).toBe(true);
      expect(run1Res.json.data.result.status).toBe("completed");

      // 3. Verify run count incremented
      const getRes1 = await apiFetch<{
        ok: boolean;
        data: { automation: { runCount: number; enabled: boolean } };
      }>(env.baseUrl, env.accessToken, "GET", `/v1/agent/automations/${automationId}`);
      expect(getRes1.json.data.automation.runCount).toBe(1);

      // 4. Disable
      const disableRes = await apiFetch<{
        ok: boolean;
        data: { automation: { enabled: boolean } };
      }>(env.baseUrl, env.accessToken, "PATCH", `/v1/agent/automations/${automationId}`, {
        enabled: false,
      });
      expect(disableRes.json.data.automation.enabled).toBe(false);

      // 5. Re-enable
      const enableRes = await apiFetch<{
        ok: boolean;
        data: { automation: { enabled: boolean } };
      }>(env.baseUrl, env.accessToken, "PATCH", `/v1/agent/automations/${automationId}`, {
        enabled: true,
      });
      expect(enableRes.json.data.automation.enabled).toBe(true);

      // 6. Run again
      const run2Res = await apiFetch<{
        ok: boolean;
        data: { result: { status: string } };
      }>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/agent/automations/${automationId}/run`,
        {
          providerId: provider.providerId,
          model: provider.model,
          timeoutMs: MOCK_E2E_TIMEOUT_MS,
        },
      );
      expect(run2Res.json.data.result.status).toBe("completed");

      // 7. Verify run count = 2
      const getRes2 = await apiFetch<{
        ok: boolean;
        data: { automation: { runCount: number } };
      }>(env.baseUrl, env.accessToken, "GET", `/v1/agent/automations/${automationId}`);
      expect(getRes2.json.data.automation.runCount).toBe(2);

      // 8. Cleanup
      const deleteRes = await apiFetch<{
        ok: boolean;
        data: { deleted: boolean };
      }>(env.baseUrl, env.accessToken, "DELETE", `/v1/agent/automations/${automationId}`);
      expect(deleteRes.json.data.deleted).toBe(true);
    });
  },
);

// ─── Provider failover (exercises real hub fallback/cooldown logic) ───
// The hub's agentLlmClient uses providerService.runWithFallback() to resolve
// credentials. If credential resolution fails for the primary provider,
// the fallback logic kicks in and tries the next candidate.

describe("Friday Mock Journeys E2E — Provider Failover", () => {
  let env: MockHubEnv;

  beforeAll(async () => {
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

  it("Scenario 8: Provider failover — bad primary returns 429, triggers cooldown, good fallback succeeds", async () => {
    const ollamaMock = env.mockFor("ollama");
    const ollamaProvider = env.providers["ollama"]!;

    // Create a bad provider that will route to a mock returning 429 errors.
    // Unlike a credential-missing error, a 429 is a transient-pattern error
    // that triggers the actual cooldown logic in friday-provider-fallback.ts.
    const badProviderRes = await apiFetch<{
      ok: boolean;
      data: { provider: { id: string } };
    }>(env.baseUrl, env.accessToken, "POST", "/v1/providers", {
      kind: "openai-compatible",
      name: "Bad Provider (Mock 429)",
      baseUrl: "https://mock.bad-provider.local",
      authMode: "api-key",
      api: "openai-completions",
      apiKey: "mock-key-for-bad-provider",
      supportedModels: ["mock-bad"],
      defaultModel: "mock-bad",
      enabled: true,
      validateOnSave: false,
      runtimeCapabilities: [
        {
          capability: "text",
          model: "mock-bad",
          status: "verified",
          verified: true,
          verifiedAt: new Date(0).toISOString(),
          notes: "Mock failover provider is backed by deterministic test fetch.",
        },
      ],
    });
    expect(badProviderRes.status).toBe(200);
    const badProviderId = badProviderRes.json.data.provider.id;

    // Register a mock fetch route for the bad provider that returns 429
    const { createMockFetch: createMock } = await import("../../../test/_mocks/mock-llm-providers.js");
    const badMock = createMock("openai-completions");
    badMock.setDefault({
      type: "http_error",
      status: 429,
      body: { error: { message: "rate_limit exceeded — try again later", type: "rate_limit_error" } },
    });

    // Inject the bad-provider route into the existing fetch router
    const currentFetch = globalThis.fetch as MockFetchRouter;
    currentFetch.routes.push({
      urlPrefix: "https://mock.bad-provider.local",
      api: "openai-completions",
      mockFetch: badMock,
    });

    // Set routing: bad provider as primary, good ollama as fallback.
    // The bad provider returns 429, which triggers cooldown and failover.
    await apiFetch(env.baseUrl, env.accessToken, "PUT", "/v1/model-routing", {
      defaultProviderId: badProviderId,
      fallbackProviderIds: [ollamaProvider.providerId],
    });

    // Pin the mock-bad route for the default task profile so this scenario
    // deterministically exercises the 429 cooldown path instead of allowing
    // cost/learning reordering to bypass the primary candidate.
    await apiFetch(env.baseUrl, env.accessToken, "POST", "/v1/providers/routing/pin", {
      taskProfileId: "default",
      providerId: badProviderId,
      model: "mock-bad",
      backendKind: "http",
      reason: "mock-failover-test",
    });

    // Set up the good mock to respond
    ollamaMock.setDefault({
      type: "text",
      text: "FAILOVER_OK",
    });

    // Run an agent task — bad provider returns 429, hub cools it down and falls back
    const runRes = await apiFetch<{
      ok: boolean;
      data: {
        runId: string;
        status: string;
        response: string;
      };
    }>(env.baseUrl, env.accessToken, "POST", "/v1/agent/runs", {
      task: 'Say exactly "FAILOVER_OK" and nothing else.',
      timeoutMs: 15_000,
    });

    expect(runRes.status).toBe(200);
    expect(runRes.json.ok).toBe(true);

    // Strictly assert completed — not "failed"
    expect(runRes.json.data.status).toBe("completed");
    expect(runRes.json.data.response).toContain("FAILOVER_OK");

    // Verify the bad mock was hit (proving the 429 path was exercised)
    expect(badMock.calls.length).toBeGreaterThanOrEqual(1);

    // Verify the fallback mock was called (the bad provider failed, good one succeeded)
    expect(ollamaMock.calls.length).toBeGreaterThanOrEqual(1);

    // Remove the bad-provider route to clean up
    const routeIdx = currentFetch.routes.findIndex(
      (r) => r.urlPrefix === "https://mock.bad-provider.local",
    );
    if (routeIdx >= 0) currentFetch.routes.splice(routeIdx, 1);

    // Restore routing
    await apiFetch(env.baseUrl, env.accessToken, "PUT", "/v1/model-routing", {
      defaultProviderId: ollamaProvider.providerId,
      fallbackProviderIds: [],
    });
  });
});
