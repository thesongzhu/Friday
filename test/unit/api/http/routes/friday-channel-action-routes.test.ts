// Phase 14.5E module_28e Slice 6.4/6.8 — focused route handler tests for
// POST /v1/channels/actions/:actionId/owner-approve.
//
// The route is invoked directly through its handler so the test does not
// need to boot a full HTTP server. We assert:
//   - the route refuses `source: "channel"`;
//   - the route accepts `source: "api"` with a valid token;
//   - the route refuses an expired token;
//   - the route records an approval the store can later look up.

import { describe, expect, it } from "vitest";

import {
  createFridayChannelActionRoutes,
  createInMemoryChannelActionApprovalStore,
} from "../../../../../src/api/http/routes/friday-channel-action-routes.js";
import {
  signFridayChannelActionApprovalToken,
  verifyFridayChannelActionApprovalToken,
} from "../../../../../src/security/friday-channel-action-approval.js";
import { FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES } from "../../../../../src/security/friday-owner-session-channel-capability.js";
import { createFridayDefaultPublicHttpPrincipal } from "../../../../../src/api/http/friday-default-public-principal.js";
import type { FridayAuthPrincipal } from "../../../../../src/api/model/friday-api-auth.types.js";

const SIGNING_KEY = "phase-14-5e-owner-link-key";

function realPrincipal(overrides: Partial<FridayAuthPrincipal> = {}): FridayAuthPrincipal {
  return {
    principalType: "user",
    principalId: "user-real-1",
    tenantId: "tenant-1",
    userId: "11111111-1111-1111-1111-111111111111",
    role: "admin",
    scopes: ["agent.write"],
    tokenId: "22222222-2222-2222-2222-222222222222",
    tokenKind: "access",
    issuedAt: "2026-05-17T00:00:00.000Z",
    ...overrides,
  };
}

function buildCtx(input: {
  actionId: string;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  principal?: FridayAuthPrincipal | null;
}) {
  return {
    params: { actionId: input.actionId },
    query: {},
    body: input.body,
    headers: input.headers ?? {},
    principal: input.principal ?? realPrincipal(),
    requestId: "req-1",
  };
}

function getRouteHandler() {
  const approvalStore = createInMemoryChannelActionApprovalStore();
  const routes = createFridayChannelActionRoutes({
    signingKey: SIGNING_KEY,
    approvalStore,
    nowIso: () => "2026-05-17T00:00:00.000Z",
  });
  const route = routes.find((r) => r.path === "/v1/channels/actions/:actionId/owner-approve");
  if (!route) throw new Error("route not found");
  return { route, approvalStore };
}

function getOwnerLinkHandler() {
  const approvalStore = createInMemoryChannelActionApprovalStore();
  const routes = createFridayChannelActionRoutes({
    signingKey: SIGNING_KEY,
    approvalStore,
    nowIso: () => "2026-05-17T00:00:00.000Z",
  });
  const linkRoute = routes.find(
    (r) => r.path === "/v1/channels/actions/:actionId/owner-link",
  );
  const approveRoute = routes.find(
    (r) => r.path === "/v1/channels/actions/:actionId/owner-approve",
  );
  if (!linkRoute) throw new Error("owner-link route not found");
  if (!approveRoute) throw new Error("owner-approve route not found");
  return { linkRoute, approveRoute, approvalStore };
}

function getApproveAndExecuteHandlers() {
  const approvalStore = createInMemoryChannelActionApprovalStore();
  const routes = createFridayChannelActionRoutes({
    signingKey: SIGNING_KEY,
    approvalStore,
    nowIso: () => "2026-05-17T00:00:00.000Z",
  });
  const approveRoute = routes.find(
    (r) => r.path === "/v1/channels/actions/:actionId/owner-approve",
  );
  const executeRoute = routes.find(
    (r) => r.path === "/v1/channels/actions/:actionId/execute",
  );
  if (!approveRoute) throw new Error("approve route not found");
  if (!executeRoute) throw new Error("execute route not found");
  return { approveRoute, executeRoute, approvalStore };
}

describe("POST /v1/channels/actions/:actionId/owner-approve", () => {
  it("refuses source: \"channel\"", async () => {
    const { route } = getRouteHandler();
    const token = signFridayChannelActionApprovalToken({
      actionId: "act-1",
      channelId: "discord:chat-1",
      principalId: "user-real-1",
      riskLevel: "high",
      expiresAt: "2099-01-01T00:00:00.000Z",
      signingKey: SIGNING_KEY,
    });
    let thrown: unknown;
    try {
      await route.handler(buildCtx({
        actionId: "act-1",
        body: { ownerApprovalToken: token, channelId: "discord:chat-1" },
        headers: { "x-friday-principal-source": "channel" },
      }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe(
      FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES.CHANNEL_HIGH_RISK_SOURCE_REFUSED,
    );
  });

  it("refuses unauthenticated synthetic principal", async () => {
    const { route } = getRouteHandler();
    const token = signFridayChannelActionApprovalToken({
      actionId: "act-1",
      channelId: "discord:chat-1",
      principalId: "user-real-1",
      riskLevel: "high",
      expiresAt: "2099-01-01T00:00:00.000Z",
      signingKey: SIGNING_KEY,
    });
    let thrown: unknown;
    try {
      await route.handler(buildCtx({
        actionId: "act-1",
        body: { ownerApprovalToken: token, channelId: "discord:chat-1" },
        principal: createFridayDefaultPublicHttpPrincipal(),
      }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe(
      FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES.BOUND_PRINCIPAL_REQUIRED,
    );
  });

  it("accepts source: \"api\" with a valid owner-signed token and records the approval", async () => {
    const { route, approvalStore } = getRouteHandler();
    const token = signFridayChannelActionApprovalToken({
      actionId: "act-1",
      channelId: "discord:chat-1",
      principalId: "user-real-1",
      riskLevel: "high",
      expiresAt: "2099-01-01T00:00:00.000Z",
      signingKey: SIGNING_KEY,
    });
    const response = await route.handler(buildCtx({
      actionId: "act-1",
      body: { ownerApprovalToken: token, channelId: "discord:chat-1" },
    }));
    expect((response as { actionId: string }).actionId).toBe("act-1");
    expect((response as { approvedSource: string }).approvedSource).toBe("api");
    const stored = await approvalStore.getApproval("act-1");
    expect(stored?.actionId).toBe("act-1");
    expect(stored?.approvedBy).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("refuses tokens whose actionId does not match the path", async () => {
    const { route } = getRouteHandler();
    const token = signFridayChannelActionApprovalToken({
      actionId: "act-other",
      channelId: "discord:chat-1",
      principalId: "user-real-1",
      riskLevel: "high",
      expiresAt: "2099-01-01T00:00:00.000Z",
      signingKey: SIGNING_KEY,
    });
    let thrown: unknown;
    try {
      await route.handler(buildCtx({
        actionId: "act-1",
        body: { ownerApprovalToken: token, channelId: "discord:chat-1" },
      }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe(
      "CHANNEL_OWNER_APPROVAL_TOKEN_CONTEXT_MISMATCH",
    );
  });

  it("rejects malformed bodies", async () => {
    const { route } = getRouteHandler();
    let thrown: unknown;
    try {
      await route.handler(buildCtx({
        actionId: "act-1",
        body: {},
      }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /v1/channels/actions/:actionId/execute", () => {
  it("refuses execute without a prior approval record", async () => {
    const { executeRoute } = getApproveAndExecuteHandlers();
    let thrown: unknown;
    try {
      await executeRoute.handler(buildCtx({
        actionId: "act-1",
        body: { channelId: "discord:chat-1", messageId: "msg-1" },
      }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe(
      "CHANNEL_HIGH_RISK_EXECUTE_NOT_APPROVED",
    );
  });

  it("refuses execute from source: \"channel\"", async () => {
    const { executeRoute } = getApproveAndExecuteHandlers();
    let thrown: unknown;
    try {
      await executeRoute.handler(buildCtx({
        actionId: "act-1",
        body: { channelId: "discord:chat-1", messageId: "msg-1" },
        headers: { "x-friday-principal-source": "channel" },
      }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe(
      FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES.CHANNEL_HIGH_RISK_SOURCE_REFUSED,
    );
  });

  it("executes when a prior approval record exists and emits the non_reversible_external receipt", async () => {
    const { approveRoute, executeRoute } = getApproveAndExecuteHandlers();
    const token = signFridayChannelActionApprovalToken({
      actionId: "act-1",
      channelId: "discord:chat-1",
      principalId: "user-real-1",
      riskLevel: "high",
      expiresAt: "2099-01-01T00:00:00.000Z",
      signingKey: SIGNING_KEY,
    });
    await approveRoute.handler(buildCtx({
      actionId: "act-1",
      body: { ownerApprovalToken: token, channelId: "discord:chat-1" },
    }));
    const response = await executeRoute.handler(buildCtx({
      actionId: "act-1",
      body: { channelId: "discord:chat-1", messageId: "msg-1" },
    }));
    const body = response as {
      actionId: string;
      executedSource: string;
      receipt: { rollbackClass: string; evidenceRefSource: string; nonReversibleReason: string };
      approval: { approvedBy: string };
    };
    expect(body.actionId).toBe("act-1");
    expect(body.executedSource).toBe("api");
    expect(body.receipt.rollbackClass).toBe("non_reversible_external");
    expect(body.receipt.evidenceRefSource).toBe("channel_event");
    expect(body.receipt.nonReversibleReason).toContain("discord:chat-1");
    expect(body.approval.approvedBy).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("refuses execute when channelId does not match the approval", async () => {
    const { approveRoute, executeRoute } = getApproveAndExecuteHandlers();
    const token = signFridayChannelActionApprovalToken({
      actionId: "act-1",
      channelId: "discord:chat-1",
      principalId: "user-real-1",
      riskLevel: "high",
      expiresAt: "2099-01-01T00:00:00.000Z",
      signingKey: SIGNING_KEY,
    });
    await approveRoute.handler(buildCtx({
      actionId: "act-1",
      body: { ownerApprovalToken: token, channelId: "discord:chat-1" },
    }));
    let thrown: unknown;
    try {
      await executeRoute.handler(buildCtx({
        actionId: "act-1",
        body: { channelId: "lark:chat-1", messageId: "msg-1" },
      }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe(
      "CHANNEL_HIGH_RISK_EXECUTE_CHANNEL_MISMATCH",
    );
  });

  it("consumes the approval on successful execute so a second execute is refused", async () => {
    // Fail-closed single-use of the owner approval. The owner-link
    // contract is documented as single-use in
    // `friday-channel-action-approval.ts` (line 31); a successful execute
    // must consume the approval so a follow-up execute requires a fresh
    // owner-signed token.
    const { approveRoute, executeRoute, approvalStore } = getApproveAndExecuteHandlers();
    const token = signFridayChannelActionApprovalToken({
      actionId: "act-1",
      channelId: "discord:chat-1",
      principalId: "user-real-1",
      riskLevel: "high",
      expiresAt: "2099-01-01T00:00:00.000Z",
      signingKey: SIGNING_KEY,
    });
    await approveRoute.handler(buildCtx({
      actionId: "act-1",
      body: { ownerApprovalToken: token, channelId: "discord:chat-1" },
    }));
    // First execute succeeds.
    const first = await executeRoute.handler(buildCtx({
      actionId: "act-1",
      body: { channelId: "discord:chat-1", messageId: "msg-1" },
    }));
    expect((first as { actionId: string }).actionId).toBe("act-1");
    // Store no longer carries the approval after a successful execute.
    expect(await approvalStore.getApproval("act-1")).toBeNull();
    // Second execute against the same actionId fails closed.
    let thrown: unknown;
    try {
      await executeRoute.handler(buildCtx({
        actionId: "act-1",
        body: { channelId: "discord:chat-1", messageId: "msg-2" },
      }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe(
      "CHANNEL_HIGH_RISK_EXECUTE_NOT_APPROVED",
    );
  });

  it("does not consume the approval when channelId validation fails", async () => {
    // A mismatched-channel execute attempt is rejected before the
    // consume step, so a legitimate execute against the original
    // channelId remains valid.
    const { approveRoute, executeRoute, approvalStore } = getApproveAndExecuteHandlers();
    const token = signFridayChannelActionApprovalToken({
      actionId: "act-1",
      channelId: "discord:chat-1",
      principalId: "user-real-1",
      riskLevel: "high",
      expiresAt: "2099-01-01T00:00:00.000Z",
      signingKey: SIGNING_KEY,
    });
    await approveRoute.handler(buildCtx({
      actionId: "act-1",
      body: { ownerApprovalToken: token, channelId: "discord:chat-1" },
    }));
    let thrown: unknown;
    try {
      await executeRoute.handler(buildCtx({
        actionId: "act-1",
        body: { channelId: "lark:chat-1", messageId: "msg-1" },
      }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe(
      "CHANNEL_HIGH_RISK_EXECUTE_CHANNEL_MISMATCH",
    );
    // Approval is still present; a legitimate execute can use it.
    const stored = await approvalStore.getApproval("act-1");
    expect(stored?.actionId).toBe("act-1");
    const legit = await executeRoute.handler(buildCtx({
      actionId: "act-1",
      body: { channelId: "discord:chat-1", messageId: "msg-1" },
    }));
    expect((legit as { actionId: string }).actionId).toBe("act-1");
  });
});

describe("POST /v1/channels/actions/:actionId/owner-link", () => {
  it("refuses source: \"channel\"", async () => {
    const { linkRoute } = getOwnerLinkHandler();
    let thrown: unknown;
    try {
      await linkRoute.handler(buildCtx({
        actionId: "act-1",
        body: { channelId: "discord:chat-1" },
        headers: { "x-friday-principal-source": "channel" },
      }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe(
      FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES.CHANNEL_HIGH_RISK_SOURCE_REFUSED,
    );
  });

  it("refuses unauthenticated synthetic principal", async () => {
    const { linkRoute } = getOwnerLinkHandler();
    let thrown: unknown;
    try {
      await linkRoute.handler(buildCtx({
        actionId: "act-1",
        body: { channelId: "discord:chat-1" },
        principal: createFridayDefaultPublicHttpPrincipal(),
      }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe(
      FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES.BOUND_PRINCIPAL_REQUIRED,
    );
  });

  it("requires channelId", async () => {
    const { linkRoute } = getOwnerLinkHandler();
    let thrown: unknown;
    try {
      await linkRoute.handler(buildCtx({
        actionId: "act-1",
        body: {},
      }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe("VALIDATION_ERROR");
  });

  it("requires actionId path parameter", async () => {
    const { linkRoute } = getOwnerLinkHandler();
    let thrown: unknown;
    try {
      await linkRoute.handler({
        params: {},
        query: {},
        body: { channelId: "discord:chat-1" },
        headers: {},
        principal: realPrincipal(),
        requestId: "req-1",
      } as never);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe("VALIDATION_ERROR");
  });

  it("mints a signed token that the approve route accepts (api source)", async () => {
    const { linkRoute, approveRoute, approvalStore } = getOwnerLinkHandler();
    const linkResponse = (await linkRoute.handler(buildCtx({
      actionId: "act-1",
      body: { channelId: "discord:chat-1" },
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
    expect(linkResponse.actionId).toBe("act-1");
    expect(linkResponse.channelId).toBe("discord:chat-1");
    expect(linkResponse.ownerApprovalPath).toBe(
      "/v1/channels/actions/act-1/owner-approve",
    );
    expect(linkResponse.ownerApprovalUrl).toBe(linkResponse.ownerApprovalPath);
    expect(linkResponse.issuedSource).toBe("api");
    expect(linkResponse.principalId).toBe("user-real-1");

    // Token must verify independently against the same signing key.
    const payload = verifyFridayChannelActionApprovalToken({
      token: linkResponse.ownerApprovalToken,
      actionId: "act-1",
      channelId: "discord:chat-1",
      principalId: "user-real-1",
      nowIso: "2026-05-17T00:00:00.000Z",
      signingKey: SIGNING_KEY,
    });
    expect(payload.expiresAt).toBe(linkResponse.expiresAt);

    // Token routed through the approve handler completes the loop.
    const approveResponse = (await approveRoute.handler(buildCtx({
      actionId: "act-1",
      body: {
        ownerApprovalToken: linkResponse.ownerApprovalToken,
        channelId: "discord:chat-1",
      },
    }))) as { approvedSource: string };
    expect(approveResponse.approvedSource).toBe("api");
    const stored = await approvalStore.getApproval("act-1");
    expect(stored?.actionId).toBe("act-1");
  });

  it("issues a token with the session source label when called from session", async () => {
    const { linkRoute } = getOwnerLinkHandler();
    const response = (await linkRoute.handler(buildCtx({
      actionId: "act-2",
      body: { channelId: "lark:chat-2" },
      headers: { "x-friday-principal-source": "session" },
    }))) as { issuedSource: string };
    expect(response.issuedSource).toBe("session");
  });

  it("clamps ttlSeconds to the allowed range", async () => {
    const { linkRoute } = getOwnerLinkHandler();
    const issuedAt = Date.parse("2026-05-17T00:00:00.000Z");
    const tooSmall = (await linkRoute.handler(buildCtx({
      actionId: "act-1",
      body: { channelId: "discord:chat-1", ttlSeconds: 5 },
    }))) as { expiresAt: string };
    expect(Date.parse(tooSmall.expiresAt) - issuedAt).toBe(60_000);
    const tooLarge = (await linkRoute.handler(buildCtx({
      actionId: "act-2",
      body: { channelId: "discord:chat-1", ttlSeconds: 99_999 },
    }))) as { expiresAt: string };
    expect(Date.parse(tooLarge.expiresAt) - issuedAt).toBe(3_600_000);
    const inRange = (await linkRoute.handler(buildCtx({
      actionId: "act-3",
      body: { channelId: "discord:chat-1", ttlSeconds: 300 },
    }))) as { expiresAt: string };
    expect(Date.parse(inRange.expiresAt) - issuedAt).toBe(300_000);
  });

  it("rejects non-finite ttlSeconds", async () => {
    const { linkRoute } = getOwnerLinkHandler();
    let thrown: unknown;
    try {
      await linkRoute.handler(buildCtx({
        actionId: "act-1",
        body: { channelId: "discord:chat-1", ttlSeconds: "not-a-number" },
      }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe("VALIDATION_ERROR");
  });

  it("does not place the signed token into the path field or URL field as a query string", async () => {
    // Hardens the no-bearer-in-channel-text invariant: the route returns
    // the token in a separate field from the path/URL; the path must
    // never embed the token. The local Assistant carries the token
    // separately into the approve POST body.
    const { linkRoute } = getOwnerLinkHandler();
    const response = (await linkRoute.handler(buildCtx({
      actionId: "act-1",
      body: { channelId: "discord:chat-1" },
    }))) as {
      ownerApprovalPath: string;
      ownerApprovalUrl: string;
      ownerApprovalToken: string;
    };
    expect(response.ownerApprovalPath).not.toContain(response.ownerApprovalToken);
    expect(response.ownerApprovalUrl).not.toContain(response.ownerApprovalToken);
    expect(response.ownerApprovalPath).not.toContain("token=");
    expect(response.ownerApprovalUrl).not.toContain("token=");
  });
});
