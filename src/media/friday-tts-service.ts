import * as fs from "node:fs";
import * as path from "node:path";
import { FridayDomainError } from "#errors";

// ─── Constants ───

const DEFAULT_VOICE = "alloy";
const DEFAULT_FORMAT = "mp3";
const DEFAULT_SPEED = 1.0;
const DEFAULT_MODEL = "tts-1";
const MAX_TEXT_LENGTH = 4096;
const MIN_SPEED = 0.25;
const MAX_SPEED = 4.0;

const VALID_FORMATS = new Set(["mp3", "wav", "opus"]);

const FORMAT_MIME_MAP: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  opus: "audio/opus",
};

// ─── Types ───

export type FridayTtsFormat = "mp3" | "wav" | "opus";

export interface FridayTtsRequest {
  text: string;
  voice?: string;
  format?: FridayTtsFormat;
  speed?: number;
  model?: string;
}

export interface FridayTtsResult {
  /** Audio data buffer. */
  data: Buffer;
  /** MIME type of the output audio. */
  mimeType: string;
  /** Format used. */
  format: FridayTtsFormat;
  /** Voice used. */
  voice: string;
  /** Model used. */
  model: string;
}

/**
 * Provider-agnostic synthesis function.
 * Implementors call their TTS API and return raw audio bytes.
 */
export type FridayTtsSynthesizeFn = (
  request: FridayTtsRequest,
  signal: AbortSignal,
) => Promise<FridayTtsResult>;

export interface FridayTtsServiceOptions {
  /** Directory to write audio artifacts. Created if missing. */
  artifactDir: string;
  /** Provider synthesis function. */
  synthesize: FridayTtsSynthesizeFn;
  /** Default voice. */
  defaultVoice?: string;
  /** Default format. */
  defaultFormat?: FridayTtsFormat;
  /** Default model. */
  defaultModel?: string;
}

export interface FridayTtsServiceResult {
  /** Absolute path to the written audio file. */
  filePath: string;
  /** MIME type. */
  mimeType: string;
  /** File size in bytes. */
  bytes: number;
  /** Voice used. */
  voice: string;
  /** Model used. */
  model: string;
  /** Format used. */
  format: FridayTtsFormat;
}

export interface FridayTtsService {
  synthesize(
    request: FridayTtsRequest,
    signal: AbortSignal,
  ): Promise<FridayTtsServiceResult>;
}

// ─── Validation ───

export function validateTtsText(text: string): void {
  if (!text || text.trim().length === 0) {
    throw new FridayDomainError("VALIDATION_ERROR", "Text is required for TTS.", { httpStatus: 400 });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new FridayDomainError("VALIDATION_ERROR", `Text exceeds maximum length of ${MAX_TEXT_LENGTH} characters.`, { httpStatus: 400 });
  }
}

export function validateTtsFormat(format: string | undefined): FridayTtsFormat {
  if (!format) return DEFAULT_FORMAT;
  if (!VALID_FORMATS.has(format)) {
    throw new FridayDomainError("VALIDATION_ERROR", `Invalid format "${format}". Valid: ${Array.from(VALID_FORMATS).join(", ")}.`, { httpStatus: 400 });
  }
  return format as FridayTtsFormat;
}

export function validateTtsSpeed(speed: number | undefined): number {
  if (speed === undefined) return DEFAULT_SPEED;
  if (speed < MIN_SPEED || speed > MAX_SPEED) {
    throw new FridayDomainError("VALIDATION_ERROR", `Speed must be between ${MIN_SPEED} and ${MAX_SPEED}. Got: ${speed}`, { httpStatus: 400 });
  }
  return speed;
}

// ─── Factory ───

export function createFridayTtsService(
  options: FridayTtsServiceOptions,
): FridayTtsService {
  const {
    artifactDir,
    synthesize,
    defaultVoice = DEFAULT_VOICE,
    defaultFormat = DEFAULT_FORMAT,
    defaultModel = DEFAULT_MODEL,
  } = options;

  return {
    async synthesize(
      request: FridayTtsRequest,
      signal: AbortSignal,
    ): Promise<FridayTtsServiceResult> {
      // Validate inputs
      validateTtsText(request.text);
      const format = validateTtsFormat(request.format);
      const speed = validateTtsSpeed(request.speed);
      const voice = request.voice ?? defaultVoice;
      const model = request.model ?? defaultModel;

      // Call provider
      const result = await synthesize(
        { text: request.text, voice, format, speed, model },
        signal,
      );

      // Ensure artifact directory exists
      fs.mkdirSync(artifactDir, { recursive: true });

      // Write file
      const timestamp = Date.now();
      const filename = `tts-${timestamp}.${format}`;
      const filePath = path.join(artifactDir, filename);
      fs.writeFileSync(filePath, result.data);

      return {
        filePath,
        mimeType: FORMAT_MIME_MAP[format] ?? "application/octet-stream",
        bytes: result.data.byteLength,
        voice: result.voice,
        model: result.model,
        format: result.format,
      };
    },
  };
}
