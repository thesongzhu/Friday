import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

import Database from "better-sqlite3";
import { beforeEach, describe, it, expect, afterEach, vi } from "vitest";
import type { FridayChannelMessage, FridayChannelPlugin } from "#channels";
import {
  createFridayHub,
  shouldFailClosedForFridayWorkspaceContext,
} from "#hub";
import type { FridayHub } from "#hub";
import { resolveStateDir } from "#state";
import { createFridayReflexCandidateRepository } from "../../../src/reflex/index.js";
import type { FridayCompiledWorkflowGraphV2 } from "#workflows";
import {
  clearAutoDetectProviderEnv,
  restoreAutoDetectProviderEnv,
  type FridayAutoDetectProviderEnvSnapshot,
} from "../../_helpers/auto-detect-provider-env.js";
import * as hubAuditWriterModule from "../../../src/hub/services/friday-hub-audit-log-writer.js";
import { createMockFetch, type MockLlmReply } from "../../_mocks/mock-llm-providers.js";

function createTestChannelPlugin(kind = "testchannel"): {
  plugin: FridayChannelPlugin;
  getStartedHandler: () => ((msg: FridayChannelMessage) => void) | null;
  sentMessages: string[];
} {
  let startedHandler: ((msg: FridayChannelMessage) => void) | null = null;
  const sentMessages: string[] = [];
  return {
    sentMessages,
    getStartedHandler: () => startedHandler,
    plugin: {
      kind,
      init: vi.fn(async () => {}),
      start: vi.fn(async (onMessage) => {
        startedHandler = onMessage;
      }),
      stop: vi.fn(async () => {}),
      send: vi.fn(async (options) => {
        sentMessages.push(options.text);
        return { messageId: `sent-${String(sentMessages.length)}` };
      }),
    },
  };
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function makeChannelApprovedWorkflowGraph(
  workflowId = "wf-placeholder",
  versionId = "wv-placeholder",
): FridayCompiledWorkflowGraphV2 {
  const graph: FridayCompiledWorkflowGraphV2 = {
    schemaVersion: "2.0",
    workflowId,
    workflowVersionId: versionId,
    sourceSpecSchemaVersion: "1.0",
    graph: {
      nodes: [
        { id: "trigger", type: "trigger", label: "Manual trigger", config: {} },
        {
          id: "receipt",
          type: "data",
          label: "Produce deterministic channel approval receipt",
          config: {
            mapping: {
              marker: "DP10_CHANNEL_APPROVED_WORKFLOW_EXECUTED",
              triggerPhrase: "$inputs.triggerPhrase",
            },
          },
        },
      ],
      edges: [{ id: "edge-trigger-receipt", sourceNodeId: "trigger", targetNodeId: "receipt" }],
    },
    failurePolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
    checksum: "placeholder-checksum",
  };
  return {
    ...graph,
    checksum: sha256(JSON.stringify({ ...graph, checksum: "" })),
  };
}

function makeChannelOrganicRunReplies(runCount: number): MockLlmReply[] {
  const replies: MockLlmReply[] = [];
  for (let index = 0; index < runCount; index += 1) {
    replies.push(
      {
        type: "tool_use",
        toolName: "memory_search",
        toolInput: {
          query: "weekly refund followup reusable channel path",
          namespace: "agent",
          limit: 3,
        },
      },
      {
        type: "tool_use",
        toolName: "memory_store",
        toolInput: {
          content: `DP10_CHANNEL_ORGANIC_REUSABLE_STEP_${String(index + 1)}: channel weekly refund followup uses memory_search -> memory_store -> memory_search.`,
          namespace: "agent",
          tags: ["dp10-channel-organic", "repeated-success"],
        },
      },
      {
        type: "tool_use",
        toolName: "memory_search",
        toolInput: {
          query: "DP10_CHANNEL_ORGANIC_REUSABLE_STEP weekly refund followup",
          namespace: "agent",
          limit: 3,
        },
      },
      {
        type: "text",
        text: "DP10_CHANNEL_ORGANIC_REPEATED_RUN_COMPLETED: channel task completed; reusable workflow candidate remains review-gated.",
      },
    );
  }
  return replies;
}

async function waitForWorkflowRunStable(
  hub: FridayHub,
  runId: string,
  timeoutMs = 10_000,
): Promise<string> {
  const start = Date.now();
  const transient = new Set(["queued", "running"]);
  while (Date.now() - start < timeoutMs) {
    const run = hub.workflowRuntime.execution.getRun(runId);
    if (run && !transient.has(run.status)) {
      return run.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const run = hub.workflowRuntime.execution.getRun(runId);
  return run?.status ?? "unknown";
}

describe("createFridayHub", () => {
  let hub: FridayHub | null = null;
  let stateDir: string | null = null;
  let homeDir: string | null = null;
  let bundledSkillsDir: string | null = null;
  let managedSkillsDir: string | null = null;
  let autoDetectEnvSnapshot: FridayAutoDetectProviderEnvSnapshot | null = null;
  const originalSuppression = process.env.FRIDAY_SUPPRESS_TEST_ENV_SECURITY_WARNINGS;

  async function createIsolatedHub(
    overrides: Partial<Parameters<typeof createFridayHub>[0]> = {},
  ): Promise<FridayHub> {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-hub-bootstrap-"));
    bundledSkillsDir = path.join(stateDir, "skills-empty");
    managedSkillsDir = path.join(stateDir, "managed-skills-empty");
    await fs.mkdir(bundledSkillsDir, { recursive: true });
    await fs.mkdir(managedSkillsDir, { recursive: true });
    hub = await createFridayHub({
      skillDirs: [bundledSkillsDir, managedSkillsDir],
      stateDir,
      ...overrides,
    });
    return hub;
  }

  beforeEach(() => {
    process.env.FRIDAY_SUPPRESS_TEST_ENV_SECURITY_WARNINGS = "1";
    autoDetectEnvSnapshot = clearAutoDetectProviderEnv();
  });

  afterEach(async () => {
    if (originalSuppression === undefined) {
      delete process.env.FRIDAY_SUPPRESS_TEST_ENV_SECURITY_WARNINGS;
    } else {
      process.env.FRIDAY_SUPPRESS_TEST_ENV_SECURITY_WARNINGS = originalSuppression;
    }
    if (hub) {
      await hub.stop();
      hub = null;
    }
    if (stateDir) {
      await fs.rm(stateDir, { recursive: true, force: true });
      stateDir = null;
    }
    if (homeDir) {
      await fs.rm(homeDir, { recursive: true, force: true });
      homeDir = null;
    }
    bundledSkillsDir = null;
    managedSkillsDir = null;
    if (autoDetectEnvSnapshot) {
      restoreAutoDetectProviderEnv(autoDetectEnvSnapshot);
      autoDetectEnvSnapshot = null;
    }
  });

  it("fails closed for standard general runs when user project rules cannot load", () => {
    expect(shouldFailClosedForFridayWorkspaceContext({
      promptProfile: "standard",
      contextPolicy: { workspaceContext: "auto" },
      toolRouting: { profile: "general" },
    })).toBe(true);
    expect(shouldFailClosedForFridayWorkspaceContext({
      promptProfile: "minimal",
      contextPolicy: { workspaceContext: "skip" },
      toolRouting: { profile: "trivial" },
    })).toBe(false);
    expect(shouldFailClosedForFridayWorkspaceContext({
      promptProfile: "standard",
      contextPolicy: { workspaceContext: "skip" },
      toolRouting: { profile: "status" },
    })).toBe(false);
  });

  it("creates a hub with default config", async () => {
    hub = await createIsolatedHub();
    expect(hub).toBeDefined();
    expect(hub.skills).toBeDefined();
    expect(hub.executor).toBeDefined();
  });

  it("fails closed for unsupported QQ in explicit startup channel config", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      hub = await createIsolatedHub({
        channels: {
          enabled: true,
          instances: [
            {
              kind: "qq",
              enabled: true,
              appId: "qq-app",
              appSecret: "qq-secret", // pragma: allowlist secret
            },
          ],
        },
      });

      expect(hub.channelRegistry.list()).not.toContain("qq");
      expect(warnSpy.mock.calls.some(([message]) =>
        String(message).includes("Channel qq disabled: kind is unsupported in this release."),
      )).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("fails closed for unsupported slack http mode in explicit startup channel config", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      hub = await createIsolatedHub({
        channels: {
          enabled: true,
          instances: [
            {
              kind: "slack",
              enabled: true,
              botToken: "xoxb-stub",
              mode: "http",
              signingSecret: "stub-signing-secret", // pragma: allowlist secret
            },
          ],
        },
      });

      expect(hub.channelRegistry.list()).not.toContain("slack");
      expect(warnSpy.mock.calls.some(([message]) =>
        String(message).includes("Channel slack disabled: mode http is unsupported in this release."),
      )).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("still registers supported slack socket mode from explicit startup channel config", async () => {
    process.env.FRIDAY_TEST_SLACK_BOT_TOKEN = "xoxb-stub";
    process.env.FRIDAY_TEST_SLACK_APP_TOKEN = "xapp-stub";
    try {
      hub = await createIsolatedHub({
        channels: {
          enabled: true,
          instances: [
            {
              kind: "slack",
              enabled: true,
              botToken: "env:FRIDAY_TEST_SLACK_BOT_TOKEN",
              appToken: "env:FRIDAY_TEST_SLACK_APP_TOKEN",
              mode: "socket",
              // Control-capable channels fail closed without a persisted
              // allowlist; provide one so this asserts socket mode IS supported.
              allowedUsers: ["U-allowed-user"],
            },
          ],
        },
      });

      expect(hub.channelRegistry.list()).toContain("slack");
    } finally {
      delete process.env.FRIDAY_TEST_SLACK_BOT_TOKEN;
      delete process.env.FRIDAY_TEST_SLACK_APP_TOKEN;
    }
  });

  it("does not expose unsupported QQ as a runtime-supported channel kind", async () => {
    hub = await createIsolatedHub();
    const routes = hub.apiRuntime.routes.getRoutes();
    const healthRoute = routes.find((route) => route.operationId === "health.capabilities");
    const personaRoute = routes.find((route) => route.operationId === "channels.persona.get");

    const health = await healthRoute!.handler({} as never) as {
      capabilities: { channels: { supportedKinds: string[] } };
    };

    expect(health.capabilities.channels.supportedKinds).not.toContain("qq");
    expect(health.capabilities.channels.supportedKinds).toContain("telegram");

    await expect(personaRoute!.handler({
      requestId: "req-channel-persona-qq",
      receivedAt: "2026-05-26T00:00:00.000Z",
      params: { kind: "qq" },
      query: {},
      body: null,
      headers: {},
      principal: null,
    } as never)).rejects.toMatchObject({ code: "CHANNEL_NOT_FOUND" });

    await expect(personaRoute!.handler({
      requestId: "req-channel-persona-telegram",
      receivedAt: "2026-05-26T00:00:00.000Z",
      params: { kind: "telegram" },
      query: {},
      body: null,
      headers: {},
      principal: null,
    } as never)).resolves.toMatchObject({ kind: "telegram", persona: null });
  });

  it("starts in stopped state", async () => {
    hub = await createIsolatedHub();
    const status = hub.status();
    expect(status.state).toBe("stopped");
    expect(status.skillCount).toBe(0);
    expect(status.upSince).toBeNull();
  });

  it("transitions to running after start()", async () => {
    hub = await createIsolatedHub();
    await hub.start();
    const status = hub.status();
    expect(status.state).toBe("running");
    expect(status.upSince).not.toBeNull();
  }, 20_000);

  it("transitions to stopped after stop()", async () => {
    hub = await createIsolatedHub();
    await hub.start();
    await hub.stop();
    hub = null; // already stopped
    // Can't check status after stop since sqlite is closed
  });

  it("returns skillCount 0 with no skill dirs", async () => {
    hub = await createIsolatedHub();
    await hub.start();
    const status = hub.status();
    expect(status.skillCount).toBe(0);
  }, 20_000);

  it("wires observability routes into the API runtime", async () => {
    hub = await createIsolatedHub();
    const operationIds = hub.apiRuntime.routes.getRoutes().map((route) => route.operationId);
    expect(operationIds).toContain("version.get");
    expect(operationIds).toContain("config.get");
    expect(operationIds).toContain("secrets.list");
    expect(operationIds).toContain("observability.overview");
    expect(operationIds).toContain("observability.time.series");
    expect(operationIds).toContain("agent.loop.policy.get");
  });

  it("wires canonical skill lifecycle routes into the API runtime", async () => {
    hub = await createIsolatedHub({ allowTestOnlySkillVerifyExecution: true });
    const routes = hub.apiRuntime.routes.getRoutes();
    const operationIds = routes.map((route) => route.operationId);

    expect(operationIds).toContain("skills.catalog.list");
    expect(operationIds).toContain("skills.get");
    expect(operationIds).toContain("skills.install");
    expect(operationIds).toContain("skills.update");
    expect(operationIds).toContain("skills.delete");
    expect(operationIds).toContain("skills.manifest.validate");
    expect(operationIds).toContain("skills.verify");

    const verifyRoute = routes.find((route) => route.operationId === "skills.verify");
    await expect(verifyRoute!.handler({
      requestId: "req-skill-verify-route",
      receivedAt: "2026-05-12T00:00:00.000Z",
      params: { skillId: "missing-skill" },
      query: {},
      body: null,
      headers: {},
      principal: {
        principalType: "user",
        principalId: "user-1",
        userId: "user-1",
        role: "admin",
        scopes: ["hub.admin"],
        tokenId: "token-1",
        tokenKind: "access",
        issuedAt: "2026-05-12T00:00:00.000Z",
        expiresAt: "2026-05-12T01:00:00.000Z",
      },
    } as never)).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
  });

  it("deduplicates expected startup warnings across repeated hub bootstraps", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      hub = await createIsolatedHub();
      await hub.stop();
      hub = null;
      if (stateDir) {
        await fs.rm(stateDir, { recursive: true, force: true });
        stateDir = null;
      }
      bundledSkillsDir = null;
      managedSkillsDir = null;

      hub = await createIsolatedHub();

      const warnings = warnSpy.mock.calls.map(([message]) => String(message));
      // The admin-user warning now always prints via console.warn (no longer
      // deduplicated by warnOnce), so each hub bootstrap emits it once.
      const adminWarnings = warnings.filter((message) => message.includes("Created default admin user"));
      expect(adminWarnings.length).toBe(2);
      expect(warnings.filter((message) => message.includes("No model routing configured"))).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("always emits bootstrap admin warning regardless of test security warning suppression", async () => {
    process.env.FRIDAY_SUPPRESS_TEST_ENV_SECURITY_WARNINGS = "1";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      hub = await createIsolatedHub();
      const warnings = warnSpy.mock.calls.map(([message]) => String(message));
      // Suppression env var no longer prevents the admin warning from being emitted
      expect(warnings.filter((message) => message.includes("Created default admin user"))).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("uses the initialized state runtime path for audit logs when stateDir config is omitted", async () => {
    const originalHome = process.env.HOME;
    const originalStateDirEnv = process.env.FRIDAY_STATE_DIR;
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-hub-home-"));
    process.env.HOME = homeDir;
    delete process.env.FRIDAY_STATE_DIR;

    bundledSkillsDir = path.join(homeDir, "skills-empty");
    managedSkillsDir = path.join(homeDir, "managed-skills-empty");
    await fs.mkdir(bundledSkillsDir, { recursive: true });
    await fs.mkdir(managedSkillsDir, { recursive: true });

    stateDir = resolveStateDir({ env: process.env, homedir: () => homeDir! });

    const auditPathSpy = vi.spyOn(hubAuditWriterModule, "resolveFridayAuditLogPath");
    try {
      hub = await createFridayHub({
        skillDirs: [bundledSkillsDir, managedSkillsDir],
      });

      expect(auditPathSpy).toHaveBeenCalledWith(stateDir);
    } finally {
      auditPathSpy.mockRestore();
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalStateDirEnv === undefined) {
        delete process.env.FRIDAY_STATE_DIR;
      } else {
        process.env.FRIDAY_STATE_DIR = originalStateDirEnv;
      }
    }
  });

  it("executor returns failed for unknown skill", async () => {
    hub = await createIsolatedHub();
    await hub.start();

    const handle = hub.executor.execute({
      skillId: "nonexistent-skill",
      input: {},
      sessionId: "test-session",
      userId: "test-user",
      channel: "test",
    });

    const result = await handle.result;
    expect(result.status).toBe("failed");
    expect(result.stderr).toContain("not found");
  }, 20_000);

  it("routes channel high-impact preference commands to Review Center confirmation", async () => {
    hub = await createIsolatedHub();
    const channel = createTestChannelPlugin();
    hub.channelRegistry.register(channel.plugin);

    await hub.start();
    const onMessage = channel.getStartedHandler();
    expect(onMessage).toBeTypeOf("function");

    onMessage!({
      id: "msg-reflex-policy-1",
      channelKind: "testchannel",
      senderId: "sender-1",
      senderName: "Alice",
      chatId: "chat-1",
      chatType: "direct",
      text: "以后允许 live llm 测试",
      timestamp: Date.now(),
    });

    await vi.waitFor(() => {
      expect(channel.sentMessages.some((message) => message.includes("Review Center 待确认"))).toBe(true);
    });

    const candidatesRoute = hub.apiRuntime.routes
      .getRoutes()
      .find((route) => route.operationId === "reflex.candidates.list");
    const preferencesRoute = hub.apiRuntime.routes
      .getRoutes()
      .find((route) => route.operationId === "reflex.preferences.list");
    expect(candidatesRoute).toBeDefined();
    expect(preferencesRoute).toBeDefined();

    const principal = {
      principalType: "user",
      principalId: "admin-001",
      userId: "admin-001",
      scopes: ["agent.run"],
      tokenId: "tok-1",
      tokenKind: "access",
      issuedAt: "2026-04-30T12:00:00.000Z",
    };
    const candidates = await candidatesRoute!.handler({
      params: {},
      query: { kind: "preference", status: "ready_for_review" },
      body: null,
      headers: {},
      principal,
    } as never) as { items: Array<{ payload: Record<string, unknown>; evidence: Record<string, unknown> }> };
    const preferences = await preferencesRoute!.handler({
      params: {},
      query: {},
      body: null,
      headers: {},
      principal,
    } as never) as { items: Array<{ category: string; key: string; value: unknown }> };

    expect(candidates.items).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        category: "reflex",
        key: "testing.live_llm_policy",
        value: "allowed_with_cost_notice",
      }),
      evidence: expect.objectContaining({
        requiresExplicitConfirmation: true,
        sourceSurface: "channel",
      }),
    }));
    expect(preferences.items).not.toContainEqual(expect.objectContaining({
      category: "reflex",
      key: "testing.live_llm_policy",
    }));
  }, 20_000);

  it("routes channel reflex candidate approval commands through Reflex service and mirrors the ack", async () => {
    hub = await createIsolatedHub();
    const channel = createTestChannelPlugin();
    hub.channelRegistry.register(channel.plugin);

    await hub.start();
    const onMessage = channel.getStartedHandler();
    expect(onMessage).toBeTypeOf("function");

    onMessage!({
      id: "msg-reflex-policy-approve-seed",
      channelKind: "testchannel",
      senderId: "sender-1",
      senderName: "Alice",
      chatId: "chat-1",
      chatType: "direct",
      text: "以后允许 live llm 测试",
      timestamp: Date.now(),
    });

    await vi.waitFor(() => {
      expect(channel.sentMessages.some((message) => message.includes("Review Center 待确认"))).toBe(true);
    });

    const candidatesRoute = hub.apiRuntime.routes
      .getRoutes()
      .find((route) => route.operationId === "reflex.candidates.list");
    const preferencesRoute = hub.apiRuntime.routes
      .getRoutes()
      .find((route) => route.operationId === "reflex.preferences.list");
    expect(candidatesRoute).toBeDefined();
    expect(preferencesRoute).toBeDefined();

    const principal = {
      principalType: "user",
      principalId: "admin-001",
      userId: "admin-001",
      scopes: ["agent.run"],
      tokenId: "tok-1",
      tokenKind: "access",
      issuedAt: "2026-04-30T12:00:00.000Z",
    };
    const candidatesBefore = await candidatesRoute!.handler({
      params: {},
      query: { kind: "preference", status: "ready_for_review" },
      body: null,
      headers: {},
      principal,
    } as never) as { items: Array<{ id: string; status: string; payload: Record<string, unknown> }> };
    expect(candidatesBefore.items).toHaveLength(1);
    const candidateId = candidatesBefore.items[0]!.id;

    onMessage!({
      id: "msg-reflex-policy-approve-command",
      channelKind: "testchannel",
      senderId: "sender-1",
      senderName: "Alice",
      chatId: "chat-1",
      chatType: "direct",
      text: `approve reflex ${candidateId}`,
      timestamp: Date.now(),
    });

    await vi.waitFor(() => {
      expect(channel.sentMessages.some((message) =>
        message.includes(`Reflex candidate ${candidateId} 已更新为 approved`),
      )).toBe(true);
    });

    const approvedCandidates = await candidatesRoute!.handler({
      params: {},
      query: { kind: "preference", status: "approved" },
      body: null,
      headers: {},
      principal,
    } as never) as { items: Array<{ id: string; status: string }> };
    expect(approvedCandidates.items).toContainEqual(expect.objectContaining({
      id: candidateId,
      status: "approved",
    }));

    const preferences = await preferencesRoute!.handler({
      params: {},
      query: {},
      body: null,
      headers: {},
      principal,
    } as never) as { items: Array<{ category: string; key: string; value: unknown }> };
    expect(preferences.items).toContainEqual(expect.objectContaining({
      category: "reflex",
      key: "testing.live_llm_policy",
      value: "allowed_with_cost_notice",
    }));

    onMessage!({
      id: "msg-reflex-policy-approve-missing",
      channelKind: "testchannel",
      senderId: "sender-1",
      senderName: "Alice",
      chatId: "chat-1",
      chatType: "direct",
      text: "approve reflex missing-candidate-404",
      timestamp: Date.now(),
    });

    await vi.waitFor(() => {
      expect(channel.sentMessages.some((message) =>
        message.includes("Reflex candidate missing-candidate-404 处理失败"),
      )).toBe(true);
    });
  }, 20_000);

  it("rejects and approves workflow Reflex candidates from channel commands before running the published workflow", async () => {
    hub = await createIsolatedHub();
    const channel = createTestChannelPlugin();
    hub.channelRegistry.register(channel.plugin);

    await hub.start();
    const onMessage = channel.getStartedHandler();
    expect(onMessage).toBeTypeOf("function");
    expect(stateDir).toBeTruthy();

    const userId = "admin-001";
    const rejectCandidateId = "workflow-channel-reject-candidate";
    const approveCandidateId = "workflow-channel-approve-candidate";
    const generatorSessionId = "workflow-channel-approve-session";
    const db = new Database(path.join(stateDir!, "friday.db"));
    try {
      const candidateRepo = createFridayReflexCandidateRepository();
      const insertWorkflowCandidate = (candidateId: string, sessionId: string, title: string) => {
        candidateRepo.insert(db, {
          id: candidateId,
          nowIso: new Date().toISOString(),
          userId,
          kind: "workflow",
          origin: "post_run",
          status: "ready_for_review",
          sourceRunId: `run-${candidateId}`,
          sessionKey: `session-${candidateId}`,
          channelKind: "testchannel",
          channelUserId: "sender-1",
          title,
          summary: "Channel command proof workflow candidate",
          payload: {
            goal: "Create a safe deterministic workflow candidate from a channel command.",
          },
          evidence: {
            generatorSessionId: sessionId,
            mode: "test_fixture",
            draftWorkflowId: `draft-${candidateId}`,
            draftName: title,
            validationOk: true,
            qaVerdict: { status: "passed", source: "channel-command-proof" },
            harness: { status: "passed", source: "channel-command-proof" },
          },
          confidence: 0.91,
          riskTier: 3,
        });
      };

      insertWorkflowCandidate(
        rejectCandidateId,
        "workflow-channel-reject-session",
        "Reject deterministic channel workflow",
      );
      insertWorkflowCandidate(
        approveCandidateId,
        generatorSessionId,
        "Approve deterministic channel workflow",
      );
    } finally {
      db.close();
    }

    let approvedWorkflowId = "";
    let approvedWorkflowVersionId = "";
    const approveAndSaveCalls: string[] = [];
    const originalApproveAndSave = hub.workflowGenerator.approveAndSave.bind(hub.workflowGenerator);
    try {
      hub.workflowGenerator.approveAndSave = async (sessionId: string) => {
        approveAndSaveCalls.push(sessionId);
        expect(sessionId).toBe(generatorSessionId);
        const { workflow, version } = hub!.workflowRuntime.crud.createWorkflowWithVersion(
          {
            slug: "dp10-channel-approved-workflow",
            name: "DP-10 Channel approved workflow",
            description: "Deterministic workflow created after trusted channel approval.",
            tags: ["dp10-channel-approval"],
            ownerUserId: userId,
          },
          makeChannelApprovedWorkflowGraph(),
          userId,
          "Approved through channel Reflex command local proof.",
        );
        const published = hub!.workflowRuntime.crud.publishVersion(workflow.id, version.versionNumber);
        approvedWorkflowId = workflow.id;
        approvedWorkflowVersionId = published.id;
        return {
          sessionId,
          workflowId: workflow.id,
          workflowVersionId: published.id,
          versionNumber: published.versionNumber,
          slug: workflow.slug,
          published: true,
          publicationBoundary: {
            stage: "published_version",
            lifecyclePromotion: "not_lifecycle_promoted",
            proofBoundary: "crud_publish_only",
            summary: "Published for deterministic channel command proof; lifecycle promotion remains separate.",
          },
        };
      };

      expect(hub.workflowRuntime.crud.listWorkflows({ tag: "dp10-channel-approval", archived: false })).toHaveLength(0);

      onMessage!({
        id: "msg-reflex-workflow-reject-command",
        channelKind: "testchannel",
        senderId: "sender-1",
        senderName: "Alice",
        chatId: "chat-1",
        chatType: "direct",
        text: `reject reflex ${rejectCandidateId} unsafe invoice mutation`,
        timestamp: Date.now(),
      });

      await vi.waitFor(() => {
        expect(channel.sentMessages.some((message) =>
          message.includes(`Reflex candidate ${rejectCandidateId} 已更新为 rejected`),
        )).toBe(true);
      });

      expect(approveAndSaveCalls).toHaveLength(0);
      expect(hub.workflowRuntime.crud.listWorkflows({ tag: "dp10-channel-approval", archived: false })).toHaveLength(0);

      onMessage!({
        id: "msg-reflex-workflow-approve-command",
        channelKind: "testchannel",
        senderId: "sender-1",
        senderName: "Alice",
        chatId: "chat-1",
        chatType: "direct",
        text: `approve reflex ${approveCandidateId}`,
        timestamp: Date.now(),
      });

      await vi.waitFor(() => {
        expect(channel.sentMessages.some((message) =>
          message.includes(`Reflex candidate ${approveCandidateId} 已更新为 approved`),
        )).toBe(true);
      });

      expect(approveAndSaveCalls).toEqual([generatorSessionId]);
      expect(approvedWorkflowId).toBeTruthy();
      expect(approvedWorkflowVersionId).toBeTruthy();
      expect(hub.workflowRuntime.crud.listWorkflows({ tag: "dp10-channel-approval", archived: false })
        .map((workflow) => workflow.id)).toContain(approvedWorkflowId);

      const candidatesRoute = hub.apiRuntime.routes
        .getRoutes()
        .find((route) => route.operationId === "reflex.candidates.list");
      expect(candidatesRoute).toBeDefined();
      const principal = {
        principalType: "user",
        principalId: userId,
        userId,
        scopes: ["agent.run"],
        tokenId: "tok-1",
        tokenKind: "access",
        issuedAt: "2026-04-30T12:00:00.000Z",
      };
      const approvedCandidates = await candidatesRoute!.handler({
        params: {},
        query: { kind: "workflow", status: "approved" },
        body: null,
        headers: {},
        principal,
      } as never) as { items: Array<{ id: string; status: string; evidence: Record<string, unknown> }> };
      const approved = approvedCandidates.items.find((item) => item.id === approveCandidateId);
      expect(approved).toEqual(expect.objectContaining({
        id: approveCandidateId,
        status: "approved",
      }));
      expect(approved!.evidence.savedWorkflowId).toBe(approvedWorkflowId);
      expect(approved!.evidence.workflowVersionId).toBe(approvedWorkflowVersionId);
      expect(approved!.evidence.published).toBe(true);

      const rejectedCandidates = await candidatesRoute!.handler({
        params: {},
        query: { kind: "workflow", status: "rejected" },
        body: null,
        headers: {},
        principal,
      } as never) as { items: Array<{ id: string; status: string; evidence: Record<string, unknown> }> };
      const rejected = rejectedCandidates.items.find((item) => item.id === rejectCandidateId);
      expect(rejected).toEqual(expect.objectContaining({
        id: rejectCandidateId,
        status: "rejected",
      }));
      expect(rejected!.evidence.savedWorkflowId).toBeUndefined();
      expect(rejected!.evidence.workflowVersionId).toBeUndefined();

      const run = await hub.workflowRuntime.execution.startRun({
        workflowId: approvedWorkflowId,
        workflowVersionId: approvedWorkflowVersionId,
        triggerType: "manual",
        triggerPayload: { triggerPhrase: "run the channel approved workflow" },
        startedByUserId: userId,
      });
      const finalStatus = await waitForWorkflowRunStable(hub, run.id);
      expect(finalStatus).toBe("completed");
      const evidence = hub.workflowRuntime.evidence.getRunEvidence(run.id);
      expect(evidence.summary.totalEvents).toBeGreaterThan(0);
    } finally {
      hub.workflowGenerator.approveAndSave = originalApproveAndSave;
    }
  }, 20_000);

  it("creates workflow Reflex candidates from channel agent runs, rejects one, then approves and runs another", async () => {
    const originalFetch = globalThis.fetch;
    const originalCanonicalGate = process.env.FRIDAY_CANONICAL_GATE;
    process.env.FRIDAY_CANONICAL_GATE = "true";
    const mockLlmFetch = createMockFetch("openai-completions", {
      initialReplies: [
        { type: "text", text: "OK" },
        { type: "text", text: "OK" },
        ...makeChannelOrganicRunReplies(4),
      ],
    });
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url.endsWith("/v1/models") || url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return mockLlmFetch(input, init);
    }) as typeof fetch;

    hub = await createIsolatedHub();
    const channel = createTestChannelPlugin();
    hub.channelRegistry.register(channel.plugin);

    const provider = await hub.providerService.createProvider({
      kind: "openai-compatible",
      name: "DP-10 channel organic provider",
      baseUrl: "https://example.com",
      authMode: "none",
      api: "openai-completions",
      supportedModels: ["gpt-4o"],
      defaultModel: "gpt-4o",
      enabled: true,
      validateOnSave: false,
    });
    await expect(hub.providerService.validateProvider(provider.id)).resolves.toMatchObject({
      status: "ok",
    });
    const capabilityReport = await hub.providerService.runCapabilityDoctor({ providerIds: [provider.id] });
    expect(capabilityReport.capabilityResults).toContainEqual(expect.objectContaining({
      providerId: provider.id,
      capability: "text",
      model: "gpt-4o",
      status: "verified",
    }));
    await hub.providerService.setRoutingConfig({
      defaultProviderId: provider.id,
      fallbackProviderIds: [],
    });

    let generatorSessionCounter = 0;
    let approvedWorkflowId = "";
    let approvedWorkflowVersionId = "";
    const approveAndSaveCalls: string[] = [];
    const originalStartSession = hub.workflowGenerator.startSession;
    const originalSubmitTurn = hub.workflowGenerator.submitTurn;
    const originalGetSession = hub.workflowGenerator.getSession;
    const originalGenerateDraft = hub.workflowGenerator.generateDraft;
    const originalGetQaVerdict = hub.workflowGenerator.getQaVerdict;
    const originalGetHarnessSummary = hub.workflowGenerator.getHarnessSummary;
    const originalApproveAndSave = hub.workflowGenerator.approveAndSave;
    const originalCancelSession = hub.workflowGenerator.cancelSession;

    try {
      hub.workflowGenerator.startSession = async () => {
        generatorSessionCounter += 1;
        return {
          mode: "new",
          session: { sessionId: `dp10-channel-organic-generator-${String(generatorSessionCounter)}` },
        };
      };
      hub.workflowGenerator.submitTurn = async () => undefined as never;
      hub.workflowGenerator.getSession = async () => undefined;
      hub.workflowGenerator.generateDraft = async (sessionId: string) => ({
        spec: {
          workflowId: `draft-${sessionId}`,
          name: "DP-10 channel organic generated workflow",
        },
        validation: { ok: true },
      });
      hub.workflowGenerator.getQaVerdict = async () => ({
        status: "passed",
        source: "dp10-channel-organic-deterministic-generator",
      });
      hub.workflowGenerator.getHarnessSummary = async () => ({
        status: "passed",
        source: "dp10-channel-organic-deterministic-generator",
      });
      hub.workflowGenerator.approveAndSave = async (sessionId: string) => {
        approveAndSaveCalls.push(sessionId);
        const { workflow, version } = hub!.workflowRuntime.crud.createWorkflowWithVersion(
          {
            slug: `dp10-channel-organic-approved-${sessionId}`,
            name: "DP-10 channel organic approved workflow",
            description: "Generated from repeated channel agent runs and approved through channel Reflex command.",
            tags: ["dp10-channel-organic"],
            ownerUserId: "admin-001",
          },
          makeChannelApprovedWorkflowGraph(),
          "admin-001",
          "Approved through DP-10 product-created channel candidate proof.",
        );
        const published = hub!.workflowRuntime.crud.publishVersion(workflow.id, version.versionNumber);
        approvedWorkflowId = workflow.id;
        approvedWorkflowVersionId = published.id;
        return {
          sessionId,
          workflowId: workflow.id,
          workflowVersionId: published.id,
          versionNumber: published.versionNumber,
          slug: workflow.slug,
          published: true,
          publicationBoundary: {
            stage: "published_version",
            lifecyclePromotion: "not_lifecycle_promoted",
            proofBoundary: "product_created_channel_candidate_deterministic",
            summary: "Published for local product-created channel candidate proof; live external delivery remains separate.",
          },
        };
      };
      hub.workflowGenerator.cancelSession = async () => undefined;

      await hub.start();
      const onMessage = channel.getStartedHandler();
      expect(onMessage).toBeTypeOf("function");

      const approveNextChannelToolPrompt = async (
        sentCountBefore: number,
        approvalMessageId: string,
        completedMarker?: string,
        chatId = "chat-organic",
      ): Promise<string | null> => {
        let approvalPromptText: string | undefined;
        let shortId = "";
        await vi.waitFor(() => {
          const sentSinceTrigger = channel.sentMessages.slice(sentCountBefore);
          approvalPromptText = sentSinceTrigger.find((message) =>
            message.includes("需要确认敏感操作") && message.includes("工具: "),
          );
          const completed = completedMarker
            ? sentSinceTrigger.some((message) => message.includes(completedMarker))
            : false;
          expect(Boolean(approvalPromptText) || completed).toBe(true);
        }, { timeout: 20_000 });
        if (!approvalPromptText) return null;

        const parsed = /需要确认敏感操作\s+([a-z0-9_-]+)/iu.exec(approvalPromptText)?.[1];
        expect(parsed).toBeTruthy();
        shortId = parsed!;

        onMessage!({
          id: approvalMessageId,
          channelKind: "testchannel",
          senderId: "sender-1",
          senderName: "Alice",
          chatId,
          chatType: "direct",
          text: `批准 ${shortId}`,
          timestamp: Date.now(),
        });

        await vi.waitFor(() => {
          expect(channel.sentMessages.some((message) =>
            message.includes(`已批准 ${shortId}`) && message.includes("Friday 会继续执行"),
          )).toBe(true);
        }, { timeout: 20_000 });

        return shortId;
      };

      const sendChannelTask = async (id: string, text: string) => {
        const sentCountBefore = channel.sentMessages.length;
        onMessage!({
          id,
          channelKind: "testchannel",
          senderId: "sender-1",
          senderName: "Alice",
          chatId: "chat-organic",
          chatType: "direct",
          text,
          timestamp: Date.now(),
        });
        await approveNextChannelToolPrompt(
          sentCountBefore,
          `${id}-approve-memory-store`,
          "DP10_CHANNEL_ORGANIC_REPEATED_RUN_COMPLETED",
        );
        await vi.waitFor(() => {
          expect(channel.sentMessages.slice(sentCountBefore).some((message) =>
            message.includes("DP10_CHANNEL_ORGANIC_REPEATED_RUN_COMPLETED"),
          )).toBe(true);
        }, { timeout: 20_000 });
      };

      await sendChannelTask("msg-channel-organic-1", "prepare the weekly refund followup pack");
      await sendChannelTask("msg-channel-organic-2", "prepare the weekly refund followup pack");
      await sendChannelTask("msg-channel-organic-3", "prepare the weekly refund followup pack");
      await sendChannelTask("msg-channel-organic-4", "prepare the weekly refund followup pack");

      expect(mockLlmFetch.calls.length).toBeGreaterThanOrEqual(16);

      const candidatesRoute = hub.apiRuntime.routes
        .getRoutes()
        .find((route) => route.operationId === "reflex.candidates.list");
      expect(candidatesRoute).toBeDefined();
      const principal = {
        principalType: "user",
        principalId: "sender-1",
        userId: "sender-1",
        scopes: ["agent.run"],
        tokenId: "tok-1",
        tokenKind: "access",
        issuedAt: "2026-04-30T12:00:00.000Z",
      };
      const readyCandidates = await candidatesRoute!.handler({
        params: {},
        query: { kind: "workflow", status: "ready_for_review" },
        body: null,
        headers: {},
        principal,
      } as never) as { items: Array<{ id: string; evidence: Record<string, unknown>; channelKind?: string }> };
      expect(readyCandidates.items.length).toBeGreaterThanOrEqual(2);
      const [candidateToReject, candidateToApprove] = readyCandidates.items;
      expect(candidateToReject!.evidence.priorRecipeCandidate).toBe(true);
      expect(candidateToApprove!.evidence.priorRecipeCandidate).toBe(true);

      onMessage!({
        id: "msg-channel-organic-reject",
        channelKind: "testchannel",
        senderId: "sender-1",
        senderName: "Alice",
        chatId: "chat-organic",
        chatType: "direct",
        text: `reject reflex ${candidateToReject!.id} unsafe external send`,
        timestamp: Date.now(),
      });

      await vi.waitFor(() => {
        expect(channel.sentMessages.some((message) =>
          message.includes(`Reflex candidate ${candidateToReject!.id} 已更新为 rejected`),
        )).toBe(true);
      }, { timeout: 10_000 });
      expect(approveAndSaveCalls).toHaveLength(0);
      expect(hub.workflowRuntime.crud.listWorkflows({ tag: "dp10-channel-organic", archived: false })).toHaveLength(0);

      onMessage!({
        id: "msg-channel-organic-approve",
        channelKind: "testchannel",
        senderId: "sender-1",
        senderName: "Alice",
        chatId: "chat-organic",
        chatType: "direct",
        text: `approve reflex ${candidateToApprove!.id}`,
        timestamp: Date.now(),
      });

      await vi.waitFor(() => {
        expect(channel.sentMessages.some((message) =>
          message.includes(`Reflex candidate ${candidateToApprove!.id} 已更新为 approved`),
        )).toBe(true);
      }, { timeout: 10_000 });
      expect(approveAndSaveCalls).toHaveLength(1);
      expect(approvedWorkflowId).toBeTruthy();
      expect(approvedWorkflowVersionId).toBeTruthy();

      const memoryStoreRoute = hub.apiRuntime.routes
        .getRoutes()
        .find((route) => route.operationId === "memory.store");
      expect(memoryStoreRoute).toBeDefined();
      const sopMemory = await memoryStoreRoute!.handler({
        params: {},
        query: {},
        body: {
          namespace: "agent",
          content: [
            "DP10_CHANNEL_APPROVED_SOP",
            "Trigger phrases: new topic: execute approved channel refund followup automation now; do the approved channel refund followup cleanup.",
            `Workflow: ${approvedWorkflowId}`,
            `Version: ${approvedWorkflowVersionId}`,
            "Allowed mutations: run only the approved product-created workflow after explicit Reflex candidate approval.",
            "Denied trigger: delete all refund followup source files or send external messages without approval.",
          ].join("\n"),
          source: "dp10-channel-product-proof",
          tags: ["dp10-channel-organic", "sop", "approved-workflow-trigger"],
          memoryType: "procedure",
          confidence: 0.99,
        },
        headers: {},
        principal,
      } as never) as { item: { id: string; namespace: string } };
      expect(sopMemory.item.namespace).toMatch(/\.agent$/u);

      const approvedCandidates = await candidatesRoute!.handler({
        params: {},
        query: { kind: "workflow", status: "approved" },
        body: null,
        headers: {},
        principal,
      } as never) as { items: Array<{ id: string; status: string; evidence: Record<string, unknown> }> };
      expect(approvedCandidates.items).toContainEqual(expect.objectContaining({
        id: candidateToApprove!.id,
        status: "approved",
        evidence: expect.objectContaining({
          savedWorkflowId: approvedWorkflowId,
          workflowVersionId: approvedWorkflowVersionId,
          published: true,
        }),
      }));

      const rejectedCandidates = await candidatesRoute!.handler({
        params: {},
        query: { kind: "workflow", status: "rejected" },
        body: null,
        headers: {},
        principal,
      } as never) as { items: Array<{ id: string; status: string; evidence: Record<string, unknown> }> };
      const rejected = rejectedCandidates.items.find((item) => item.id === candidateToReject!.id);
      expect(rejected).toEqual(expect.objectContaining({
        id: candidateToReject!.id,
        status: "rejected",
      }));
      expect(rejected!.evidence.savedWorkflowId).toBeUndefined();
      expect(rejected!.evidence.workflowVersionId).toBeUndefined();

      const run = await hub.workflowRuntime.execution.startRun({
        workflowId: approvedWorkflowId,
        workflowVersionId: approvedWorkflowVersionId,
        triggerType: "manual",
        triggerPayload: { triggerPhrase: "run product-created channel approved workflow" },
        startedByUserId: "admin-001",
      });
      const finalStatus = await waitForWorkflowRunStable(hub, run.id);
      expect(finalStatus).toBe("completed");
      const evidence = hub.workflowRuntime.evidence.getRunEvidence(run.id);
      expect(evidence.summary.totalEvents).toBeGreaterThan(0);

      const naturalTriggerPhrase = "new topic: execute approved channel refund followup automation now";
      const freshTriggerChatId = "chat-organic-execute";
      const naturalTriggerMarker =
        "DP10_CHANNEL_APPROVED_WORKFLOW_TRIGGER_EXECUTED: approved workflow ran from a fresh channel trigger after memory recall, workflow_list discovery, Reflex candidate approval, and channel tool approval.";
      const naturalTriggerReplies: MockLlmReply[] = [
        {
          type: "tool_use",
          toolName: "memory_search",
          toolInput: {
            query: "DP10_CHANNEL_APPROVED_SOP weekly refund followup automation",
            namespace: "agent",
            limit: 3,
          },
        },
        {
          type: "tool_use",
          toolName: "workflow_list",
          toolInput: {
            tag: "dp10-channel-organic",
            publishedOnly: true,
            limit: 5,
          },
        },
        {
          type: "tool_use",
          toolName: "workflow_run",
          toolInput: {
            workflowId: approvedWorkflowId,
            versionId: approvedWorkflowVersionId,
            input: {
              triggerPhrase: naturalTriggerPhrase,
              proofMemoryId: sopMemory.item.id,
            },
          },
        },
        {
          type: "text",
          text: naturalTriggerMarker,
        },
      ];
      mockLlmFetch.reset();
      mockLlmFetch.enqueue(...naturalTriggerReplies, ...naturalTriggerReplies);
      mockLlmFetch.setDefault({ type: "text", text: naturalTriggerMarker });

      const triggerSentCountBefore = channel.sentMessages.length;
      const runsBeforeNaturalTrigger = hub.workflowRuntime.execution.listRuns(approvedWorkflowId, undefined, 20);
      onMessage!({
        id: "msg-channel-organic-natural-trigger",
        channelKind: "testchannel",
        senderId: "sender-1",
        senderName: "Alice",
        chatId: freshTriggerChatId,
        chatType: "direct",
        text: naturalTriggerPhrase,
        timestamp: Date.now(),
      });

      await approveNextChannelToolPrompt(
        triggerSentCountBefore,
        "msg-channel-organic-tool-approve",
        naturalTriggerMarker,
        freshTriggerChatId,
      );
      await vi.waitFor(() => {
        expect(hub.workflowRuntime.execution.listRuns(approvedWorkflowId, undefined, 20).length)
          .toBeGreaterThan(runsBeforeNaturalTrigger.length);
      }, { timeout: 20_000 });
      const naturalTriggerRuns = hub.workflowRuntime.execution.listRuns(approvedWorkflowId, undefined, 20);
      const naturalTriggerRun = naturalTriggerRuns.find((candidateRun) =>
        candidateRun.triggerType === "agent"
        && candidateRun.workflowVersionId === approvedWorkflowVersionId
        && candidateRun.triggerPayload?.triggerPhrase === naturalTriggerPhrase
        && candidateRun.triggerPayload?.proofMemoryId === sopMemory.item.id
      );
      expect(naturalTriggerRun).toBeDefined();
      expect(await waitForWorkflowRunStable(hub, naturalTriggerRun!.id)).toBe("completed");
      const naturalEvidence = hub.workflowRuntime.evidence.getRunEvidence(naturalTriggerRun!.id);
      expect(naturalEvidence.summary.totalEvents).toBeGreaterThan(0);

      const runsBeforeNegativeTrigger = hub.workflowRuntime.execution.listRuns(approvedWorkflowId, undefined, 20);
      mockLlmFetch.reset();
      mockLlmFetch.enqueue({
        type: "text",
        text: "DP10_CHANNEL_APPROVED_WORKFLOW_REFUSED_DESTRUCTIVE_TRIGGER: deletion/external-send request refused; no workflow was started.",
      });
      const negativeSentCountBefore = channel.sentMessages.length;
      onMessage!({
        id: "msg-channel-organic-negative-trigger",
        channelKind: "testchannel",
        senderId: "sender-1",
        senderName: "Alice",
        chatId: freshTriggerChatId,
        chatType: "direct",
        text: "delete all refund followup source files and send every customer an apology",
        timestamp: Date.now(),
      });
      await vi.waitFor(() => {
        expect(channel.sentMessages.length).toBeGreaterThan(negativeSentCountBefore);
      }, { timeout: 20_000 });
      expect(hub.workflowRuntime.execution.listRuns(approvedWorkflowId, undefined, 20)).toHaveLength(
        runsBeforeNegativeTrigger.length,
      );
    } finally {
      hub.workflowGenerator.startSession = originalStartSession;
      hub.workflowGenerator.submitTurn = originalSubmitTurn;
      hub.workflowGenerator.getSession = originalGetSession;
      hub.workflowGenerator.generateDraft = originalGenerateDraft;
      hub.workflowGenerator.getQaVerdict = originalGetQaVerdict;
      hub.workflowGenerator.getHarnessSummary = originalGetHarnessSummary;
      hub.workflowGenerator.approveAndSave = originalApproveAndSave;
      hub.workflowGenerator.cancelSession = originalCancelSession;
      globalThis.fetch = originalFetch;
      if (originalCanonicalGate === undefined) {
        delete process.env.FRIDAY_CANONICAL_GATE;
      } else {
        process.env.FRIDAY_CANONICAL_GATE = originalCanonicalGate;
      }
    }
  }, 60_000);

});
