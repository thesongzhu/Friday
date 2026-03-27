import type { ISODateTime, UUID } from "#workflows";
import type { FridayPrincipalType } from "./friday-api-principal.types.js";

// ─── Roles ───

export type FridayRole = "owner" | "admin" | "operator" | "viewer";

// ─── Token Kind ───

export type FridayTokenKind = "access" | "refresh" | "api" | "satellite";

// ─── Scopes ───

export type FridayScope =
  | "hub.admin"
  | "workflow.read"
  | "workflow.write"
  | "workflow.run"
  | "workflow.conflict.resolve"
  | "satellite.read"
  | "satellite.write"
  | "fleet.read"
  | "security.read"
  | "security.write"
  | "session.read"
  | "session.write"
  | "diagnosis.read"
  | "diagnosis.write"
  | "agent.read"
  | "agent.run"
  | "agent.write"
  | "skill.read"
  | "skill.write"
  | "plugin.read"
  | "plugin.write"
  | "plugin.install"
  | "desktop.read"
  | "desktop.write"
  | "desktop.execute"
  | "marketplace.read"
  | "marketplace.write"
  | "marketplace.admin"
  | "rules.read"
  | "rules.write"
  | "execution.read"
  | "acceptance.read"
  | "retry.read"
  | "playbook.read"
  | "playbook.write";

// ─── Rate Limit Policy IDs ───

export type FridayRateLimitPolicyId =
  | "auth.login"
  | "auth.refresh"
  | "auth.logout"
  | "workflow.start_run"
  | "workflow.publish"
  | "workflow.resolve_conflict"
  | "realtime.subscribe"
  | "realtime.pull"
  | "realtime.ws_connect"
  | "provider.write"
  | "provider.validate"
  | "generator.llm"
  | "generator.write"
  | "skill_generator.llm"
  | "skill_generator.write"
  | "skill_converter.write"
  | "marketplace.checkout"
  | "marketplace.write"
  | "playbook.promote"
  | "playbook.select"
  | "agent.run"
  | "session.write"
  | "memory.write";

// ─── Auth Principal ───

export interface FridayAuthPrincipal {
  principalType: FridayPrincipalType;
  principalId: string;
  tenantId?: UUID | null;
  userId?: UUID;
  role?: FridayRole;
  scopes: FridayScope[];
  tokenId: UUID;
  tokenKind: FridayTokenKind;
  issuedAt: ISODateTime;
  expiresAt?: ISODateTime;
  sessionId?: UUID;
  tokenVersion?: number;
}

// ─── Access Token Claims ───

export interface FridayAccessTokenClaims {
  tokenId: UUID;
  principalType: FridayPrincipalType;
  principalId: string;
  tenantId?: UUID | null;
  userId?: UUID;
  role?: FridayRole;
  scopes: FridayScope[];
  iat: number;
  exp: number;
  sid?: UUID;
  ver?: number;
}

// ─── Validated Token ───

export interface FridayValidatedToken {
  principal: FridayAuthPrincipal;
  rawToken: string;
  claims?: FridayAccessTokenClaims;
}

// ─── Login ───

export interface FridayLoginRequest {
  email?: string;
  password?: string;
  localPassphrase?: string;
  rememberMe?: boolean;
  /** Explicit flag required for dev-mode passwordless login. */
  local?: boolean;
}

export interface FridayLoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
  user: {
    id: UUID;
    email?: string;
    displayName: string;
    role: FridayRole;
  };
}

// ─── Local bootstrap (first-login passphrase setup) ───

export interface FridayAuthBootstrapStatusResponse {
  bootstrapRequired: boolean;
  allowPasswordlessLocalLogin: boolean;
  /** True when no-signin local bypass is enabled for `login({ local: true })`. */
  allowLocalBypassLogin: boolean;
}

export interface FridayAuthBootstrapRequest {
  passphrase: string;
}

export interface FridayAuthBootstrapResponse {
  initialized: true;
  initializedAt: ISODateTime;
  userId: UUID;
}

// ─── Refresh ───

export interface FridayRefreshRequest {
  refreshToken: string;
}

export interface FridayRefreshResponse {
  accessToken: string;
  refreshToken?: string;
  expiresInSec: number;
}

// ─── Logout ───

export interface FridayLogoutRequest {
  refreshToken?: string;
  allSessions?: boolean;
}

export interface FridayLogoutResponse {
  ok: true;
}

// ─── Me ───

export interface FridayAuthMeResponse {
  user: {
    id: UUID;
    email?: string;
    displayName: string;
    role: FridayRole;
  };
  scopes: FridayScope[];
  sessionExpiresAt?: ISODateTime;
}

// ─── Rate Limit ───

export interface FridayRateLimitPolicy {
  id: FridayRateLimitPolicyId;
  windowMs: number;
  maxHits: number;
  keyBy: "ip" | "principal" | "principal+route" | "session";
}

export interface FridayRateLimitDecision {
  allowed: boolean;
  policyId: FridayRateLimitPolicyId;
  limit: number;
  remaining: number;
  resetAt: ISODateTime;
}
