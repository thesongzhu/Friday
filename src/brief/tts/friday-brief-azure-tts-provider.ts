import type { FridayBriefTtsConfig } from "../friday-brief-config.types.js";
import type {
  FridayBriefTtsInput,
  FridayBriefTtsOutput,
  FridayBriefTtsProvider,
} from "./friday-brief-tts.types.js";

export interface FridayBriefAzureTtsProviderDeps {
  /** Pull the live TTS config slice at call time so user changes take effect. */
  getConfig: () => FridayBriefTtsConfig;
  /** Resolve the subscription key by ref at call time. */
  resolveKey: (refKey: string | undefined) => string | undefined;
  /** Injected fetch — override in tests. */
  fetchImpl?: typeof fetch;
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function pickVoice(config: FridayBriefTtsConfig, language: string, override?: string): string {
  if (override && override.length > 0) return override;
  if (language.toLowerCase().startsWith("en")) return config.azure.voiceEn;
  return config.azure.voice;
}

function buildSsml(text: string, language: string, voice: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${escapeXml(language)}">
  <voice name="${escapeXml(voice)}">
    <prosody rate="0%">${escapeXml(text)}</prosody>
  </voice>
</speak>`;
}

export function createFridayBriefAzureTtsProvider(
  deps: FridayBriefAzureTtsProviderDeps,
): FridayBriefTtsProvider {
  const fetchImpl = deps.fetchImpl ?? fetch;

  return {
    kind: "azure",
    isConfigured(): boolean {
      const cfg = deps.getConfig();
      if (!cfg.azure.region || cfg.azure.region.length === 0) return false;
      const key = deps.resolveKey(cfg.azure.keyRefKey);
      return typeof key === "string" && key.length > 0;
    },
    async synthesize(input: FridayBriefTtsInput, signal: AbortSignal): Promise<FridayBriefTtsOutput> {
      const cfg = deps.getConfig();
      if (!cfg.azure.region) {
        throw new Error("azure_region_missing");
      }
      const key = deps.resolveKey(cfg.azure.keyRefKey);
      if (!key) {
        throw new Error("azure_key_missing");
      }
      const voice = pickVoice(cfg, input.language, input.voice);
      const ssml = buildSsml(input.text, input.language, voice);
      const url = `https://${cfg.azure.region}.tts.speech.microsoft.com/cognitiveservices/v1`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": key,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
          "User-Agent": "friday-brief",
        },
        body: ssml,
        signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`azure_tts_${String(response.status)}:${body.slice(0, 240)}`);
      }
      const arrayBuf = await response.arrayBuffer();
      const data = Buffer.from(arrayBuf);
      const durationSec = data.byteLength > 0 ? (data.byteLength * 8) / 48000 : undefined;
      return {
        data,
        format: "mp3",
        mimeType: "audio/mpeg",
        provider: "azure",
        voice,
        durationSec,
      };
    },
  };
}
