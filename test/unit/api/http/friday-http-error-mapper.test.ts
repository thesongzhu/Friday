import { describe, it, expect } from "vitest";
import { FridayDomainError } from "#errors";
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

    it("returns 500 for generic Error", () => {
      expect(mapErrorToStatusCode(new Error("boom"))).toBe(500);
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
      expect(apiError.retryable).toBe(false);
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

    it("preserves 4xx domain error details", () => {
      const err = new FridayDomainError("NOT_FOUND", "Session not found", { httpStatus: 404 });
      const result = buildErrorResponse(err, "req-2");
      expect(result.statusCode).toBe(404);
      expect(result.body.error.code).toBe("NOT_FOUND");
      expect(result.body.error.message).toBe("Session not found");
    });
  });
});
