import { FridayDomainError } from "#errors";

import {
  FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID,
  FRIDAY_DEFAULT_PUBLIC_HTTP_TOKEN_ID,
  FRIDAY_DEFAULT_PUBLIC_HTTP_USER_ID,
} from "../api/http/friday-default-public-principal.js";
import type { FridayAuthPrincipal, FridayRole, FridayScope } from "../api/model/friday-api-auth.types.js";
import {
  DEVICE_OWNER_PRINCIPAL_TYPE,
  isDeviceOwnerAuthorityEnabled,
  isDeviceOwnerPrincipalId,
} from "./friday-device-owner-authority-precondition.js";

// Phase 14.5A — module_28a owner/session/channel capability gate.
// Source-aware boundary above high-risk public mutating operations.
// Required gates here cannot be disabled by Light/Standard/Strict profile,
// automation budget, or user config; they fail closed by default and only
// open via an explicit per-resource opt-in that the operator configures.

export type FridayPublicMutationOperation =
  | "capability.grant.revoke"
  | "sessions.create"
  | "sessions.messages.create"
  | "workflow.create"
  | "workflow.update"
  | "workflow.archive"
  | "workflow.publish"
  | "workflow.template.instantiate"
  | "workflow.draft.create"
  | "workflow.bundle.import"
  | "workflow.draft.save"
  | "workflow.draft.autosave"
  | "workflow.draft.compile"
  | "workflow.draft.publish"
  | "workflow.lock.acquire"
  | "workflow.lock.renew"
  | "workflow.lock.release"
  | "workflow.deploy"
  | "workflow.generator.session.create"
  | "workflow.generator.message.create"
  | "workflow.generator.generate"
  | "workflow.generator.approve"
  | "workflow.generator.cancel"
  | "workflow.trigger.update"
  | "workflow.trigger.resync"
  | "workflow.conflict.resolve"
  | "workflow.run.start"
  | "workflow.run.evidence.export"
  | "workflow.run.cancel"
  | "workflow.run.retry"
  | "workflow.run.resume"
  | "workflow.webhook.invoke"
  | "workflow.approval.approve"
  | "workflow.approval.reject"
  | "agent.plan.approve"
  | "agent.plan.reject"
  | "agent.tool.approve"
  | "agent.tool.reject"
  | "agent.run.resume"
  | "run.outcome.learning.decide.apply"
  | "satellite.pairing.approve"
  | "satellite.pairing.reject"
  | "satellite.revoke"
  | "security.token.revoke"
  | "task.workflow.create"
  | "task.workflow.revise"
  | "task.workflow.claim.create"
  | "task.workflow.evidence.attach"
  | "task.workflow.evidence.raw.read"
  | "task.workflow.claim.verify"
  | "task.workflow.claim.block"
  | "task.workflow.closeout"
  | "task.workflow.lane.executor.open"
  | "task.workflow.lane.verifier.open"
  | "task.workflow.lane.complete"
  | "task.workflow.lane.verdict"
  | "task.workflow.cli.handoff.record"
  | "task.workflow.channel.command.issue"
  | "task.workflow.channel.command.confirm"
  // SEC-SETUP-BOOTSTRAP-001 Slice 5 — authenticated legacy-passphrase → device
  // migration. Public mutating routes that refuse the synthetic public principal
  // (only the bound local OWNER may mint a migration nonce / migrate ownership).
  | "auth.migrate.challenge"
  | "auth.migrate.device.claim"
  | "runtime.config.update"
  | "runtime.config.revert"
  | "runtime.secret.list"
  | "runtime.secret.read"
  | "runtime.secret.create"
  | "runtime.secret.update"
  | "runtime.secret.delete"
  | "security.multi_tenant.read"
  | "security.multi_tenant.write"
  | "autofix.actions.run.ready"
  | "autofix.actions.approve"
  | "autofix.actions.deny"
  | "autofix.actions.execute"
  | "autofix.actions.rollback"
  | "autofix.actions.preview"
  // Phase 17A — user-owned cloud worker setup UX bound-principal ops.
  | "cloud.worker.dns.validate"
  | "cloud.worker.package.generate"
  | "cloud.worker.teardown.receipt"
  // Lane B / D20 W1 — organic mission-spine mutations driven over the sealed-WS dispatch
  // arms (Mission intake / Mission lifecycle / WorkItem status / RouteDecision control).
  // Public mutating routes: refuse the synthetic public principal; only a bound owner drives a
  // Mission/WorkItem transition or pre-dispatch route veto/override.
  | "mission.spine.intake"
  | "mission.spine.lifecycle"
  | "mission.spine.workitem.status"
  | "mission.spine.routedecision.control"
  | "agent.d20.worktree.batch.dispatch"
  // Lane M — the memory-confirmation loop's terminal mutation driven over the
  // sealed-WS dispatch arm (OWNER confirm/reject of ONE memory candidate). Public
  // mutating route: refuse the synthetic public principal; only a bound owner can
  // confirm/reject (and the Rust side ALSO scopes the decision to the candidate's
  // owning principal).
  | "memory.spine.decide";

export type FridayBoundPrincipalSource = "api" | "session" | "channel" | "satellite" | "device";

export const ERROR_CODE_BOUND_PRINCIPAL_REQUIRED = "OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED";
const ERROR_CODE_BOUND_PRINCIPAL_AUTHORITY_REQUIRED = "OWNER_SESSION_CHANNEL_AUTHORITY_REQUIRED";
const ERROR_CODE_WEBHOOK_HMAC_REQUIRED = "WORKFLOW_WEBHOOK_HMAC_REQUIRED";
const ERROR_CODE_WEBHOOK_PATH_TOKEN_WEAK = "WORKFLOW_WEBHOOK_PATH_TOKEN_WEAK";

const BEARER_ONLY_OPT_IN_ENV = "FRIDAY_WORKFLOW_WEBHOOK_BEARER_ONLY_PATH_TOKENS";
const WEBHOOK_PATH_TOKEN_MIN_LENGTH = 32;

const SENSITIVE_HEADER_PATTERNS: ReadonlyArray<RegExp> = [
  /^authorization$/i,
  /^proxy-authorization$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /^x-api-key$/i,
  /^x-auth-token$/i,
  /^x-session-token$/i,
  /^x-csrf-token$/i,
];

/**
 * SEC-SETUP-BOOTSTRAP-001 Slice 3 — a device-bound owner principal that is
 * DISABLED in the release/default profile (the server-derived device-authority
 * switch is off, which is ALWAYS the case until native-IPC caller-identity (b)
 * lands). Such a principal MUST be treated exactly like the synthetic anonymous
 * principal by every floor. This is keyed on the principal TYPE + the
 * server-derived switch — NOT on "the id is not public:default" — so a device
 * principal minted non-synthetic with owner scopes cannot slip through L1/L2/L3.
 */
export function isReleaseDisabledDevicePrincipal(
  principal: FridayAuthPrincipal | null | undefined,
): boolean {
  if (!principal) return false;
  if (principal.principalType !== DEVICE_OWNER_PRINCIPAL_TYPE) return false;
  // Fail closed: the device principal carries authority ONLY when the
  // server-derived switch is on. Off (today) ⇒ treat as unauthenticated.
  return !isDeviceOwnerAuthorityEnabled();
}

export function isUnauthenticatedPublicPrincipal(
  principal: FridayAuthPrincipal | null | undefined,
): boolean {
  if (!principal) return true;
  if (principal.principalId === FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID) return true;
  if (principal.tokenId === FRIDAY_DEFAULT_PUBLIC_HTTP_TOKEN_ID) return true;
  if (
    principal.userId === FRIDAY_DEFAULT_PUBLIC_HTTP_USER_ID &&
    principal.principalId === FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID
  ) {
    return true;
  }
  // Additive fail-closed refusal: a release-disabled device principal is refused
  // exactly like the synthetic anonymous principal across L1/L2/L3.
  if (isReleaseDisabledDevicePrincipal(principal)) return true;
  return false;
}

export interface FridayBoundPrincipalDescriptor {
  readonly principalId: string;
  readonly principalType: string;
  readonly tenantId?: string | null;
  readonly userId?: string;
  readonly sessionId?: string;
  readonly tokenId: string;
  readonly source: FridayBoundPrincipalSource;
}

export interface FridayBoundPrincipalAuthorityRequirement {
  readonly anyOfScopes?: readonly FridayScope[];
  readonly anyOfRoles?: readonly FridayRole[];
}

export function assertBoundPrincipalForOperation(
  principal: FridayAuthPrincipal | null | undefined,
  operation: FridayPublicMutationOperation,
  source: FridayBoundPrincipalSource = "api",
): FridayBoundPrincipalDescriptor {
  if (isUnauthenticatedPublicPrincipal(principal)) {
    throw new FridayDomainError(
      ERROR_CODE_BOUND_PRINCIPAL_REQUIRED,
      `${operation} requires a bound owner/session/channel principal; the synthetic public principal cannot approve high-risk operations.`,
      { httpStatus: 401 },
    );
  }
  // principal is non-null here per the guard above.
  const bound = principal as FridayAuthPrincipal;
  return {
    principalId: bound.principalId,
    principalType: bound.principalType,
    tenantId: bound.tenantId ?? undefined,
    userId: bound.userId,
    sessionId: bound.sessionId,
    tokenId: bound.tokenId,
    source,
  };
}

export function assertBoundPrincipalAuthorityForOperation(
  principal: FridayAuthPrincipal | null | undefined,
  operation: FridayPublicMutationOperation,
  source: FridayBoundPrincipalSource,
  requirement: FridayBoundPrincipalAuthorityRequirement,
): FridayBoundPrincipalDescriptor {
  const bound = assertBoundPrincipalForOperation(principal, operation, source);
  const allowedScopes = requirement.anyOfScopes ?? [];
  const allowedRoles = requirement.anyOfRoles ?? [];
  const hasScope = allowedScopes.length > 0
    && allowedScopes.some((scope) => principal?.scopes?.includes(scope) ?? false);
  const hasRole = allowedRoles.length > 0
    && principal?.role !== undefined
    && allowedRoles.includes(principal.role);
  if ((allowedScopes.length > 0 || allowedRoles.length > 0) && !hasScope && !hasRole) {
    throw new FridayDomainError(
      ERROR_CODE_BOUND_PRINCIPAL_AUTHORITY_REQUIRED,
      `${operation} requires an authorized owner/admin/operator principal; the bound principal does not have the required authority.`,
      { httpStatus: 403 },
    );
  }
  return bound;
}

// Phase 14.5A WP-001 conversational parity (decision 8): the deterministic
// session-text approval dispatch path only carries a string actorId rather than
// a full principal. This helper closes the same gate on that path by refusing
// the synthetic-public actor id and the legacy "system" fallback. Callers must
// supply the upstream principalId; if it is missing, the operation fails closed.
export function assertBoundActorForSessionOperation(
  actorId: string | null | undefined,
  operation: FridayPublicMutationOperation,
): string {
  // Phase 18B CLAW-044: trim before validating so a whitespace-only actor id
  // (which is truthy in JavaScript) cannot pass the bound-principal gate or be
  // propagated downstream as an audit identity.
  const normalized = typeof actorId === "string" ? actorId.trim() : "";
  // SEC-SETUP-BOOTSTRAP-001 Slice 3: a device-owner actor id is refused here
  // exactly like the synthetic public actor while the server-derived
  // device-authority switch is off (always, today) — conversational dispatch
  // never grants owner authority from a disabled device identity.
  const isDisabledDeviceActor =
    isDeviceOwnerPrincipalId(normalized) && !isDeviceOwnerAuthorityEnabled();
  if (
    normalized.length === 0 ||
    normalized === FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID ||
    normalized === "system" ||
    isDisabledDeviceActor
  ) {
    throw new FridayDomainError(
      ERROR_CODE_BOUND_PRINCIPAL_REQUIRED,
      `${operation} requires a bound owner/session/channel actor; conversational dispatch refuses the synthetic public actor.`,
      { httpStatus: 401 },
    );
  }
  return normalized;
}

export interface FridayWorkflowWebhookGateInput {
  readonly pathToken: string;
  readonly hasSecretRef: boolean;
  readonly explicitBearerOnlyAllowlist?: ReadonlySet<string>;
}

export interface FridayWorkflowWebhookGateRejection {
  readonly statusCode: number;
  readonly errorCode: string;
  readonly reason: string;
}

export function readWorkflowWebhookBearerOnlyAllowlistFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> {
  const raw = env[BEARER_ONLY_OPT_IN_ENV];
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

export function evaluateWorkflowWebhookGate(
  input: FridayWorkflowWebhookGateInput,
): FridayWorkflowWebhookGateRejection | null {
  if (input.hasSecretRef) {
    // HMAC path is enforced by the signature validator downstream.
    return null;
  }
  const allowlist = input.explicitBearerOnlyAllowlist ?? new Set<string>();
  if (!allowlist.has(input.pathToken)) {
    return {
      statusCode: 401,
      errorCode: ERROR_CODE_WEBHOOK_HMAC_REQUIRED,
      reason: "Workflow webhook requires HMAC verification (webhookSecretRef) by default. Bearer path-token-only mode is opt-in per path token via " + BEARER_ONLY_OPT_IN_ENV + ".",
    };
  }
  if (input.pathToken.length < WEBHOOK_PATH_TOKEN_MIN_LENGTH) {
    return {
      statusCode: 401,
      errorCode: ERROR_CODE_WEBHOOK_PATH_TOKEN_WEAK,
      reason: "Bearer path-token mode requires a token of at least " + String(WEBHOOK_PATH_TOKEN_MIN_LENGTH) + " characters of entropy.",
    };
  }
  return null;
}

export const FRIDAY_WORKFLOW_WEBHOOK_PATH_TOKEN_MIN_LENGTH = WEBHOOK_PATH_TOKEN_MIN_LENGTH;

export function redactSensitiveWebhookHeaders<T extends Record<string, unknown>>(
  headers: T | null | undefined,
): Record<string, unknown> {
  if (!headers) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_PATTERNS.some((pattern) => pattern.test(key))) {
      result[key] = "[REDACTED]";
      continue;
    }
    result[key] = value;
  }
  return result;
}

export function redactWebhookPathTokenInPath(pathname: string): string {
  return pathname.replace(/(\/v1\/workflow-webhooks\/)([^/?#]+)/g, (_match, prefix) => `${prefix}***`);
}

export function describeWebhookReceiptTrust(opts: {
  readonly hadSecret: boolean;
  readonly bearerOnlyOptIn: boolean;
  readonly pathToken: string;
}): string {
  if (opts.hadSecret) {
    return "hmac-verified";
  }
  if (opts.bearerOnlyOptIn) {
    return "bearer-only-opt-in (no HMAC; URL-token treated as bearer credential)";
  }
  return "rejected (HMAC required by default for workflow webhook ingress)";
}

export const FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES = {
  BOUND_PRINCIPAL_REQUIRED: ERROR_CODE_BOUND_PRINCIPAL_REQUIRED,
  BOUND_PRINCIPAL_AUTHORITY_REQUIRED: ERROR_CODE_BOUND_PRINCIPAL_AUTHORITY_REQUIRED,
  WEBHOOK_HMAC_REQUIRED: ERROR_CODE_WEBHOOK_HMAC_REQUIRED,
  WEBHOOK_PATH_TOKEN_WEAK: ERROR_CODE_WEBHOOK_PATH_TOKEN_WEAK,
} as const;
