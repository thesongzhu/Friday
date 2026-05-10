/**
 * Provider doctor diagnostics — pure classifier from health-snapshot + persisted
 * validation state to a stable remediation verdict token.
 *
 * The classifier consumes only stable enums, booleans, and known reason-code
 * strings. It does not accept `errorMessage` (or any free-text field) on its
 * input, and it never returns one. Surfaces (Settings, Setup wizard, etc.) map
 * the verdict to localized copy themselves; that keeps i18n out of pure logic
 * and preserves the secret-discipline boundary established in PR #185
 * (validator free-text belongs in the agent doctor action, not in the general
 * provider view).
 */

export type FridayProviderDoctorRemediationVerdict =
  | "healthy"
  | "provider_disabled"
  | "cli_problem"
  | "oauth_reauth_required"
  | "credential_problem"
  | "payment_required"
  | "connectivity_problem"
  | "model_problem"
  | "unverified_or_unknown"
  | "out_of_scope_health";

export interface FridayProviderDoctorRemediationInput {
  enabled?: boolean;
  validationStatus?: string;
  validationErrorCode?: string;
  reasons?: ReadonlyArray<string>;
  backendHealth?: string;
  authHealth?: string;
  routingEligible?: boolean;
}

/**
 * Classify a provider's doctor / health snapshot into a stable remediation
 * verdict. Priority order (most-actionable wins on conflict):
 *
 *   1. provider_disabled       — provider toggled off (admin can't fix anything else first)
 *   2. cli_problem             — auxiliary CLI auth/session must be repaired first
 *   3. oauth_reauth_required   — OAuth token manager check pending
 *   4. credential_problem      — common BYOK key/env-var issue
 *   5. payment_required        — key valid, account state needs attention (neutral copy at the surface)
 *   6. connectivity_problem    — provider unreachable
 *   7. model_problem           — model unavailable or supported-model list empty
 *   8. healthy                 — all green
 *   9. unverified_or_unknown   — never validated, validation_unverified, or PROVIDER_UNKNOWN_ERROR
 *  10. out_of_scope_health     — backend/auth degraded with no specific reason matched
 */
export function classifyFridayProviderDoctorRemediation(
  input: FridayProviderDoctorRemediationInput,
): FridayProviderDoctorRemediationVerdict {
  const reasons = input.reasons ?? [];
  const reasonSet = new Set(reasons);

  if (input.enabled === false || reasonSet.has("provider_disabled")) {
    return "provider_disabled";
  }

  if (reasonSet.has("cli_session_unhealthy") || reasonSet.has("cli_config_missing")) {
    return "cli_problem";
  }

  if (reasonSet.has("oauth_requires_token_manager_check")) {
    return "oauth_reauth_required";
  }

  if (
    input.validationErrorCode === "PROVIDER_AUTH_INVALID"
    || input.validationErrorCode === "PROVIDER_ENV_VAR_MISSING"
    || reasonSet.has("credential_missing")
  ) {
    return "credential_problem";
  }

  if (input.validationErrorCode === "PROVIDER_PAYMENT_REQUIRED") {
    return "payment_required";
  }

  if (input.validationErrorCode === "PROVIDER_UNREACHABLE") {
    return "connectivity_problem";
  }

  if (
    input.validationErrorCode === "PROVIDER_MODEL_UNAVAILABLE"
    || reasonSet.has("no_supported_models")
  ) {
    return "model_problem";
  }

  const validationOk = input.validationStatus === "ok";
  const backendOk = input.backendHealth === undefined || input.backendHealth === "healthy";
  const authOk = input.authHealth === undefined || input.authHealth === "healthy";

  if (validationOk && backendOk && authOk && reasons.length === 0) {
    return "healthy";
  }

  if (
    input.validationStatus === "never"
    || reasonSet.has("validation_unverified")
    || input.validationErrorCode === "PROVIDER_UNKNOWN_ERROR"
  ) {
    return "unverified_or_unknown";
  }

  return "out_of_scope_health";
}
