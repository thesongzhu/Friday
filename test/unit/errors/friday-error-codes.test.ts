import { describe, it, expect } from "vitest";
import {
  FRIDAY_ERROR_CODES,
  buildFridayErrorShape,
  mapFridayErrorToHttpStatus,
  mapFridayErrorToWsCloseCode,
  mapFridayErrorToGrpcStatus,
  validateFridayErrorShape,
} from "#errors";

describe("FRIDAY_ERROR_CODES", () => {
  it("exposes all expected error codes", () => {
    expect(FRIDAY_ERROR_CODES.UNAUTHORIZED).toBe("UNAUTHORIZED");
    expect(FRIDAY_ERROR_CODES.FORBIDDEN).toBe("FORBIDDEN");
    expect(FRIDAY_ERROR_CODES.NOT_FOUND).toBe("NOT_FOUND");
    expect(FRIDAY_ERROR_CODES.RATE_LIMITED).toBe("RATE_LIMITED");
    expect(FRIDAY_ERROR_CODES.INVALID_JSON).toBe("INVALID_JSON");
    expect(FRIDAY_ERROR_CODES.INVALID_PATH).toBe("INVALID_PATH");
    expect(FRIDAY_ERROR_CODES.PAYLOAD_TOO_LARGE).toBe("PAYLOAD_TOO_LARGE");
    expect(FRIDAY_ERROR_CODES.INTERNAL_ERROR).toBe("INTERNAL_ERROR");
    expect(FRIDAY_ERROR_CODES.UNKNOWN_ERROR).toBe("UNKNOWN_ERROR");
    expect(FRIDAY_ERROR_CODES.NOT_AUTHENTICATED).toBe("NOT_AUTHENTICATED");
    expect(FRIDAY_ERROR_CODES.AUTH_FAILED).toBe("AUTH_FAILED");
    expect(FRIDAY_ERROR_CODES.STATE_CONFLICT).toBe("STATE_CONFLICT");
    expect(FRIDAY_ERROR_CODES.STREAM_NOT_AUTHORIZED).toBe("STREAM_NOT_AUTHORIZED");
    expect(FRIDAY_ERROR_CODES.VALIDATION_ERROR).toBe("VALIDATION_ERROR");
    expect(FRIDAY_ERROR_CODES.TOOL_UNAVAILABLE).toBe("TOOL_UNAVAILABLE");
    expect(FRIDAY_ERROR_CODES.DEGRADED_MODE).toBe("DEGRADED_MODE");
  });
});

describe("buildFridayErrorShape", () => {
  it("builds shape with default retryable=false", () => {
    const shape = buildFridayErrorShape("NOT_FOUND", "Resource not found");
    expect(shape).toEqual({
      code: "NOT_FOUND",
      message: "Resource not found",
      retryable: false,
    });
  });

  it("auto-sets retryable=true for RATE_LIMITED", () => {
    const shape = buildFridayErrorShape("RATE_LIMITED", "Too many requests");
    expect(shape.retryable).toBe(true);
  });

  it("allows retryable override", () => {
    const shape = buildFridayErrorShape("RATE_LIMITED", "Too many", { retryable: false });
    expect(shape.retryable).toBe(false);
  });

  it("includes retryAfterMs when provided", () => {
    const shape = buildFridayErrorShape("RATE_LIMITED", "Too many", { retryAfterMs: 5000 });
    expect(shape.retryAfterMs).toBe(5000);
  });

  it("omits retryAfterMs when not provided", () => {
    const shape = buildFridayErrorShape("NOT_FOUND", "Not found");
    expect(shape).not.toHaveProperty("retryAfterMs");
  });

  it("includes details when provided", () => {
    const shape = buildFridayErrorShape("VALIDATION_ERROR", "Invalid", {
      details: { field: "name" },
    });
    expect(shape.details).toEqual({ field: "name" });
  });

  it("omits details when empty object", () => {
    const shape = buildFridayErrorShape("NOT_FOUND", "Not found", { details: {} });
    expect(shape).not.toHaveProperty("details");
  });

  it("includes protocol metadata when requested", () => {
    const shape = buildFridayErrorShape("UNAUTHORIZED", "Not authorized", {
      includeProtocol: true,
    });
    expect(shape.protocol).toEqual({
      httpStatus: 401,
      wsCloseCode: 4001,
      grpcStatus: 16,
    });
  });

  it("omits protocol metadata by default", () => {
    const shape = buildFridayErrorShape("UNAUTHORIZED", "Not authorized");
    expect(shape).not.toHaveProperty("protocol");
  });
});

describe("mapFridayErrorToHttpStatus", () => {
  it("maps auth errors to 401", () => {
    expect(mapFridayErrorToHttpStatus("UNAUTHORIZED")).toBe(401);
    expect(mapFridayErrorToHttpStatus("NOT_AUTHENTICATED")).toBe(401);
    expect(mapFridayErrorToHttpStatus("AUTH_FAILED")).toBe(401);
  });

  it("maps forbidden errors to 403", () => {
    expect(mapFridayErrorToHttpStatus("FORBIDDEN")).toBe(403);
    expect(mapFridayErrorToHttpStatus("STREAM_NOT_AUTHORIZED")).toBe(403);
  });

  it("maps NOT_FOUND to 404", () => {
    expect(mapFridayErrorToHttpStatus("NOT_FOUND")).toBe(404);
  });

  it("maps STATE_CONFLICT to 409", () => {
    expect(mapFridayErrorToHttpStatus("STATE_CONFLICT")).toBe(409);
  });

  it("maps RATE_LIMITED to 429", () => {
    expect(mapFridayErrorToHttpStatus("RATE_LIMITED")).toBe(429);
  });

  it("maps PAYLOAD_TOO_LARGE to 413", () => {
    expect(mapFridayErrorToHttpStatus("PAYLOAD_TOO_LARGE")).toBe(413);
  });

  it("maps VALIDATION_ERROR to 422", () => {
    expect(mapFridayErrorToHttpStatus("VALIDATION_ERROR")).toBe(422);
  });

  it("maps INVALID_JSON to 400", () => {
    expect(mapFridayErrorToHttpStatus("INVALID_JSON")).toBe(400);
  });

  it("maps INTERNAL_ERROR to 500", () => {
    expect(mapFridayErrorToHttpStatus("INTERNAL_ERROR")).toBe(500);
  });

  it("maps unknown codes to 500", () => {
    expect(mapFridayErrorToHttpStatus("TOTALLY_UNKNOWN")).toBe(500);
  });

  it("maps TOOL_UNAVAILABLE and DEGRADED_MODE to 503", () => {
    expect(mapFridayErrorToHttpStatus("TOOL_UNAVAILABLE")).toBe(503);
    expect(mapFridayErrorToHttpStatus("DEGRADED_MODE")).toBe(503);
  });
});

describe("mapFridayErrorToWsCloseCode", () => {
  it("maps auth errors to 4001", () => {
    expect(mapFridayErrorToWsCloseCode("UNAUTHORIZED")).toBe(4001);
    expect(mapFridayErrorToWsCloseCode("NOT_AUTHENTICATED")).toBe(4001);
  });

  it("maps AUTH_FAILED to 4002", () => {
    expect(mapFridayErrorToWsCloseCode("AUTH_FAILED")).toBe(4002);
  });

  it("maps forbidden errors to 4003", () => {
    expect(mapFridayErrorToWsCloseCode("FORBIDDEN")).toBe(4003);
    expect(mapFridayErrorToWsCloseCode("STREAM_NOT_AUTHORIZED")).toBe(4003);
  });

  it("maps RATE_LIMITED to 4029", () => {
    expect(mapFridayErrorToWsCloseCode("RATE_LIMITED")).toBe(4029);
  });

  it("maps INTERNAL_ERROR to 4200", () => {
    expect(mapFridayErrorToWsCloseCode("INTERNAL_ERROR")).toBe(4200);
  });

  it("maps unknown codes to 4200", () => {
    expect(mapFridayErrorToWsCloseCode("SOMETHING_ELSE")).toBe(4200);
  });

  it("all codes are in 4000-4999 range", () => {
    for (const code of Object.values(FRIDAY_ERROR_CODES)) {
      const wsCode = mapFridayErrorToWsCloseCode(code);
      expect(wsCode).toBeGreaterThanOrEqual(4000);
      expect(wsCode).toBeLessThan(5000);
    }
  });
});

describe("mapFridayErrorToGrpcStatus", () => {
  it("maps auth errors to 16 (UNAUTHENTICATED)", () => {
    expect(mapFridayErrorToGrpcStatus("UNAUTHORIZED")).toBe(16);
    expect(mapFridayErrorToGrpcStatus("NOT_AUTHENTICATED")).toBe(16);
    expect(mapFridayErrorToGrpcStatus("AUTH_FAILED")).toBe(16);
  });

  it("maps forbidden errors to 7 (PERMISSION_DENIED)", () => {
    expect(mapFridayErrorToGrpcStatus("FORBIDDEN")).toBe(7);
    expect(mapFridayErrorToGrpcStatus("STREAM_NOT_AUTHORIZED")).toBe(7);
  });

  it("maps NOT_FOUND to 5", () => {
    expect(mapFridayErrorToGrpcStatus("NOT_FOUND")).toBe(5);
  });

  it("maps RATE_LIMITED to 8 (RESOURCE_EXHAUSTED)", () => {
    expect(mapFridayErrorToGrpcStatus("RATE_LIMITED")).toBe(8);
  });

  it("maps INTERNAL_ERROR to 13 (INTERNAL)", () => {
    expect(mapFridayErrorToGrpcStatus("INTERNAL_ERROR")).toBe(13);
  });

  it("maps UNKNOWN_ERROR to 2 (UNKNOWN)", () => {
    expect(mapFridayErrorToGrpcStatus("UNKNOWN_ERROR")).toBe(2);
  });

  it("maps unknown codes to 2 (UNKNOWN)", () => {
    expect(mapFridayErrorToGrpcStatus("NEVER_HEARD_OF_IT")).toBe(2);
  });
});

describe("Protocol mapping parity", () => {
  it("every canonical code has HTTP, WS, and gRPC mappings", () => {
    for (const code of Object.values(FRIDAY_ERROR_CODES)) {
      const http = mapFridayErrorToHttpStatus(code);
      const ws = mapFridayErrorToWsCloseCode(code);
      const grpc = mapFridayErrorToGrpcStatus(code);

      expect(http).toBeGreaterThanOrEqual(400);
      expect(http).toBeLessThan(600);
      expect(ws).toBeGreaterThanOrEqual(4000);
      expect(ws).toBeLessThan(5000);
      expect(grpc).toBeGreaterThanOrEqual(0);
      expect(grpc).toBeLessThanOrEqual(16);
    }
  });

  it("auth errors map consistently across protocols", () => {
    // HTTP 401, WS 4001, gRPC 16 for UNAUTHORIZED and NOT_AUTHENTICATED
    for (const code of ["UNAUTHORIZED", "NOT_AUTHENTICATED", "AUTH_FAILED"]) {
      expect(mapFridayErrorToHttpStatus(code)).toBe(401);
      expect(mapFridayErrorToGrpcStatus(code)).toBe(16);
    }
  });

  it("forbidden errors map consistently across protocols", () => {
    for (const code of ["FORBIDDEN", "STREAM_NOT_AUTHORIZED"]) {
      expect(mapFridayErrorToHttpStatus(code)).toBe(403);
      expect(mapFridayErrorToGrpcStatus(code)).toBe(7);
    }
  });
});

describe("validateFridayErrorShape", () => {
  it("returns true for valid error shape", () => {
    const shape = buildFridayErrorShape("NOT_FOUND", "Not found");
    expect(validateFridayErrorShape(shape)).toBe(true);
  });

  it("returns true for shape with all optional fields", () => {
    const shape = buildFridayErrorShape("RATE_LIMITED", "Too many", {
      retryAfterMs: 5000,
      details: { field: "x" },
      includeProtocol: true,
    });
    expect(validateFridayErrorShape(shape)).toBe(true);
  });

  it("returns errors for missing required fields", () => {
    const result = validateFridayErrorShape({});
    expect(result).not.toBe(true);
    expect(Array.isArray(result)).toBe(true);
  });

  it("returns errors for wrong types", () => {
    const result = validateFridayErrorShape({
      code: 123,
      message: "msg",
      retryable: "yes",
    });
    expect(result).not.toBe(true);
  });

  it("returns errors for empty code", () => {
    const result = validateFridayErrorShape({
      code: "",
      message: "msg",
      retryable: false,
    });
    expect(result).not.toBe(true);
  });

  it("rejects additional properties", () => {
    const result = validateFridayErrorShape({
      code: "TEST",
      message: "msg",
      retryable: false,
      extraField: "oops",
    });
    expect(result).not.toBe(true);
  });

  it("validates non-object inputs", () => {
    expect(validateFridayErrorShape(null)).not.toBe(true);
    expect(validateFridayErrorShape("string")).not.toBe(true);
    expect(validateFridayErrorShape(42)).not.toBe(true);
  });
});
