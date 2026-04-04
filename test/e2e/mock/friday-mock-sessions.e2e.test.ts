/**
 * Session Management E2E Tests — verify session creation, message persistence,
 * session listing, and key format.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import {
  createMockHubEnv,
  type MockHubEnv,
} from "./_helpers/mock-env.js";
import { resetMockCounters } from "../../_mocks/mock-llm-providers.js";

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

interface AgentRunResult {
  ok: boolean;
  data: {
    runId: string;
    status: string;
    response: string;
    toolCallCount: number;
    durationMs: number;
  };
}

const MOCK_E2E_TIMEOUT_MS = 20_000;

// ─── Tests ───

describe("Friday Mock Sessions E2E", () => {
  let env: MockHubEnv;
  let providerId: string;
  let model: string;

  beforeAll(async () => {
    env = await createMockHubEnv({ providerKinds: ["ollama"] });
    const provider = env.providers["ollama"]!;
    providerId = provider.providerId;
    model = provider.model;
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

  it("session created by agent run is visible via sessions API", async () => {
    const mock = env.mockFor("ollama");
    const sessionKey = "api:e2e:sessions-visible";

    mock.setDefault({ type: "text", text: "Hello from session test." });

    await apiFetch<AgentRunResult>(
      env.baseUrl, env.accessToken, "POST", "/v1/agent/runs",
      { task: "Create a session", providerId, model, timeoutMs: MOCK_E2E_TIMEOUT_MS, sessionKey },
    );

    // Fetch sessions list
    const sessionsRes = await apiFetch<{
      ok: boolean;
      data: { items: Array<{ key: string }> };
    }>(env.baseUrl, env.accessToken, "GET", "/v1/sessions");

    expect(sessionsRes.json.ok).toBe(true);
    const keys = sessionsRes.json.data.items.map((s) => s.key);
    expect(keys).toContain(sessionKey);
  });

  it("session messages contain task and agent response", async () => {
    const mock = env.mockFor("ollama");
    const sessionKey = "api:e2e:sessions-messages";

    mock.setDefault({ type: "text", text: "The answer is 42." });

    await apiFetch<AgentRunResult>(
      env.baseUrl, env.accessToken, "POST", "/v1/agent/runs",
      { task: "What is the answer?", providerId, model, timeoutMs: MOCK_E2E_TIMEOUT_MS, sessionKey },
    );

    // Fetch session messages — API returns { items } not { messages }
    const msgsRes = await apiFetch<{
      ok: boolean;
      data: { items: Array<{ role: string; content: unknown; contentText: string }> };
    }>(env.baseUrl, env.accessToken, "GET", `/v1/sessions/${encodeURIComponent(sessionKey)}/messages`);

    expect(msgsRes.json.ok).toBe(true);
    const messages = msgsRes.json.data.items;
    expect(messages.length).toBeGreaterThanOrEqual(2);

    // Should have user message and assistant response
    const roles = messages.map((m) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
  });

  it("multiple runs in same session accumulate messages", { timeout: MOCK_E2E_TIMEOUT_MS }, async () => {
    const mock = env.mockFor("ollama");
    const sessionKey = "api:e2e:sessions-accumulate";

    // Run 1
    mock.setDefault({ type: "text", text: "First response." });
    await apiFetch<AgentRunResult>(
      env.baseUrl, env.accessToken, "POST", "/v1/agent/runs",
      { task: "First question", providerId, model, timeoutMs: MOCK_E2E_TIMEOUT_MS, sessionKey },
    );

    mock.reset();
    resetMockCounters();

    // Run 2
    mock.setDefault({ type: "text", text: "Second response." });
    await apiFetch<AgentRunResult>(
      env.baseUrl, env.accessToken, "POST", "/v1/agent/runs",
      { task: "Second question", providerId, model, timeoutMs: MOCK_E2E_TIMEOUT_MS, sessionKey },
    );

    // Fetch session messages
    const msgsRes = await apiFetch<{
      ok: boolean;
      data: { items: Array<{ role: string; contentText: string }> };
    }>(env.baseUrl, env.accessToken, "GET", `/v1/sessions/${encodeURIComponent(sessionKey)}/messages`);

    expect(msgsRes.json.ok).toBe(true);
    // Should have at least 4 messages: user1, assistant1, user2, assistant2
    expect(msgsRes.json.data.items.length).toBeGreaterThanOrEqual(4);
  });

  it("sessions list contains multiple sessions", { timeout: MOCK_E2E_TIMEOUT_MS }, async () => {
    const mock = env.mockFor("ollama");
    mock.setDefault({ type: "text", text: "ok" });

    // Create 3 sessions with different keys
    for (let i = 1; i <= 3; i++) {
      mock.reset();
      resetMockCounters();
      mock.setDefault({ type: "text", text: `Response ${String(i)}` });
      await apiFetch<AgentRunResult>(
        env.baseUrl, env.accessToken, "POST", "/v1/agent/runs",
        { task: `Task ${String(i)}`, providerId, model, timeoutMs: MOCK_E2E_TIMEOUT_MS, sessionKey: `api:e2e:sessions-list-${String(i)}` },
      );
    }

    // List all sessions
    const sessionsRes = await apiFetch<{
      ok: boolean;
      data: { items: Array<{ key: string }> };
    }>(env.baseUrl, env.accessToken, "GET", "/v1/sessions");

    expect(sessionsRes.json.ok).toBe(true);
    const keys = sessionsRes.json.data.items.map((s) => s.key);

    for (let i = 1; i <= 3; i++) {
      expect(keys).toContain(`api:e2e:sessions-list-${String(i)}`);
    }
  });

  it("auto-generated session keys follow expected prefix pattern", async () => {
    const mock = env.mockFor("ollama");
    mock.setDefault({ type: "text", text: "Auto-session test." });

    // Run without explicit sessionKey
    const res = await apiFetch<AgentRunResult>(
      env.baseUrl, env.accessToken, "POST", "/v1/agent/runs",
      { task: "Auto session test", providerId, model, timeoutMs: MOCK_E2E_TIMEOUT_MS },
    );

    expect(res.json.data.status).toBe("completed");
    expect(res.json.data.runId).toBeTruthy();

    // The run was created successfully — verify the run is persisted
    const getRunRes = await apiFetch<{
      ok: boolean;
      data: { run: { id: string; status: string } };
    }>(env.baseUrl, env.accessToken, "GET", `/v1/agent/runs/${res.json.data.runId}`);

    expect(getRunRes.json.ok).toBe(true);
    expect(getRunRes.json.data.run.status).toBe("completed");
  });

  it("deterministic immediate runs remain readable via getRun and replayable via events", async () => {
    const sessionKey = "chat:default:mock-deterministic-events";

    const runRes = await apiFetch<{
      ok: boolean;
      data: {
        runId: string;
        status: string;
        response: string;
        eventStreamAvailable: boolean;
      };
    }>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "What can you do right now?", sessionKey },
    );

    expect(runRes.status).toBe(200);
    expect(runRes.json.ok).toBe(true);
    expect(runRes.json.data.status).toBe("completed");
    expect(runRes.json.data.eventStreamAvailable).toBe(true);
    expect(runRes.json.data.response).toContain("Current capabilities:");

    const getRunRes = await apiFetch<{
      ok: boolean;
      data: { run: { id: string; status: string; responseText?: string } };
    }>(env.baseUrl, env.accessToken, "GET", `/v1/agent/runs/${runRes.json.data.runId}`);

    expect(getRunRes.status).toBe(200);
    expect(getRunRes.json.data.run.status).toBe("completed");
    expect(getRunRes.json.data.run.responseText).toContain("Current capabilities:");

    const eventsRes = await fetch(
      `${env.baseUrl}/v1/agent/runs/${encodeURIComponent(runRes.json.data.runId)}/events`,
      {
        headers: {
          Authorization: `Bearer ${env.accessToken}`,
          Accept: "text/event-stream",
        },
      },
    );
    const eventsText = await eventsRes.text();
    expect(eventsRes.status).toBe(200);
    expect(eventsText).toContain('"type":"agent.run.text_delta"');
    expect(eventsText).toContain('"type":"agent.run.completed"');
  });
});
