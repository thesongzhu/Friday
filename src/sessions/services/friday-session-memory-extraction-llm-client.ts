import { FridayDomainError } from "#errors";
import type {
  FridayProviderApi,
  FridayProviderAuthMode,
  FridayProviderService,
  FridayProviderTenantContext,
  FridayResolvedProviderRoute,
} from "#providers";
import {
  FRIDAY_ANTHROPIC_OAUTH_HEADERS,
  FRIDAY_ANTHROPIC_OAUTH_SYSTEM_PREFIX,
  isFridayAnthropicBearerAuthMode,
} from "#providers";
import { resolveFridayAgentTaskProfile } from "../../agent/runtime/friday-agent-task-profile.js";

import { FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES } from "../friday-session-memory-extraction.constants.js";
import type {
  FridaySessionMemoryExtractionItemKind,
  FridaySessionMemoryExtractionLlmItem,
  FridaySessionMemoryExtractionLlmResponse,
} from "../model/friday-session-memory-extraction.types.js";
import type { FridaySessionMessageRecord } from "../model/friday-session.types.js";

// ─── Deps ───

export interface CreateFridaySessionMemoryExtractionLlmClientDeps {
  providerService: FridayProviderService;
}

// ─── Client interface ───

export interface FridaySessionMemoryExtractionLlmClient {
  extractMemoryItems(
    messages: FridaySessionMessageRecord[],
    maxItems: number,
    tenantContext?: FridayProviderTenantContext,
  ): Promise<FridaySessionMemoryExtractionLlmResponse>;
}

// ─── Prompt ───

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction assistant. Your job is to extract durable, reusable facts from conversation messages.

Extract key facts, decisions, preferences, and action items from this conversation.

Rules:
- Each extracted item must be a self-contained, useful memory.
- Use "kind" to classify: "fact", "decision", "preference", or "action_item".
- Reference the source message IDs that contributed to each item.
- Content should be concise but complete enough to be useful without the original conversation.
- Do not extract trivial greetings, acknowledgments, or filler.
- If there is nothing meaningful to extract, return an empty items array.

Respond with strict JSON only:
{
  "items": [
    {
      "kind": "fact|decision|preference|action_item",
      "content": "short durable memory",
      "sourceMessageIds": ["msg-1", "msg-2"],
      "tags": ["optional.lowercase.tag"]
    }
  ]
}`;

function buildUserPrompt(messages: FridaySessionMessageRecord[], maxItems: number): string {
  const messageLines = messages.map((m) =>
    `[${m.id}] (${m.role}) ${m.contentText}`,
  );
  return `Extract up to ${maxItems} memory items from these messages:\n\n${messageLines.join("\n")}`;
}

// ─── Provider API helpers ───

function buildRequestBody(
  api: FridayProviderApi,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  temperature: number,
  authMode?: FridayProviderAuthMode,
): Record<string, unknown> {
  const effectiveSystemPrompt = isFridayAnthropicBearerAuthMode(authMode)
    ? `${FRIDAY_ANTHROPIC_OAUTH_SYSTEM_PREFIX}\n\n${systemPrompt}`
    : systemPrompt;
  const messages = [
    { role: "system" as const, content: effectiveSystemPrompt },
    { role: "user" as const, content: userPrompt },
  ];

  switch (api) {
    case "openai-completions":
      return {
        model,
        messages,
        temperature,
        response_format: { type: "json_object" },
      };
    case "openai-responses": {
      const input: Array<Record<string, unknown>> = messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));
      return {
        model,
        input,
        temperature,
        text: { format: { type: "json_object" } },
      };
    }
    case "anthropic-messages":
      return {
        model,
        system: effectiveSystemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        max_tokens: 4096,
        temperature,
      };
    case "google-generative-ai":
      return {
        model,
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { temperature, responseMimeType: "application/json" },
      };
    case "ollama":
      return {
        model,
        messages,
        stream: false,
        format: "json",
        options: { temperature },
      };
  }
}

function buildUrl(api: FridayProviderApi, baseUrl: string, model: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  switch (api) {
    case "openai-completions":
      return `${base}/v1/chat/completions`;
    case "openai-responses":
      return `${base}/v1/responses`;
    case "anthropic-messages":
      return `${base}/v1/messages`;
    case "google-generative-ai":
      return `${base}/v1beta/models/${model}:generateContent`;
    case "ollama":
      return `${base}/api/chat`;
  }
}

function buildHeaders(
  api: FridayProviderApi,
  credential: string | null,
  extraHeaders?: Record<string, string>,
  authMode?: FridayProviderAuthMode,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };

  if (credential) {
    switch (api) {
      case "anthropic-messages":
        if (isFridayAnthropicBearerAuthMode(authMode)) {
          headers["Authorization"] = `Bearer ${credential}`;
          Object.assign(headers, FRIDAY_ANTHROPIC_OAUTH_HEADERS);
        } else {
          headers["x-api-key"] = credential;
        }
        headers["anthropic-version"] = "2023-06-01";
        break;
      case "google-generative-ai":
        headers["x-goog-api-key"] = credential;
        break;
      default:
        headers["Authorization"] = `Bearer ${credential}`;
        break;
    }
  }

  return headers;
}

function extractTextFromResponse(
  api: FridayProviderApi,
  body: Record<string, unknown>,
): string {
  switch (api) {
    case "openai-completions": {
      const choices = body["choices"] as
        | Array<{ message?: { content?: string } }>
        | undefined;
      return choices?.[0]?.message?.content ?? "";
    }
    case "openai-responses": {
      const output = body["output"] as
        | Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>
        | undefined;
      const messageItem = output?.find((o) => o.type === "message");
      const textPart = messageItem?.content?.find((c) => c.type === "output_text");
      return textPart?.text ?? "";
    }
    case "anthropic-messages": {
      const content = body["content"] as
        | Array<{ type: string; text?: string }>
        | undefined;
      const textBlock = content?.find((b) => b.type === "text");
      return textBlock?.text ?? "";
    }
    case "google-generative-ai": {
      const candidates = body["candidates"] as
        | Array<{ content?: { parts?: Array<{ text?: string }> } }>
        | undefined;
      return candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    }
    case "ollama": {
      const message = body["message"] as { content?: string } | undefined;
      return message?.content ?? "";
    }
  }
}

// ─── JSON parser ───

function parseJsonFromText(rawText: string): unknown {
  const trimmed = rawText.trim();
  try {
    return JSON.parse(trimmed);
  } catch {}

  try {
    const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(trimmed);
    if (fenceMatch?.[1]) {
      return JSON.parse(fenceMatch[1].trim());
    }
  } catch {}

  try {
    const startBrace = trimmed.indexOf("{");
    if (startBrace !== -1) {
      const end = trimmed.lastIndexOf("}");
      if (end > startBrace) {
        return JSON.parse(trimmed.slice(startBrace, end + 1));
      }
    }
  } catch {}

  console.warn("[friday][session-memory-extraction-llm-client] JSON parse failed:", trimmed.slice(0, 200));
  throw new FridayDomainError(
    FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.PARSE_ERROR,
    `Failed to parse JSON from model output: ${trimmed.slice(0, 200)}`,
    { httpStatus: 422 },
  );
}

// ─── Validation ───

const VALID_KINDS = new Set<string>(["fact", "decision", "preference", "action_item"]);

function validateLlmResponse(
  parsed: unknown,
  validMessageIds: Set<string>,
): FridaySessionMemoryExtractionLlmResponse {
  if (parsed === null || typeof parsed !== "object") {
    throw new FridayDomainError(
      FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.PARSE_ERROR,
      "LLM response is not an object",
      { httpStatus: 422 },
    );
  }

  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj["items"])) {
    throw new FridayDomainError(
      FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.PARSE_ERROR,
      "LLM response missing 'items' array",
      { httpStatus: 422 },
    );
  }

  const rawItems = obj["items"] as unknown[];
  const items: FridaySessionMemoryExtractionLlmItem[] = [];

  for (const raw of rawItems) {
    if (raw === null || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;

    const kind = item["kind"];
    if (typeof kind !== "string" || !VALID_KINDS.has(kind)) continue;

    const content = item["content"];
    if (typeof content !== "string" || !content.trim()) continue;

    const sourceMessageIds = item["sourceMessageIds"];
    if (!Array.isArray(sourceMessageIds)) continue;
    const validIds = sourceMessageIds.filter(
      (id): id is string => typeof id === "string" && validMessageIds.has(id),
    );

    // Skip items with no valid source message references
    if (validIds.length === 0) continue;

    const tags = Array.isArray(item["tags"])
      ? (item["tags"] as unknown[]).filter((t): t is string => typeof t === "string")
      : undefined;

    items.push({
      kind: kind as FridaySessionMemoryExtractionItemKind,
      content: content.trim(),
      sourceMessageIds: validIds,
      tags,
    });
  }

  return { items };
}

// ─── Factory ───

export function createFridaySessionMemoryExtractionLlmClient(
  deps: CreateFridaySessionMemoryExtractionLlmClientDeps,
): FridaySessionMemoryExtractionLlmClient {
  return {
    async extractMemoryItems(messages, maxItems, tenantContext) {
      if (messages.length === 0) {
        return { items: [] };
      }

      const taskProfile = resolveFridayAgentTaskProfile("deterministic");
      const userPrompt = buildUserPrompt(messages, maxItems);
      const validMessageIds = new Set(messages.map((m) => m.id));

      const fallbackResult = await deps.providerService.runWithFallback({
        tenantContext,
        run: async (
          currentRoute: FridayResolvedProviderRoute,
          credential: string | null,
        ) => {
          const { provider } = currentRoute;
          const api = provider.config.api;
          const model = currentRoute.model;

          const url = buildUrl(api, provider.baseUrl, model);
          const headers = buildHeaders(api, credential, provider.config.headers, provider.config.authMode);
          const body = buildRequestBody(
            api,
            model,
            EXTRACTION_SYSTEM_PROMPT,
            userPrompt,
            taskProfile.temperature ?? 0,
            provider.config.authMode,
          );

          const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new FridayDomainError(
              FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.PROVIDER_ERROR,
              `Provider ${provider.name} returned ${response.status}: ${errorText.slice(0, 500)}`,
              { httpStatus: 502, retryable: true },
            );
          }

          const responseBody = (await response.json()) as Record<string, unknown>;
          return extractTextFromResponse(api, responseBody);
        },
      });

      const rawText = fallbackResult.result;

      if (!rawText) {
        return { items: [] };
      }

      const parsed = parseJsonFromText(rawText);
      return validateLlmResponse(parsed, validMessageIds);
    },
  };
}

// ─── Re-exports for testing ───

/** @internal - test only */
export { validateLlmResponse as _validateLlmResponse };
/** @internal - test only */
export { parseJsonFromText as _parseJsonFromText };
