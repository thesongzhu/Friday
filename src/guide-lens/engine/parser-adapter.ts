import { FridayDomainError } from "#errors";
import type {
  FridayGuideLensBounds,
  FridayGuideLensElement,
  FridayGuideLensParserAdapter,
  FridayGuideLensParserRequest,
  FridayGuideLensParserResult,
  FridayGuideLensPreferences,
} from "../model/friday-guide-lens.types.js";

export interface CreateFridayGuideLensHttpParserAdapterOptions {
  endpointUrl: string;
  provider: Exclude<FridayGuideLensPreferences["parserProvider"], "local_none">;
  timeoutMs?: number;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function assertLoopbackEndpoint(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new FridayDomainError("GUIDE_LENS_PARSER_INVALID_ENDPOINT", "Guide Lens parser endpoint must be a valid URL", {
      httpStatus: 400,
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new FridayDomainError("GUIDE_LENS_PARSER_INVALID_ENDPOINT", "Guide Lens parser endpoint must use http or https", {
      httpStatus: 400,
    });
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new FridayDomainError(
      "GUIDE_LENS_PARSER_INVALID_ENDPOINT",
      "Guide Lens parser endpoint must be loopback-only",
      { httpStatus: 400, details: { hostname } },
    );
  }
  return parsed;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function clampConfidence(value: unknown, fallback = 0.7): number {
  const numeric = readNumber(value);
  if (numeric === undefined) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function boundsFromExternal(value: unknown): FridayGuideLensBounds | undefined {
  const obj = readObject(value);
  if (obj) {
    const x = readNumber(obj.x ?? obj.left);
    const y = readNumber(obj.y ?? obj.top);
    const width = readNumber(obj.width ?? obj.w);
    const height = readNumber(obj.height ?? obj.h);
    if (x !== undefined && y !== undefined && width !== undefined && height !== undefined && width > 0 && height > 0) {
      return { x, y, width, height };
    }
  }
  if (Array.isArray(value) && value.length >= 4) {
    const x1 = readNumber(value[0]);
    const y1 = readNumber(value[1]);
    const x2 = readNumber(value[2]);
    const y2 = readNumber(value[3]);
    if (x1 !== undefined && y1 !== undefined && x2 !== undefined && y2 !== undefined) {
      const width = x2 > x1 ? x2 - x1 : x2;
      const height = y2 > y1 ? y2 - y1 : y2;
      if (width > 0 && height > 0) {
        return { x: x1, y: y1, width, height };
      }
    }
  }
  return undefined;
}

function normalizeExternalElement(value: unknown, index: number): FridayGuideLensElement | undefined {
  const obj = readObject(value);
  if (!obj) return undefined;
  const label = readString(obj.label ?? obj.name ?? obj.text ?? obj.content);
  const text = readString(obj.text ?? obj.content ?? obj.label ?? obj.name);
  const bounds = boundsFromExternal(obj.bounds ?? obj.rect ?? obj.bbox ?? obj.box);
  return {
    id: readString(obj.id) ?? `parser:${String(index + 1)}`,
    role: readString(obj.role ?? obj.type ?? obj.tag) ?? "unknown",
    ...(label ? { label } : {}),
    ...(text ? { text } : {}),
    ...(readString(obj.description) ? { description: readString(obj.description) } : {}),
    ...(bounds ? { bounds } : {}),
    source: "parser",
    confidence: clampConfidence(obj.confidence ?? obj.score),
    interactable: Boolean(obj.interactable ?? obj.clickable ?? obj.enabled ?? false),
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : undefined,
    sensitive: Boolean(obj.sensitive ?? false),
    metadata: {
      parserIndex: index,
      parserRole: obj.role ?? obj.type ?? obj.tag,
    },
  };
}

function readExternalElements(body: Record<string, unknown>): FridayGuideLensElement[] {
  const raw = body.elements ?? body.ui_elements ?? body.items ?? body.nodes;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, index) => normalizeExternalElement(item, index))
    .filter((element): element is FridayGuideLensElement => Boolean(element))
    .slice(0, 120);
}

function readParserBody(body: unknown, provider: FridayGuideLensParserRequest["provider"], latencyMs: number): FridayGuideLensParserResult {
  const obj = readObject(body);
  if (!obj) {
    throw new FridayDomainError("GUIDE_LENS_PARSER_INVALID_RESPONSE", "Guide Lens parser returned a non-object response", {
      httpStatus: 502,
    });
  }
  return {
    provider: readString(obj.provider) as FridayGuideLensPreferences["parserProvider"] | undefined ?? provider,
    used: obj.used === undefined ? true : Boolean(obj.used),
    visibleText: readString(obj.visibleText ?? obj.visible_text ?? obj.text),
    screenshotText: readString(obj.screenshotText ?? obj.screenshot_text ?? obj.ocrText ?? obj.ocr_text),
    elements: readExternalElements(obj),
    latencyMs: readNumber(obj.latencyMs ?? obj.latency_ms) ?? latencyMs,
    fallbackReason: readString(obj.fallbackReason ?? obj.fallback_reason),
    metadata: readObject(obj.metadata),
  };
}

export function createFridayGuideLensHttpParserAdapter(
  options: CreateFridayGuideLensHttpParserAdapterOptions,
): FridayGuideLensParserAdapter {
  const endpoint = assertLoopbackEndpoint(options.endpointUrl);
  const timeoutMs = Math.max(500, Math.min(30_000, options.timeoutMs ?? 3_000));

  return {
    async parse(req: FridayGuideLensParserRequest): Promise<FridayGuideLensParserResult> {
      const controller = new AbortController();
      const startedAt = Date.now();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider: req.provider,
            snapshot: req.snapshot,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new FridayDomainError(
            "GUIDE_LENS_PARSER_FAILED",
            `Guide Lens parser failed with HTTP ${String(response.status)}`,
            { httpStatus: 502, details: { status: response.status } },
          );
        }
        return readParserBody(await response.json(), options.provider, Date.now() - startedAt);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
