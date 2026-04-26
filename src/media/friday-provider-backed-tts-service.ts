import { FridayDomainError } from "#errors";

import type { FridayProviderService } from "../providers/services/friday-provider-service.types.js";
import type { FridayResolvedProviderRoute } from "../providers/model/friday-provider.types.js";
import {
  createFridayTtsService,
  type FridayTtsFormat,
  type FridayTtsRequest,
  type FridayTtsResult,
  type FridayTtsService,
} from "./friday-tts-service.js";

const DEFAULT_OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
const DEFAULT_TTS_VOICE = "alloy";

export interface CreateFridayProviderBackedTtsServiceOptions {
  providerService: FridayProviderService;
  artifactDir: string;
  fetchImpl?: typeof fetch;
  defaultModel?: string;
  defaultVoice?: string;
}

export function createFridayProviderBackedTtsService(
  options: CreateFridayProviderBackedTtsServiceOptions,
): FridayTtsService {
  const fetchImpl = options.fetchImpl ?? fetch;
  return createFridayTtsService({
    artifactDir: options.artifactDir,
    defaultModel: options.defaultModel ?? DEFAULT_OPENAI_TTS_MODEL,
    defaultVoice: options.defaultVoice ?? DEFAULT_TTS_VOICE,
    synthesize: async (request, signal) => {
      const { result } = await options.providerService.runWithFallback({
        requestedModel: request.model,
        routingContext: {
          estimatedInputTokens: Math.max(1, Math.ceil(request.text.length / 4)),
          complexity: "simple",
          requiredCapabilities: ["tts"],
        },
        run: async (route, credential) =>
          synthesizeOpenAiCompatibleSpeech({
            route,
            credential,
            request,
            signal,
            fetchImpl,
          }),
      });
      return result;
    },
  });
}

async function synthesizeOpenAiCompatibleSpeech(input: {
  route: FridayResolvedProviderRoute;
  credential: string | null;
  request: FridayTtsRequest;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
}): Promise<FridayTtsResult> {
  if (
    input.route.provider.config.api !== "openai-completions" &&
    input.route.provider.config.api !== "openai-responses"
  ) {
    throw new FridayDomainError(
      "PROVIDER_UNKNOWN_ERROR",
      `TTS is only wired for OpenAI-compatible audio/speech providers; got ${input.route.provider.config.api}.`,
      { httpStatus: 400 },
    );
  }

  const endpoint = `${input.route.provider.baseUrl.replace(/\/+$/, "")}/v1/audio/speech`;
  const model = input.request.model ?? DEFAULT_OPENAI_TTS_MODEL;
  const voice = input.request.voice ?? DEFAULT_TTS_VOICE;
  const format = input.request.format ?? "mp3";
  const speed = input.request.speed ?? 1;
  const response = await input.fetchImpl(endpoint, {
    method: "POST",
    headers: buildOpenAiCompatibleTtsHeaders(input.route, input.credential),
    body: JSON.stringify({
      model,
      input: input.request.text,
      voice,
      response_format: format,
      speed,
    }),
    signal: input.signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new FridayDomainError(
      response.status === 401 || response.status === 403
        ? "PROVIDER_AUTH_INVALID"
        : response.status === 402
          ? "PROVIDER_PAYMENT_REQUIRED"
          : response.status === 404
            ? "PROVIDER_MODEL_UNAVAILABLE"
            : "PROVIDER_UNREACHABLE",
      `TTS provider failed with HTTP ${String(response.status)}${errorText ? `: ${errorText.slice(0, 240)}` : ""}`,
      { httpStatus: response.status },
    );
  }

  const data = Buffer.from(await response.arrayBuffer());
  if (data.byteLength === 0) {
    throw new FridayDomainError(
      "PROVIDER_UNKNOWN_ERROR",
      "TTS provider returned an empty audio response.",
      { httpStatus: 502 },
    );
  }

  return {
    data,
    mimeType: response.headers.get("content-type")?.split(";")[0]?.trim() || mimeTypeForFormat(format),
    format,
    voice,
    model,
  };
}

function buildOpenAiCompatibleTtsHeaders(
  route: FridayResolvedProviderRoute,
  credential: string | null,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(route.provider.config.headers ?? {}),
    ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
  };
}

function mimeTypeForFormat(format: FridayTtsFormat): string {
  switch (format) {
    case "wav":
      return "audio/wav";
    case "opus":
      return "audio/opus";
    case "mp3":
    default:
      return "audio/mpeg";
  }
}
