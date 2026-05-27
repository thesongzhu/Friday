import * as crypto from "node:crypto";
import * as net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFridayAgentEventEmitter,
  createFridayAgentMemoryTools,
  createFridayAgentRuntime,
  type FridayAgentLlmClient,
  type FridayAgentMessage,
} from "#agent";
import {
  createFridayApiRuntime,
  createFridayHttpServer,
  encodeToken,
  type FridayHttpServer,
} from "#api";
import {
  createFridayMemoryGuardServiceFactory,
  createFridayMemoryService,
} from "#memory";
import { createFridayProviderService } from "#providers";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../helpers/friday-test-db.helper.js";

const NOW = "2026-05-27T02:00:00.000Z";
const AUTH_TOKEN_TEST_KEY = "dp10-cross-session-sop-memory-test-key";

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close();
      if (!addr || typeof addr === "string") {
        reject(new Error("No free port"));
        return;
      }
      resolve(addr.port);
    });
    srv.on("error", reject);
  });
}

function authHeaders(): Record<string, string> {
  const nowSec = Math.floor(Date.parse(NOW) / 1000);
  const token = encodeToken(
    {
      tokenId: "dp10-token",
      principalType: "user",
      principalId: "dp10-user",
      tenantId: "dp10-tenant",
      userId: "dp10-user",
      role: "admin",
      scopes: ["agent.run", "memory.read", "memory.write", "session.read", "session.write"],
      iat: nowSec,
      exp: nowSec + 3600,
    },
    AUTH_TOKEN_TEST_KEY,
  );
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function jsonFetch<T>(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
}

function textFromMessages(messages: FridayAgentMessage[]): string {
  return messages
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content))
    .join("\n");
}

describe("DP-10 probe — cross-session SOP trigger memory", () => {
  let db: FridaySqliteLayer | undefined;
  let server: FridayHttpServer | undefined;

  afterEach(async () => {
    await server?.close();
    db?.close();
    server = undefined;
    db = undefined;
  });

  it("recalls a seeded SOP after reset through sessions.run and refuses a destructive near-miss trigger", async () => {
    db = createTestDb();
    const idGenerator = createTestIdGenerator();
    const providerService = createFridayProviderService({
      db,
      idGenerator,
      nowIso: () => NOW,
    });
    const memoryService = createFridayMemoryService({
      db,
      providerService,
      idGenerator,
      nowIso: () => NOW,
    });
    const memoryGuardFactory = createFridayMemoryGuardServiceFactory({
      core: memoryService,
      db,
      nowIso: () => NOW,
      nowMs: () => Date.parse(NOW),
    });

    const finalPrompts: string[] = [];
    let streamCallIndex = 0;
    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        const callIndex = streamCallIndex++;
        const prompt = textFromMessages(params.messages);
        if (callIndex % 2 === 0) {
          yield {
            type: "tool_use",
            id: `dp10-memory-search-${finalPrompts.length}`,
            name: "memory_search",
            input: {
              query: "refund followup routine customer followup cleanup SOP",
              namespace: "default",
              limit: 3,
            },
          };
          yield { type: "message_end", stopReason: "tool_use", inputTokens: 20, outputTokens: 5 };
          return;
        }

        finalPrompts.push(prompt);
        if (/delete the followup routine outputs/i.test(prompt)) {
          yield {
            type: "text_delta",
            text: "DP10_REFUSED_DESTRUCTIVE_TRIGGER: SOP-DP10-REFUND-FOLLOWUP recalled, but deletion requires a separate explicit approval and will not execute.",
          };
        } else {
          yield {
            type: "text_delta",
            text: "DP10_SAFE_PLAN: SOP-DP10-REFUND-FOLLOWUP recalled; write only customer followup outputs inside the isolated workspace and request approval before destructive cleanup.",
          };
        }
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 30, outputTokens: 10 };
      },
    };

    const agentRuntime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "dp10-deterministic-model",
      providerId: "dp10-deterministic-provider",
      systemPrompt: "You are Friday. Use memory before applying learned routines.",
      tools: createFridayAgentMemoryTools({
        memoryService,
        memoryGuardFactory,
      }),
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const runtime = createFridayApiRuntime({
      db,
      idGenerator,
      nowIso: () => NOW,
      providerService,
      memoryService,
      agentRuntime,
      agentEventEmitter: createFridayAgentEventEmitter(),
      tokenSecret: AUTH_TOKEN_TEST_KEY,
      computeChecksum: (content) => crypto.createHash("sha256").update(content).digest("hex"),
      resolveSkill: () => null,
      invokeSkill: async () => ({}),
    });

    const port = await findFreePort();
    server = createFridayHttpServer({
      routes: runtime.routes,
      wsGateway: runtime.wsGateway,
      middleware: runtime.middleware,
      port,
      host: "127.0.0.1",
    });
    await server.listen();
    const baseUrl = `http://127.0.0.1:${port}`;

    const store = await jsonFetch<{
      ok: boolean;
      data: { item: { id: string; namespace: string; accessCount?: number } };
    }>(baseUrl, "POST", "/v1/memory/store", {
      namespace: "default",
      content: [
        "SOP-DP10-REFUND-FOLLOWUP",
        "Trigger phrases: run the refund followup routine; do the customer followup cleanup.",
        "Inputs: inbox/orders.csv, inbox/notes.md, rules/refund-policy.md.",
        "Outputs: outbox/customer-followups.md and outbox/triage-summary.json.",
        "Allowed mutations: write outputs only inside the isolated workspace.",
        "Approval boundary: deletion, external send, or writes outside workspace require explicit approval.",
      ].join("\n"),
      source: "dp10-probe",
      tags: ["dp10", "sop", "trigger"],
      memoryType: "procedure",
      confidence: 0.97,
    });
    expect(store.status).toBe(200);
    expect(store.json.ok).toBe(true);
    expect(store.json.data.item.accessCount ?? 0).toBe(0);

    const directSearch = await jsonFetch<{
      ok: boolean;
      data: { items: Array<{ item: { id: string; content: string }; score: number }> };
    }>(baseUrl, "POST", "/v1/memory/search", {
      namespace: "default",
      query: "refund followup routine customer followup cleanup SOP",
      limit: 3,
    });
    expect(directSearch.status).toBe(200);
    expect(directSearch.json.data.items.map((result) => result.item.id)).toContain(store.json.data.item.id);

    const createSession = await jsonFetch<{
      ok: boolean;
      data: { session: { key: string } };
    }>(baseUrl, "POST", "/v1/sessions", {
      channel: "dp10",
      chatId: "cross-session-sop",
    });
    expect(createSession.status).toBe(200);
    const sessionKey = createSession.json.data.session.key;

    const reset = await jsonFetch<{ ok: boolean }>(
      baseUrl,
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionKey)}/reset`,
    );
    expect(reset.status).toBe(200);
    expect(reset.json.ok).toBe(true);

    const runA = await jsonFetch<{
      ok: boolean;
      data: { run: { status: string; response: string; toolCallCount: number } };
    }>(
      baseUrl,
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionKey)}/run`,
      { task: "run the refund followup routine" },
    );
    expect(runA.status).toBe(200);
    if (runA.json.data.run.status !== "completed") {
      console.info("DP10 runA diagnostic", JSON.stringify(runA.json.data.run, null, 2));
    }
    expect(runA.json.data.run.status).toBe("completed");
    expect(runA.json.data.run.toolCallCount).toBe(1);
    expect(runA.json.data.run.response).toContain("DP10_SAFE_PLAN");
    expect(runA.json.data.run.response).toContain("SOP-DP10-REFUND-FOLLOWUP");

    const runB = await jsonFetch<{
      ok: boolean;
      data: { run: { status: string; response: string; toolCallCount: number } };
    }>(
      baseUrl,
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionKey)}/run`,
      { task: "do the customer followup cleanup" },
    );
    expect(runB.status).toBe(200);
    expect(runB.json.data.run.response).toContain("DP10_SAFE_PLAN");

    const negative = await jsonFetch<{
      ok: boolean;
      data: { run: { status: string; response: string; toolCallCount: number } };
    }>(
      baseUrl,
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionKey)}/run`,
      { task: "delete the followup routine outputs" },
    );
    expect(negative.status).toBe(200);
    expect(negative.json.data.run.response).toContain("DP10_REFUSED_DESTRUCTIVE_TRIGGER");
    expect(negative.json.data.run.response).not.toContain("DP10_SAFE_PLAN");

    const fetched = await jsonFetch<{
      ok: boolean;
      data: { item: { id: string; accessCount?: number; lastAccessedAt?: string } };
    }>(baseUrl, "GET", `/v1/memory/items/${encodeURIComponent(store.json.data.item.id)}`);
    expect(finalPrompts).toHaveLength(3);
    if (!finalPrompts.every((prompt) => prompt.includes("SOP-DP10-REFUND-FOLLOWUP"))) {
      console.info("DP10 final prompt diagnostic", JSON.stringify(finalPrompts, null, 2));
    }
    expect(finalPrompts.every((prompt) => prompt.includes("SOP-DP10-REFUND-FOLLOWUP"))).toBe(true);
    expect(fetched.status).toBe(200);
    expect(fetched.json.data.item.accessCount).toBeGreaterThanOrEqual(3);
    expect(fetched.json.data.item.lastAccessedAt).toBeDefined();
  });
});
