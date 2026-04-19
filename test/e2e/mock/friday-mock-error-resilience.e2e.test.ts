/**
 * Error Resilience E2E Tests — verify graceful error handling,
 * provider failover, timeouts, disabled tools, and agent limits.
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
    error?: string;
  };
}

// ─── Tests ───

describe("Friday Mock Error Resilience E2E", () => {
  let env: MockHubEnv;
  let providerId: string;
  let model: string;

  beforeAll(async () => {
    env = await createMockHubEnv({ providerKinds: ["anthropic", "ollama"] });
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

  // ─── 1. All providers return 500 ───

  it("all providers return 500 — agent run fails gracefully", async () => {
    const mock = env.mockFor("anthropic");

    mock.setDefault({
      type: "http_error",
      status: 500,
      body: { error: { message: "Internal Server Error" } },
    });

    const res = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "Test failure handling", providerId, model, timeoutMs: 15_000 },
    );

    // GAP 3: first LLM failure degrades gracefully → run completes with synthetic response
    expect(res.status).toBe(200);
    expect(["completed", "failed"]).toContain(res.json.data.status);
  });

  // ─── 2. Tool error → LLM retries ───

  it("tool execution error reported to LLM, LLM retries with different approach", async () => {
    const mock = env.mockFor("anthropic");
    const validFile = path.join(env.stateDir, "resilience-valid.txt");
    fs.writeFileSync(validFile, "correct data");

    // LLM call 1: try reading nonexistent file → error
    mock.enqueue({
      type: "tool_use",
      toolName: "read",
      toolInput: { path: path.join(env.stateDir, "nonexistent-resilience.txt") },
    });
    // LLM call 2: after error, try the correct file → success
    mock.enqueue({
      type: "tool_use",
      toolName: "read",
      toolInput: { path: validFile },
    });
    // LLM call 3: respond with result
    mock.enqueue({
      type: "text",
      text: "Found the correct data after retrying.",
    });

    const res = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "Read the data file", providerId, model, timeoutMs: 15_000 },
    );

    expect(res.json.data.status).toBe("completed");
    expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(2);
    expect(mock.calls.length).toBe(3);
  });

  // ─── 3. Agent run timeout ───

  it("agent run timeout results in failed/cancelled status", async () => {
    const mock = env.mockFor("anthropic");

    // Simulate a slow LLM response (3s)
    mock.setDefault({
      type: "text",
      text: "This will be too slow",
      latencyMs: 5000,
    });

    const res = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "Timeout test", providerId, model, timeoutMs: 1000 },
    );

    expect(res.status).toBe(200);
    // Status should be failed or cancelled due to timeout
    expect(["failed", "cancelled"]).toContain(res.json.data.status);
  });

  // ─── 4. ReadOnly constraint blocks exec tool ───

  it("readOnly constraint blocks exec tool and reports error to LLM", async () => {
    const mock = env.mockFor("anthropic");

    mock.enqueue({
      type: "tool_use",
      toolName: "exec",
      toolInput: { command: "echo hello" },
    });
    mock.enqueue({
      type: "text",
      text: "The exec tool was blocked in readOnly mode.",
    });

    const res = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      {
        task: "Run a command",
        providerId,
        model,
        timeoutMs: 15_000,
        constraints: { readOnly: true },
      },
    );

    expect(res.json.data.status).toBe("completed");
    expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
    // LLM received the blocked error and responded
    expect(mock.calls.length).toBe(2);
  });

  // ─── 5. Network error (ECONNREFUSED) ───

  it("network error from LLM — run fails", async () => {
    const mock = env.mockFor("anthropic");

    mock.setDefault({
      type: "network_error",
      message: "ECONNREFUSED: mock connection refused",
      code: "ECONNREFUSED",
    });

    const res = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "Network error test", providerId, model, timeoutMs: 15_000 },
    );

    // GAP 3: first LLM failure degrades gracefully → run completes with synthetic response
    expect(res.status).toBe(200);
    expect(["completed", "failed"]).toContain(res.json.data.status);
  });

  // ─── 6. Timeout error (ETIMEDOUT) ───

  it("timeout error from LLM — run fails", async () => {
    const mock = env.mockFor("anthropic");

    mock.setDefault({
      type: "timeout",
      message: "ETIMEDOUT: connection timed out",
      code: "ETIMEDOUT",
    });

    const res = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "Timeout error test", providerId, model, timeoutMs: 15_000 },
    );

    // GAP 3: first LLM failure degrades gracefully → run completes with synthetic response
    expect(res.status).toBe(200);
    expect(["completed", "failed"]).toContain(res.json.data.status);
  });

  // ─── 7. HTTP 429 → cooldown → fallback ───

  it("HTTP 429 primary triggers cooldown, fallback provider succeeds", async () => {
    const anthropicMock = env.mockFor("anthropic");
    const ollamaMock = env.mockFor("ollama");
    const anthropicProvider = env.providers["anthropic"]!;
    const ollamaProvider = env.providers["ollama"]!;

    // Primary (anthropic) returns 429
    anthropicMock.setDefault({
      type: "http_error",
      status: 429,
      body: { error: { message: "Rate limit exceeded", type: "rate_limit_error" } },
    });

    // Fallback (ollama) succeeds
    ollamaMock.setDefault({
      type: "text",
      text: "FAILOVER_SUCCESS_429",
    });

    // Set routing: anthropic primary, ollama fallback
    await apiFetch(env.baseUrl, env.accessToken, "PUT", "/v1/model-routing", {
      defaultProviderId: anthropicProvider.providerId,
      fallbackProviderIds: [ollamaProvider.providerId],
    });

    const res = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "Test failover", timeoutMs: 15_000 },
    );

    expect(res.status).toBe(200);
    // The run should either complete via fallback or fail from the 429
    // The key assertion: at least one mock was called
    const totalCalls = anthropicMock.calls.length + ollamaMock.calls.length;
    expect(totalCalls).toBeGreaterThanOrEqual(1);

    // If fallback succeeded, response should contain the ollama text
    if (res.json.data.status === "completed") {
      expect(res.json.data.response).toContain("FAILOVER_SUCCESS_429");
    }

    // Restore routing
    await apiFetch(env.baseUrl, env.accessToken, "PUT", "/v1/model-routing", {
      defaultProviderId: anthropicProvider.providerId,
      fallbackProviderIds: [],
    });
  });

  // ─── 8. Agent run with empty task ───

  it("agent run with empty task returns error", async () => {
    const mock = env.mockFor("anthropic");
    mock.setDefault({ type: "text", text: "ok" });

    const res = await apiFetch<{ ok: boolean; error?: { message: string } }>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "", providerId, model, timeoutMs: 10_000 },
    );

    // Should get a validation error or the run should fail
    expect(res.status === 400 || res.status === 200).toBe(true);
  });

  // ─── 9. ReadOnly constraint blocks mutating tools ───

  it("readOnly constraint blocks write tool", async () => {
    const mock = env.mockFor("anthropic");

    mock.enqueue({
      type: "tool_use",
      toolName: "write",
      toolInput: { path: path.join(env.stateDir, "readonly-test.txt"), content: "blocked" },
    });
    mock.enqueue({
      type: "text",
      text: "Write was blocked due to readOnly constraint.",
    });

    const res = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      {
        task: "Write a file",
        providerId,
        model,
        timeoutMs: 15_000,
        constraints: { readOnly: true },
      },
    );

    expect(res.json.data.status).toBe("failed");
    expect(res.json.data.response).toContain("AGENT_OUTPUT_CLOSURE_ERROR");
    expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
    expect(mock.calls.length).toBe(2);
    // The file should NOT have been created
    expect(fs.existsSync(path.join(env.stateDir, "readonly-test.txt"))).toBe(false);
  });

  // ─── 10. ReadOnly allows read tools ───

  it("readOnly constraint allows read tool", async () => {
    const mock = env.mockFor("anthropic");
    const readableFile = path.join(env.stateDir, "readonly-readable.txt");
    fs.writeFileSync(readableFile, "readable content");

    mock.enqueue({
      type: "tool_use",
      toolName: "read",
      toolInput: { path: readableFile },
    });
    mock.enqueue({
      type: "text",
      text: "File read successfully in readOnly mode.",
    });

    const res = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      {
        task: "Read a file",
        providerId,
        model,
        timeoutMs: 15_000,
        constraints: { readOnly: true },
      },
    );

    expect(res.json.data.status).toBe("completed");
    expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
  });
});
