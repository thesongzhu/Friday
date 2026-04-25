import { describe, it, expect, vi } from "vitest";
import { createFridayAgentLlmClient } from "#agent";
import type { FridayAgentLlmStreamEvent } from "#agent";
import {
  buildRealOpenAIResponsesTextSSE,
  buildRealOpenAIResponsesToolSSE,
} from "../../../_mocks/mock-llm-providers.js";

describe("FridayAgentLlmClient", () => {
  function createSSEStream(events: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const data = events.map((e) => `data: ${e}\n\n`).join("");
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(data));
        controller.close();
      },
    });
  }

  function createRawSSEStream(lines: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const data = lines.join("");
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(data));
        controller.close();
      },
    });
  }

  function createMockFetch(
    status: number,
    body: ReadableStream<Uint8Array> | null,
  ): typeof fetch {
    return vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve("error"),
      body,
    }) as unknown as typeof fetch;
  }

  // ─── Parses text_delta events ───

  it("parses text_delta events from SSE stream", async () => {
    const sseEvents = [
      JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 10 } } }),
      JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } }),
      JSON.stringify({ type: "content_block_stop", index: 0 }),
      JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
    ];

    const fetchImpl = createMockFetch(200, createSSEStream(sseEvents));
    const client = createFridayAgentLlmClient({
      baseUrl: "https://api.example.com",
      apiKey: "test-key",
      fetchImpl,
    });

    const events: FridayAgentLlmStreamEvent[] = [];
    const stream = client.stream({
      model: "test-model",
      systemPrompt: "You are a test.",
      messages: [{ role: "user", content: "Hi" }],
      tools: [],
      signal: new AbortController().signal,
    });

    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: "text_delta", text: "Hello" });
    expect(events[1]).toEqual({ type: "text_delta", text: " world" });
    expect(events[2]).toEqual({
      type: "message_end",
      stopReason: "end_turn",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  // ─── Parses tool_use events ───

  it("parses tool_use events from SSE stream", async () => {
    const sseEvents = [
      JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 15 } } }),
      JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name: "exec" } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":' } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"ls -la"}' } }),
      JSON.stringify({ type: "content_block_stop", index: 0 }),
      JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8 } }),
    ];

    const fetchImpl = createMockFetch(200, createSSEStream(sseEvents));
    const client = createFridayAgentLlmClient({
      baseUrl: "https://api.example.com",
      apiKey: "test-key",
      fetchImpl,
    });

    const events: FridayAgentLlmStreamEvent[] = [];
    const stream = client.stream({
      model: "test-model",
      systemPrompt: "Test",
      messages: [{ role: "user", content: "Run ls" }],
      tools: [{
        name: "exec",
        description: "Execute shell",
        parameters: { properties: { command: { type: "string" } } },
        async execute() { return { content: "ok" }; },
      }],
      signal: new AbortController().signal,
    });

    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "tool_use",
      id: "tool-1",
      name: "exec",
      input: { command: "ls -la" },
    });
    expect(events[1]).toEqual({
      type: "message_end",
      stopReason: "tool_use",
      inputTokens: 15,
      outputTokens: 8,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  // ─── Throws on non-OK response ───

  it("throws on non-OK HTTP response", async () => {
    const fetchImpl = createMockFetch(401, null);
    const client = createFridayAgentLlmClient({
      baseUrl: "https://api.example.com",
      apiKey: "bad-key",
      fetchImpl,
    });

    const stream = client.stream({
      model: "test-model",
      systemPrompt: "Test",
      messages: [{ role: "user", content: "Hi" }],
      tools: [],
      signal: new AbortController().signal,
    });

    const events: FridayAgentLlmStreamEvent[] = [];
    await expect(async () => {
      for await (const event of stream) {
        events.push(event);
      }
    }).rejects.toThrow("LLM request failed (401)");
  });

  it("streams bounded provider error bodies instead of buffering full text", async () => {
    const response = new Response("x".repeat(5000), { status: 502 });
    const textSpy = vi.spyOn(response, "text");
    const fetchImpl = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
    const client = createFridayAgentLlmClient({
      baseUrl: "https://api.example.com",
      apiKey: "test-key",
      fetchImpl,
    });

    const stream = client.stream({
      model: "test-model",
      systemPrompt: "Test",
      messages: [{ role: "user", content: "Hi" }],
      tools: [],
      signal: new AbortController().signal,
    });

    await expect(async () => {
      for await (const _event of stream) {
        // no events expected
      }
    }).rejects.toThrow("[truncated]");
    expect(textSpy).not.toHaveBeenCalled();
  });

  // ─── Sends correct request format ───

  it("sends correct Anthropic API request", async () => {
    const sseEvents = [
      JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1 } } }),
      JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
    ];

    const fetchImpl = createMockFetch(200, createSSEStream(sseEvents));
    const client = createFridayAgentLlmClient({
      baseUrl: "https://api.example.com",
      apiKey: "test-key",
      fetchImpl,
    });

    const stream = client.stream({
      model: "claude-3",
      systemPrompt: "System prompt here",
      messages: [{ role: "user", content: "Hello" }],
      tools: [{
        name: "read",
        description: "Read file",
        parameters: { properties: { path: { type: "string" } } },
        async execute() { return { content: "" }; },
      }],
      signal: new AbortController().signal,
    });

    for await (const _event of stream) {
      // drain
    }

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, options] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/messages");
    expect(options.method).toBe("POST");

    const headers = options.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");

    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body.model).toBe("claude-3");
    expect(body.system).toEqual([{ type: "text", text: "System prompt here" }]);
    expect(body.stream).toBe(true);

    const tools = body.tools as Array<{ name: string; input_schema: unknown }>;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("read");
    expect(tools[0].input_schema).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
    });
  });

  it("uses Bearer auth and Claude OAuth headers for Anthropic OAuth", async () => {
    const sseEvents = [
      JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1 } } }),
      JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
    ];

    const fetchImpl = createMockFetch(200, createSSEStream(sseEvents));
    const client = createFridayAgentLlmClient({
      baseUrl: "https://api.anthropic.com",
      apiKey: "oauth-access-token", // pragma: allowlist secret
      api: "anthropic-messages",
      authMode: "oauth",
      fetchImpl,
    });

    const stream = client.stream({
      model: "claude-sonnet-4-20250514",
      systemPrompt: "System prompt here",
      messages: [{ role: "user", content: "Hello" }],
      tools: [],
      signal: new AbortController().signal,
    });

    for await (const _event of stream) {
      // drain
    }

    const [, options] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer oauth-access-token");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["anthropic-beta"]).toContain("oauth-2025-04-20");
    expect(headers["anthropic-beta"]).toContain("claude-code-20250219");

    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body.system).toEqual([
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text", text: "System prompt here" },
    ]);
  });

  // ─── Anthropic model extraction ───

  it("extracts model from Anthropic message_start event", async () => {
    const sseEvents = [
      JSON.stringify({ type: "message_start", message: { model: "claude-sonnet-4-20250514", usage: { input_tokens: 10 } } }),
      JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }),
      JSON.stringify({ type: "content_block_stop", index: 0 }),
      JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
    ];

    const fetchImpl = createMockFetch(200, createSSEStream(sseEvents));
    const client = createFridayAgentLlmClient({
      baseUrl: "https://api.example.com",
      apiKey: "test-key",
      fetchImpl,
    });

    const events: FridayAgentLlmStreamEvent[] = [];
    for await (const event of client.stream({
      model: "claude-sonnet-4-20250514",
      systemPrompt: "Test",
      messages: [{ role: "user", content: "Hi" }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    const messageEnd = events.find((e) => e.type === "message_end");
    expect(messageEnd).toBeDefined();
    expect(messageEnd!.type).toBe("message_end");
    if (messageEnd!.type === "message_end") {
      expect(messageEnd!.actualModel).toBe("claude-sonnet-4-20250514");
      expect(messageEnd!.actualProviderKind).toBe("anthropic");
      expect(messageEnd!.actualProviderApi).toBe("anthropic-messages");
    }
  });

  it("omits model fields when message_start has no model", async () => {
    const sseEvents = [
      JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1 } } }),
      JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
    ];

    const fetchImpl = createMockFetch(200, createSSEStream(sseEvents));
    const client = createFridayAgentLlmClient({
      baseUrl: "https://api.example.com",
      apiKey: "test-key",
      fetchImpl,
    });

    const events: FridayAgentLlmStreamEvent[] = [];
    for await (const event of client.stream({
      model: "test-model",
      systemPrompt: "Test",
      messages: [{ role: "user", content: "Hi" }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    const messageEnd = events.find((e) => e.type === "message_end");
    expect(messageEnd).toEqual({
      type: "message_end",
      stopReason: "end_turn",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  it("formats OpenAI Responses tools with top-level name/parameters", async () => {
    const sseEvents = ["[DONE]"];
    const fetchImpl = createMockFetch(200, createSSEStream(sseEvents));
    const client = createFridayAgentLlmClient({
      baseUrl: "https://api.openai.com",
      apiKey: "test-key",
      api: "openai-responses",
      fetchImpl,
    });

    const stream = client.stream({
      model: "gpt-4o-mini",
      systemPrompt: "System prompt",
      messages: [{ role: "user", content: "hello" }],
      tools: [{
        name: "browser",
        description: "Browser tool",
        parameters: {
          properties: {
            values: { type: "array" },
          },
        },
        async execute() { return { content: "" }; },
      }],
      signal: new AbortController().signal,
    });

    for await (const _event of stream) {
      // drain
    }

    const [, options] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.type).toBe("function");
    expect(tools[0]?.name).toBe("browser");
    expect(tools[0]?.function).toBeUndefined();
    const parameters = tools[0]?.parameters as Record<string, unknown>;
    const props = parameters.properties as Record<string, unknown>;
    const values = props.values as Record<string, unknown>;
    expect(values.type).toBe("array");
    expect(values.items).toBeDefined();
  });

  it("maps assistant tool_use and user tool_result history into OpenAI Responses function-call items", async () => {
    const sseEvents = ["[DONE]"];
    const fetchImpl = createMockFetch(200, createSSEStream(sseEvents));
    const client = createFridayAgentLlmClient({
      baseUrl: "https://api.openai.com",
      apiKey: "test-key",
      api: "openai-responses",
      fetchImpl,
    });

    const stream = client.stream({
      model: "gpt-4o-mini",
      systemPrompt: "System prompt",
      messages: [
        { role: "user", content: "What should you call me?" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call-memory-1", name: "memory_search", input: { query: "user name", limit: 1 } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call-memory-1", content: "[{\"content\":\"Captain Friday\"}]" },
          ],
        },
      ],
      tools: [{
        name: "memory_search",
        description: "Memory search tool",
        parameters: {
          properties: {
            query: { type: "string" },
          },
        },
        async execute() { return { content: "" }; },
      }],
      signal: new AbortController().signal,
    });

    for await (const _event of stream) {
      // drain
    }

    const [, options] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    const input = body.input as Array<Record<string, unknown>>;

    expect(input).toEqual([
      {
        role: "system",
        content: [{ type: "input_text", text: "System prompt" }],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: "What should you call me?" }],
      },
      {
        type: "function_call",
        call_id: "call-memory-1",
        name: "memory_search",
        arguments: JSON.stringify({ query: "user name", limit: 1 }),
      },
      {
        type: "function_call_output",
        call_id: "call-memory-1",
        output: "[{\"content\":\"Captain Friday\"}]",
      },
    ]);
  });

  it("parses real OpenAI Responses text SSE shape", async () => {
    const fetchImpl = createMockFetch(200, createRawSSEStream(
      buildRealOpenAIResponsesTextSSE("Hello from responses"),
    ));
    const client = createFridayAgentLlmClient({
      baseUrl: "https://api.openai.com",
      apiKey: "test-key",
      api: "openai-responses",
      fetchImpl,
    });

    const events: FridayAgentLlmStreamEvent[] = [];
    for await (const event of client.stream({
      model: "gpt-4.1-mini",
      systemPrompt: "Test",
      messages: [{ role: "user", content: "Say hello" }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text_delta", text: "Hello from responses" },
      {
        type: "message_end",
        stopReason: "end_turn",
        inputTokens: 10,
        outputTokens: 3,
      },
    ]);
  });

  it("falls back to completed OpenAI Responses message content when no text deltas are emitted", async () => {
    const rawLines = [
      "data: " + JSON.stringify({
        type: "response.output_item.added",
        item: {
          id: "msg_done_only",
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [],
        },
      }) + "\n\n",
      "data: " + JSON.stringify({
        type: "response.output_item.done",
        item: {
          id: "msg_done_only",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "OK" }],
        },
      }) + "\n\n",
      "data: " + JSON.stringify({
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 9,
            output_tokens: 1,
          },
        },
      }) + "\n\n",
    ];
    const fetchImpl = createMockFetch(200, createRawSSEStream(rawLines));
    const client = createFridayAgentLlmClient({
      baseUrl: "https://api.openai.com",
      apiKey: "test-key",
      api: "openai-responses",
      fetchImpl,
    });

    const events: FridayAgentLlmStreamEvent[] = [];
    for await (const event of client.stream({
      model: "gpt-4.1-mini",
      systemPrompt: "Test",
      messages: [{ role: "user", content: "Reply with OK only." }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text_delta", text: "OK" },
      {
        type: "message_end",
        stopReason: "end_turn",
        inputTokens: 9,
        outputTokens: 1,
      },
    ]);
  });

  it("parses the final OpenAI Responses event even when the stream closes without a trailing newline", async () => {
    const rawLines = [
      "data: " + JSON.stringify({
        type: "response.output_item.added",
        item: {
          id: "msg_no_newline",
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [],
        },
      }) + "\n\n",
      "data: " + JSON.stringify({
        type: "response.output_item.done",
        item: {
          id: "msg_no_newline",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "FILE_NOT_FOUND" }],
        },
      }) + "\n\n",
      "data: " + JSON.stringify({
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 14,
            output_tokens: 2,
          },
        },
      }),
    ];
    const fetchImpl = createMockFetch(200, createRawSSEStream(rawLines));
    const client = createFridayAgentLlmClient({
      baseUrl: "https://api.openai.com",
      apiKey: "test-key",
      api: "openai-responses",
      fetchImpl,
    });

    const events: FridayAgentLlmStreamEvent[] = [];
    for await (const event of client.stream({
      model: "gpt-4.1-mini",
      systemPrompt: "Test",
      messages: [{ role: "user", content: "Read the missing file and answer exactly FILE_NOT_FOUND." }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text_delta", text: "FILE_NOT_FOUND" },
      {
        type: "message_end",
        stopReason: "end_turn",
        inputTokens: 14,
        outputTokens: 2,
      },
    ]);
  });

  it("parses OpenAI Responses refusal events as assistant text", async () => {
    const rawLines = [
      "data: " + JSON.stringify({
        type: "response.output_item.added",
        item: {
          id: "msg_refusal",
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [],
        },
      }) + "\n\n",
      "data: " + JSON.stringify({
        type: "response.refusal.delta",
        item_id: "msg_refusal",
        delta: "I'm sorry, ",
      }) + "\n\n",
      "data: " + JSON.stringify({
        type: "response.refusal.done",
        item_id: "msg_refusal",
        refusal: "I'm sorry, but I can't do that.",
      }) + "\n\n",
      "data: " + JSON.stringify({
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 15,
            output_tokens: 8,
          },
        },
      }) + "\n\n",
    ];
    const fetchImpl = createMockFetch(200, createRawSSEStream(rawLines));
    const client = createFridayAgentLlmClient({
      baseUrl: "https://api.openai.com",
      apiKey: "test-key",
      api: "openai-responses",
      fetchImpl,
    });

    const events: FridayAgentLlmStreamEvent[] = [];
    for await (const event of client.stream({
      model: "gpt-4.1-mini",
      systemPrompt: "Test",
      messages: [{ role: "user", content: "Answer with exactly OK." }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text_delta", text: "I'm sorry, " },
      { type: "text_delta", text: "but I can't do that." },
      {
        type: "message_end",
        stopReason: "end_turn",
        inputTokens: 15,
        outputTokens: 8,
      },
    ]);
  });

  it("parses OpenAI Responses content_part.done text when no output_text events are emitted", async () => {
    const rawLines = [
      "data: " + JSON.stringify({
        type: "response.output_item.added",
        item: {
          id: "msg_content_part",
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [],
        },
      }) + "\n\n",
      "data: " + JSON.stringify({
        type: "response.content_part.done",
        item_id: "msg_content_part",
        part: {
          type: "output_text",
          text: "AUTOMATION_OK",
        },
      }) + "\n\n",
      "data: " + JSON.stringify({
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 12,
            output_tokens: 3,
          },
        },
      }) + "\n\n",
    ];
    const fetchImpl = createMockFetch(200, createRawSSEStream(rawLines));
    const client = createFridayAgentLlmClient({
      baseUrl: "https://api.openai.com",
      apiKey: "test-key",
      api: "openai-responses",
      fetchImpl,
    });

    const events: FridayAgentLlmStreamEvent[] = [];
    for await (const event of client.stream({
      model: "gpt-4.1-mini",
      systemPrompt: "Test",
      messages: [{ role: "user", content: "Reply with exactly AUTOMATION_OK." }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text_delta", text: "AUTOMATION_OK" },
      {
        type: "message_end",
        stopReason: "end_turn",
        inputTokens: 12,
        outputTokens: 3,
      },
    ]);
  });

  it("throws when OpenAI Responses emits response.failed", async () => {
    const rawLines = [
      "data: " + JSON.stringify({
        type: "response.failed",
        response: {
          error: {
            code: "rate_limit_exceeded",
            message: "Rate limit reached.",
          },
        },
      }) + "\n\n",
    ];
    const fetchImpl = createMockFetch(200, createRawSSEStream(rawLines));
    const client = createFridayAgentLlmClient({
      baseUrl: "https://api.openai.com",
      apiKey: "test-key",
      api: "openai-responses",
      fetchImpl,
    });

    const consume = async () => {
      for await (const _event of client.stream({
        model: "gpt-4.1-mini",
        systemPrompt: "Test",
        messages: [{ role: "user", content: "Say hi" }],
        tools: [],
        signal: new AbortController().signal,
      })) {
        // drain
      }
    };

    await expect(consume()).rejects.toThrow(/rate_limit_exceeded/);
  });

  it("parses real OpenAI Responses function-call SSE shape", async () => {
    const fetchImpl = createMockFetch(200, createRawSSEStream(
      buildRealOpenAIResponsesToolSSE("browser", { command: "open /tmp/demo" }, "call_real_1"),
    ));
    const client = createFridayAgentLlmClient({
      baseUrl: "https://api.openai.com",
      apiKey: "test-key",
      api: "openai-responses",
      fetchImpl,
    });

    const events: FridayAgentLlmStreamEvent[] = [];
    for await (const event of client.stream({
      model: "gpt-4.1-mini",
      systemPrompt: "Test",
      messages: [{ role: "user", content: "Open the demo" }],
      tools: [{
        name: "browser",
        description: "Browser tool",
        parameters: {
          properties: {
            command: { type: "string" },
          },
        },
        async execute() { return { content: "" }; },
      }],
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "tool_use",
        id: "call_real_1",
        name: "browser",
        input: { command: "open /tmp/demo" },
      },
      {
        type: "message_end",
        stopReason: "tool_use",
        inputTokens: 10,
        outputTokens: 10,
      },
    ]);
  });

  it("waits for a non-empty tool name before emitting OpenAI Responses tool calls", async () => {
    const rawLines = [
      "data: " + JSON.stringify({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: "call_late_name",
          arguments: "{\"action\":\"start\"}",
        },
      }) + "\n\n",
      "data: " + JSON.stringify({
        type: "response.output_item.added",
        item: {
          type: "function_call",
          call_id: "call_late_name",
          name: "skill_generate",
        },
      }) + "\n\n",
      "data: " + JSON.stringify({
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 11,
            output_tokens: 4,
          },
        },
      }) + "\n\n",
    ];
    const fetchImpl = createMockFetch(200, createRawSSEStream(rawLines));
    const client = createFridayAgentLlmClient({
      baseUrl: "https://api.openai.com",
      apiKey: "test-key",
      api: "openai-responses",
      fetchImpl,
    });

    const events: FridayAgentLlmStreamEvent[] = [];
    for await (const event of client.stream({
      model: "gpt-4.1-mini",
      systemPrompt: "Test",
      messages: [{ role: "user", content: "Generate a skill" }],
      tools: [{
        name: "skill_generate",
        description: "Generate a Friday skill",
        parameters: {
          properties: {
            action: { type: "string" },
          },
        },
        async execute() { return { content: "" }; },
      }],
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "tool_use",
        id: "call_late_name",
        name: "skill_generate",
        input: { action: "start" },
      },
      {
        type: "message_end",
        stopReason: "tool_use",
        inputTokens: 11,
        outputTokens: 4,
      },
    ]);
  });

  it("merges OpenAI Responses item ids with call ids for function-call deltas", async () => {
    const rawLines = [
      "data: " + JSON.stringify({
        type: "response.output_item.added",
        item: {
          id: "fc_real_1",
          type: "function_call",
          status: "in_progress",
          call_id: "call_real_1",
          name: "skill_generate",
          arguments: "",
        },
      }) + "\n\n",
      "data: " + JSON.stringify({
        type: "response.function_call_arguments.delta",
        item_id: "fc_real_1",
        delta: "{\"action\":\"start\",\"goal\":\"Create an otter skill\"}",
      }) + "\n\n",
      "data: " + JSON.stringify({
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 12,
            output_tokens: 6,
          },
        },
      }) + "\n\n",
    ];
    const fetchImpl = createMockFetch(200, createRawSSEStream(rawLines));
    const client = createFridayAgentLlmClient({
      baseUrl: "https://api.openai.com",
      apiKey: "test-key",
      api: "openai-responses",
      fetchImpl,
    });

    const events: FridayAgentLlmStreamEvent[] = [];
    for await (const event of client.stream({
      model: "gpt-4.1-mini",
      systemPrompt: "Test",
      messages: [{ role: "user", content: "Generate a skill" }],
      tools: [{
        name: "skill_generate",
        description: "Generate a Friday skill",
        parameters: {
          properties: {
            action: { type: "string" },
            goal: { type: "string" },
          },
        },
        async execute() { return { content: "" }; },
      }],
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "tool_use",
        id: "call_real_1",
        name: "skill_generate",
        input: {
          action: "start",
          goal: "Create an otter skill",
        },
      },
      {
        type: "message_end",
        stopReason: "tool_use",
        inputTokens: 12,
        outputTokens: 6,
      },
    ]);
  });

  it("formats OpenAI Chat Completions tools with nested function field", async () => {
    const sseEvents = [JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })];
    const fetchImpl = createMockFetch(200, createSSEStream([...sseEvents, "[DONE]"]));
    const client = createFridayAgentLlmClient({
      baseUrl: "https://api.openai.com",
      apiKey: "test-key",
      api: "openai-completions",
      fetchImpl,
    });

    const stream = client.stream({
      model: "gpt-4o-mini",
      systemPrompt: "System prompt",
      messages: [{ role: "user", content: "hello" }],
      tools: [{
        name: "browser",
        description: "Browser tool",
        parameters: {
          properties: {
            values: { type: "array" },
          },
        },
        async execute() { return { content: "" }; },
      }],
      signal: new AbortController().signal,
    });

    for await (const _event of stream) {
      // drain
    }

    const [, options] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    const tools = body.tools as Array<Record<string, unknown>>;
    const streamOptions = body.stream_options as Record<string, unknown>;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.type).toBe("function");
    const fn = tools[0]?.function as Record<string, unknown>;
    expect(fn.name).toBe("browser");
    expect(streamOptions.include_usage).toBe(true);
    const parameters = fn.parameters as Record<string, unknown>;
    const props = parameters.properties as Record<string, unknown>;
    const values = props.values as Record<string, unknown>;
    expect(values.type).toBe("array");
    expect(values.items).toBeDefined();
  });

  // ─── Image content block mapping ───

  it("maps image content blocks to OpenAI image_url format", async () => {
    const sseEvents = [JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })];
    const fetchImpl = createMockFetch(200, createSSEStream([...sseEvents, "[DONE]"]));
    const client = createFridayAgentLlmClient({
      baseUrl: "https://api.openai.com",
      apiKey: "test-key",
      api: "openai-completions",
      fetchImpl,
    });

    const stream = client.stream({
      model: "gpt-4o",
      systemPrompt: "System",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image", source: { type: "url", url: "https://example.com/img.png" } },
        ],
      }],
      tools: [],
      signal: new AbortController().signal,
    });

    for await (const _event of stream) {
      // drain
    }

    const [, options] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    const messages = body.messages as Array<{ role: string; content: unknown }>;

    // Find user message (after system message)
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(Array.isArray(userMsg!.content)).toBe(true);

    const content = userMsg!.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "What is this?" });
    expect(content[1]).toEqual({ type: "image_url", image_url: { url: "https://example.com/img.png" } });
  });
});
