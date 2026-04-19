import { describe, it, expect } from "vitest";
import { FRIDAY_ERROR_CODES, FridayDomainError } from "#errors";
import {
  mapErrorToStatusCode,
  mapErrorToApiError,
  buildErrorResponse,
} from "../../../../src/api/http/friday-http-error-mapper.js";

describe("FridayHttpErrorMapper", () => {
  describe("mapErrorToStatusCode", () => {
    it("returns httpStatus from FridayDomainError", () => {
      const err = new FridayDomainError("NOT_FOUND", "Not found", { httpStatus: 404 });
      expect(mapErrorToStatusCode(err)).toBe(404);
    });

    it("derives a default 4xx status from the Friday error code", () => {
      const err = new FridayDomainError("VALIDATION_ERROR", "Name is required");
      expect(mapErrorToStatusCode(err)).toBe(422);
    });

    it("returns 500 for generic Error", () => {
      expect(mapErrorToStatusCode(new Error("boom"))).toBe(500);
    });

    it("maps SQLITE_BUSY errors to 503 degraded mode", () => {
      const err = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      expect(mapErrorToStatusCode(err)).toBe(503);
    });

    it("returns 500 for non-Error value", () => {
      expect(mapErrorToStatusCode("string error")).toBe(500);
    });
  });

  describe("mapErrorToApiError", () => {
    it("preserves message for 4xx FridayDomainError", () => {
      const err = new FridayDomainError("INVALID_INPUT", "Name is required", {
        httpStatus: 400,
        retryable: false,
      });
      const apiError = mapErrorToApiError(err, 400);
      expect(apiError.code).toBe("INVALID_INPUT");
      expect(apiError.message).toBe("Name is required");
      expect(apiError.retryable).toBe(false);
    });

    it("masks message to 'Internal Server Error' for generic Error (500)", () => {
      const err = new Error("database connection string leaked");
      const apiError = mapErrorToApiError(err, 500);
      expect(apiError.code).toBe("INTERNAL_ERROR");
      expect(apiError.message).toBe("Internal Server Error");
      expect(apiError.retryable).toBe(false);
    });

    it("masks message to 'Internal Server Error' for 5xx FridayDomainError", () => {
      const err = new FridayDomainError("DB_FAILURE", "postgres: connection refused at 10.0.0.5:5432", {
        httpStatus: 503,
        retryable: true,
      });
      const apiError = mapErrorToApiError(err, 503);
      expect(apiError.code).toBe("DB_FAILURE");
      expect(apiError.message).toBe("Internal Server Error");
      expect(apiError.retryable).toBe(true);
    });

    it("normalizes SQLITE_BUSY errors to masked retryable degraded responses", () => {
      const err = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      const apiError = mapErrorToApiError(err, 503);
      expect(apiError.code).toBe(FRIDAY_ERROR_CODES.DEGRADED_MODE);
      expect(apiError.message).toBe("Internal Server Error");
      expect(apiError.retryable).toBe(true);
    });

    it("masks message for non-Error values with 500 status", () => {
      const apiError = mapErrorToApiError("string error", 500);
      expect(apiError.code).toBe("INTERNAL_ERROR");
      expect(apiError.message).toBe("Internal Server Error");
      expect(apiError.retryable).toBe(false);
    });

    it("preserves retryable for 4xx FridayDomainError", () => {
      const err = new FridayDomainError("RATE_LIMITED", "Too many requests", {
        httpStatus: 429,
        retryable: true,
      });
      const apiError = mapErrorToApiError(err, 429);
      expect(apiError.retryable).toBe(true);
    });
  });

  describe("buildErrorResponse", () => {
    it("returns masked 5xx response for generic errors", () => {
      const result = buildErrorResponse(new Error("secret info"), "req-1");
      expect(result.statusCode).toBe(500);
      expect(result.body.ok).toBe(false);
      expect(result.body.error.message).toBe("Internal Server Error");
      expect(result.body.error.retryable).toBe(false);
      expect(result.body.requestId).toBe("req-1");
    });

    it("maps SQLITE_BUSY responses to 503 with retry-after metadata", () => {
      const err = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      const result = buildErrorResponse(err, "req-busy");
      expect(result.statusCode).toBe(503);
      expect(result.body.error.code).toBe(FRIDAY_ERROR_CODES.DEGRADED_MODE);
      expect(result.body.error.message).toBe("Internal Server Error");
      expect(result.body.error.retryable).toBe(true);
      expect(result.body.error.retryAfterMs).toBe(1000);
      expect(result.headers?.["Retry-After"]).toBe("1");
    });

    it("preserves 4xx domain error details", () => {
      const err = new FridayDomainError("NOT_FOUND", "Session not found", { httpStatus: 404 });
      const result = buildErrorResponse(err, "req-2");
      expect(result.statusCode).toBe(404);
      expect(result.body.error.code).toBe("NOT_FOUND");
      expect(result.body.error.message).toBe("Session not found");
    });

    it("does not mask validation errors when the route omitted httpStatus", () => {
      const err = new FridayDomainError("VALIDATION_ERROR", "condition is required");
      const result = buildErrorResponse(err, "req-3");
      expect(result.statusCode).toBe(422);
      expect(result.body.error.code).toBe("VALIDATION_ERROR");
      expect(result.body.error.message).toBe("condition is required");
    });
  });
});
