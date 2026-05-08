import { describe, it, expect, vi } from "vitest";
import { createFridayAgentToolRegistry, partitionFridayAgentTools } from "#agent";
import type { FridayAgentToolDefinition } from "#agent";
import type { FridaySkillRegistry } from "#skills";
import type { FridaySessionService } from "../../../../src/sessions/services/friday-session-service.types.js";
import type { FridayAgentRuntime } from "#agent";
import type { FridayJobSchedulerRepository } from "../../../../src/jobs/scheduler/friday-job-scheduler-repository.js";
import type { FridayJobSchedulerService } from "../../../../src/jobs/scheduler/friday-job-scheduler.types.js";
import type { FridayChannelRegistry } from "../../../../src/channels/friday-channel-registry.js";
import type { FridayMcpAdapter } from "../../../../src/agent/mcp/friday-mcp-adapter.types.js";
import type { FridayProviderService } from "../../../../src/providers/services/friday-provider-service.types.js";
import type { FridayGuideLensService } from "../../../../src/guide-lens/model/friday-guide-lens.types.js";
import { makeManifest } from "../../skills/_helpers/make-manifest.helper.js";

function stubSessionService(): FridaySessionService {
  return {
    createSession: vi.fn(),
    listSessions: vi.fn(),
    getSession: vi.fn(),
    getOrCreateSession: vi.fn(),
    addMessage: vi.fn(),
    getMessages: vi.fn(),
    archiveSession: vi.fn(),
    pruneOldSessions: vi.fn(),
    sweepLifecycle: vi.fn(),
    getSessionMemoryNamespace: vi.fn(),
    forkSession: vi.fn(),
    listForks: vi.fn(),
    mergeForkSummary: vi.fn(),
    resetSession: vi.fn(),
    setSendPolicy: vi.fn(),
    evaluateSendPolicy: vi.fn(),
  } as unknown as FridaySessionService;
}

function stubRuntime(): FridayAgentRuntime {
  return { executeRun: vi.fn() } as unknown as FridayAgentRuntime;
}

function stubMcpAdapter(): FridayMcpAdapter {
  return {
    listServers: vi.fn().mockReturnValue([{ id: "filesystem", command: "npx" }]),
    listServerStates: vi.fn().mockReturnValue([{ serverId: "filesystem", transport: "stdio", state: "loaded", lazyDiscovery: true }]),
    listTools: vi.fn(),
    searchTools: vi.fn(),
    callTool: vi.fn(),
    listResources: vi.fn(),
    readResource: vi.fn(),
    listPrompts: vi.fn(),
    getPrompt: vi.fn(),
  };
}

function stubSkillRegistry(): FridaySkillRegistry {
  return {
    list: vi.fn().mockReturnValue([]),
    get: vi.fn(),
    resolveByIntent: vi.fn(),
    validateAll: vi.fn().mockReturnValue([]),
    reload: vi.fn(),
    refresh: vi.fn(),
    isCompatible: vi.fn().mockReturnValue({ compatible: true, reasons: [] }),
    startWatching: vi.fn(),
    stopWatching: vi.fn(),
    close: vi.fn(),
  } as unknown as FridaySkillRegistry;
}

function stubMcpRequiredSkillRegistry(): FridaySkillRegistry {
  const manifest = makeManifest({
    id: "mcp-skill",
    requirements: {
      bins: [],
      env: [],
      config: [],
      os: ["darwin", "linux", "win32"],
      mcpServers: [{ name: "filesystem", auth: "connected" }],
    },
  });
  const skill = {
    manifest,
    skillDir: "/tmp/mcp-skill",
    source: "bundled",
    origin: "bundled",
    status: "installed",
    loaded: {
      skillDir: "/tmp/mcp-skill",
      manifest,
      loadMode: "manifest-v2",
      declaredFiles: [],
    },
    validation: { ok: true, issues: [] },
    trust: {
      trustTier: "bundled",
      executionMode: "trusted",
      sandboxPolicy: {
        trustTier: "bundled",
        defaultExecutionMode: "trusted",
        allowedExecutionModes: ["trusted", "restricted"],
      },
    },
  };
  return {
    ...stubSkillRegistry(),
    list: vi.fn().mockReturnValue([skill]),
    get: vi.fn((skillId: string) => (skillId === "mcp-skill" ? skill : null)),
  } as unknown as FridaySkillRegistry;
}

function stubProviderService(): FridayProviderService {
  return {
    listProviders: vi.fn(),
    getProvider: vi.fn(),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    initOAuth: vi.fn(),
    completeOAuth: vi.fn(),
    setDefaultRoute: vi.fn(),
    validateProvider: vi.fn(),
    getRoutingConfig: vi.fn(),
    resolveRoute: vi.fn(),
    runWithFallback: vi.fn(),
    recordUsage: vi.fn(),
  } as unknown as FridayProviderService;
}

function stubGuideLensService(): FridayGuideLensService {
  return {
    getState: vi.fn(),
    updatePreferences: vi.fn(),
    updateAvatar: vi.fn(),
    captureSnapshot: vi.fn(),
    resolveTarget: vi.fn(),
    showOverlay: vi.fn(),
    clearOverlay: vi.fn(),
    analyzeScreenshot: vi.fn(),
    verify: vi.fn(),
    assertReadOnlyAction: vi.fn(),
  } as unknown as FridayGuideLensService;
}

describe("createFridayAgentToolRegistry", () => {
  // ─── Issue 1 & 2: Sessions tool with lazy runtime getter ───

  it("includes sessions tool when sessionService + agentRuntimeGetter provided", () => {
    const tools = createFridayAgentToolRegistry({
      sessionService: stubSessionService(),
      agentRuntimeGetter: () => stubRuntime(),
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("sessions");
  });

  it("includes sessions tool when sessionService + agentRuntime provided", () => {
    const tools = createFridayAgentToolRegistry({
      sessionService: stubSessionService(),
      agentRuntime: stubRuntime(),
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("sessions");
  });

  it("excludes sessions tool when sessionService missing", () => {
    const tools = createFridayAgentToolRegistry({
      agentRuntimeGetter: () => stubRuntime(),
    });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("sessions");
  });

  it("excludes sessions tool when both agentRuntime and agentRuntimeGetter missing", () => {
    const tools = createFridayAgentToolRegistry({
      sessionService: stubSessionService(),
    });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("sessions");
  });

  // ─── Cron + message tools require their deps ───

  it("includes cron tool when schedulerRepository + schedulerService provided", () => {
    const tools = createFridayAgentToolRegistry({
      schedulerRepository: {} as FridayJobSchedulerRepository,
      schedulerService: {
        start: vi.fn(),
        stop: vi.fn(),
        wakeNow: vi.fn(),
        status: vi.fn(),
        registerDynamicJob: vi.fn(),
        updateJobSchedule: vi.fn(),
      } as unknown as FridayJobSchedulerService,
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("cron");
  });

  it("includes message tool when channelRegistry provided", () => {
    const tools = createFridayAgentToolRegistry({
      channelRegistry: {
        list: vi.fn().mockReturnValue([]),
        register: vi.fn(),
        send: vi.fn(),
        startAll: vi.fn(),
        stopAll: vi.fn(),
      } as unknown as FridayChannelRegistry,
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("message");
  });

  it("excludes mcp tool when lifecycle availability resolver is missing", () => {
    const tools = createFridayAgentToolRegistry({
      mcpAdapter: stubMcpAdapter(),
    });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("mcp");
  });

  it("includes mcp tool when mcpAdapter has promoted servers", () => {
    const tools = createFridayAgentToolRegistry({
      mcpAdapter: stubMcpAdapter(),
      getMcpServerAvailability: () => ({ available: true, promotionChannel: "active" }),
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("mcp");
  });

  it("blocks MCP-backed skills when the configured server is not lifecycle-promoted", async () => {
    const execute = vi.fn().mockReturnValue({
      runId: "run-1",
      result: Promise.resolve({
        runId: "run-1",
        status: "completed",
        output: {},
        stdout: "",
        stderr: "",
        durationMs: 1,
      }),
    });
    const tools = createFridayAgentToolRegistry({
      skillExecutor: {
        execute,
        cancel: vi.fn(),
      } as never,
      skillRegistry: stubMcpRequiredSkillRegistry(),
      mcpAdapter: stubMcpAdapter(),
      getMcpServerAvailability: () => ({ available: false, promotionChannel: "shadow" }),
    });

    const skillRun = tools.find((tool) => tool.name === "skill_run")!;
    const runResult = await skillRun.execute({ skillId: "mcp-skill", input: {} }, new AbortController().signal);
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.parse(runResult.content)).toMatchObject({
      status: "blocked",
      ready: false,
      blockers: ['Required MCP server "filesystem" is not configured for this deployment.'],
    });

    const skillsList = tools.find((tool) => tool.name === "skills_list")!;
    const listResult = await skillsList.execute({}, new AbortController().signal);
    const parsed = JSON.parse(listResult.content) as { skills: Array<{ ready: boolean; blockers: string[] }> };
    expect(parsed.skills[0]?.ready).toBe(false);
    expect(parsed.skills[0]?.blockers).toContain('Required MCP server "filesystem" is not configured for this deployment.');
  });

  it("always includes exec, file, web_fetch tools", () => {
    const tools = createFridayAgentToolRegistry({});
    const names = tools.map((t) => t.name);
    expect(names).toContain("exec");
    expect(names).toContain("read");
    expect(names).toContain("web_fetch");
  });

  it("includes skills_list when skill executor and registry are provided", () => {
    const tools = createFridayAgentToolRegistry({
      skillExecutor: {
        execute: vi.fn(),
        cancel: vi.fn(),
      } as never,
      skillRegistry: stubSkillRegistry(),
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("skills_list");
    expect(names).toContain("skill_run");
  });

  it("includes provider tool when providerService is provided", () => {
    const tools = createFridayAgentToolRegistry({
      providerService: stubProviderService(),
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("provider");
  });

  it("includes guide_lens tool when guideLensService is provided", () => {
    const tools = createFridayAgentToolRegistry({
      guideLensService: stubGuideLensService(),
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("guide_lens");
  });

  it("includes capabilities tool when capabilitySnapshotGetter is provided", () => {
    const tools = createFridayAgentToolRegistry({
      capabilitySnapshotGetter: () => ({
        readOnly: false,
        messaging: { enabled: true, kinds: ["discord"] },
        mcp: { enabled: false, serverCount: 0, servers: [] },
        provider: { available: true, configuredCount: 1, mutationBlockedByReadOnly: false },
        browser: { activeMode: "host_chrome_visible", targetBrowser: "Google Chrome" },
        system: { enabled: true },
        desktop: { connected: false },
        companion: { connected: false },
      }),
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("capabilities");
  });

  it("includes task_status tool when taskStatusSnapshotGetter is provided", () => {
    const tools = createFridayAgentToolRegistry({
      taskStatusSnapshotGetter: () => ({
        readOnly: false,
        trackedRunId: "run-1",
        activeSubagents: [],
        blockers: [],
      }),
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("task_status");
  });

  // ─── operationalMode filtering ───

  it("filters to read-only tools in plan mode", () => {
    const tools = createFridayAgentToolRegistry({ operationalMode: "plan" });
    const names = tools.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("web_fetch");
    expect(names).not.toContain("exec");
    expect(names).not.toContain("write");
  });

  it("returns all core tools in execute mode", () => {
    const tools = createFridayAgentToolRegistry({ operationalMode: "execute" });
    const names = tools.map((t) => t.name);
    expect(names).toContain("exec");
    expect(names).toContain("read");
    expect(names).toContain("web_fetch");
  });

  it("returns full set when no mode specified", () => {
    const tools = createFridayAgentToolRegistry({});
    const names = tools.map((t) => t.name);
    expect(names).toContain("exec");
    expect(names).toContain("read");
  });
});

describe("partitionFridayAgentTools", () => {
  function mockTool(name: string): FridayAgentToolDefinition {
    return {
      name,
      description: `Mock ${name}`,
      parameters: {},
      execute: async () => ({ content: "" }),
    };
  }

  it("places core tools in alwaysLoad", () => {
    const tools = [
      mockTool("exec"),
      mockTool("read"),
      mockTool("write"),
      mockTool("web_fetch"),
      mockTool("autonomous"),
      mockTool("skill_generate"),
      mockTool("workflow_generate"),
    ];
    const result = partitionFridayAgentTools(tools);
    const names = result.alwaysLoad.map((t) => t.name);
    expect(names).toContain("exec");
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).toContain("web_fetch");
    expect(names).toContain("autonomous");
    expect(names).toContain("skill_generate");
    expect(names).toContain("workflow_generate");
    expect(result.deferred).toHaveLength(0);
  });

  it("places non-core tools in deferred", () => {
    const tools = [mockTool("desktop"), mockTool("browser"), mockTool("canvas"), mockTool("tts")];
    const result = partitionFridayAgentTools(tools);
    expect(result.alwaysLoad).toHaveLength(0);
    const names = result.deferred.map((t) => t.name);
    expect(names).toContain("desktop");
    expect(names).toContain("browser");
    expect(names).toContain("canvas");
    expect(names).toContain("tts");
  });

  it("returns empty arrays for empty input", () => {
    const result = partitionFridayAgentTools([]);
    expect(result.alwaysLoad).toEqual([]);
    expect(result.deferred).toEqual([]);
  });

  it("skill_run and skills_list are always-load", () => {
    const tools = [
      mockTool("skill_run"),
      mockTool("skills_list"),
      mockTool("skill_generate"),
      mockTool("workflow_generate"),
    ];
    const result = partitionFridayAgentTools(tools);
    const names = result.alwaysLoad.map((t) => t.name);
    expect(names).toContain("skill_run");
    expect(names).toContain("skills_list");
    expect(names).toContain("skill_generate");
    expect(names).toContain("workflow_generate");
    expect(result.deferred).toHaveLength(0);
  });

  it("partitions mixed tools correctly", () => {
    const tools = [
      mockTool("exec"), mockTool("read"), mockTool("autonomous"), mockTool("desktop"),
      mockTool("web_fetch"), mockTool("canvas"), mockTool("cron"),
    ];
    const result = partitionFridayAgentTools(tools);
    expect(result.alwaysLoad.map((t) => t.name)).toEqual(["exec", "read", "autonomous", "web_fetch"]);
    expect(result.deferred.map((t) => t.name)).toEqual(["desktop", "canvas", "cron"]);
  });
});
