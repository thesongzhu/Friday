import * as fs from "node:fs";
import * as path from "node:path";
import { FridayDomainError } from "#errors";

// ─── Constants ───

const MAX_PROMPT_LENGTH = 4000;
const DEFAULT_SIZE = "1024x1024";
const DEFAULT_STYLE = "natural";
const DEFAULT_MODEL = "dall-e-3";
const DEFAULT_QUALITY = "standard";

const VALID_SIZES = new Set([
  "256x256",
  "512x512",
  "1024x1024",
  "1024x1792",
  "1792x1024",
]);

const VALID_STYLES = new Set(["natural", "vivid"]);
const VALID_QUALITIES = new Set(["standard", "hd"]);

// ─── Types ───

export type FridayImageGenerateSize =
  | "256x256"
  | "512x512"
  | "1024x1024"
  | "1024x1792"
  | "1792x1024";

export type FridayImageGenerateStyle = "natural" | "vivid";
export type FridayImageGenerateQuality = "standard" | "hd";

export interface FridayImageGenerateRequest {
  prompt: string;
  negativePrompt?: string;
  size?: FridayImageGenerateSize;
  style?: FridayImageGenerateStyle;
  quality?: FridayImageGenerateQuality;
  model?: string;
}

export interface FridayImageGenerateResult {
  /** Raw image data. */
  data: Buffer;
  /** MIME type of the generated image. */
  mimeType: string;
  /** Model used. */
  model: string;
  /** Revised prompt (if model rewrote the prompt). */
  revisedPrompt?: string;
}

/**
 * Provider-agnostic image generation function.
 * Implementors call their image generation API and return raw image bytes.
 */
export type FridayImageGenerateFn = (
  request: FridayImageGenerateRequest,
  signal: AbortSignal,
) => Promise<FridayImageGenerateResult>;

export interface FridayImageGenerateServiceOptions {
  /** Directory to write generated image artifacts. Created if missing. */
  artifactDir: string;
  /** Provider generation function. */
  generate: FridayImageGenerateFn;
  /** Default model. */
  defaultModel?: string;
  /** Default size. */
  defaultSize?: FridayImageGenerateSize;
  /** Default style. */
  defaultStyle?: FridayImageGenerateStyle;
  /** Default quality. */
  defaultQuality?: FridayImageGenerateQuality;
}

export interface FridayImageGenerateServiceResult {
  /** Absolute path to the written image file. */
  filePath: string;
  /** MIME type. */
  mimeType: string;
  /** File size in bytes. */
  bytes: number;
  /** Model used. */
  model: string;
  /** Revised prompt. */
  revisedPrompt?: string;
}

export interface FridayImageGenerateService {
  generate(
    request: FridayImageGenerateRequest,
    signal: AbortSignal,
  ): Promise<FridayImageGenerateServiceResult>;
}

// ─── Validation ───

export function validateImagePrompt(prompt: string): void {
  if (!prompt || prompt.trim().length === 0) {
    throw new FridayDomainError("VALIDATION_ERROR", "Prompt is required for image generation.", { httpStatus: 400 });
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new FridayDomainError("VALIDATION_ERROR", `Prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters.`, { httpStatus: 400 });
  }
}

export function validateImageSize(size: string | undefined): FridayImageGenerateSize {
  if (!size) return DEFAULT_SIZE;
  if (!VALID_SIZES.has(size)) {
    throw new FridayDomainError("VALIDATION_ERROR", `Invalid size "${size}". Valid: ${Array.from(VALID_SIZES).join(", ")}.`, { httpStatus: 400 });
  }
  return size as FridayImageGenerateSize;
}

export function validateImageStyle(style: string | undefined): FridayImageGenerateStyle {
  if (!style) return DEFAULT_STYLE;
  if (!VALID_STYLES.has(style)) {
    throw new FridayDomainError("VALIDATION_ERROR", `Invalid style "${style}". Valid: ${Array.from(VALID_STYLES).join(", ")}.`, { httpStatus: 400 });
  }
  return style as FridayImageGenerateStyle;
}

export function validateImageQuality(quality: string | undefined): FridayImageGenerateQuality {
  if (!quality) return DEFAULT_QUALITY;
  if (!VALID_QUALITIES.has(quality)) {
    throw new FridayDomainError("VALIDATION_ERROR", `Invalid quality "${quality}". Valid: ${Array.from(VALID_QUALITIES).join(", ")}.`, { httpStatus: 400 });
  }
  return quality as FridayImageGenerateQuality;
}

// ─── Factory ───

export function createFridayImageGenerateService(
  options: FridayImageGenerateServiceOptions,
): FridayImageGenerateService {
  const {
    artifactDir,
    generate,
    defaultModel = DEFAULT_MODEL,
    defaultSize = DEFAULT_SIZE,
    defaultStyle = DEFAULT_STYLE,
    defaultQuality = DEFAULT_QUALITY,
  } = options;

  return {
    async generate(
      request: FridayImageGenerateRequest,
      signal: AbortSignal,
    ): Promise<FridayImageGenerateServiceResult> {
      validateImagePrompt(request.prompt);
      const size = validateImageSize(request.size);
      const style = validateImageStyle(request.style);
      const quality = validateImageQuality(request.quality);
      const model = request.model ?? defaultModel;

      const result = await generate(
        { prompt: request.prompt, negativePrompt: request.negativePrompt, size, style, quality, model },
        signal,
      );

      // Ensure artifact directory exists
      fs.mkdirSync(artifactDir, { recursive: true });

      // Determine extension from MIME
      const ext = result.mimeType === "image/png" ? "png" : "jpg";
      const timestamp = Date.now();
      const filename = `image-gen-${timestamp}.${ext}`;
      const filePath = path.join(artifactDir, filename);
      fs.writeFileSync(filePath, result.data);

      return {
        filePath,
        mimeType: result.mimeType,
        bytes: result.data.byteLength,
        model: result.model,
        revisedPrompt: result.revisedPrompt,
      };
    },
  };
}
