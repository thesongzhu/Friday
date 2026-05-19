import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import {
  createFridayAgentRuntime,
  createFridayAgentEventEmitter,
  createFridayAgentFileTools,
  createFridayAgentSystemTool,
  createFridayAgentRunRepository,
  createFridayAgentReviewGate,
  createFridayAgentRunEventRepository,
  createFridayAgentSelfFixService,
} from "#agent";
import { createFridaySystemService } from "../../../../src/system/engine/friday-system-service.js";
import type { FridaySystemCompanionBridge } from "../../../../src/system/companion/friday-system-companion.types.js";
import type {
  FridayAgentLlmClient,
  FridayAgentMessage,
  FridayAgentLlmStreamEvent,
  FridayAgentSystemPromptContext,
  FridayAgentToolDefinition,
} from "#agent";
import type { FridayEvaluationContext, FridayEvaluationResult } from "#rules";

describe("FridayAgentRuntime", () => {
  let db: FridaySqliteLayer;
  let idGenerator: () => string;
  const NOW = "2026-02-19T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGenerator = createTestIdGenerator();
  });

  afterEach(() => {
    db.close();
  });

  function createMockLlmClient(
    events: FridayAgentLlmStreamEvent[][],
  ): FridayAgentLlmClient {
    let callIndex = 0;
    return {
      async *stream() {
        const batch = events[callIndex] ?? [];
        callIndex++;
        for (const event of batch) {
          yield event;
        }
      },
    };
  }

  async function flushAsyncEvents(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  function createEchoTool(): FridayAgentToolDefinition {
    return {
      name: "echo",
      description: "Echoes input back",
      parameters: {
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
      async execute(args) {
        const msg = typeof args.message === "string" ? args.message : "no message";
        return { content: `Echo: ${msg}` };
      },
    };
  }

  function createNamedTool(name: string, description = `${name} test tool`): FridayAgentToolDefinition {
    return {
      name,
      description,
      parameters: {
        type: "object",
        properties: {
          value: { type: "string" },
        },
      },
      async execute() {
        return { content: `${name} executed` };
      },
    };
  }

  function createFailingEchoTool(): FridayAgentToolDefinition {
    return {
      name: "echo",
      description: "Always fails",
      parameters: {
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
      async execute() {
        return { content: "echo failed", isError: true };
      },
    };
  }

  function createWorkflowGeneratorClarificationTool(): FridayAgentToolDefinition {
    return {
      name: "workflow_generate",
      description: "Mock workflow generator that asks for clarification",
      parameters: {
        properties: {
          action: { type: "string" },
          goal: { type: "string" },
        },
        required: ["action"],
      },
      async execute() {
        return {
          content: JSON.stringify({
            sessionId: "wf-session-1",
            status: "needs_clarification",
            mode: "clarification_required",
            questions: [
              "Which timezone should this workflow run in?",
              "Which Slack destination should receive the summary?",
            ],
          }),
        };
      },
    };
  }

  function createExecTool(spy?: ReturnType<typeof vi.fn>): FridayAgentToolDefinition {
    return {
      name: "exec",
      description: "Mock exec tool",
      parameters: {
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
      },
      async execute(args) {
        spy?.(args);
        return { content: "mock exec output" };
      },
    };
  }

  function createMemorySearchTool(spy?: ReturnType<typeof vi.fn>): FridayAgentToolDefinition {
    return {
      name: "memory_search",
      description: "Mock memory search tool",
      parameters: {
        properties: {
          query: { type: "string" },
          namespace: { type: "string" },
          limit: { type: "number" },
        },
        required: ["query"],
      },
      async execute(args) {
        spy?.(args);
        return {
          content: JSON.stringify([
            {
              content: "Captain Friday",
              score: 0.98,
              metadata: {
                id: "learned-fact:pref:user_name",
                namespace: "preference",
                source: "learned_fact",
              },
            },
          ]),
        };
      },
    };
  }

  function createFailingWebFetchTool(
    spy?: ReturnType<typeof vi.fn>,
    errorMessage = "Fetch error: SSRF guard: DNS resolution failed for www.youtube.com",
  ): FridayAgentToolDefinition {
    return {
      name: "web_fetch",
      description: "Always fails web fetch",
      parameters: {
        properties: {
          url: { type: "string" },
        },
        required: ["url"],
      },
      async execute(args) {
        spy?.(args);
        return {
          content: errorMessage,
          isError: true,
        };
      },
    };
  }

  function createSuccessfulWebFetchTool(spy?: ReturnType<typeof vi.fn>): FridayAgentToolDefinition {
    return {
      name: "web_fetch",
      description: "Successful web fetch tool",
      parameters: {
        properties: {
          url: { type: "string" },
        },
        required: ["url"],
      },
      async execute(args) {
        spy?.(args);
        return {
          content: JSON.stringify({
            url: typeof args.url === "string" ? args.url : "https://example.com",
            title: "Example Domain",
            text: "Example page body",
          }),
        };
      },
    };
  }

  function createSuccessfulWebSearchTool(options?: {
    metadata?: Record<string, unknown>;
    content?: string;
  }): FridayAgentToolDefinition {
    return {
      name: "web_search",
      description: "Successful web search tool",
      parameters: {
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      async execute() {
        return {
          content:
            options?.content
            ?? "1. Headline\n   URL: https://example.com/1\n   Date: 2026-02-19\n   Summary",
          metadata: options?.metadata,
        };
      },
    };
  }

  function createDesktopRecoveryTool(
    spy?: ReturnType<typeof vi.fn>,
    options: {
      inspectElementErrorMessage?: string;
      executeErrorMessage?: string;
    } = {},
  ): FridayAgentToolDefinition {
    return {
      name: "desktop",
      description: "Mock desktop tool with selector input errors",
      parameters: {
        properties: {
          action: { type: "string" },
          actionType: { type: "string" },
          strategy: { type: "string" },
          selectorValue: { type: "string" },
        },
        required: ["action"],
      },
      async execute(args) {
        spy?.(args);
        const action = typeof args.action === "string" ? args.action : "";
        const actionType = typeof args.actionType === "string" ? args.actionType : "";
        if (action === "inspect_element") {
          return { content: options.inspectElementErrorMessage ?? "strategy is required", isError: true };
        }
        if (action === "execute" && actionType === "click") {
          return {
            content: options.executeErrorMessage ?? "Either coordinates or selector strategy is required",
            isError: true,
          };
        }
        if (action === "screenshot") {
          return {
            content: JSON.stringify({
              actionId: "desktop-shot-1",
              status: "completed",
              screenshotBase64: "ZmFrZS1zY3JlZW5zaG90",
            }),
          };
        }
        return { content: `unsupported action: ${action}`, isError: true };
      },
    };
  }

  function createSystemTool(spy?: ReturnType<typeof vi.fn>): FridayAgentToolDefinition {
    return {
      name: "system",
      description: "Mock system tool",
      parameters: {
        properties: {
          action: { type: "string" },
          appIdentifier: { type: "string" },
        },
        required: ["action"],
      },
      async execute(args) {
        spy?.(args);
        const action = typeof args.action === "string" ? args.action : "";
        if (action === "snapshot") {
          return {
            content: JSON.stringify({
              id: "system-snapshot-1",
              action: "snapshot",
              status: "completed",
              message: "System snapshot captured",
              payload: {
                snapshot: {
                  health: {
                    status: "safe_mode",
                    desktopConnected: false,
                    companionConnected: false,
                    reasons: ["desktop_session_unavailable"],
                  },
                  notifications: [],
                },
              },
            }),
          };
        }
        if (action === "open") {
          return {
            content: JSON.stringify({
              id: "system-open-1",
              action: "launch_app",
              status: "completed",
              message: `Launched ${String(args.appIdentifier ?? "app")}`,
            }),
          };
        }
        return {
          content: JSON.stringify({
            id: `system-${action || "unknown"}`,
            action,
            status: "completed",
            message: `Ran ${action || "unknown"}`,
          }),
        };
      },
    };
  }

  function createConnectedSystemCompanionBridge(
    launchApp: ReturnType<typeof vi.fn>,
  ): FridaySystemCompanionBridge {
    const now = NOW;
    const status = {
      id: "companion-test",
      platform: "darwin" as const,
      runtimeKind: "embedded" as const,
      connected: true,
      transport: { mode: "in_process" as const, protocol: "jsonrpc-2.0" as const, authenticated: true },
      launchAtLoginEnabled: false,
      panicHotkey: "Control+Option+Command+F",
      safeMode: false,
      overlayVisible: false,
      lastHeartbeatAt: now,
      capabilities: {
        surfaces: {
          launchAtLogin: true,
          menuBar: true,
          overlay: true,
          globalHotkey: true,
          windowInventory: true,
          notificationIntake: true,
          screenCapture: true,
        },
        actions: {
          snapshot: "supported" as const,
          launch_app: "supported" as const,
          focus: "supported" as const,
          open_url: "supported" as const,
          open_project: "supported" as const,
          handoff_to_browser: "supported" as const,
          handoff_to_terminal: "supported" as const,
          arrange_windows: "supported" as const,
          notification_list: "supported" as const,
          read_notification: "supported" as const,
          notification_act: "supported" as const,
          recover_ui: "supported" as const,
        },
      },
      permissions: [],
    };

    return {
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      isConnected: vi.fn(() => true),
      ping: vi.fn(async () => ({ ok: true, serverTime: now })),
      getStatus: vi.fn(async () => status),
      captureSnapshot: vi.fn(async () => ({
        apps: [],
        windows: [],
        notifications: [],
      })),
      arrangeWindows: vi.fn(async (layout = "single_focus") => ({
        arrangedWindowIds: [],
        layout,
        arrangedAt: now,
      })),
      launchApp,
      focusTarget: vi.fn(async (input) => ({
        ...input,
        focused: true,
        focusedAt: now,
      })),
      openUrl: vi.fn(async (url) => ({ url, openedAt: now })),
      openProject: vi.fn(async (projectPath) => ({ projectPath, openedAt: now })),
      listNotifications: vi.fn(async () => []),
      actOnNotification: vi.fn(async () => null),
      setOverlayVisible: vi.fn(async (visible) => ({ visible, changedAt: now })),
      showGuideOverlay: vi.fn(async (command) => ({ visible: true, changedAt: now, guideOverlay: command })),
      clearGuideOverlay: vi.fn(async () => ({ visible: false, changedAt: now })),
    };
  }

  function createFailingDesktopTool(
    errorMessage = "Desktop session is not connected.",
    spy?: ReturnType<typeof vi.fn>,
  ): FridayAgentToolDefinition {
    return {
      name: "desktop",
      description: "Mock desktop tool that always fails",
      parameters: {
        properties: {
          action: { type: "string" },
        },
        required: ["action"],
      },
      async execute(args) {
        spy?.(args);
        return { content: errorMessage, isError: true };
      },
    };
  }

  function createBrowserRecoveryTool(spy?: ReturnType<typeof vi.fn>): FridayAgentToolDefinition {
    return {
      name: "browser",
      description: "Mock browser tool with act selector input errors",
      parameters: {
        properties: {
          action: { type: "string" },
          act: { type: "string" },
          sessionId: { type: "string" },
          tabId: { type: "string" },
          selector: { type: "string" },
          elementId: { type: "string" },
        },
        required: ["action"],
      },
      async execute(args) {
        spy?.(args);
        const action = typeof args.action === "string" ? args.action : "";
        if (action === "act") {
          return { content: "Either selector or elementId is required for act.", isError: true };
        }
        if (action === "snapshot") {
          return {
            content: JSON.stringify({
              sessionId: typeof args.sessionId === "string" ? args.sessionId : "default",
              tabId: typeof args.tabId === "string" ? args.tabId : "tab-1",
              axText: "Recovered browser snapshot",
            }),
          };
        }
        return { content: `unsupported action: ${action}`, isError: true };
      },
    };
  }

  function createMcpRecoveryTool(spy?: ReturnType<typeof vi.fn>): FridayAgentToolDefinition {
    return {
      name: "mcp",
      description: "Mock mcp tool with required-action input errors",
      parameters: {
        properties: {
          action: { type: "string" },
          serverId: { type: "string" },
        },
      },
      async execute(args) {
        spy?.(args);
        const action = typeof args.action === "string" ? args.action : "";
        if (!action) {
          return { content: "MCP error: action is required", isError: true };
        }
        if (action === "list_servers") {
          return {
            content: JSON.stringify({
              count: 1,
              items: [{ id: "local-mcp", command: "echo" }],
            }),
          };
        }
        return { content: `unsupported action: ${action}`, isError: true };
      },
    };
  }

  function createBrowserTool(
    opts?: {
      onOpen?: ReturnType<typeof vi.fn>;
      onSnapshot?: ReturnType<typeof vi.fn>;
    },
  ): FridayAgentToolDefinition {
    return {
      name: "browser",
      description: "Mock browser tool",
      parameters: {
        properties: {
          action: { type: "string" },
        },
        required: ["action"],
      },
      async execute(args) {
        const action = typeof args.action === "string" ? args.action : "";
        if (action === "open") {
          opts?.onOpen?.(args);
          return {
            content: JSON.stringify({
              sessionId: "fallback-session",
              tabId: "tab-1",
              url: typeof args.url === "string" ? args.url : "about:blank",
              title: "YouTube",
            }),
          };
        }
        if (action === "snapshot") {
          opts?.onSnapshot?.(args);
          return {
            content: JSON.stringify({
              sessionId: "fallback-session",
              tabId: "tab-1",
              axText: "Video title: test",
            }),
          };
        }
        return { content: "unsupported browser action", isError: true };
      },
    };
  }

  function createFeedbackTool(spy?: ReturnType<typeof vi.fn>): FridayAgentToolDefinition {
    return {
      name: "feedback",
      description: "Mock feedback tool",
      parameters: {
        properties: {
          kind: { type: "string" },
          field: { type: "string" },
          value: { type: "string" },
        },
        required: ["kind", "field", "value"],
      },
      async execute(args) {
        spy?.(args);
        return { content: "Feedback recorded: ok." };
      },
    };
  }

  function allowPolicyResult(
    overrides?: Partial<FridayEvaluationResult>,
  ): FridayEvaluationResult {
    return {
      evaluationId: "eval-allow",
      decision: "allow",
      matchedRules: [],
      durationMs: 0.1,
      allowed: true,
      evaluatedAt: NOW,
      ...overrides,
    };
  }

  function denyPolicyResult(
    message: string,
    overrides?: Partial<FridayEvaluationResult>,
  ): FridayEvaluationResult {
    return {
      evaluationId: "eval-deny",
      decision: "deny",
      matchedRules: [],
      message,
      durationMs: 0.1,
      allowed: false,
      evaluatedAt: NOW,
      ...overrides,
    };
  }

  // ─── Basic run with text-only response ───

  it("completes a run with text-only response", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "Hello, " },
        { type: "text_delta", text: "world!" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 10, outputTokens: 5 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "Say hello" });

    expect(result.status).toBe("completed");
    expect(result.response).toBe("Hello, world!");
    expect(result.toolCallCount).toBe(0);
    expect(result.usageInput).toBe(10);
    expect(result.usageOutput).toBe(5);
  });

  it("does not forward the internal default route sentinel as a pinned provider", async () => {
    const streamSpy = vi.fn(async function* (params: {
      providerId?: string;
      model?: string;
    }) {
      yield { type: "text_delta" as const, text: "ok" };
      yield { type: "message_end" as const, stopReason: "end_turn", inputTokens: 1, outputTokens: 1 };
    });
    const llmClient: FridayAgentLlmClient = { stream: streamSpy };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "default",
      providerId: "default",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "Say hello" });

    expect(result.status).toBe("completed");
    expect(streamSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: undefined,
        model: "default",
      }),
    );
  });

  it.each([
    {
      label: "default routing",
      providerId: undefined,
      model: "route-default-model",
    },
    {
      label: "an explicit Anthropic pin",
      providerId: "anthropic",
      model: "claude-sonnet-4-20250514",
    },
  ])("answers trivial fact prompts in English without tools under $label", async ({ providerId, model }) => {
    const streamSpy = vi.fn(async function* (params: {
      providerId?: string;
      model?: string;
    }) {
      yield { type: "text_delta" as const, text: "Paris is the capital of France." };
      yield { type: "message_end" as const, stopReason: "end_turn", inputTokens: 6, outputTokens: 6 };
    });
    const llmClient: FridayAgentLlmClient = { stream: streamSpy };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "route-default-model",
      providerId: "default",
      systemPrompt: "You are a test agent.",
      tools: [createSuccessfulWebSearchTool(), createMemorySearchTool()],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "What is the capital of France? Answer in English.",
      taskPrompt: "This is a new question. Ignore the previous sourdough topic.\nCurrent question: What is the capital of France? Answer in English.",
      historyMessages: [
        { role: "user", content: "How do I bake sourdough bread?" },
        { role: "assistant", content: "Use a sourdough starter and let the dough ferment overnight." },
      ],
      conversationContext: {
        turnKind: "new_topic",
        previousTopicSummary: "How do I bake sourdough bread?",
        currentTopicSummary: "What is the capital of France?",
      },
      providerId,
      model,
    });

    expect(result.status).toBe("completed");
    expect(result.response).toBe("Paris is the capital of France.");
    expect(result.toolCallCount).toBe(0);
    expect(streamSpy).toHaveBeenCalledWith(expect.objectContaining({
      providerId,
      model,
    }));
  });

  it("routes trivial simple chat through minimal prompt with zero tools and skipped workspace context", async () => {
    let capturedTools: FridayAgentToolDefinition[] | undefined;
    let capturedSystemPrompt = "";
    let capturedPromptContext: FridayAgentSystemPromptContext | undefined;
    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        capturedTools = params.tools;
        capturedSystemPrompt = params.systemPrompt;
        yield { type: "text_delta", text: "4" };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 120, outputTokens: 1 };
      },
    };
    const systemPromptBuilder = vi.fn((context: FridayAgentSystemPromptContext) => {
      capturedPromptContext = context;
      return context.promptProfile === "minimal"
        ? "MINIMAL_PROMPT"
        : "STANDARD_PROMPT";
    });

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPromptBuilder,
      tools: [createSuccessfulWebSearchTool(), createMemorySearchTool(), createNamedTool("browser")],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      contextEngine: {
        assemble: vi.fn().mockReturnValue({
          promptFragment: "SHOULD_NOT_BE_LOADED",
        }),
      },
    });

    const result = await runtime.executeRun({ task: "What is 2+2?" });

    expect(result.status).toBe("completed");
    expect(capturedSystemPrompt).toBe("MINIMAL_PROMPT");
    expect(capturedTools).toEqual([]);
    expect(capturedPromptContext).toEqual(expect.objectContaining({
      promptProfile: "minimal",
      toolNames: [],
      contextPolicy: { workspaceContext: "skip" },
    }));
    expect(capturedPromptContext?.toolRouting?.profile).toBe("trivial");
  });

  it("injects active memory context by default only for private channel chats", async () => {
    const capturedSystemPrompts: string[] = [];
    const compactionContextBuilder = vi.fn(() => "ACTIVE MEMORY CONTEXT");
    const communicationPromptBuilder = vi.fn(() => "PRIVATE PERSONA CONTEXT");
    const learningContextBuilder = vi.fn(() => ({ preferences: { timezone: "America/Los_Angeles" } }));
    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        capturedSystemPrompts.push(params.systemPrompt);
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 10, outputTokens: 1 };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPromptBuilder: () => "BASE_PROMPT",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      compactionContextBuilder,
      communicationPromptBuilder,
      learningContextBuilder,
    });

    await runtime.executeRun({
      task: "Create a workflow for release reminders",
      sessionKey: "channel:feishu:group-1",
      principalId: "user-1",
      executionContext: {
        surface: "channel",
        channelKind: "feishu",
        channelChatType: "group",
        channelControlRoute: "full_agent",
      },
    });

    await runtime.executeRun({
      task: "Create a workflow for release reminders",
      sessionKey: "channel:feishu:dm-user-1",
      principalId: "user-1",
      executionContext: {
        surface: "channel",
        channelKind: "feishu",
        channelChatType: "direct",
        channelControlRoute: "full_agent",
      },
    });

    expect(capturedSystemPrompts[0]).toBe("BASE_PROMPT");
    expect(capturedSystemPrompts[1]).toContain("ACTIVE MEMORY CONTEXT");
    expect(capturedSystemPrompts[1]).toContain("PRIVATE PERSONA CONTEXT");
    expect(compactionContextBuilder).toHaveBeenCalledTimes(1);
    expect(communicationPromptBuilder).toHaveBeenCalledTimes(1);
    expect(learningContextBuilder).toHaveBeenCalledTimes(1);
  });

  it("routes code tasks to the file and shell pack without browser or provider schemas", async () => {
    let capturedToolNames: string[] = [];
    let capturedPromptContext: FridayAgentSystemPromptContext | undefined;
    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        capturedToolNames = params.tools.map((tool) => tool.name).sort();
        yield { type: "text_delta", text: "I will inspect the repo first." };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 200, outputTokens: 8 };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPromptBuilder: (context) => {
        capturedPromptContext = context;
        return "STANDARD_PROMPT";
      },
      tools: [
        createNamedTool("read"),
        createNamedTool("write"),
        createNamedTool("edit"),
        createExecTool(),
        createSuccessfulWebSearchTool(),
        createSuccessfulWebFetchTool(),
        createNamedTool("browser"),
        createNamedTool("provider"),
        createNamedTool("desktop"),
      ],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "Fix the failing TypeScript tests in this repo" });

    expect(result.status).toBe("completed");
    expect(capturedPromptContext?.toolRouting?.profile).toBe("code");
    expect(capturedToolNames).toEqual(expect.arrayContaining([
      "edit",
      "exec",
      "read",
      "request_tool_pack",
      "web_fetch",
      "web_search",
      "write",
    ]));
    expect(capturedToolNames).not.toContain("browser");
    expect(capturedToolNames).not.toContain("provider");
    expect(capturedToolNames).not.toContain("desktop");
  });

  it("skips server workspace context for public isolated code tasks", async () => {
    let capturedToolNames: string[] = [];
    let capturedPromptContext: FridayAgentSystemPromptContext | undefined;
    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        capturedToolNames = params.tools.map((tool) => tool.name).sort();
        yield { type: "text_delta", text: "I cannot inspect server workspace files in public mode." };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 200, outputTokens: 12 };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPromptBuilder: (context) => {
        capturedPromptContext = context;
        return "STANDARD_PROMPT";
      },
      tools: [
        createNamedTool("read"),
        createNamedTool("write"),
        createNamedTool("edit"),
        createExecTool(),
        createNamedTool("pdf_parse"),
        createNamedTool("image_analysis"),
        createNamedTool("memory_search"),
        createNamedTool("memory_query"),
        createNamedTool("memory_get"),
        createNamedTool("memory_store"),
        createNamedTool("memory_extract"),
        createNamedTool("feedback"),
        createSuccessfulWebSearchTool(),
      ],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      contextEngine: {
        assemble: vi.fn().mockReturnValue({
          promptFragment: "SERVER_WORKSPACE_CONTEXT_SHOULD_NOT_LOAD",
        }),
      },
    });

    await runtime.executeRun({
      task: "Read AGENTS.md from the server workspace and summarize it",
      constraints: {
        readOnly: true,
        operationalMode: "restricted",
        dataSensitivity: "public",
      },
      disabledToolNames: [
        "read",
        "write",
        "edit",
        "exec",
        "pdf_parse",
        "image_analysis",
        "memory_search",
        "memory_query",
        "memory_get",
        "memory_store",
        "memory_extract",
        "feedback",
      ],
    });

    expect(capturedPromptContext?.contextPolicy).toEqual({ workspaceContext: "skip" });
    expect(capturedPromptContext?.toolRouting?.workspaceContextPolicy).toBe("skip");
    expect(capturedToolNames).not.toEqual(expect.arrayContaining([
      "read",
      "write",
      "edit",
      "exec",
      "pdf_parse",
      "image_analysis",
      "memory_search",
      "memory_query",
      "memory_get",
      "memory_store",
      "memory_extract",
      "feedback",
    ]));
  });

  it("exposes only read for explicit workspace read-tool tasks", async () => {
    const capturedToolNamesByTurn: string[][] = [];
    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        capturedToolNamesByTurn.push(params.tools.map((tool) => tool.name).sort());
        yield { type: "text_delta", text: "I cannot access README.md directly." };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPromptBuilder: () => "STANDARD_PROMPT",
      tools: [
        createNamedTool("read"),
        createNamedTool("write"),
        createNamedTool("edit"),
        createExecTool(),
        createSuccessfulWebSearchTool(),
        createSuccessfulWebFetchTool(),
        createNamedTool("skills_list"),
        createNamedTool("capabilities"),
      ],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "Call the `read` tool with path `README.md` from the current workspace root, then answer with the top H1 heading only. Do not use web search for this workspace file.",
    });

    expect(result.status).toBe("failed");
    expect(capturedToolNamesByTurn.length).toBeGreaterThan(0);
    for (const toolNames of capturedToolNamesByTurn) {
      expect(toolNames).toEqual(["read"]);
    }
  });

  it("routes channel full-agent workflow follow-ups to workflow tools", async () => {
    let capturedToolNames: string[] = [];
    let capturedPromptContext: FridayAgentSystemPromptContext | undefined;
    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        capturedToolNames = params.tools.map((tool) => tool.name).sort();
        yield { type: "text_delta", text: "我会继续生成 SampleBoard workflow。" };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 160, outputTokens: 8 };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPromptBuilder: (context) => {
        capturedPromptContext = context;
        return "STANDARD_PROMPT";
      },
      tools: [
        createNamedTool("task_status"),
        createNamedTool("workflow_run"),
        createNamedTool("workflow_generate"),
        createNamedTool("cron"),
        createNamedTool("skills_list"),
        createNamedTool("skill_run"),
        createNamedTool("memory_search"),
        createSuccessfulWebSearchTool(),
      ],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "4，然后做成一个workflow，我打开和调整后可以直接去自动化做任务",
      conversationContext: {
        turnKind: "clarification",
        currentTopicSummary: "SampleBoard skill 和 workflow 生成",
        selectedBlocks: [
          {
            id: "assistant:msg-40",
            source: "assistant_anchor",
            summary: "4. 全部打包成一个 skill，然后做成 workflow。你选哪个？",
            score: 100,
            reason: "Latest assistant answer is preferred because the user replied with an option choice.",
          },
        ],
      },
      executionContext: {
        channelKind: "dm",
        channelControlRoute: "full_agent",
      },
    });

    expect(result.status).toBe("completed");
    expect(capturedPromptContext?.toolRouting?.profile).toBe("workflow");
    expect(capturedToolNames).toEqual(expect.arrayContaining([
      "cron",
      "skill_run",
      "skills_list",
      "task_status",
      "workflow_generate",
      "workflow_run",
    ]));
    expect(capturedToolNames).not.toContain("memory_search");
  });

  it("loads a deferred tool pack on a second LLM turn when request_tool_pack is called", async () => {
    const capturedToolsByCall: string[][] = [];
    let callCount = 0;
    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        capturedToolsByCall.push(params.tools.map((tool) => tool.name).sort());
        callCount++;
        if (callCount === 1) {
          yield {
            type: "tool_use",
            id: "load-browser-pack",
            name: "request_tool_pack",
            input: { pack: "browser", reason: "Need an interactive page snapshot." },
          };
          yield { type: "message_end", stopReason: "tool_use", inputTokens: 180, outputTokens: 12 };
          return;
        }
        yield { type: "text_delta", text: "Browser pack is loaded." };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 220, outputTokens: 6 };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPromptBuilder: () => "STANDARD_PROMPT",
      tools: [
        createSuccessfulWebSearchTool(),
        createSuccessfulWebFetchTool(),
        createNamedTool("browser"),
        createNamedTool("provider"),
      ],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "Research the documentation for example.com" });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    expect(capturedToolsByCall[0]).toEqual(expect.arrayContaining([
      "request_tool_pack",
      "web_fetch",
      "web_search",
    ]));
    expect(capturedToolsByCall[0]).not.toContain("browser");
    expect(capturedToolsByCall[1]).toEqual(expect.arrayContaining([
      "browser",
      "request_tool_pack",
      "web_fetch",
      "web_search",
    ]));
    expect(capturedToolsByCall[1]).not.toContain("provider");
  });

  it("prepends provided history messages before the new task", async () => {
    let capturedMessages: FridayAgentMessage[] | undefined;

    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        capturedMessages = params.messages.map((message) => ({
          role: message.role,
          content: typeof message.content === "string"
            ? message.content
            : JSON.parse(JSON.stringify(message.content)),
        }));
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 4, outputTokens: 2 };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    await runtime.executeRun({
      task: "follow-up task",
      historyMessages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
      ],
    });

    expect(capturedMessages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "follow-up task" },
    ]);
  });

  it("uses taskPrompt for the current turn and retries when the answer matches the previous topic", async () => {
    const capturedCalls: FridayAgentMessage[][] = [];
    let callIndex = 0;

    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        capturedCalls.push(params.messages.map((message) => ({
          role: message.role,
          content: typeof message.content === "string"
            ? message.content
            : JSON.parse(JSON.stringify(message.content)),
        })));
        if (callIndex === 0) {
          callIndex++;
          yield { type: "text_delta", text: "Paris is the capital of France." };
          yield { type: "message_end", stopReason: "end_turn", inputTokens: 6, outputTokens: 4 };
          return;
        }
        yield { type: "text_delta", text: "Use a sourdough starter and let the dough ferment overnight." };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 7 };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "How do I bake sourdough bread?",
      taskPrompt: "This is a new question. Ignore the previous France topic.\nCurrent question: How do I bake sourdough bread?",
      historyMessages: [
        { role: "user", content: "What is the capital of France?" },
        { role: "assistant", content: "Paris is the capital of France." },
      ],
      conversationContext: {
        turnKind: "new_topic",
        previousTopicSummary: "What is the capital of France?",
        currentTopicSummary: "How do I bake sourdough bread?",
      },
    });

    expect(result.status).toBe("completed");
    expect(result.response).toContain("sourdough starter");
    expect(capturedCalls).toHaveLength(2);
    expect(capturedCalls[0]).toEqual([
      { role: "user", content: "What is the capital of France?" },
      { role: "assistant", content: "Paris is the capital of France." },
      { role: "user", content: "This is a new question. Ignore the previous France topic.\nCurrent question: How do I bake sourdough bread?" },
    ]);
    expect(capturedCalls[1]![capturedCalls[1]!.length - 1]).toEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("You answered the previous topic instead"),
      }),
    );
  });

  it("retries when a reply-anchor follow-up asks for more context instead of answering the anchored point", async () => {
    const capturedCalls: FridayAgentMessage[][] = [];
    let callIndex = 0;

    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        capturedCalls.push(params.messages.map((message) => ({
          role: message.role,
          content: typeof message.content === "string"
            ? message.content
            : JSON.parse(JSON.stringify(message.content)),
        })));
        if (callIndex === 0) {
          callIndex++;
          yield { type: "text_delta", text: "关于“这里”，我无法确定您具体指的内容。如果您能提供更多上下文，我将乐意帮助您。" };
          yield { type: "message_end", stopReason: "end_turn", inputTokens: 6, outputTokens: 10 };
          return;
        }
        yield { type: "text_delta", text: "这里指的是前面提到的桌面伴侣没有连接，所以 Friday 无法查看桌面内容。" };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 7, outputTokens: 12 };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "这里",
      taskPrompt: [
        "Continue the current topic: 桌面伴侣未连接",
        "Relevant anchors:",
        "- [reply_anchor] assistant: The desktop companion is not connected.",
        "An explicit reply anchor was selected. Do not ask what 'this/that/here' refers to unless the reply anchor itself is ambiguous.",
        "Latest user turn: 这里",
      ].join("\n"),
      historyMessages: [
        { role: "user", content: "看一下我桌面上的codex app给我的回复是什么" },
        { role: "assistant", content: "The desktop companion is not connected." },
      ],
      conversationContext: {
        turnKind: "follow_up",
        previousTopicSummary: "桌面伴侣未连接",
        currentTopicSummary: "桌面伴侣未连接",
        selectedBlocks: [
          {
            id: "reply:msg-2",
            source: "reply_anchor",
            summary: "assistant: The desktop companion is not connected.",
            score: 100,
            reason: "Explicit reply target matched a prior session message.",
            messageIds: ["msg-2"],
          },
        ],
        selectionReasons: ["reply_anchor → Explicit reply target matched a prior session message."],
        replyToMessageId: "discord-assistant-1",
      },
    });

    expect(result.status).toBe("completed");
    expect(result.response).toContain("The desktop companion is not connected");
    expect(capturedCalls).toHaveLength(3);
    expect(capturedCalls[1]![capturedCalls[1]!.length - 1]).toEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("explicit reply anchor was already selected"),
      }),
    );
    expect(capturedCalls[2]![capturedCalls[2]!.length - 1]).toEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("without carrying forward any concrete detail"),
      }),
    );
  });

  it("retries when an anchored clarification restarts with a generic Friday introduction", async () => {
    const capturedCalls: FridayAgentMessage[][] = [];
    let callIndex = 0;

    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        capturedCalls.push(params.messages.map((message) => ({
          role: message.role,
          content: typeof message.content === "string"
            ? message.content
            : JSON.parse(JSON.stringify(message.content)),
        })));
        if (callIndex === 0) {
          callIndex++;
          yield { type: "text_delta", text: "我是 Friday，一个开源 AI 自动化 agent。我可以帮你执行多步骤任务、搜索网络、创建工作流。想让我做什么？" };
          yield { type: "message_end", stopReason: "end_turn", inputTokens: 7, outputTokens: 18 };
          return;
        }
        yield { type: "text_delta", text: "我会按第 4 项继续：把 SampleBoard 打包成 Friday skill，并生成可调整后直接运行的 workflow。" };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 20 };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "4，然后做成一个workflow，我打开和调整后可以直接去自动化做任务",
      taskPrompt: [
        "The user is replying to your clarification request: 4，然后做成一个workflow，我打开和调整后可以直接去自动化做任务",
        "Current topic: SampleBoard skill 和 workflow 生成",
        "Relevant anchors:",
        "- [assistant_anchor] 4. 全部打包成一个 skill，然后做成 workflow。你选哪个？",
        "Use this answer to continue the current topic.",
      ].join("\n"),
      conversationContext: {
        turnKind: "clarification",
        currentTopicSummary: "SampleBoard skill 和 workflow 生成",
        selectedBlocks: [
          {
            id: "assistant:msg-40",
            source: "assistant_anchor",
            summary: "4. 全部打包成一个 skill，然后做成 workflow。你选哪个？",
            score: 100,
            reason: "Latest assistant answer is preferred because the user replied with an option choice.",
          },
        ],
      },
    });

    expect(result.status).toBe("completed");
    expect(result.response).toContain("SampleBoard");
    expect(result.response).toContain("workflow");
    expect(capturedCalls).toHaveLength(2);
    expect(capturedCalls[1]![capturedCalls[1]!.length - 1]).toEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("generic self-introduction"),
      }),
    );
  });

  it("retries when a reply-anchor follow-up drifts into generic troubleshooting without anchored facts", async () => {
    const capturedCalls: FridayAgentMessage[][] = [];
    let callIndex = 0;

    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        capturedCalls.push(params.messages.map((message) => ({
          role: message.role,
          content: typeof message.content === "string"
            ? message.content
            : JSON.parse(JSON.stringify(message.content)),
        })));
        if (callIndex === 0) {
          callIndex++;
          yield { type: "text_delta", text: "Common reasons applications fail to open include network issues, outdated software, or app crashes." };
          yield { type: "message_end", stopReason: "end_turn", inputTokens: 7, outputTokens: 14 };
          return;
        }
        yield { type: "text_delta", text: "It did not open because the browser session was not connected in the earlier GitHub attempt." };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 15 };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "why didn't it connect/open?",
      taskPrompt: [
        "The user is following up on a specifically referenced earlier exchange.",
        "Relevant anchors:",
        "- [reply_anchor] user: open github assistant: I could not open GitHub because the browser session was not connected.",
        "Latest user turn: why didn't it connect/open?",
        "An explicit reply anchor was selected. Answer the referenced point directly from the anchored context.",
        "Do not reinterpret this as a generic troubleshooting or research request unless the user explicitly broadens the scope.",
      ].join("\n"),
      historyMessages: [
        { role: "user", content: "open github" },
        { role: "assistant", content: "I could not open GitHub because the browser session was not connected." },
      ],
      conversationContext: {
        turnKind: "follow_up",
        currentTopicSummary: "open github",
        selectedBlocks: [
          {
            id: "reply:msg-2",
            source: "reply_anchor",
            summary: "user: open github assistant: I could not open GitHub because the browser session was not connected.",
            score: 100,
            reason: "Explicit reply target matched a prior session message.",
            messageIds: ["msg-1", "msg-2"],
          },
        ],
        selectionReasons: ["reply_anchor → Explicit reply target matched a prior session message."],
        replyToMessageId: "discord-assistant-2",
      },
    });

    expect(result.status).toBe("completed");
    expect(result.response).toContain("browser session was not connected");
    expect(capturedCalls).toHaveLength(2);
    expect(capturedCalls[1]![capturedCalls[1]!.length - 1]).toEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("without carrying forward any concrete detail"),
      }),
    );
  });

  it("retries and anchors a Chinese short follow-up instead of generic troubleshooting", async () => {
    const capturedCalls: FridayAgentMessage[][] = [];
    let callIndex = 0;

    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        capturedCalls.push(params.messages.map((message) => ({
          role: message.role,
          content: typeof message.content === "string"
            ? message.content
            : JSON.parse(JSON.stringify(message.content)),
        })));
        if (callIndex === 0) {
          callIndex++;
          yield {
            type: "text_delta",
            text: "您提到的 Codex 应用没有连接的原因可能是由于多种因素。以下是一些常见的问题和解决方法：1. 网络问题。2. 权限问题。",
          };
          yield { type: "message_end", stopReason: "end_turn", inputTokens: 9, outputTokens: 24 };
          return;
        }
        yield {
          type: "text_delta",
          text: "前面那次不是网络排障，而是我在尝试访问 Codex 应用时遇到了无效的 URL，所以当时没能直接读取通知。",
        };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 22 };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "为什么没有connect",
      taskPrompt: [
        "用户是在追问前面一条明确引用的回复。",
        "Relevant anchors:",
        "- [reply_anchor] user: 看一下我桌面上的codex app给我的回复是什么 assistant: 我尝试访问 Codex 应用时遇到了无效的 URL，所以没能直接读取通知。",
        "Latest user turn: 为什么没有connect",
        "显式 reply anchor 已经选中。先解释前面那条回复里已经出现的具体事实，不要改写成泛化排障清单。",
      ].join("\n"),
      historyMessages: [
        { role: "user", content: "看一下我桌面上的codex app给我的回复是什么" },
        { role: "assistant", content: "我尝试访问 Codex 应用时遇到了无效的 URL，所以没能直接读取通知。" },
      ],
      conversationContext: {
        turnKind: "follow_up",
        currentTopicSummary: "桌面上的 Codex 应用回复",
        selectedBlocks: [
          {
            id: "reply:msg-cn-2",
            source: "reply_anchor",
            summary: "user: 看一下我桌面上的codex app给我的回复是什么 assistant: 我尝试访问 Codex 应用时遇到了无效的 URL，所以没能直接读取通知。",
            score: 100,
            reason: "Explicit reply target matched a prior session message.",
            messageIds: ["msg-cn-1", "msg-cn-2"],
          },
        ],
        selectionReasons: ["reply_anchor → Explicit reply target matched a prior session message."],
        replyToMessageId: "discord-assistant-cn-2",
      },
    });

    expect(result.status).toBe("completed");
    expect(result.response).toContain("无效");
    expect(result.response).toContain("URL");
    expect(capturedCalls).toHaveLength(2);
    expect(capturedCalls[1]![capturedCalls[1]!.length - 1]).toEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("generic troubleshooting"),
      }),
    );
  });

  it("retries when an implicit assistant-anchor follow-up invents a new successful state", async () => {
    const capturedCalls: FridayAgentMessage[][] = [];
    let callIndex = 0;

    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        capturedCalls.push(params.messages.map((message) => ({
          role: message.role,
          content: typeof message.content === "string"
            ? message.content
            : JSON.parse(JSON.stringify(message.content)),
        })));
        if (callIndex === 0) {
          callIndex++;
          yield {
            type: "text_delta",
            text: "我已经成功将焦点转移到 Codex 应用。现在你可以查看消息了。",
          };
          yield { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 18 };
          return;
        }
        yield {
          type: "text_delta",
          text: "前面那次并不是已经连上了，而是桌面伴侣没有连接，所以 Friday 当时无法查看桌面内容。更深一层的原因我现在没有可验证证据。",
        };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 9, outputTokens: 24 };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "为什么没有connect",
      taskPrompt: [
        "Continue the current topic: 看一下我桌面上的codex app给我的回复是什么",
        "Referenced assistant fact: The desktop companion is not connected.",
        "Relevant anchors:",
        "- [assistant_anchor] The desktop companion is not connected.",
        "Treat this short follow-up as referring to the referenced assistant fact even if the user uses deictic wording like “这里/这个/that one/why didn’t it connect”.",
        "Latest user turn: 为什么没有connect",
        "Explain the referenced assistant fact directly before adding any broader caveat.",
        "Do not claim a new action, a new success state, or a new result unless this turn produced new deterministic evidence.",
      ].join("\n"),
      historyMessages: [
        { role: "user", content: "看一下我桌面上的codex app给我的回复是什么" },
        { role: "assistant", content: "The desktop companion is not connected." },
      ],
      conversationContext: {
        turnKind: "follow_up",
        previousTopicSummary: "看一下我桌面上的codex app给我的回复是什么",
        currentTopicSummary: "看一下我桌面上的codex app给我的回复是什么",
        selectedBlocks: [
          {
            id: "assistant:msg-2",
            source: "assistant_anchor",
            summary: "The desktop companion is not connected.",
            score: 42,
            reason: "Latest assistant answer is a plausible short-follow-up anchor.",
            messageIds: ["msg-2"],
          },
          {
            id: "focus:current-topic",
            source: "focus_topic",
            summary: "看一下我桌面上的codex app给我的回复是什么",
            score: 12,
            reason: "Persisted focus topic kept as a low-weight context block.",
          },
        ],
        selectionReasons: ["assistant_anchor → Latest assistant answer is a plausible short-follow-up anchor."],
      },
    });

    expect(result.status).toBe("completed");
    expect(result.response).toContain("没有连接");
    expect(capturedCalls).toHaveLength(2);
    expect(capturedCalls[1]![capturedCalls[1]!.length - 1]).toEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("contradicts the earlier anchored fact"),
      }),
    );
  });

  it("falls back deterministically for implicit assistant-anchor follow-ups after exhausting retries", async () => {
    let callIndex = 0;

    const llmClient: FridayAgentLlmClient = {
      async *stream() {
        callIndex++;
        if (callIndex === 1) {
          yield { type: "text_delta", text: "我已经成功将焦点转移到 Codex 应用。现在你可以查看消息了。" };
        } else if (callIndex === 2) {
          yield { type: "text_delta", text: "常见原因包括网络、权限或者程序设置问题。" };
        } else {
          yield { type: "text_delta", text: "Generic troubleshooting still applies here." };
        }
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 7, outputTokens: 12 };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "这里",
      historyMessages: [
        { role: "user", content: "看一下我桌面上的codex app给我的回复是什么" },
        { role: "assistant", content: "The desktop companion is not connected." },
      ],
      conversationContext: {
        turnKind: "follow_up",
        currentTopicSummary: "看一下我桌面上的codex app给我的回复是什么",
        selectedBlocks: [
          {
            id: "assistant:msg-2",
            source: "assistant_anchor",
            summary: "The desktop companion is not connected.",
            score: 42,
            reason: "Latest assistant answer is a plausible short-follow-up anchor.",
            messageIds: ["msg-2"],
          },
        ],
        selectionReasons: ["assistant_anchor → Latest assistant answer is a plausible short-follow-up anchor."],
      },
    });

    expect(callIndex).toBe(3);
    expect(result.status).toBe("completed");
    expect(result.response).toContain("The desktop companion is not connected.");
    expect(result.response).toContain("不做额外假设");
  });

  it("allows up to two alignment retries for reply-anchor follow ups", async () => {
    let callIndex = 0;
    const capturedCalls: FridayAgentMessage[][] = [];

    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        capturedCalls.push(params.messages.map((message) => ({
          role: message.role,
          content: typeof message.content === "string"
            ? message.content
            : JSON.parse(JSON.stringify(message.content)),
        })));
        if (callIndex === 0) {
          callIndex++;
          yield { type: "text_delta", text: "I need more context to know what you mean by that." };
          yield { type: "message_end", stopReason: "end_turn", inputTokens: 6, outputTokens: 11 };
          return;
        }
        if (callIndex === 1) {
          callIndex++;
          yield { type: "text_delta", text: "Common reasons things fail to open include network issues or bad settings." };
          yield { type: "message_end", stopReason: "end_turn", inputTokens: 7, outputTokens: 13 };
          return;
        }
        yield { type: "text_delta", text: "The earlier GitHub attempt did not open because the browser session was not connected. I do not have deeper root-cause evidence beyond that anchored fact." };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 18 };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "why didn't it connect/open?",
      taskPrompt: [
        "The user is following up on a specifically referenced earlier exchange.",
        "Relevant anchors:",
        "- [reply_anchor] user: open github assistant: I could not open GitHub because the browser session was not connected.",
        "Latest user turn: why didn't it connect/open?",
        "An explicit reply anchor was selected. Answer the referenced point directly from the anchored context.",
      ].join("\n"),
      historyMessages: [
        { role: "user", content: "open github" },
        { role: "assistant", content: "I could not open GitHub because the browser session was not connected." },
      ],
      conversationContext: {
        turnKind: "follow_up",
        currentTopicSummary: "open github",
        selectedBlocks: [
          {
            id: "reply:msg-2",
            source: "reply_anchor",
            summary: "user: open github assistant: I could not open GitHub because the browser session was not connected.",
            score: 100,
            reason: "Explicit reply target matched a prior session message.",
            messageIds: ["msg-1", "msg-2"],
          },
        ],
        selectionReasons: ["reply_anchor → Explicit reply target matched a prior session message."],
        replyToMessageId: "discord-assistant-2",
      },
    });

    expect(result.status).toBe("completed");
    expect(result.response).toContain("browser session was not connected");
    expect(capturedCalls).toHaveLength(3);
    expect(capturedCalls[1]![capturedCalls[1]!.length - 1]).toEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("explicit reply anchor was already selected"),
      }),
    );
    expect(capturedCalls[2]![capturedCalls[2]!.length - 1]).toEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("without carrying forward any concrete detail"),
      }),
    );
  });

  it("falls back to a deterministic reply-anchor explanation after exhausting alignment retries", async () => {
    let callIndex = 0;

    const llmClient: FridayAgentLlmClient = {
      async *stream() {
        callIndex++;
        if (callIndex === 1) {
          yield { type: "text_delta", text: "I need more context to know what you mean by that." };
        } else if (callIndex === 2) {
          yield { type: "text_delta", text: "Common reasons things fail to open include network issues or bad settings." };
        } else {
          yield { type: "text_delta", text: "Generic troubleshooting still applies here." };
        }
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 7, outputTokens: 12 };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "why didn't it connect/open?",
      historyMessages: [
        { role: "user", content: "open github" },
        { role: "assistant", content: "I could not open GitHub because the browser session was not connected." },
      ],
      conversationContext: {
        turnKind: "follow_up",
        selectedBlocks: [
          {
            id: "reply:msg-2",
            source: "reply_anchor",
            summary: "user: open github assistant: I could not open GitHub because the browser session was not connected.",
            score: 100,
            reason: "Explicit reply target matched a prior session message.",
            messageIds: ["msg-1", "msg-2"],
          },
        ],
        selectionReasons: ["reply_anchor → Explicit reply target matched a prior session message."],
        replyToMessageId: "discord-assistant-2",
      },
    });

    expect(callIndex).toBe(3);
    expect(result.status).toBe("completed");
    expect(result.response).toContain("I could not open GitHub because the browser session was not connected.");
    expect(result.response).toContain("I won't speculate");
  });

  it("disables web_search for reply-anchor follow ups without explicit research intent", async () => {
    const webSearchSpy = vi.fn(async () => ({
      content: "should not be called",
    }));

    const llmClient = createMockLlmClient([
      [
        { type: "tool_use", id: "call-web", name: "web_search", input: { query: "what did that earlier failure mean" } },
        { type: "message_end", stopReason: "tool_use", inputTokens: 7, outputTokens: 8 },
      ],
      [
        { type: "text_delta", text: "The earlier GitHub attempt did not open because the browser session was not connected." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 13 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [{
        name: "web_search",
        description: "Search the web",
        parameters: {
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
        async execute(args) {
          return webSearchSpy(args);
        },
      }],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "what did that earlier failure mean?",
      historyMessages: [
        { role: "user", content: "open github" },
        { role: "assistant", content: "I could not open GitHub because the browser session was not connected." },
      ],
      conversationContext: {
        turnKind: "follow_up",
        selectedBlocks: [
          {
            id: "reply:msg-2",
            source: "reply_anchor",
            summary: "user: open github assistant: I could not open GitHub because the browser session was not connected.",
            score: 100,
            reason: "Explicit reply target matched a prior session message.",
            messageIds: ["msg-1", "msg-2"],
          },
        ],
        selectionReasons: ["reply_anchor → Explicit reply target matched a prior session message."],
        replyToMessageId: "discord-assistant-2",
      },
    });

    expect(result.status).toBe("completed");
    expect(result.response).toContain("browser session was not connected");
    expect(webSearchSpy).not.toHaveBeenCalled();
  });

  it("records usage metadata when LLM reports actual provider fields", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "ok" },
        {
          type: "message_end",
          stopReason: "end_turn",
          inputTokens: 12,
          outputTokens: 6,
          actualProviderId: "provider-1",
          actualModel: "gpt-4o-mini",
          actualProviderApi: "openai-completions",
          costUsd: 0.0012,
        },
      ],
    ]);
    const usageRecorder = vi.fn(async () => {});

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      usageRecorder,
    });

    const result = await runtime.executeRun({ task: "usage test" });

    expect(result.status).toBe("completed");
    expect(usageRecorder).toHaveBeenCalledTimes(1);
    expect(usageRecorder).toHaveBeenCalledWith({
      providerId: "provider-1",
      model: "gpt-4o-mini",
      providerApi: "openai-completions",
      inputTokens: 12,
      outputTokens: 6,
      costUsd: 0.0012,
    });
  });

  it("flags unverified completion claims when no tool was executed", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "I have successfully opened Google for you." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "open google" });

    expect(result.status).toBe("completed");
    expect(result.response).toContain("I have successfully opened Google for you.");
    expect(result.response).toContain("no successful tool call evidence");
  });

  it("flags unverified Chinese completion claims when no tool was executed", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "我已经成功打开了 Google。" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "打开 google" });

    expect(result.status).toBe("completed");
    expect(result.response).toContain("我已经成功打开了 Google。");
    expect(result.response).toContain("no successful tool call evidence");
  });

  it("flags unverified completion claims when all tool calls failed", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "tool_use", id: "call-1", name: "echo", input: { message: "ping" } },
        { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "I have successfully opened Google for you." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 12, outputTokens: 8 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createFailingEchoTool()],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "open google" });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    expect(result.response).toContain("no successful tool call evidence");
  });

  it("re-prompts for evidence on URL tasks when first answer has no tool call", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "I cannot access that URL right now." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
      [
        {
          type: "tool_use",
          id: "call-1",
          name: "web_fetch",
          input: { url: "https://example.com" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 12, outputTokens: 8 },
      ],
      [
        { type: "text_delta", text: "Fetched and verified from the URL." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 10, outputTokens: 7 },
      ],
    ]);
    const webFetchSpy = vi.fn();

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createSuccessfulWebFetchTool(webFetchSpy), createBrowserTool()],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "https://example.com 这个页面是什么",
    });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    expect(webFetchSpy).toHaveBeenCalledTimes(1);
    expect(result.response).toContain("Fetched and verified");
  });

  it("fails URL route when no successful evidence-capable tool result exists", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "I cannot access that URL right now." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
      [
        { type: "text_delta", text: "Still cannot verify that page." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
      [
        { type: "text_delta", text: "No tool evidence available." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createSuccessfulWebFetchTool(), createBrowserTool()],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "https://example.com 这个页面是什么",
    });

    expect(result.status).toBe("failed");
    expect(result.toolCallCount).toBe(0);
    expect(result.response).toContain("AGENT_OUTPUT_CLOSURE_ERROR");
  });

  it("does not count request_tool_pack as local workspace file read evidence", async () => {
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "load-code-pack",
          name: "request_tool_pack",
          input: { pack: "code", reason: "Need local workspace file access." },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 6 },
      ],
      [
        { type: "text_delta", text: "I cannot access README.md directly." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
      [
        { type: "text_delta", text: "Still unable to read README.md." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPromptBuilder: () => "STANDARD_PROMPT",
      tools: [createNamedTool("read"), createExecTool()],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "Call the read tool with path README.md from the current workspace root, then answer with the top H1 heading only.",
    });

    expect(result.status).toBe("failed");
    expect(result.toolCallCount).toBe(1);
    expect(result.response).toContain("AGENT_OUTPUT_CLOSURE_ERROR");
  });

  it("does not count web or skill-list tools as local workspace file read evidence", async () => {
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "web-fetch-readme",
          name: "web_fetch",
          input: { url: "https://example.com/README.md" },
        },
        {
          type: "tool_use",
          id: "list-skills",
          name: "skills_list",
          input: {},
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 6 },
      ],
      [
        { type: "text_delta", text: "I still cannot access README.md from the workspace." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
      [
        { type: "text_delta", text: "No local read evidence is available." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPromptBuilder: () => "STANDARD_PROMPT",
      tools: [createSuccessfulWebFetchTool(), createNamedTool("skills_list"), createNamedTool("read")],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "Call the read tool with path README.md from the current workspace root, then answer with the top H1 heading only.",
    });

    expect(result.status).toBe("failed");
    expect(result.toolCallCount).toBe(2);
    expect(result.response).toContain("AGENT_OUTPUT_CLOSURE_ERROR");
  });

  it("blocks non-read detours for explicit local workspace read-tool tasks", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "friday-agent-runtime-read-detour-"));
    writeFileSync(join(workspaceRoot, "README.md"), "# Friday\n\nLocal fixture.\n", "utf8");
    const webFetchSpy = vi.fn();
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "web-fetch-readme",
          name: "web_fetch",
          input: { url: "README.md" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 6 },
      ],
      [
        {
          type: "tool_use",
          id: "read-readme",
          name: "read",
          input: { path: "README.md" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 6 },
      ],
      [
        { type: "text_delta", text: "Friday" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPromptBuilder: () => "STANDARD_PROMPT",
      tools: [createSuccessfulWebFetchTool(webFetchSpy), ...createFridayAgentFileTools({ workspaceRoot })],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      workdir: workspaceRoot,
    });

    try {
      const result = await runtime.executeRun({
        task: "Call the read tool with path README.md from the current workspace root, then answer with the top H1 heading only.",
      });

      expect(result.status).toBe("completed");
      expect(result.toolCallCount).toBe(2);
      expect(result.response).toBe("Friday");
      expect(webFetchSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("blocks read calls that target the wrong local workspace path", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "friday-agent-runtime-read-wrong-path-"));
    writeFileSync(join(workspaceRoot, "README.md"), "# Friday\n\nLocal fixture.\n", "utf8");
    writeFileSync(join(workspaceRoot, "NOTES.md"), "# Wrong\n", "utf8");
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "read-notes",
          name: "read",
          input: { path: "NOTES.md" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 6 },
      ],
      [
        {
          type: "tool_use",
          id: "read-readme",
          name: "read",
          input: { path: "README.md" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 6 },
      ],
      [
        { type: "text_delta", text: "Friday" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPromptBuilder: () => "STANDARD_PROMPT",
      tools: createFridayAgentFileTools({ workspaceRoot }),
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      workdir: workspaceRoot,
    });

    try {
      const result = await runtime.executeRun({
        task: "Call the read tool with path README.md from the current workspace root, then answer with the top H1 heading only.",
      });

      expect(result.status).toBe("completed");
      expect(result.toolCallCount).toBe(2);
      expect(result.response).toBe("Friday");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("does not count capabilities as local workspace file read evidence", async () => {
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "check-capabilities",
          name: "capabilities",
          input: {},
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 6 },
      ],
      [
        { type: "text_delta", text: "Capabilities checked, but I cannot read README.md from the workspace." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
      [
        { type: "text_delta", text: "No local file read evidence is available." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPromptBuilder: () => "STANDARD_PROMPT",
      tools: [createNamedTool("capabilities"), createNamedTool("read")],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "Use capabilities if needed, but read README.md from the local workspace and answer with the top H1 heading only.",
    });

    expect(result.status).toBe("failed");
    expect(result.response).toContain("AGENT_OUTPUT_CLOSURE_ERROR");
  });

  it("does not satisfy nested workspace file requests with a same-basename read", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "friday-agent-runtime-read-path-match-"));
    writeFileSync(join(workspaceRoot, "README.md"), "# Wrong\n", "utf8");
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "read-root-readme",
          name: "read",
          input: { path: "README.md" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 6 },
      ],
      [
        { type: "text_delta", text: "Wrong" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
      [
        { type: "text_delta", text: "Still no matching nested file read." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPromptBuilder: () => "STANDARD_PROMPT",
      tools: createFridayAgentFileTools({ workspaceRoot }),
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      workdir: workspaceRoot,
    });

    try {
      const result = await runtime.executeRun({
        task: "Call the read tool with path docs/README.md from the current workspace root, then answer with the top H1 heading only.",
      });

      expect(result.status).toBe("failed");
      expect(result.toolCallCount).toBe(1);
      expect(result.response).toContain("AGENT_OUTPUT_CLOSURE_ERROR");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("retries local workspace file tasks until the requested file is read", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "friday-agent-runtime-read-evidence-"));
    writeFileSync(join(workspaceRoot, "README.md"), "# Friday\n\nLocal fixture.\n", "utf8");
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "I cannot access README.md directly." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
      [
        {
          type: "tool_use",
          id: "read-readme",
          name: "read",
          input: { path: "README.md" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 6 },
      ],
      [
        { type: "text_delta", text: "Friday" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPromptBuilder: () => "STANDARD_PROMPT",
      tools: createFridayAgentFileTools({ workspaceRoot }),
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      workdir: workspaceRoot,
    });

    try {
      const result = await runtime.executeRun({
        task: "Call the read tool with path README.md from the current workspace root, then answer with the top H1 heading only.",
      });

      expect(result.status).toBe("completed");
      expect(result.toolCallCount).toBe(1);
      expect(result.response).toBe("Friday");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("retries local workspace file tasks when a successful read is followed by a refusal answer", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "friday-agent-runtime-read-refusal-"));
    writeFileSync(join(workspaceRoot, "README.md"), "# Friday\n\nLocal fixture.\n", "utf8");
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "read-readme",
          name: "read",
          input: { path: "README.md" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 6 },
      ],
      [
        { type: "text_delta", text: "未能读取到 README.md 文件的内容。请确认文件存在或路径正确。" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
      [
        { type: "text_delta", text: "Friday" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPromptBuilder: () => "STANDARD_PROMPT",
      tools: createFridayAgentFileTools({ workspaceRoot }),
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      workdir: workspaceRoot,
    });

    try {
      const result = await runtime.executeRun({
        task: "Call the read tool with path README.md from the current workspace root, then answer with the top H1 heading only.",
      });

      expect(result.status).toBe("completed");
      expect(result.toolCallCount).toBe(1);
      expect(result.response).toBe("Friday");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("retries top-heading workspace reads when the first read is too narrow", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "friday-agent-runtime-read-heading-"));
    writeFileSync(
      join(workspaceRoot, "README.md"),
      [
        '<p align="right">',
        '  <a href="README.zh-CN.md">中文</a>',
        "</p>",
        "",
        '<h1 align="center">Friday</h1>',
        "",
        "Local fixture.",
      ].join("\n"),
      "utf8",
    );
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "read-readme-narrow",
          name: "read",
          input: { path: "README.md", limit: 1 },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 6 },
      ],
      [
        { type: "text_delta", text: 'The top H1 is <p align="right">.' },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
      [
        {
          type: "tool_use",
          id: "read-readme-full",
          name: "read",
          input: { path: "README.md" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 6 },
      ],
      [
        { type: "text_delta", text: "Friday" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPromptBuilder: () => "STANDARD_PROMPT",
      tools: createFridayAgentFileTools({ workspaceRoot }),
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      workdir: workspaceRoot,
    });

    try {
      const result = await runtime.executeRun({
        task: "Call the read tool with path README.md from the current workspace root, then answer with the top H1 heading only.",
      });

      expect(result.status).toBe("completed");
      expect(result.toolCallCount).toBe(2);
      expect(result.response).toBe("Friday");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("re-prompts latest news answers until dates and URLs are included", async () => {
    let callCount = 0;
    const llmClient: FridayAgentLlmClient = {
      async *stream() {
        callCount++;
        if (callCount === 1) {
          yield {
            type: "tool_use",
            id: "call-1",
            name: "web_search",
            input: { query: "Iran latest news", freshness: "day", numResults: 3 },
          };
          yield { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 };
          return;
        }
        if (callCount === 2) {
          yield { type: "text_delta", text: "Here are the latest Iran headlines." };
          yield { type: "message_end", stopReason: "end_turn", inputTokens: 9, outputTokens: 7 };
          return;
        }
        yield {
          type: "text_delta",
          text: "1. Headline A (2026-02-19) https://example.com/a\n2. Headline B (2026-02-18) https://example.com/b",
        };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 11, outputTokens: 9 };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [
        createSuccessfulWebSearchTool({
          metadata: {
            provider: "serper",
            freshnessRequested: "day",
            freshnessApplied: true,
            hasDates: true,
            warning: null,
          },
        }),
      ],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "Give me the latest Iran news",
      timezone: "UTC",
    });

    expect(result.status).toBe("completed");
    expect(callCount).toBe(3);
    expect(result.response).toContain("2026-02-19");
    expect(result.response).toContain("https://example.com/a");
  });

  it("keeps latest-news enforcement sticky across history follow-ups", async () => {
    let callCount = 0;
    const llmClient: FridayAgentLlmClient = {
      async *stream() {
        callCount++;
        if (callCount === 1) {
          yield {
            type: "tool_use",
            id: "call-1",
            name: "web_search",
            input: { query: "Iran latest news", freshness: "day", numResults: 3 },
          };
          yield { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 };
          return;
        }
        if (callCount === 2) {
          yield { type: "text_delta", text: "再来三条：" };
          yield { type: "message_end", stopReason: "end_turn", inputTokens: 9, outputTokens: 7 };
          return;
        }
        yield {
          type: "text_delta",
          text: "1. 新闻 A（2026-02-19）https://example.com/a\n2. 新闻 B（2026-02-18）https://example.com/b\n3. 新闻 C（2026-02-17）https://example.com/c",
        };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 11, outputTokens: 9 };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [
        createSuccessfulWebSearchTool({
          metadata: {
            provider: "serper",
            freshnessRequested: "day",
            freshnessApplied: true,
            hasDates: true,
            warning: null,
          },
        }),
      ],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "再来三条",
      timezone: "UTC",
      historyMessages: [
        { role: "user", content: "Give me the latest Iran news" },
        { role: "assistant", content: "previous answer" },
      ],
    });

    expect(result.status).toBe("completed");
    expect(callCount).toBe(3);
    expect(result.response).toContain("https://example.com/c");
  });

  it("requires each listed latest-news item to include its own date and URL", async () => {
    let callCount = 0;
    const llmClient: FridayAgentLlmClient = {
      async *stream() {
        callCount++;
        if (callCount === 1) {
          yield {
            type: "tool_use",
            id: "call-1",
            name: "web_search",
            input: { query: "Iran latest news", freshness: "day", numResults: 3 },
          };
          yield { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 };
          return;
        }
        if (callCount === 2) {
          yield {
            type: "text_delta",
            text: "1. Headline A (2026-02-19) https://example.com/a\n2. Headline B\n3. Headline C (2026-02-17) https://example.com/c",
          };
          yield { type: "message_end", stopReason: "end_turn", inputTokens: 9, outputTokens: 7 };
          return;
        }
        yield {
          type: "text_delta",
          text: "1. Headline A (2026-02-19) https://example.com/a\n2. Headline B (2026-02-18) https://example.com/b\n3. Headline C (2026-02-17) https://example.com/c",
        };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 11, outputTokens: 9 };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [
        createSuccessfulWebSearchTool({
          metadata: {
            provider: "serper",
            freshnessRequested: "day",
            freshnessApplied: true,
            hasDates: true,
            warning: null,
          },
        }),
      ],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "Give me the latest Iran news",
      timezone: "UTC",
    });

    expect(result.status).toBe("completed");
    expect(callCount).toBe(3);
    expect(result.response).toContain("https://example.com/b");
  });

  it("does not accept a generic latestness caveat without exact date and timezone", async () => {
    let callCount = 0;
    const llmClient: FridayAgentLlmClient = {
      async *stream() {
        callCount++;
        if (callCount === 1) {
          yield {
            type: "tool_use",
            id: "call-1",
            name: "web_search",
            input: { query: "Iran latest news", freshness: "day", numResults: 3 },
          };
          yield { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 };
          return;
        }
        yield { type: "text_delta", text: "I cannot verify that these are the latest results." };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 9, outputTokens: 7 };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [
        createSuccessfulWebSearchTool({
          metadata: {
            provider: "duckduckgo",
            freshnessRequested: "day",
            freshnessApplied: false,
            hasDates: false,
            warning: "DuckDuckGo HTML search does not provide verified recency filtering or stable publication dates; latest-ness is unverified.",
          },
        }),
      ],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "Give me the latest Iran news",
      timezone: "UTC",
    });

    expect(result.status).toBe("completed");
    expect(callCount).toBe(3);
    expect(result.response).toContain("2026-02-19 (UTC)");
  });

  it("retries when the model claims latestness is unverified despite verified dated search evidence", async () => {
    let callCount = 0;
    const llmClient: FridayAgentLlmClient = {
      async *stream() {
        callCount++;
        if (callCount === 1) {
          yield {
            type: "tool_use",
            id: "call-1",
            name: "web_search",
            input: { query: "OpenAI latest news", freshness: "day", numResults: 3 },
          };
          yield { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 };
          return;
        }
        if (callCount === 2) {
          yield {
            type: "text_delta",
            text: "I could not verify that these are the latest results as of 2026-02-19 (UTC).",
          };
          yield { type: "message_end", stopReason: "end_turn", inputTokens: 9, outputTokens: 7 };
          return;
        }
        yield {
          type: "text_delta",
          text: "1. Headline A (2026-02-19) https://example.com/a\n2. Headline B (2026-02-18) https://example.com/b\n3. Headline C (2026-02-17) https://example.com/c",
        };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 11, outputTokens: 9 };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [
        createSuccessfulWebSearchTool({
          metadata: {
            provider: "google_news_rss",
            freshnessRequested: "day",
            freshnessApplied: true,
            hasDates: true,
            warning: null,
          },
        }),
      ],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "Give me the latest OpenAI news",
      timezone: "UTC",
    });

    expect(result.status).toBe("completed");
    expect(callCount).toBe(3);
    expect(result.response).toContain("https://example.com/c");
    expect(result.response).not.toContain("could not verify");
  });

  it("does not treat current capability questions as time-sensitive news", async () => {
    let callCount = 0;
    const llmClient: FridayAgentLlmClient = {
      async *stream() {
        callCount++;
        yield { type: "text_delta", text: "Discord is enabled. MCP is disabled. Provider mutations are blocked by readOnly. Desktop companion is disconnected." };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 18 };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "What can Friday do right now in this deployment? Use current runtime facts only.",
      timezone: "UTC",
    });

    expect(result.status).toBe("completed");
    expect(callCount).toBe(1);
    expect(result.response).toContain("Discord is enabled.");
    expect(result.response).not.toContain("unverified search results");
    expect(result.response).not.toContain("I could not verify that these are the latest results");
  });

  it("does not treat a plain article read as time-sensitive news", async () => {
    let callCount = 0;
    const webFetchSpy = vi.fn();
    const llmClient: FridayAgentLlmClient = {
      async *stream() {
        callCount++;
        if (callCount === 1) {
          yield {
            type: "tool_use",
            id: "call-1",
            name: "web_fetch",
            input: { url: "https://example.com/article/123" },
          };
          yield { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 };
          return;
        }
        yield { type: "text_delta", text: "The article discusses AI agents transforming software development." };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 9, outputTokens: 7 };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [
        {
          name: "web_fetch",
          description: "Successful web fetch tool",
          parameters: {
            properties: {
              url: { type: "string" },
            },
            required: ["url"],
          },
          async execute(args) {
            webFetchSpy(args);
            return {
              content:
                "HTTP 200\nContent-Type: text/html; charset=utf-8\n(HTML parsed to plain text)\nAI Agents in 2026\n\nAI Agents Transform Software Development...",
            };
          },
        },
      ],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "Read this article: https://example.com/article/123",
      timezone: "UTC",
    });

    expect(result.status).toBe("completed");
    expect(callCount).toBe(2);
    expect(webFetchSpy).toHaveBeenCalledWith({ url: "https://example.com/article/123" });
    expect(result.response).toContain("The article discusses AI agents");
    expect(result.response).not.toContain("latest results");
  });

  it("adds a caveat when latest news evidence remains unverified after retry", async () => {
    let callCount = 0;
    const llmClient: FridayAgentLlmClient = {
      async *stream() {
        callCount++;
        if (callCount === 1) {
          yield {
            type: "tool_use",
            id: "call-1",
            name: "web_search",
            input: { query: "Iran latest news", freshness: "day", numResults: 3 },
          };
          yield { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 };
          return;
        }
        yield { type: "text_delta", text: "These are the top search hits I found." };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 9, outputTokens: 7 };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [
        createSuccessfulWebSearchTool({
          metadata: {
            provider: "duckduckgo",
            freshnessRequested: "day",
            freshnessApplied: false,
            hasDates: false,
            warning: "DuckDuckGo HTML search does not provide verified recency filtering or stable publication dates; latest-ness is unverified.",
          },
          content: "Warning: DuckDuckGo HTML search does not provide verified recency filtering or stable publication dates; latest-ness is unverified.",
        }),
      ],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "Give me the latest Iran news",
      timezone: "UTC",
    });

    expect(result.status).toBe("completed");
    expect(callCount).toBe(3);
    expect(result.response).toContain("could not verify");
    expect(result.response).toContain("2026-02-19 (UTC)");
  });

  it("fails desktop route when no successful evidence-capable tool result exists", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "我无法直接查看您的桌面内容。" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
      [
        { type: "text_delta", text: "仍然无法确认桌面内容。" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
      [
        { type: "text_delta", text: "没有可验证证据。" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createExecTool()],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "在我的桌面上看一下 codex 回复是什么",
    });

    expect(result.status).toBe("failed");
    expect(result.toolCallCount).toBe(0);
    expect(result.response).toContain("AGENT_OUTPUT_CLOSURE_ERROR");
  });

  it("auto-fallbacks web_fetch errors to browser and keeps evidence", async () => {
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-1",
          name: "web_fetch",
          input: { url: "https://www.youtube.com/watch?v=abc" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "I checked it and here is the summary." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 15, outputTokens: 10 },
      ],
    ]);
    const webFetchSpy = vi.fn();
    const onOpen = vi.fn();
    const onSnapshot = vi.fn();

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [
        createFailingWebFetchTool(
          webFetchSpy,
          "Fetch error: DNS lookup timed out for www.youtube.com",
        ),
        createBrowserTool({ onOpen, onSnapshot }),
      ],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "summarize this youtube url" });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    expect(webFetchSpy).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(result.response).toContain("summary");
    expect(result.response).not.toContain("no successful tool call evidence");
  });

  it("marks feedback-recorded claim as unverified when no feedback persistence tool was used", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "我已经记录了您的反馈，会用于后续改进。" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 9, outputTokens: 7 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "请记录我的反馈" });

    expect(result.status).toBe("completed");
    expect(result.response).toContain("我已经记录了您的反馈");
    expect(result.response).toContain("feedback persistence was claimed");
  });

  it("does not mark feedback-recorded claim when feedback tool evidence exists", async () => {
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-1",
          name: "feedback",
          input: { kind: "preference", field: "style", value: "concise" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "我已经记录了您的反馈。" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 7, outputTokens: 6 },
      ],
    ]);
    const feedbackSpy = vi.fn();

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createFeedbackTool(feedbackSpy)],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "记录偏好" });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    expect(feedbackSpy).toHaveBeenCalledTimes(1);
    expect(result.response).toContain("我已经记录了您的反馈");
    expect(result.response).not.toContain("feedback persistence was claimed");
  });

  it("retries explicit preference-setting tasks until feedback persistence evidence exists", async () => {
    const feedbackSpy = vi.fn();
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "Got it! I'll call you MemoryAuditName-123." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
      [
        {
          type: "tool_use",
          id: "call-1",
          name: "feedback",
          input: { kind: "preference", field: "user_name", value: "MemoryAuditName-123" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "Got it, I will use that name." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 9, outputTokens: 7 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createFeedbackTool(feedbackSpy)],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "Call me MemoryAuditName-123.",
    });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    expect(feedbackSpy).toHaveBeenCalledTimes(1);
    expect(result.response).toContain("use that name");
  });

  it("retries Chinese display-name setting tasks until feedback persistence evidence exists", async () => {
    const feedbackSpy = vi.fn();
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "好的 测试名，记住了。" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
      [
        {
          type: "tool_use",
          id: "call-1",
          name: "feedback",
          input: { kind: "preference", field: "user_name", value: "测试名" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "好的 测试名，我会使用这个称呼。" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 9, outputTokens: 7 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createFeedbackTool(feedbackSpy)],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "我的名字是 测试名，以后叫我 测试名。",
    });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    expect(feedbackSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "preference", field: "user_name", value: "测试名" }),
    );
    expect(result.response).toContain("测试名");
    expect(result.response).not.toContain("feedback persistence was claimed");
  });

  it("enforces tool evidence for desktop inspection tasks before concluding", async () => {
    const execSpy = vi.fn();
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "我无法直接查看您的桌面内容。" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
      [
        {
          type: "tool_use",
          id: "call-1",
          name: "exec",
          input: { command: "pwd" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "我已通过命令检查当前环境，并给出可验证结果。" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 9, outputTokens: 7 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createExecTool(execSpy)],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "在我的桌面上看一下 codex 回复是什么",
    });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(result.response).toContain("可验证结果");
  });

  it("retries preference recall tasks until memory_search evidence exists", async () => {
    const memorySearchSpy = vi.fn();
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "I do not know what to call you." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
      [
        {
          type: "tool_use",
          id: "call-1",
          name: "memory_search",
          input: { query: "what should i call you", namespace: "agent", limit: 1 },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "Captain Friday" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 9, outputTokens: 3 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createMemorySearchTool(memorySearchSpy)],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "Use memory_search if needed. What should you call me? Reply with only the name.",
    });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    expect(memorySearchSpy).toHaveBeenCalledTimes(1);
    expect(result.response).toContain("Captain Friday");
  });

  it("retries natural name-recall questions when the first answer claims the stored name is missing", async () => {
    const memorySearchSpy = vi.fn();
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "I don't have a specific name for you. Could you please tell me what you'd like to be called?" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
      [
        {
          type: "tool_use",
          id: "call-1",
          name: "memory_search",
          input: { query: "what should you call me", limit: 1 },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "Captain Friday" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 9, outputTokens: 3 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createMemorySearchTool(memorySearchSpy)],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "What should you call me? Reply with only the name.",
    });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    expect(memorySearchSpy).toHaveBeenCalledTimes(1);
    expect(result.response).toBe("Captain Friday");
  });

  it("retries Chinese name-recall questions until memory_search evidence exists", async () => {
    const memorySearchSpy = vi.fn();
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "我现在不知道你的名字。" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
      [
        {
          type: "tool_use",
          id: "call-1",
          name: "memory_search",
          input: { query: "我叫什么名字", limit: 1 },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "Captain Friday" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 9, outputTokens: 3 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createMemorySearchTool(memorySearchSpy)],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "我叫什么名字？只回答名字。",
    });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    expect(memorySearchSpy).toHaveBeenCalledTimes(1);
    expect(result.response).toBe("Captain Friday");
  });

  it("retries when memory_search found a stored name but the answer ignored it", async () => {
    const memorySearchSpy = vi.fn();
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-1",
          name: "memory_search",
          input: { query: "what should you call me", limit: 1 },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "I do not know what to call you." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
      [
        { type: "text_delta", text: "Captain Friday" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 7, outputTokens: 3 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createMemorySearchTool(memorySearchSpy)],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "What should you call me? Reply with only the name.",
    });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    expect(memorySearchSpy).toHaveBeenCalledTimes(1);
    expect(result.response).toBe("Captain Friday");
  });

  it("does not misclassify preference recall questions as feedback-persistence tasks", async () => {
    const memorySearchSpy = vi.fn();
    const feedbackSpy = vi.fn();
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-1",
          name: "memory_search",
          input: { query: "what should you call me", namespace: "user", limit: 1 },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "Captain Friday" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 9, outputTokens: 3 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createMemorySearchTool(memorySearchSpy), createFeedbackTool(feedbackSpy)],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "Use memory_search if needed. What should you call me? Reply with only the name.",
    });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    expect(memorySearchSpy).toHaveBeenCalledTimes(1);
    expect(feedbackSpy).not.toHaveBeenCalled();
    expect(result.response).toContain("Captain Friday");
  });

  it("does not delegate direct memory recall tasks to sub-agents", async () => {
    const memorySearchSpy = vi.fn();
    const delegationHandler = vi.fn(async () => ({
      delegated: true as const,
      subagentId: "sub-1",
      childRunId: "child-run-1",
      childSessionKey: "subagent:child-run-1",
      statusSnapshot: "completed" as const,
      outcome: {
        status: "completed" as const,
        response: "Delegated child completed successfully.",
        toolCallCount: 0,
        durationMs: 100,
        usageInput: 12,
        usageOutput: 5,
      },
    }));
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-1",
          name: "memory_search",
          input: { query: "what should you call me", limit: 1 },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "Captain Friday" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 9, outputTokens: 3 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createMemorySearchTool(memorySearchSpy)],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      delegationHandler,
    });

    const result = await runtime.executeRun({
      task: "Use memory_search if needed. What should you call me? Reply with only the name.",
      sessionKey: "ui:memory:recall",
    });

    expect(result.status).toBe("completed");
    expect(delegationHandler).not.toHaveBeenCalled();
    expect(memorySearchSpy).toHaveBeenCalledTimes(1);
    expect(result.response).toBe("Captain Friday");
  });

  it("falls back to deterministic memory recall when the model returns an empty direct-name answer", async () => {
    const memorySearchSpy = vi.fn();
    const llmClient = createMockLlmClient([
      [
        { type: "message_end", stopReason: "end_turn", inputTokens: 0, outputTokens: 0 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createMemorySearchTool(memorySearchSpy)],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "Use memory_search if needed. What should you call me? Reply with only the name.",
    });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    expect(memorySearchSpy).toHaveBeenCalledTimes(1);
    expect(result.response).toBe("Captain Friday");
  });

  it("does not overwrite local conversation recall answers with unrelated memory fallback results", async () => {
    const memorySearchSpy = vi.fn();
    const unrelatedMemorySearchTool: FridayAgentToolDefinition = {
      name: "memory_search",
      description: "Mock unrelated memory search tool",
      parameters: {
        properties: {
          query: { type: "string" },
          namespace: { type: "string" },
          limit: { type: "number" },
        },
        required: ["query"],
      },
      async execute(args) {
        memorySearchSpy(args);
        return {
          content: JSON.stringify([
            {
              content: "涉及敏感操作时，用户可通过审批卡片操作或回复“批准 <编号>”/“拒绝 <编号>”。",
              score: 1.15,
              metadata: {
                id: "approval-memory",
                namespace: "tenant.default.channel.feishu.user.chat.shared",
                source: "session:channel:feishu:chat",
              },
            },
          ]),
        };
      },
    };
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "青杉-6184" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 3 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [unrelatedMemorySearchTool],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "刚刚那个暗号是什么？只回复暗号。",
    });

    expect(result.status).toBe("completed");
    expect(memorySearchSpy).not.toHaveBeenCalled();
    expect(result.response).toBe("青杉-6184");
  });

  it("fills missing memory-recall fields with field-specific fallback searches before answering", async () => {
    const memorySearchSpy = vi.fn();
    const combinedMemorySearchTool: FridayAgentToolDefinition = {
      name: "memory_search",
      description: "Mock multi-field memory search tool",
      parameters: {
        properties: {
          query: { type: "string" },
          namespace: { type: "string" },
          limit: { type: "number" },
        },
        required: ["query"],
      },
      async execute(args) {
        memorySearchSpy(args);
        const query = typeof args.query === "string" ? args.query : "";
        if (query === "codename and release-note style") {
          return {
            content: JSON.stringify([
              {
                content: "User prefers release notes with verdict first and exactly two short bullets.",
                score: 1.2,
                metadata: { id: "pref-1", namespace: "user" },
              },
            ]),
          };
        }
        if (query === "codename") {
          return {
            content: JSON.stringify([
              {
                content: "User's codename is cedar-bridge-42.",
                score: 1.1,
                metadata: { id: "code-1", namespace: "user" },
              },
            ]),
          };
        }
        if (query === "release-note style") {
          return {
            content: JSON.stringify([
              {
                content: "User prefers release notes with verdict first and exactly two short bullets.",
                score: 1.2,
                metadata: { id: "pref-1", namespace: "user" },
              },
            ]),
          };
        }
        return { content: "[]" };
      },
    };

    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-1",
          name: "memory_search",
          input: { query: "codename and release-note style", limit: 5 },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "You prefer release notes with verdict first and exactly two short bullets." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
      [
        { type: "message_end", stopReason: "end_turn", inputTokens: 1, outputTokens: 0 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [combinedMemorySearchTool],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "What is my codename and what release-note style do I prefer? Answer in one concise sentence.",
    });

    expect(result.status).toBe("completed");
    expect(memorySearchSpy).toHaveBeenCalledTimes(2);
    expect(memorySearchSpy.mock.calls[0]?.[0]).toMatchObject({ query: "codename and release-note style" });
    expect(memorySearchSpy.mock.calls[1]?.[0]).toMatchObject({ query: "codename", namespace: "user", limit: 1 });
    expect(result.response).toBe(
      "Your codename is cedar-bridge-42, and you prefer release notes with verdict first and exactly two short bullets.",
    );
  });

  it("blocks app-launch tool calls for desktop content inspection tasks and retries with read-only evidence", async () => {
    const systemSpy = vi.fn();
    const emitter = createFridayAgentEventEmitter();
    const toolEndEvents: Array<Record<string, unknown>> = [];
    emitter.on("agent.run.tool_end", (payload) => {
      toolEndEvents.push(payload as Record<string, unknown>);
    });
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-open",
          name: "system",
          input: { action: "open", appIdentifier: "codex app" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 5 },
      ],
      [
        {
          type: "tool_use",
          id: "call-snapshot",
          name: "system",
          input: { action: "snapshot" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "我目前只能确认桌面未连接，所以还看不到 Codex 回复。" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createSystemTool(systemSpy)],
      eventEmitter: emitter,
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "看一下我桌面上的codex app给我的回复是什么",
    });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(2);
    expect(systemSpy).toHaveBeenCalledTimes(1);
    expect(systemSpy.mock.calls[0]?.[0]).toMatchObject({ action: "snapshot" });
    expect(result.response).toContain("桌面未连接");
    expect(toolEndEvents[0]?.toolName).toBe("system");
    expect(toolEndEvents[0]?.isError).toBe(true);
    expect(String(toolEndEvents[0]?.summary ?? "")).toContain("inspect existing desktop/app content");
  });

  it("allows app-launch tool calls when the task explicitly asks to open the app", async () => {
    const systemSpy = vi.fn();
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-open",
          name: "system",
          input: { action: "open", appIdentifier: "codex app" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "已打开 Codex。" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 6, outputTokens: 4 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createSystemTool(systemSpy)],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "打开 codex app",
    });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    expect(systemSpy).toHaveBeenCalledTimes(1);
    expect(systemSpy.mock.calls[0]?.[0]).toMatchObject({ action: "open", appIdentifier: "codex app" });
    expect(result.response).toContain("已打开 Codex");
  });

  it("blocks mutating system tool calls at the canonical gate when no approval resolver is available", async () => {
    const systemSpy = vi.fn();
    const emitter = createFridayAgentEventEmitter();
    const toolEndEvents: Array<Record<string, unknown>> = [];
    emitter.on("agent.run.tool_end", (payload) => {
      toolEndEvents.push(payload as Record<string, unknown>);
    });
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-open",
          name: "system",
          input: { action: "open", appIdentifier: "codex app" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "需要用户确认后才能打开 Codex。" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 6, outputTokens: 4 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createSystemTool(systemSpy)],
      eventEmitter: emitter,
      idGenerator,
      nowIso: () => NOW,
      canonicalMutatingActionGate: true,
    });

    const result = await runtime.executeRun({
      task: "打开 codex app",
    });

    expect(result.status).toBe("completed");
    expect(systemSpy).not.toHaveBeenCalled();
    expect(toolEndEvents[0]?.isError).toBe(true);
    expect(toolEndEvents[0]?.routeId).toBe("agent.execute.tool.canonical_gate");
  });

  it("blocks approved mutating tool calls when canonical approval signing is not configured", async () => {
    const systemSpy = vi.fn();
    const resolver = vi.fn(async () => ({ approved: true, decidedByPrincipalId: "user-approver-1" }));
    const emitter = createFridayAgentEventEmitter();
    const toolEndEvents: Array<Record<string, unknown>> = [];
    emitter.on("agent.run.tool_end", (payload) => {
      toolEndEvents.push(payload as Record<string, unknown>);
    });
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-open",
          name: "system",
          input: { action: "open", appIdentifier: "codex app" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "没有签名密钥时不能执行系统 mutation。" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 6, outputTokens: 4 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createSystemTool(systemSpy)],
      eventEmitter: emitter,
      idGenerator,
      nowIso: () => NOW,
      canonicalMutatingActionGate: true,
      toolApprovalResolver: resolver,
    });

    const result = await runtime.executeRun({
      task: "打开 codex app",
    });

    expect(result.status).toBe("completed");
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({
      canonicalAction: "system.open",
      canonicalActionDigest: expect.any(String),
    }));
    expect(systemSpy).not.toHaveBeenCalled();
    expect(toolEndEvents[0]?.isError).toBe(true);
    expect(toolEndEvents[0]?.routeId).toBe("agent.execute.tool.canonical_gate");
  });

  it("injects a digest-bound canonical approval for approved mutating system tool calls", async () => {
    const systemSpy = vi.fn();
    const resolver = vi.fn(async () => ({ approved: true, decidedByPrincipalId: "user-approver-1" }));
    const emitter = createFridayAgentEventEmitter();
    const toolStartEvents: Array<Record<string, unknown>> = [];
    emitter.on("agent.run.tool_start", (payload) => {
      toolStartEvents.push(payload as Record<string, unknown>);
    });
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-open",
          name: "system",
          input: { action: "open", appIdentifier: "codex app" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "已打开 Codex。" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 6, outputTokens: 4 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createSystemTool(systemSpy)],
      eventEmitter: emitter,
      idGenerator,
      nowIso: () => NOW,
      canonicalMutatingActionGate: true,
      canonicalApprovalSecret: "test-canonical-secret", // pragma: allowlist secret
      toolApprovalResolver: resolver,
    });

    const result = await runtime.executeRun({
      task: "打开 codex app",
    });

    expect(result.status).toBe("completed");
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({
      canonicalAction: "system.open",
      canonicalActionDigest: expect.any(String),
      canonicalMutating: true,
      canonicalRisk: "medium",
    }));
    expect(systemSpy).toHaveBeenCalledWith(expect.objectContaining({
      action: "open",
      canonicalActorId: "agent-runtime",
      canonicalActorKind: "agent",
      idempotencyKey: "test-id-0001:call-open",
      canonicalApproval: expect.objectContaining({
        decision: "approved",
        decidedByPrincipalId: "user-approver-1",
        actionDigest: expect.any(String),
        issuer: "friday_canonical_gate",
        signature: expect.any(String),
      }),
    }));
    expect(toolStartEvents.at(-1)?.params).toMatchObject({
      canonicalApproval: {
        redacted: true,
        decision: "approved",
        actionDigest: expect.any(String),
        issuer: "friday_canonical_gate",
      },
    });
    expect(JSON.stringify(toolStartEvents)).not.toContain("signature");
  });

  it("executes an approved system tool call through the real system service canonical gate", async () => {
    const resolver = vi.fn(async () => ({ approved: true, decidedByPrincipalId: "user-approver-1" }));
    const launchApp = vi.fn(async (appIdentifier: string) => ({
      appIdentifier,
      launchedAt: NOW,
    }));
    const systemService = await createFridaySystemService({
      db,
      idGenerator,
      nowIso: () => NOW,
      workspaceRoot: process.cwd(),
      companionBridge: createConnectedSystemCompanionBridge(launchApp),
      execCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      canonicalMutationGate: true,
      canonicalApprovalSecret: "test-canonical-secret", // pragma: allowlist secret
      companionReconnectIntervalMs: 60_000,
      warn: vi.fn(),
    });
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-launch",
          name: "system",
          input: {
            action: "launch_app",
            appIdentifier: "Codex",
            actorId: "model-supplied-actor",
            actorKind: "remote",
            approvalId: "model-supplied-approval",
            riskLevel: "critical",
          },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "System launch completed." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 6, outputTokens: 4 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createFridayAgentSystemTool({ systemService })],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      canonicalMutatingActionGate: true,
      canonicalApprovalSecret: "test-canonical-secret", // pragma: allowlist secret
      toolApprovalResolver: resolver,
    });

    const result = await runtime.executeRun({
      task: "打开 Codex app",
    });

    expect(result.status).toBe("completed");
    expect(result.response).toContain("System launch completed");
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({
      canonicalAction: "system.launch_app",
      canonicalActionDigest: expect.any(String),
    }));
    expect(launchApp).toHaveBeenCalledWith("Codex");
  });

  it("blocks file-search tool calls for desktop content inspection tasks and retries with snapshot evidence", async () => {
    const systemSpy = vi.fn();
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-search",
          name: "system",
          input: { action: "search_file", query: "codex app" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 5 },
      ],
      [
        {
          type: "tool_use",
          id: "call-snapshot",
          name: "system",
          input: { action: "snapshot" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "我目前只能确认桌面不可用，所以还看不到 Codex 回复。" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
    ]);

    const emitter = createFridayAgentEventEmitter();
    const toolEndEvents: Array<Record<string, unknown>> = [];
    emitter.on("agent.run.tool_end", (payload) => {
      toolEndEvents.push(payload as Record<string, unknown>);
    });

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createSystemTool(systemSpy)],
      eventEmitter: emitter,
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "看一下我桌面上的codex app给我的回复是什么",
    });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(2);
    expect(systemSpy).toHaveBeenCalledTimes(1);
    expect(systemSpy.mock.calls[0]?.[0]).toMatchObject({ action: "snapshot" });
    expect(result.response).toContain("桌面不可用");
    expect(toolEndEvents[0]?.isError).toBe(true);
    expect(String(toolEndEvents[0]?.summary ?? "")).toContain("not to mutate the desktop");
  });

  it("re-prompts desktop content inspection answers that only list environment status without a visibility verdict", async () => {
    const systemSpy = vi.fn();
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-snapshot",
          name: "system",
          input: { action: "snapshot" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "系统快照已成功捕获。当前前台应用是 Codex，处于安全模式。" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
      [
        { type: "text_delta", text: "我现在只能确认 Codex 在前台运行，但还没有看到你要的回复内容；当前快照也提示桌面不可用/安全模式，所以内容暂时无法验证。" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createSystemTool(systemSpy)],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "看一下我桌面上的codex app给我的回复是什么",
    });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    expect(systemSpy).toHaveBeenCalledTimes(1);
    expect(result.response).toContain("没有看到你要的回复内容");
    expect(result.response).toContain("无法验证");
  });

  it("retries desktop evidence path when prior desktop tools all failed", async () => {
    const execSpy = vi.fn();
    const desktopSpy = vi.fn();
    const llmClient = createMockLlmClient([
      [
        { type: "tool_use", id: "call-desktop", name: "desktop", input: { action: "session_info" } },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "我无法继续查看桌面了。" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 7, outputTokens: 4 },
      ],
      [
        { type: "tool_use", id: "call-exec", name: "exec", input: { command: "pwd" } },
        { type: "message_end", stopReason: "tool_use", inputTokens: 9, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "我已补充执行检查并给出可验证结果。" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 6, outputTokens: 4 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [
        createFailingDesktopTool("Desktop session is not connected.", desktopSpy),
        createExecTool(execSpy),
      ],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "在我的桌面上看一下 codex 回复是什么",
    });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(2);
    expect(desktopSpy).toHaveBeenCalledTimes(1);
    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(result.response).toContain("可验证结果");
  });

  it("fails run when screenshot artifact route has no deliverable image", async () => {
    const browserTool: FridayAgentToolDefinition = {
      name: "browser",
      description: "Browser tool with failing screenshot",
      parameters: {
        properties: {
          action: { type: "string" },
          url: { type: "string" },
          sessionId: { type: "string" },
        },
        required: ["action"],
      },
      async execute(args) {
        const action = typeof args.action === "string" ? args.action : "";
        if (action === "open") {
          return {
            content: JSON.stringify({
              sessionId: "default",
              tabId: "tab-1",
              url: "https://example.com",
            }),
          };
        }
        if (action === "screenshot") {
          return {
            content: "browserType.launch: Executable doesn't exist at /missing/chromium",
            isError: true,
          };
        }
        return { content: "unsupported browser action", isError: true };
      },
    };

    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-open",
          name: "browser",
          input: { action: "open", url: "https://example.com" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 6 },
      ],
      [
        {
          type: "tool_use",
          id: "call-shot",
          name: "browser",
          input: { action: "screenshot", sessionId: "default" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 12, outputTokens: 7 },
      ],
      [
        { type: "text_delta", text: "Screenshot captured and attached." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 5 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [browserTool],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "Open example.com and take a screenshot",
    });

    expect(result.status).toBe("failed");
    expect(result.toolCallCount).toBe(2);
    expect(result.response).toContain("Output delivery failed");
    expect(result.response).toContain("AGENT_OUTPUT_CLOSURE_ERROR");

    const repo = createFridayAgentRunRepository();
    const run = db.withReadConnection((reader) => repo.getById(reader, result.runId));
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("AGENT_OUTPUT_CLOSURE_ERROR");
  });

  // ─── Run with tool use ───

  it("executes tool calls and re-prompts LLM", async () => {
    const llmClient = createMockLlmClient([
      // First LLM response: tool_use
      [
        { type: "tool_use", id: "call-1", name: "echo", input: { message: "ping" } },
        { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 },
      ],
      // Second LLM response: text only
      [
        { type: "text_delta", text: "Got echo response" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 20, outputTokens: 10 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createEchoTool()],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "Use the echo tool" });

    expect(result.status).toBe("completed");
    expect(result.response).toBe("Got echo response");
    expect(result.toolCallCount).toBe(1);
    expect(result.usageInput).toBe(30);
    expect(result.usageOutput).toBe(15);
  });

  it("recovers text-encoded tool call JSON and executes it", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "{\"name\":\"echo\",\"arguments\":{\"message\":\"ping\"}}" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 6, outputTokens: 4 },
      ],
      [
        { type: "text_delta", text: "Recovered tool call and finished." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 5 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createEchoTool()],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "Say hello" });

    expect(result.status).toBe("completed");
    expect(result.response).toBe("Recovered tool call and finished.");
    expect(result.toolCallCount).toBe(1);
    expect(result.usageInput).toBe(14);
    expect(result.usageOutput).toBe(9);
  });

  it("recovers tool call JSON from fenced code blocks embedded in prose", async () => {
    const llmClient = createMockLlmClient([
      [
        {
          type: "text_delta",
          text:
            "There might be a channel issue. Try this:\n```json\n" +
            "[{\"type\":\"tool_use\",\"id\":\"t-1\",\"name\":\"echo\",\"input\":{\"message\":\"ping\"}}]\n" +
            "```",
        },
        { type: "message_end", stopReason: "end_turn", inputTokens: 11, outputTokens: 7 },
      ],
      [
        { type: "text_delta", text: "Done after executing the tool." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 9, outputTokens: 6 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createEchoTool()],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "Say hello" });

    expect(result.status).toBe("completed");
    expect(result.response).toBe("Done after executing the tool.");
    expect(result.toolCallCount).toBe(1);
    expect(result.usageInput).toBe(20);
    expect(result.usageOutput).toBe(13);
  });

  // ─── Run persists to database ───

  it("creates and updates run record in database", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "Done" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 3 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "Test persistence" });

    const repo = createFridayAgentRunRepository();
    const run = db.withReadConnection((reader) => repo.getById(reader, result.runId));

    expect(run).not.toBeNull();
    expect(run?.status).toBe("completed");
    expect(run?.task).toBe("Test persistence");
    expect(run?.model).toBe("test-model");
    expect(run?.providerId).toBe("test-provider");
  });

  // ─── Run handles LLM error ───

  it("handles LLM errors gracefully by degrading instead of crashing", async () => {
    const llmClient: FridayAgentLlmClient = {
      async *stream() {
        throw new Error("LLM request failed");
      },
    };

    const emitter = createFridayAgentEventEmitter();
    const degradedEvents: unknown[] = [];
    emitter.on("agent.run.degraded", (p) => degradedEvents.push(p));
    const modeChangedEvents: unknown[] = [];
    emitter.on("agent.run.mode_changed", (p) => modeChangedEvents.push(p));

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: emitter,
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "Should degrade gracefully" });

    // First LLM failure now degrades to a failed run with synthetic response
    expect(result.status).toBe("failed");
    expect(result.response).toContain("connection");
    expect(degradedEvents.length).toBeGreaterThanOrEqual(1);
    expect(modeChangedEvents.length).toBeGreaterThanOrEqual(1);
  });

  // ─── Emits events ───

  it("emits started and completed events", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "Ok" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 1, outputTokens: 1 },
      ],
    ]);

    const emitter = createFridayAgentEventEmitter();
    const events: Array<{ event: string; payload: unknown }> = [];
    emitter.on("agent.run.started", (p) => events.push({ event: "started", payload: p }));
    emitter.on("agent.run.completed", (p) => events.push({ event: "completed", payload: p }));

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: emitter,
      idGenerator,
      nowIso: () => NOW,
    });

    await runtime.executeRun({ task: "Event test" });

    expect(events).toHaveLength(2);
    expect(events[0].event).toBe("started");
    expect(events[1].event).toBe("completed");
  });

  it("emits progress events with phase, active tool, and ETA metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    try {
      const llmClient = createMockLlmClient([
        [
          { type: "tool_use", id: "call-1", name: "echo", input: { message: "hello" } },
          { type: "message_end", stopReason: "tool_use", inputTokens: 5, outputTokens: 3 },
        ],
        [
          { type: "text_delta", text: "done" },
          { type: "message_end", stopReason: "end_turn", inputTokens: 7, outputTokens: 4 },
        ],
      ]);

      const emitter = createFridayAgentEventEmitter();
      const progressEvents: Array<{
        phase: string;
        activeTool?: string;
        subagentCount: number;
        etaConfidence: string;
      }> = [];
      emitter.on("agent.run.progress", (payload) => {
        progressEvents.push({
          phase: payload.phase,
          activeTool: payload.activeTool,
          subagentCount: payload.subagentCount,
          etaConfidence: payload.etaConfidence,
        });
      });

      const runtime = createFridayAgentRuntime({
        db,
        llmClient,
        model: "test-model",
        providerId: "test-provider",
        systemPrompt: "You are a test agent.",
        tools: [createEchoTool()],
        eventEmitter: emitter,
        idGenerator,
        nowIso: () => NOW,
      });

      await runtime.executeRun({ task: "Progress test" });

      expect(progressEvents.length).toBeGreaterThan(0);
      expect(progressEvents.some((event) => event.phase === "executing")).toBe(true);
      expect(progressEvents.some((event) => event.activeTool === "echo")).toBe(true);
      expect(progressEvents.at(-1)?.phase).toBe("completed");
      expect(progressEvents.every((event) => event.subagentCount === 0)).toBe(true);
      expect(progressEvents.every((event) => event.etaConfidence === "low" || event.etaConfidence === "unavailable")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a delegated parent run as executing while the child is still in flight", async () => {
    const eventEmitter = createFridayAgentEventEmitter();
    const repo = createFridayAgentRunRepository();
    let resolveDelegation: ((value: {
      delegated: true;
      subagentId: string;
      childRunId: string;
      childSessionKey: string;
      statusSnapshot: "completed";
      outcome: {
        status: "completed";
        response: string;
        toolCallCount: number;
        durationMs: number;
        usageInput: number;
        usageOutput: number;
      };
    }) => void) | null = null;
    const delegationPromise = new Promise<{
      delegated: true;
      subagentId: string;
      childRunId: string;
      childSessionKey: string;
      statusSnapshot: "completed";
      outcome: {
        status: "completed";
        response: string;
        toolCallCount: number;
        durationMs: number;
        usageInput: number;
        usageOutput: number;
      };
    }>((resolve) => {
      resolveDelegation = resolve;
    });

    const runtime = createFridayAgentRuntime({
      db,
      llmClient: createMockLlmClient([]),
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createEchoTool()],
      eventEmitter,
      idGenerator,
      nowIso: () => NOW,
      delegationHandler: () => delegationPromise,
    });

    const runPromise = runtime.executeRun({
      task: "Review the repository state and tell me the next action.",
      sessionKey: "ui:delegation:test",
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const inFlight = db.withReadConnection((reader) => repo.getById(reader, "test-id-0001"));
    expect(inFlight?.status).toBe("executing");

    resolveDelegation?.({
      delegated: true,
      subagentId: "sub-1",
      childRunId: "child-1",
      childSessionKey: "subagent:child-1",
      statusSnapshot: "completed",
      outcome: {
        status: "completed",
        response: "Delegated child done",
        toolCallCount: 0,
        durationMs: 50,
        usageInput: 0,
        usageOutput: 0,
      },
    });

    const result = await runPromise;
    expect(result.status).toBe("completed");
  });

  it("passes public isolated disabled tools into delegated sub-agent requests", async () => {
    const delegationHandler = vi.fn(async () => ({
      delegated: true as const,
      subagentId: "sub-public-1",
      childRunId: "child-public-1",
      childSessionKey: "subagent:child-public-1",
      statusSnapshot: "completed" as const,
      outcome: {
        status: "completed" as const,
        response: "Delegated child done",
        toolCallCount: 0,
        durationMs: 50,
        usageInput: 0,
        usageOutput: 0,
      },
    }));

    const runtime = createFridayAgentRuntime({
      db,
      llmClient: createMockLlmClient([]),
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createEchoTool()],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      delegationHandler,
    });

    await runtime.executeRun({
      task: "Review and analyze the repository state before reporting the next action.",
      sessionKey: "ui:delegation:public",
      constraints: {
        readOnly: true,
        operationalMode: "restricted",
        dataSensitivity: "public",
      },
      disabledToolNames: [
        "read",
        "write",
        "edit",
        "exec",
        "pdf_parse",
        "image_analysis",
        "memory_search",
        "memory_query",
        "memory_get",
        "memory_store",
        "memory_extract",
        "feedback",
      ],
    });

    expect(delegationHandler).toHaveBeenCalledWith(expect.objectContaining({
      constraints: expect.objectContaining({
        readOnly: true,
        operationalMode: "restricted",
        dataSensitivity: "public",
      }),
      disabledToolNames: [
        "read",
        "write",
        "edit",
        "exec",
        "pdf_parse",
        "image_analysis",
        "memory_search",
        "memory_query",
        "memory_get",
        "memory_store",
        "memory_extract",
        "feedback",
      ],
      principalId: undefined,
      tenantContext: undefined,
    }));
  });

  it("uses the delegated child error message for failed parent-run events", async () => {
    const eventEmitter = createFridayAgentEventEmitter();
    const repo = createFridayAgentRunRepository();
    const failedEvents: Array<{ message: string; code: string }> = [];
    let resolveDelegation: ((value: {
      delegated: true;
      subagentId: string;
      childRunId: string;
      childSessionKey: string;
      statusSnapshot: "failed";
      outcome: {
        status: "failed";
        response: string;
        toolCallCount: number;
        durationMs: number;
        usageInput: number;
        usageOutput: number;
      };
    }) => void) | null = null;
    const delegationPromise = new Promise<{
      delegated: true;
      subagentId: string;
      childRunId: string;
      childSessionKey: string;
      statusSnapshot: "failed";
      outcome: {
        status: "failed";
        response: string;
        toolCallCount: number;
        durationMs: number;
        usageInput: number;
        usageOutput: number;
      };
    }>((resolve) => {
      resolveDelegation = resolve;
    });

    eventEmitter.on("agent.run.failed", (payload) => {
      failedEvents.push({
        message: payload.error.message,
        code: payload.error.code,
      });
    });

    const runtime = createFridayAgentRuntime({
      db,
      llmClient: createMockLlmClient([]),
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createEchoTool()],
      eventEmitter,
      idGenerator,
      nowIso: () => NOW,
      delegationHandler: () => delegationPromise,
    });

    const runPromise = runtime.executeRun({
      task: "Review the repository state and tell me the next action.",
      sessionKey: "ui:delegation:test-failed",
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    db.withWriteTransaction((writer) => {
      repo.create(writer, {
        id: "child-1",
        task: "Delegated child task",
        sessionKey: "subagent:child-1",
        maxAttempts: 1,
        nowIso: NOW,
      });
      repo.update(writer, {
        id: "child-1",
        status: "failed",
        completedAt: NOW,
        durationMs: 50,
        errorCode: "AGENT_LLM_ERROR",
        errorMessage: "Child execution failed after verification.",
        responseText: "Successfully saved the report.",
        summary: "Successfully saved the report.",
      });
    });

    resolveDelegation?.({
      delegated: true,
      subagentId: "sub-1",
      childRunId: "child-1",
      childSessionKey: "subagent:child-1",
      statusSnapshot: "failed",
      outcome: {
        status: "failed",
        response: "Successfully saved the report.",
        toolCallCount: 0,
        durationMs: 50,
        usageInput: 0,
        usageOutput: 0,
      },
    });

    const result = await runPromise;
    expect(result.status).toBe("failed");
    expect(result.response).toBe("Child execution failed after verification.");
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]).toEqual({
      message: "Child execution failed after verification.",
      code: "AGENT_LLM_ERROR",
    });
  });

  // ─── Unknown tool ───

  it("returns error for unknown tool calls", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "tool_use", id: "call-1", name: "nonexistent", input: {} },
        { type: "message_end", stopReason: "tool_use", inputTokens: 5, outputTokens: 3 },
      ],
      [
        { type: "text_delta", text: "Handled error" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 10, outputTokens: 5 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "Unknown tool test" });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
  });

  it("returns explicit enablement hint when desktop tool is unavailable", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "tool_use", id: "call-1", name: "desktop", input: { action: "session_info" } },
        { type: "message_end", stopReason: "tool_use", inputTokens: 5, outputTokens: 3 },
      ],
      [
        { type: "text_delta", text: "Desktop unavailable." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 10, outputTokens: 5 },
      ],
    ]);

    const emitter = createFridayAgentEventEmitter();
    const toolEndEvents: Array<Record<string, unknown>> = [];
    emitter.on("agent.run.tool_end", (payload) => {
      toolEndEvents.push(payload as Record<string, unknown>);
    });

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: emitter,
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "desktop unavailable test" });

    expect(result.status).toBe("failed");
    expect(result.toolCallCount).toBe(1);
    expect(result.response).toContain("AGENT_OUTPUT_CLOSURE_ERROR");
    expect(toolEndEvents).toHaveLength(1);
    expect(toolEndEvents[0]?.toolName).toBe("desktop");
    expect(toolEndEvents[0]?.errorCode).toBe("AGENT_TOOL_ERROR");
    expect(String(toolEndEvents[0]?.summary ?? "")).toContain("FRIDAY_DESKTOP_ENABLED=true");
  });

  it("does not force extra evidence retry when desktop runtime is unavailable", async () => {
    let llmCalls = 0;
    const llmClient: FridayAgentLlmClient = {
      async *stream() {
        llmCalls += 1;
        if (llmCalls === 1) {
          yield { type: "tool_use", id: "call-1", name: "desktop", input: { action: "session_info" } };
          yield { type: "message_end", stopReason: "tool_use", inputTokens: 5, outputTokens: 3 };
          return;
        }
        if (llmCalls === 2) {
          yield {
            type: "text_delta",
            text: "Desktop runtime is not enabled. Set FRIDAY_DESKTOP_ENABLED=true and restart Friday.",
          };
          yield { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 5 };
          return;
        }
        throw new Error(`Unexpected extra LLM call ${String(llmCalls)}`);
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createExecTool()],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "Check desktop session info" });

    expect(llmCalls).toBe(2);
    expect(result.status).toBe("failed");
    expect(result.response).toContain("FRIDAY_DESKTOP_ENABLED=true");
    expect(result.response).toContain("AGENT_OUTPUT_CLOSURE_ERROR");
  });

  it("forces one retry through skills_list when an installed starter skill strongly matches the request", async () => {
    let llmCalls = 0;
    const skillsListExecute = vi.fn(async () => ({
      content: JSON.stringify({
        count: 1,
        skills: [
          {
            skillId: "workspace-diff-review",
            ready: true,
            blockers: [],
          },
        ],
      }),
    }));
    const llmClient: FridayAgentLlmClient = {
      async *stream() {
        llmCalls += 1;
        if (llmCalls === 1) {
          yield { type: "text_delta", text: "I reviewed the diff and it looks fine." };
          yield { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 4 };
          return;
        }
        if (llmCalls === 2) {
          yield { type: "tool_use", id: "call-1", name: "skills_list", input: { q: "review this diff", installedOnly: true } };
          yield { type: "message_end", stopReason: "tool_use", inputTokens: 6, outputTokens: 3 };
          return;
        }
        if (llmCalls === 3) {
          yield { type: "text_delta", text: "The installed starter skill workspace-diff-review matches this request." };
          yield { type: "message_end", stopReason: "end_turn", inputTokens: 7, outputTokens: 4 };
          return;
        }
        throw new Error(`Unexpected extra LLM call ${String(llmCalls)}`);
      },
    };
    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [
        {
          name: "skills_list",
          description: "List skills",
          parameters: {
            properties: {
              q: { type: "string" },
              installedOnly: { type: "boolean" },
            },
          },
          execute: skillsListExecute,
        },
      ],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      starterSkillRouting: {
        enabled: true,
        skills: [
          {
            skillId: "workspace-diff-review",
            purpose: "Review risky workspace changes",
            triggerPhrases: ["review this diff"],
            intents: ["workspace_diff_review"],
            tags: ["starter", "starter.devops"],
          },
        ],
      },
    });

    const result = await runtime.executeRun({ task: "Please review this diff before I land it." });

    expect(result.status).toBe("completed");
    expect(result.response).toContain("workspace-diff-review");
    expect(result.toolCallCount).toBe(1);
    expect(llmCalls).toBe(3);
    expect(skillsListExecute).toHaveBeenCalledTimes(1);
  });

  it("returns explicit enablement hint when mcp tool is unavailable", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "tool_use", id: "call-1", name: "mcp", input: { action: "list_servers" } },
        { type: "message_end", stopReason: "tool_use", inputTokens: 5, outputTokens: 3 },
      ],
      [
        { type: "text_delta", text: "MCP unavailable." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 10, outputTokens: 5 },
      ],
    ]);

    const emitter = createFridayAgentEventEmitter();
    const toolEndEvents: Array<Record<string, unknown>> = [];
    emitter.on("agent.run.tool_end", (payload) => {
      toolEndEvents.push(payload as Record<string, unknown>);
    });

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: emitter,
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "mcp unavailable test" });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    expect(toolEndEvents).toHaveLength(1);
    expect(toolEndEvents[0]?.toolName).toBe("mcp");
    expect(toolEndEvents[0]?.errorCode).toBe("AGENT_TOOL_ERROR");
    expect(String(toolEndEvents[0]?.summary ?? "")).toContain("FRIDAY_MCP_SERVERS");
  });

  it("auto-recovers desktop inspect_element missing selector params via screenshot fallback", async () => {
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-1",
          name: "desktop",
          input: { action: "inspect_element", actionType: "read_element" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 4 },
      ],
      [
        { type: "text_delta", text: "桌面检查完成。" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 9, outputTokens: 5 },
      ],
    ]);

    const desktopSpy = vi.fn();
    const emitter = createFridayAgentEventEmitter();
    const toolEndEvents: Array<Record<string, unknown>> = [];
    emitter.on("agent.run.tool_end", (payload) => {
      toolEndEvents.push(payload as Record<string, unknown>);
    });

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createDesktopRecoveryTool(desktopSpy)],
      eventEmitter: emitter,
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "在我的桌面上看一下 codex 回复是什么" });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    expect(result.response).toContain("桌面检查完成");
    expect(result.response).not.toContain("unverified");
    expect(desktopSpy).toHaveBeenCalledTimes(2);
    expect(desktopSpy.mock.calls[0]?.[0]).toMatchObject({ action: "inspect_element" });
    expect(desktopSpy.mock.calls[1]?.[0]).toMatchObject({ action: "screenshot" });

    const primaryToolEnd = toolEndEvents.find((event) => event.toolCallId === "call-1");
    const recoveryToolEnd = toolEndEvents.find((event) => event.toolCallId === "call-1:input-recovery");
    expect(primaryToolEnd).toBeDefined();
    expect(recoveryToolEnd).toBeDefined();
    expect(primaryToolEnd?.isError).toBe(false);
    expect(recoveryToolEnd?.isError).toBe(false);
  });

  it("auto-recovers desktop inspect_element Chinese strategy error via screenshot fallback", async () => {
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-1",
          name: "desktop",
          input: { action: "inspect_element" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 4 },
      ],
      [
        { type: "text_delta", text: "桌面检查完成。" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 9, outputTokens: 5 },
      ],
    ]);

    const desktopSpy = vi.fn();
    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createDesktopRecoveryTool(desktopSpy, { inspectElementErrorMessage: "需要指定策略" })],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "在我的桌面上看一下 codex 回复是什么" });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    expect(result.response).toContain("桌面检查完成");
    expect(desktopSpy).toHaveBeenCalledTimes(2);
    expect(desktopSpy.mock.calls[0]?.[0]).toMatchObject({ action: "inspect_element" });
    expect(desktopSpy.mock.calls[1]?.[0]).toMatchObject({ action: "screenshot" });
  });

  it("auto-recovers desktop execute click selector error via screenshot fallback", async () => {
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-1",
          name: "desktop",
          input: { action: "execute", actionType: "click" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 4 },
      ],
      [
        { type: "text_delta", text: "桌面检查完成。" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 9, outputTokens: 5 },
      ],
    ]);

    const desktopSpy = vi.fn();
    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createDesktopRecoveryTool(desktopSpy)],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "在我的桌面上看一下 codex 回复是什么" });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    expect(result.response).toContain("桌面检查完成");
    expect(desktopSpy).toHaveBeenCalledTimes(2);
    expect(desktopSpy.mock.calls[0]?.[0]).toMatchObject({ action: "execute", actionType: "click" });
    expect(desktopSpy.mock.calls[1]?.[0]).toMatchObject({ action: "screenshot" });
  });

  it("auto-recovers browser act missing target via snapshot fallback", async () => {
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-1",
          name: "browser",
          input: { action: "act", act: "click", sessionId: "default", tabId: "tab-1" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 4 },
      ],
      [
        { type: "text_delta", text: "已完成页面检查。" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 9, outputTokens: 5 },
      ],
    ]);

    const browserSpy = vi.fn();
    const emitter = createFridayAgentEventEmitter();
    const toolEndEvents: Array<Record<string, unknown>> = [];
    emitter.on("agent.run.tool_end", (payload) => {
      toolEndEvents.push(payload as Record<string, unknown>);
    });

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createBrowserRecoveryTool(browserSpy)],
      eventEmitter: emitter,
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "请点击页面上的按钮" });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    expect(browserSpy).toHaveBeenCalledTimes(2);
    expect(browserSpy.mock.calls[0]?.[0]).toMatchObject({ action: "act" });
    expect(browserSpy.mock.calls[1]?.[0]).toMatchObject({ action: "snapshot", sessionId: "default", tabId: "tab-1" });
    const primaryToolEnd = toolEndEvents.find((event) => event.toolCallId === "call-1");
    expect(primaryToolEnd?.isError).toBe(false);
  });

  it("auto-recovers mcp missing action via list_servers fallback", async () => {
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-1",
          name: "mcp",
          input: {},
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 4 },
      ],
      [
        { type: "text_delta", text: "MCP 信息已返回。" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 9, outputTokens: 5 },
      ],
    ]);

    const mcpSpy = vi.fn();
    const emitter = createFridayAgentEventEmitter();
    const toolEndEvents: Array<Record<string, unknown>> = [];
    emitter.on("agent.run.tool_end", (payload) => {
      toolEndEvents.push(payload as Record<string, unknown>);
    });

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [createMcpRecoveryTool(mcpSpy)],
      eventEmitter: emitter,
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "查看 MCP 服务列表" });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    expect(mcpSpy).toHaveBeenCalledTimes(2);
    expect(mcpSpy.mock.calls[0]?.[0]).toEqual({});
    expect(mcpSpy.mock.calls[1]?.[0]).toMatchObject({ action: "list_servers" });
    const primaryToolEnd = toolEndEvents.find((event) => event.toolCallId === "call-1");
    expect(primaryToolEnd?.isError).toBe(false);
  });

  // ─── Tool error handling ───

  it("handles tool execution errors", async () => {
    const failingTool: FridayAgentToolDefinition = {
      name: "failing",
      description: "Always fails",
      parameters: { properties: {} },
      async execute() {
        throw new Error("Tool exploded");
      },
    };

    const llmClient = createMockLlmClient([
      [
        { type: "tool_use", id: "call-1", name: "failing", input: {} },
        { type: "message_end", stopReason: "tool_use", inputTokens: 5, outputTokens: 3 },
      ],
      [
        { type: "text_delta", text: "Tool failed" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 10, outputTokens: 5 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [failingTool],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "Fail tool test" });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
  });

  it("honors per-tool timeout overrides for long-running tools", async () => {
    const slowTool: FridayAgentToolDefinition = {
      name: "slow_tool",
      description: "Blocks until the signal aborts",
      parameters: { properties: {} },
      timeoutMs: 10,
      async execute(_args, signal) {
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve({ content: "unexpected late success", isError: false });
          }, 50);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "aborted")));
          }, { once: true });
        });
      },
    };

    const llmClient = createMockLlmClient([
      [
        { type: "tool_use", id: "call-slow", name: "slow_tool", input: {} },
        { type: "message_end", stopReason: "tool_use", inputTokens: 5, outputTokens: 3 },
      ],
      [
        { type: "text_delta", text: "Tool timeout handled." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 10, outputTokens: 5 },
      ],
    ]);

    const emitter = createFridayAgentEventEmitter();
    const toolEndEvents: Array<Record<string, unknown>> = [];
    emitter.on("agent.run.tool_end", (payload) => {
      toolEndEvents.push(payload as Record<string, unknown>);
    });

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [slowTool],
      eventEmitter: emitter,
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "Use the slow tool once." });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    expect(String(toolEndEvents[0]?.summary ?? "")).toContain("Tool call timed out");
  });

  // ─── OC-007: Tool result size capping ───

  it("caps oversized tool result content", async () => {
    const hugeTool: FridayAgentToolDefinition = {
      name: "huge_output",
      description: "Returns oversized output",
      parameters: { properties: {} },
      async execute() {
        return { content: "x".repeat(100_000) };
      },
    };

    const llmClient = createMockLlmClient([
      [
        { type: "tool_use", id: "call-1", name: "huge_output", input: {} },
        { type: "message_end", stopReason: "tool_use", inputTokens: 5, outputTokens: 3 },
      ],
      [
        { type: "text_delta", text: "Done processing" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 3 },
      ],
    ]);

    const emitter = createFridayAgentEventEmitter();
    const toolEndEvents: Array<{ content: string }> = [];
    emitter.on("agent.run.tool_end", (p) => toolEndEvents.push({ content: p.summary ?? "" }));

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [hugeTool],
      eventEmitter: emitter,
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "Generate huge output" });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
  });

  it("does not truncate tool result under the cap", async () => {
    const normalTool: FridayAgentToolDefinition = {
      name: "normal_output",
      description: "Returns normal output",
      parameters: { properties: {} },
      async execute() {
        return { content: "short result" };
      },
    };

    const llmClient = createMockLlmClient([
      [
        { type: "tool_use", id: "call-1", name: "normal_output", input: {} },
        { type: "message_end", stopReason: "tool_use", inputTokens: 5, outputTokens: 3 },
      ],
      [
        { type: "text_delta", text: "Done" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 3 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [normalTool],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "Normal output test" });

    expect(result.status).toBe("completed");
    expect(result.response).toBe("Done");
  });

  // ─── IMPL-1: Plan review persisted before execution ───

  it("persists plan review JSON before execution", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "Done" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 3 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "Plan test" });

    const repo = createFridayAgentRunRepository();
    const run = db.withReadConnection((reader) => repo.getById(reader, result.runId));

    expect(run?.planReview).toBeDefined();
    expect(run?.planReview?.plan.task).toBe("Plan test");
    expect(run?.planReview?.decision?.approved).toBe(true);
  });

  // ─── IMPL-1: Review reject path ───

  it("review reject path returns failed run with review metadata", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "Should not reach" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 3 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      reviewGate: createFridayAgentReviewGate("auto-reject"),
    });

    const result = await runtime.executeRun({
      task: "Should be rejected",
      reviewRequired: true,
    });

    expect(result.status).toBe("failed");
    expect(result.response).toContain("rejected");

    const repo = createFridayAgentRunRepository();
    const run = db.withReadConnection((reader) => repo.getById(reader, result.runId));

    expect(run?.status).toBe("failed");
    expect(run?.planReview?.decision?.approved).toBe(false);
    expect(run?.planReview?.decision?.mode).toBe("auto-reject");
  });

  // ─── IMPL-3: executing events emitted and persisted ───

  it("emits agent.run.executing event per LLM iteration", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "tool_use", id: "call-1", name: "echo", input: { message: "hi" } },
        { type: "message_end", stopReason: "tool_use", inputTokens: 5, outputTokens: 3 },
      ],
      [
        { type: "text_delta", text: "Done" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 3 },
      ],
    ]);

    const emitter = createFridayAgentEventEmitter();
    const executingEvents: unknown[] = [];
    emitter.on("agent.run.executing", (p) => executingEvents.push(p));

    const eventRepo = createFridayAgentRunEventRepository();

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [createEchoTool()],
      eventEmitter: emitter,
      idGenerator,
      nowIso: () => NOW,
      runEventRepository: eventRepo,
    });

    const result = await runtime.executeRun({ task: "Executing events test" });

    // Should have 2 executing events (one per LLM iteration)
    expect(executingEvents).toHaveLength(2);

    // Check persisted events
    const events = db.withReadConnection((reader) =>
      eventRepo.list(reader, result.runId),
    );
    const executingPersistedEvents = events.filter((e) => e.eventName === "agent.run.executing");
    expect(executingPersistedEvents).toHaveLength(2);
    expect(executingPersistedEvents[0].payload).toHaveProperty("step", 1);
    expect(executingPersistedEvents[1].payload).toHaveProperty("step", 2);
  });

  // ─── IMPL-4: readOnly run blocks mutating tools ───

  it("readOnly run blocks mutating tools", async () => {
    const writeTool: FridayAgentToolDefinition = {
      name: "write",
      description: "Write file",
      parameters: { properties: { path: { type: "string" }, content: { type: "string" } } },
      async execute() {
        return { content: "Written" };
      },
    };

    const llmClient = createMockLlmClient([
      [
        { type: "tool_use", id: "call-1", name: "write", input: { path: "/tmp/x", content: "y" } },
        { type: "message_end", stopReason: "tool_use", inputTokens: 5, outputTokens: 3 },
      ],
      [
        { type: "text_delta", text: "Blocked" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 3 },
      ],
    ]);

    const emitter = createFridayAgentEventEmitter();
    const toolEndEvents: Array<{
      isError: boolean;
      summary?: string;
      errorCode?: string;
      routeId?: string;
      correlationId?: string;
    }> = [];
    emitter.on("agent.run.tool_end", (payload) => {
      toolEndEvents.push({
        isError: payload.isError,
        summary: payload.summary,
        errorCode: payload.errorCode,
        routeId: payload.routeId,
        correlationId: payload.correlationId,
      });
    });

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [writeTool],
      eventEmitter: emitter,
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "Try to write",
      constraints: { readOnly: true },
    });

    // Tool was blocked, not actually executed
    expect(result.toolCallCount).toBe(1);
    expect(toolEndEvents).toHaveLength(1);
    expect(toolEndEvents[0].isError).toBe(true);
    expect(toolEndEvents[0].summary).toContain("readOnly");
    expect(toolEndEvents[0].errorCode).toBe("AGENT_VALIDATION_ERROR");
    expect(toolEndEvents[0].routeId).toBe("agent.execute.tool.readonly");
    expect(toolEndEvents[0].correlationId).toBe(result.runId);
  });

  it("blocks stale writes when a tracked file changes after a read", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-agent-runtime-file-tracker-"));
    const filePath = join(tempDir, "tracked.txt");
    writeFileSync(filePath, "initial\n", "utf8");

    const writeSpy = vi.fn(async () => {
      writeFileSync(filePath, "agent-write\n", "utf8");
      return { content: "Written" };
    });

    let streamCallCount = 0;
    const llmClient: FridayAgentLlmClient = {
      async *stream() {
        streamCallCount += 1;
        if (streamCallCount === 1) {
          yield { type: "tool_use", id: "call-read", name: "read", input: { path: filePath } };
          yield { type: "message_end", stopReason: "tool_use", inputTokens: 5, outputTokens: 3 };
          return;
        }
        if (streamCallCount === 2) {
          writeFileSync(filePath, "external-change\n", "utf8");
          yield {
            type: "tool_use",
            id: "call-write",
            name: "write",
            input: { path: filePath, content: "agent-write\n" },
          };
          yield { type: "message_end", stopReason: "tool_use", inputTokens: 5, outputTokens: 3 };
          return;
        }
        yield { type: "text_delta", text: "Write blocked because the file changed." };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 3 };
      },
    };

    const readTool: FridayAgentToolDefinition = {
      name: "read",
      description: "Read file",
      parameters: {
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
      async execute(args) {
        const path = typeof args.path === "string" ? args.path : "";
        return { content: readFileSync(path, "utf8") };
      },
    };

    const writeTool: FridayAgentToolDefinition = {
      name: "write",
      description: "Write file",
      parameters: {
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
      execute: writeSpy,
    };

    const emitter = createFridayAgentEventEmitter();
    const toolEndEvents: Array<{
      toolName: string;
      isError: boolean;
      summary?: string;
      routeId?: string;
    }> = [];
    emitter.on("agent.run.tool_end", (payload) => {
      toolEndEvents.push({
        toolName: payload.toolName,
        isError: payload.isError,
        summary: payload.summary,
        routeId: payload.routeId,
      });
    });

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [readTool, writeTool],
      eventEmitter: emitter,
      idGenerator,
      nowIso: () => NOW,
    });

    try {
      const result = await runtime.executeRun({ task: "Read then write tracked file" });

      expect(result.toolCallCount).toBe(2);
      expect(writeSpy).not.toHaveBeenCalled();

      const blockedWriteEvent = toolEndEvents.find(
        (event) => event.toolName === "write" && event.isError,
      );
      expect(blockedWriteEvent).toBeDefined();
      expect(blockedWriteEvent?.routeId).toBe("agent.execute.tool.file_tracker");
      expect(blockedWriteEvent?.summary).toContain("changed since it was last observed");
      expect(readFileSync(filePath, "utf8")).toBe("external-change\n");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("blocks approval-gated mutating tools before execution", async () => {
    const execExecute = vi.fn(async () => ({ content: "deleted" }));
    const execTool: FridayAgentToolDefinition = {
      name: "exec",
      description: "Execute shell command",
      parameters: { properties: { command: { type: "string" } } },
      execute: execExecute,
    };

    const llmClient = createMockLlmClient([
      [
        { type: "tool_use", id: "call-1", name: "exec", input: { command: "rm database.dump" } },
        { type: "message_end", stopReason: "tool_use", inputTokens: 5, outputTokens: 3 },
      ],
      [
        { type: "text_delta", text: "Blocked for approval." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 4, outputTokens: 2 },
      ],
    ]);

    const emitter = createFridayAgentEventEmitter();
    const toolEndEvents: Array<{
      isError: boolean;
      summary?: string;
      errorCode?: string;
      routeId?: string;
      correlationId?: string;
    }> = [];
    emitter.on("agent.run.tool_end", (payload) => {
      toolEndEvents.push({
        isError: payload.isError,
        summary: payload.summary,
        errorCode: payload.errorCode,
        routeId: payload.routeId,
        correlationId: payload.correlationId,
      });
    });

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [execTool],
      eventEmitter: emitter,
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "Delete the dump now",
    });

    expect(result.toolCallCount).toBe(1);
    expect(execExecute).not.toHaveBeenCalled();
    expect(toolEndEvents).toHaveLength(1);
    expect(toolEndEvents[0].isError).toBe(true);
    expect(toolEndEvents[0].summary).toContain("approval");
    expect(toolEndEvents[0].routeId).toBe("agent.execute.tool.approval_required");
    expect(toolEndEvents[0].correlationId).toBe(result.runId);
  });

  it("cancels runs waiting on tool approval without hanging", async () => {
    const execExecute = vi.fn(async () => ({ content: "deleted" }));
    const execTool: FridayAgentToolDefinition = {
      name: "exec",
      description: "Execute shell command",
      parameters: { properties: { command: { type: "string" } } },
      execute: execExecute,
    };

    const llmClient = createMockLlmClient([
      [
        { type: "tool_use", id: "call-1", name: "exec", input: { command: "rm database.dump" } },
        { type: "message_end", stopReason: "tool_use", inputTokens: 5, outputTokens: 3 },
      ],
    ]);

    const emitter = createFridayAgentEventEmitter();
    const abortController = new AbortController();
    emitter.on("agent.run.awaiting_tool_approval", () => {
      abortController.abort(new Error("Cancelled while awaiting approval"));
    });

    const toolApprovalResolver = vi.fn(async () =>
      new Promise<{ approved: boolean; reason?: string }>(() => {
        // Intentionally left pending; cancellation should unblock the run.
      }));

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [execTool],
      eventEmitter: emitter,
      idGenerator,
      nowIso: () => NOW,
      toolApprovalResolver,
    });

    const result = await runtime.executeRun({
      task: "Delete the dump now",
      signal: abortController.signal,
    });

    expect(result.status).toBe("cancelled");
    expect(execExecute).not.toHaveBeenCalled();
    expect(toolApprovalResolver).toHaveBeenCalledTimes(1);
    expect(toolApprovalResolver).toHaveBeenCalledWith(expect.objectContaining({
      runId: expect.any(String),
      grantId: expect.stringMatching(/^capgrant:/),
      expiresAt: expect.any(String),
      toolName: "exec",
      toolCallId: "call-1",
    }));
  });

  it("persists cancelled status when the LLM stream aborts mid-run", async () => {
    const abortController = new AbortController();
    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        const pending = new Promise<never>((_, reject) => {
          params.signal.addEventListener("abort", () => {
            reject(
              params.signal.reason instanceof Error
                ? params.signal.reason
                : new Error(String(params.signal.reason ?? "aborted")),
            );
          }, { once: true });
        });
        queueMicrotask(() => abortController.abort(new Error("Cancelled via API")));
        await pending;
      },
    };
    const repo = createFridayAgentRunRepository();

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "Start and then cancel",
      signal: abortController.signal,
    });

    const run = db.withReadConnection((reader) => repo.getById(reader, result.runId));
    expect(result.status).toBe("cancelled");
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBeUndefined();
  });

  it("blocks provider mutations for informational guidance prompts before approval flow", async () => {
    const providerExecute = vi.fn(async () => ({ content: "provider updated" }));
    const providerTool: FridayAgentToolDefinition = {
      name: "provider",
      description: "Manage providers",
      parameters: {
        properties: {
          action: { type: "string" },
          providerId: { type: "string" },
          apiKey: { type: "string" },
        },
        required: ["action"],
      },
      execute: providerExecute,
    };

    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-1",
          name: "provider",
          input: {
            action: "update",
            providerId: "anthropic-live",
            apiKey: "$ANTHROPIC_API_KEY",
          },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 5, outputTokens: 3 },
      ],
      [
        { type: "text", text: "Open Settings, choose Providers, paste your Anthropic key, validate it, then save." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 6, outputTokens: 12 },
      ],
    ]);

    const emitter = createFridayAgentEventEmitter();
    const toolEndEvents: Array<{
      isError?: boolean;
      summary?: string;
      routeId?: string;
    }> = [];
    emitter.on("agent.run.tool_end", (payload) => {
      toolEndEvents.push({
        isError: payload.isError,
        summary: payload.summary,
        routeId: payload.routeId,
      });
    });

    const toolApprovalResolver = vi.fn(async () => ({ approved: true }));

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [providerTool],
      eventEmitter: emitter,
      idGenerator,
      nowIso: () => NOW,
      toolApprovalResolver,
    });

    const result = await runtime.executeRun({
      task: "How do I connect my Anthropic API key? Please guide me step by step.",
    });

    expect(providerExecute).not.toHaveBeenCalled();
    expect(toolApprovalResolver).not.toHaveBeenCalled();
    expect(toolEndEvents).toHaveLength(1);
    expect(toolEndEvents[0].isError).toBe(true);
    expect(toolEndEvents[0].routeId).toBe("agent.execute.tool.policy");
    expect(toolEndEvents[0].summary).toContain("denied by policy");
  });

  it("blocks tools listed in disabledToolNames", async () => {
    const browserExecute = vi.fn(async () => ({ content: "opened" }));
    const browserTool: FridayAgentToolDefinition = {
      name: "browser",
      description: "Browser tool",
      parameters: { properties: { action: { type: "string" } } },
      execute: browserExecute,
    };

    const llmClient = createMockLlmClient([
      [
        { type: "tool_use", id: "call-1", name: "browser", input: { action: "open", url: "https://www.google.com" } },
        { type: "message_end", stopReason: "tool_use", inputTokens: 5, outputTokens: 3 },
      ],
      [
        { type: "text_delta", text: "Please open this URL on your device: https://www.google.com" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 4, outputTokens: 2 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [browserTool],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "Open Google",
      disabledToolNames: ["browser"],
    });

    expect(result.status).toBe("failed");
    expect(result.response).toContain("AGENT_OUTPUT_CLOSURE_ERROR");
    expect(result.toolCallCount).toBe(1);
    expect(browserExecute).not.toHaveBeenCalled();
  });

  it("injects browser execution context and emits browser presentation metadata", async () => {
    const browserExecute = vi.fn(async () => ({
      content: JSON.stringify({
        sessionId: "visible-session",
        tabId: "tab-1",
        url: "https://www.facebook.com",
      }),
      metadata: {
        browserPresentation: {
          presentationMode: "host_chrome_visible",
          targetBrowser: "Google Chrome",
          browserTarget: "Google Chrome",
          sessionId: "visible-session",
          tabId: "tab-1",
          presentationSummary: "facebook.com · visible desktop",
        },
      },
    }));
    const browserTool: FridayAgentToolDefinition = {
      name: "browser",
      description: "Browser tool",
      parameters: { properties: { action: { type: "string" }, url: { type: "string" } } },
      execute: browserExecute,
    };

    const llmClient = createMockLlmClient([
      [
        { type: "tool_use", id: "call-1", name: "browser", input: { action: "open", url: "https://www.facebook.com" } },
        { type: "message_end", stopReason: "tool_use", inputTokens: 5, outputTokens: 3 },
      ],
      [
        { type: "text_delta", text: "Opened Facebook." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 4, outputTokens: 2 },
      ],
    ]);

    const emitter = createFridayAgentEventEmitter();
    const toolStartEvents: Array<Record<string, unknown>> = [];
    const toolEndEvents: Array<Record<string, unknown>> = [];
    emitter.on("agent.run.tool_start", (payload) => {
      toolStartEvents.push(payload as Record<string, unknown>);
    });
    emitter.on("agent.run.tool_end", (payload) => {
      toolEndEvents.push(payload as Record<string, unknown>);
    });

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [browserTool],
      eventEmitter: emitter,
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "Open Facebook",
      executionContext: {
        surface: "agent_page",
        interactive: true,
        browserPresentationMode: "host_chrome_visible",
      },
    });

    expect(result.status).toBe("completed");
    expect(browserExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "open",
        url: "https://www.facebook.com",
        __browserExecutionSource: "agent_page",
        __browserInteractive: true,
        __browserPresentationMode: "host_chrome_visible",
      }),
      expect.any(AbortSignal),
    );
    expect(toolStartEvents[0]?.params).toEqual({
      action: "open",
      url: "https://www.facebook.com",
    });
    expect(toolEndEvents[0]).toMatchObject({
      presentationMode: "host_chrome_visible",
      targetBrowser: "Google Chrome",
      browserTarget: "Google Chrome",
      sessionId: "visible-session",
      tabId: "tab-1",
      summary: "facebook.com · visible desktop",
    });
  });

  it("populates images from browser screenshot tool calls", async () => {
    const screenshotPath = "/tmp/friday-test/artifacts/browser/default/12345-tab-1.png";
    const browserTool: FridayAgentToolDefinition = {
      name: "browser",
      description: "Browser tool",
      parameters: { properties: { action: { type: "string" } } },
      execute: async () => ({
        content: JSON.stringify({
          sessionId: "default",
          tabId: "tab-1",
          mode: "path",
          mimeType: "image/png",
          path: screenshotPath,
          width: 1280,
          height: 720,
          byteLength: 4096,
        }),
      }),
    };

    const llmClient = createMockLlmClient([
      [
        { type: "tool_use", id: "call-1", name: "browser", input: { action: "screenshot" } },
        { type: "message_end", stopReason: "tool_use", inputTokens: 5, outputTokens: 3 },
      ],
      [
        { type: "text_delta", text: "Here is the screenshot." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 4, outputTokens: 2 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [browserTool],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "Take a screenshot" });

    expect(result.status).toBe("completed");
    expect(result.images).toEqual([screenshotPath]);
  });

  it("fails run when global policy denies agent execution", async () => {
    const streamSpy = vi.fn(async function* () {
      yield { type: "text_delta", text: "should not run" } as FridayAgentLlmStreamEvent;
      yield { type: "message_end", stopReason: "end_turn", inputTokens: 1, outputTokens: 1 } as FridayAgentLlmStreamEvent;
    });
    const llmClient: FridayAgentLlmClient = { stream: streamSpy };
    const emitter = createFridayAgentEventEmitter();
    const failedEvents: Array<{ routeId?: string; correlationId?: string; errorCode?: string }> = [];
    emitter.on("agent.run.failed", (payload) => {
      failedEvents.push({
        routeId: payload.routeId,
        correlationId: payload.correlationId,
        errorCode: payload.error.code,
      });
    });

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [],
      eventEmitter: emitter,
      idGenerator,
      nowIso: () => NOW,
      evaluateRules: async () => denyPolicyResult("Agent execution denied by policy"),
    });

    const result = await runtime.executeRun({
      task: "Run something sensitive",
      principalId: "user-1",
      scopes: ["agent.run"],
    });

    expect(result.status).toBe("failed");
    expect(result.response).toContain("denied by policy");
    expect(streamSpy).not.toHaveBeenCalled();
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]?.errorCode).toBe("AGENT_VALIDATION_ERROR");
    expect(failedEvents[0]?.routeId).toBe("agent.execute.run.policy");
    expect(failedEvents[0]?.correlationId).toBe(result.runId);
  });

  it("blocks tool calls when policy denies skill execution", async () => {
    const skillExecute = vi.fn(async () => ({ content: "should not execute" }));
    const skillTool: FridayAgentToolDefinition = {
      name: "skill_run",
      description: "Run skill",
      parameters: { properties: { skillId: { type: "string" } }, required: ["skillId"] },
      execute: skillExecute,
    };

    const llmClient = createMockLlmClient([
      [
        { type: "tool_use", id: "call-1", name: "skill_run", input: { skillId: "private.skill" } },
        { type: "message_end", stopReason: "tool_use", inputTokens: 5, outputTokens: 3 },
      ],
      [
        { type: "text_delta", text: "Handled blocked tool." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 3, outputTokens: 2 },
      ],
    ]);

    const evaluateRules = vi.fn(
      async (context: FridayEvaluationContext): Promise<FridayEvaluationResult> => {
        if (context.resource === "skill") {
          return denyPolicyResult("Skill execution denied by policy");
        }
        return allowPolicyResult();
      },
    );

    const emitter = createFridayAgentEventEmitter();
    const toolEndEvents: Array<{
      isError: boolean;
      errorCode?: string;
      routeId?: string;
      correlationId?: string;
    }> = [];
    emitter.on("agent.run.tool_end", (payload) => {
      toolEndEvents.push({
        isError: payload.isError,
        errorCode: payload.errorCode,
        routeId: payload.routeId,
        correlationId: payload.correlationId,
      });
    });

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [skillTool],
      eventEmitter: emitter,
      idGenerator,
      nowIso: () => NOW,
      evaluateRules,
    });

    const result = await runtime.executeRun({
      task: "Run private skill",
      principalId: "user-1",
      scopes: ["agent.run"],
    });

    expect(result.status).toBe("completed");
    expect(result.response).toBe("Handled blocked tool.");
    expect(result.toolCallCount).toBe(1);
    expect(skillExecute).not.toHaveBeenCalled();
    expect(toolEndEvents).toHaveLength(1);
    expect(toolEndEvents[0]?.isError).toBe(true);
    expect(toolEndEvents[0]?.errorCode).toBe("AGENT_VALIDATION_ERROR");
    expect(toolEndEvents[0]?.routeId).toBe("agent.execute.tool.policy");
    expect(toolEndEvents[0]?.correlationId).toBe(result.runId);
    expect(evaluateRules).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: "skill",
        action: "execute",
      }),
      expect.any(AbortSignal),
    );
  });

  it("fails the run when a requested file write is blocked outside the workspace root", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "friday-agent-runtime-workspace-"));
    const outsidePath = join(
      tmpdir(),
      `friday-agent-runtime-outside-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
    );
    rmSync(outsidePath, { force: true });

    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-1",
          name: "write",
          input: { path: outsidePath, content: "# blocked\n" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 5, outputTokens: 3 },
      ],
      [
        { type: "text_delta", text: "I could not create the file because the path is outside the workspace root." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 4, outputTokens: 2 },
      ],
    ]);

    const mockWriter = {
      writeRunArtifacts: vi.fn().mockReturnValue({
        artifactDir: "/tmp/.friday/agent-runs/outside-workspace-write",
        artifacts: [{ type: "run_record", path: "/tmp/.friday/agent-runs/outside-workspace-write/run.json" }],
      }),
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: createFridayAgentFileTools({ workspaceRoot }),
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      artifactWriter: mockWriter,
      workdir: workspaceRoot,
      selfTestService: {
        async runTests() {
          return [{ strategy: "llm_eval", passed: true, durationMs: 25 }];
        },
      },
    });

    try {
      const result = await runtime.executeRun({
        task: `Create ${outsidePath} and write a short markdown summary into that file.`,
      });

      expect(result.status).toBe("failed");
      expect(result.response).toContain("AGENT_OUTPUT_CLOSURE_ERROR");
      expect(result.toolCallCount).toBe(1);
      expect(mockWriter.writeRunArtifacts).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "failed",
        }),
      );
      expect(existsSync(outsidePath)).toBe(false);

      const repo = createFridayAgentRunRepository();
      const run = db.withReadConnection((reader) => repo.getById(reader, result.runId));

      expect(run?.status).toBe("failed");
      expect(run?.errorCode).toBe("AGENT_OUTPUT_CLOSURE_ERROR");
      expect(run?.testResults?.[0]?.passed).toBe(true);
      expect(run?.artifactDir).toBe("/tmp/.friday/agent-runs/outside-workspace-write");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(outsidePath, { force: true });
    }
  });

  // ─── IMPL-5: Failing self-test returns failed terminal status ───

  it("failing self-test returns failed terminal status", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "Here is the output" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 3 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      selfTestService: {
        async runTests() {
          return [{ strategy: "syntax", passed: false, errors: [{ message: "Syntax error", severity: "error" }], durationMs: 50 }];
        },
      },
    });

    const result = await runtime.executeRun({ task: "Self-test fail" });

    expect(result.status).toBe("failed");

    const repo = createFridayAgentRunRepository();
    const run = db.withReadConnection((reader) => repo.getById(reader, result.runId));
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("AGENT_VALIDATION_ERROR");
  });

  it("self-fix retries validation failures and completes after corrected output passes", async () => {
    const batches: FridayAgentLlmStreamEvent[][] = [
      [
        { type: "text_delta", text: "Here is the broken output" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 3 },
      ],
      [
        { type: "text_delta", text: "Here is the corrected output" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 7, outputTokens: 4 },
      ],
    ];
    const streamedMessages: string[] = [];
    let llmCallCount = 0;
    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        streamedMessages.push(JSON.stringify(params.messages));
        const batch = batches[llmCallCount] ?? [];
        llmCallCount++;
        for (const event of batch) {
          yield event;
        }
      },
    };
    let selfTestCalls = 0;

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      selfTestService: {
        async runTests() {
          selfTestCalls++;
          if (selfTestCalls === 1) {
            return [{
              strategy: "syntax",
              passed: false,
              errors: [{ message: "Syntax error", severity: "error" }],
              durationMs: 50,
            }];
          }
          return [{ strategy: "syntax", passed: true, errors: [], durationMs: 30 }];
        },
      },
      selfFixService: createFridayAgentSelfFixService(),
    });

    const result = await runtime.executeRun({ task: "Self-test fail then fix" });

    expect(result.status).toBe("completed");
    expect(result.response).toBe("Here is the corrected output");
    expect(llmCallCount).toBe(2);
    expect(selfTestCalls).toBe(2);
    expect(streamedMessages[1]).toContain("The previous attempt failed validation");
    expect(streamedMessages[1]).toContain("Syntax error");

    const repo = createFridayAgentRunRepository();
    const run = db.withReadConnection((reader) => repo.getById(reader, result.runId));
    expect(run?.status).toBe("completed");
    expect(run?.attempt).toBe(1);
    expect(run?.testResults?.[0]?.passed).toBe(true);
  });

  // ─── IMPL-5: Empty response fails criteria ───

  it("empty final response fails completion criteria when self-test is configured", async () => {
    // LLM returns no text (only tool_use that doesn't produce a final text response)
    const llmClient = createMockLlmClient([
      [
        { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 3 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      selfTestService: {
        async runTests() {
          return [{ strategy: "llm_eval", passed: true, errors: [], durationMs: 0 }];
        },
      },
    });

    const result = await runtime.executeRun({ task: "Empty response test" });

    expect(result.status).toBe("failed");
  });

  it("preserves the last non-empty assistant text when a follow-up tool turn ends without new text", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "Acknowledged: the project codename is Atlas." },
        { type: "tool_use", id: "call-1", name: "echo", input: { message: "store atlas" } },
        { type: "message_end", stopReason: "tool_use", inputTokens: 5, outputTokens: 3 },
      ],
      [
        { type: "message_end", stopReason: "end_turn", inputTokens: 4, outputTokens: 2 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [createEchoTool()],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      selfTestService: {
        async runTests() {
          return [{ strategy: "llm_eval", passed: true, errors: [], durationMs: 0 }];
        },
      },
    });

    const result = await runtime.executeRun({ task: "Remember the Atlas codename" });

    expect(result.status).toBe("completed");
    expect(result.response).toBe("Acknowledged: the project codename is Atlas.");
  });

  it("surfaces downstream workflow generator clarification as awaiting_clarification instead of failing", async () => {
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-1",
          name: "workflow_generate",
          input: {
            action: "start",
            goal: "Generate a weekly release workflow",
          },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 5, outputTokens: 3 },
      ],
      [
        { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 3 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [createWorkflowGeneratorClarificationTool()],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      selfTestService: {
        async runTests() {
          return [{ strategy: "llm_eval", passed: true, errors: [], durationMs: 0 }];
        },
      },
    });

    const result = await runtime.executeRun({
      task: "Generate a workflow that runs every Friday and posts release status to Slack.",
      reviewRequired: true,
      skipPlanningReview: true,
      planReviewOverride: {
        plan: {
          task: "Generate a workflow that runs every Friday and posts release status to Slack.",
          stepCount: 3,
          description: "Approved workflow generation plan",
        },
        decision: {
          approved: true,
          mode: "manual-approve",
          reviewedAt: NOW,
        },
        gate: {
          kind: "generate_workflow",
          state: "approved",
          planMarkdown: "# Proposed plan",
          planSummary: "Approved workflow plan",
        },
      },
    });

    expect(result.status).toBe("awaiting_clarification");
    expect(result.response).toContain("downstream generator still needs");
    expect(result.response).toContain("Which timezone should this workflow run in?");

    const repo = createFridayAgentRunRepository();
    const run = db.withReadConnection((reader) => repo.getById(reader, result.runId));
    expect(run?.status).toBe("awaiting_clarification");
    expect(run?.planReview?.gate?.state).toBe("awaiting_clarification");
    expect(run?.planReview?.decision).toBeUndefined();
    expect(run?.planReview?.gate?.clarificationQuestions).toEqual([
      "Which timezone should this workflow run in?",
      "Which Slack destination should receive the summary?",
    ]);
  });

  it("allows readonly diagnosis skill summaries to complete even when llm_eval asks for more action", async () => {
    const skillTool: FridayAgentToolDefinition = {
      name: "skill_run",
      description: "Run a skill",
      parameters: { properties: { skillId: { type: "string" } }, required: ["skillId"] },
      execute: vi.fn(async () => ({
        content: JSON.stringify({
          summary: "System snapshot captured",
          nextStep: "Review open issues if needed",
        }),
      })),
    };

    const llmClient = createMockLlmClient([
      [
        { type: "tool_use", id: "call-1", name: "skill_run", input: { skillId: "system-health-snapshot" } },
        { type: "message_end", stopReason: "tool_use", inputTokens: 5, outputTokens: 3 },
      ],
      [
        { type: "text_delta", text: "The system snapshot shows the browser runtime is healthy." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 3 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [skillTool],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      selfTestService: {
        async runTests() {
          return [{
            strategy: "llm_eval",
            passed: false,
            errors: [{ message: "Agent should take another action", severity: "error" }],
            durationMs: 10,
          }];
        },
      },
    });

    const result = await runtime.executeRun({ task: "Run system-health-snapshot and summarize it" });

    expect(result.status).toBe("completed");
    expect(result.response).toContain("browser runtime is healthy");
  });

  it("auto-corrects misrouted skill generation calls into the skill_generate toolchain", async () => {
    const skillRunSpy = vi.fn(async () => ({
      content: "skill_run should not execute for skill generation aliases",
      isError: true,
    }));
    const skillGenerateSpy = vi.fn(async (args: Record<string, unknown>) => {
      const action = typeof args.action === "string" ? args.action : "";
      if (action === "start") {
        return {
          content: JSON.stringify({
            sessionId: "skill-session-1",
            status: "preview_ready",
            mode: "preview_ready",
            questions: [],
          }),
        };
      }
      if (action === "generate") {
        return {
          content: JSON.stringify({
            sessionId: "skill-session-1",
            validation: { ok: true, issues: [] },
            fileCount: 2,
          }),
        };
      }
      if (action === "approve") {
        return {
          content: JSON.stringify({
            approved: true,
            skillId: "generated-skill-1",
            registryRefreshed: true,
          }),
        };
      }
      return { content: `unexpected action: ${action}`, isError: true };
    });

    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-skill-run",
          name: "skill_run",
          input: { skillId: "skill_generate", input: {}, timeoutMs: 0 },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 5 },
      ],
      [
        {
          type: "tool_use",
          id: "call-skill-generate",
          name: "skill_generate",
          input: { action: "generate", sessionId: "skill-session-1" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 5 },
      ],
      [
        {
          type: "tool_use",
          id: "call-skill-approve",
          name: "skill_generate",
          input: { action: "approve", sessionId: "skill-session-1" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "Skill created and approved." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 5 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [
        {
          name: "skill_run",
          description: "Run an installed skill",
          parameters: { properties: { skillId: { type: "string" } }, required: ["skillId"] },
          execute: skillRunSpy,
        },
        {
          name: "skill_generate",
          description: "Generate a skill",
          parameters: { properties: { action: { type: "string" } }, required: ["action"] },
          execute: skillGenerateSpy,
        },
      ],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      selfTestService: {
        async runTests() {
          return [{ strategy: "llm_eval", passed: true, errors: [], durationMs: 0 }];
        },
      },
    });

    const result = await runtime.executeRun({
      task: "Create a new Friday skill that formats a topic into markdown bullets.",
      reviewRequired: true,
      skipPlanningReview: true,
      planReviewOverride: {
        plan: {
          task: "Create a new Friday skill that formats a topic into markdown bullets.",
          stepCount: 3,
          description: "Approved skill generation plan",
        },
        decision: {
          approved: true,
          mode: "manual-approve",
          reviewedAt: NOW,
        },
        gate: {
          kind: "generate_skill",
          state: "approved",
          planMarkdown: "# Proposed skill plan",
          planSummary: "Approved skill plan",
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(result.response).toContain("Skill created and approved.");
    expect(skillRunSpy).not.toHaveBeenCalled();
    expect(skillGenerateSpy).toHaveBeenCalledTimes(3);
    expect(skillGenerateSpy).toHaveBeenNthCalledWith(
      1,
      {
        action: "start",
        goal: "Create a new Friday skill that formats a topic into markdown bullets.",
      },
      expect.any(AbortSignal),
    );
  });

  it("blocks direct browser bypass when a task explicitly requires autonomous", async () => {
    const browserSpy = vi.fn(async () => ({
      content: "browser should not execute before autonomous",
      isError: true,
    }));
    const autonomousSpy = vi.fn(async (args: Record<string, unknown>) => ({
      content: JSON.stringify({
        goalId: "goal-1",
        status: "completed",
        summary: `Autonomous action ${String(args.action ?? "")} completed`,
      }),
    }));

    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-browser",
          name: "browser",
          input: { action: "open", url: "https://example.com" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 5 },
      ],
      [
        {
          type: "tool_use",
          id: "call-autonomous",
          name: "autonomous",
          input: {
            action: "execute_goal",
            description: "Open example.com and capture the page title.",
          },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "Autonomous goal started and completed." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 5 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [
        {
          name: "browser",
          description: "Mock browser tool",
          parameters: { properties: { action: { type: "string" } }, required: ["action"] },
          execute: browserSpy,
        },
        {
          name: "autonomous",
          description: "Mock autonomous tool",
          parameters: { properties: { action: { type: "string" } }, required: ["action"] },
          execute: autonomousSpy,
        },
      ],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      selfTestService: {
        async runTests() {
          return [{ strategy: "llm_eval", passed: true, errors: [], durationMs: 0 }];
        },
      },
    });

    const result = await runtime.executeRun({
      task: "Mandatory: call autonomous tool exactly once to open example.com and capture the page title.",
    });

    expect(result.status).toBe("completed");
    expect(result.response).toContain("Autonomous goal started and completed.");
    expect(browserSpy).not.toHaveBeenCalled();
    expect(autonomousSpy).toHaveBeenCalledTimes(1);
    expect(autonomousSpy).toHaveBeenCalledWith(
      {
        action: "execute_goal",
        description: "Open example.com and capture the page title.",
      },
      expect.any(AbortSignal),
    );
  });

  it("does not treat internal autonomous planning prompts as explicit autonomous user tasks", async () => {
    const browserSpy = vi.fn(async () => ({
      content: "browser should stay blocked in plan mode",
      isError: false,
    }));
    const autonomousSpy = vi.fn(async () => ({
      content: "autonomous should not be invoked from planning prompt",
      isError: false,
    }));
    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-browser-plan",
          name: "browser",
          input: { action: "open", url: "https://example.com" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "Planning stayed in analysis mode." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 5 },
      ],
    ]);

    const emitter = createFridayAgentEventEmitter();
    const toolEndEvents: Array<Record<string, unknown>> = [];
    emitter.on("agent.run.tool_end", (payload) => {
      toolEndEvents.push(payload as Record<string, unknown>);
    });

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [
        {
          name: "browser",
          description: "Mock browser tool",
          parameters: { properties: { action: { type: "string" } }, required: ["action"] },
          execute: browserSpy,
        },
        {
          name: "autonomous",
          description: "Mock autonomous tool",
          parameters: { properties: { action: { type: "string" } }, required: ["action"] },
          execute: autonomousSpy,
        },
      ],
      eventEmitter: emitter,
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "You are an autonomous agent that can control a computer. You must decompose this goal into concrete steps. Goal: Open example.com and verify the title.",
      constraints: {
        readOnly: true,
        operationalMode: "plan",
      },
    });

    expect(result.toolCallCount).toBe(1);
    expect(browserSpy).not.toHaveBeenCalled();
    expect(autonomousSpy).not.toHaveBeenCalled();
    expect(toolEndEvents[0]?.toolName).toBe("browser");
    expect(String(toolEndEvents[0]?.summary ?? "")).toContain("not available in plan mode");
    expect(String(toolEndEvents[0]?.summary ?? "")).not.toContain("explicitly requires tool 'autonomous'");
  });

  it("hides tool declarations from autonomous internal planning surfaces", async () => {
    let capturedToolNames: string[] = [];
    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        capturedToolNames = params.tools.map((tool) => tool.name);
        yield {
          type: "text_delta",
          text: "[{\"instruction\":\"Open https://example.com\",\"domain\":\"browser\",\"verification\":\"URL contains example.com\"}]",
        };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 5 };
      },
    };

    const browserSpy = vi.fn(async () => ({ content: "browser should not be invoked during planning" }));
    const autonomousSpy = vi.fn(async () => ({ content: "autonomous should not be invoked during planning" }));

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [
        {
          name: "browser",
          description: "Mock browser tool",
          parameters: { properties: { action: { type: "string" } }, required: ["action"] },
          execute: browserSpy,
        },
        {
          name: "autonomous",
          description: "Mock autonomous tool",
          parameters: { properties: { action: { type: "string" } }, required: ["action"] },
          execute: autonomousSpy,
        },
      ],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "You are an autonomous agent that can control a computer. You must decompose this goal into concrete steps. Goal: Open example.com and verify the title.",
      constraints: {
        readOnly: true,
        operationalMode: "plan",
      },
      executionContext: {
        surface: "autonomous_internal_plan",
      },
    });

    expect(result.status).toBe("completed");
    expect(result.response).not.toContain("AGENT_OUTPUT_CLOSURE_ERROR");
    expect(result.toolCallCount).toBe(0);
    expect(capturedToolNames).toEqual([]);
    expect(browserSpy).not.toHaveBeenCalled();
    expect(autonomousSpy).not.toHaveBeenCalled();
  });

  it("does not route autonomous internal action surfaces back through the autonomous tool gate", async () => {
    let callCount = 0;
    const llmClient: FridayAgentLlmClient = {
      async *stream() {
        callCount++;
        if (callCount === 1) {
          yield {
            type: "tool_use",
            id: "call-browser-start",
            name: "browser",
            input: { action: "start", sessionId: "autonomous-goal:test-goal" },
          };
          yield { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 };
          return;
        }

        yield { type: "text_delta", text: "Browser session started." };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 4 };
      },
    };

    const browserSpy = vi.fn(async () => ({ content: "started" }));
    const autonomousSpy = vi.fn(async () => ({ content: "autonomous should not be invoked for internal action runs" }));

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [
        {
          name: "browser",
          description: "Mock browser tool",
          parameters: { properties: { action: { type: "string" } }, required: ["action"] },
          execute: browserSpy,
        },
        {
          name: "autonomous",
          description: "Mock autonomous tool",
          parameters: { properties: { action: { type: "string" } }, required: ["action"] },
          execute: autonomousSpy,
        },
      ],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "Execute the following tool call and return the result:\nTool: browser\nArguments: {\"action\":\"start\",\"sessionId\":\"autonomous-goal:test-goal\"}\n\nRationale: Need to start the browser first before I can navigate to https://example.com and complete the autonomous goal.",
      executionContext: {
        surface: "autonomous_internal_action",
      },
    });

    expect(result.status).toBe("completed");
    expect(result.response).toContain("Browser session started");
    expect(browserSpy).toHaveBeenCalledTimes(1);
    expect(autonomousSpy).not.toHaveBeenCalled();
  });

  it("auto-starts skill_generate after a skills_list-only iteration on skill-generation tasks", async () => {
    const skillsListSpy = vi.fn(async () => ({
      content: JSON.stringify({
        items: [{ skillId: "existing-skill", title: "Existing skill" }],
        count: 1,
      }),
    }));
    const skillGenerateSpy = vi.fn(async (args: Record<string, unknown>) => {
      const action = typeof args.action === "string" ? args.action : "";
      if (action === "start") {
        return {
          content: JSON.stringify({
            sessionId: "skill-session-auto-start-1",
            status: "preview_ready",
            mode: "preview_ready",
            questions: [],
          }),
        };
      }
      if (action === "generate") {
        return {
          content: JSON.stringify({
            sessionId: "skill-session-auto-start-1",
            validation: { ok: true, issues: [] },
            fileCount: 2,
          }),
        };
      }
      if (action === "approve") {
        return {
          content: JSON.stringify({
            approved: true,
            skillId: "generated-skill-auto-start-1",
            registryRefreshed: true,
          }),
        };
      }
      return { content: `unexpected action: ${action}`, isError: true };
    });

    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-skills-list",
          name: "skills_list",
          input: {},
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 5 },
      ],
      [
        {
          type: "tool_use",
          id: "call-skill-generate",
          name: "skill_generate",
          input: { action: "generate", sessionId: "skill-session-auto-start-1" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 5 },
      ],
      [
        {
          type: "tool_use",
          id: "call-skill-approve",
          name: "skill_generate",
          input: { action: "approve", sessionId: "skill-session-auto-start-1" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "Skill created after inventory check." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 5 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [
        {
          name: "skills_list",
          description: "List installed skills",
          parameters: { properties: {}, required: [] },
          execute: skillsListSpy,
        },
        {
          name: "skill_generate",
          description: "Generate a skill",
          parameters: { properties: { action: { type: "string" } }, required: ["action"] },
          execute: skillGenerateSpy,
        },
      ],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      selfTestService: {
        async runTests() {
          return [{ strategy: "llm_eval", passed: true, errors: [], durationMs: 0 }];
        },
      },
    });

    const result = await runtime.executeRun({
      task: "Create a new Friday skill that converts a topic into markdown bullets.",
    });

    expect(result.status).toBe("completed");
    expect(result.response).toContain("Skill created after inventory check.");
    expect(skillsListSpy).toHaveBeenCalledTimes(1);
    expect(skillGenerateSpy).toHaveBeenNthCalledWith(
      1,
      {
        action: "start",
        goal: "Create a new Friday skill that converts a topic into markdown bullets.",
      },
      expect.any(AbortSignal),
    );
  });

  it("blocks manual managed-skill writes on skill-generation tasks and auto-starts skill_generate instead", async () => {
    const writeSpy = vi.fn(async () => ({ content: "write should not execute" }));
    const skillGenerateSpy = vi.fn(async (args: Record<string, unknown>) => {
      const action = typeof args.action === "string" ? args.action : "";
      if (action === "start") {
        return {
          content: JSON.stringify({
            sessionId: "skill-session-write-1",
            status: "preview_ready",
            mode: "preview_ready",
            questions: [],
          }),
        };
      }
      if (action === "generate") {
        return {
          content: JSON.stringify({
            sessionId: "skill-session-write-1",
            validation: { ok: true, issues: [] },
            fileCount: 2,
          }),
        };
      }
      if (action === "approve") {
        return {
          content: JSON.stringify({
            approved: true,
            skillId: "generated-skill-write-1",
            registryRefreshed: true,
          }),
        };
      }
      return { content: `unexpected action: ${action}`, isError: true };
    });

    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-write-skill",
          name: "write",
          input: {
            path: "managed-skills/generated-skill-write-1/skill.manifest.json",
            content: "{}",
          },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 5 },
      ],
      [
        {
          type: "tool_use",
          id: "call-skill-generate-after-write",
          name: "skill_generate",
          input: { action: "generate", sessionId: "skill-session-write-1" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 5 },
      ],
      [
        {
          type: "tool_use",
          id: "call-skill-approve-after-write",
          name: "skill_generate",
          input: { action: "approve", sessionId: "skill-session-write-1" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "Skill created via generator." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 5 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [
        {
          name: "write",
          description: "Write a file",
          parameters: { properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
          execute: writeSpy,
        },
        {
          name: "skill_generate",
          description: "Generate a skill",
          parameters: { properties: { action: { type: "string" } }, required: ["action"] },
          execute: skillGenerateSpy,
        },
      ],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      selfTestService: {
        async runTests() {
          return [{ strategy: "llm_eval", passed: true, errors: [], durationMs: 0 }];
        },
      },
    });

    const result = await runtime.executeRun({
      task: "Create a new Friday skill that returns markdown bullets for a topic.",
    });

    expect(result.status).toBe("completed");
    expect(result.response).toContain("Skill created via generator.");
    expect(writeSpy).not.toHaveBeenCalled();
    expect(skillGenerateSpy).toHaveBeenNthCalledWith(
      1,
      {
        action: "start",
        goal: "Create a new Friday skill that returns markdown bullets for a topic.",
      },
      expect.any(AbortSignal),
    );
  });

  it("blocks manual top-level skills directory writes on skill-generation tasks and auto-starts skill_generate instead", async () => {
    const writeSpy = vi.fn(async () => ({ content: "write should not execute" }));
    const skillGenerateSpy = vi.fn(async (args: Record<string, unknown>) => {
      const action = typeof args.action === "string" ? args.action : "";
      if (action === "start") {
        return {
          content: JSON.stringify({
            sessionId: "skill-session-skills-dir-1",
            status: "preview_ready",
            mode: "preview_ready",
            questions: [],
          }),
        };
      }
      if (action === "generate") {
        return {
          content: JSON.stringify({
            sessionId: "skill-session-skills-dir-1",
            validation: { ok: true, issues: [] },
            fileCount: 2,
          }),
        };
      }
      if (action === "approve") {
        return {
          content: JSON.stringify({
            approved: true,
            skillId: "generated-skill-skills-dir-1",
            registryRefreshed: true,
          }),
        };
      }
      return { content: `unexpected action: ${action}`, isError: true };
    });

    const llmClient = createMockLlmClient([
      [
        {
          type: "tool_use",
          id: "call-write-skill-dir",
          name: "write",
          input: {
            path: "skills/generated-skill-skills-dir-1/manifest.json",
            content: "{}",
          },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 5 },
      ],
      [
        {
          type: "tool_use",
          id: "call-skill-generate-after-skill-dir-write",
          name: "skill_generate",
          input: { action: "generate", sessionId: "skill-session-skills-dir-1" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 5 },
      ],
      [
        {
          type: "tool_use",
          id: "call-skill-approve-after-skill-dir-write",
          name: "skill_generate",
          input: { action: "approve", sessionId: "skill-session-skills-dir-1" },
        },
        { type: "message_end", stopReason: "tool_use", inputTokens: 8, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "Skill created via generator after blocking top-level write." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 5 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [
        {
          name: "write",
          description: "Write a file",
          parameters: { properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
          execute: writeSpy,
        },
        {
          name: "skill_generate",
          description: "Generate a skill",
          parameters: { properties: { action: { type: "string" } }, required: ["action"] },
          execute: skillGenerateSpy,
        },
      ],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      selfTestService: {
        async runTests() {
          return [{ strategy: "llm_eval", passed: true, errors: [], durationMs: 0 }];
        },
      },
    });

    const result = await runtime.executeRun({
      task: "Create a new Friday skill that returns markdown bullets for a topic.",
    });

    expect(result.status).toBe("completed");
    expect(result.response).toContain("Skill created via generator after blocking top-level write.");
    expect(writeSpy).not.toHaveBeenCalled();
    expect(skillGenerateSpy).toHaveBeenNthCalledWith(
      1,
      {
        action: "start",
        goal: "Create a new Friday skill that returns markdown bullets for a topic.",
      },
      expect.any(AbortSignal),
    );
  });

  // ─── IMPL-5: Passing self-test emits completed with real testsPassed ───

  it("passing self-test emits completed with testsPassed from real result", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "All good" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 3 },
      ],
    ]);

    const emitter = createFridayAgentEventEmitter();
    const completedEvents: Array<{ testsPassed: boolean }> = [];
    emitter.on("agent.run.completed", (p) => completedEvents.push({ testsPassed: p.testsPassed }));

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [],
      eventEmitter: emitter,
      idGenerator,
      nowIso: () => NOW,
      selfTestService: {
        async runTests() {
          return [{ strategy: "llm_eval", passed: true, errors: [], durationMs: 0 }];
        },
      },
    });

    await runtime.executeRun({ task: "Passing test" });

    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].testsPassed).toBe(true);
  });

  // ─── IMPL-6: Response text and summary persisted ───

  it("persists response_text and summary in run record", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "This is the final response." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 3 },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "Response persist test" });

    const repo = createFridayAgentRunRepository();
    const run = db.withReadConnection((reader) => repo.getById(reader, result.runId));

    expect(run?.responseText).toBe("This is the final response.");
    expect(run?.summary).toBe("This is the final response.");
  });

  // ─── IMPL-6: Session mirror callback ───

  it("calls session mirror callback with final response", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "Mirror this" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 3 },
      ],
    ]);

    const mirrorCalls: Array<{ key: string; msg: unknown }> = [];
    const sessionMirror = vi.fn(async (key: string, msg: unknown) => {
      mirrorCalls.push({ key, msg });
    });

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      sessionMirror,
    });

    const result = await runtime.executeRun({ task: "Mirror test" });

    expect(result.status).toBe("completed");
    expect(sessionMirror).toHaveBeenCalledOnce();
    expect(mirrorCalls[0].msg).toEqual(expect.objectContaining({
      role: "assistant",
      contentText: "Mirror this",
    }));
  });

  // ─── IMPL-7: Artifact writer stores artifacts and artifactDir ───

  it("runtime stores non-empty artifacts and artifactDir when writer provided", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "Built something" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 3 },
      ],
    ]);

    const mockWriter = {
      writeRunArtifacts: vi.fn().mockReturnValue({
        artifactDir: "/tmp/.friday/agent-runs/test-run",
        artifacts: [{ type: "run_record", path: "/tmp/.friday/agent-runs/test-run/run.json" }],
      }),
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      artifactWriter: mockWriter,
    });

    const result = await runtime.executeRun({ task: "Artifact test" });

    expect(result.status).toBe("completed");
    expect(mockWriter.writeRunArtifacts).toHaveBeenCalledOnce();
    expect(mockWriter.writeRunArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationContext: undefined,
      }),
    );

    const repo = createFridayAgentRunRepository();
    const run = db.withReadConnection((reader) => repo.getById(reader, result.runId));

    expect(run?.artifactDir).toBe("/tmp/.friday/agent-runs/test-run");
    expect(run?.artifacts).toBeDefined();
    expect(run!.artifacts!.length).toBeGreaterThan(0);
  });

  it("runtime stores artifactDir and testResults when validation fails", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "Captured diagnostic summary" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 3 },
      ],
    ]);

    const mockWriter = {
      writeRunArtifacts: vi.fn().mockReturnValue({
        artifactDir: "/tmp/.friday/agent-runs/failed-run",
        artifacts: [{ type: "run_record", path: "/tmp/.friday/agent-runs/failed-run/run.json" }],
      }),
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      artifactWriter: mockWriter,
      selfTestService: {
        async runTests() {
          return [{
            strategy: "llm_eval",
            passed: false,
            errors: [{ message: "Need stronger evidence", severity: "error" }],
            durationMs: 25,
          }];
        },
      },
    });

    const result = await runtime.executeRun({ task: "Validation fail with evidence" });

    expect(result.status).toBe("failed");
    expect(mockWriter.writeRunArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        response: "Captured diagnostic summary",
        conversationContext: undefined,
      }),
    );

    const repo = createFridayAgentRunRepository();
    const run = db.withReadConnection((reader) => repo.getById(reader, result.runId));

    expect(run?.artifactDir).toBe("/tmp/.friday/agent-runs/failed-run");
    expect(run?.testResults?.[0]?.passed).toBe(false);
    expect(run?.artifacts?.length).toBeGreaterThan(0);
  });

  // ─── IMPL-2: Actual execution metadata persisted ───

  it("persists actual execution metadata from message_end", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "Done" },
        {
          type: "message_end",
          stopReason: "end_turn",
          inputTokens: 10,
          outputTokens: 5,
          actualProviderId: "anthropic-1",
          actualModel: "claude-3-haiku",
          actualProviderKind: "anthropic",
          actualProviderApi: "anthropic-messages",
          costUsd: 0.005,
        },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "Actual exec test" });

    const repo = createFridayAgentRunRepository();
    const run = db.withReadConnection((reader) => repo.getById(reader, result.runId));

    expect(run?.actualExecution).toBeDefined();
    expect(run?.actualExecution?.actualProviderId).toBe("anthropic-1");
    expect(run?.actualExecution?.actualModel).toBe("claude-3-haiku");
    expect(run?.actualExecution?.turns).toHaveLength(1);
    expect(run?.actualExecution?.turns[0].costUsd).toBe(0.005);
    expect(run?.actualExecution?.totalCostUsd).toBe(0.005);
  });

  it("treats taskProfile.model as the requested model when no explicit model override is provided", async () => {
    const llmClient = createMockLlmClient([
      [
        {
          type: "message_end",
          stopReason: "end_turn",
          inputTokens: 12,
          outputTokens: 6,
          actualProviderId: "openai-1",
          actualModel: "gpt-5.4",
          actualProviderKind: "openai",
          actualProviderApi: "openai-responses",
        },
      ],
    ]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "route-default-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "Use the task profile model",
      taskProfile: { id: "planning", model: "gpt-5.4" },
    });

    const repo = createFridayAgentRunRepository();
    const run = db.withReadConnection((reader) => repo.getById(reader, result.runId));
    expect(run?.actualExecution).toMatchObject({
      requestedModel: "gpt-5.4",
      taskProfileId: "planning",
      taskProfileModel: "gpt-5.4",
      modelSelectionSource: "task_profile",
      actualModel: "gpt-5.4",
    });
  });

  it("persists actual execution metadata when LLM error is gracefully degraded", async () => {
    const llmClient: FridayAgentLlmClient = {
      async *stream() {
        throw new Error("provider exploded");
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "route-default-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "Degrade while keeping execution audit",
      taskProfile: { id: "deterministic", model: "gpt-5.4-mini" },
    });

    const repo = createFridayAgentRunRepository();
    const run = db.withReadConnection((reader) => repo.getById(reader, result.runId));
    // First LLM error is now gracefully degraded — run fails with synthetic response
    expect(result.status).toBe("failed");
    expect(run?.actualExecution).toMatchObject({
      requestedModel: "gpt-5.4-mini",
      taskProfileId: "deterministic",
      taskProfileModel: "gpt-5.4-mini",
      modelSelectionSource: "task_profile",
    });
  });

  // ─── Boot recovery: resumeStaleRunsOnBoot ───

  it("marks stale runs as failed on boot", async () => {
    // Create a run and leave it in executing state (simulating crash)
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "Done" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 1, outputTokens: 1 },
      ],
    ]);

    const repo = createFridayAgentRunRepository();

    // Manually create a run stuck in "executing" state
    db.withWriteTransaction((writer) => {
      repo.create(writer, {
        id: "stale-run-1",
        task: "Stale task",
        sessionKey: "agent:run:stale-1",
        maxAttempts: 3,
        nowIso: NOW,
      });
      repo.update(writer, { id: "stale-run-1", status: "executing" });
    });

    // Also create a completed run (should not be affected)
    db.withWriteTransaction((writer) => {
      repo.create(writer, {
        id: "done-run-1",
        task: "Done task",
        sessionKey: "agent:run:done-1",
        maxAttempts: 3,
        nowIso: NOW,
      });
      repo.update(writer, { id: "done-run-1", status: "completed" });
    });

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const failedCount = runtime.resumeStaleRunsOnBoot();
    expect(failedCount).toBe(1);

    const staleRun = db.withReadConnection((reader) => repo.getById(reader, "stale-run-1"));
    expect(staleRun?.status).toBe("failed");
    expect(staleRun?.errorCode).toBe("AGENT_RUN_INTERRUPTED");
    expect(staleRun?.errorMessage).toContain("executing");

    const doneRun = db.withReadConnection((reader) => repo.getById(reader, "done-run-1"));
    expect(doneRun?.status).toBe("completed");
  });

  it("returns 0 when no stale runs exist", () => {
    const llmClient = createMockLlmClient([]);

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const failedCount = runtime.resumeStaleRunsOnBoot();
    expect(failedCount).toBe(0);
  });

  // ─── maxToolCalls enforcement ───

  it("fails when tool call limit is exceeded", async () => {
    // Create an LLM client that keeps requesting tool calls
    let callCount = 0;
    const infiniteToolClient: FridayAgentLlmClient = {
      async *stream() {
        callCount++;
        yield {
          type: "tool_use" as const,
          id: `tool-${String(callCount)}`,
          name: "echo",
          input: { message: "ping" },
        };
        yield {
          type: "message_end" as const,
          stopReason: "tool_use" as const,
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient: infiniteToolClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Test",
      tools: [createEchoTool()],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "Infinite loop test" });

    expect(result.status).toBe("failed");
    expect(result.toolCallCount).toBeGreaterThan(0);

    const repo = createFridayAgentRunRepository();
    const run = db.withReadConnection((reader) => repo.getById(reader, result.runId));
    // Should fail with either loop limit or tool call limit
    expect(["AGENT_LOOP_LIMIT", "AGENT_TOOL_CALL_LIMIT"]).toContain(run?.errorCode);
  });

  // ─── Inline image vision ───

  it("includes inline image blocks when images are provided", async () => {
    let capturedMessages: FridayAgentMessage[] | undefined;
    let capturedRequiredCapabilities: string[] | undefined;

    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        capturedRequiredCapabilities = params.routingContext?.requiredCapabilities;
        capturedMessages = params.messages.map((message) => ({
          role: message.role,
          content: typeof message.content === "string"
            ? message.content
            : JSON.parse(JSON.stringify(message.content)),
        }));
        yield { type: "text_delta", text: "I see the image" };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 20, outputTokens: 5 };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "What is in this image?",
      images: ["https://cdn.discord.com/attachments/123/456/screenshot.png"],
    });

    expect(result.status).toBe("completed");
    expect(result.response).toBe("I see the image");

    // Verify the user message has content blocks with text + image
    expect(capturedMessages).toBeDefined();
    const userMsg = capturedMessages!.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(Array.isArray(userMsg!.content)).toBe(true);

    const blocks = userMsg!.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "What is in this image?" });
    expect(blocks[1]).toEqual({
      type: "image",
      source: { type: "url", url: "https://cdn.discord.com/attachments/123/456/screenshot.png" },
    });
    expect(capturedRequiredCapabilities).toEqual(["vision"]);
  });

  it("sends plain string content when no images provided", async () => {
    let capturedMessages: FridayAgentMessage[] | undefined;

    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        capturedMessages = params.messages.map((message) => ({
          role: message.role,
          content: message.content,
        }));
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 4, outputTokens: 2 };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    await runtime.executeRun({ task: "Just text" });

    const userMsg = capturedMessages!.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(typeof userMsg!.content).toBe("string");
    expect(userMsg!.content).toBe("Just text");
  });

  // ─── Learning context enrichment (Layer 3 read path) ───

  it("does not append learned preferences to system prompt when principalId is provided", async () => {
    let capturedSystemPrompt = "";

    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        capturedSystemPrompt = params.systemPrompt;
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 2 };
      },
    };

    const learningContextBuilder = vi.fn().mockReturnValue({
      preferences: { language: "Chinese", tone: "formal" },
    });

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      learningContextBuilder,
    });

    await runtime.executeRun({ task: "Hello", principalId: "user-123" });

    expect(learningContextBuilder).toHaveBeenCalledWith({ userId: "user-123", nowIso: NOW });
    expect(capturedSystemPrompt).toBe("You are a test agent.");
  });

  it("awaits communicationPromptBuilder fragments before sending the prompt", async () => {
    let capturedSystemPrompt = "";

    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        capturedSystemPrompt = params.systemPrompt;
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 2 };
      },
    };

    const communicationPromptBuilder = vi.fn().mockResolvedValue("[Learned Preferences]\n- Remember canary: COMPACTION_CANARY");

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      communicationPromptBuilder,
    });

    await runtime.executeRun({ task: "Hello", principalId: "user-123" });

    expect(communicationPromptBuilder).toHaveBeenCalledWith({ userId: "user-123", nowIso: NOW });
    expect(capturedSystemPrompt).toContain("[Learned Preferences]");
    expect(capturedSystemPrompt).toContain("COMPACTION_CANARY");
  });

  it("injects persisted compaction context for the current session before the run and records replay evidence", async () => {
    let capturedSystemPrompt = "";

    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        capturedSystemPrompt = params.systemPrompt;
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 2 };
      },
    };

    const compactionContextBuilder = vi
      .fn()
      .mockResolvedValue({
        fragment: "[Previous Session Context]\nSummary: Discord channel wiring already validated.",
        blockCount: 1,
        sources: ["context_replay:entry-1"],
        sessionKey: "session-ctx-1",
        evidenceTier: "audit_replay_evidence",
        trustLevel: "unconfirmed_summary",
        source: "context_replay",
        memoryBoundary: "not_user_confirmed_memory",
        redactionApplied: true,
        redactionCount: 1,
        replayEntryIds: ["entry-1"],
      });
    const eventRepo = createFridayAgentRunEventRepository();

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      compactionContextBuilder,
      runEventRepository: eventRepo,
    });

    const result = await runtime.executeRun({ task: "Continue the task", principalId: "user-123", sessionKey: "session-ctx-1" });

    expect(compactionContextBuilder).toHaveBeenCalledWith({
      userId: "user-123",
      sessionKey: "session-ctx-1",
      nowIso: NOW,
    });
    expect(capturedSystemPrompt).toContain("[Previous Session Context]");
    expect(capturedSystemPrompt).toContain("Discord channel wiring already validated");
    const events = db.withReadConnection((reader) => eventRepo.list(reader, result.runId));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventName: "agent.run.context_replay_loaded",
          payload: expect.objectContaining({
            sessionKey: "session-ctx-1",
            evidenceTier: "audit_replay_evidence",
            trustLevel: "unconfirmed_summary",
            source: "context_replay",
            sourceCount: 1,
            blockCount: 1,
            memoryBoundary: "not_user_confirmed_memory",
            redactionApplied: true,
            redactionCount: 1,
            replayEntryIds: ["entry-1"],
          }),
        }),
      ]),
    );
  });

  it("does not inject compaction replay context for public isolated session runs", async () => {
    const llmClient: FridayAgentLlmClient = {
      async *stream() {
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 2 };
      },
    };
    const compactionContextBuilder = vi.fn().mockResolvedValue({
      fragment: "[Previous Session Context]\nPrivate summary",
      blockCount: 1,
      sources: ["context_replay:entry-1"],
      sessionKey: "session-public-ctx-1",
    });

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      compactionContextBuilder,
    });

    await runtime.executeRun({
      task: "Continue the task",
      sessionKey: "session-public-ctx-1",
      constraints: {
        readOnly: true,
        operationalMode: "restricted",
        dataSensitivity: "public",
      },
      disabledToolNames: [
        "read",
        "write",
        "edit",
        "exec",
        "pdf_parse",
        "image_analysis",
        "memory_search",
        "memory_query",
        "memory_get",
        "memory_store",
        "memory_extract",
        "feedback",
      ],
    });

    expect(compactionContextBuilder).not.toHaveBeenCalled();
  });

  it("records durable evidence when compaction replay persistence succeeds", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "ok" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 2 },
      ],
    ]);
    const eventRepo = createFridayAgentRunEventRepository();
    const compactionContextReplaySink = {
      persist: vi.fn().mockResolvedValue({
        persisted: true,
        entryId: "context-entry-1",
        sessionKey: "session-compaction-1",
        runId: "run-compaction-1",
        blockCount: 2,
        evidenceTier: "audit_replay_evidence",
        trustLevel: "unconfirmed_summary",
        redactionApplied: false,
        redactionCount: 0,
      }),
    };
    const compactionBridge = {
      compact: vi.fn().mockResolvedValue({
        compacted: true,
        messages: [{ role: "user", content: "Compacted context summary." }],
        summary: {
          summaryText: "The user validated context replay.",
          decisions: ["Keep replay outside memory"],
          todos: [],
          openQuestions: [],
          toolFailures: [],
          fileOperations: [],
        },
        blocks: [
          {
            id: "block-1",
            kind: "conversation_block",
            messageIds: ["m-1"],
            summaryText: "Block one.",
            decisions: [],
            todos: [],
            openQuestions: [],
            toolFailures: [],
            fileOperations: [],
          },
          {
            id: "block-2",
            kind: "conversation_block",
            messageIds: ["m-2"],
            summaryText: "Block two.",
            decisions: [],
            todos: [],
            openQuestions: [],
            toolFailures: [],
            fileOperations: [],
          },
        ],
        droppedMessageCount: 39,
        estimatedTokensBefore: 10_000,
        estimatedTokensAfter: 400,
      }),
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      runEventRepository: eventRepo,
      compactionBridge,
      compactionContextReplaySink,
    });

    await runtime.executeRun({
      runId: "run-compaction-1",
      task: "Continue with compaction",
      sessionKey: "session-compaction-1",
      historyMessages: Array.from({ length: 41 }, (_, index) => ({
        role: "user" as const,
        content: `history message ${index}`,
      })),
    });
    await flushAsyncEvents();

    expect(compactionContextReplaySink.persist).toHaveBeenCalledTimes(1);
    const events = db.withReadConnection((reader) => eventRepo.list(reader, "run-compaction-1"));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventName: "agent.run.compaction_persist_scheduled",
          payload: expect.objectContaining({
            sessionKey: "session-compaction-1",
            summaryPresent: true,
            blockCount: 2,
          }),
        }),
        expect.objectContaining({
          eventName: "agent.run.compaction_persisted",
          payload: expect.objectContaining({
            sessionKey: "session-compaction-1",
            entryId: "context-entry-1",
            evidenceTier: "audit_replay_evidence",
            trustLevel: "unconfirmed_summary",
            blockCount: 2,
          }),
        }),
      ]),
    );
  });

  it("records durable evidence when compaction replay persistence fails", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "ok" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 2 },
      ],
    ]);
    const eventRepo = createFridayAgentRunEventRepository();
    const compactionContextReplaySink = {
      persist: vi.fn().mockRejectedValue(new Error("sqlite write failed")),
    };
    const compactionBridge = {
      compact: vi.fn().mockResolvedValue({
        compacted: true,
        messages: [{ role: "user", content: "Compacted context summary." }],
        summary: {
          summaryText: "The user validated context replay.",
          decisions: [],
          todos: [],
          openQuestions: [],
          toolFailures: [],
          fileOperations: [],
        },
        blocks: [],
        droppedMessageCount: 39,
        estimatedTokensBefore: 10_000,
        estimatedTokensAfter: 400,
      }),
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      runEventRepository: eventRepo,
      compactionBridge,
      compactionContextReplaySink,
    });

    await runtime.executeRun({
      runId: "run-compaction-fail",
      task: "Continue with compaction",
      sessionKey: "session-compaction-fail",
      historyMessages: Array.from({ length: 41 }, (_, index) => ({
        role: "user" as const,
        content: `history message ${index}`,
      })),
    });
    await flushAsyncEvents();

    const events = db.withReadConnection((reader) => eventRepo.list(reader, "run-compaction-fail"));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventName: "agent.run.compaction_persist_failed",
          payload: expect.objectContaining({
            sessionKey: "session-compaction-fail",
            errorName: "Error",
            evidenceTier: "audit_replay_evidence",
            trustLevel: "unconfirmed_summary",
          }),
        }),
      ]),
    );
  });

  it("uses learned timezone preference when no explicit timezone is provided", async () => {
    let callCount = 0;
    const llmClient: FridayAgentLlmClient = {
      async *stream() {
        callCount++;
        if (callCount === 1) {
          yield {
            type: "tool_use",
            id: "call-1",
            name: "web_search",
            input: { query: "Iran latest news", freshness: "day", numResults: 3 },
          };
          yield { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 };
          return;
        }
        yield { type: "text_delta", text: "These are the top search hits I found." };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 9, outputTokens: 7 };
      },
    };

    const learningContextBuilder = vi.fn().mockReturnValue({
      preferences: {
        "pref:timezone": "America/Los_Angeles",
      },
    });

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [
        createSuccessfulWebSearchTool({
          metadata: {
            provider: "duckduckgo",
            freshnessRequested: "day",
            freshnessApplied: false,
            hasDates: false,
            warning: "DuckDuckGo HTML search does not provide verified recency filtering or stable publication dates; latest-ness is unverified.",
          },
        }),
      ],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => "2026-02-19T02:30:00.000Z",
      learningContextBuilder,
    });

    const result = await runtime.executeRun({
      task: "Give me the latest Iran news",
      principalId: "user-123",
    });

    expect(result.status).toBe("completed");
    expect(callCount).toBe(3);
    expect(result.response).toContain("2026-02-18 (America/Los_Angeles)");
  });

  it("does not enrich system prompt when no principalId is provided", async () => {
    let capturedSystemPrompt = "";

    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        capturedSystemPrompt = params.systemPrompt;
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 2 };
      },
    };

    const learningContextBuilder = vi.fn();

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      learningContextBuilder,
    });

    await runtime.executeRun({ task: "Hello" });

    expect(learningContextBuilder).not.toHaveBeenCalled();
    expect(capturedSystemPrompt).toBe("You are a test agent.");
  });

  it("calls contextEngine.afterTurn for terminal runs without changing the result", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "ok" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 2 },
      ],
    ]);
    const afterTurn = vi.fn();

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      contextEngine: {
        afterTurn,
      },
    });

    const result = await runtime.executeRun({
      task: "Hello",
      sessionKey: "session-123",
    });

    expect(result.status).toBe("completed");
    expect(afterTurn).toHaveBeenCalledWith(expect.objectContaining({
      runId: result.runId,
      sessionKey: "session-123",
      task: "Hello",
      response: "ok",
      status: "completed",
      summary: "ok",
    }));
  });

  it("does not enrich system prompt when preferences are empty", async () => {
    let capturedSystemPrompt = "";

    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        capturedSystemPrompt = params.systemPrompt;
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 2 };
      },
    };

    const learningContextBuilder = vi.fn().mockReturnValue({ preferences: {} });

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      learningContextBuilder,
    });

    await runtime.executeRun({ task: "Hello", principalId: "user-123" });

    expect(learningContextBuilder).toHaveBeenCalled();
    expect(capturedSystemPrompt).toBe("You are a test agent.");
  });

  it("gracefully handles learningContextBuilder throwing an error", async () => {
    let capturedSystemPrompt = "";

    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        capturedSystemPrompt = params.systemPrompt;
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 2 };
      },
    };

    const learningContextBuilder = vi.fn().mockImplementation(() => {
      throw new Error("DB connection lost");
    });

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      learningContextBuilder,
    });

    const result = await runtime.executeRun({ task: "Hello", principalId: "user-123" });

    expect(result.status).toBe("completed");
    expect(capturedSystemPrompt).toBe("You are a test agent.");
  });

  it("recovers rollback checkpoints after runtime restart", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-agent-runtime-checkpoint-"));
    const filePath = join(tempDir, "tracked.txt");
    writeFileSync(filePath, "before\n", "utf8");

    const llmClient = createMockLlmClient([
      [
        { type: "tool_use", id: "call-write", name: "write", input: { path: filePath, content: "after\n" } },
        { type: "message_end", stopReason: "tool_use", inputTokens: 5, outputTokens: 3 },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 2 },
      ],
    ]);

    const writeTool: FridayAgentToolDefinition = {
      name: "write",
      description: "Write file",
      parameters: {
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
      async execute(args) {
        writeFileSync(String(args.path), String(args.content), "utf8");
        return { content: "Written" };
      },
    };

    try {
      const runtimeA = createFridayAgentRuntime({
        db,
        llmClient,
        model: "test-model",
        providerId: "test-provider",
        systemPrompt: "Test",
        tools: [writeTool],
        eventEmitter: createFridayAgentEventEmitter(),
        idGenerator,
        nowIso: () => NOW,
        workdir: tempDir,
      });

      const result = await runtimeA.executeRun({ task: "Modify tracked file" });
      expect(readFileSync(filePath, "utf8")).toBe("after\n");
      expect(runtimeA.hasRollbackCheckpoint(result.runId)).toBe(true);

      const runtimeB = createFridayAgentRuntime({
        db,
        llmClient: createMockLlmClient([]),
        model: "test-model",
        providerId: "test-provider",
        systemPrompt: "Test",
        tools: [writeTool],
        eventEmitter: createFridayAgentEventEmitter(),
        idGenerator,
        nowIso: () => NOW,
        workdir: tempDir,
      });

      expect(runtimeB.hasRollbackCheckpoint(result.runId)).toBe(true);
      const rollback = runtimeB.rollbackRun(result.runId);
      expect(rollback).not.toBeNull();
      expect(rollback?.errors).toEqual([]);
      expect(rollback?.restoredCount).toBe(1);
      expect(readFileSync(filePath, "utf8")).toBe("before\n");
      expect(runtimeB.hasRollbackCheckpoint(result.runId)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("persists pack context metadata on agent runs", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "Hello, " },
        { type: "text_delta", text: "creator!" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 10, outputTokens: 5 },
      ],
    ]);
    const runRepo = createFridayAgentRunRepository();

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "Continue creator workflow",
      sessionKey: "chat:default:pack-context",
      executionContext: {
        surface: "chat",
        interactive: true,
        packId: "industry-creator-media",
      },
    });

    const run = db.withReadConnection((reader) => runRepo.getById(reader, result.runId));
    expect(run?.metadata).toEqual({
      packContext: {
        packId: "industry-creator-media",
        surface: "chat",
        updatedAt: NOW,
      },
    });
  });

  it("persists top-level surface metadata for non-pack runs", async () => {
    const llmClient = createMockLlmClient([
      [
        { type: "text_delta", text: "Hello!" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 6, outputTokens: 3 },
      ],
    ]);
    const runRepo = createFridayAgentRunRepository();

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "Open the settings surface",
      sessionKey: "settings:default:surface",
      executionContext: {
        surface: "settings",
        interactive: true,
      },
    });

    const run = db.withReadConnection((reader) => runRepo.getById(reader, result.runId));
    expect(run?.metadata).toEqual({
      surface: "settings",
    });
  });

});
