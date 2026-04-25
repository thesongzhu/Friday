/**
 * Brief TTS — provider-agnostic types.
 *
 * A provider takes a language-tagged text and produces a playable audio buffer.
 * The registry selects a provider per-run based on the user's config.
 */

import type { FridayBriefTtsProviderKind } from "../friday-brief.types.js";

export interface FridayBriefTtsInput {
  text: string;
  /** BCP-47 language tag (e.g. "zh-CN", "en-US"). */
  language: string;
  /** Explicit voice override — when unset, provider picks based on language. */
  voice?: string;
}

export interface FridayBriefTtsOutput {
  /** Audio bytes. */
  data: Buffer;
  /** Output format extension ("mp3" / "amr" / "wav"). */
  format: string;
  mimeType: string;
  provider: FridayBriefTtsProviderKind;
  voice: string;
  /** Estimated duration in seconds. */
  durationSec?: number;
}

export interface FridayBriefTtsProvider {
  readonly kind: FridayBriefTtsProviderKind;
  /** Whether the provider has resolvable credentials and is ready. */
  isConfigured(): boolean;
  /** Synthesize audio. Must throw on failure — caller wraps for fallback. */
  synthesize(input: FridayBriefTtsInput, signal: AbortSignal): Promise<FridayBriefTtsOutput>;
}

/** Registry that picks the active provider based on current config. */
export interface FridayBriefTtsRegistry {
  get(kind: FridayBriefTtsProviderKind): FridayBriefTtsProvider | undefined;
  /** Pick the configured provider, with fallback to any configured provider. */
  select(preferred: FridayBriefTtsProviderKind): FridayBriefTtsProvider | undefined;
}
