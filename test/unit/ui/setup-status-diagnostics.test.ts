import { describe, expect, it } from "vitest";
import { ApiError, AuthExpiredError } from "@/lib/api/types";
import {
  classifyFridaySaveProviderValidation,
  describeSetupStatusFailure,
} from "@/lib/setup/setup-status-diagnostics";

describe("describeSetupStatusFailure", () => {
  const origin = "http://127.0.0.1:50576";

  it("classifies unauthorized setup status failures as local connection issues", () => {
    const result = describeSetupStatusFailure(
      new ApiError("UNAUTHORIZED", "Authentication required", 401),
      origin,
    );

    expect(result.title).toContain("local Friday connection");
    expect(result.detail).toContain(origin);
    expect(result.actions.join(" ")).toContain("local passphrase");
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

  it("classifies reset local connections explicitly", () => {
    const result = describeSetupStatusFailure(new AuthExpiredError(), origin);

    expect(result.title).toContain("local connection reset");
    expect(result.actions.join(" ")).toContain("Reload the page");
  });
});

describe("classifyFridaySaveProviderValidation", () => {
  it("returns validation_ok when the saved provider doctored to ok", () => {
    expect(classifyFridaySaveProviderValidation({ status: "ok" })).toBe("validation_ok");
  });

  it("returns validation_failed when the saved provider doctored to failed", () => {
    expect(classifyFridaySaveProviderValidation({ status: "failed" })).toBe("validation_failed");
  });

  it("returns validation_unknown when the saved provider was not yet doctored", () => {
    expect(classifyFridaySaveProviderValidation({ status: "never" })).toBe("validation_unknown");
  });

  it("returns validation_unknown when the save response carries no validation field", () => {
    expect(classifyFridaySaveProviderValidation(undefined)).toBe("validation_unknown");
  });

  it("derives the verdict from status alone and ignores any errorMessage payload", () => {
    const verdict = classifyFridaySaveProviderValidation({
      status: "failed",
    });
    expect(verdict).toBe("validation_failed");
    expect(verdict).not.toContain("ignored");
  });
});
