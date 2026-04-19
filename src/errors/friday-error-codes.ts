/**
 * Canonical Friday error-code catalog.
 *
 * Single source of truth for all error codes, their protocol mappings,
 * retryability, and structured shape. Domain modules may define their own
 * codes (e.g. FRIDAY_PLUGIN_ERROR_CODES), but this catalog covers shared
 * transport-level errors and the canonical shape builder.
 *
 * Protocol mapping helpers translate error codes into HTTP status codes,
 * WebSocket close codes, and gRPC status codes for multi-transport parity.
 */

import Ajv from "ajv";

// ─── Error Code Enum ───

export const FRIDAY_ERROR_CODES = {
  // Auth
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_AUTHENTICATED: "NOT_AUTHENTICATED",
  AUTH_FAILED: "AUTH_FAILED",

  // Resource
  NOT_FOUND: "NOT_FOUND",

  // Validation
  INVALID_JSON: "INVALID_JSON",
  INVALID_PATH: "INVALID_PATH",
  VALIDATION_ERROR: "VALIDATION_ERROR",

  // Rate-limiting
  RATE_LIMITED: "RATE_LIMITED",

  // Payload
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",

  // State
  STATE_CONFLICT: "STATE_CONFLICT",

  // Server
  INTERNAL_ERROR: "INTERNAL_ERROR",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",

  // Realtime
  STREAM_NOT_AUTHORIZED: "STREAM_NOT_AUTHORIZED",

  // Operational mode
  TOOL_UNAVAILABLE: "TOOL_UNAVAILABLE",
  DEGRADED_MODE: "DEGRADED_MODE",
} as const;

export type FridayErrorCode = (typeof FRIDAY_ERROR_CODES)[keyof typeof FRIDAY_ERROR_CODES];

// ─── Error Shape ───

export interface FridayErrorShape {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
  /** Protocol-specific metadata (HTTP status, WS close code, gRPC status). */
  protocol?: {
    httpStatus?: number;
    wsCloseCode?: number;
    grpcStatus?: number;
  };
}

// ─── Default retryability ───

const RETRYABLE_CODES = new Set<string>([
  FRIDAY_ERROR_CODES.RATE_LIMITED,
  FRIDAY_ERROR_CODES.DEGRADED_MODE,
]);

// ─── Shape Builder ───

/**
 * Build a structured error shape from a code, message, and optional metadata.
 *
 * Automatically infers `retryable` from the error code unless explicitly overridden.
 * Protocol metadata is computed lazily from the code but can be overridden.
 */
export function buildFridayErrorShape(
  code: string,
  message: string,
  options?: {
    retryable?: boolean;
    retryAfterMs?: number;
    details?: Record<string, unknown>;
    includeProtocol?: boolean;
  },
): FridayErrorShape {
  const retryable = options?.retryable ?? RETRYABLE_CODES.has(code);

  const shape: FridayErrorShape = {
    code,
    message,
    retryable,
  };

  if (options?.retryAfterMs != null) {
    shape.retryAfterMs = options.retryAfterMs;
  }

  if (options?.details != null && Object.keys(options.details).length > 0) {
    shape.details = options.details;
  }

  if (options?.includeProtocol) {
    shape.protocol = {
      httpStatus: mapFridayErrorToHttpStatus(code),
      wsCloseCode: mapFridayErrorToWsCloseCode(code),
      grpcStatus: mapFridayErrorToGrpcStatus(code),
    };
  }

  return shape;
}

// ─── Protocol Mapping: HTTP ───

const HTTP_STATUS_MAP: Record<string, number> = {
  [FRIDAY_ERROR_CODES.UNAUTHORIZED]: 401,
  [FRIDAY_ERROR_CODES.NOT_AUTHENTICATED]: 401,
  [FRIDAY_ERROR_CODES.AUTH_FAILED]: 401,
  [FRIDAY_ERROR_CODES.FORBIDDEN]: 403,
  [FRIDAY_ERROR_CODES.STREAM_NOT_AUTHORIZED]: 403,
  [FRIDAY_ERROR_CODES.NOT_FOUND]: 404,
  [FRIDAY_ERROR_CODES.STATE_CONFLICT]: 409,
  [FRIDAY_ERROR_CODES.VALIDATION_ERROR]: 422,
  [FRIDAY_ERROR_CODES.INVALID_JSON]: 400,
  [FRIDAY_ERROR_CODES.INVALID_PATH]: 400,
  [FRIDAY_ERROR_CODES.RATE_LIMITED]: 429,
  [FRIDAY_ERROR_CODES.PAYLOAD_TOO_LARGE]: 413,
  [FRIDAY_ERROR_CODES.INTERNAL_ERROR]: 500,
  [FRIDAY_ERROR_CODES.UNKNOWN_ERROR]: 500,
  [FRIDAY_ERROR_CODES.TOOL_UNAVAILABLE]: 503,
  [FRIDAY_ERROR_CODES.DEGRADED_MODE]: 503,
};

/**
 * Map an error code to an HTTP status code.
 * Falls back to 500 for unknown codes.
 */
export function mapFridayErrorToHttpStatus(code: string): number {
  return HTTP_STATUS_MAP[code] ?? 500;
}

// ─── Protocol Mapping: WebSocket Close ───

/**
 * WebSocket close code semantics:
 *   4000-4099 — auth / access errors
 *   4100-4199 — client protocol errors
 *   4200-4299 — server errors
 */
const WS_CLOSE_CODE_MAP: Record<string, number> = {
  [FRIDAY_ERROR_CODES.UNAUTHORIZED]: 4001,
  [FRIDAY_ERROR_CODES.NOT_AUTHENTICATED]: 4001,
  [FRIDAY_ERROR_CODES.AUTH_FAILED]: 4002,
  [FRIDAY_ERROR_CODES.FORBIDDEN]: 4003,
  [FRIDAY_ERROR_CODES.STREAM_NOT_AUTHORIZED]: 4003,
  [FRIDAY_ERROR_CODES.NOT_FOUND]: 4004,
  [FRIDAY_ERROR_CODES.STATE_CONFLICT]: 4009,
  [FRIDAY_ERROR_CODES.VALIDATION_ERROR]: 4022,
  [FRIDAY_ERROR_CODES.INVALID_JSON]: 4100,
  [FRIDAY_ERROR_CODES.INVALID_PATH]: 4101,
  [FRIDAY_ERROR_CODES.RATE_LIMITED]: 4029,
  [FRIDAY_ERROR_CODES.PAYLOAD_TOO_LARGE]: 4013,
  [FRIDAY_ERROR_CODES.INTERNAL_ERROR]: 4200,
  [FRIDAY_ERROR_CODES.UNKNOWN_ERROR]: 4200,
  [FRIDAY_ERROR_CODES.TOOL_UNAVAILABLE]: 4203,
  [FRIDAY_ERROR_CODES.DEGRADED_MODE]: 4204,
};

/**
 * Map an error code to a WebSocket close code (4000-4999 range).
 * Falls back to 4200 (internal error) for unknown codes.
 */
export function mapFridayErrorToWsCloseCode(code: string): number {
  return WS_CLOSE_CODE_MAP[code] ?? 4200;
}

// ─── Protocol Mapping: gRPC ───

/**
 * gRPC status codes (subset relevant to Friday):
 *   0  OK
 *   2  UNKNOWN
 *   3  INVALID_ARGUMENT
 *   5  NOT_FOUND
 *   7  PERMISSION_DENIED
 *   8  RESOURCE_EXHAUSTED
 *   9  FAILED_PRECONDITION
 *  13  INTERNAL
 *  16  UNAUTHENTICATED
 */
const GRPC_STATUS_MAP: Record<string, number> = {
  [FRIDAY_ERROR_CODES.UNAUTHORIZED]: 16,
  [FRIDAY_ERROR_CODES.NOT_AUTHENTICATED]: 16,
  [FRIDAY_ERROR_CODES.AUTH_FAILED]: 16,
  [FRIDAY_ERROR_CODES.FORBIDDEN]: 7,
  [FRIDAY_ERROR_CODES.STREAM_NOT_AUTHORIZED]: 7,
  [FRIDAY_ERROR_CODES.NOT_FOUND]: 5,
  [FRIDAY_ERROR_CODES.STATE_CONFLICT]: 9,
  [FRIDAY_ERROR_CODES.VALIDATION_ERROR]: 3,
  [FRIDAY_ERROR_CODES.INVALID_JSON]: 3,
  [FRIDAY_ERROR_CODES.INVALID_PATH]: 3,
  [FRIDAY_ERROR_CODES.RATE_LIMITED]: 8,
  [FRIDAY_ERROR_CODES.PAYLOAD_TOO_LARGE]: 8,
  [FRIDAY_ERROR_CODES.INTERNAL_ERROR]: 13,
  [FRIDAY_ERROR_CODES.UNKNOWN_ERROR]: 2,
  [FRIDAY_ERROR_CODES.TOOL_UNAVAILABLE]: 14,
  [FRIDAY_ERROR_CODES.DEGRADED_MODE]: 14,
};

/**
 * Map an error code to a gRPC status code.
 * Falls back to 2 (UNKNOWN) for unknown codes.
 */
export function mapFridayErrorToGrpcStatus(code: string): number {
  return GRPC_STATUS_MAP[code] ?? 2;
}

// ─── JSON Schema for FridayErrorShape ───

export const FridayErrorShapeSchema = {
  type: "object" as const,
  required: ["code", "message", "retryable"],
  properties: {
    code: { type: "string" as const, minLength: 1 },
    message: { type: "string" as const },
    retryable: { type: "boolean" as const },
    retryAfterMs: { type: "number" as const, minimum: 0 },
    details: { type: "object" as const },
    protocol: {
      type: "object" as const,
      properties: {
        httpStatus: { type: "number" as const },
        wsCloseCode: { type: "number" as const },
        grpcStatus: { type: "number" as const },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

// ─── AJV Validator ───

// SAFETY: ESM/CJS interop — Ajv may export as { default: Ajv } or as Ajv directly
const AjvConstructor = (Ajv as unknown as { default: typeof Ajv.default }).default ?? Ajv;
const ajv = new AjvConstructor({ allErrors: true });
const compiledValidator = ajv.compile<FridayErrorShape>(FridayErrorShapeSchema);

/**
 * Validate a value against the FridayErrorShape JSON schema.
 *
 * @returns `true` if valid, or an array of error strings if invalid.
 */
export function validateFridayErrorShape(value: unknown): true | string[] {
  const valid = compiledValidator(value);
  if (valid) return true;
  return (compiledValidator.errors ?? []).map(
    (e: { instancePath?: string; message?: string }) => `${e.instancePath || "/"}: ${e.message ?? "unknown error"}`,
  );
}
