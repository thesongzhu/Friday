import { describe, expect, it } from "vitest";

import { ApiError } from "../../../ui/src/lib/api/types";
import { shouldRetryQuery } from "../../../ui/src/providers/query-provider";

describe("query retry policy", () => {
  it("retries one time for network failures", () => {
    expect(shouldRetryQuery(0, new ApiError("NETWORK_ERROR", "offline", 0))).toBe(true);
    expect(shouldRetryQuery(1, new ApiError("NETWORK_ERROR", "offline", 0))).toBe(false);
  });

  it("does not retry deterministic API failures by default", () => {
    expect(shouldRetryQuery(0, new ApiError("SERVER_ERROR", "boom", 500, false))).toBe(false);
    expect(shouldRetryQuery(0, new ApiError("BAD_REQUEST", "bad input", 400, false))).toBe(false);
  });

  it("allows one retry when the server explicitly marks the error retryable", () => {
    expect(shouldRetryQuery(0, new ApiError("TRANSIENT", "try again", 503, true))).toBe(true);
    expect(shouldRetryQuery(1, new ApiError("TRANSIENT", "try again", 503, true))).toBe(false);
  });
});
