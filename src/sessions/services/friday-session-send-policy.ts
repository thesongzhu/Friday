import type { FridaySessionSendPolicy } from "../model/friday-session.types.js";

// ─── Constants ───

/** The default send policy when none is set on the session. */
export const FRIDAY_SESSION_DEFAULT_SEND_POLICY: FridaySessionSendPolicy = "allow";

/** Valid send policy values. */
export const FRIDAY_SESSION_VALID_SEND_POLICIES = new Set<FridaySessionSendPolicy>([
  "allow",
  "block",
  "queue",
]);

// ─── Normalization ───

/**
 * Normalize a raw send policy string to a valid FridaySessionSendPolicy.
 * Returns undefined if the input is null/undefined/invalid.
 */
export function normalizeFridaySessionSendPolicy(
  raw: string | null | undefined,
): FridaySessionSendPolicy | undefined {
  if (raw == null) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (FRIDAY_SESSION_VALID_SEND_POLICIES.has(normalized as FridaySessionSendPolicy)) {
    return normalized as FridaySessionSendPolicy;
  }
  return undefined;
}

// ─── Resolution ───

export interface FridaySessionSendPolicyResolveInput {
  /** Per-session override (from session record). */
  sessionPolicy?: FridaySessionSendPolicy;
  /** Rule-level policy (from config/rules). */
  rulePolicy?: FridaySessionSendPolicy;
}

/**
 * Resolve the effective send policy for a session.
 * Precedence: session override > rule-level > default ("allow").
 */
export function resolveFridaySessionSendPolicy(
  input: FridaySessionSendPolicyResolveInput,
): FridaySessionSendPolicy {
  if (input.sessionPolicy && FRIDAY_SESSION_VALID_SEND_POLICIES.has(input.sessionPolicy)) {
    return input.sessionPolicy;
  }
  if (input.rulePolicy && FRIDAY_SESSION_VALID_SEND_POLICIES.has(input.rulePolicy)) {
    return input.rulePolicy;
  }
  return FRIDAY_SESSION_DEFAULT_SEND_POLICY;
}

/**
 * Check whether a resolved send policy allows outbound sends.
 */
export function isFridaySessionSendAllowed(policy: FridaySessionSendPolicy): boolean {
  return policy === "allow";
}
