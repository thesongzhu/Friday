/**
 * Hub Bootstrap E2E Tests — verify hub boots correctly with all services,
 * health endpoint works, providers are listed, and shutdown is clean.
 * Validates Phase 4 god-file refactoring didn't break anything.
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

// ─── Tests ───

describe("Friday Mock Bootstrap E2E", () => {
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

  it("hub boots with state 'running'", () => {
    const status = env.hub.status();
    expect(status.state).toBe("running");
  });

  it("hub has all required services", () => {
    expect(env.hub.skills).toBeDefined();
    expect(env.hub.executor).toBeDefined();
    expect(env.hub.providerService).toBeDefined();
    expect(env.hub.apiRuntime).toBeDefined();
    expect(env.hub.channelRegistry).toBeDefined();
  });

  it("health endpoint returns ok", async () => {
    const res = await apiFetch<{ ok: boolean; data?: { status: string } }>(
      env.baseUrl,
      env.accessToken,
      "GET",
      "/v1/health",
    );

    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
  });

  it("providers endpoint lists registered mock provider", async () => {
    const res = await apiFetch<{
      ok: boolean;
      data: { items: Array<{ id: string; name: string; kind: string }> };
    }>(
      env.baseUrl,
      env.accessToken,
      "GET",
      "/v1/providers",
    );

    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.data.items.length).toBeGreaterThanOrEqual(1);

    // Should include our mock ollama provider
    const kinds = res.json.data.items.map((p) => p.kind);
    expect(kinds).toContain("ollama");
  });

  it("agent runs endpoint completes a run end-to-end", async () => {
    const mock = env.mockFor("ollama");
    const provider = env.providers["ollama"]!;

    mock.setDefault({
      type: "text",
      text: "Bootstrap test response.",
    });

    const res = await apiFetch<AgentRunResult>(
      env.baseUrl,
      env.accessToken,
      "POST",
      "/v1/agent/runs",
      {
        task: "Bootstrap verification test",
        providerId: provider.providerId,
        model: provider.model,
        timeoutMs: 10_000,
      },
    );

    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.data.status).toBe("completed");
    expect(res.json.data.response).toContain("Bootstrap test");
    expect(res.json.data.runId).toBeTruthy();
  });

  it("state directory contains SQLite database", () => {
    // The hub creates a SQLite database in the state directory
    const files = fs.readdirSync(env.stateDir);
    const hasDb = files.some(
      (f) => f.endsWith(".db") || f.endsWith(".sqlite") || f === "friday.db",
    );
    expect(hasDb).toBe(true);
  });

  it("hub status reports skill count", () => {
    const status = env.hub.status();
    expect(typeof status.skillCount).toBe("number");
    expect(status.skillCount).toBeGreaterThanOrEqual(0);
  });
});

// ─── Separate describe for shutdown test (needs its own env) ───

describe("Friday Mock Bootstrap E2E — Shutdown", () => {
  it("hub.stop() transitions to 'stopped' state", async () => {
    const env2 = await createMockHubEnv({ providerKinds: ["ollama"] });

    try {
      expect(env2.hub.status().state).toBe("running");
      await env2.hub.stop();
      expect(env2.hub.status().state).toBe("stopped");
    } finally {
      // cleanup will also try to stop, but that's ok since it's already stopped
      await env2.cleanup();
    }
  }, 30_000);
});
