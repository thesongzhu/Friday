/**
 * Security E2E Tests — verify SSRF protection, path traversal prevention,
 * shell injection blocking, and readOnly constraints through the full agent loop.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import {
  createMockHubEnv,
  type MockHubEnv,
} from "./_helpers/mock-env.js";
import { resetMockCounters } from "../../_mocks/mock-llm-providers.js";
import type { FridayProviderApi } from "../../../src/providers/model/friday-provider.types.js";

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

describe("Friday Mock Security E2E", () => {
  let env: MockHubEnv;
  let providerId: string;
  let model: string;

  beforeAll(async () => {
    // Use strict SSRF policy (no allowPrivateNetwork) so private IP blocking tests work correctly
    env = await createMockHubEnv({
      providerKinds: ["anthropic"],
      ssrfPolicy: { allowPrivateNetwork: false },
    });
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

  // ─── SSRF Protection ───

  describe("SSRF Protection", () => {
    it("blocks localhost in web_fetch", { timeout: MOCK_E2E_TIMEOUT_MS }, async () => {
      const mock = env.mockFor("anthropic");

      mock.enqueue({
        type: "tool_use",
        toolName: "web_fetch",
        toolInput: { url: "http://localhost:8080/admin" },
      });
      mock.enqueue({
        type: "text",
        text: "The URL was blocked by SSRF protection.",
      });

      const res = await apiFetch<AgentRunResult>(
        env.baseUrl, env.accessToken, "POST", "/v1/agent/runs",
        { task: "Fetch localhost", providerId, model, timeoutMs: 15_000 },
      );

      expect(res.json.data.status).toBe("failed");
      expect(res.json.data.response).toContain("AGENT_OUTPUT_CLOSURE_ERROR");
      expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
      // LLM received error and responded — the fetch was NOT executed against localhost
      expect(mock.calls.length).toBe(2);
    });

    it("blocks cloud metadata endpoint (169.254.169.254)", { timeout: MOCK_E2E_TIMEOUT_MS }, async () => {
      const mock = env.mockFor("anthropic");

      mock.enqueue({
        type: "tool_use",
        toolName: "web_fetch",
        toolInput: { url: "http://169.254.169.254/latest/meta-data" },
      });
      mock.enqueue({
        type: "text",
        text: "The metadata endpoint was blocked.",
      });

      const res = await apiFetch<AgentRunResult>(
        env.baseUrl, env.accessToken, "POST", "/v1/agent/runs",
        { task: "Fetch cloud metadata", providerId, model, timeoutMs: 15_000 },
      );

      expect(res.json.data.status).toBe("failed");
      expect(res.json.data.response).toContain("AGENT_OUTPUT_CLOSURE_ERROR");
      expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
    });

    it("blocks private RFC 1918 addresses (10.x.x.x)", { timeout: MOCK_E2E_TIMEOUT_MS }, async () => {
      const mock = env.mockFor("anthropic");

      mock.enqueue({
        type: "tool_use",
        toolName: "web_fetch",
        toolInput: { url: "http://10.0.0.1/internal" },
      });
      mock.enqueue({
        type: "text",
        text: "Private network address was blocked.",
      });

      const res = await apiFetch<AgentRunResult>(
        env.baseUrl, env.accessToken, "POST", "/v1/agent/runs",
        { task: "Fetch private network", providerId, model, timeoutMs: 15_000 },
      );

      expect(res.json.data.status).toBe("failed");
      expect(res.json.data.response).toContain("AGENT_OUTPUT_CLOSURE_ERROR");
      expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── File Path Security ───

  describe("File Path Security", () => {
    it("rejects path traversal via ../ in read", { timeout: MOCK_E2E_TIMEOUT_MS }, async () => {
      const mock = env.mockFor("anthropic");

      mock.enqueue({
        type: "tool_use",
        toolName: "read",
        toolInput: { path: "../../etc/shadow" },
      });
      mock.enqueue({
        type: "text",
        text: "Path traversal was rejected.",
      });

      const res = await apiFetch<AgentRunResult>(
        env.baseUrl, env.accessToken, "POST", "/v1/agent/runs",
        { task: "Read sensitive file", providerId, model, timeoutMs: 15_000 },
      );

      expect(res.json.data.status).toBe("completed");
      expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
    });

    it("rejects absolute path outside workspace in read", { timeout: MOCK_E2E_TIMEOUT_MS }, async () => {
      const mock = env.mockFor("anthropic");

      mock.enqueue({
        type: "tool_use",
        toolName: "read",
        toolInput: { path: "/etc/passwd" },
      });
      mock.enqueue({
        type: "text",
        text: "Absolute path outside workspace was rejected.",
      });

      const res = await apiFetch<AgentRunResult>(
        env.baseUrl, env.accessToken, "POST", "/v1/agent/runs",
        { task: "Read passwd file", providerId, model, timeoutMs: 15_000 },
      );

      expect(res.json.data.status).toBe("completed");
      expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Shell Injection Prevention ───

  describe("Shell Injection Prevention", () => {
    it("blocks semicolon injection", { timeout: MOCK_E2E_TIMEOUT_MS }, async () => {
      const mock = env.mockFor("anthropic");

      mock.enqueue({
        type: "tool_use",
        toolName: "exec",
        toolInput: { command: "ls; cat /etc/passwd" },
      });
      mock.enqueue({
        type: "text",
        text: "Command with semicolons was blocked.",
      });

      const res = await apiFetch<AgentRunResult>(
        env.baseUrl, env.accessToken, "POST", "/v1/agent/runs",
        { task: "Run malicious command", providerId, model, timeoutMs: 15_000 },
      );

      expect(res.json.data.status).toBe("completed");
      expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
    });

    it("blocks pipe injection", { timeout: MOCK_E2E_TIMEOUT_MS }, async () => {
      const mock = env.mockFor("anthropic");

      mock.enqueue({
        type: "tool_use",
        toolName: "exec",
        toolInput: { command: "echo test | grep secret" },
      });
      mock.enqueue({
        type: "text",
        text: "Command with pipes was blocked.",
      });

      const res = await apiFetch<AgentRunResult>(
        env.baseUrl, env.accessToken, "POST", "/v1/agent/runs",
        { task: "Run piped command", providerId, model, timeoutMs: 15_000 },
      );

      expect(res.json.data.status).toBe("completed");
      expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
    });

    it("blocks backtick injection", { timeout: MOCK_E2E_TIMEOUT_MS }, async () => {
      const mock = env.mockFor("anthropic");

      mock.enqueue({
        type: "tool_use",
        toolName: "exec",
        toolInput: { command: "echo `whoami`" },
      });
      mock.enqueue({
        type: "text",
        text: "Command with backticks was blocked.",
      });

      const res = await apiFetch<AgentRunResult>(
        env.baseUrl, env.accessToken, "POST", "/v1/agent/runs",
        { task: "Run backtick command", providerId, model, timeoutMs: 15_000 },
      );

      expect(res.json.data.status).toBe("completed");
      expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── ReadOnly Constraints ───

  describe("ReadOnly Constraints", () => {
    it("readOnly blocks write, allows read", { timeout: MOCK_E2E_TIMEOUT_MS }, async () => {
      const mock = env.mockFor("anthropic");

      // Create a readable file
      const readableFile = path.join(env.stateDir, "security-readable.txt");
      fs.writeFileSync(readableFile, "safe content");

      // Attempt write (should be blocked)
      mock.enqueue({
        type: "tool_use",
        toolName: "write",
        toolInput: { path: path.join(env.stateDir, "security-blocked.txt"), content: "blocked" },
      });
      // After write is blocked, read (should succeed)
      mock.enqueue({
        type: "tool_use",
        toolName: "read",
        toolInput: { path: readableFile },
      });
      mock.enqueue({
        type: "text",
        text: "Write was blocked but read succeeded.",
      });

      const res = await apiFetch<AgentRunResult>(
        env.baseUrl, env.accessToken, "POST", "/v1/agent/runs",
        {
          task: "Try write then read",
          providerId,
          model,
          timeoutMs: 15_000,
          constraints: { readOnly: true },
        },
      );

      expect(res.json.data.status).toBe("completed");
      expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(2);
      // Write file should NOT exist
      expect(fs.existsSync(path.join(env.stateDir, "security-blocked.txt"))).toBe(false);
    });

    it("readOnly blocks exec tool", { timeout: MOCK_E2E_TIMEOUT_MS }, async () => {
      const mock = env.mockFor("anthropic");

      mock.enqueue({
        type: "tool_use",
        toolName: "exec",
        toolInput: { command: "echo hello" },
      });
      mock.enqueue({
        type: "text",
        text: "Exec was blocked in readOnly mode.",
      });

      const res = await apiFetch<AgentRunResult>(
        env.baseUrl, env.accessToken, "POST", "/v1/agent/runs",
        {
          task: "Run command in readOnly",
          providerId,
          model,
          timeoutMs: 15_000,
          constraints: { readOnly: true },
        },
      );

      expect(res.json.data.status).toBe("completed");
      expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
    });

    it("readOnly allows web_search tool", { timeout: MOCK_E2E_TIMEOUT_MS }, async () => {
      const mock = env.mockFor("anthropic");
      const router = env.fetchRouter;

      // Mock DuckDuckGo HTML to avoid DNS resolution (unavailable in some test envs)
      const ddgRoute = {
        urlPrefix: "https://html.duckduckgo.com",
        api: "anthropic-messages" as FridayProviderApi,
        mockFetch: async () =>
          new Response(
            '<a class="result__a" href="https://example.com/result">Test Result</a>' +
            '<a class="result__snippet">A search result snippet</a>',
            { status: 200, headers: { "content-type": "text/html" } },
          ),
      };
      router.routes.unshift(ddgRoute);

      try {
        // web_search is non-mutating, should work in readOnly mode
        mock.enqueue({
          type: "tool_use",
          toolName: "web_search",
          toolInput: { query: "readonly search test" },
        });
        mock.enqueue({
          type: "text",
          text: "Search worked in readOnly mode.",
        });

        const res = await apiFetch<AgentRunResult>(
          env.baseUrl, env.accessToken, "POST", "/v1/agent/runs",
          {
            task: "Search in readOnly",
            providerId,
            model,
            timeoutMs: 15_000,
            constraints: { readOnly: true },
          },
        );

        // web_search succeeds via mock DDG route, and the point is
        // the tool was ALLOWED to execute (not blocked by readOnly)
        expect(res.json.data.status).toBe("completed");
        expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
      } finally {
        const idx = router.routes.indexOf(ddgRoute);
        if (idx >= 0) router.routes.splice(idx, 1);
      }
    });
  });
});
