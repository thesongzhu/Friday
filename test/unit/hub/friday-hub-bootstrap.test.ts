import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { beforeEach, describe, it, expect, afterEach, vi } from "vitest";
import type { FridayChannelMessage, FridayChannelPlugin } from "#channels";
import {
  createFridayHub,
  shouldFailClosedForFridayWorkspaceContext,
} from "#hub";
import type { FridayHub } from "#hub";
import { resolveStateDir } from "#state";
import {
  clearAutoDetectProviderEnv,
  restoreAutoDetectProviderEnv,
  type FridayAutoDetectProviderEnvSnapshot,
} from "../../_helpers/auto-detect-provider-env.js";
import * as hubAuditWriterModule from "../../../src/hub/services/friday-hub-audit-log-writer.js";

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

describe("createFridayHub", () => {
  let hub: FridayHub | null = null;
  let stateDir: string | null = null;
  let homeDir: string | null = null;
  let bundledSkillsDir: string | null = null;
  let managedSkillsDir: string | null = null;
  let autoDetectEnvSnapshot: FridayAutoDetectProviderEnvSnapshot | null = null;
  const originalSuppression = process.env.FRIDAY_SUPPRESS_TEST_ENV_SECURITY_WARNINGS;

  async function createIsolatedHub(): Promise<FridayHub> {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-hub-bootstrap-"));
    bundledSkillsDir = path.join(stateDir, "skills-empty");
    managedSkillsDir = path.join(stateDir, "managed-skills-empty");
    await fs.mkdir(bundledSkillsDir, { recursive: true });
    await fs.mkdir(managedSkillsDir, { recursive: true });
    hub = await createFridayHub({
      skillDirs: [bundledSkillsDir, managedSkillsDir],
      stateDir,
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

});
