/**
 * Phase 14.5E module_28e Slice 6.8 — channel setup and live-proof
 * acceptance test.
 *
 * Drives the real route handlers from the same factory functions wired
 * by `createFridayApiRuntime` and the real Friday task-workflow service
 * (no mocks of `createFridayTaskWorkflowService`, its repository,
 * `routeFridayChannelDispatch`, `assertBoundPrincipalForOperation`,
 * `verifyFridayChannelActionApprovalToken`, or
 * `buildFridayChannelOutboundReceiptSummary`). The test:
 *
 *   (1) hits `GET /v1/setup/channels/status` (via the route handler from
 *       `createFridaySetupRoutes`) under three env states — no env,
 *       Discord-only env, all-three env — and asserts that every v1
 *       channel (Discord / Lark / Telegram) carries its own honest
 *       per-channel proof label and that Discord credentials never
 *       silently satisfy Lark or Telegram;
 *   (2) drives `routeFridayChannelDispatch` end-to-end on an inbound
 *       channel message that resolves to a high-risk canonical command
 *       and asserts the dispatcher emits an `owner_link_required`
 *       outcome (never an in-channel confirmation);
 *   (3) signs an owner-approval token with the runtime secret, hits
 *       `POST /v1/channels/actions/{actionId}/owner-approve` and asserts
 *       the approval record is captured;
 *   (4) hits `POST /v1/channels/actions/{actionId}/execute` and asserts
 *       the response carries `rollbackClass = "non_reversible_external"`
 *       and `evidenceRefSource = "channel_event"`;
 *   (5) drives the real task-workflow service with a `channel_event`
 *       evidence ref and asserts the closeout receipt has
 *       `rollbackClass = "non_reversible_external"`, the
 *       `rollback_class_disclosure_required` gate passes, and
 *       `evidenceDurability` is populated.
 *
 * Mirrors Stage 2 Slice 6.8 of
 * `PHASE_14_5E_STAGE_2_SCOPE_RECONCILIATION_MATRIX_2026-05-17.md`.
 */

import { describe, expect, it } from "vitest";

import {
  createFridayTaskWorkflowRepository,
  createFridayTaskWorkflowService,
} from "../../../src/task-workflows/index.js";
import {
  createFridayChannelActionRoutes,
  createInMemoryChannelActionApprovalStore,
} from "../../../src/api/http/routes/friday-channel-action-routes.js";
import { createFridaySetupRoutes } from "../../../src/api/http/routes/friday-setup-routes.js";
import {
  buildFridayChannelSetupStatus,
  routeFridayChannelDispatch,
  type FridayChannelRegistryView,
  type FridayChannelSetupStatusResponse,
} from "#channels";
import {
  signFridayChannelActionApprovalToken,
  verifyFridayChannelActionApprovalToken,
} from "../../../src/security/friday-channel-action-approval.js";
import { FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES } from "../../../src/security/friday-owner-session-channel-capability.js";
import type { FridayAuthPrincipal } from "../../../src/api/model/friday-api-auth.types.js";

import {
  createTestDb,
  createTestIdGenerator,
} from "../../helpers/friday-test-db.helper.js";

const NOW = "2026-05-17T08:30:00.000Z";
const SIGNING_KEY = "phase-14-5e-acceptance-signing-key";

function realPrincipal(): FridayAuthPrincipal {
  return {
    principalType: "user",
    principalId: "user-acceptance-1",
    tenantId: "tenant-acceptance-1",
    userId: "33333333-3333-3333-3333-333333333333",
    role: "admin",
    scopes: ["agent.write"],
    tokenId: "44444444-4444-4444-4444-444444444444",
    tokenKind: "access",
    issuedAt: NOW,
  };
}

function buildCtx(input: {
  actionId: string;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  principal?: FridayAuthPrincipal;
}) {
  return {
    params: { actionId: input.actionId },
    query: {},
    body: input.body,
    headers: input.headers ?? {},
    principal: input.principal ?? realPrincipal(),
    requestId: "req-acceptance-1",
    receivedAt: NOW,
  };
}

function getStatusRoute(views: readonly FridayChannelRegistryView[]) {
  // Construct the real setup routes factory and pull the
  // `setup.channels.status` route handler. The factory only touches db /
  // providerService / skillRegistry inside other route handlers; the
  // status route handler is a pure projection over
  // `listChannelRegistryViews` and `process.env`. We pass minimal stubs
  // for the unused deps so the factory still compiles.
  const db = createTestDb();
  try {
    const routes = createFridaySetupRoutes({
      db,
      providerService: {} as never,
      skillRegistry: {} as never,
      nowIso: () => NOW,
      runningHost: "127.0.0.1",
      runningPort: 3141,
      listChannelRegistryViews: () => views,
    });
    const route = routes.find((r) => r.operationId === "setup.channels.status");
    if (!route) throw new Error("setup.channels.status route not found");
    return { route, db };
  } catch (err) {
    db.close();
    throw err;
  }
}

async function callStatusRoute(
  views: readonly FridayChannelRegistryView[],
  processEnv: NodeJS.ProcessEnv,
): Promise<FridayChannelSetupStatusResponse> {
  // Capture the active env, swap to the requested env for the route
  // call, then restore. The status handler reads from `process.env` via
  // the helper. Acceptance-level intent: same payload the wizard would
  // observe via HTTP.
  const previous = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      delete (process.env as Record<string, string | undefined>)[key];
    }
    for (const [key, value] of Object.entries(processEnv)) {
      if (typeof value === "string") {
        (process.env as Record<string, string>)[key] = value;
      }
    }
    const { route, db } = getStatusRoute(views);
    try {
      // The route handler ignores params/query/body; pass empty shells.
      const response = (await route.handler({
        params: {},
        query: {},
        body: {},
        headers: {},
        principal: null,
        requestId: "req-status",
        receivedAt: NOW,
      } as never)) as FridayChannelSetupStatusResponse;
      return response;
    } finally {
      db.close();
    }
  } finally {
    for (const key of Object.keys(process.env)) {
      delete (process.env as Record<string, string | undefined>)[key];
    }
    for (const [key, value] of Object.entries(previous)) {
      if (typeof value === "string") {
        (process.env as Record<string, string>)[key] = value;
      }
    }
  }
}

describe("Phase 14.5E module_28e Slice 6.8: channel setup + live-proof acceptance", () => {
  describe("GET /v1/setup/channels/status (real route handler) — three env states", () => {
    it("(a) no env — every v1 channel reports `not_configured`; no Discord stand-in", async () => {
      const response = await callStatusRoute([], {});
      expect(response.channels.map((row) => row.kind)).toEqual([
        "discord",
        "lark",
        "telegram",
      ]);
      for (const row of response.channels) {
        expect(row.proofLabel).toBe("not_configured");
        expect(row.missingEnvVars.length).toBeGreaterThan(0);
      }
      // Compare against the helper directly to anchor the route+helper
      // contract: the projection produced by the route must equal the
      // projection produced by the helper for the same inputs.
      expect(response).toEqual(buildFridayChannelSetupStatus({ views: [], processEnv: {} }));
    });

    it("(b) Discord-only env — Discord is `configured`; Lark + Telegram remain `not_configured`", async () => {
      const env: NodeJS.ProcessEnv = {
        FRIDAY_DISCORD_BOT_TOKEN: "discord-token",
        FRIDAY_DISCORD_SETUP_USER_ID: "owner",
        FRIDAY_DISCORD_GUILD_ID: "guild",
        FRIDAY_DISCORD_CHANNEL_ID: "channel",
      };
      const response = await callStatusRoute([], env);
      const discord = response.channels.find((row) => row.kind === "discord");
      const lark = response.channels.find((row) => row.kind === "lark");
      const telegram = response.channels.find((row) => row.kind === "telegram");
      expect(discord?.proofLabel).toBe("configured");
      expect(discord?.missingEnvVars).toEqual([]);
      expect(lark?.proofLabel).toBe("not_configured");
      expect(lark?.missingEnvVars.length).toBeGreaterThan(0);
      expect(telegram?.proofLabel).toBe("not_configured");
      expect(telegram?.missingEnvVars.length).toBeGreaterThan(0);
    });

    it("(c) all-three env stubbed — every v1 channel reports `configured` honestly", async () => {
      const env: NodeJS.ProcessEnv = {
        FRIDAY_DISCORD_BOT_TOKEN: "discord-token",
        FRIDAY_DISCORD_SETUP_USER_ID: "owner",
        FRIDAY_DISCORD_GUILD_ID: "guild",
        FRIDAY_DISCORD_CHANNEL_ID: "channel",
        FRIDAY_LARK_APP_ID: "lark-app",
        FRIDAY_LARK_APP_SECRET: "lark-secret",
        FRIDAY_LARK_VERIFICATION_TOKEN: "lark-verify",
        FRIDAY_LARK_ENCRYPT_KEY: "lark-encrypt",
        FRIDAY_LARK_TEST_CHAT_ID: "lark-chat",
        FRIDAY_TELEGRAM_BOT_TOKEN: "telegram-token",
        FRIDAY_TELEGRAM_TEST_CHAT_ID: "telegram-chat",
      };
      const response = await callStatusRoute([], env);
      for (const row of response.channels) {
        expect(row.proofLabel).toBe("configured");
        expect(row.missingEnvVars).toEqual([]);
      }
    });
  });

  describe("canonical command ladder: preview → owner-link → execute → receipt", () => {
    it("drives the full high-risk ladder against real route handlers", async () => {
      // (2) Channel inbound message → routeFridayChannelDispatch — high
      // risk verb → owner_link_required.
      const dispatch = routeFridayChannelDispatch({
        channelKind: "discord",
        chatId: "chat-acceptance-1",
        chatType: "group",
        senderId: "user-acceptance-1",
        text: "apply repair",
      });
      expect(dispatch.kind).toBe("owner_link_required");
      if (dispatch.kind !== "owner_link_required") {
        throw new Error("expected owner_link_required outcome");
      }
      const actionId = dispatch.request.actionId;
      const channelId = `${dispatch.request.channelKind}:${dispatch.request.chatId}`;
      expect(dispatch.request.ownerLinkPath).toBe(
        `/v1/channels/actions/${encodeURIComponent(actionId)}/owner-approve`,
      );

      // Build the channel-action routes (shared in-memory approval store
      // across owner-link mint + approve + execute). This mirrors the
      // wiring inside `createFridayApiRuntime`.
      const approvalStore = createInMemoryChannelActionApprovalStore();
      const routes = createFridayChannelActionRoutes({
        signingKey: SIGNING_KEY,
        approvalStore,
        nowIso: () => NOW,
      });
      const linkRoute = routes.find(
        (r) => r.operationId === "channels.actions.owner.link",
      );
      const approveRoute = routes.find(
        (r) => r.operationId === "channels.actions.owner.approve",
      );
      const executeRoute = routes.find(
        (r) => r.operationId === "channels.actions.execute",
      );
      if (!linkRoute || !approveRoute || !executeRoute) {
        throw new Error("channel-action routes not found");
      }

      // (2b) Owner-link mint route refuses `source: "channel"`: the
      // signed token is never delivered to a channel-sourced caller,
      // preserving the rule that channel text never carries bearer
      // credentials. The owner mints the link via api/session lane
      // only.
      let refusedLinkMintFromChannel: unknown;
      try {
        await linkRoute.handler(buildCtx({
          actionId,
          body: { channelId },
          headers: { "x-friday-principal-source": "channel" },
        }));
      } catch (err) {
        refusedLinkMintFromChannel = err;
      }
      expect(refusedLinkMintFromChannel).toBeDefined();
      expect((refusedLinkMintFromChannel as { code?: string }).code).toBe(
        FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES.CHANNEL_HIGH_RISK_SOURCE_REFUSED,
      );

      // (2c) Owner-link mint route on api lane returns the one-click
      // owner approval URL form plus the signed token. The token is
      // delivered alongside (not inside) the URL — the Assistant POSTs
      // the token back to the approve route. The path the channel
      // already advertised in (2) matches the path the mint route
      // returns.
      const mintedLink = (await linkRoute.handler(buildCtx({
        actionId,
        body: { channelId, ttlSeconds: 600 },
      }))) as {
        actionId: string;
        channelId: string;
        principalId: string;
        ownerApprovalToken: string;
        ownerApprovalPath: string;
        ownerApprovalUrl: string;
        issuedAt: string;
        expiresAt: string;
        issuedSource: string;
      };
      expect(mintedLink.actionId).toBe(actionId);
      expect(mintedLink.channelId).toBe(channelId);
      expect(mintedLink.issuedSource).toBe("api");
      expect(mintedLink.principalId).toBe(realPrincipal().principalId);
      expect(mintedLink.ownerApprovalPath).toBe(dispatch.request.ownerLinkPath);
      // Hard rule: the signed token is not embedded in the path or URL
      // returned to the owner; it travels in a separate field that the
      // Assistant uses for POST. This is what makes it safe for the
      // channel adapter to surface the path text without leaking
      // bearer material.
      expect(mintedLink.ownerApprovalPath).not.toContain(
        mintedLink.ownerApprovalToken,
      );
      expect(mintedLink.ownerApprovalUrl).not.toContain(
        mintedLink.ownerApprovalToken,
      );
      // Token verifies against the runtime signing key with the same
      // context the approve route enforces.
      const verifiedPayload = verifyFridayChannelActionApprovalToken({
        token: mintedLink.ownerApprovalToken,
        actionId,
        channelId,
        principalId: realPrincipal().principalId,
        nowIso: NOW,
        signingKey: SIGNING_KEY,
      });
      expect(verifiedPayload.expiresAt).toBe(mintedLink.expiresAt);

      // (a) channel-sourced approve must be refused even with a valid
      // token — the bound-principal contract refuses `source: "channel"`
      // for the high-risk approve operation.
      const channelToken = signFridayChannelActionApprovalToken({
        actionId,
        channelId,
        principalId: realPrincipal().principalId,
        riskLevel: "high",
        expiresAt: "2099-01-01T00:00:00.000Z",
        signingKey: SIGNING_KEY,
      });
      let refusedFromChannel: unknown;
      try {
        await approveRoute.handler(buildCtx({
          actionId,
          body: { ownerApprovalToken: channelToken, channelId },
          headers: { "x-friday-principal-source": "channel" },
        }));
      } catch (err) {
        refusedFromChannel = err;
      }
      expect(refusedFromChannel).toBeDefined();
      expect((refusedFromChannel as { code?: string }).code).toBe(
        FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES.CHANNEL_HIGH_RISK_SOURCE_REFUSED,
      );

      // (3) `source: "api"` + the minted owner-link token records the
      // approval. This closes the production user-visible loop: the
      // mint route is the only place the runtime signed-token minter
      // is exercised end-to-end with a bound principal, and the
      // approve route consumes exactly that minted token.
      const approveResponse = (await approveRoute.handler(buildCtx({
        actionId,
        body: {
          ownerApprovalToken: mintedLink.ownerApprovalToken,
          channelId,
        },
      }))) as { actionId: string; approvedSource: string };
      expect(approveResponse.actionId).toBe(actionId);
      expect(approveResponse.approvedSource).toBe("api");
      const storedApproval = await approvalStore.getApproval(actionId);
      expect(storedApproval?.principalId).toBe(realPrincipal().principalId);

      // (4) Execute consumes the approval and returns a
      // `non_reversible_external` receipt. Channel-sourced execute is
      // refused outright by the bound-principal contract.
      let refusedExecuteFromChannel: unknown;
      try {
        await executeRoute.handler(buildCtx({
          actionId,
          body: { channelId, messageId: "msg-acceptance-1" },
          headers: { "x-friday-principal-source": "channel" },
        }));
      } catch (err) {
        refusedExecuteFromChannel = err;
      }
      expect(refusedExecuteFromChannel).toBeDefined();
      expect((refusedExecuteFromChannel as { code?: string }).code).toBe(
        FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES.CHANNEL_HIGH_RISK_SOURCE_REFUSED,
      );

      const executeResponse = (await executeRoute.handler(buildCtx({
        actionId,
        body: { channelId, messageId: "msg-acceptance-1" },
      }))) as {
        actionId: string;
        receipt: {
          rollbackClass: string;
          evidenceRefSource: string;
          nonReversibleReason: string;
        };
        approval: { approvedBy: string };
      };
      expect(executeResponse.actionId).toBe(actionId);
      expect(executeResponse.receipt.rollbackClass).toBe("non_reversible_external");
      expect(executeResponse.receipt.evidenceRefSource).toBe("channel_event");
      expect(executeResponse.receipt.nonReversibleReason).toContain(channelId);
      expect(executeResponse.approval.approvedBy).toBe(
        realPrincipal().userId,
      );

      // (4c) Single-use guarantee: the successful execute above must
      // have consumed the approval record, so a second execute against
      // the same actionId/store is refused. The owner must mint a fresh
      // owner-signed token to authorize another execute.
      expect(await approvalStore.getApproval(actionId)).toBeNull();
      let refusedRepeatExecute: unknown;
      try {
        await executeRoute.handler(buildCtx({
          actionId,
          body: { channelId, messageId: "msg-acceptance-1b" },
        }));
      } catch (err) {
        refusedRepeatExecute = err;
      }
      expect(refusedRepeatExecute).toBeDefined();
      expect((refusedRepeatExecute as { code?: string }).code).toBe(
        "CHANNEL_HIGH_RISK_EXECUTE_NOT_APPROVED",
      );

      // (4b) Execute without a prior approval is refused. A new store
      // for a fresh action id models the post-restart / never-approved
      // scenario at the boundary of the in-memory ledger.
      const freshStore = createInMemoryChannelActionApprovalStore();
      const freshRoutes = createFridayChannelActionRoutes({
        signingKey: SIGNING_KEY,
        approvalStore: freshStore,
        nowIso: () => NOW,
      });
      const freshExecute = freshRoutes.find(
        (r) => r.operationId === "channels.actions.execute",
      )!;
      let refusedMissingApproval: unknown;
      try {
        await freshExecute.handler(buildCtx({
          actionId,
          body: { channelId, messageId: "msg-acceptance-2" },
        }));
      } catch (err) {
        refusedMissingApproval = err;
      }
      expect(refusedMissingApproval).toBeDefined();
      expect((refusedMissingApproval as { code?: string }).code).toBe(
        "CHANNEL_HIGH_RISK_EXECUTE_NOT_APPROVED",
      );
    });
  });

  describe("channel-triggered closeout receipt drives the Phase 14.5C/D fields", () => {
    it("(5) channel_event evidence ref → non_reversible_external + rollback_class_disclosure_required passes + evidenceDurability populated", () => {
      const db = createTestDb();
      const repository = createFridayTaskWorkflowRepository();
      const idGen = createTestIdGenerator();
      const service = createFridayTaskWorkflowService({
        db,
        repository,
        idGenerator: idGen,
        nowIso: () => NOW,
        getWorkflowRunEvidenceStatus: () => "available",
      });
      try {
        const tw = service.create({
          charter: "Phase 14.5E acceptance — channel outbound closeout",
          taskKind: "general",
          contextPackage: {
            allowedFiles: ["src/x.ts"],
            allowedTools: [],
            allowedApis: [],
            boundaryIds: [
              "api.task_workflows.core",
              "evidence.refs.channel_event",
            ],
          },
        });
        const claim = service.draftClaim(tw.id, {
          claimText: "outbound channel send acknowledged",
          claimKind: "runtime_evidence",
        });
        // Attach a compatible evidence ref so verifyClaim succeeds via the
        // service. The channel_event ref source is not directly attachable
        // to runtime_evidence claims (Phase 13.5A compatibility policy), so
        // we model the closeout-time disclosure surface by planting the
        // channel_event ref through the repository after verification —
        // exactly the pattern the Phase 14.5D acceptance test uses for
        // manual_external refs.
        service.attachEvidenceRef(tw.id, claim.id, {
          refKind: "agent_run.event",
          refId: "agent-evt-channel-pre",
          refSource: "agent_run_event",
        });
        service.verifyClaim(tw.id, claim.id, {
          verifierVerdict: "fresh-read pre-channel evidence",
        });
        db.withWriteTransaction((conn) => {
          repository.insertEvidenceRef(conn, {
            id: "plant-channel-evt-acceptance-1",
            workflowId: tw.id,
            claimId: claim.id,
            refKind: "channel.event",
            refId: "channel-evt-acceptance-1",
            refHash: null,
            refSource: "channel_event",
            createdAt: NOW,
          });
          repository.incrementEvidenceRefCount(conn, claim.id, NOW);
        });
        const receipt = service.closeout(tw.id);
        expect(receipt.rollbackClass).toBe("non_reversible_external");
        expect(receipt.nonReversibleReason).toBeTruthy();
        expect(receipt.compensatingAction).toBeNull();
        // Phase 14.5C: evidenceDurability is populated on the receipt and
        // proofClaimable is a deterministic boolean.
        expect(typeof receipt.evidenceDurability).toBe("string");
        expect(["available", "degraded", "unavailable"]).toContain(
          receipt.evidenceDurability,
        );
        expect(typeof receipt.proofClaimable).toBe("boolean");
        // Phase 14.5D: rollback_class_disclosure_required gate passes.
        const rollbackGate = receipt.gateOutcomes.find(
          (g) => g.gateId === "rollback_class_disclosure_required",
        );
        expect(rollbackGate?.status).toBe("pass");
        // Phase 14.5C: workflow_run_evidence_durable gate is present and
        // not regressed by the 14.5E receipt path.
        const evidenceGate = receipt.gateOutcomes.find(
          (g) => g.gateId === "workflow_run_evidence_durable",
        );
        expect(evidenceGate?.status).toBe("pass");
      } finally {
        db.close();
      }
    });
  });
});
