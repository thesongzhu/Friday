import { FridayDomainError } from "#errors";

import {
  FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID,
  FRIDAY_DEFAULT_PUBLIC_HTTP_TOKEN_ID,
  FRIDAY_DEFAULT_PUBLIC_HTTP_USER_ID,
} from "../api/http/friday-default-public-principal.js";
import type { FridayAuthPrincipal } from "../api/model/friday-api-auth.types.js";

// Phase 14.5A — module_28a owner/session/channel capability gate.
// Source-aware boundary above high-risk public mutating operations.
// Required gates here cannot be disabled by Light/Standard/Strict profile,
// automation budget, or user config; they fail closed by default and only
// open via an explicit per-resource opt-in that the operator configures.

export type FridayPublicMutationOperation =
  | "workflow.webhook.invoke"
  | "workflow.approval.approve"
  | "workflow.approval.reject"
  | "agent.plan.approve"
  | "agent.plan.reject"
  | "agent.tool.approve"
  | "agent.tool.reject"
  | "satellite.pairing.approve"
  | "satellite.pairing.reject"
  | "satellite.revoke"
  | "security.token.revoke"
  | "task.workflow.evidence.attach"
  | "task.workflow.claim.verify"
  | "task.workflow.claim.block"
  | "task.workflow.closeout"
  | "autofix.actions.run.ready"
  | "autofix.actions.approve"
  | "autofix.actions.deny"
  | "autofix.actions.execute"
  | "autofix.actions.rollback"
  | "autofix.actions.preview";

export type FridayBoundPrincipalSource = "api" | "session" | "channel" | "satellite";

const ERROR_CODE_BOUND_PRINCIPAL_REQUIRED = "OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED";
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

// Phase 14.5A WP-001 conversational parity (decision 8): the deterministic
// session-text approval dispatch path only carries a string actorId rather than
// a full principal. This helper closes the same gate on that path by refusing
// the synthetic-public actor id and the legacy "system" fallback. Callers must
// supply the upstream principalId; if it is missing, the operation fails closed.
export function assertBoundActorForSessionOperation(
  actorId: string | null | undefined,
  operation: FridayPublicMutationOperation,
): string {
  if (
    !actorId ||
    actorId === FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID ||
    actorId === "system"
  ) {
    throw new FridayDomainError(
      ERROR_CODE_BOUND_PRINCIPAL_REQUIRED,
      `${operation} requires a bound owner/session/channel actor; conversational dispatch refuses the synthetic public actor.`,
      { httpStatus: 401 },
    );
  }
  return actorId;
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
  WEBHOOK_HMAC_REQUIRED: ERROR_CODE_WEBHOOK_HMAC_REQUIRED,
  WEBHOOK_PATH_TOKEN_WEAK: ERROR_CODE_WEBHOOK_PATH_TOKEN_WEAK,
} as const;
