import type { FridayBriefTtsConfig } from "../friday-brief-config.types.js";
import type {
  FridayBriefTtsInput,
  FridayBriefTtsOutput,
  FridayBriefTtsProvider,
} from "./friday-brief-tts.types.js";

export interface FridayBriefGoogleTtsProviderDeps {
  getConfig: () => FridayBriefTtsConfig;
  resolveKey: (refKey: string | undefined) => string | undefined;
  fetchImpl?: typeof fetch;
}

function pickVoice(config: FridayBriefTtsConfig, language: string, override?: string): string {
  if (override && override.length > 0) return override;
  if (language.toLowerCase().startsWith("en")) return config.google.voiceEn;
  return config.google.voice;
}

function pickLanguageCode(voice: string, language: string): string {
  const match = voice.match(/^([a-z]{2,4}-[A-Z]{2})/);
  return match ? match[1] : language;
}

function estimateDurationSec(text: string, languageCode: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const lang = languageCode.toLowerCase();
  if (lang.startsWith("zh") || lang.startsWith("cmn") || lang.startsWith("ja") || lang.startsWith("ko")) {
    const cjk = trimmed.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g);
    const chars = cjk ? cjk.length : trimmed.length;
    return chars / 4;
  }
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  return words / 2.5;
}

export function createFridayBriefGoogleTtsProvider(
  deps: FridayBriefGoogleTtsProviderDeps,
): FridayBriefTtsProvider {
  const fetchImpl = deps.fetchImpl ?? fetch;

  return {
    kind: "google",
    isConfigured(): boolean {
      const cfg = deps.getConfig();
      const key = deps.resolveKey(cfg.google.apiKeyRefKey);
      return typeof key === "string" && key.length > 0;
    },
    async synthesize(input: FridayBriefTtsInput, signal: AbortSignal): Promise<FridayBriefTtsOutput> {
      const cfg = deps.getConfig();
      const key = deps.resolveKey(cfg.google.apiKeyRefKey);
      if (!key) throw new Error("google_key_missing");
      const voice = pickVoice(cfg, input.language, input.voice);
      const languageCode = pickLanguageCode(voice, input.language);
      const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(key)}`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { text: input.text },
          voice: { languageCode, name: voice },
          audioConfig: { audioEncoding: "MP3" },
        }),
        signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`google_tts_${String(response.status)}:${body.slice(0, 240)}`);
      }
      const parsed = (await response.json()) as { audioContent?: string };
      if (!parsed.audioContent) {
        throw new Error("google_tts_empty_response");
      }
      const data = Buffer.from(parsed.audioContent, "base64");
      const durationSec = estimateDurationSec(input.text, languageCode);
      return {
        data,
        format: "mp3",
        mimeType: "audio/mpeg",
        provider: "google",
        voice,
        durationSec,
      };
    },
  };
}
