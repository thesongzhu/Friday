import { describe, it, expect } from "vitest";
import { FRIDAY_API_ERROR_CODES, buildFridayApiError } from "#api";

describe("FridayApiErrorCodes", () => {
  it("exposes all expected error codes", () => {
    expect(FRIDAY_API_ERROR_CODES.UNAUTHORIZED).toBe("UNAUTHORIZED");
    expect(FRIDAY_API_ERROR_CODES.FORBIDDEN).toBe("FORBIDDEN");
    expect(FRIDAY_API_ERROR_CODES.NOT_FOUND).toBe("NOT_FOUND");
    expect(FRIDAY_API_ERROR_CODES.RATE_LIMITED).toBe("RATE_LIMITED");
    expect(FRIDAY_API_ERROR_CODES.INVALID_JSON).toBe("INVALID_JSON");
    expect(FRIDAY_API_ERROR_CODES.INVALID_PATH).toBe("INVALID_PATH");
    expect(FRIDAY_API_ERROR_CODES.PAYLOAD_TOO_LARGE).toBe("PAYLOAD_TOO_LARGE");
    expect(FRIDAY_API_ERROR_CODES.INTERNAL_ERROR).toBe("INTERNAL_ERROR");
    expect(FRIDAY_API_ERROR_CODES.UNKNOWN_ERROR).toBe("UNKNOWN_ERROR");
  });

  describe("buildFridayApiError", () => {
    it("builds error shape with default retryable=false", () => {
      const err = buildFridayApiError("NOT_FOUND", "Resource not found");
      expect(err).toEqual({
        code: "NOT_FOUND",
        message: "Resource not found",
        retryable: false,
      });
    });

    it("sets retryable=true for RATE_LIMITED by default", () => {
      const err = buildFridayApiError("RATE_LIMITED", "Too many requests");
      expect(err.retryable).toBe(true);
    });

    it("allows retryable override", () => {
      const err = buildFridayApiError("RATE_LIMITED", "Too many requests", { retryable: false });
      expect(err.retryable).toBe(false);
    });

    it("includes retryAfterMs when provided", () => {
      const err = buildFridayApiError("RATE_LIMITED", "Too many requests", { retryAfterMs: 5000 });
      expect(err.retryAfterMs).toBe(5000);
    });

    it("omits retryAfterMs when not provided", () => {
      const err = buildFridayApiError("UNAUTHORIZED", "Auth required");
      expect(err).not.toHaveProperty("retryAfterMs");
    });
  });
});
