/**
 * Brief delivery — outbound-only client interface.
 *
 * Each delivery client knows how to push an audio payload (+ optional text
 * transcript) to a single channel. The service tries clients in the user's
 * fallback order until one succeeds.
 */

import type { FridayBriefChannelKind } from "../friday-brief.types.js";

export interface FridayBriefDeliveryPayload {
  /** Brief run id — used as idempotency hint if the platform supports it. */
  runId: string;
  /** Transcript text. Always present, even if `includeTranscript` is false
   *  — email at least needs a body. */
  transcript: string;
  /** Detected language tag for the transcript. */
  language: string;
  /** Audio artifact. `filePath` must exist for the duration of the call. */
  audio: {
    filePath: string;
    mimeType: string;
    bytes: number;
    /** "mp3", "amr", etc. */
    format: string;
    durationSec?: number;
  };
  /** Whether the user opted to receive the transcript alongside audio. */
  includeTranscript: boolean;
}

export interface FridayBriefDeliveryResult {
  messageId: string;
}

export interface FridayBriefDeliveryClient {
  readonly kind: FridayBriefChannelKind;
  /** Whether this client has all required config + resolvable credentials. */
  isConfigured(): boolean;
  /** Deliver — must throw on failure. */
  deliver(payload: FridayBriefDeliveryPayload, signal: AbortSignal): Promise<FridayBriefDeliveryResult>;
}
