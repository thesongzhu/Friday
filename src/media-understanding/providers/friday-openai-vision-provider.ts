/**
 * OpenAI Vision Provider — Concrete FridayMediaUnderstandingProvider that calls
 * the OpenAI chat completions API with a multimodal content array.
 *
 * @module media-understanding/providers/friday-openai-vision-provider
 */

import type {
  FridayMediaAttachment,
  FridayMediaType,
  FridayMediaUnderstandingOutput,
  FridayMediaUnderstandingProvider,
} from "../friday-media-understanding.types.js";

export const FRIDAY_OPENAI_VISION_PROVIDER_ID = "openai-vision";

export const DEFAULT_OPENAI_VISION_MODEL = "gpt-4o-mini";
export const DEFAULT_OPENAI_VISION_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_VISION_PROMPT =
  "Describe this image factually in one paragraph.";
export const DEFAULT_OPENAI_VISION_MAX_TOKENS = 256;
export const DEFAULT_OPENAI_VISION_IMAGE_DETAIL: "low" | "high" | "auto" = "low";

const SUPPORTED_MEDIA_TYPES: readonly FridayMediaType[] = ["image"] as const;

export interface FridayOpenAiVisionProviderConfig {
  /** Resolved OpenAI API key plaintext. Never logged, never echoed in errors. */
  readonly apiKey: string;
  /** Model id (e.g. "gpt-4o-mini"). */
  readonly model?: string;
  /** Optional base URL override (e.g. for openai-compatible gateways). */
  readonly baseUrl?: string;
  /** Optional user prompt override; defaults to a factual one-paragraph description. */
  readonly prompt?: string;
  /** Image detail hint for OpenAI vision; "low" minimizes cost on smoke probes. */
  readonly imageDetail?: "low" | "high" | "auto";
  /** Optional fetch override for testability (defaults to globalThis.fetch). */
  readonly fetchImpl?: typeof fetch;
}

interface OpenAiChatCompletionResponse {
  readonly choices?: ReadonlyArray<{
    readonly message?: { readonly content?: string };
  }>;
}

/**
 * Construct a FridayMediaUnderstandingProvider that uses OpenAI chat completions
 * with the multimodal `image_url` content schema.
 *
 * The caller supplies a plaintext API key resolved via the canonical secret-ref
 * pipeline (`parseFridaySecretInput` + `resolveFridaySecretInput`). The plaintext
 * is held only in this provider's closure; it is never read from `process.env`
 * here, never logged, never returned in any output field, and never embedded in
 * thrown error messages.
 */
export function createFridayOpenAiVisionProvider(
  config: FridayOpenAiVisionProviderConfig,
): FridayMediaUnderstandingProvider {
  if (typeof config.apiKey !== "string" || config.apiKey.trim().length === 0) {
    throw new Error("[openai-vision] apiKey is required and must be non-empty.");
  }
  const apiKey = config.apiKey;
  const model = config.model && config.model.trim().length > 0
    ? config.model
    : DEFAULT_OPENAI_VISION_MODEL;
  const baseUrl = (config.baseUrl && config.baseUrl.trim().length > 0
    ? config.baseUrl
    : DEFAULT_OPENAI_VISION_BASE_URL
  ).replace(/\/+$/, "");
  const prompt = config.prompt && config.prompt.trim().length > 0
    ? config.prompt
    : DEFAULT_OPENAI_VISION_PROMPT;
  const imageDetail = config.imageDetail ?? DEFAULT_OPENAI_VISION_IMAGE_DETAIL;
  const fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);

  return {
    providerId: FRIDAY_OPENAI_VISION_PROVIDER_ID,
    supportedMediaTypes: SUPPORTED_MEDIA_TYPES,
    async process(
      attachment: FridayMediaAttachment,
      fetchContent: () => Promise<Buffer>,
    ): Promise<FridayMediaUnderstandingOutput> {
      const startTime = Date.now();

      const buffer = await fetchContent();
      const base64 = buffer.toString("base64");
      const mimeType = (attachment.mimeType && attachment.mimeType.trim().length > 0
        ? attachment.mimeType
        : "image/png");
      const dataUrl = `data:${mimeType};base64,${base64}`;

      const body = {
        model,
        messages: [
          {
            role: "user" as const,
            content: [
              { type: "text" as const, text: prompt },
              {
                type: "image_url" as const,
                image_url: { url: dataUrl, detail: imageDetail },
              },
            ],
          },
        ],
        max_tokens: DEFAULT_OPENAI_VISION_MAX_TOKENS,
        temperature: 0,
      };

      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Authorization header uses the resolved plaintext from the closure;
            // it is never logged or echoed by this provider.
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        throw new Error(`[openai-vision] network error: ${redactSecretShapes(toMessage(err))}`);
      }

      if (!response.ok) {
        const status = response.status;
        const text = await safeReadResponseText(response);
        throw new Error(`[openai-vision] HTTP ${status}: ${truncateForError(redactSecretShapes(text))}`);
      }

      let json: OpenAiChatCompletionResponse;
      try {
        json = (await response.json()) as OpenAiChatCompletionResponse;
      } catch (err) {
        throw new Error(`[openai-vision] failed to parse JSON response: ${redactSecretShapes(toMessage(err))}`);
      }

      const content = json?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim().length === 0) {
        throw new Error("[openai-vision] HTTP 200 but no content in response.choices[0].message.content");
      }

      return {
        description: content.trim(),
        // OpenAI does not expose a calibrated confidence; do not fabricate.
        confidence: 0,
        provider: FRIDAY_OPENAI_VISION_PROVIDER_ID,
        processingMs: Date.now() - startTime,
      };
    },
  };
}

// ─── Helpers ───

async function safeReadResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<failed to read response body>";
  }
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncateForError(text: string, maxLen = 200): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length <= maxLen ? trimmed : `${trimmed.slice(0, maxLen)}…`;
}

/**
 * Defense-in-depth: scrub anything that looks like an OpenAI / bearer-token
 * secret out of upstream error bodies before they appear in our thrown
 * Error.message. The upstream API should not return our key, but we redact
 * shape-matches anyway so a misbehaving gateway cannot leak through.
 */
function redactSecretShapes(text: string): string {
  // Build patterns at runtime to avoid embedding literal high-entropy-looking
  // strings in this file's source text.
  // pragma: allowlist secret
  const SK = new RegExp(`${"sk"}-[A-Za-z0-9_-]{20,}`, "g");
  const BEARER = new RegExp(`${"Bearer"} [A-Za-z0-9._\\-]{20,}`, "g");
  return text.replace(SK, "sk-***redacted***").replace(BEARER, "Bearer ***redacted***");
}
