import type { FridaySqliteLayer } from "#state";
import type {
  FridayRateLimitDecision,
  FridayRateLimitPolicy,
  FridayRateLimitPolicyId,
} from "../model/friday-api-auth.types.js";

// ─── Auth lockout scope constants ───

/** Scope for shared-secret (password/passphrase) authentication. */
export const AUTH_LOCKOUT_SCOPE_SHARED_SECRET = "shared-secret";
/** Scope for device-token authentication. */
export const AUTH_LOCKOUT_SCOPE_DEVICE_TOKEN = "device-token";

// ─── Auth lockout types ───

export interface FridayAuthLockoutConfig {
  /** Maximum failed attempts before lockout. Default: 10. */
  maxAttempts: number;
  /** Window in ms for counting failures. Default: 60_000. */
  windowMs: number;
  /** Base lockout duration in ms. Escalates by 2^level. Default: 300_000. */
  lockoutMs: number;
  /** Maximum lockout level for escalation cap. Default: 4 (= 16× base). */
  maxLockoutLevel: number;
  /** Exempt loopback addresses (127.0.0.1, ::1, ::ffff:127.0.0.1) from IP lockout checks. Default: false. */
  exemptLoopback?: boolean;
}

export interface FridayAuthLockoutStatus {
  locked: boolean;
  /** ISO timestamp when the lockout expires (only when locked). */
  retryAfter?: string;
  /** Remaining ms until lockout expires (only when locked). */
  retryAfterMs?: number;
  /** Current failure count in the active window. */
  failureCount: number;
  /** Escalation level (0 = first lockout, increases on repeated lockouts). */
  lockoutLevel: number;
}

export interface FridayRateLimitService {
  check(policyId: FridayRateLimitPolicyId, key: string): FridayRateLimitDecision;
  increment(policyId: FridayRateLimitPolicyId, key: string): FridayRateLimitDecision;
  getPolicy(policyId: FridayRateLimitPolicyId): FridayRateLimitPolicy | undefined;

  // ─── Auth lockout methods ───
  /** Check if a principal is currently locked out. Scope partitions lockout counters. */
  checkAuthLockout(principalKey: string, scope?: string): FridayAuthLockoutStatus;
  /** Record a failed auth attempt for a principal. May trigger lockout. */
  recordAuthFailure(principalKey: string, scope?: string): FridayAuthLockoutStatus;
  /** Reset auth failures for a principal (call on successful login). */
  resetAuthFailures(principalKey: string, scope?: string): void;

  // ─── IP lockout methods ───
  /** Check if an IP is currently locked out. */
  checkIpLockout(ip: string | undefined): FridayAuthLockoutStatus;
  /** Record a failed auth attempt from an IP. */
  recordIpFailure(ip: string | undefined): FridayAuthLockoutStatus;
  /** Reset IP lockout on successful auth from this IP. */
  resetIpFailures(ip: string | undefined): void;

  /** Dispose resources (prune timer, entries). */
  dispose?(): void;
}

export interface CreateFridayRateLimitServiceDeps {
  db: FridaySqliteLayer;
  nowIso: () => string;
  policyOverrides?: Partial<Record<FridayRateLimitPolicyId, Partial<FridayRateLimitPolicy>>>;
  /** Override auth lockout configuration. */
  authLockoutConfig?: Partial<FridayAuthLockoutConfig>;
}
