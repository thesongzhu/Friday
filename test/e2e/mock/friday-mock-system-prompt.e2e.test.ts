/**
 * Dynamic System Prompt E2E Tests — verify the system prompt builder
 * generates correct prompts with all tool names, version, and guidance.
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

function extractSystemPrompt(mockCalls: Array<{ bodyJson?: unknown }>): string {
  const firstCall = mockCalls[0];
  if (!firstCall?.bodyJson) return "";
  const body = firstCall.bodyJson as Record<string, unknown>;
  // Anthropic API: system prompt in the `system` field (string or array of content blocks)
  if (typeof body.system === "string") return body.system;
  if (Array.isArray(body.system)) {
    return (body.system as Array<{ type: string; text: string }>)
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }
  // OpenAI API: system prompt as first message with role "system"
  if (Array.isArray(body.messages)) {
    const sysMsg = (body.messages as Array<{ role: string; content: string }>).find(
      (m) => m.role === "system",
    );
    if (sysMsg) return sysMsg.content;
  }
  return "";
}

// ─── Tests ───

describe("Friday Mock System Prompt E2E", () => {
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

  it("system prompt contains all core tool names", async () => {
    const mock = env.mockFor("anthropic");
    mock.setDefault({ type: "text", text: "ok" });

    await apiFetch(env.baseUrl, env.accessToken, "POST", "/v1/agent/runs", {
      task: "What tools do you have available?",
      providerId,
      model,
      timeoutMs: 10_000,
    });

    const prompt = extractSystemPrompt(mock.calls);
    expect(prompt.length).toBeGreaterThan(0);

    // Core tools that should always be registered
    const coreTools = ["exec", "read", "write", "edit", "web_fetch", "web_search"];
    for (const tool of coreTools) {
      expect(prompt).toContain(tool);
    }
  });

  it("system prompt includes Friday version and model identity", async () => {
    const mock = env.mockFor("anthropic");
    mock.setDefault({ type: "text", text: "ok" });

    await apiFetch(env.baseUrl, env.accessToken, "POST", "/v1/agent/runs", {
      task: "Who are you?",
      providerId,
      model,
      timeoutMs: 10_000,
    });

    const prompt = extractSystemPrompt(mock.calls);

    // Should contain "Friday v" (version)
    expect(prompt).toMatch(/Friday v\d+/);
    // Should mention the model identity
    expect(prompt).toContain("model");
  });

  it("system prompt includes tool selection strategy", async () => {
    const mock = env.mockFor("anthropic");
    mock.setDefault({ type: "text", text: "ok" });

    await apiFetch(env.baseUrl, env.accessToken, "POST", "/v1/agent/runs", {
      task: "Say hi",
      providerId,
      model,
      timeoutMs: 10_000,
    });

    const prompt = extractSystemPrompt(mock.calls);

    // Tool selection strategy guidance
    expect(prompt).toContain("web_search");
    expect(prompt).toContain("web_fetch");
    expect(prompt).toContain("browser");
    // Strategy ordering: search first, fetch fallback, browser last resort
    expect(prompt).toMatch(/web_search.*web_fetch.*browser/s);
  });

  it("system prompt includes current time context and latest-news guidance", async () => {
    const mock = env.mockFor("anthropic");
    mock.setDefault({ type: "text", text: "ok" });

    await apiFetch(env.baseUrl, env.accessToken, "POST", "/v1/agent/runs", {
      task: "Latest news please",
      providerId,
      model,
      timeoutMs: 10_000,
      timezone: "America/Los_Angeles",
    });

    const prompt = extractSystemPrompt(mock.calls);
    expect(prompt).toContain("Current time context:");
    expect(prompt).toContain("timezone: America/Los_Angeles");
    expect(prompt).toContain("absolute dates plus source URLs");
    expect(prompt).toContain("latestness is unverified");
  });

  it("system prompt includes error handling guidance", async () => {
    const mock = env.mockFor("anthropic");
    mock.setDefault({ type: "text", text: "ok" });

    await apiFetch(env.baseUrl, env.accessToken, "POST", "/v1/agent/runs", {
      task: "Say hi",
      providerId,
      model,
      timeoutMs: 10_000,
    });

    const prompt = extractSystemPrompt(mock.calls);

    // Error handling guidance
    expect(prompt).toContain("retry");
    expect(prompt).toContain("Diagnose");
    expect(prompt).toMatch(/MUST NOT immediately report the failure/);
  });

  it("system prompt tool list includes memory tools when available", async () => {
    const mock = env.mockFor("anthropic");
    mock.setDefault({ type: "text", text: "ok" });

    await apiFetch(env.baseUrl, env.accessToken, "POST", "/v1/agent/runs", {
      task: "Say hi",
      providerId,
      model,
      timeoutMs: 10_000,
    });

    const prompt = extractSystemPrompt(mock.calls);

    // Memory tools should be listed
    expect(prompt).toContain("memory_search");
    expect(prompt).toContain("memory_store");
  });
});
