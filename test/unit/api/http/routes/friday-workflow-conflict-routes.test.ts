import { describe, it, expect, vi } from "vitest";
import { createFridayWorkflowConflictRoutes } from "#api";
import type { FridayAuthPrincipal, FridayHttpContext, FridayWorkflowConflictRoutesDeps } from "#api";
import { createFridayDefaultPublicHttpPrincipal } from "../../../../../src/api/http/friday-default-public-principal.js";
import type {
  FridayWorkflowConflictEntity,
  FridayWorkflowDraftEntity,
} from "#api";

/** Handlers are never invoked; stubs only satisfy the type signature. */
const stubConflict = {} as unknown as FridayWorkflowConflictEntity;
const stubDraft = {} as unknown as FridayWorkflowDraftEntity;
const NOW = "2026-05-22T00:00:00.000Z";

function makePrincipal(overrides: Partial<FridayAuthPrincipal> = {}): FridayAuthPrincipal {
  return {
    principalType: "user",
    principalId: "user-1",
    userId: "user-1",
    role: "operator",
    scopes: ["workflow.conflict.resolve"],
    tokenId: "token-1",
    tokenKind: "access",
    issuedAt: NOW,
    ...overrides,
  };
}

function makeCtx(
  overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {},
): FridayHttpContext<unknown, unknown, unknown> {
  return {
    requestId: "req-1",
    receivedAt: NOW,
    params: { workflowId: "wf-1", conflictId: "conflict-1" },
    query: {},
    body: {},
    headers: {},
    principal: makePrincipal(),
    ...overrides,
  };
}

describe("FridayWorkflowConflictRoutes", () => {
  const stubDeps: FridayWorkflowConflictRoutesDeps = {
    listConflicts: () => ({ items: [] }),
    resolveConflict: () => ({ conflict: stubConflict, draft: stubDraft }),
  };

  const routes = createFridayWorkflowConflictRoutes(stubDeps);

  it("registers 2 conflict routes", () => {
    expect(routes).toHaveLength(2);
  });

  it("GET /v1/workflows/:workflowId/conflicts requires workflow.read", () => {
    const route = routes.find((r) => r.operationId === "conflicts.list");
    expect(route).toBeDefined();
    expect(route!.method).toBe("GET");
    expect(route!.auth).toEqual({ public: true });
  });

  it("POST /v1/workflows/:workflowId/conflicts/:conflictId/resolve requires workflow.conflict.resolve", () => {
    const route = routes.find((r) => r.operationId === "conflicts.resolve");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
    expect(route!.auth).toEqual({ public: true });
    expect(route!.rateLimitPolicyId).toBe("workflow.resolve_conflict");
  });

  it("rejects synthetic public conflict resolution", async () => {
    const route = routes.find((r) => r.operationId === "conflicts.resolve")!;
    await expect(
      route.handler(makeCtx({ principal: createFridayDefaultPublicHttpPrincipal() })),
    ).rejects.toMatchObject({
      code: "OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED",
      httpStatus: 401,
    });
  });

  it("passes the bound user id to conflict resolution", async () => {
    const resolveConflict = vi.fn(() => ({ conflict: stubConflict, draft: stubDraft }));
    const route = createFridayWorkflowConflictRoutes({
      listConflicts: () => ({ items: [] }),
      resolveConflict,
    }).find((r) => r.operationId === "conflicts.resolve")!;
    const result = await route.handler(makeCtx());
    expect(result).toEqual({ conflict: stubConflict, draft: stubDraft });
    expect(resolveConflict).toHaveBeenCalledWith("wf-1", "conflict-1", {}, "user-1");
  });
});
