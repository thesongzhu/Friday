import { describe, expect, it } from "vitest";
import { ApiError, AuthExpiredError } from "@/lib/api/types";
import { describeSetupStatusFailure } from "@/lib/setup/setup-status-diagnostics";

describe("describeSetupStatusFailure", () => {
  const origin = "http://127.0.0.1:50576";

  it("classifies unauthorized setup status failures as auth issues", () => {
    const result = describeSetupStatusFailure(
      new ApiError("UNAUTHORIZED", "Authentication required", 401),
      origin,
    );

    expect(result.title).toContain("valid local session");
    expect(result.detail).toContain(origin);
    expect(result.actions.join(" ")).toContain("NODE_ENV=development");
  });

  it("classifies not found setup status failures as origin assembly problems", () => {
    const result = describeSetupStatusFailure(
      new ApiError("NOT_FOUND", "No route matches GET /v1/setup/status", 404),
      origin,
    );

    expect(result.title).toContain("not mounted");
    expect(result.actions.join(" ")).toContain("5173");
    expect(result.actions.join(" ")).toContain("3141");
  });

  it("classifies invalid response failures as wrong payloads from /v1", () => {
    const result = describeSetupStatusFailure(
      new ApiError(
        "INVALID_RESPONSE",
        "Friday API returned an unexpected response.",
        200,
        false,
        undefined,
        "Expected Friday API JSON from /v1/setup/status, but received HTML instead.",
      ),
      origin,
    );

    expect(result.title).toContain("wrong payload");
    expect(result.detail).toContain("received HTML");
  });

  it("classifies network failures as unreachable APIs", () => {
    const result = describeSetupStatusFailure(
      new ApiError("NETWORK_ERROR", "Could not reach the Friday API.", 0),
      origin,
    );

    expect(result.title).toContain("not reachable");
    expect(result.detail).toContain("/v1/setup/status");
  });

  it("classifies expired sessions explicitly", () => {
    const result = describeSetupStatusFailure(new AuthExpiredError(), origin);

    expect(result.title).toContain("session expired");
    expect(result.actions.join(" ")).toContain("Reload the page");
  });
});
