import { FridayDomainError } from "#errors";
import type { FridayProviderAuthMode, FridayProviderService } from "#providers";
import type {
  FridayCostRoutingDecision,
  FridayPromptCacheHints,
  FridayProviderApi,
  FridayProviderKind,
  FridayProviderNormalizedUsage,
  FridayProviderRouteStrategy,
  FridayResolvedProviderRoute,
} from "#providers";
import { isFridayAnthropicBearerAuthMode } from "#providers";

import {
  FRIDAY_ANTHROPIC_OAUTH_DISABLED_MESSAGE,
} from "../../../providers/oauth/friday-anthropic-oauth.js";

import type {
  FridayInferenceRequest,
  FridayInferenceResult,
  FridayProviderInferenceClient,
} from "./friday-provider-inference-client.types.js";
import { resolveFridayAgentTaskProfile } from "../../../agent/runtime/friday-agent-task-profile.js";

import {
  createFridayProviderComplexityClassifier,
  createFridayProviderContextCompactor,
  createFridayProviderContextPruner,
  createFridayProviderCostCalculator,
  createFridayProviderPricingCatalog,
  createFridayProviderPromptCacheAdapter,
  createFridayProviderTokenEstimator,
  createFridayProviderUsageNormalizer,
  extractProviderRequestId,
} from "#providers";

// ─── Deps ───

export interface CreateFridayProviderInferenceClientDeps {
  providerService: FridayProviderService;
}

const FRIDAY_PROVIDER_INFERENCE_ERROR_BODY_MAX_BYTES = 4096;

// ─── Message shape for provider APIs ───

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

async function readProviderErrorText(response: Response): Promise<string> {
  if (!response.body) {
    return response.text();
  }

  const byteLimit = FRIDAY_PROVIDER_INFERENCE_ERROR_BODY_MAX_BYTES + 1;
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
  return text.length > FRIDAY_PROVIDER_INFERENCE_ERROR_BODY_MAX_BYTES
    ? `${text.slice(0, FRIDAY_PROVIDER_INFERENCE_ERROR_BODY_MAX_BYTES)}...[truncated]`
    : text;
}

// ─── Build request body per provider API ───

function buildRequestBody(
  api: FridayProviderApi,
  model: string,
  messages: ChatMessage[],
  temperature?: number,
): Record<string, unknown> {
  switch (api) {
    case "openai-completions":
      return {
        model,
        messages,
        temperature: temperature ?? 0,
        response_format: { type: "json_object" },
      };
    case "openai-responses":
    case "openai-codex-responses": {
      // OpenAI Responses API uses `input` (array of items), not `messages`
      const input: Array<Record<string, unknown>> = [];
      const systemMsg = messages.find((m) => m.role === "system");
      if (systemMsg && api !== "openai-codex-responses") {
        input.push({
          role: "system",
          content: systemMsg.content,
        });
      }
      for (const m of messages.filter((m) => m.role !== "system")) {
        input.push({
          role: m.role,
          content: api === "openai-codex-responses"
            ? [{ type: "input_text", text: m.content }]
            : m.content,
        });
      }
      return {
        model,
        input,
        ...(api === "openai-codex-responses"
          ? {
              instructions: systemMsg?.content ?? "You are Friday. Return the requested JSON object.",
              store: false,
            }
          : {}),
        ...(api !== "openai-codex-responses" ? { temperature: temperature ?? 0 } : {}),
        text: { format: { type: "json_object" } },
      };
    }
    case "anthropic-messages": {
      const systemMsg = messages.find((m) => m.role === "system");
      const nonSystem = messages.filter((m) => m.role !== "system");
      return {
        model,
        system: systemMsg?.content ?? "",
        messages: nonSystem,
        max_tokens: 8192,
        temperature: temperature ?? 0,
      };
    }
    case "google-generative-ai":
      return {
        model,
        contents: messages
          .filter((m) => m.role !== "system")
          .map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          })),
        systemInstruction: messages.find((m) => m.role === "system")
          ? {
              parts: [
                { text: messages.find((m) => m.role === "system")!.content },
              ],
            }
          : undefined,
        generationConfig: { temperature: temperature ?? 0, responseMimeType: "application/json" },
      };
    case "ollama":
      return {
        model,
        messages,
        stream: false,
        format: "json",
        options: { temperature: temperature ?? 0 },
      };
  }
}

// ─── Build URL ───

function buildUrl(api: FridayProviderApi, baseUrl: string, model: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  switch (api) {
    case "openai-completions":
      return `${base}/v1/chat/completions`;
    case "openai-responses":
      return `${base}/v1/responses`;
    case "openai-codex-responses":
      return `${base}/responses`;
    case "anthropic-messages":
      return `${base}/v1/messages`;
    case "google-generative-ai":
      return `${base}/v1beta/models/${model}:generateContent`;
    case "ollama":
      return `${base}/api/chat`;
  }
}

// ─── Build headers ───

function buildHeaders(
  api: FridayProviderApi,
  credential: string | null,
  extraHeaders?: Record<string, string>,
  authMode?: FridayProviderAuthMode,
): Record<string, string> {
  const isBearerAuth = isFridayAnthropicBearerAuthMode(authMode);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };

  if (credential) {
    switch (api) {
      case "anthropic-messages":
        if (isBearerAuth) {
          throw new FridayDomainError(
            "PROVIDER_AUTH_UNSUPPORTED",
            FRIDAY_ANTHROPIC_OAUTH_DISABLED_MESSAGE,
            { httpStatus: 400 },
          );
        } else {
          headers["x-api-key"] = credential;
        }
        headers["anthropic-version"] = "2023-06-01";
        break;
      case "google-generative-ai":
        headers["x-goog-api-key"] = credential;
        break;
      case "openai-codex-responses":
        headers["Authorization"] = `Bearer ${credential}`;
        headers.originator = "friday";
        headers["User-Agent"] = "friday";
        break;
      default:
        headers["Authorization"] = `Bearer ${credential}`;
        break;
    }
  }

  return headers;
}

// ─── Extract text content from provider response ───

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
    case "openai-responses":
    case "openai-codex-responses": {
      // Responses API: output[] → find message item → content[] → find text
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
        | Array<{
            content?: { parts?: Array<{ text?: string }> };
          }>
        | undefined;
      return candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    }
    case "ollama": {
      const message = body["message"] as { content?: string } | undefined;
      return message?.content ?? "";
    }
  }
}

function extractRefusalFromResponse(
  api: FridayProviderApi,
  body: Record<string, unknown>,
): string | undefined {
  switch (api) {
    case "openai-completions": {
      const choices = body["choices"] as
        | Array<{ message?: { refusal?: string | null } }>
        | undefined;
      const refusal = choices?.[0]?.message?.refusal;
      return typeof refusal === "string" && refusal.trim().length > 0
        ? refusal
        : undefined;
    }
    case "openai-responses":
    case "openai-codex-responses": {
      const output = body["output"] as
        | Array<{ type?: string; content?: Array<{ type?: string; refusal?: string }> }>
        | undefined;
      const messageItem = output?.find((o) => o.type === "message");
      const refusalPart = messageItem?.content?.find((c) => c.type === "refusal");
      return typeof refusalPart?.refusal === "string" && refusalPart.refusal.trim().length > 0
        ? refusalPart.refusal
        : undefined;
    }
    case "anthropic-messages":
    case "google-generative-ai":
    case "ollama":
      return undefined;
  }
}

// ─── Parse JSON from model output ───

function parseJsonFromText<T>(rawText: string): T {
  const trimmed = rawText.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {}

  try {
    const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(trimmed);
    if (fenceMatch?.[1]) {
      return JSON.parse(fenceMatch[1].trim()) as T;
    }
  } catch {}

  try {
    const startBrace = trimmed.indexOf("{");
    const startBracket = trimmed.indexOf("[");
    const start =
      startBrace === -1
        ? startBracket
        : startBracket === -1
          ? startBrace
          : Math.min(startBrace, startBracket);

    if (start !== -1) {
      const isArray = trimmed[start] === "[";
      const endChar = isArray ? "]" : "}";
      const end = trimmed.lastIndexOf(endChar);
      if (end > start) {
        return JSON.parse(trimmed.slice(start, end + 1)) as T;
      }
    }
  } catch {}

  console.warn("[friday][provider-inference-client] operation failed:", trimmed.slice(0, 200));
  throw new FridayDomainError("PARSE_ERROR", `Failed to parse JSON from model output: ${trimmed.slice(0, 200)}`, { httpStatus: 422 });
}

// ─── Factory ───

export function createFridayProviderInferenceClient(
  deps: CreateFridayProviderInferenceClientDeps,
): FridayProviderInferenceClient {
  const tokenEstimator = createFridayProviderTokenEstimator();
  const complexityClassifier = createFridayProviderComplexityClassifier();
  const usageNormalizer = createFridayProviderUsageNormalizer();
  const pricingCatalog = createFridayProviderPricingCatalog();
  const costCalculator = createFridayProviderCostCalculator({ pricingCatalog });
  const cacheAdapter = createFridayProviderPromptCacheAdapter();
  const pruner = createFridayProviderContextPruner();
  const contextCompactor = createFridayProviderContextCompactor({
    estimator: tokenEstimator,
    pruner,
  });

  /** Default context window size when compaction is needed. */
  const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

  return {
    async infer<T>(request: FridayInferenceRequest): Promise<FridayInferenceResult<T>> {
      const resolvedTaskProfile = resolveFridayAgentTaskProfile(request.taskProfile ?? "deterministic");
      let messages: ChatMessage[] = [
        { role: "system", content: request.prompt.system },
        { role: "user", content: request.prompt.user },
      ];

      // When session context is provided, run context compaction before building the LLM request
      if (request.sessionContext) {
        const sessionMessages = request.sessionContext.messages;
        const compactionResult = await contextCompactor.compact({
          systemPrompt: request.prompt.system,
          userPrompt: request.prompt.user,
          messages: sessionMessages,
          contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
          summarize: async (prompt) => {
            // Use the provider service itself for summarization
            const summaryResult = await deps.providerService.runWithFallback({
              tenantContext: request.tenantContext,
              run: async (route, credential) => {
                const api = route.provider.config.api;
                const model = route.model;
                const url = buildUrl(api, route.provider.baseUrl, model);
                const authMode = route.provider.config.authMode;
                const headers = buildHeaders(api, credential, route.provider.config.headers, authMode);
                const body = buildRequestBody(api, model, [
                  { role: "system", content: prompt.system },
                  { role: "user", content: prompt.user },
                ], resolvedTaskProfile.temperature);
                const resp = await fetch(url, {
                  method: "POST",
                  headers,
                  body: JSON.stringify(body),
                  signal: AbortSignal.timeout(120_000),
                });
                if (!resp.ok) {
                  const errorText = await readProviderErrorText(resp);
                  throw new FridayDomainError(
                    "PROVIDER_ERROR",
                    `Compaction summary failed: ${errorText.slice(0, 500)}`,
                    { httpStatus: 502 },
                  );
                }
                const respBody = (await resp.json()) as Record<string, unknown>;
                return extractTextFromResponse(api, respBody) ?? "";
              },
            });
            return summaryResult.result;
          },
        });

        // Build messages from compacted results
        const compactedMessages: ChatMessage[] = [
          { role: "system", content: request.prompt.system },
        ];
        for (const m of compactionResult.keptMessages) {
          const role: ChatMessage["role"] =
            m.role === "tool-result" ? "assistant" : m.role;
          compactedMessages.push({ role, content: m.content });
        }
        compactedMessages.push({ role: "user", content: request.prompt.user });
        messages = compactedMessages;
      }

      // Estimate input tokens and classify complexity for routing
      const estimatedInputTokens = tokenEstimator.estimateMessagesTokens(messages);
      const complexity = complexityClassifier.classify({
        systemPrompt: request.prompt.system,
        userPrompt: request.prompt.user,
        estimatedInputTokens,
      });

      const fallbackResult = await deps.providerService.runWithFallback({
        requestedModel: request.requestedModel,
        tenantContext: request.tenantContext,
        routingContext: { estimatedInputTokens, complexity },
        run: async (
          currentRoute: FridayResolvedProviderRoute,
          credential: string | null,
        ) => {
          const { provider } = currentRoute;
          const api = provider.config.api;
          const model = currentRoute.model;

          const authMode = provider.config.authMode;
          const url = buildUrl(api, provider.baseUrl, model);
          let headers = buildHeaders(
            api,
            credential,
            provider.config.headers,
            authMode,
          );

          const effectiveMessages = messages;
          let body = buildRequestBody(api, model, effectiveMessages, resolvedTaskProfile.temperature);

          // Apply Anthropic prompt caching when applicable
          if (api === "anthropic-messages") {
            // Detect static user content blocks (spec summary, large context)
            const userStaticBlockIndexes: number[] = [];
            const userContent = request.prompt.user;
            if (
              request.sessionContext?.specSummary ||
              userContent.length >= 800
            ) {
              userStaticBlockIndexes.push(0);
            }

            const cacheHints: FridayPromptCacheHints = {
              api,
              providerKind: provider.kind,
              anthropic: {
                enabled: true,
                systemCache: true,
                userStaticBlockIndexes,
              },
              openaiSystemCache: { enabled: false },
            };

            const cacheResult = cacheAdapter.applyAnthropicCacheHints({
              systemPrompt: request.prompt.system,
              userPrompt: request.prompt.user,
              hints: cacheHints,
            });

            // Replace string system prompt with content blocks and merge cached user blocks
            // Preserve compacted session history; only replace the last user message with cache-enhanced content
            const existingMessages = body["messages"] as Array<{ role: string; content: unknown }>;
            const lastUserIdx = existingMessages.findLastIndex((m) => m.role === "user");
            const mergedMessages =
              lastUserIdx >= 0
                ? [
                    ...existingMessages.slice(0, lastUserIdx),
                    { role: "user" as const, content: cacheResult.userBlocks },
                    ...existingMessages.slice(lastUserIdx + 1),
                  ]
                : [...existingMessages, { role: "user" as const, content: cacheResult.userBlocks }];

            body = {
              ...body,
              system: cacheResult.systemBlocks,
              messages: mergedMessages,
            };
            // Merge cache headers — append anthropic-beta flags instead of replacing
            const cacheHeaders = cacheResult.extraHeaders;
            if (cacheHeaders["anthropic-beta"] && headers["anthropic-beta"]) {
              // Deduplicate beta flags to avoid Anthropic API rejecting unknown combinations
              const existing = new Set(headers["anthropic-beta"].split(",").map((f: string) => f.trim()));
              for (const flag of cacheHeaders["anthropic-beta"].split(",")) {
                existing.add(flag.trim());
              }
              cacheHeaders["anthropic-beta"] = [...existing].join(",");
            }
            headers = { ...headers, ...cacheHeaders };
          }

          const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120_000),
          });

          if (!response.ok) {
            const errorText = await readProviderErrorText(response);
            console.error(
              `[friday][generator-llm] Provider ${provider.name} (${api}, model=${model}) returned ${response.status}:`,
              errorText.slice(0, 1000),
            );
            throw new FridayDomainError(
              "PROVIDER_ERROR",
              `Provider ${provider.name} returned ${response.status}: ${errorText.slice(0, 500)}`,
              { httpStatus: 502 },
            );
          }

          const responseBody = (await response.json()) as Record<string, unknown>;
          const rawText = extractTextFromResponse(api, responseBody);

          if (!rawText) {
            const refusal = extractRefusalFromResponse(api, responseBody);
            if (refusal) {
              throw new FridayDomainError(
                "PROVIDER_ERROR",
                `Provider refused request: ${refusal.slice(0, 500)}`,
                { httpStatus: 422 },
              );
            }
            throw new FridayDomainError("PROVIDER_ERROR", "Empty response from provider", { httpStatus: 502 });
          }

          // Normalize usage and compute cost
          const usage = usageNormalizer.normalize(api, responseBody);
          const costUsd = costCalculator.calculate({
            providerKind: provider.kind,
            model,
            usage,
          });
          // Capture the provider's own request-id from the completed response
          // so the usage record is idempotent on it and carries a receipt.
          const requestId = extractProviderRequestId(api, response.headers, responseBody);

          return {
            rawText,
            model,
            providerId: provider.id,
            providerApi: api,
            providerKind: provider.kind,
            usage,
            costUsd,
            requestId,
          };
        },
      });

      const { result, route } = fallbackResult;
      // routingDecision may be undefined in test mocks that use the old interface shape
      const routingDecision = "routingDecision" in fallbackResult
        ? (fallbackResult as { routingDecision: FridayCostRoutingDecision }).routingDecision
        : undefined;

      const resolvedStrategy = routingDecision?.strategy ?? "configured";

      // Record usage asynchronously (fire-and-forget, errors logged)
      if (result.usage && typeof deps.providerService.recordUsage === "function") {
        deps.providerService.recordUsage({
          providerId: result.providerId,
          providerApi: result.providerApi,
          model: result.model,
          routeStrategy: resolvedStrategy,
          taskComplexity: complexity,
          usage: result.usage,
          costUsd: result.costUsd,
          // Provider request-id: makes the write idempotent (no double-count on
          // retry/replay) and binds a durable receipt to the call.
          requestId: result.requestId,
          // Distinguish this runtime path truthfully in usage artifacts
          // (hub-agent callers tag source="agent-runtime").
          metadata: { source: "generator-llm" },
        }).catch(() => {
          // Usage recording is best-effort; swallow errors
        });
      }

      const parsed = parseJsonFromText<T>(result.rawText);

      return {
        parsed,
        rawText: result.rawText,
        model: route.model,
        providerId: route.provider.id,
        usage: result.usage,
        costUsd: result.costUsd,
        routeStrategy: resolvedStrategy,
      };
    },
  };
}

// ─── Re-export for testability ───

export { parseJsonFromText as _parseJsonFromText };
