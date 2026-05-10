import { describe, expect, it } from "vitest";

import {
  classifyFridayProviderDoctorRemediation,
  type FridayProviderDoctorRemediationInput,
  type FridayProviderDoctorRemediationVerdict,
} from "@/lib/providers/provider-doctor-diagnostics";

const VERDICT_TOKENS: ReadonlyArray<FridayProviderDoctorRemediationVerdict> = [
  "healthy",
  "provider_disabled",
  "cli_problem",
  "oauth_reauth_required",
  "credential_problem",
  "payment_required",
  "connectivity_problem",
  "model_problem",
  "unverified_or_unknown",
  "out_of_scope_health",
];

function healthy(overrides: Partial<FridayProviderDoctorRemediationInput> = {}): FridayProviderDoctorRemediationInput {
  return {
    enabled: true,
    validationStatus: "ok",
    backendHealth: "healthy",
    authHealth: "healthy",
    routingEligible: true,
    reasons: [],
    ...overrides,
  };
}

describe("classifyFridayProviderDoctorRemediation", () => {
  it("returns healthy when validation is ok, both health channels are healthy, and there are no reasons", () => {
    expect(classifyFridayProviderDoctorRemediation(healthy())).toBe("healthy");
  });

  it("returns provider_disabled when enabled=false (overrides any other failure signal)", () => {
    expect(
      classifyFridayProviderDoctorRemediation(healthy({
        enabled: false,
        validationStatus: "failed",
        validationErrorCode: "PROVIDER_AUTH_INVALID",
      })),
    ).toBe("provider_disabled");
  });

  it("returns provider_disabled when reasons include provider_disabled even if enabled flag is missing", () => {
    expect(
      classifyFridayProviderDoctorRemediation({
        reasons: ["provider_disabled"],
      }),
    ).toBe("provider_disabled");
  });

  it("returns cli_problem for cli_session_unhealthy reason", () => {
    expect(
      classifyFridayProviderDoctorRemediation(healthy({
        validationStatus: "failed",
        reasons: ["cli_session_unhealthy"],
      })),
    ).toBe("cli_problem");
  });

  it("returns cli_problem for cli_config_missing reason", () => {
    expect(
      classifyFridayProviderDoctorRemediation(healthy({
        validationStatus: "failed",
        reasons: ["cli_config_missing"],
      })),
    ).toBe("cli_problem");
  });

  it("returns oauth_reauth_required for oauth_requires_token_manager_check reason", () => {
    expect(
      classifyFridayProviderDoctorRemediation(healthy({
        validationStatus: "failed",
        reasons: ["oauth_requires_token_manager_check"],
      })),
    ).toBe("oauth_reauth_required");
  });

  it("returns credential_problem for PROVIDER_AUTH_INVALID errorCode", () => {
    expect(
      classifyFridayProviderDoctorRemediation(healthy({
        validationStatus: "failed",
        validationErrorCode: "PROVIDER_AUTH_INVALID",
      })),
    ).toBe("credential_problem");
  });

  it("returns credential_problem for PROVIDER_ENV_VAR_MISSING errorCode", () => {
    expect(
      classifyFridayProviderDoctorRemediation(healthy({
        validationStatus: "failed",
        validationErrorCode: "PROVIDER_ENV_VAR_MISSING",
      })),
    ).toBe("credential_problem");
  });

  it("returns credential_problem when reasons include credential_missing", () => {
    expect(
      classifyFridayProviderDoctorRemediation(healthy({
        validationStatus: "failed",
        reasons: ["credential_missing"],
      })),
    ).toBe("credential_problem");
  });

  it("returns payment_required for PROVIDER_PAYMENT_REQUIRED errorCode", () => {
    expect(
      classifyFridayProviderDoctorRemediation(healthy({
        validationStatus: "failed",
        validationErrorCode: "PROVIDER_PAYMENT_REQUIRED",
      })),
    ).toBe("payment_required");
  });

  it("returns connectivity_problem for PROVIDER_UNREACHABLE errorCode", () => {
    expect(
      classifyFridayProviderDoctorRemediation(healthy({
        validationStatus: "failed",
        validationErrorCode: "PROVIDER_UNREACHABLE",
      })),
    ).toBe("connectivity_problem");
  });

  it("returns model_problem for PROVIDER_MODEL_UNAVAILABLE errorCode", () => {
    expect(
      classifyFridayProviderDoctorRemediation(healthy({
        validationStatus: "failed",
        validationErrorCode: "PROVIDER_MODEL_UNAVAILABLE",
      })),
    ).toBe("model_problem");
  });

  it("returns model_problem when reasons include no_supported_models", () => {
    expect(
      classifyFridayProviderDoctorRemediation(healthy({
        validationStatus: "failed",
        reasons: ["no_supported_models"],
      })),
    ).toBe("model_problem");
  });

  it("returns unverified_or_unknown when validationStatus is never", () => {
    expect(
      classifyFridayProviderDoctorRemediation(healthy({
        validationStatus: "never",
      })),
    ).toBe("unverified_or_unknown");
  });

  it("returns unverified_or_unknown when reasons include validation_unverified", () => {
    expect(
      classifyFridayProviderDoctorRemediation(healthy({
        validationStatus: "failed",
        reasons: ["validation_unverified"],
      })),
    ).toBe("unverified_or_unknown");
  });

  it("returns unverified_or_unknown for PROVIDER_UNKNOWN_ERROR errorCode", () => {
    expect(
      classifyFridayProviderDoctorRemediation(healthy({
        validationStatus: "failed",
        validationErrorCode: "PROVIDER_UNKNOWN_ERROR",
      })),
    ).toBe("unverified_or_unknown");
  });

  it("returns out_of_scope_health when health channels are degraded with no specific reason matched", () => {
    expect(
      classifyFridayProviderDoctorRemediation({
        enabled: true,
        validationStatus: "ok",
        backendHealth: "degraded",
        authHealth: "healthy",
        reasons: [],
      }),
    ).toBe("out_of_scope_health");
  });

  it("priority: provider_disabled wins over credential_problem", () => {
    expect(
      classifyFridayProviderDoctorRemediation({
        enabled: false,
        validationStatus: "failed",
        validationErrorCode: "PROVIDER_AUTH_INVALID",
        reasons: ["credential_missing"],
      }),
    ).toBe("provider_disabled");
  });

  it("priority: cli_problem wins over credential_problem when both signals present", () => {
    expect(
      classifyFridayProviderDoctorRemediation(healthy({
        validationStatus: "failed",
        validationErrorCode: "PROVIDER_AUTH_INVALID",
        reasons: ["cli_session_unhealthy"],
      })),
    ).toBe("cli_problem");
  });

  it("priority: oauth_reauth_required wins over credential_problem when both signals present", () => {
    expect(
      classifyFridayProviderDoctorRemediation(healthy({
        validationStatus: "failed",
        validationErrorCode: "PROVIDER_AUTH_INVALID",
        reasons: ["oauth_requires_token_manager_check"],
      })),
    ).toBe("oauth_reauth_required");
  });

  it("ignores any unknown free-text fields on the input (errorMessage cannot leak into the verdict)", () => {
    // Cast through a wider type to simulate a careless caller passing the raw
    // FridayProviderValidationState (which carries errorMessage). The helper's
    // declared input does not include errorMessage; this test pins the
    // structural boundary so a future refactor cannot regress it.
    const careless = {
      enabled: true,
      validationStatus: "failed",
      validationErrorCode: "PROVIDER_AUTH_INVALID",
      reasons: [],
      errorMessage: "validator-detail-must-not-leak-via-classifier",
    } as unknown as FridayProviderDoctorRemediationInput;

    const verdict = classifyFridayProviderDoctorRemediation(careless);

    expect(verdict).toBe("credential_problem");
    expect(VERDICT_TOKENS).toContain(verdict);
    expect(verdict).not.toContain("validator-detail-must-not-leak-via-classifier");
    expect(verdict).not.toContain("ignored");
  });

  it("returns a verdict that is always one of the declared union tokens", () => {
    // Sweep a few mixed inputs and assert every output is in the declared union.
    const inputs: FridayProviderDoctorRemediationInput[] = [
      {},
      { enabled: true },
      { enabled: false },
      { validationStatus: "ok", backendHealth: "healthy", authHealth: "healthy" },
      { validationStatus: "failed", validationErrorCode: "PROVIDER_PAYMENT_REQUIRED" },
      { reasons: ["cli_session_unhealthy", "credential_missing"] },
      { backendHealth: "missing", authHealth: "status_unknown" },
    ];
    for (const input of inputs) {
      const verdict = classifyFridayProviderDoctorRemediation(input);
      expect(VERDICT_TOKENS).toContain(verdict);
    }
  });
});
