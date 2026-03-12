import * as fs from "node:fs";
import * as path from "node:path";

import type {
  FridayAgentToolResult,
  FridayAgentToolResultContentBlock,
} from "../model/friday-agent.types.js";

// ─── Tool input error ───

export class FridayAgentToolInputError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "FridayAgentToolInputError";
  }
}

// ─── Parameter readers ───

export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: { required: true; label?: string },
): string;
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options?: { required?: boolean; label?: string },
): string | undefined;
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; label?: string } = {},
): string | undefined {
  const { required = false, label = key } = options;
  const raw = params[key];
  if (typeof raw !== "string") {
    if (required) {
      throw new FridayAgentToolInputError(`${label} is required`);
    }
    return undefined;
  }
  const value = raw.trim();
  if (!value) {
    if (required) {
      throw new FridayAgentToolInputError(`${label} is required`);
    }
    return undefined;
  }
  return value;
}

export function readNumberParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; label?: string; integer?: boolean } = {},
): number | undefined {
  const { required = false, label = key, integer = false } = options;
  const raw = params[key];
  let value: number | undefined;

  if (typeof raw === "number" && Number.isFinite(raw)) {
    value = raw;
  } else if (typeof raw === "string") {
    const parsed = Number.parseFloat(raw.trim());
    if (Number.isFinite(parsed)) {
      value = parsed;
    }
  }

  if (value === undefined) {
    if (required) {
      throw new FridayAgentToolInputError(`${label} is required`);
    }
    return undefined;
  }

  return integer ? Math.trunc(value) : value;
}

export function readBooleanParam(
  params: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const raw = params[key];
  if (typeof raw === "boolean") {
    return raw;
  }
  return undefined;
}

export function readRecordParam(
  params: Record<string, unknown>,
  key: string,
): Record<string, string> | undefined {
  const raw = params[key];
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(record)) {
      result[k] = String(v);
    }
    return result;
  }
  return undefined;
}

// ─── Extended parameter readers ───

/**
 * Read a parameter that can be either a string or a number.
 * Returns the value coerced to the detected type.
 */
export function readStringOrNumberParam(
  params: Record<string, unknown>,
  key: string,
  options: { required: true; label?: string },
): string | number;
export function readStringOrNumberParam(
  params: Record<string, unknown>,
  key: string,
  options?: { required?: boolean; label?: string },
): string | number | undefined;
export function readStringOrNumberParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; label?: string } = {},
): string | number | undefined {
  const { required = false, label = key } = options;
  const raw = params[key];

  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      if (required) {
        throw new FridayAgentToolInputError(`${label} is required`);
      }
      return undefined;
    }
    // Try numeric coercion
    const asNum = Number(trimmed);
    if (Number.isFinite(asNum)) {
      return asNum;
    }
    return trimmed;
  }

  if (required) {
    throw new FridayAgentToolInputError(`${label} is required`);
  }
  return undefined;
}

/**
 * Read an array of strings parameter. Accepts both a string[] and a single
 * string (which is wrapped in an array).
 */
export function readStringArrayParam(
  params: Record<string, unknown>,
  key: string,
  options: { required: true; label?: string },
): string[];
export function readStringArrayParam(
  params: Record<string, unknown>,
  key: string,
  options?: { required?: boolean; label?: string },
): string[] | undefined;
export function readStringArrayParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; label?: string } = {},
): string[] | undefined {
  const { required = false, label = key } = options;
  const raw = params[key];

  if (Array.isArray(raw)) {
    const result = raw.filter((item): item is string => typeof item === "string");
    if (result.length === 0 && required) {
      throw new FridayAgentToolInputError(`${label} is required`);
    }
    return result.length > 0 ? result : required ? undefined : undefined;
  }

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      if (required) {
        throw new FridayAgentToolInputError(`${label} is required`);
      }
      return undefined;
    }
    return [trimmed];
  }

  if (required) {
    throw new FridayAgentToolInputError(`${label} is required`);
  }
  return undefined;
}

// ─── Result formatters ───

export function jsonResult(payload: unknown): FridayAgentToolResult {
  return {
    content: JSON.stringify(payload, null, 2),
  };
}

export function textResult(text: string): FridayAgentToolResult {
  return { content: text };
}

export function errorResult(
  message: string,
  meta?: {
    errorCode?: string;
    routeId?: string;
    correlationId?: string;
  },
): FridayAgentToolResult {
  return {
    content: message,
    isError: true,
    ...(meta?.errorCode ? { errorCode: meta.errorCode } : {}),
    ...(meta?.routeId ? { routeId: meta.routeId } : {}),
    ...(meta?.correlationId ? { correlationId: meta.correlationId } : {}),
  };
}

// ─── Structured result builders ───

/**
 * Build a tool result containing an image from a Buffer.
 * The `content` field is a text description fallback.
 */
export function imageResult(
  data: Buffer,
  mimeType: string,
  description?: string,
): FridayAgentToolResult {
  const base64 = data.toString("base64");
  const desc = description ?? `[image: ${mimeType}, ${data.byteLength} bytes]`;
  return {
    content: desc,
    blocks: [
      { type: "image", mimeType, data: base64 },
    ],
  };
}

/**
 * Build a tool result containing an image read from a file path.
 * The `content` field is a text description fallback.
 */
export function imageResultFromFile(
  filePath: string,
  mimeType?: string,
  description?: string,
): FridayAgentToolResult {
  const resolvedMime = mimeType ?? guessMimeType(filePath);
  const data = fs.readFileSync(filePath);
  const base64 = data.toString("base64");
  const desc = description ?? `[image: ${resolvedMime}, ${path.basename(filePath)}]`;
  return {
    content: desc,
    blocks: [
      { type: "image", mimeType: resolvedMime, data: base64 },
    ],
  };
}

/**
 * Build a tool result referencing a file on disk.
 * Optionally includes inline base64 data.
 */
export function fileResult(
  filePath: string,
  mimeType?: string,
  opts?: { inline?: boolean; description?: string },
): FridayAgentToolResult {
  const resolvedMime = mimeType ?? guessMimeType(filePath);
  const desc = opts?.description ?? `[file: ${path.basename(filePath)}, ${resolvedMime}]`;

  const block: FridayAgentToolResultContentBlock = {
    type: "file",
    mimeType: resolvedMime,
    path: filePath,
  };

  if (opts?.inline) {
    const data = fs.readFileSync(filePath);
    (block as { data?: string }).data = data.toString("base64");
  }

  return {
    content: desc,
    blocks: [block],
  };
}

/**
 * Build a mixed tool result with multiple content blocks.
 */
export function mixedResult(
  blocks: FridayAgentToolResultContentBlock[],
  opts?: { isError?: boolean },
): FridayAgentToolResult {
  // Extract text content as fallback
  const textParts = blocks
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text);
  const fallback = textParts.length > 0
    ? textParts.join("\n")
    : blocks.map((b) => {
        if (b.type === "image") return `[image: ${b.mimeType}]`;
        if (b.type === "file") return `[file: ${b.path}]`;
        return "";
      }).filter(Boolean).join("\n");

  return {
    content: fallback,
    isError: opts?.isError,
    blocks,
  };
}

/** Guess MIME type from file extension. */
function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    case ".pdf": return "application/pdf";
    case ".json": return "application/json";
    case ".html": case ".htm": return "text/html";
    case ".txt": return "text/plain";
    case ".csv": return "text/csv";
    case ".xml": return "application/xml";
    case ".zip": return "application/zip";
    default: return "application/octet-stream";
  }
}

// ─── Truncation ───

export function truncateOutput(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  // Binary search for the right cut point
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return text.slice(0, low) + "\n... [truncated]";
}
