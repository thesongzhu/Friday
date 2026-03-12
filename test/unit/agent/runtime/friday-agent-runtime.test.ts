import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import {
  createFridayAgentRuntime,
  createFridayAgentEventEmitter,
  createFridayAgentRunRepository,
  createFridayAgentReviewGate,
  createFridayAgentRunEventRepository,
} from "#agent";
import type {
  FridayAgentLlmClient,
  FridayAgentMessage,
  FridayAgentLlmStreamEvent,
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
      task: "latest task",
      historyMessages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
      ],
    });

    expect(capturedMessages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "latest task" },
    ]);
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

  it("handles LLM errors gracefully", async () => {
    const llmClient: FridayAgentLlmClient = {
      async *stream() {
        throw new Error("LLM request failed");
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

    const result = await runtime.executeRun({ task: "Should fail" });

    expect(result.status).toBe("failed");
    expect(result.response).toContain("LLM request failed");
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

    const repo = createFridayAgentRunRepository();
    const run = db.withReadConnection((reader) => repo.getById(reader, result.runId));

    expect(run?.artifactDir).toBe("/tmp/.friday/agent-runs/test-run");
    expect(run?.artifacts).toBeDefined();
    expect(run!.artifacts!.length).toBeGreaterThan(0);
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

    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
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

  it("appends learned preferences to system prompt when principalId is provided", async () => {
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
    expect(capturedSystemPrompt).toContain("User preferences (learned from past interactions):");
    expect(capturedSystemPrompt).toContain("- language: Chinese");
    expect(capturedSystemPrompt).toContain("- tone: formal");
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
});
