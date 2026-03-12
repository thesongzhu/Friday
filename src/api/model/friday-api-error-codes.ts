/**
 * API error code catalog — backward-compatible re-exports from canonical catalog.
 *
 * The canonical catalog lives at `#errors` (src/errors/friday-error-codes.ts).
 * This file re-exports the subset used by the API layer for backward compat.
 */

import { buildFridayErrorShape, FRIDAY_ERROR_CODES } from "../../errors/friday-error-codes.js";
import type { FridayErrorShape } from "../../errors/friday-error-codes.js";

// ─── Backward-compatible Error Code Enum ───

export const FRIDAY_API_ERROR_CODES = {
  UNAUTHORIZED: FRIDAY_ERROR_CODES.UNAUTHORIZED,
  FORBIDDEN: FRIDAY_ERROR_CODES.FORBIDDEN,
  NOT_FOUND: FRIDAY_ERROR_CODES.NOT_FOUND,
  RATE_LIMITED: FRIDAY_ERROR_CODES.RATE_LIMITED,
  INVALID_JSON: FRIDAY_ERROR_CODES.INVALID_JSON,
  INVALID_PATH: FRIDAY_ERROR_CODES.INVALID_PATH,
  PAYLOAD_TOO_LARGE: FRIDAY_ERROR_CODES.PAYLOAD_TOO_LARGE,
  INTERNAL_ERROR: FRIDAY_ERROR_CODES.INTERNAL_ERROR,
  UNKNOWN_ERROR: FRIDAY_ERROR_CODES.UNKNOWN_ERROR,
} as const;

export type FridayApiErrorCode = (typeof FRIDAY_API_ERROR_CODES)[keyof typeof FRIDAY_API_ERROR_CODES];

// ─── Backward-compatible Error Shape ───

export interface FridayApiErrorShape {
  code: FridayApiErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

/**
 * Build a standard API error shape from a code and message.
 *
 * @param code - One of the FRIDAY_API_ERROR_CODES values.
 * @param message - Human-readable error description.
 * @param options - Optional retryable flag and retryAfterMs hint.
 */
export function buildFridayApiError(
  code: FridayApiErrorCode,
  message: string,
  options?: { retryable?: boolean; retryAfterMs?: number },
): FridayApiErrorShape {
  const shape = buildFridayErrorShape(code, message, {
    retryable: options?.retryable,
    retryAfterMs: options?.retryAfterMs,
  });
  const result: FridayApiErrorShape = {
    code: shape.code as FridayApiErrorCode,
    message: shape.message,
    retryable: shape.retryable,
  };
  if (shape.retryAfterMs != null) {
    result.retryAfterMs = shape.retryAfterMs;
  }
  return result;
}
