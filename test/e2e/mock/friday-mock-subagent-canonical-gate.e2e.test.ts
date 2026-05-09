import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createMockHubEnv,
  type MockHubEnv,
} from "./_helpers/mock-env.js";
import type {
  FridayChannelMessage,
  FridayChannelMessageHandler,
  FridayChannelPlugin,
  FridayChannelSendOptions,
} from "#channels";
import { resetMockCounters } from "../../_mocks/mock-llm-providers.js";

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

async function waitFor<T>(
  fn: () => Promise<T | null> | T | null,
  timeoutMs = 5_000,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await fn();
    if (value !== null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for condition");
}

interface AgentRunResponse {
  ok: boolean;
  data: {
    runId: string;
    status: string;
    response: string;
    toolCallCount: number;
  };
}

interface SubagentListResponse {
  ok: boolean;
  data: {
    items: Array<{
      id: string;
      childRunId: string;
      status: string;
    }>;
  };
}

interface ToolApprovalResponse {
  ok: boolean;
  data: {
    resolved: boolean;
    grantId?: string;
    decision?: "approved" | "rejected";
  };
}

interface TestChannelSentMessage extends FridayChannelSendOptions {
  messageId: string;
}

interface TestChannelHarness {
  plugin: FridayChannelPlugin;
  sent: TestChannelSentMessage[];
  emit(overrides: Partial<FridayChannelMessage> & {
    id: string;
    senderId: string;
    chatId: string;
    text: string;
  }): void;
}

function createTestChannelHarness(kind = "test-channel"): TestChannelHarness {
  let handler: FridayChannelMessageHandler | undefined;
  const sent: TestChannelSentMessage[] = [];
  const plugin: FridayChannelPlugin = {
    kind,
    async init() {},
    async start(onMessage) {
      handler = onMessage;
    },
    async stop() {
      handler = undefined;
    },
    async send(options) {
      const messageId = `sent-${String(sent.length + 1)}`;
      sent.push({ ...options, messageId });
      return { messageId };
    },
  };

  return {
    plugin,
    sent,
    emit(overrides) {
      if (!handler) {
        throw new Error("Test channel is not started");
      }
      handler({
        channelKind: kind,
        chatType: "group",
        timestamp: Date.now(),
        ...overrides,
      });
    },
  };
}

async function createDefaultProviderAliasForChannelRuns(env: MockHubEnv): Promise<void> {
  const provider = env.providers["anthropic"]!;
  const db = new Database(path.join(env.stateDir, "friday.db"));
  try {
    const columns = (db.prepare("PRAGMA table_info(provider_profiles)").all() as Array<{ name: string }>)
      .map((column) => column.name)
      .filter((name) => name !== "id");
    const columnList = columns.join(", ");
    db.prepare(
      `INSERT INTO provider_profiles (id, ${columnList})
       SELECT ?, ${columnList} FROM provider_profiles WHERE id = ?`,
    ).run("default", provider.providerId);
  } finally {
    db.close();
  }
  await env.hub.providerService.setRoutingConfig({
    defaultProviderId: "default",
    defaultModel: provider.model,
    fallbackProviderIds: [],
  });
}

describe("Friday mock subagent canonical gate E2E", () => {
  let env: MockHubEnv;
  let providerId: string;
  let model: string;
  let previousCanonicalGate: string | undefined;

  beforeAll(async () => {
    previousCanonicalGate = process.env.FRIDAY_CANONICAL_GATE;
    process.env.FRIDAY_CANONICAL_GATE = "true";
    env = await createMockHubEnv({ providerKinds: ["anthropic"] });
    const provider = env.providers["anthropic"]!;
    providerId = provider.providerId;
    model = provider.model;
  }, 30_000);

  afterAll(async () => {
    if (env) await env.cleanup();
    if (previousCanonicalGate === undefined) {
      delete process.env.FRIDAY_CANONICAL_GATE;
    } else {
      process.env.FRIDAY_CANONICAL_GATE = previousCanonicalGate;
    }
  }, 15_000);

  beforeEach(() => {
    for (const mock of Object.values(env.mocks)) {
      mock.reset();
    }
    resetMockCounters();
  });

  it("requires canonical approval before a subagent mutating tool executes", async () => {
    const mock = env.mockFor("anthropic");
    const sentinel = path.join(
      os.tmpdir(),
      `friday-subagent-canonical-${String(process.pid)}-${String(Date.now())}.txt`,
    );
    try {
      mock.enqueue(
        {
          type: "tool_use",
          toolName: "spawn_subagent",
          toolInput: {
            task: "Create the canonical gate sentinel file.",
            wait: true,
          },
          toolCallId: "parent-spawn-1",
        },
        {
          type: "tool_use",
          toolName: "exec",
          toolInput: {
            command: `touch ${sentinel}`,
          },
          toolCallId: "child-exec-1",
        },
        {
          type: "text",
          text: "Child completed the approved mutation.",
        },
        {
          type: "text",
          text: "Parent observed the approved child result.",
        },
      );

      const runPromise = apiFetch<AgentRunResponse>(
        env.baseUrl,
        env.accessToken,
        "POST",
        "/v1/agent/runs",
        {
          task: "Delegate a subagent to create a sentinel file.",
          providerId,
          model,
          timeoutMs: 20_000,
        },
      );

      const subagent = await waitFor(async () => {
        const res = await apiFetch<SubagentListResponse>(
          env.baseUrl,
          env.accessToken,
          "GET",
          "/v1/agent/subagents",
        );
        return res.json.data.items[0] ?? null;
      });

      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(fs.existsSync(sentinel)).toBe(false);

      const approval = await waitFor(async () => {
        const res = await apiFetch<ToolApprovalResponse>(
          env.baseUrl,
          env.accessToken,
          "POST",
          `/v1/agent/runs/${encodeURIComponent(subagent.childRunId)}/approve-tool`,
          { toolCallId: "child-exec-1" },
        );
        if (res.status !== 200 || !res.json.data?.resolved) {
          return null;
        }
        return res.json.data;
      });

      expect(approval.decision).toBe("approved");

      const run = await runPromise;
      expect(run.status).toBe(200);
      expect(run.json.ok).toBe(true);
      expect(run.json.data.status).toBe("completed");
      expect(run.json.data.response).toContain("approved child result");
      expect(fs.existsSync(sentinel)).toBe(true);
    } finally {
      fs.rmSync(sentinel, { force: true });
    }
  }, 30_000);
});

describe("Friday live-channel canonical approval adversarial E2E", () => {
  let env: MockHubEnv;
  const channel = createTestChannelHarness();
  let previousCanonicalGate: string | undefined;

  beforeAll(async () => {
    previousCanonicalGate = process.env.FRIDAY_CANONICAL_GATE;
    process.env.FRIDAY_CANONICAL_GATE = "true";
    env = await createMockHubEnv({
      providerKinds: ["anthropic"],
      channels: {
        enabled: true,
        instances: [],
      },
      beforeStart: async (hub) => {
        await channel.plugin.init({ kind: channel.plugin.kind, enabled: true });
        hub.channelRegistry.register(channel.plugin);
      },
    });
    await createDefaultProviderAliasForChannelRuns(env);
  }, 30_000);

  afterAll(async () => {
    if (env) await env.cleanup();
    if (previousCanonicalGate === undefined) {
      delete process.env.FRIDAY_CANONICAL_GATE;
    } else {
      process.env.FRIDAY_CANONICAL_GATE = previousCanonicalGate;
    }
  }, 15_000);

  beforeEach(() => {
    for (const mock of Object.values(env.mocks)) {
      mock.reset();
    }
    resetMockCounters();
    channel.sent.length = 0;
  });

  it("rejects a second group sender stealing approval before the original sender approves", async () => {
    const mock = env.mockFor("anthropic");
    const sentinel = path.join(
      os.tmpdir(),
      `friday-channel-canonical-${String(process.pid)}-${String(Date.now())}.txt`,
    );

    try {
      mock.enqueue(
        {
          type: "tool_use",
          toolName: "exec",
          toolInput: {
            command: `touch ${sentinel}`,
          },
          toolCallId: "channel-exec-1",
        },
        {
          type: "text",
          text: "Channel mutation completed after the original sender approved.",
        },
      );

      channel.emit({
        id: "msg-original-request",
        senderId: "user-a",
        senderName: "User A",
        chatId: "group-1",
        text: "Create the channel canonical approval sentinel file.",
      });

      const approvalPrompt = await waitFor(() =>
        channel.sent.find((message) => message.approval?.shortId) ?? null,
      );
      const shortId = approvalPrompt.approval!.shortId;
      expect(fs.existsSync(sentinel)).toBe(false);

      channel.emit({
        id: "msg-attacker-approve",
        senderId: "user-b",
        senderName: "User B",
        chatId: "group-1",
        text: `批准 ${shortId}`,
      });

      await waitFor(() =>
        channel.sent.find((message) => message.text.includes(`审批 ${shortId} 只能由原请求者确认。`)) ?? null,
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(fs.existsSync(sentinel)).toBe(false);

      channel.emit({
        id: "msg-original-approve",
        senderId: "user-a",
        senderName: "User A",
        chatId: "group-1",
        text: `批准 ${shortId}`,
      });

      await waitFor(() =>
        channel.sent.find((message) => message.text.includes(`已批准 ${shortId}`)) ?? null,
      );
      await waitFor(() => fs.existsSync(sentinel) ? true : null);
      expect(fs.existsSync(sentinel)).toBe(true);
    } finally {
      fs.rmSync(sentinel, { force: true });
    }
  }, 30_000);
});
