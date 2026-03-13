import { FridayDomainError } from "#errors";
import {
  FRIDAY_ANTHROPIC_OAUTH_HEADERS,
  FRIDAY_ANTHROPIC_OAUTH_SYSTEM_PREFIX,
} from "#providers";
import type { FridayProviderApi, FridayProviderAuthMode } from "#providers";

import { validateGatewayUrl } from "../tools/friday-agent-gateway-validation.js";
import { FRIDAY_AGENT_ERROR_CODES } from "../friday-agent.constants.js";
import type { FridayAgentContentBlock, FridayAgentToolDefinition } from "../model/friday-agent.types.js";
import type {
  CreateFridayAgentLlmClientDeps,
  FridayAgentLlmClient,
  FridayAgentLlmStreamEvent,
  FridayAgentLlmStreamParams,
} from "./friday-agent-llm-client.types.js";

// ─── Anthropic API request/response shapes ───

interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicMessageRequest {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: string; content: unknown }>;
  tools: AnthropicToolDefinition[];
  stream: true;
}

interface OpenAiFunctionDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ─── Factory ───

export function createFridayAgentLlmClient(
  deps: CreateFridayAgentLlmClientDeps,
): FridayAgentLlmClient {
  const { baseUrl, apiKey } = deps;
  const api: FridayProviderApi = deps.api ?? "anthropic-messages";
  const authMode: FridayProviderAuthMode | undefined = deps.authMode;
  const fetchFn = deps.fetchImpl ?? fetch;

  // SSRF guard: validate the provider baseUrl at construction time
  const ssrfCheck = validateGatewayUrl(baseUrl);
  if (!ssrfCheck.valid) {
    throw new FridayDomainError(
      FRIDAY_AGENT_ERROR_CODES.LLM_ERROR,
      `LLM provider baseUrl blocked by SSRF guard: ${ssrfCheck.error}`,
      { httpStatus: 403 },
    );
  }

  return {
    async *stream(params: FridayAgentLlmStreamParams): AsyncIterable<FridayAgentLlmStreamEvent> {
      // Dispatch to the appropriate API handler based on provider api type
      if (api === "ollama") {
        yield* handleOllamaStream(fetchFn, baseUrl, params);
      } else if (api === "openai-completions" || api === "openai-responses") {
        yield* handleOpenAIStream(fetchFn, baseUrl, apiKey, api, params);
      } else {
        // Default: anthropic-messages (backwards compatible)
        yield* handleAnthropicStream(fetchFn, baseUrl, apiKey, authMode, params);
      }
    },
  };
}

// ─── Anthropic handler ───

async function* handleAnthropicStream(
  fetchFn: typeof fetch,
  baseUrl: string,
  apiKey: string,
  authMode: FridayProviderAuthMode | undefined,
  params: FridayAgentLlmStreamParams,
): AsyncIterable<FridayAgentLlmStreamEvent> {
  const isOAuth = authMode === "oauth";
  const body: AnthropicMessageRequest = {
    model: params.model,
    max_tokens: 8192,
    system: isOAuth
      ? `${FRIDAY_ANTHROPIC_OAUTH_SYSTEM_PREFIX}\n\n${params.systemPrompt}`
      : params.systemPrompt,
    messages: params.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    tools: params.tools.map(toAnthropicTool),
    stream: true,
  };

  const response = await fetchFn(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(isOAuth
        ? {
            "Authorization": `Bearer ${apiKey}`,
            ...FRIDAY_ANTHROPIC_OAUTH_HEADERS,
          }
        : {
            "x-api-key": apiKey,
          }),
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    throw new FridayDomainError(
      FRIDAY_AGENT_ERROR_CODES.LLM_ERROR,
      `LLM request failed (${String(response.status)}): ${errorText}`,
      { httpStatus: 502 },
    );
  }

  if (!response.body) {
    throw new FridayDomainError(
      FRIDAY_AGENT_ERROR_CODES.LLM_ERROR,
      "LLM response has no body",
      { httpStatus: 502 },
    );
  }

  yield* parseAnthropicSSEStream(response.body);
}

// ─── Ollama handler (non-streaming, tool support via function calling) ───

async function* handleOllamaStream(
  fetchFn: typeof fetch,
  baseUrl: string,
  params: FridayAgentLlmStreamParams,
): AsyncIterable<FridayAgentLlmStreamEvent> {
  const messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }> = [
    { role: "system", content: params.systemPrompt },
    ...params.messages.map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : mapContentBlocksForOpenAI(m.content),
    })),
  ];

  // Build Ollama tools in OpenAI-compatible format
  const openAiTools = params.tools.map(toOpenAiFunctionTool);
  const tools = openAiTools.length > 0
    ? openAiTools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
    : undefined;

  const body: Record<string, unknown> = {
    model: params.model,
    messages,
    stream: false,
    ...(tools ? { tools } : {}),
  };

  const base = baseUrl.replace(/\/+$/, "");
  const response = await fetchFn(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: params.signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    throw new FridayDomainError(
      FRIDAY_AGENT_ERROR_CODES.LLM_ERROR,
      `LLM request failed (${String(response.status)}): ${errorText}`,
      { httpStatus: 502 },
    );
  }

  const responseBody = (await response.json()) as Record<string, unknown>;
  const message = responseBody.message as {
    role?: string;
    content?: string;
    tool_calls?: Array<{
      function: { name: string; arguments: Record<string, unknown> };
    }>;
  } | undefined;

  // Extract usage from Ollama response
  const inputTokens = typeof responseBody.prompt_eval_count === "number"
    ? responseBody.prompt_eval_count
    : 0;
  const outputTokens = typeof responseBody.eval_count === "number"
    ? responseBody.eval_count
    : 0;

  // Emit text content if present
  const textContent = message?.content ?? "";
  if (textContent) {
    yield { type: "text_delta", text: textContent };
  }

  // Emit tool calls if present
  if (message?.tool_calls && message.tool_calls.length > 0) {
    for (const toolCall of message.tool_calls) {
      yield {
        type: "tool_use",
        id: `ollama-tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: toolCall.function.name,
        input: toolCall.function.arguments,
      };
    }
    yield {
      type: "message_end",
      stopReason: "tool_use",
      inputTokens,
      outputTokens,
    };
  } else {
    yield {
      type: "message_end",
      stopReason: "end_turn",
      inputTokens,
      outputTokens,
    };
  }
}

// ─── OpenAI handler (streaming SSE) ───

async function* handleOpenAIStream(
  fetchFn: typeof fetch,
  baseUrl: string,
  apiKey: string,
  api: "openai-completions" | "openai-responses",
  params: FridayAgentLlmStreamParams,
): AsyncIterable<FridayAgentLlmStreamEvent> {
  const base = baseUrl.replace(/\/+$/, "");
  const messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }> = [
    { role: "system", content: params.systemPrompt },
    ...params.messages.map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : mapContentBlocksForOpenAI(m.content),
    })),
  ];

  const openAiTools = params.tools.map(toOpenAiFunctionTool);

  let url: string;
  let body: Record<string, unknown>;

  if (api === "openai-responses") {
    url = `${base}/v1/responses`;
    const input: Array<Record<string, unknown>> = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    body = {
      model: params.model,
      input,
      stream: true,
      ...(openAiTools.length > 0
        ? {
            tools: openAiTools.map((tool) => ({
              type: "function" as const,
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
          }
        : {}),
    };
  } else {
    const includeUsage = shouldIncludeOpenAiStreamUsage(base);
    url = `${base}/v1/chat/completions`;
    body = {
      model: params.model,
      messages,
      stream: true,
      ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
      ...(openAiTools.length > 0
        ? {
            tools: openAiTools.map((tool) => ({
              type: "function" as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          }
        : {}),
    };
  }

  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    throw new FridayDomainError(
      FRIDAY_AGENT_ERROR_CODES.LLM_ERROR,
      `LLM request failed (${String(response.status)}): ${errorText}`,
      { httpStatus: 502 },
    );
  }

  if (!response.body) {
    throw new FridayDomainError(
      FRIDAY_AGENT_ERROR_CODES.LLM_ERROR,
      "LLM response has no body",
      { httpStatus: 502 },
    );
  }

  yield* parseOpenAISSEStream(response.body);
}

function shouldIncludeOpenAiStreamUsage(_baseUrl: string): boolean {
  // Always request stream usage — the `stream_options: { include_usage: true }`
  // parameter is harmless for providers that don't support it (silently ignored).
  // Previously this only returned true for api.openai.com, causing zero token
  // counts for all OpenAI-compatible providers (Groq, Together, local, etc).
  return true;
}

// ─── Helpers ───

/**
 * Map internal content blocks to OpenAI-compatible format.
 * Converts `FridayAgentImageBlock` → `{ type: "image_url", image_url: { url } }`.
 * Falls back to JSON serialization for non-image block arrays (backward compat).
 */
function mapContentBlocksForOpenAI(
  blocks: FridayAgentContentBlock[],
): string | Array<Record<string, unknown>> {
  const hasImage = blocks.some((b) => b.type === "image");
  if (!hasImage) return JSON.stringify(blocks);
  return blocks.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "image") {
      const url = block.source.type === "url"
        ? block.source.url
        : `data:${block.source.media_type};base64,${block.source.data}`;
      return { type: "image_url", image_url: { url } };
    }
    return { type: "text", text: JSON.stringify(block) };
  });
}

function toAnthropicTool(tool: FridayAgentToolDefinition): AnthropicToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: normalizeToolParameters(tool.parameters),
  };
}

function toOpenAiFunctionTool(tool: FridayAgentToolDefinition): OpenAiFunctionDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: normalizeToolParameters(tool.parameters),
  };
}

/**
 * Normalize JSON schema so provider tool-call validators accept it.
 *
 * Notable fixes:
 * - object schemas always include `type: "object"` + object `properties`
 * - array schemas always include `items`
 * - nested schemas are normalized recursively
 */
function normalizeToolParameters(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: "object",
    ...input,
  };
  const normalized = normalizeSchemaNode(base);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    return { type: "object", properties: {} };
  }
  const record = normalized as Record<string, unknown>;
  if (record.type !== "object") {
    record.type = "object";
  }
  if (!record.properties || typeof record.properties !== "object" || Array.isArray(record.properties)) {
    record.properties = {};
  }
  return record;
}

function normalizeSchemaNode(node: unknown): unknown {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return node;
  }

  const source = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      out[key] = value.map((entry) => normalizeSchemaNode(entry));
      continue;
    }
    if (value && typeof value === "object") {
      out[key] = normalizeSchemaNode(value);
      continue;
    }
    out[key] = value;
  }

  if (
    out.type === "object" ||
    (out.type === undefined &&
      out.properties !== undefined &&
      typeof out.properties === "object" &&
      !Array.isArray(out.properties))
  ) {
    out.type = "object";
    if (!out.properties || typeof out.properties !== "object" || Array.isArray(out.properties)) {
      out.properties = {};
    } else {
      const properties = out.properties as Record<string, unknown>;
      const normalizedProps: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(properties)) {
        normalizedProps[propName] = normalizeSchemaNode(propSchema);
      }
      out.properties = normalizedProps;
    }
  }

  if (out.type === "array") {
    if (out.items === undefined) {
      out.items = { type: "string" };
    } else {
      out.items = normalizeSchemaNode(out.items);
    }
  }

  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const value = out[key];
    if (Array.isArray(value)) {
      out[key] = value.map((entry) => normalizeSchemaNode(entry));
    }
  }

  if (out.required !== undefined && !Array.isArray(out.required)) {
    delete out.required;
  }

  return out;
}

// ─── OpenAI SSE stream parser ───

async function* parseOpenAISSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<FridayAgentLlmStreamEvent> {
  const decoder = new TextDecoder();
  let buffer = "";

  // Track accumulated tool calls by index
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  let inputTokens = 0;
  let outputTokens = 0;
  // Guard against emitting message_end twice — a real OpenAI stream can send
  // both a non-null finish_reason AND a [DONE] sentinel, which would otherwise
  // yield two message_end events.
  let messageEnded = false;

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") {
        if (!messageEnded) {
          // Emit any accumulated tool calls
          for (const [, tc] of toolCalls) {
            let input: Record<string, unknown> = {};
            if (tc.args) {
              try { input = JSON.parse(tc.args) as Record<string, unknown>; } catch {
                input = { _parseError: true, _rawJson: tc.args };
              }
            }
            yield { type: "tool_use", id: tc.id, name: tc.name, input };
          }

          const hasToolCalls = toolCalls.size > 0;
          yield {
            type: "message_end",
            stopReason: hasToolCalls ? "tool_use" : "end_turn",
            inputTokens,
            outputTokens,
          };
          messageEnded = true;
        }
        return;
      }

      let event: Record<string, unknown>;
      try { event = JSON.parse(data) as Record<string, unknown>; } catch { continue; }

      // Handle usage
      const usage = event.usage as Record<string, unknown> | undefined;
      if (usage) {
        if (typeof usage.prompt_tokens === "number") inputTokens = usage.prompt_tokens;
        if (typeof usage.completion_tokens === "number") outputTokens = usage.completion_tokens;
      }

      const choices = event.choices as Array<Record<string, unknown>> | undefined;
      if (!choices || choices.length === 0) continue;
      const choice = choices[0]!;
      const delta = choice.delta as Record<string, unknown> | undefined;
      if (!delta) continue;

      // Text content
      const content = delta.content;
      if (typeof content === "string" && content) {
        yield { type: "text_delta", text: content };
      }

      // Tool calls (streamed in deltas)
      const tcDeltas = delta.tool_calls as Array<Record<string, unknown>> | undefined;
      if (tcDeltas) {
        for (const tcd of tcDeltas) {
          const idx = typeof tcd.index === "number" ? tcd.index : 0;
          const fn = tcd.function as Record<string, unknown> | undefined;
          if (!toolCalls.has(idx)) {
            toolCalls.set(idx, {
              id: typeof tcd.id === "string" ? tcd.id : `tc-${idx}`,
              name: typeof fn?.name === "string" ? fn.name : "",
              args: "",
            });
          }
          const tc = toolCalls.get(idx)!;
          if (typeof fn?.name === "string" && fn.name) tc.name = fn.name;
          if (typeof fn?.arguments === "string") tc.args += fn.arguments;
        }
      }

      // Check finish_reason
      const finishReason = choice.finish_reason;
      if (typeof finishReason === "string" && finishReason !== null && !messageEnded) {
        // Emit accumulated tool calls
        for (const [, tc] of toolCalls) {
          let input: Record<string, unknown> = {};
          if (tc.args) {
            try { input = JSON.parse(tc.args) as Record<string, unknown>; } catch {
              input = { _parseError: true, _rawJson: tc.args };
            }
          }
          yield { type: "tool_use", id: tc.id, name: tc.name, input };
        }

        yield {
          type: "message_end",
          stopReason: finishReason === "tool_calls" ? "tool_use" :
                      finishReason === "length" ? "max_tokens" : "end_turn",
          inputTokens,
          outputTokens,
        };
        messageEnded = true;
      }
    }
  }
}

// ─── Anthropic SSE stream parser ───

async function* parseAnthropicSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<FridayAgentLlmStreamEvent> {
  const decoder = new TextDecoder();
  let buffer = "";

  // Track accumulated state for tool_use blocks
  let currentToolId = "";
  let currentToolName = "";
  let toolInputJson = "";

  // Track usage and model for message_end
  let inputTokens = 0;
  let outputTokens = 0;
  let responseModel = "";

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });

    const lines = buffer.split("\n");
    // Keep the last incomplete line in the buffer
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) {
        continue;
      }

      const data = line.slice(6).trim();
      if (data === "[DONE]") {
        return;
      }

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }

      const eventType = event.type;

      if (eventType === "message_start") {
        const message = event.message as Record<string, unknown> | undefined;
        const usage = message?.usage as Record<string, unknown> | undefined;
        if (usage) {
          inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
        }
        // Extract actual model from Anthropic message_start response
        if (typeof message?.model === "string") {
          responseModel = message.model;
        }
      } else if (eventType === "content_block_start") {
        const contentBlock = event.content_block as Record<string, unknown> | undefined;
        if (contentBlock?.type === "tool_use") {
          currentToolId = typeof contentBlock.id === "string" ? contentBlock.id : "";
          currentToolName = typeof contentBlock.name === "string" ? contentBlock.name : "";
          toolInputJson = "";
        }
      } else if (eventType === "content_block_delta") {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (!delta) {
          continue;
        }

        if (delta.type === "text_delta") {
          const text = typeof delta.text === "string" ? delta.text : "";
          if (text) {
            yield { type: "text_delta", text };
          }
        } else if (delta.type === "input_json_delta") {
          const partial = typeof delta.partial_json === "string" ? delta.partial_json : "";
          toolInputJson += partial;
        }
      } else if (eventType === "content_block_stop") {
        if (currentToolId) {
          let input: Record<string, unknown> = {};
          if (toolInputJson) {
            try {
              input = JSON.parse(toolInputJson) as Record<string, unknown>;
            } catch {
              // Malformed JSON from LLM — flag so runtime can produce a helpful error
              input = { _parseError: true, _rawJson: toolInputJson };
            }
          }
          yield {
            type: "tool_use",
            id: currentToolId,
            name: currentToolName,
            input,
          };
          currentToolId = "";
          currentToolName = "";
          toolInputJson = "";
        }
      } else if (eventType === "message_delta") {
        const delta = event.delta as Record<string, unknown> | undefined;
        const usage = event.usage as Record<string, unknown> | undefined;
        const stopReason = typeof delta?.stop_reason === "string" ? delta.stop_reason : "end_turn";
        if (usage) {
          outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
        }
        yield {
          type: "message_end",
          stopReason: stopReason as "end_turn" | "tool_use" | "max_tokens" | "stop_sequence",
          inputTokens,
          outputTokens,
          ...(responseModel ? { actualModel: responseModel, actualProviderKind: "anthropic", actualProviderApi: "anthropic-messages" } : {}),
        };
      }
    }
  }
}
