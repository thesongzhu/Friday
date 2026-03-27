/**
 * Mock LLM provider factory for deterministic E2E tests.
 *
 * Supports all 5 FridayProviderApi types with protocol-accurate responses.
 * Uses pure fetch interception — no external dependencies.
 */

import type {
  FridayProviderApi,
} from "../../src/providers/model/friday-provider.types.js";

// ─── Reply types ───

export type MockLlmReply =
  | { type: "text"; text: string; status?: number; latencyMs?: number }
  | {
      type: "tool_use";
      toolName: string;
      toolInput: Record<string, unknown>;
      toolCallId?: string;
      textAfterTool?: string;
      latencyMs?: number;
    }
  | {
      type: "http_error";
      status: number;
      body?: unknown;
      headers?: HeadersInit;
      latencyMs?: number;
    }
  | {
      type: "network_error";
      message: string;
      code?: string;
      latencyMs?: number;
    }
  | {
      type: "timeout";
      message?: string;
      code?: "ETIMEDOUT" | "ECONNRESET";
      latencyMs?: number;
    };

// ─── Call recording ───

export interface MockFetchCall {
  api: FridayProviderApi;
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyRaw?: string;
  bodyJson?: unknown;
  atIso: string;
}

// ─── MockFetch interface ───

export interface MockFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  calls: MockFetchCall[];
  enqueue: (...replies: MockLlmReply[]) => void;
  setDefault: (reply: MockLlmReply) => void;
  reset: () => void;
}

// ─── Deterministic ID counters ───

let _msgCounter = 0;
let _callCounter = 0;

export function resetMockCounters(): void {
  _msgCounter = 0;
  _callCounter = 0;
}

function nextMsgId(): string {
  _msgCounter += 1;
  return `mock_msg_${_msgCounter}`;
}

function nextCallId(): string {
  _callCounter += 1;
  return `mock_call_${_callCounter}`;
}

// ─── SSE helper ───

function sseResponse(lines: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ─── Anthropic Messages SSE builder ───

function buildAnthropicTextSSE(text: string): string[] {
  const msgId = nextMsgId();
  return [
    `event: message_start\ndata: {"type":"message_start","message":{"id":"${msgId}","type":"message","role":"assistant","content":[],"model":"mock-anthropic","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}\n\n`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":${text.split(" ").length}}}\n\n`,
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
  ];
}

function buildAnthropicToolSSE(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolCallId?: string,
  textAfterTool?: string,
): string[] {
  const id = toolCallId ?? nextCallId();
  const inputJson = JSON.stringify(toolInput);
  const lines: string[] = [
    `event: message_start\ndata: {"type":"message_start","message":{"id":"${nextMsgId()}","type":"message","role":"assistant","content":[],"model":"mock-anthropic","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"${id}","name":"${toolName}"}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":${JSON.stringify(inputJson)}}}\n\n`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
  ];

  if (textAfterTool) {
    lines.push(
      `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":${JSON.stringify(textAfterTool)}}}\n\n`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n`,
    );
  }

  lines.push(
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":10}}\n\n`,
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
  );

  return lines;
}

// ─── OpenAI Completions SSE builder ───

function buildOpenAICompletionsTextSSE(text: string): string[] {
  const id = `chatcmpl_${nextMsgId()}`;
  return [
    `data: {"id":"${id}","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":${JSON.stringify(text)}},"finish_reason":null}]}\n\n`,
    // Usage chunk with finish_reason: null — terminal "stop" is validated in non-streaming JSON path.
    // The SSE parser uses [DONE] sentinel for message_end emission.
    `data: {"id":"${id}","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":null}],"usage":{"prompt_tokens":10,"completion_tokens":${text.split(" ").length}}}\n\n`,
    `data: [DONE]\n\n`,
  ];
}

function buildOpenAICompletionsToolSSE(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolCallId?: string,
): string[] {
  const id = `chatcmpl_${nextMsgId()}`;
  const callId = toolCallId ?? nextCallId();
  const argsJson = JSON.stringify(toolInput);
  return [
    `data: {"id":"${id}","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"${callId}","type":"function","function":{"name":"${toolName}","arguments":""}}]},"finish_reason":null}]}\n\n`,
    `data: {"id":"${id}","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":${JSON.stringify(argsJson)}}}]},"finish_reason":null}]}\n\n`,
    // Usage chunk — terminal "tool_calls" finish_reason validated in non-streaming JSON path.
    `data: {"id":"${id}","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":null}],"usage":{"prompt_tokens":10,"completion_tokens":10}}\n\n`,
    `data: [DONE]\n\n`,
  ];
}

// ─── OpenAI Responses SSE builder ───
// The agent runtime consumes the real Responses SSE protocol.
// The provider inference client still uses non-streaming JSON.

export function buildRealOpenAIResponsesTextSSE(text: string): string[] {
  const responseId = `resp_${nextMsgId()}`;
  const messageId = `msg_${nextMsgId()}`;
  const outputTokens = text.split(" ").length;
  return [
    `event: response.created\ndata: {"type":"response.created","response":{"id":"${responseId}","status":"in_progress"}}\n\n`,
    `event: response.output_item.added\ndata: {"type":"response.output_item.added","response_id":"${responseId}","output_index":0,"item":{"id":"${messageId}","type":"message","status":"in_progress","role":"assistant","content":[]}}\n\n`,
    `event: response.content_part.added\ndata: {"type":"response.content_part.added","item_id":"${messageId}","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}\n\n`,
    `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"${messageId}","output_index":0,"content_index":0,"delta":${JSON.stringify(text)}}\n\n`,
    `event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"${messageId}","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":${JSON.stringify(text)}}]}}\n\n`,
    `event: response.completed\ndata: {"type":"response.completed","response":{"id":"${responseId}","status":"completed","usage":{"input_tokens":10,"output_tokens":${outputTokens}}}}\n\n`,
  ];
}

export function buildRealOpenAIResponsesToolSSE(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolCallId?: string,
): string[] {
  const responseId = `resp_${nextMsgId()}`;
  const callId = toolCallId ?? nextCallId();
  const argsJson = JSON.stringify(toolInput);
  const midpoint = Math.max(1, Math.floor(argsJson.length / 2));
  const firstDelta = argsJson.slice(0, midpoint);
  const secondDelta = argsJson.slice(midpoint);
  return [
    `event: response.created\ndata: {"type":"response.created","response":{"id":"${responseId}","status":"in_progress"}}\n\n`,
    `event: response.output_item.added\ndata: {"type":"response.output_item.added","response_id":"${responseId}","output_index":0,"item":{"id":"${callId}","type":"function_call","status":"in_progress","call_id":"${callId}","name":"${toolName}","arguments":""}}\n\n`,
    `event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"${callId}","output_index":0,"delta":${JSON.stringify(firstDelta)}}\n\n`,
    `event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"${callId}","output_index":0,"delta":${JSON.stringify(secondDelta)}}\n\n`,
    `event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"${callId}","type":"function_call","status":"completed","call_id":"${callId}","name":"${toolName}","arguments":${JSON.stringify(argsJson)}}}\n\n`,
    `event: response.completed\ndata: {"type":"response.completed","response":{"id":"${responseId}","status":"completed","usage":{"input_tokens":10,"output_tokens":10}}}\n\n`,
  ];
}

function buildOpenAIResponsesTextSSE(text: string): string[] {
  return buildRealOpenAIResponsesTextSSE(text);
}

function buildOpenAIResponsesToolSSE(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolCallId?: string,
): string[] {
  return buildRealOpenAIResponsesToolSSE(toolName, toolInput, toolCallId);
}

// ─── Google Generative AI JSON builder ───

function buildGoogleTextJson(text: string): Record<string, unknown> {
  return {
    candidates: [
      {
        content: { role: "model", parts: [{ text }] },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: text.split(" ").length,
      totalTokenCount: 10 + text.split(" ").length,
    },
  };
}

function buildGoogleToolJson(
  toolName: string,
  toolInput: Record<string, unknown>,
): Record<string, unknown> {
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ functionCall: { name: toolName, args: toolInput } }],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 10,
      totalTokenCount: 20,
    },
  };
}

// ─── Ollama JSON builder ───

function buildOllamaTextJson(text: string): Record<string, unknown> {
  return {
    model: "mock-ollama",
    created_at: "2026-02-20T00:00:00.000Z",
    message: { role: "assistant", content: text },
    done: true,
    prompt_eval_count: 10,
    eval_count: text.split(" ").length,
  };
}

function buildOllamaToolJson(
  toolName: string,
  toolInput: Record<string, unknown>,
): Record<string, unknown> {
  return {
    model: "mock-ollama",
    created_at: "2026-02-20T00:00:00.000Z",
    message: {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          function: { name: toolName, arguments: toolInput },
        },
      ],
    },
    done: true,
    prompt_eval_count: 10,
    eval_count: 10,
  };
}

// ─── Non-streaming JSON builders for SSE-capable APIs ───

function buildAnthropicTextJson(text: string): Record<string, unknown> {
  return {
    id: nextMsgId(),
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: "mock-anthropic",
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: text.split(" ").length },
  };
}

function buildAnthropicToolJson(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolCallId?: string,
): Record<string, unknown> {
  return {
    id: nextMsgId(),
    type: "message",
    role: "assistant",
    content: [
      { type: "tool_use", id: toolCallId ?? nextCallId(), name: toolName, input: toolInput },
    ],
    model: "mock-anthropic",
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

function buildOpenAICompletionsTextJson(text: string): Record<string, unknown> {
  return {
    id: `chatcmpl_${nextMsgId()}`,
    object: "chat.completion",
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 10, completion_tokens: text.split(" ").length },
  };
}

function buildOpenAICompletionsToolJson(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolCallId?: string,
): Record<string, unknown> {
  const callId = toolCallId ?? nextCallId();
  return {
    id: `chatcmpl_${nextMsgId()}`,
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: callId, type: "function", function: { name: toolName, arguments: JSON.stringify(toolInput) } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  };
}

function buildOpenAIResponsesTextJson(text: string): Record<string, unknown> {
  return {
    id: `resp_${nextMsgId()}`,
    object: "response",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: text.split(" ").length },
  };
}

function buildOpenAIResponsesToolJson(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolCallId?: string,
): Record<string, unknown> {
  const callId = toolCallId ?? nextCallId();
  return {
    id: `resp_${nextMsgId()}`,
    object: "response",
    output: [
      {
        type: "function_call",
        id: callId,
        name: toolName,
        arguments: JSON.stringify(toolInput),
      },
    ],
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

// ─── Build response for a given API + reply ───

function buildResponse(api: FridayProviderApi, reply: MockLlmReply, isStreaming: boolean): Response {
  if (reply.type === "http_error") {
    const body = reply.body ?? { error: { message: `Mock HTTP error ${reply.status}` } };
    return new Response(JSON.stringify(body), {
      status: reply.status,
      headers: {
        "content-type": "application/json",
        ...(reply.headers ? Object.fromEntries(new Headers(reply.headers).entries()) : {}),
      },
    });
  }

  // Network error and timeout are thrown, not returned as Response
  if (reply.type === "network_error") {
    throw Object.assign(new Error(reply.message), { code: reply.code ?? "ECONNREFUSED" });
  }

  if (reply.type === "timeout") {
    const err = new Error(reply.message ?? "ETIMEDOUT: mock timeout");
    err.name = "AbortError";
    Object.assign(err, { code: reply.code ?? "ETIMEDOUT" });
    throw err;
  }

  // Anthropic: SSE when streaming, JSON otherwise
  if (api === "anthropic-messages") {
    if (reply.type === "text") {
      if (isStreaming) return sseResponse(buildAnthropicTextSSE(reply.text), reply.status ?? 200);
      return jsonResponse(buildAnthropicTextJson(reply.text), reply.status ?? 200);
    }
    if (reply.type === "tool_use") {
      if (isStreaming) return sseResponse(buildAnthropicToolSSE(reply.toolName, reply.toolInput, reply.toolCallId, reply.textAfterTool), 200);
      return jsonResponse(buildAnthropicToolJson(reply.toolName, reply.toolInput, reply.toolCallId), 200);
    }
  }

  // OpenAI Completions: SSE when streaming, JSON otherwise
  if (api === "openai-completions") {
    if (reply.type === "text") {
      if (isStreaming) return sseResponse(buildOpenAICompletionsTextSSE(reply.text), reply.status ?? 200);
      return jsonResponse(buildOpenAICompletionsTextJson(reply.text), reply.status ?? 200);
    }
    if (reply.type === "tool_use") {
      if (isStreaming) return sseResponse(buildOpenAICompletionsToolSSE(reply.toolName, reply.toolInput, reply.toolCallId), 200);
      return jsonResponse(buildOpenAICompletionsToolJson(reply.toolName, reply.toolInput, reply.toolCallId), 200);
    }
  }

  // OpenAI Responses: SSE when streaming, JSON otherwise
  if (api === "openai-responses") {
    if (reply.type === "text") {
      if (isStreaming) return sseResponse(buildOpenAIResponsesTextSSE(reply.text), reply.status ?? 200);
      return jsonResponse(buildOpenAIResponsesTextJson(reply.text), reply.status ?? 200);
    }
    if (reply.type === "tool_use") {
      if (isStreaming) return sseResponse(buildOpenAIResponsesToolSSE(reply.toolName, reply.toolInput, reply.toolCallId), 200);
      return jsonResponse(buildOpenAIResponsesToolJson(reply.toolName, reply.toolInput, reply.toolCallId), 200);
    }
  }

  // Non-streaming JSON APIs (always JSON regardless of stream flag)
  if (api === "google-generative-ai") {
    if (reply.type === "text") {
      return jsonResponse(buildGoogleTextJson(reply.text), reply.status ?? 200);
    }
    if (reply.type === "tool_use") {
      return jsonResponse(buildGoogleToolJson(reply.toolName, reply.toolInput), 200);
    }
  }

  if (api === "ollama") {
    if (reply.type === "text") {
      return jsonResponse(buildOllamaTextJson(reply.text), reply.status ?? 200);
    }
    if (reply.type === "tool_use") {
      return jsonResponse(buildOllamaToolJson(reply.toolName, reply.toolInput), 200);
    }
  }

  throw new Error(`Unsupported api/reply combination: ${api}/${reply.type}`);
}

// ─── Factory ───

export function createMockFetch(
  api: FridayProviderApi,
  opts?: {
    initialReplies?: MockLlmReply[];
    defaultReply?: MockLlmReply;
  },
): MockFetch {
  const queue: MockLlmReply[] = [...(opts?.initialReplies ?? [])];
  let defaultReply: MockLlmReply | undefined = opts?.defaultReply;
  const calls: MockFetchCall[] = [];

  const mockFetch = async function mockFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    const method = init?.method ?? "POST";
    const rawHeaders = init?.headers ?? {};
    const headers: Record<string, string> = {};
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((v, k) => { headers[k] = v; });
    } else if (Array.isArray(rawHeaders)) {
      for (const [k, v] of rawHeaders) { headers[k] = v; }
    } else {
      Object.assign(headers, rawHeaders);
    }

    let bodyRaw: string | undefined;
    let bodyJson: unknown;
    if (init?.body) {
      bodyRaw = typeof init.body === "string" ? init.body : undefined;
      if (bodyRaw) {
        try { bodyJson = JSON.parse(bodyRaw); } catch { /* noop */ }
      }
    }

    calls.push({
      api,
      url,
      method,
      headers,
      bodyRaw,
      bodyJson,
      atIso: new Date().toISOString(),
    });

    const reply = queue.shift() ?? defaultReply;
    if (!reply) {
      throw new Error(
        `MockFetch(${api}): No reply queued and no default set. ` +
        `Use enqueue() or setDefault() before making requests.`,
      );
    }

    if (reply.latencyMs && reply.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, reply.latencyMs));
    }

    // Detect whether the request asks for streaming based on the body's `stream` field
    const isStreaming = bodyJson != null &&
      typeof bodyJson === "object" &&
      "stream" in (bodyJson as Record<string, unknown>) &&
      (bodyJson as Record<string, unknown>).stream === true;

    return buildResponse(api, reply, isStreaming);
  } as MockFetch;

  mockFetch.calls = calls;
  mockFetch.enqueue = (...replies: MockLlmReply[]) => { queue.push(...replies); };
  mockFetch.setDefault = (reply: MockLlmReply) => { defaultReply = reply; };
  mockFetch.reset = () => {
    queue.length = 0;
    calls.length = 0;
    defaultReply = undefined;
  };

  return mockFetch;
}

// ─── Non-streaming JSON builders for provider inference client path ───
// These build the response shapes that extractTextFromResponse expects.

export function buildNonStreamingResponse(
  api: FridayProviderApi,
  text: string,
): Record<string, unknown> {
  switch (api) {
    case "openai-completions":
      return {
        choices: [{ message: { content: text } }],
        usage: { prompt_tokens: 10, completion_tokens: text.split(" ").length },
      };
    case "openai-responses":
      return {
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: text.split(" ").length },
      };
    case "anthropic-messages":
      return {
        content: [{ type: "text", text }],
        usage: { input_tokens: 10, output_tokens: text.split(" ").length },
      };
    case "google-generative-ai":
      return buildGoogleTextJson(text);
    case "ollama":
      return buildOllamaTextJson(text);
  }
}
