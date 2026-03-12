import type { FridayApiError, FridayApiErrorResponse } from "../model/friday-api-common.types.js";
import type { JsonValue } from "#workflows";
import { FRIDAY_ERROR_CODES, FridayDomainError, mapFridayErrorToHttpStatus } from "#errors";

// ─── Error to HTTP status code ───

export function mapErrorToStatusCode(error: unknown): number {
  if (error instanceof FridayDomainError) {
    return error.httpStatus;
  }
  return 500;
}

// ─── Constants ───

const FRIDAY_GENERIC_5XX_MESSAGE = "Internal Server Error";

// ─── Error to API error ───

export function mapErrorToApiError(error: unknown, statusCode: number): FridayApiError {
  if (statusCode >= 500) {
    // Mask all 5xx messages to prevent information leakage
    return {
      code: error instanceof FridayDomainError ? error.code : FRIDAY_ERROR_CODES.INTERNAL_ERROR,
      message: FRIDAY_GENERIC_5XX_MESSAGE,
      retryable: false,
    };
  }
  if (error instanceof FridayDomainError) {
    const apiError: FridayApiError = {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
    if (error.details && Object.keys(error.details).length > 0) {
      apiError.details = error.details as Record<string, JsonValue>;
    }
    return apiError;
  }
  if (error instanceof Error) {
    return {
      code: FRIDAY_ERROR_CODES.INTERNAL_ERROR,
      message: error.message,
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
  const statusCode = mapErrorToStatusCode(error);
  const apiError = mapErrorToApiError(error, statusCode);

  // Propagate retryAfterMs into the API error and Retry-After header
  const retryAfterMs = extractRetryAfterMs(error);
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
