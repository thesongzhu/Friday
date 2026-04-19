/**
 * Tool Invocation E2E Tests — verify agent tool_use → execute → result round-trip.
 *
 * These tests fill the critical gap: the mock LLM returns tool_use responses,
 * the agent runtime executes the tool, feeds the result back to the LLM,
 * and the LLM then returns a final text response.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import {
  createMockHubEnv,
  type MockHubEnv,
} from "./_helpers/mock-env.js";
import { resetMockCounters } from "../../_mocks/mock-llm-providers.js";
import type { MockFetchRouter } from "./_helpers/mock-fetch-router.js";
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

// ─── Mock DuckDuckGo HTML ───

const MOCK_DDG_HTML = `
<html><body>
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fresult1&amp;rut=abc">Example Result One</a>
  <a class="result__snippet" href="#">This is the first search result snippet about testing.</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fresult2&amp;rut=def">Example Result Two</a>
  <a class="result__snippet" href="#">Second result snippet with more details.</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fresult3&amp;rut=ghi">Example Result Three</a>
  <a class="result__snippet" href="#">Third result snippet here.</a>
</div>
</body></html>
`;

// ─── Agent run result shape ───

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

const MOCK_E2E_RUN_TIMEOUT_MS = 20_000;
const MOCK_E2E_TEST_TIMEOUT_MS = 20_000;

// ─── Tests ───

describe("Friday Mock Tool Invocations E2E", () => {
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

  // ─── 1. web_search round-trip ───

  it("web_search tool round-trip with mock DuckDuckGo", async () => {
    const mock = env.mockFor("anthropic");
    const router = globalThis.fetch as unknown as MockFetchRouter;

    // Inject DuckDuckGo mock route
    const ddgRoute = {
      urlPrefix: "https://html.duckduckgo.com",
      api: "anthropic-messages" as FridayProviderApi,
      mockFetch: async () =>
        new Response(MOCK_DDG_HTML, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    };
    router.routes.unshift(ddgRoute);

    try {
      // LLM call 1: return tool_use for web_search
      mock.enqueue({
        type: "tool_use",
        toolName: "web_search",
        toolInput: { query: "nodejs testing frameworks" },
      });
      // LLM call 2: after getting search results, return text
      mock.enqueue({
        type: "text",
        text: "Based on the search results, I found 3 relevant pages about testing.",
      });

      const res = await apiFetch<AgentRunResult>(
        env.baseUrl,
        env.accessToken,
        "POST",
        "/v1/agent/runs",
        {
          task: "Search for nodejs testing frameworks",
          providerId,
          model,
          timeoutMs: MOCK_E2E_RUN_TIMEOUT_MS,
        },
      );

      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      expect(res.json.data.status).toBe("completed");
      expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
      expect(res.json.data.response).toContain("search results");

      // Verify LLM was called twice (tool_use + final text)
      expect(mock.calls.length).toBe(2);
    } finally {
      // Remove injected route
      const idx = router.routes.indexOf(ddgRoute);
      if (idx >= 0) router.routes.splice(idx, 1);
    }
  });

  // ─── 2. web_fetch round-trip ───

  it("web_fetch tool round-trip with mock URL", async () => {
    const mock = env.mockFor("anthropic");
    const router = globalThis.fetch as unknown as MockFetchRouter;

    const mockApiRoute = {
      urlPrefix: "https://mock.api-test.example.com",
      api: "anthropic-messages" as FridayProviderApi,
      mockFetch: async () =>
        new Response(
          JSON.stringify({ data: "hello from mock API" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    };
    router.routes.unshift(mockApiRoute);

    try {
      mock.enqueue({
        type: "tool_use",
        toolName: "web_fetch",
        toolInput: { url: "https://mock.api-test.example.com/data" },
      });
      mock.enqueue({
        type: "text",
        text: "The API returned data successfully.",
      });

      const res = await apiFetch<AgentRunResult>(
        env.baseUrl,
        env.accessToken,
        "POST",
        "/v1/agent/runs",
        { task: "Fetch data from the API", providerId, model, timeoutMs: MOCK_E2E_RUN_TIMEOUT_MS },
      );

      expect(res.status).toBe(200);
      expect(res.json.data.status).toBe("completed");
      expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
    } finally {
      const idx = router.routes.indexOf(mockApiRoute);
      if (idx >= 0) router.routes.splice(idx, 1);
    }
  });

  // ─── 3. exec round-trip ───

  it("exec tool round-trip", async () => {
    const mock = env.mockFor("anthropic");

    mock.enqueue({
      type: "tool_use",
      toolName: "exec",
      toolInput: { command: "echo hello-from-exec-test" },
    });
    mock.enqueue({
      type: "text",
      text: "The command output was: hello-from-exec-test",
    });

    const res = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "Run echo hello", providerId, model, timeoutMs: MOCK_E2E_RUN_TIMEOUT_MS },
    );

    expect(res.status).toBe(200);
    expect(res.json.data.status).toBe("completed");
    expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
    expect(mock.calls.length).toBe(2);
  });

  // ─── 4. exec metacharacter block ───

  it("exec tool blocks shell metacharacters", async () => {
    const mock = env.mockFor("anthropic");

    mock.enqueue({
      type: "tool_use",
      toolName: "exec",
      toolInput: { command: "echo hello; cat /etc/passwd" },
    });
    mock.enqueue({
      type: "text",
      text: "The command was blocked due to shell metacharacters.",
    });

    const res = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "Run a command", providerId, model, timeoutMs: MOCK_E2E_RUN_TIMEOUT_MS },
    );

    expect(res.status).toBe(200);
    expect(res.json.data.status).toBe("completed");
    expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
    // LLM received the error from the tool and responded
    expect(mock.calls.length).toBe(2);
  });

  // ─── 5. read tool round-trip ───

  it("read tool round-trip with temp file", async () => {
    const mock = env.mockFor("anthropic");

    // Create a temp file in stateDir
    const testFilePath = path.join(env.stateDir, "test-read-file.txt");
    fs.writeFileSync(testFilePath, "Hello from the test file!\nLine 2 here.");

    mock.enqueue({
      type: "tool_use",
      toolName: "read",
      toolInput: { path: testFilePath },
    });
    mock.enqueue({
      type: "text",
      text: "The file contains a greeting and a second line.",
    });

    const res = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "Read the test file", providerId, model, timeoutMs: MOCK_E2E_RUN_TIMEOUT_MS },
    );

    expect(res.status).toBe(200);
    expect(res.json.data.status).toBe("completed");
    expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
    expect(mock.calls.length).toBe(2);
  });

  // ─── 6. write tool round-trip ───

  it("write tool round-trip creates file on disk", async () => {
    const mock = env.mockFor("anthropic");
    const targetPath = path.join(env.stateDir, "test-write-output.txt");

    mock.enqueue({
      type: "tool_use",
      toolName: "write",
      toolInput: { path: targetPath, content: "Written by agent tool test" },
    });
    mock.enqueue({
      type: "text",
      text: "File written successfully.",
    });

    const res = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "Write a file", providerId, model, timeoutMs: MOCK_E2E_RUN_TIMEOUT_MS },
    );

    expect(res.status).toBe(200);
    expect(res.json.data.status).toBe("completed");
    expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);

    // Verify file was actually written to disk
    expect(fs.existsSync(targetPath)).toBe(true);
    expect(fs.readFileSync(targetPath, "utf-8")).toBe("Written by agent tool test");
  });

  // ─── 7. write path traversal block ───

  it("write tool rejects path traversal", async () => {
    const mock = env.mockFor("anthropic");

    mock.enqueue({
      type: "tool_use",
      toolName: "write",
      toolInput: { path: "../../../tmp/evil.txt", content: "pwned" },
    });
    mock.enqueue({
      type: "text",
      text: "The write operation was rejected for security reasons.",
    });

    const res = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "Write a file outside workspace", providerId, model, timeoutMs: MOCK_E2E_RUN_TIMEOUT_MS },
    );

    expect(res.status).toBe(200);
    expect(res.json.data.status).toBe("failed");
    expect(res.json.data.response).toContain("AGENT_OUTPUT_CLOSURE_ERROR");
    expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
    // File mutation tasks must fail closed when every write attempt is blocked.
    expect(mock.calls.length).toBe(2);
  });

  // ─── 8. memory_store then memory_search ───

  it("memory_store then memory_search via agent tools", { timeout: MOCK_E2E_TEST_TIMEOUT_MS }, async () => {
    const mock = env.mockFor("anthropic");

    // Run 1: store memory
    mock.enqueue({
      type: "tool_use",
      toolName: "memory_store",
      toolInput: {
        content: "The user prefers dark mode for all interfaces",
        namespace: "e2e-tool-test",
        tags: ["preference", "ui"],
      },
    });
    mock.enqueue({
      type: "text",
      text: "I have stored the preference about dark mode.",
    });

    const run1 = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      {
        task: "Store this note for later: the interface should default to dark mode",
        providerId,
        model,
        timeoutMs: MOCK_E2E_RUN_TIMEOUT_MS,
      },
    );

    expect(run1.json.data.status).toBe("completed");
    expect(run1.json.data.toolCallCount).toBeGreaterThanOrEqual(1);

    // Reset mock for run 2
    mock.reset();
    resetMockCounters();

    // Run 2: search memory
    mock.enqueue({
      type: "tool_use",
      toolName: "memory_search",
      toolInput: { query: "dark mode preference" },
    });
    mock.enqueue({
      type: "text",
      text: "I found your preference for dark mode.",
    });

    const run2 = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      {
        task: "Search my saved note about the interface theme",
        providerId,
        model,
        timeoutMs: MOCK_E2E_RUN_TIMEOUT_MS,
      },
    );

    expect(run2.json.data.status).toBe("completed");
    expect(run2.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
  });

  // ─── 9. Unknown tool name ───

  it("unknown tool name returns error to LLM gracefully", { timeout: MOCK_E2E_TEST_TIMEOUT_MS }, async () => {
    const mock = env.mockFor("anthropic");

    mock.enqueue({
      type: "tool_use",
      toolName: "nonexistent_tool_xyz",
      toolInput: {},
    });
    mock.enqueue({
      type: "text",
      text: "That tool is not available. Let me try a different approach.",
    });

    const res = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "Use a nonexistent tool", providerId, model, timeoutMs: MOCK_E2E_RUN_TIMEOUT_MS },
    );

    expect(res.status).toBe(200);
    // The run should still complete — the error was reported to the LLM
    expect(res.json.data.status).toBe("completed");
    expect(mock.calls.length).toBe(2);
  });

  // ─── 10. Tool execution error → LLM retry ───

  it("tool execution error reported back to LLM, LLM retries successfully", async () => {
    const mock = env.mockFor("anthropic");

    // Create a valid file for the retry
    const validFile = path.join(env.stateDir, "valid-retry-file.txt");
    fs.writeFileSync(validFile, "success data");

    // LLM call 1: try to read nonexistent file → tool returns error
    mock.enqueue({
      type: "tool_use",
      toolName: "read",
      toolInput: { path: path.join(env.stateDir, "does-not-exist.txt") },
    });
    // LLM call 2: after seeing error, retry with valid file
    mock.enqueue({
      type: "tool_use",
      toolName: "read",
      toolInput: { path: validFile },
    });
    // LLM call 3: success, return final text
    mock.enqueue({
      type: "text",
      text: "Found the data after retrying with the correct file path.",
    });

    const res = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "Read a file", providerId, model, timeoutMs: MOCK_E2E_RUN_TIMEOUT_MS },
    );

    expect(res.status).toBe(200);
    expect(res.json.data.status).toBe("completed");
    expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(2);
    // 3 LLM calls: first tool_use (fail), second tool_use (success), final text
    expect(mock.calls.length).toBe(3);
  });

  // ─── 11. Multi-step tool chain ───

  it("multi-step tool chain: exec then read", async () => {
    const mock = env.mockFor("anthropic");
    const chainFile = path.join(env.stateDir, "chain-test.txt");

    // Step 1: LLM writes a file via exec
    mock.enqueue({
      type: "tool_use",
      toolName: "exec",
      toolInput: { command: `echo chain-test-data > ${JSON.stringify(chainFile)}` },
    });
    // Step 2: LLM reads the file it just wrote
    mock.enqueue({
      type: "tool_use",
      toolName: "read",
      toolInput: { path: chainFile },
    });
    // Step 3: Final response
    mock.enqueue({
      type: "text",
      text: "Successfully created and verified the file.",
    });

    const res = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "Create a file and verify its contents", providerId, model, timeoutMs: MOCK_E2E_RUN_TIMEOUT_MS },
    );

    expect(res.status).toBe(200);
    expect(res.json.data.status).toBe("completed");
    expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(2);
    expect(mock.calls.length).toBe(3);
  });

  // ─── 12. list tool round-trip ───

  it("list tool returns directory contents", async () => {
    const mock = env.mockFor("anthropic");

    // Create some files to list
    fs.writeFileSync(path.join(env.stateDir, "list-test-a.txt"), "a");
    fs.writeFileSync(path.join(env.stateDir, "list-test-b.txt"), "b");

    mock.enqueue({
      type: "tool_use",
      toolName: "list",
      toolInput: { path: env.stateDir },
    });
    mock.enqueue({
      type: "text",
      text: "The directory contains several test files.",
    });

    const res = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      { task: "List files in the state directory", providerId, model, timeoutMs: MOCK_E2E_RUN_TIMEOUT_MS },
    );

    expect(res.status).toBe(200);
    expect(res.json.data.status).toBe("completed");
    expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
  });
});
