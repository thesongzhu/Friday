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
  | "secrets.read"
  | "secrets.write"
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
  | "workflow.webhook"
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
  | "playbook.promote"
  | "playbook.select"
  | "agent.run"
  | "channel.webhook"
  | "satellite.register"
  | "satellite.handshake"
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
}

export interface FridayAuthBootstrapRequest {
  passphrase: string;
}

export interface FridayAuthBootstrapResponse {
  initialized: true;
  initializedAt: ISODateTime;
  userId: UUID;
}

// ─── Device-bound owner claim (SEC-SETUP-BOOTSTRAP-001) ───
//
// The signed-native install-flow first mints a single-use install nonce
// (challenge), then presents it back with a device public key to atomically
// claim the local owner slot. This is an ADDITIVE alternative to the passphrase
// bootstrap above; both compete for the same single owner slot and the first to
// win flips it (the other fails closed). Passphrase removal is a later slice.

export interface FridayAuthBootstrapChallengeRequest {
  /** Stable installation id for this hub install (binds the nonce). */
  installId: string;
  /** OS user the install runs as (binds the nonce). */
  osUser: string;
  /** Loopback origin the claim will be presented from (binds the nonce). */
  origin: string;
  /** Optional bound action label; defaults to "owner-claim". */
  action?: string;
}

export interface FridayAuthBootstrapChallengeResponse {
  challengeId: UUID;
  /** Raw single-use nonce — returned exactly ONCE; only its hash is persisted. */
  nonce: string;
  kind: "install_owner_claim";
  hubId: string;
  installId: string;
  osUser: string;
  origin: string;
  action: string;
  createdAt: ISODateTime;
  expiresAt: ISODateTime;
}

export interface FridayAuthDeviceClaimRequest {
  /** The raw nonce previously issued by the challenge endpoint. */
  nonce: string;
  /** Device public key (opaque bytes, base64url) bound to the owner. */
  devicePublicKey: string;
  /** Device identifier bound to the owner. */
  deviceId: string;
  /** Origin the claim is presented from; MUST equal the bound issue origin. */
  origin: string;
  installId: string;
  osUser: string;
}

export interface FridayAuthDeviceClaimResponse {
  claimed: true;
  claimedAt: ISODateTime;
  userId: UUID;
  deviceId: string;
  /** Deterministic hash of the bound device public key (never the private key). */
  devicePublicKeyHash: string;
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
