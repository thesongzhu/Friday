import * as fs from "node:fs";
import { FridayDomainError } from "#errors";

// ─── Constants ───

const DEFAULT_MODEL = "whisper-1";
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB (OpenAI Whisper limit)

const SUPPORTED_FORMATS = new Set([
  "mp3", "mp4", "mpeg", "mpga", "m4a", "wav", "webm", "ogg", "flac",
]);

// ─── Types ───

export interface FridaySttRequest {
  audioFilePath: string;
  language?: string;
  model?: string;
  prompt?: string;
}

export interface FridaySttResult {
  /** Transcribed text. */
  text: string;
  /** Model used. */
  model: string;
  /** Detected language (if available). */
  language?: string;
  /** Duration of the audio in seconds (if available). */
  durationSeconds?: number;
}

/**
 * Provider-agnostic speech-to-text function.
 * Implementors call their STT API and return transcribed text.
 */
export type FridaySttTranscribeFn = (
  request: FridaySttRequest,
  signal: AbortSignal,
) => Promise<FridaySttResult>;

export interface FridaySttServiceOptions {
  /** Provider transcription function. */
  transcribe: FridaySttTranscribeFn;
  /** Default model. */
  defaultModel?: string;
}

export interface FridaySttService {
  transcribe(
    request: FridaySttRequest,
    signal: AbortSignal,
  ): Promise<FridaySttResult>;
}

// ─── Validation ───

export function validateAudioFile(filePath: string): void {
  if (!filePath || filePath.trim().length === 0) {
    throw new FridayDomainError("VALIDATION_ERROR", "Audio file path is required.", { httpStatus: 400 });
  }
  if (!fs.existsSync(filePath)) {
    throw new FridayDomainError("RESOURCE_NOT_FOUND", `Audio file not found: ${filePath}`, { httpStatus: 404 });
  }
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_SIZE_BYTES) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `Audio file too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB. Max: 25MB.`,
      { httpStatus: 400 },
    );
  }

  // Check extension
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (ext && !SUPPORTED_FORMATS.has(ext)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `Unsupported audio format ".${ext}". Supported: ${Array.from(SUPPORTED_FORMATS).join(", ")}.`,
      { httpStatus: 400 },
    );
  }
}

// ─── Factory ───

export function createFridaySttService(
  options: FridaySttServiceOptions,
): FridaySttService {
  const {
    transcribe,
    defaultModel = DEFAULT_MODEL,
  } = options;

  return {
    async transcribe(
      request: FridaySttRequest,
      signal: AbortSignal,
    ): Promise<FridaySttResult> {
      validateAudioFile(request.audioFilePath);
      const model = request.model ?? defaultModel;

      return transcribe(
        { ...request, model },
        signal,
      );
    },
  };
}
