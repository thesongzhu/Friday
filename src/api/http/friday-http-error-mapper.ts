import type { FridayApiError, FridayApiErrorResponse } from "../model/friday-api-common.types.js";
import type { JsonValue } from "#workflows";
import { FRIDAY_ERROR_CODES, FridayDomainError, mapFridayErrorToHttpStatus } from "#errors";

// ─── Error to HTTP status code ───

const FRIDAY_GENERIC_5XX_MESSAGE = "Internal Server Error";
const FRIDAY_SQLITE_BUSY_RETRY_AFTER_MS = 1_000;
const FRIDAY_SQLITE_BUSY_CODES = new Set(["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT"]);

function isSqliteBusyLike(error: unknown, seen = new Set<object>()): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  if (seen.has(error)) {
    return false;
  }
  seen.add(error);

  const record = error as { code?: unknown; message?: unknown; cause?: unknown };
  if (typeof record.code === "string" && FRIDAY_SQLITE_BUSY_CODES.has(record.code)) {
    return true;
  }
  if (
    typeof record.message === "string"
    && record.message.toLowerCase().includes("database is locked")
  ) {
    return true;
  }
  return isSqliteBusyLike(record.cause, seen);
}

function normalizeHttpError(error: unknown): unknown {
  if (error instanceof FridayDomainError) {
    return error;
  }
  if (isSqliteBusyLike(error)) {
    return new FridayDomainError(
      FRIDAY_ERROR_CODES.DEGRADED_MODE,
      "Database is temporarily busy",
      {
        httpStatus: 503,
        retryable: true,
        details: {
          retryAfterMs: FRIDAY_SQLITE_BUSY_RETRY_AFTER_MS,
        },
        cause: error,
      },
    );
  }
  return error;
}

export function mapErrorToStatusCode(error: unknown): number {
  const normalized = normalizeHttpError(error);
  if (normalized instanceof FridayDomainError) {
    return normalized.httpStatus;
  }
  return 500;
}

// ─── Error to API error ───

export function mapErrorToApiError(error: unknown, statusCode: number): FridayApiError {
  const normalized = normalizeHttpError(error);
  if (statusCode >= 500) {
    if (normalized instanceof FridayDomainError && statusCode === 501) {
      const apiError: FridayApiError = {
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
      };
      if (normalized.details && Object.keys(normalized.details).length > 0) {
        apiError.details = normalized.details as Record<string, JsonValue>;
      }
      return apiError;
    }
    // Mask all 5xx messages to prevent information leakage
    return {
      code: normalized instanceof FridayDomainError ? normalized.code : FRIDAY_ERROR_CODES.INTERNAL_ERROR,
      message: FRIDAY_GENERIC_5XX_MESSAGE,
      retryable: normalized instanceof FridayDomainError ? normalized.retryable : false,
    };
  }
  if (normalized instanceof FridayDomainError) {
    const apiError: FridayApiError = {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
    };
    if (normalized.details && Object.keys(normalized.details).length > 0) {
      apiError.details = normalized.details as Record<string, JsonValue>;
    }
    return apiError;
  }
  if (normalized instanceof Error) {
    return {
      code: FRIDAY_ERROR_CODES.INTERNAL_ERROR,
      message: normalized.message,
      retryable: false,
    };
  }
  return {
    code: FRIDAY_ERROR_CODES.UNKNOWN_ERROR,
    message: "An unexpected error occurred",
    retryable: false,
  };
}

// ─── Build full error response ───

/**
 * Extract `retryAfterMs` from a domain error's details, if present and numeric.
 */
function extractRetryAfterMs(error: unknown): number | undefined {
  if (error instanceof FridayDomainError && error.details) {
    const raw = (error.details as Record<string, unknown>).retryAfterMs;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return raw;
    }
  }
  return undefined;
}

export function buildErrorResponse(error: unknown, requestId: string): {
  statusCode: number;
  body: FridayApiErrorResponse;
  headers?: Record<string, string>;
} {
  const normalized = normalizeHttpError(error);
  const statusCode = mapErrorToStatusCode(normalized);
  const apiError = mapErrorToApiError(normalized, statusCode);

  // Propagate retryAfterMs into the API error and Retry-After header
  const retryAfterMs = extractRetryAfterMs(normalized);
  if (retryAfterMs != null) {
    apiError.retryAfterMs = retryAfterMs;
  }

  const headers: Record<string, string> = {};
  if (retryAfterMs != null && retryAfterMs > 0) {
    headers["Retry-After"] = String(Math.ceil(retryAfterMs / 1000));
  }

  return {
    statusCode,
    body: {
      ok: false,
      error: apiError,
      requestId,
    },
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}
