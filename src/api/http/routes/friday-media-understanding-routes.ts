/**
 * Media Understanding HTTP routes — Phase 02a.
 *
 * Exposes the operator/agent-facing surface for the media-understanding
 * pipeline:
 *  - `POST /v1/media-understanding/doctor`   (operationId: media.understanding.doctor)
 *  - `POST /v1/media-understanding/analyze`  (operationId: media.understanding.analyze)
 *
 * Routes are **always registered**. When the bootstrap could not enable the
 * media-understanding service (missing flag, missing credential, etc.) the
 * deps fields are null and the handlers return `503 MEDIA_UNDERSTANDING_DISABLED`
 * with a structured `disabledReason` from the bootstrap. Handlers never echo
 * env values, credentials, or partial credentials.
 *
 * @module api/http/routes/friday-media-understanding-routes
 */

import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import { FridayDomainError } from "#errors";
import type {
  FridayMediaAttachment,
  FridayMediaType,
  FridayMediaUnderstandingDoctorReport,
  FridayMediaUnderstandingProvider,
  FridayMediaUnderstandingResult,
  FridayMediaUnderstandingService,
} from "#media-understanding";
import { probeMediaUnderstandingProvider } from "#media-understanding";

// ─── Deps ───

export interface FridayMediaUnderstandingRoutesDeps {
  /** Active media-understanding service when enabled; null when disabled. */
  readonly service: FridayMediaUnderstandingService | null;
  /** Active doctor provider when enabled; null when disabled. */
  readonly doctorProvider: FridayMediaUnderstandingProvider | null;
  /**
   * Structured short reason from bootstrap explaining why media-understanding
   * is disabled (e.g. "FRIDAY_MEDIA_UNDERSTANDING_ENABLED is not set to true"
   * or "media understanding credential resolution failed: SECRET_ENV_VAR_MISSING").
   * Must never include any env value, credential, or partial credential.
   */
  readonly disabledReason: string | null;
  /** Optional clock injection for tests / determinism. */
  readonly nowIso?: () => string;
  /**
   * Test-oracle only: allow the legacy TypeScript media-understanding product
   * logic (provider-orchestrating analyze pipeline + provider connectivity
   * doctor probe) to execute. Production/runtime callers must leave this unset
   * so both POST routes fail-close (503 TS_RUNTIME_MEDIA_UNDERSTANDING_RETIRED)
   * until Rust owns media understanding. fail_closed (not operator_external_
   * adapter): the route's purpose is media understanding product logic that
   * Rust will reimplement — calling providers does NOT make it an external
   * egress conduit (same as agent runs, which call LLM providers and are
   * fail_closed); when retired it 503s and nothing egresses.
   */
  readonly allowTestOnlyMediaUnderstandingExecution?: boolean;
}

// ─── Request / response shapes ───

export interface FridayMediaUnderstandingDoctorRequest {
  testImageBase64?: string;
  testImageMimeType?: string;
  timeoutMs?: number;
}

export interface FridayMediaUnderstandingDoctorResponse {
  report: FridayMediaUnderstandingDoctorReport;
}

export interface FridayMediaUnderstandingAnalyzeRequestAttachment {
  id?: string;
  filename?: string | null;
  mimeType: string;
  sizeBytes: number;
  sourceUrl: string;
  channelId?: string;
}

export interface FridayMediaUnderstandingAnalyzeRequest {
  attachments: FridayMediaUnderstandingAnalyzeRequestAttachment[];
}

export interface FridayMediaUnderstandingAnalyzeResponse {
  result: FridayMediaUnderstandingResult;
}

// ─── Defaults ───

const DEFAULT_DISABLED_MESSAGE =
  "Media understanding is disabled in this runtime; set FRIDAY_MEDIA_UNDERSTANDING_ENABLED=true and ensure OPENAI_API_KEY is set in the runtime shell.";

const DEFAULT_DOCTOR_TIMEOUT_MAX_MS = 60_000;

// ─── Factory ───

export function createFridayMediaUnderstandingRoutes(
  deps: FridayMediaUnderstandingRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  function disabledMessage(): string {
    return deps.disabledReason && deps.disabledReason.trim().length > 0
      ? deps.disabledReason
      : DEFAULT_DISABLED_MESSAGE;
  }

  function throwDisabled(): never {
    throw new FridayDomainError(
      "MEDIA_UNDERSTANDING_DISABLED",
      disabledMessage(),
      { httpStatus: 503 },
    );
  }

  // TS-runtime retirement: the media-understanding product logic (analyze
  // pipeline + doctor provider probe) fail-closes by default/live. Placed AFTER
  // the availability check and body parse, immediately before the provider call,
  // so disabled -> MEDIA_UNDERSTANDING_DISABLED and malformed -> 400 still win.
  function assertMediaTestOracleAllowed(): never | void {
    if (deps.allowTestOnlyMediaUnderstandingExecution === true) {
      return;
    }
    throw new FridayDomainError(
      "TS_RUNTIME_MEDIA_UNDERSTANDING_RETIRED",
      "Media understanding (attachment analysis + provider doctor) is fail-closed in the default/live runtime; the Rust-owned media-understanding entrypoint is required.",
      {
        httpStatus: 503,
        details: {
          classification: "fail_closed",
          replacement: "rust_owned_media_understanding_entrypoint_required",
        },
      },
    );
  }

  return [
    {
      operationId: "media.understanding.doctor",
      method: "POST",
      path: "/v1/media-understanding/doctor",
      auth: { public: true },
      async handler(ctx): Promise<FridayMediaUnderstandingDoctorResponse> {
        if (!deps.doctorProvider) {
          throwDisabled();
        }
        const body = parseDoctorBody(ctx.body);
        assertMediaTestOracleAllowed();
        const report = await probeMediaUnderstandingProvider(deps.doctorProvider, {
          testImageBase64: body.testImageBase64,
          testImageMimeType: body.testImageMimeType,
          timeoutMs: body.timeoutMs,
          nowIso: deps.nowIso,
        });
        return { report };
      },
    },
    {
      operationId: "media.understanding.analyze",
      method: "POST",
      path: "/v1/media-understanding/analyze",
      auth: { public: true },
      async handler(ctx): Promise<FridayMediaUnderstandingAnalyzeResponse> {
        if (!deps.service) {
          throwDisabled();
        }
        const body = parseAnalyzeBody(ctx.body);
        const attachments = body.attachments.map((raw, index) =>
          normalizeAttachment(raw, index),
        );
        assertMediaTestOracleAllowed();
        const result = await deps.service.processAttachments(attachments);
        return { result };
      },
    },
  ];
}

// ─── Body parsing ───

function parseDoctorBody(raw: unknown): FridayMediaUnderstandingDoctorRequest {
  if (raw === null || raw === undefined) {
    return {};
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "Request body must be a JSON object.",
      { httpStatus: 400 },
    );
  }
  const obj = raw as Record<string, unknown>;
  const out: FridayMediaUnderstandingDoctorRequest = {};
  if (obj.testImageBase64 !== undefined) {
    if (typeof obj.testImageBase64 !== "string") {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        "testImageBase64 must be a string when provided.",
        { httpStatus: 400 },
      );
    }
    out.testImageBase64 = obj.testImageBase64;
  }
  if (obj.testImageMimeType !== undefined) {
    if (typeof obj.testImageMimeType !== "string") {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        "testImageMimeType must be a string when provided.",
        { httpStatus: 400 },
      );
    }
    out.testImageMimeType = obj.testImageMimeType;
  }
  if (obj.timeoutMs !== undefined) {
    if (typeof obj.timeoutMs !== "number" || !Number.isFinite(obj.timeoutMs)) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        "timeoutMs must be a finite number when provided.",
        { httpStatus: 400 },
      );
    }
    if (obj.timeoutMs <= 0 || obj.timeoutMs > DEFAULT_DOCTOR_TIMEOUT_MAX_MS) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `timeoutMs must be in (0, ${DEFAULT_DOCTOR_TIMEOUT_MAX_MS}] when provided.`,
        { httpStatus: 400 },
      );
    }
    out.timeoutMs = obj.timeoutMs;
  }
  return out;
}

function parseAnalyzeBody(raw: unknown): FridayMediaUnderstandingAnalyzeRequest {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "Request body must be a JSON object with an attachments array.",
      { httpStatus: 400 },
    );
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.attachments)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "Request body must include an attachments array.",
      { httpStatus: 400 },
    );
  }
  if (obj.attachments.length === 0) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "attachments array must not be empty.",
      { httpStatus: 400 },
    );
  }
  const parsed: FridayMediaUnderstandingAnalyzeRequestAttachment[] = obj.attachments.map(
    (raw, idx) => parseAnalyzeAttachment(raw, idx),
  );
  return { attachments: parsed };
}

function parseAnalyzeAttachment(
  raw: unknown,
  index: number,
): FridayMediaUnderstandingAnalyzeRequestAttachment {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `attachments[${index}] must be a JSON object.`,
      { httpStatus: 400 },
    );
  }
  const obj = raw as Record<string, unknown>;
  const mimeType = obj.mimeType;
  if (typeof mimeType !== "string" || mimeType.trim().length === 0) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `attachments[${index}].mimeType is required and must be a non-empty string.`,
      { httpStatus: 400 },
    );
  }
  const sizeBytes = obj.sizeBytes;
  if (
    typeof sizeBytes !== "number" ||
    !Number.isFinite(sizeBytes) ||
    sizeBytes < 0
  ) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `attachments[${index}].sizeBytes is required and must be a non-negative number.`,
      { httpStatus: 400 },
    );
  }
  const sourceUrl = obj.sourceUrl;
  if (typeof sourceUrl !== "string" || sourceUrl.trim().length === 0) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `attachments[${index}].sourceUrl is required and must be a non-empty string.`,
      { httpStatus: 400 },
    );
  }
  // Phase 02a only accepts http:// and https:// sourceUrls. Inline schemes such
  // as data: are rejected so callers cannot bypass the SSRF guard or the
  // request-size policy by embedding base64 in the URL. A future slice may add
  // an explicit `contentBase64` field with its own size enforcement; until then
  // inline content is out of scope.
  const trimmedSourceUrl = sourceUrl.trim();
  if (!/^https?:\/\//i.test(trimmedSourceUrl)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `attachments[${index}].sourceUrl must use the http:// or https:// scheme; other schemes (including data:) are not accepted.`,
      { httpStatus: 400 },
    );
  }
  const out: FridayMediaUnderstandingAnalyzeRequestAttachment = {
    mimeType,
    sizeBytes,
    sourceUrl,
  };
  if (obj.id !== undefined) {
    if (typeof obj.id !== "string") {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `attachments[${index}].id must be a string when provided.`,
        { httpStatus: 400 },
      );
    }
    out.id = obj.id;
  }
  if (obj.filename !== undefined) {
    if (obj.filename !== null && typeof obj.filename !== "string") {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `attachments[${index}].filename must be a string or null when provided.`,
        { httpStatus: 400 },
      );
    }
    out.filename = obj.filename as string | null;
  }
  if (obj.channelId !== undefined) {
    if (typeof obj.channelId !== "string") {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `attachments[${index}].channelId must be a string when provided.`,
        { httpStatus: 400 },
      );
    }
    out.channelId = obj.channelId;
  }
  return out;
}

function normalizeAttachment(
  raw: FridayMediaUnderstandingAnalyzeRequestAttachment,
  index: number,
): FridayMediaAttachment {
  return {
    id: raw.id ?? `att-${index}`,
    filename: raw.filename ?? null,
    mimeType: raw.mimeType,
    mediaType: detectMediaType(raw.mimeType),
    sizeBytes: raw.sizeBytes,
    sourceUrl: raw.sourceUrl,
    ...(raw.channelId !== undefined ? { channelId: raw.channelId } : {}),
  };
}

// Local copy of the MIME-prefix detection used by the media-understanding
// service. Kept local on purpose so the route does not import the service's
// internal helper and can validate input shape before touching the service.
function detectMediaType(mimeType: string): FridayMediaType {
  const lower = mimeType.toLowerCase();
  if (lower.startsWith("image/")) return "image";
  if (lower.startsWith("audio/")) return "audio";
  if (lower.startsWith("video/")) return "video";
  return "document";
}
