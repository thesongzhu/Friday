import { FridayDomainError } from "#errors";
import {
  FRIDAY_ANTHROPIC_OAUTH_DISABLED_MESSAGE,
  isFridayAnthropicBearerAuthMode,
} from "#providers";
import { isFridayModelTooSmallForTools } from "./friday-agent-operational-mode.js";
import {
  runFridayCliBackendTextCompletion,
} from "#providers";
import type {
  FridayProviderApi,
  FridayProviderAuthMode,
  FridayProviderBackendKind,
} from "#providers";
import { createFridayProviderPromptCacheAdapter, extractProviderRequestId } from "#providers";

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
  system: string | unknown[];
  messages: Array<{ role: string; content: unknown }>;
  tools: AnthropicToolDefinition[];
  stream: true;
  temperature?: number;
}

const FRIDAY_CLI_BACKEND_TEXT_ONLY_NOTE = [
  "Runtime capability boundary:",
  "- Friday tools are unavailable in this backend.",
  "- You do not have access to files, shell, browser, network, or live workspace state.",
  "- Never claim to have read a file, inspected the repository, run a command, browsed the web, or used a Friday tool.",
  "- If the request depends on those capabilities, clearly say this Friday CLI backend is text-only and ask to reroute to an HTTP backend for tool-using tasks.",
].join("\n");

const FRIDAY_AGENT_LLM_ERROR_BODY_MAX_BYTES = 4096;

async function readErrorTextWithLimit(response: Response): Promise<string> {
  if (!response.body) {
    return response.text();
  }

  const byteLimit = FRIDAY_AGENT_LLM_ERROR_BODY_MAX_BYTES + 1;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytesRead = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }

      const remaining = byteLimit - bytesRead;
      if (remaining <= 0) {
        await reader.cancel();
        break;
      }

      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(decoder.decode(chunk, { stream: true }));
      bytesRead += chunk.byteLength;

      if (bytesRead >= byteLimit) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  chunks.push(decoder.decode());
  const text = chunks.join("");
  return text.length > FRIDAY_AGENT_LLM_ERROR_BODY_MAX_BYTES
    ? `${text.slice(0, FRIDAY_AGENT_LLM_ERROR_BODY_MAX_BYTES)}...[truncated]`
    : text;
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
  const backendKind: FridayProviderBackendKind = deps.backendKind ?? "http";
  const authMode: FridayProviderAuthMode | undefined = deps.authMode;
  const fetchFn = deps.fetchImpl ?? fetch;

  if (backendKind === "http") {
    const normalizedBaseUrl = baseUrl ?? "";
    const ssrfCheck = validateGatewayUrl(normalizedBaseUrl, {
      allowLoopback: deps.allowPrivateNetwork,
      allowPrivate: deps.allowPrivateNetwork,
    });
    if (!ssrfCheck.valid) {
      throw new FridayDomainError(
        FRIDAY_AGENT_ERROR_CODES.LLM_ERROR,
        `LLM provider baseUrl blocked by SSRF guard: ${ssrfCheck.error}`,
        { httpStatus: 403 },
      );
    }
  }

  return {
    async *stream(params: FridayAgentLlmStreamParams): AsyncIterable<FridayAgentLlmStreamEvent> {
      if (backendKind === "cli") {
        if (!deps.cliConfig) {
          throw new FridayDomainError(
            FRIDAY_AGENT_ERROR_CODES.LLM_ERROR,
            "CLI backend selected without cliConfig",
            { httpStatus: 500 },
          );
        }
        const conversation = params.messages
          .map((message) =>
            `${message.role.toUpperCase()}: ${
              typeof message.content === "string"
                ? message.content
                : JSON.stringify(message.content)
            }`,
          )
          .join("\n\n");
        const cliSystemPrompt = params.tools.length > 0
          ? `${params.systemPrompt}\n\n${FRIDAY_CLI_BACKEND_TEXT_ONLY_NOTE}`
          : params.systemPrompt;
        const output = await runFridayCliBackendTextCompletion({
          cliConfig: deps.cliConfig,
          systemPrompt: cliSystemPrompt,
          conversation,
          model: params.model,
        });
        if (output.length > 0) {
          yield { type: "text_delta", text: output };
        }
        yield {
          type: "message_end",
          stopReason: "end_turn",
          inputTokens: 0,
          outputTokens: 0,
        };
        return;
      }

      // Gate tools for small models (<7B parameters) to prevent hallucinated tool calls.
      // At this point params.model is the resolved model name (e.g. "llama3.2:3b").
      if (isFridayModelTooSmallForTools(params.model)) {
        params = { ...params, tools: [] };
      }

      // Dispatch to the appropriate API handler based on provider api type
      if (api === "ollama") {
        yield* handleOllamaStream(fetchFn, baseUrl ?? "", params);
      } else if (api === "openai-completions" || api === "openai-responses" || api === "openai-codex-responses") {
        yield* handleOpenAIStream(fetchFn, baseUrl ?? "", apiKey ?? "", api, params);
      } else {
        // Default: anthropic-messages (backwards compatible)
        yield* handleAnthropicStream(fetchFn, baseUrl ?? "", apiKey ?? "", authMode, params);
      }
    },
  };
}

/**
 * Attaches the provider's request-id to the terminal `message_end` event of a
 * streamed turn so downstream usage recording can bind an idempotent, verifiable
 * receipt to the call. Purely additive: non-`message_end` events pass through
 * untouched, and a null request-id leaves `message_end` exactly as before (no
 * receipt — the prior behavior for calls that surface no request identifier).
 */
async function* attachRequestIdToMessageEnd(
  events: AsyncIterable<FridayAgentLlmStreamEvent>,
  requestId: string | null,
): AsyncIterable<FridayAgentLlmStreamEvent> {
  for await (const event of events) {
    if (event.type === "message_end" && requestId) {
      yield { ...event, requestId };
    } else {
      yield event;
    }
  }
}

// ─── Anthropic handler ───

async function* handleAnthropicStream(
  fetchFn: typeof fetch,
  baseUrl: string,
  apiKey: string,
  authMode: FridayProviderAuthMode | undefined,
  params: FridayAgentLlmStreamParams,
): AsyncIterable<FridayAgentLlmStreamEvent> {
  const isBearerAuth = isFridayAnthropicBearerAuthMode(authMode);
  if (isBearerAuth) {
    throw new FridayDomainError(
      FRIDAY_AGENT_ERROR_CODES.LLM_ERROR,
      FRIDAY_ANTHROPIC_OAUTH_DISABLED_MESSAGE,
      { httpStatus: 400 },
    );
  }

  // ── Prompt caching for Anthropic ──
  // Apply cache_control to system prompt to save ~90% input tokens on subsequent calls.
  // Reference: skills/generator/llm/friday-provider-inference-client.ts:447-494
  const cacheAdapter = createFridayProviderPromptCacheAdapter();
  const cacheResult = cacheAdapter.applyAnthropicCacheHints({
    systemPrompt: params.systemPrompt,
    userPrompt: "",
    hints: {
      api: "anthropic-messages",
      providerKind: "anthropic",
      anthropic: { enabled: true, systemCache: true, userStaticBlockIndexes: [] },
      openaiSystemCache: { enabled: false },
    },
  });

  let systemField: AnthropicMessageRequest["system"];
  let cacheHeaders: Record<string, string> = {};
  systemField = cacheResult.systemBlocks;
  cacheHeaders = cacheResult.extraHeaders;
  const tools = params.tools.map(toAnthropicTool);

  const body: AnthropicMessageRequest = {
    model: params.model,
    max_tokens: 8192,
    system: systemField,
    messages: params.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    tools,
    stream: true,
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
  };

  const response = await fetchFn(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...cacheHeaders,
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });

  if (!response.ok) {
    const errorText = await readErrorTextWithLimit(response).catch(() => "unknown error");
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

  // Capture the provider's own request-id from the completed response's
  // transport headers (`request-id` / `x-request-id`) and bind it to the turn's
  // message_end so the usage record is idempotent + receipt-backed.
  const requestId = extractProviderRequestId("anthropic-messages", response.headers, {});
  yield* attachRequestIdToMessageEnd(parseAnthropicSSEStream(response.body), requestId);
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
    ...(params.temperature !== undefined ? { options: { temperature: params.temperature } } : {}),
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
    const errorText = await readErrorTextWithLimit(response).catch(() => "unknown error");
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

  // Emit text content if present.
  // Post-process: some local models (especially coder variants) output raw JSON
  // tool-call format as text instead of using the tool_call mechanism. Strip it
  // to avoid exposing internal protocol details to the user.
  let textContent = message?.content ?? "";
  if (textContent) {
    const trimmed = textContent.trim();
    // Detect raw JSON tool-call format: {"name": "...", "arguments": {...}}
    if (/^\s*\{\s*"name"\s*:/.test(trimmed) && /"arguments"\s*:/.test(trimmed)) {
      try {
        const parsed = JSON.parse(trimmed) as { name?: string; arguments?: Record<string, unknown> };
        if (parsed.name && parsed.arguments) {
          // Convert to a natural language response instead of exposing raw JSON
          const args = Object.entries(parsed.arguments).map(([k, v]) => `${k}: ${String(v)}`).join(", ");
          textContent = `I tried to use "${parsed.name}" with ${args}, but this model doesn't support structured tool calls. Please try a larger model (7B+) for tool-capable tasks.`;
        }
      } catch {
        // Not valid JSON, leave as-is
      }
    }
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
  api: "openai-completions" | "openai-responses" | "openai-codex-responses",
  params: FridayAgentLlmStreamParams,
): AsyncIterable<FridayAgentLlmStreamEvent> {
  const base = baseUrl.replace(/\/+$/, "");
  const openAiTools = params.tools.map(toOpenAiFunctionTool);

  let url: string;
  let body: Record<string, unknown>;

  if (api === "openai-responses" || api === "openai-codex-responses") {
    url = api === "openai-codex-responses"
      ? `${base}/responses`
      : `${base}/v1/responses`;
    const input = api === "openai-codex-responses"
      ? params.messages.flatMap((message) => mapMessageForOpenAIResponses(message.role, message.content))
      : mapMessagesForOpenAIResponses(params.systemPrompt, params.messages);
    body = {
      model: params.model,
      input: input.length > 0
        ? input
        : [{ role: "user", content: [{ type: "input_text", text: "Continue." }] }],
      stream: true,
      ...(api === "openai-codex-responses"
        ? {
            instructions: params.systemPrompt || "You are Friday. Follow the user's instruction exactly.",
            store: false,
          }
        : {}),
      ...(api !== "openai-codex-responses" && params.temperature !== undefined ? { temperature: params.temperature } : {}),
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
    const messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }> = [
      { role: "system", content: params.systemPrompt },
      ...params.messages.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : mapContentBlocksForOpenAI(m.content),
      })),
    ];
    const includeUsage = shouldIncludeOpenAiStreamUsage(base);
    url = `${base}/v1/chat/completions`;
    body = {
      model: params.model,
      messages,
      stream: true,
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
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
      ...(api === "openai-codex-responses"
        ? {
            originator: "friday",
            "User-Agent": "friday",
          }
        : {}),
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });

  if (!response.ok) {
    const errorText = await readErrorTextWithLimit(response).catch(() => "unknown error");
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

  // Capture the provider's own request-id (`x-request-id` header) and bind it to
  // the turn's message_end so the usage record is idempotent + receipt-backed.
  const requestId = extractProviderRequestId(api, response.headers, {});
  const parsed = api === "openai-responses" || api === "openai-codex-responses"
    ? parseOpenAIResponsesSSEStream(response.body)
    : parseOpenAISSEStream(response.body);
  yield* attachRequestIdToMessageEnd(parsed, requestId);
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

function mapContentBlocksForOpenAIResponses(
  role: string,
  content: string | FridayAgentContentBlock[],
): Array<Record<string, unknown>> {
  const textBlockType = role === "assistant" ? "output_text" : "input_text";

  if (typeof content === "string") {
    return [{ type: textBlockType, text: content }];
  }

  return content.map((block) => {
    if (block.type === "text") {
      return { type: textBlockType, text: block.text };
    }
    if (block.type === "image") {
      if (role === "assistant") {
        return { type: "output_text", text: JSON.stringify(block) };
      }
      const imageUrl = block.source.type === "url"
        ? block.source.url
        : `data:${block.source.media_type};base64,${block.source.data}`;
      return { type: "input_image", image_url: imageUrl };
    }
    return { type: textBlockType, text: JSON.stringify(block) };
  });
}

function mapMessageForOpenAIResponses(
  role: string,
  content: string | FridayAgentContentBlock[],
): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return [{
      role,
      content: mapContentBlocksForOpenAIResponses(role, content),
    }];
  }

  const items: Array<Record<string, unknown>> = [];
  let bufferedBlocks: FridayAgentContentBlock[] = [];
  const flushBufferedBlocks = () => {
    if (bufferedBlocks.length === 0) {
      return;
    }
    items.push({
      role,
      content: mapContentBlocksForOpenAIResponses(role, bufferedBlocks),
    });
    bufferedBlocks = [];
  };

  for (const block of content) {
    if (block.type === "tool_use" && role === "assistant") {
      flushBufferedBlocks();
      items.push({
        type: "function_call",
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      });
      continue;
    }
    if (block.type === "tool_result") {
      flushBufferedBlocks();
      items.push({
        type: "function_call_output",
        call_id: block.tool_use_id,
        output: block.content,
      });
      continue;
    }
    bufferedBlocks.push(block);
  }

  flushBufferedBlocks();
  return items;
}

function mapMessagesForOpenAIResponses(
  systemPrompt: string,
  messages: FridayAgentLlmStreamParams["messages"],
): Array<Record<string, unknown>> {
  return [
    {
      role: "system",
      content: mapContentBlocksForOpenAIResponses("system", systemPrompt),
    },
    ...messages.flatMap((message) => mapMessageForOpenAIResponses(message.role, message.content)),
  ];
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
              try { input = JSON.parse(tc.args) as Record<string, unknown>; } catch (err) {
                console.warn("[friday][agent-llm-client] tool call args parse failed:", err instanceof Error ? err.message : String(err));
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
      try { event = JSON.parse(data) as Record<string, unknown>; } catch (err) { console.warn("[friday][agent-llm-client] SSE event parse failed:", err instanceof Error ? err.message : String(err)); continue; }

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
            try { input = JSON.parse(tc.args) as Record<string, unknown>; } catch (err) {
              console.warn("[friday][agent-llm-client] tool call args parse failed:", err instanceof Error ? err.message : String(err));
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

async function* parseOpenAIResponsesSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<FridayAgentLlmStreamEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  const toolCalls = new Map<string, { id: string; itemId?: string; callId?: string; name: string; args: string; emitted: boolean }>();
  const toolCallKeyByCallId = new Map<string, string>();
  const assistantMessages = new Map<string, { emittedText: string }>();
  let inputTokens = 0;
  let outputTokens = 0;
  let messageEnded = false;

  const appendAssistantText = (itemId: string, text: string) => {
    if (!itemId || text.length === 0) {
      return;
    }
    const tracked = assistantMessages.get(itemId) ?? { emittedText: "" };
    tracked.emittedText += text;
    assistantMessages.set(itemId, tracked);
  };

  const emitAssistantTextFromFinalText = async function* (
    itemId: string,
    finalText: string,
    source: string,
  ): AsyncGenerator<FridayAgentLlmStreamEvent, void, void> {
    if (!itemId || finalText.length === 0) {
      return;
    }
    const tracked = assistantMessages.get(itemId) ?? { emittedText: "" };
    const emittedText = tracked.emittedText;
    if (finalText === emittedText) {
      assistantMessages.set(itemId, tracked);
      return;
    }

    let missingText = "";
    if (emittedText.length === 0) {
      missingText = finalText;
    } else if (finalText.startsWith(emittedText)) {
      missingText = finalText.slice(emittedText.length);
    } else {
      console.warn(`[friday][agent-llm-client] OpenAI Responses ${source} text mismatch; using completed text as fallback`, {
        itemId,
      });
      missingText = finalText;
    }

    if (missingText.length > 0) {
      yield { type: "text_delta", text: missingText };
      tracked.emittedText = finalText;
      assistantMessages.set(itemId, tracked);
    }
  };

  const emitAssistantTextFromItem = async function* (
    itemId: string,
    item: Record<string, unknown>,
  ): AsyncGenerator<FridayAgentLlmStreamEvent, void, void> {
    const finalText = extractOpenAIResponsesMessageText(item);
    yield* emitAssistantTextFromFinalText(itemId, finalText, "message item");
  };

  const processLine = async function* (line: string): AsyncGenerator<FridayAgentLlmStreamEvent, void, void> {
    if (!line.startsWith("data: ")) return;
    const data = line.slice(6).trim();

    if (data === "[DONE]") {
      if (!messageEnded) {
        const hasToolCalls = toolCalls.size > 0;
        yield* emitOpenAIResponsesToolCalls(toolCalls);
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
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch (err) {
      console.warn("[friday][agent-llm-client] Responses SSE event parse failed:", err instanceof Error ? err.message : String(err));
      return;
    }

    const type = typeof event.type === "string" ? event.type : "";

    if (type === "error") {
      const error = event.error as Record<string, unknown> | undefined;
      const code = typeof error?.code === "string" ? error.code : "unknown_error";
      const message = typeof error?.message === "string" ? error.message : "OpenAI streaming error";
      throw new FridayDomainError(
        FRIDAY_AGENT_ERROR_CODES.LLM_ERROR,
        `LLM stream error (${code}): ${message}`,
        { httpStatus: 502 },
      );
    }

    if (type === "response.failed" || type === "response.incomplete") {
      const response = event.response as Record<string, unknown> | undefined;
      const error = response?.error as Record<string, unknown> | undefined;
      const incomplete = response?.incomplete_details as Record<string, unknown> | undefined;
      const code = typeof error?.code === "string"
        ? error.code
        : typeof incomplete?.reason === "string"
          ? incomplete.reason
          : type;
      const message = typeof error?.message === "string"
        ? error.message
        : typeof incomplete?.message === "string"
          ? incomplete.message
          : `OpenAI response ended with status ${type}`;
      throw new FridayDomainError(
        FRIDAY_AGENT_ERROR_CODES.LLM_ERROR,
        `LLM response failed (${code}): ${message}`,
        { httpStatus: 502 },
      );
    }

    if (type === "response.output_text.delta") {
      const itemId = typeof event.item_id === "string" ? event.item_id : "";
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (delta) {
        appendAssistantText(itemId, delta);
        yield { type: "text_delta", text: delta };
      }
      return;
    }

    if (type === "response.output_text.done") {
      const itemId = typeof event.item_id === "string" ? event.item_id : "";
      const text = typeof event.text === "string" ? event.text : "";
      yield* emitAssistantTextFromFinalText(itemId, text, "output_text.done");
      return;
    }

    if (type === "response.refusal.delta") {
      const itemId = typeof event.item_id === "string" ? event.item_id : "";
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (delta) {
        appendAssistantText(itemId, delta);
        yield { type: "text_delta", text: delta };
      }
      return;
    }

    if (type === "response.refusal.done") {
      const itemId = typeof event.item_id === "string" ? event.item_id : "";
      const refusal = typeof event.refusal === "string" ? event.refusal : "";
      yield* emitAssistantTextFromFinalText(itemId, refusal, "refusal.done");
      return;
    }

    if (type === "response.content_part.done") {
      const itemId = typeof event.item_id === "string" ? event.item_id : "";
      const part = event.part as Record<string, unknown> | undefined;
      const finalText = extractOpenAIResponsesContentPartText(part);
      yield* emitAssistantTextFromFinalText(itemId, finalText, "content_part.done");
      return;
    }

    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "message") {
        const itemId = typeof item.id === "string" ? item.id : "";
        if (type === "response.output_item.done") {
          yield* emitAssistantTextFromItem(itemId, item);
        }
        return;
      }

      if (item?.type === "function_call") {
        const itemId = typeof item.id === "string" ? item.id : "";
        const callId = typeof item.call_id === "string" ? item.call_id : "";
        const toolKey = itemId
          || (callId ? toolCallKeyByCallId.get(callId) ?? callId : "");
        if (toolKey) {
          if (callId && itemId) {
            toolCallKeyByCallId.set(callId, toolKey);
          }
          const existing = toolCalls.get(toolKey) ?? {
            id: callId || itemId,
            itemId: itemId || undefined,
            callId: callId || undefined,
            name: "",
            args: "",
            emitted: false,
          };
          if (itemId) {
            existing.itemId = itemId;
          }
          if (callId) {
            existing.callId = callId;
            existing.id = callId;
          } else if (itemId && existing.id.trim().length === 0) {
            existing.id = itemId;
          }
          if (typeof item.name === "string" && item.name) {
            existing.name = item.name;
          }
          if (typeof item.arguments === "string") {
            existing.args = item.arguments;
          }
          toolCalls.set(toolKey, existing);

          if (type === "response.output_item.done" && !existing.emitted && existing.name.trim().length > 0) {
            const input = parseOpenAIToolCallArgs(existing.args);
            yield {
              type: "tool_use",
              id: existing.id,
              name: existing.name,
              input,
            };
            existing.emitted = true;
          }
        }
      }
      return;
    }

    if (type === "response.function_call_arguments.delta") {
      const itemId = typeof event.item_id === "string" ? event.item_id : "";
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (!itemId || !delta) return;
      const existing = toolCalls.get(itemId) ?? {
        id: itemId,
        itemId,
        callId: undefined,
        name: "",
        args: "",
        emitted: false,
      };
      existing.args += delta;
      toolCalls.set(itemId, existing);
      return;
    }

    if (type === "response.completed" && !messageEnded) {
      const response = event.response as Record<string, unknown> | undefined;
      const usage = response?.usage as Record<string, unknown> | undefined;
      if (usage) {
        if (typeof usage.input_tokens === "number") inputTokens = usage.input_tokens;
        if (typeof usage.output_tokens === "number") outputTokens = usage.output_tokens;
      }

      const hasToolCalls = toolCalls.size > 0;
      yield* emitOpenAIResponsesToolCalls(toolCalls);
      yield {
        type: "message_end",
        stopReason: hasToolCalls ? "tool_use" : "end_turn",
        inputTokens,
        outputTokens,
      };
      messageEnded = true;
      return;
    }
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      yield* processLine(line);
    }
  }

  const trailingLine = buffer.trim();
  if (trailingLine.length > 0) {
    yield* processLine(trailingLine);
  }
}

function parseOpenAIToolCallArgs(args: string): Record<string, unknown> {
  if (!args) {
    return {};
  }

  try {
    return JSON.parse(args) as Record<string, unknown>;
  } catch (err) {
    console.warn("[friday][agent-llm-client] tool call args parse failed:", err instanceof Error ? err.message : String(err));
    return { _parseError: true, _rawJson: args };
  }
}

function extractOpenAIResponsesMessageText(item: Record<string, unknown>): string {
  const content = Array.isArray(item.content) ? item.content : [];
  const parts: string[] = [];
  for (const part of content) {
    const text = extractOpenAIResponsesContentPartText(part);
    if (text) {
      parts.push(text);
    }
  }
  return parts.join("");
}

function extractOpenAIResponsesContentPartText(part: unknown): string {
  if (!part || typeof part !== "object" || Array.isArray(part)) {
    return "";
  }
  const record = part as Record<string, unknown>;
  if ((record.type === "output_text" || record.type === "text") && typeof record.text === "string") {
    return record.text;
  }
  if (record.type === "refusal" && typeof record.refusal === "string") {
    return record.refusal;
  }
  return "";
}

async function* emitOpenAIResponsesToolCalls(
  toolCalls: Map<string, { id: string; itemId?: string; callId?: string; name: string; args: string; emitted: boolean }>,
): AsyncGenerator<FridayAgentLlmStreamEvent, void, void> {

  for (const [, toolCall] of toolCalls) {
    if (toolCall.emitted) {
      continue;
    }
    if (toolCall.name.trim().length === 0) {
      console.warn("[friday][agent-llm-client] dropping OpenAI Responses tool call without a name", {
        toolCallId: toolCall.id,
      });
      continue;
    }

    yield {
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.name,
      input: parseOpenAIToolCallArgs(toolCall.args),
    };
    toolCall.emitted = true;
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
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
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
      } catch (err) {
        console.warn("[friday][agent-llm-client] Anthropic SSE parse failed:", err instanceof Error ? err.message : String(err));
        continue;
      }

      const eventType = event.type;

      if (eventType === "message_start") {
        const message = event.message as Record<string, unknown> | undefined;
        const usage = message?.usage as Record<string, unknown> | undefined;
        if (usage) {
          inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
          cacheReadInputTokens = typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
          cacheCreationInputTokens = typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0;
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
            } catch (err) {
              // Malformed JSON from LLM — flag so runtime can produce a helpful error
              console.warn("[friday][agent-llm-client] tool input JSON malformed:", err instanceof Error ? err.message : String(err));
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
          cacheReadInputTokens,
          cacheCreationInputTokens,
          ...(responseModel ? { actualModel: responseModel, actualProviderKind: "anthropic", actualProviderApi: "anthropic-messages" } : {}),
        };
      }
    }
  }
}
