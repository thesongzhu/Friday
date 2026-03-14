import { describe, it, expect, vi } from "vitest";
import { createFridayAgentToolRegistry } from "#agent";
import type { FridaySkillRegistry } from "#skills";
import type { FridaySessionService } from "../../../../src/sessions/services/friday-session-service.types.js";
import type { FridayAgentRuntime } from "#agent";
import type { FridayJobSchedulerRepository } from "../../../../src/jobs/scheduler/friday-job-scheduler-repository.js";
import type { FridayJobSchedulerService } from "../../../../src/jobs/scheduler/friday-job-scheduler.types.js";
import type { FridayChannelRegistry } from "../../../../src/channels/friday-channel-registry.js";
import type { FridayMcpAdapter } from "../../../../src/agent/mcp/friday-mcp-adapter.types.js";
import type { FridayProviderService } from "../../../../src/providers/services/friday-provider-service.types.js";

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
    listTools: vi.fn(),
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

  it("includes mcp tool when mcpAdapter has configured servers", () => {
    const tools = createFridayAgentToolRegistry({
      mcpAdapter: stubMcpAdapter(),
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("mcp");
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
});
