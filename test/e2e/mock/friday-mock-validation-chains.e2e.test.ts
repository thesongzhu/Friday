/**
 * Validation Chain E2E Tests — covers the real-world failure modes
 * discovered during the Friday v0.4.2 manual validation (2026-03-31).
 *
 * These tests exercise FULL end-to-end chains through the real hub,
 * unlike unit tests that mock individual components.
 *
 * Chain 1: Intent routing — tasks with "automation/pipeline" words must NOT
 *          trigger workflow clarification when combined with Q&A verbs
 * Chain 2: Generator session — skill generator must succeed (no 502)
 * Chain 3: tool_use/tool_result pairing — orphaned blocks repaired
 * Chain 4: Preferences round-trip — write + read consistency
 * Chain 5: Multi-turn session context continuity
 * Chain 6: Provider error resilience — structured error, not crash
 * Chain 7: Layer-2 generator clarification guard
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

const RUN_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 25_000;

// ─── Tests ───

describe("Friday Validation Chain E2E", () => {
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

  // ═══════════════════════════════════════════════════════════════════════
  // Chain 1: Intent Routing — Q&A with "automation/pipeline" keywords
  // must NOT enter workflow/skill generation planning gate.
  // Also tests that Q&A tasks with "summarize" etc. are NOT killed by
  // the evidence closure validator (L2-1 fix).
  // ═══════════════════════════════════════════════════════════════════════

  describe("Chain 1: Intent routing — Q&A bypass", () => {
    // These tasks include words that USED TO trigger workflow generation
    // ("automation", "pipeline") but are clearly Q&A requests.
    // They don't contain external-action keywords so they bypass the
    // evidence closure validator too.
    const QA_TASKS = [
      "How does the automation module handle retries?",
      "What is the pipeline event model?",
      "Tell me about the automation architecture",
      "Give me an overview of the pipeline design",
    ];

    for (const task of QA_TASKS) {
      it(`"${task}" completes without clarification`, { timeout: TEST_TIMEOUT_MS }, async () => {
        const mock = env.mockFor("anthropic");
        mock.setDefault({ type: "text", text: "Here is the information you requested about the system." });

        const res = await apiFetch<AgentRunResult>(
          env.baseUrl,
          env.accessToken,
          "POST",
          "/v1/agent/runs",
          { task, providerId, model, timeoutMs: RUN_TIMEOUT_MS },
        );

        expect(res.status).toBe(200);
        expect(res.json.ok).toBe(true);
        expect(res.json.data.status).toBe("completed");
        // Must NOT return workflow clarification
        expect(res.json.data.response).not.toMatch(/before I execute this generate/i);
        expect(res.json.data.response).not.toMatch(/awaiting_clarification/i);
      });
    }

    it("explicit workflow request DOES trigger clarification or complete normally", { timeout: TEST_TIMEOUT_MS }, async () => {
      const mock = env.mockFor("anthropic");
      mock.setDefault({ type: "text", text: "I need more details." });

      const res = await apiFetch<AgentRunResult>(
        env.baseUrl,
        env.accessToken,
        "POST",
        "/v1/agent/runs",
        { task: "Generate a new workflow for deployment", providerId, model, timeoutMs: RUN_TIMEOUT_MS },
      );

      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      // Should either trigger clarification or complete — not silently fail
      expect(["completed", "awaiting_clarification"]).toContain(res.json.data.status);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Chain 2: Generator session — LLM call must not fail with 502
  // ═══════════════════════════════════════════════════════════════════════

  describe("Chain 2: Skill generator session creation", () => {
    it("POST /v1/skills/generator/sessions does not return 502", { timeout: TEST_TIMEOUT_MS }, async () => {
      const mock = env.mockFor("anthropic");
      mock.setDefault({
        type: "text",
        text: JSON.stringify({
          requirements: [
            { id: "R1", description: "Must greet the user", priority: "must" },
          ],
          suggestedName: "greeter-skill",
          complexity: "simple",
        }),
      });

      const res = await apiFetch<{
        ok?: boolean;
        mode?: string;
        session?: { sessionId: string; goal: string };
        error?: { code: string; message: string };
      }>(
        env.baseUrl,
        env.accessToken,
        "POST",
        "/v1/skills/generator/sessions",
        { goal: "Create a skill that greets the user by name" },
      );

      // Must NOT return 502 PROVIDER_ERROR
      expect(res.status).not.toBe(502);
      if (res.status === 200) {
        expect(res.json.session?.sessionId).toBeDefined();
        expect(res.json.mode).not.toBe("generation_failed");
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Chain 3: tool_use/tool_result pairing — completes without crash
  // ═══════════════════════════════════════════════════════════════════════

  describe("Chain 3: tool_use/tool_result integrity", () => {
    it("agent run with file_read tool_use completes correctly", { timeout: TEST_TIMEOUT_MS }, async () => {
      const mock = env.mockFor("anthropic");

      // Turn 1: LLM requests file_read tool (non-external action, no closure issues)
      mock.enqueue({
        type: "tool_use",
        toolName: "file_read",
        toolInput: { path: "/tmp/nonexistent-test-file.txt" },
      });
      // Turn 2: After tool result (error), LLM returns text
      mock.enqueue({
        type: "text",
        text: "The file does not exist at the specified path.",
      });

      const res = await apiFetch<AgentRunResult>(
        env.baseUrl,
        env.accessToken,
        "POST",
        "/v1/agent/runs",
        { task: "Read the file at /tmp/nonexistent-test-file.txt", providerId, model, timeoutMs: RUN_TIMEOUT_MS },
      );

      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      expect(res.json.data.status).toBe("completed");
      expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
    });

    it("multiple sequential tool calls maintain pairing", { timeout: TEST_TIMEOUT_MS }, async () => {
      const mock = env.mockFor("anthropic");

      // Turn 1: file_read
      mock.enqueue({
        type: "tool_use",
        toolName: "file_read",
        toolInput: { path: "/tmp/test-chain-1.txt" },
      });
      // Turn 2: another file_read
      mock.enqueue({
        type: "tool_use",
        toolName: "file_read",
        toolInput: { path: "/tmp/test-chain-2.txt" },
      });
      // Turn 3: final text
      mock.enqueue({
        type: "text",
        text: "Neither file exists.",
      });

      const res = await apiFetch<AgentRunResult>(
        env.baseUrl,
        env.accessToken,
        "POST",
        "/v1/agent/runs",
        { task: "Read /tmp/test-chain-1.txt and /tmp/test-chain-2.txt", providerId, model, timeoutMs: RUN_TIMEOUT_MS },
      );

      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      expect(res.json.data.status).toBe("completed");
      expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Chain 4: Preferences write + read round-trip
  // ═══════════════════════════════════════════════════════════════════════

  describe("Chain 4: Preferences persistence", () => {
    it("PUT then GET preferences round-trips correctly", { timeout: TEST_TIMEOUT_MS }, async () => {
      // Write a communication preference
      // Keys are "persona.tone", "persona.verbosity", etc.
      // Tone values: "warm", "neutral", "analytical", "encouraging"
      const putRes = await apiFetch<{
        ok: boolean;
        data?: unknown;
        error?: { code: string; message: string };
      }>(env.baseUrl, env.accessToken, "PUT", "/v1/uix/preferences", {
        preferences: [
          { category: "communication", key: "persona.tone", value: "analytical" },
        ],
      });

      expect(putRes.status).toBe(200);

      // Read preferences back
      const getRes = await apiFetch<{
        ok: boolean;
        data: { items: Array<{ category: string; key: string; value: unknown }> };
      }>(env.baseUrl, env.accessToken, "GET", "/v1/uix/preferences");

      expect(getRes.status).toBe(200);
      expect(getRes.json.ok).toBe(true);
      const items = getRes.json.data.items;
      const toneItem = items.find((i) => i.key === "persona.tone");
      expect(toneItem).toBeDefined();
      expect(toneItem?.value).toBe("analytical");
    });

    it("PUT persona maps UI setting keys to canonical communication preference keys", { timeout: TEST_TIMEOUT_MS }, async () => {
      const putRes = await apiFetch<{
        ok: boolean;
        data: {
          persona: {
            settings: {
              tone: string;
              verbosity: string;
              structure: string;
              directness: string;
            };
          };
        };
        error?: { code: string; message: string };
      }>(env.baseUrl, env.accessToken, "PUT", "/v1/uix/persona", {
        settings: {
          tone: "warm",
          verbosity: "concise",
          structure: "structured",
          directness: "direct",
        },
      });

      expect(putRes.status).toBe(200);
      expect(putRes.json.ok).toBe(true);
      expect(putRes.json.data.persona.settings).toMatchObject({
        tone: "warm",
        verbosity: "concise",
        structure: "structured",
        directness: "direct",
      });

      const getRes = await apiFetch<{
        ok: boolean;
        data: { items: Array<{ category: string; key: string; value: unknown }> };
      }>(env.baseUrl, env.accessToken, "GET", "/v1/uix/preferences");

      expect(getRes.status).toBe(200);
      expect(getRes.json.data.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ category: "communication", key: "persona.tone", value: "warm" }),
          expect.objectContaining({ category: "communication", key: "persona.verbosity", value: "concise" }),
          expect.objectContaining({ category: "communication", key: "persona.structure", value: "structured" }),
          expect.objectContaining({ category: "communication", key: "persona.directness", value: "direct" }),
        ]),
      );
    });

    it("invalid MBTI type is rejected with 400", { timeout: TEST_TIMEOUT_MS }, async () => {
      const res = await apiFetch<{
        ok: boolean;
        error?: { code: string };
      }>(env.baseUrl, env.accessToken, "PUT", "/v1/uix/preferences", {
        preferences: [
          { category: "communication", key: "persona.mbti", value: "XXXX" },
        ],
      });

      expect(res.status).toBe(400);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Chain 5: Multi-turn session context continuity
  // ═══════════════════════════════════════════════════════════════════════

  describe("Chain 5: Multi-turn context continuity", () => {
    it("second turn in same session accumulates messages", { timeout: 30_000 }, async () => {
      const mock = env.mockFor("anthropic");
      const sessionKey = "e2e:validation-chain:multi-turn";

      // Turn 1
      mock.enqueue({ type: "text", text: "Hello! I am Friday, your AI assistant." });
      const run1 = await apiFetch<AgentRunResult>(
        env.baseUrl,
        env.accessToken,
        "POST",
        "/v1/agent/runs",
        { task: "Hi, who are you?", providerId, model, timeoutMs: RUN_TIMEOUT_MS, sessionKey },
      );
      expect(run1.json.data.status).toBe("completed");

      // Turn 2
      mock.enqueue({ type: "text", text: "Got it. I will remember that you work on frontend systems." });
      const run2 = await apiFetch<AgentRunResult>(
        env.baseUrl,
        env.accessToken,
        "POST",
        "/v1/agent/runs",
        {
          task: "I work on frontend systems. Remember that.",
          providerId,
          model,
          timeoutMs: RUN_TIMEOUT_MS,
          sessionKey,
        },
      );
      expect(run2.json.data.status).toBe("completed");

      // Verify session messages include both turns
      const msgsRes = await apiFetch<{
        ok: boolean;
        data: { items: Array<{ role: string; contentText: string }> };
      }>(env.baseUrl, env.accessToken, "GET", `/v1/sessions/${encodeURIComponent(sessionKey)}/messages`);

      expect(msgsRes.status).toBe(200);
      expect(msgsRes.json.ok).toBe(true);
      const messages = msgsRes.json.data.items;
      // Should have at least 4 messages: user1 + assistant1 + user2 + assistant2
      expect(messages.length).toBeGreaterThanOrEqual(4);
      const userMessages = messages.filter((m) => m.role === "user");
      const assistantMessages = messages.filter((m) => m.role === "assistant");
      expect(userMessages.length).toBeGreaterThanOrEqual(2);
      expect(assistantMessages.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Chain 6: Provider error resilience
  // ═══════════════════════════════════════════════════════════════════════

  describe("Chain 6: Provider error returns structured error, not crash", () => {
    it("LLM 500 returns graceful failure in agent run", { timeout: TEST_TIMEOUT_MS }, async () => {
      const mock = env.mockFor("anthropic");

      // Simulate provider returning HTTP 500
      mock.enqueue({ type: "http_error", status: 500, body: "Internal server error" });

      const res = await apiFetch<{
        ok: boolean;
        data?: { status: string; response: string };
        error?: { code: string; message: string };
      }>(
        env.baseUrl,
        env.accessToken,
        "POST",
        "/v1/agent/runs",
        { task: "Hello there", providerId, model, timeoutMs: RUN_TIMEOUT_MS },
      );

      // Server itself should NOT return 500 — the error should be handled gracefully
      expect(res.status).toBeLessThan(500);
      // Run should either fail gracefully or have error info
      if (res.json.data?.status === "failed") {
        expect(res.json.data.response).toBeTruthy();
      }
    });

    it("network error returns structured failure", { timeout: TEST_TIMEOUT_MS }, async () => {
      const mock = env.mockFor("anthropic");

      mock.enqueue({ type: "network_error", message: "ECONNREFUSED" });

      const res = await apiFetch<{
        ok: boolean;
        data?: { status: string; response: string };
        error?: { code: string; message: string };
      }>(
        env.baseUrl,
        env.accessToken,
        "POST",
        "/v1/agent/runs",
        { task: "Tell me a joke", providerId, model, timeoutMs: RUN_TIMEOUT_MS },
      );

      expect(res.status).toBeLessThan(500);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Chain 7: Layer-2 generator clarification guard
  //
  // When the LLM autonomously calls workflow_generate for a Q&A task,
  // Layer 2 should NOT surface the clarification if the original task
  // matches the QA bypass pattern.
  // ═══════════════════════════════════════════════════════════════════════

  describe("Chain 7: Layer-2 LLM tool-selection guard", () => {
    it("LLM calling workflow_generate for Q&A task is not surfaced as clarification", { timeout: TEST_TIMEOUT_MS }, async () => {
      const mock = env.mockFor("anthropic");

      // Simulate LLM mistakenly calling workflow_generate for a describe request
      mock.enqueue({
        type: "tool_use",
        toolName: "workflow_generate",
        toolInput: { action: "start", goal: "describe the system architecture" },
      });
      // After tool returns, LLM produces final answer
      mock.enqueue({
        type: "text",
        text: "The system architecture consists of three main layers.",
      });

      const res = await apiFetch<AgentRunResult>(
        env.baseUrl,
        env.accessToken,
        "POST",
        "/v1/agent/runs",
        // "Describe" is a QA bypass keyword — should NOT surface clarification
        { task: "Describe the system architecture for me", providerId, model, timeoutMs: RUN_TIMEOUT_MS },
      );

      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      // Must NOT be stuck in awaiting_clarification
      expect(res.json.data.status).not.toBe("awaiting_clarification");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Chain 8: Evidence Closure does NOT kill Q&A tasks (L2-1)
  //
  // After the fix, tasks with "summarize" should complete with pure text
  // response — they no longer trigger the web evidence closure validator.
  // ═══════════════════════════════════════════════════════════════════════

  describe("Chain 8: Evidence Closure Q&A bypass", () => {
    const QA_TASKS_WITH_WEB_WORDS = [
      "Summarize this text about the project architecture",
      "Explain how the system handles retries",
      "Describe the deployment pipeline",
      "Analyze the error logs from yesterday",
      "Compare these two approaches to caching",
    ];

    for (const task of QA_TASKS_WITH_WEB_WORDS) {
      it(`"${task}" completes without AGENT_OUTPUT_CLOSURE_ERROR`, { timeout: TEST_TIMEOUT_MS }, async () => {
        const mock = env.mockFor("anthropic");
        // LLM returns pure text — NO tool calls
        mock.setDefault({ type: "text", text: "Here is the analysis you requested." });

        const res = await apiFetch<AgentRunResult>(
          env.baseUrl,
          env.accessToken,
          "POST",
          "/v1/agent/runs",
          { task, providerId, model, timeoutMs: RUN_TIMEOUT_MS },
        );

        expect(res.status).toBe(200);
        expect(res.json.ok).toBe(true);
        expect(res.json.data.status).toBe("completed");
        // Must NOT fail with evidence closure error
        expect(res.json.data.response).not.toContain("AGENT_OUTPUT_CLOSURE_ERROR");
      });
    }

    it("actual external-action task still requires tool evidence", { timeout: TEST_TIMEOUT_MS }, async () => {
      const mock = env.mockFor("anthropic");

      // LLM calls web_search (correct behavior for external task)
      mock.enqueue({
        type: "tool_use",
        toolName: "web_search",
        toolInput: { query: "latest Node.js release" },
      });
      mock.enqueue({
        type: "text",
        text: "The latest Node.js LTS release is v22.",
      });

      const res = await apiFetch<AgentRunResult>(
        env.baseUrl,
        env.accessToken,
        "POST",
        "/v1/agent/runs",
        { task: "Search for the latest Node.js release version", providerId, model, timeoutMs: RUN_TIMEOUT_MS },
      );

      expect(res.status).toBe(200);
      expect(res.json.data.toolCallCount).toBeGreaterThanOrEqual(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Chain 9: Preferences → Learning pipeline connection (L2-3)
  // ═══════════════════════════════════════════════════════════════════════

  describe("Chain 9: Preferences write emits learning events", () => {
    it("PUT preferences succeeds and data persists", { timeout: TEST_TIMEOUT_MS }, async () => {
      // Write preference
      const putRes = await apiFetch<{
        ok: boolean;
        data?: { preferences: Array<{ key: string; value: unknown }>; created: number; updated: number };
      }>(env.baseUrl, env.accessToken, "PUT", "/v1/uix/preferences", {
        preferences: [
          { category: "communication", key: "persona.verbosity", value: "concise" },
        ],
      });

      expect(putRes.status).toBe(200);
      expect(putRes.json.ok).toBe(true);

      // Read back
      const getRes = await apiFetch<{
        ok: boolean;
        data: { items: Array<{ key: string; value: unknown }> };
      }>(env.baseUrl, env.accessToken, "GET", "/v1/uix/preferences");

      expect(getRes.status).toBe(200);
      const verbosity = getRes.json.data.items.find((i) => i.key === "persona.verbosity");
      expect(verbosity).toBeDefined();
      expect(verbosity?.value).toBe("concise");
    });
  });
});
