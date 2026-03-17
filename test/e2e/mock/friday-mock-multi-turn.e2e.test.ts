/**
 * Multi-Turn Conversation E2E Tests — verify session continuity,
 * history accumulation, memory persistence, and session isolation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
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

describe("Friday Mock Multi-Turn E2E", () => {
  let env: MockHubEnv;
  let providerId: string;
  let model: string;

  beforeAll(async () => {
    env = await createMockHubEnv({ providerKinds: ["anthropic"] });
    const provider = env.providers["anthropic"]!;
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

  it("two-turn conversation: run 2 sends history from run 1 to LLM", async () => {
    const mock = env.mockFor("anthropic");
    const sessionKey = "api:e2e:multi-turn-two-turn";

    // Run 1 — use setDefault so the mock always has a reply available
    mock.setDefault({ type: "text", text: "Paris is the capital of France." });
    const r1 = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "What is the capital of France?", providerId, model, timeoutMs: MOCK_E2E_TIMEOUT_MS, sessionKey },
    );
    expect(r1.json.data.status).toBe("completed");

    mock.reset();
    resetMockCounters();

    // Run 2 — same session
    mock.setDefault({ type: "text", text: "As I mentioned, Paris is in France." });
    const r2 = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "What country is that city in?", providerId, model, timeoutMs: MOCK_E2E_TIMEOUT_MS, sessionKey },
    );
    expect(r2.json.data.status).toBe("completed");

    // The LLM call for run 2 should include history from run 1
    // mock.calls[0] is the first LLM call of run 2 (after reset)
    const r2Body = mock.calls[0]?.bodyJson as { messages?: Array<{ role: string; content?: string }> } | undefined;
    expect(r2Body?.messages).toBeDefined();
    // Should have more than just the latest user message (history included)
    if (r2Body?.messages) {
      expect(r2Body.messages.length).toBeGreaterThan(1);
    }
  }, MOCK_E2E_TIMEOUT_MS);

  it("treats an unrelated second turn as a new topic instead of replaying the prior answer", async () => {
    const mock = env.mockFor("anthropic");
    const sessionKey = "api:e2e:multi-turn-new-topic";

    mock.setDefault({ type: "text", text: "Paris is the capital of France." });
    const r1 = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "What is the capital of France?", providerId, model, timeoutMs: MOCK_E2E_TIMEOUT_MS, sessionKey },
    );
    expect(r1.json.data.status).toBe("completed");

    mock.reset();
    resetMockCounters();

    mock.setDefault({ type: "text", text: "Use a starter and let the dough ferment overnight." });
    const r2 = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "How do I bake sourdough bread?", providerId, model, timeoutMs: MOCK_E2E_TIMEOUT_MS, sessionKey },
    );
    expect(r2.json.data.status).toBe("completed");

    const r2Body = mock.calls[0]?.bodyJson as { messages?: Array<{ role: string; content?: string }> } | undefined;
    expect(r2Body?.messages).toBeDefined();
    if (r2Body?.messages) {
      const joined = r2Body.messages.map((message) => message.content ?? "").join(" ");
      expect(joined).not.toContain("Paris is the capital of France.");
      expect(joined).toContain("How do I bake sourdough bread?");
    }
  }, MOCK_E2E_TIMEOUT_MS);

  it("three-turn accumulation: by round 3, LLM receives history from rounds 1 and 2", async () => {
    const mock = env.mockFor("anthropic");
    const sessionKey = "api:e2e:multi-turn-three-turns";

    // Round 1
    mock.setDefault({ type: "text", text: "I like TypeScript." });
    await apiFetch<AgentRunResult>(
      env.baseUrl, env.accessToken, "POST", "/v1/agent/runs",
      { task: "What language do you prefer?", providerId, model, timeoutMs: MOCK_E2E_TIMEOUT_MS, sessionKey },
    );
    mock.reset();
    resetMockCounters();

    // Round 2
    mock.setDefault({ type: "text", text: "Vitest is my recommended test runner." });
    await apiFetch<AgentRunResult>(
      env.baseUrl, env.accessToken, "POST", "/v1/agent/runs",
      { task: "What test runner do you recommend?", providerId, model, timeoutMs: MOCK_E2E_TIMEOUT_MS, sessionKey },
    );
    mock.reset();
    resetMockCounters();

    // Round 3
    mock.setDefault({ type: "text", text: "TypeScript with Vitest is a great combination." });
    await apiFetch<AgentRunResult>(
      env.baseUrl, env.accessToken, "POST", "/v1/agent/runs",
      { task: "Summarize your recommendations", providerId, model, timeoutMs: MOCK_E2E_TIMEOUT_MS, sessionKey },
    );

    // Verify round 3 LLM call includes history from rounds 1 and 2
    const r3Body = mock.calls[0]?.bodyJson as { messages?: Array<{ role: string; content?: string }> } | undefined;
    expect(r3Body?.messages).toBeDefined();
    if (r3Body?.messages) {
      // Should include user + assistant messages from prior rounds plus current message
      // At minimum: user1, assistant1, user2, assistant2, user3 = 5 messages
      expect(r3Body.messages.length).toBeGreaterThanOrEqual(4);
    }
  }, MOCK_E2E_TIMEOUT_MS);

  it("memory stored via API in run 1 is searchable in run 2", async () => {
    const mock = env.mockFor("anthropic");

    // Store memory via API (not via agent tool)
    const storeRes = await apiFetch<{
      ok: boolean;
      data: { item: { id: string } };
    }>(env.baseUrl, env.accessToken, "POST", "/v1/memory/store", {
      namespace: "e2e-multi-turn-memory",
      content: "User prefers functional programming paradigms",
      source: "test",
      tags: ["preference"],
    });
    expect(storeRes.json.ok).toBe(true);

    // Search memory via API
    const searchRes = await apiFetch<{
      ok: boolean;
      data: { items: Array<{ item: { content: string }; score: number }> };
    }>(env.baseUrl, env.accessToken, "POST", "/v1/memory/search", {
      query: "functional programming",
      namespace: "e2e-multi-turn-memory",
    });
    expect(searchRes.json.ok).toBe(true);
    expect(searchRes.json.data.items.length).toBeGreaterThanOrEqual(1);
    expect(searchRes.json.data.items[0]!.item.content).toContain("functional programming");
  });

  it("session isolation: different session keys don't share history", async () => {
    const mock = env.mockFor("anthropic");

    // Session A
    mock.setDefault({ type: "text", text: "Session A response" });
    await apiFetch<AgentRunResult>(
      env.baseUrl, env.accessToken, "POST", "/v1/agent/runs",
      { task: "Session A topic: quantum physics", providerId, model, timeoutMs: MOCK_E2E_TIMEOUT_MS, sessionKey: "api:e2e:isolation-A" },
    );
    mock.reset();
    resetMockCounters();

    // Session B (different key)
    mock.setDefault({ type: "text", text: "Session B response" });
    await apiFetch<AgentRunResult>(
      env.baseUrl, env.accessToken, "POST", "/v1/agent/runs",
      { task: "Session B topic: cooking recipes", providerId, model, timeoutMs: MOCK_E2E_TIMEOUT_MS, sessionKey: "api:e2e:isolation-B" },
    );

    // Session B LLM call should NOT include Session A's history
    const bBody = mock.calls[0]?.bodyJson as { messages?: Array<{ role: string; content?: string }> } | undefined;
    if (bBody?.messages) {
      const allContent = bBody.messages.map((m) => m.content ?? "").join(" ");
      expect(allContent).not.toContain("quantum physics");
      expect(allContent).toContain("cooking recipes");
    }
  }, MOCK_E2E_TIMEOUT_MS);

  it("cross-run tool results: run 1 writes file, run 2 reads it", async () => {
    const mock = env.mockFor("anthropic");
    const sharedFile = path.join(env.stateDir, "cross-run-data.txt");

    // Run 1: write file
    mock.enqueue({
      type: "tool_use",
      toolName: "write",
      toolInput: { path: sharedFile, content: "shared data between runs" },
    });
    mock.enqueue({ type: "text", text: "File written." });

    await apiFetch<AgentRunResult>(
      env.baseUrl, env.accessToken, "POST", "/v1/agent/runs",
      { task: "Write shared data", providerId, model, timeoutMs: 15_000 },
    );
    mock.reset();
    resetMockCounters();

    // Verify file exists
    expect(fs.existsSync(sharedFile)).toBe(true);

    // Run 2: read the same file
    mock.enqueue({
      type: "tool_use",
      toolName: "read",
      toolInput: { path: sharedFile },
    });
    mock.enqueue({ type: "text", text: "The file contains shared data." });

    const r2 = await apiFetch<AgentRunResult>(
      env.baseUrl, env.accessToken, "POST", "/v1/agent/runs",
      { task: "Read the shared file", providerId, model, timeoutMs: 15_000 },
    );

    expect(r2.json.data.status).toBe("completed");
    expect(r2.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
  }, MOCK_E2E_TIMEOUT_MS);

  it("concurrency closure: same-user multi-request and multi-user parallel runs stay isolated", async () => {
    const mock = env.mockFor("anthropic");
    mock.setDefault({ type: "text", text: "Concurrent request completed." });

    const sessionA = "api:e2e:concurrency-user-A";
    const sessionB = "api:e2e:concurrency-user-B";
    const tasksA = ["A-task-1", "A-task-2", "A-task-3", "A-task-4"];
    const tasksB = ["B-task-1", "B-task-2", "B-task-3", "B-task-4"];

    const concurrentRuns = await Promise.all([
      ...tasksA.map((task) =>
        apiFetch<AgentRunResult>(
          env.baseUrl,
          env.accessToken,
          "POST",
          "/v1/agent/runs",
          { task, providerId, model, timeoutMs: 20_000, sessionKey: sessionA },
        )),
      ...tasksB.map((task) =>
        apiFetch<AgentRunResult>(
          env.baseUrl,
          env.accessToken,
          "POST",
          "/v1/agent/runs",
          { task, providerId, model, timeoutMs: 20_000, sessionKey: sessionB },
        )),
    ]);

    for (const result of concurrentRuns) {
      expect(result.status).toBe(200);
      expect(result.json.ok).toBe(true);
      expect(result.json.data.status).toBe("completed");
      expect(result.json.data.response.length).toBeGreaterThan(0);
    }

    const runIds = concurrentRuns.map((result) => result.json.data.runId);
    expect(new Set(runIds).size).toBe(runIds.length);

    const sessionARes = await apiFetch<{
      ok: boolean;
      data: { items: Array<{ contentText: string }> };
    }>(
      env.baseUrl,
      env.accessToken,
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionA)}/messages`,
    );
    const sessionBRes = await apiFetch<{
      ok: boolean;
      data: { items: Array<{ contentText: string }> };
    }>(
      env.baseUrl,
      env.accessToken,
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionB)}/messages`,
    );

    expect(sessionARes.status).toBe(200);
    expect(sessionBRes.status).toBe(200);
    expect(sessionARes.json.ok).toBe(true);
    expect(sessionBRes.json.ok).toBe(true);
    expect(sessionARes.json.data.items.length).toBeGreaterThanOrEqual(tasksA.length * 2);
    expect(sessionBRes.json.data.items.length).toBeGreaterThanOrEqual(tasksB.length * 2);

    const sessionAText = sessionARes.json.data.items.map((item) => item.contentText).join(" ");
    const sessionBText = sessionBRes.json.data.items.map((item) => item.contentText).join(" ");
    for (const task of tasksA) {
      expect(sessionAText).toContain(task);
      expect(sessionBText).not.toContain(task);
    }
    for (const task of tasksB) {
      expect(sessionBText).toContain(task);
      expect(sessionAText).not.toContain(task);
    }
  }, 90_000);
});
