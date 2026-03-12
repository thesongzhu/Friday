import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── Constants ───

const MAX_IMAGES = 10;
const MAX_DATA_URI_BYTES = 20 * 1024 * 1024; // 20 MB

const IMAGE_MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const VALID_DETAILS = new Set(["low", "high", "auto"]);

// ─── Types ───

export type ImageDetail = "low" | "high" | "auto";

export interface NormalizedImage {
  type: "base64" | "url";
  /** MIME type when type=base64 */
  mimeType?: string;
  /** base64 data when type=base64 */
  data?: string;
  /** URL when type=url */
  url?: string;
}

export interface ImageValidationResult {
  valid: boolean;
  images?: NormalizedImage[];
  error?: string;
}

// ─── Helpers ───

/**
 * Validate the detail parameter.
 */
export function validateDetail(detail: string | undefined): ImageDetail {
  if (!detail) return "auto";
  if (!VALID_DETAILS.has(detail)) {
    throw new Error(`Invalid detail "${detail}". Valid: low, high, auto.`);
  }
  return detail as ImageDetail;
}

/**
 * Check whether a resolved path is within an allowed directory.
 * Uses `path.relative` + `path.isAbsolute` instead of string prefix for safety.
 */
function isPathWithinDirectory(filePath: string, dir: string): boolean {
  const resolvedDir = path.resolve(dir);
  const resolvedFile = path.resolve(filePath);
  const rel = path.relative(resolvedDir, resolvedFile);
  // rel must be non-empty, must not start with "..", and must not be absolute
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export interface NormalizeImageOptions {
  /** Workspace root directory — local file paths must be within this dir or the system temp dir. */
  workspaceRoot?: string;
}

/**
 * Normalize a single image input string to a NormalizedImage.
 * Accepts:
 *   - data URI (data:image/png;base64,...)
 *   - HTTP/HTTPS URL
 *   - local file path (must be within workspace or temp directory)
 */
export function normalizeImageInput(input: string, options?: NormalizeImageOptions): NormalizedImage {
  const trimmed = input.trim();

  // Data URI
  if (trimmed.startsWith("data:")) {
    if (Buffer.byteLength(trimmed, "utf8") > MAX_DATA_URI_BYTES) {
      throw new Error(`Data URI exceeds maximum size of ${MAX_DATA_URI_BYTES} bytes.`);
    }
    const match = /^data:([^;]+);base64,(.+)$/.exec(trimmed);
    if (!match) {
      throw new Error("Invalid data URI format. Expected data:<mime>;base64,<data>");
    }
    return { type: "base64", mimeType: match[1], data: match[2] };
  }

  // HTTP/HTTPS URL
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return { type: "url", url: trimmed };
  }

  // Local file path — apply workspace boundary check
  const resolved = path.resolve(trimmed);

  // Security: restrict local file reads to workspace directory or system temp directory
  const workspaceRoot = options?.workspaceRoot ?? process.cwd();
  const tempDir = os.tmpdir();
  const withinWorkspace = isPathWithinDirectory(resolved, workspaceRoot);
  const withinTemp = isPathWithinDirectory(resolved, tempDir);

  if (!withinWorkspace && !withinTemp) {
    throw new Error(
      `Image path "${trimmed}" is outside the allowed directories (workspace or temp). ` +
      `Resolved: ${resolved}`,
    );
  }

  if (!fs.existsSync(resolved)) {
    throw new Error(`Image file not found: ${resolved}`);
  }

  const ext = path.extname(resolved).toLowerCase();
  const mime = IMAGE_MIME_MAP[ext];
  if (!mime) {
    throw new Error(
      `Unsupported image format "${ext}". Supported: ${Object.keys(IMAGE_MIME_MAP).join(", ")}`,
    );
  }

  const data = fs.readFileSync(resolved);
  return { type: "base64", mimeType: mime, data: data.toString("base64") };
}

/**
 * Validate and normalize an array of image inputs.
 */
export function validateAndNormalizeImages(
  images: string[],
  options?: NormalizeImageOptions,
): ImageValidationResult {
  if (!images || images.length === 0) {
    return { valid: false, error: "At least one image is required." };
  }

  if (images.length > MAX_IMAGES) {
    return { valid: false, error: `Too many images (${images.length}). Maximum: ${MAX_IMAGES}.` };
  }

  const normalized: NormalizedImage[] = [];
  for (const img of images) {
    try {
      normalized.push(normalizeImageInput(img, options));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { valid: false, error: message };
    }
  }

  return { valid: true, images: normalized };
}
