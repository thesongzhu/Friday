// Phase 14.5E module_28e Slice 6.4 — owner-signed approval + execute
// API for high-risk channel-triggered actions.
//
// `POST /v1/channels/actions/{actionId}/owner-approve` accepts an
// owner-signed token (built locally by the Assistant / API surface using
// the existing internal runtime secret) and records that the owner has
// approved the named channel action. `POST /v1/channels/actions/
// {actionId}/execute` then consumes that approval record and emits the
// outbound-channel closeout-receipt summary; the execute path refuses
// any call without a prior approval record. Both routes run on the
// `api`/`session` lane and the bound-principal contract refuses
// `source: "channel"` outright for the matching `channel.action.high_
// risk.{approve,execute}` operations.

import { FridayDomainError } from "#errors";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import {
  assertBoundPrincipalForOperation,
  type FridayBoundPrincipalSource,
} from "../../../security/friday-owner-session-channel-capability.js";
import {
  type FridayChannelActionApprovalPayload,
  signFridayChannelActionApprovalToken,
  verifyFridayChannelActionApprovalToken,
} from "../../../security/friday-channel-action-approval.js";
import {
  buildFridayChannelOutboundReceiptSummary,
  type FridayChannelOutboundReceiptSummary,
} from "../../../channels/services/friday-channel-outbound-receipt.js";

// Phase 14.5E module_28e Slice 6.4 — owner-link minting defaults. The
// mint route is bound-principal-authenticated and refuses `source:
// "channel"`; the token TTL is short by default so a leaked signed
// approval URL cannot drive a delayed-execute attack.
const OWNER_LINK_DEFAULT_TTL_SECONDS = 900;
const OWNER_LINK_MIN_TTL_SECONDS = 60;
const OWNER_LINK_MAX_TTL_SECONDS = 3600;

export interface FridayChannelActionApprovalRecord {
  readonly actionId: string;
  readonly channelId: string;
  readonly principalId: string;
  readonly approvedBy: string;
  readonly approvedSource: "api" | "session";
  readonly approvedAt: string;
  readonly tokenExpiresAt: string;
}

export interface FridayChannelActionApprovalStore {
  recordApproval(record: FridayChannelActionApprovalRecord): Promise<void> | void;
  hasApproval(actionId: string): Promise<boolean> | boolean;
  getApproval(actionId: string): Promise<FridayChannelActionApprovalRecord | null> | FridayChannelActionApprovalRecord | null;
  /**
   * Atomically read-and-remove the approval record so a single approval
   * cannot drive multiple `execute` calls. Returns `null` if no approval
   * is present. Callers MUST treat a `null` return as
   * `CHANNEL_HIGH_RISK_EXECUTE_NOT_APPROVED`. The owner-link contract is
   * single-use by design (see `friday-channel-action-approval.ts` header
   * line 31): each successful execute consumes the approval so a follow-up
   * execute must obtain a fresh owner-signed token.
   */
  consumeApproval(actionId: string): Promise<FridayChannelActionApprovalRecord | null> | FridayChannelActionApprovalRecord | null;
}

export interface FridayChannelActionRoutesDeps {
  /** Internal runtime signing key (typically the FRIDAY_TOKEN_SECRET). */
  readonly signingKey: string;
  /**
   * In-process approval ledger consulted by both the owner-approve route
   * (write) and the execute route (read). Defaults to an in-memory map.
   * Phase 14.5E scope explicitly accepts the in-process default: the
   * owner-signed token already carries its own expiry, the approval
   * window is short, and the Stage 2 matrix did not plan a v088 SQLite
   * migration for this slice. Callers wanting durability across runtime
   * restarts can pass their own store.
   */
  readonly approvalStore?: FridayChannelActionApprovalStore;
  /** Clock injection for tests. */
  readonly nowIso?: () => string;
}

interface OwnerApproveRequestBody {
  readonly ownerApprovalToken?: unknown;
  readonly channelId?: unknown;
}

interface OwnerApproveResponseBody {
  readonly actionId: string;
  readonly channelId: string;
  readonly principalId: string;
  readonly approvedAt: string;
  readonly tokenExpiresAt: string;
  readonly approvedSource: "api" | "session";
}

// Phase 14.5E module_28e Slice 6.4 — owner-link mint route shapes.
//
// The mint route's job is to turn a pending high-risk channel action into
// a one-click owner-approval URL form that the local Assistant / API
// surface delivers to the owner. The token itself is the bearer; it must
// never be written to channel text, logs, tests, reports, or artifacts.
// Channel inbound replies expose only the relative `ownerApprovalPath`
// (no token, no signed URL) — the Assistant fetches the signed material
// via this bound-principal route and surfaces the one-click "Approve"
// affordance to the owner.
interface OwnerLinkRequestBody {
  readonly channelId?: unknown;
  readonly ttlSeconds?: unknown;
}

interface OwnerLinkResponseBody {
  readonly actionId: string;
  readonly channelId: string;
  readonly principalId: string;
  readonly ownerApprovalToken: string;
  readonly ownerApprovalPath: string;
  readonly ownerApprovalUrl: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly issuedSource: "api" | "session";
}

interface ExecuteRequestBody {
  readonly channelId?: unknown;
  readonly messageId?: unknown;
}

interface ExecuteResponseBody {
  readonly actionId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly executedAt: string;
  readonly executedSource: "api" | "session";
  readonly approval: {
    readonly approvedBy: string;
    readonly approvedAt: string;
    readonly approvedSource: "api" | "session";
  };
  readonly receipt: FridayChannelOutboundReceiptSummary;
}

export function createInMemoryChannelActionApprovalStore(): FridayChannelActionApprovalStore {
  const store = new Map<string, FridayChannelActionApprovalRecord>();
  return {
    recordApproval(record) {
      store.set(record.actionId, record);
    },
    hasApproval(actionId) {
      return store.has(actionId);
    },
    getApproval(actionId) {
      return store.get(actionId) ?? null;
    },
    consumeApproval(actionId) {
      const record = store.get(actionId);
      if (!record) return null;
      store.delete(actionId);
      return record;
    },
  };
}

export function createFridayChannelActionRoutes(
  deps: FridayChannelActionRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  const approvalStore = deps.approvalStore ?? createInMemoryChannelActionApprovalStore();
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());

  return [
    // POST /v1/channels/actions/:actionId/owner-link
    //
    // Owner-link mint route. The local Assistant / API surface calls
    // this with the bound owner principal AND the pending action's
    // channelId; the route mints an HMAC-signed approval token and
    // returns the one-click owner-approval URL form the Assistant can
    // hand the owner. The token never travels through the channel
    // adapter outbound — channel reply text only carries the relative
    // `ownerApprovalPath`. `source: "channel"` is refused outright by
    // `assertBoundPrincipalForOperation`; an unauthenticated synthetic
    // principal is refused with 401. The route reuses the existing
    // `channel.action.high_risk.approve` operation because the same
    // bound-principal authority that approves is the authority that
    // mints the link.
    {
      operationId: "channels.actions.owner.link",
      method: "POST",
      path: "/v1/channels/actions/:actionId/owner-link",
      auth: { public: true },
      async handler(ctx): Promise<OwnerLinkResponseBody> {
        const source: FridayBoundPrincipalSource = resolveSource(ctx);
        const bound = assertBoundPrincipalForOperation(
          ctx.principal ?? null,
          "channel.action.high_risk.approve",
          source,
        );
        const { actionId } = ctx.params as { actionId?: string };
        if (typeof actionId !== "string" || actionId.trim().length === 0) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "actionId path parameter is required.",
            { httpStatus: 400 },
          );
        }
        const body = (ctx.body ?? {}) as OwnerLinkRequestBody;
        const channelId = typeof body.channelId === "string"
          ? body.channelId.trim()
          : "";
        if (channelId.length === 0) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "channelId is required.",
            { httpStatus: 400 },
          );
        }
        const ttlSeconds = clampOwnerLinkTtlSeconds(body.ttlSeconds);
        const issuedAt = nowIso();
        const issuedAtMs = Date.parse(issuedAt);
        if (!Number.isFinite(issuedAtMs)) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "Owner-link mint clock returned an invalid timestamp.",
            { httpStatus: 500 },
          );
        }
        const expiresAt = new Date(issuedAtMs + ttlSeconds * 1000).toISOString();
        const trimmedActionId = actionId.trim();
        const token = signFridayChannelActionApprovalToken({
          actionId: trimmedActionId,
          channelId,
          principalId: bound.principalId,
          riskLevel: "high",
          expiresAt,
          signingKey: deps.signingKey,
        });
        const ownerApprovalPath = `/v1/channels/actions/${encodeURIComponent(trimmedActionId)}/owner-approve`;
        return {
          actionId: trimmedActionId,
          channelId,
          principalId: bound.principalId,
          ownerApprovalToken: token,
          ownerApprovalPath,
          ownerApprovalUrl: ownerApprovalPath,
          issuedAt,
          expiresAt,
          issuedSource: source === "session" ? "session" : "api",
        };
      },
    },
    // POST /v1/channels/actions/:actionId/owner-approve
    {
      operationId: "channels.actions.owner.approve",
      method: "POST",
      path: "/v1/channels/actions/:actionId/owner-approve",
      // `auth: { public: true }` follows the same convention as
      // /v1/auto-fix/actions/*: the HTTP layer accepts the call, then the
      // bound-principal contract refuses any unauthenticated synthetic
      // principal AND any `source: "channel"` call. This route never
      // accepts `source: "channel"` per Slice 6.4.
      auth: { public: true },
      async handler(ctx): Promise<OwnerApproveResponseBody> {
        const source: FridayBoundPrincipalSource = resolveSource(ctx);
        const bound = assertBoundPrincipalForOperation(
          ctx.principal ?? null,
          "channel.action.high_risk.approve",
          source,
        );
        const { actionId } = ctx.params as { actionId?: string };
        if (typeof actionId !== "string" || actionId.trim().length === 0) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "actionId path parameter is required.",
            { httpStatus: 400 },
          );
        }
        const body = (ctx.body ?? {}) as OwnerApproveRequestBody;
        const token = typeof body.ownerApprovalToken === "string"
          ? body.ownerApprovalToken.trim()
          : "";
        const channelId = typeof body.channelId === "string"
          ? body.channelId.trim()
          : "";
        if (token.length === 0 || channelId.length === 0) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "ownerApprovalToken and channelId are required.",
            { httpStatus: 400 },
          );
        }
        const now = nowIso();
        const payload: FridayChannelActionApprovalPayload = verifyFridayChannelActionApprovalToken({
          token,
          actionId: actionId.trim(),
          channelId,
          principalId: bound.principalId,
          nowIso: now,
          signingKey: deps.signingKey,
        });
        const record: FridayChannelActionApprovalRecord = {
          actionId: payload.actionId,
          channelId: payload.channelId,
          principalId: payload.principalId,
          approvedBy: bound.userId ?? bound.principalId,
          approvedSource: source === "session" ? "session" : "api",
          approvedAt: now,
          tokenExpiresAt: payload.expiresAt,
        };
        await approvalStore.recordApproval(record);
        return {
          actionId: record.actionId,
          channelId: record.channelId,
          principalId: record.principalId,
          approvedAt: record.approvedAt,
          tokenExpiresAt: record.tokenExpiresAt,
          approvedSource: record.approvedSource,
        };
      },
    },
    // POST /v1/channels/actions/:actionId/execute
    //
    // Consumes the approval record written by the owner-approve route
    // above and emits the deterministic outbound-channel closeout
    // receipt summary (rollbackClass = "non_reversible_external" via the
    // Phase 14.5D `FRIDAY_TASK_WORKFLOW_ROLLBACK_CLASS_BY_REF_SOURCE`
    // registry). The execute path is fail-closed: missing prior approval
    // → 403; `source: "channel"` → 403; synthetic public principal →
    // 401.
    {
      operationId: "channels.actions.execute",
      method: "POST",
      path: "/v1/channels/actions/:actionId/execute",
      auth: { public: true },
      async handler(ctx): Promise<ExecuteResponseBody> {
        const source: FridayBoundPrincipalSource = resolveSource(ctx);
        const bound = assertBoundPrincipalForOperation(
          ctx.principal ?? null,
          "channel.action.high_risk.execute",
          source,
        );
        const { actionId } = ctx.params as { actionId?: string };
        if (typeof actionId !== "string" || actionId.trim().length === 0) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "actionId path parameter is required.",
            { httpStatus: 400 },
          );
        }
        const body = (ctx.body ?? {}) as ExecuteRequestBody;
        const channelId = typeof body.channelId === "string"
          ? body.channelId.trim()
          : "";
        const messageId = typeof body.messageId === "string"
          ? body.messageId.trim()
          : "";
        if (channelId.length === 0 || messageId.length === 0) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "channelId and messageId are required.",
            { httpStatus: 400 },
          );
        }
        const trimmedActionId = actionId.trim();
        const approval = await approvalStore.getApproval(trimmedActionId);
        if (!approval) {
          throw new FridayDomainError(
            "CHANNEL_HIGH_RISK_EXECUTE_NOT_APPROVED",
            "Execute requires a prior owner-signed approval for this actionId.",
            { httpStatus: 403 },
          );
        }
        if (approval.channelId !== channelId) {
          throw new FridayDomainError(
            "CHANNEL_HIGH_RISK_EXECUTE_CHANNEL_MISMATCH",
            "Execute channelId does not match the approval record.",
            { httpStatus: 403 },
          );
        }
        if (approval.principalId !== bound.principalId) {
          throw new FridayDomainError(
            "CHANNEL_HIGH_RISK_EXECUTE_PRINCIPAL_MISMATCH",
            "Execute principal does not match the approval record.",
            { httpStatus: 403 },
          );
        }
        const separatorIndex = channelId.indexOf(":");
        if (separatorIndex <= 0 || separatorIndex >= channelId.length - 1) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "channelId must be `<channelKind>:<chatId>`.",
            { httpStatus: 400 },
          );
        }
        const channelKind = channelId.slice(0, separatorIndex);
        const chatId = channelId.slice(separatorIndex + 1);
        // Atomic read-and-remove: fail-closed single-use of the owner
        // approval. Validation above has confirmed source/channel/principal
        // parity against the still-present record; consuming here matches
        // the "single-use at the API layer" contract documented in
        // `friday-channel-action-approval.ts` (line 31). A concurrent
        // executor that lost the race sees `null` and is rejected with
        // CHANNEL_HIGH_RISK_EXECUTE_NOT_APPROVED — the owner must mint a
        // fresh token to authorize another execute.
        const consumed = await approvalStore.consumeApproval(trimmedActionId);
        if (!consumed) {
          throw new FridayDomainError(
            "CHANNEL_HIGH_RISK_EXECUTE_NOT_APPROVED",
            "Execute requires a prior owner-signed approval for this actionId.",
            { httpStatus: 403 },
          );
        }
        const receipt = buildFridayChannelOutboundReceiptSummary({
          channelKind,
          chatId,
          messageId,
        });
        const executedAt = nowIso();
        return {
          actionId: trimmedActionId,
          channelId,
          messageId,
          executedAt,
          executedSource: source === "session" ? "session" : "api",
          approval: {
            approvedBy: approval.approvedBy,
            approvedAt: approval.approvedAt,
            approvedSource: approval.approvedSource,
          },
          receipt,
        };
      },
    },
  ];
}

function resolveSource(ctx: { headers?: Record<string, string | undefined> }): FridayBoundPrincipalSource {
  const headers = ctx.headers ?? {};
  const raw = headers["x-friday-principal-source"];
  const normalized = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (normalized === "session") return "session";
  // Default to "api" — never "channel". Channel-sourced calls must not
  // implicitly downgrade their source classification to reach this gate.
  if (normalized === "channel") return "channel";
  return "api";
}

function clampOwnerLinkTtlSeconds(raw: unknown): number {
  if (raw === undefined || raw === null) {
    return OWNER_LINK_DEFAULT_TTL_SECONDS;
  }
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "ttlSeconds must be a finite number when supplied.",
      { httpStatus: 400 },
    );
  }
  const truncated = Math.trunc(value);
  if (truncated < OWNER_LINK_MIN_TTL_SECONDS) {
    return OWNER_LINK_MIN_TTL_SECONDS;
  }
  if (truncated > OWNER_LINK_MAX_TTL_SECONDS) {
    return OWNER_LINK_MAX_TTL_SECONDS;
  }
  return truncated;
}
