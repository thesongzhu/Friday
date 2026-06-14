import { describe, expect, it, vi } from "vitest";

import { FridayDomainError } from "../../../../src/errors/friday-domain-error.js";
import {
  createFridayMemorySpineRoutes,
  validateMemoryDecisionBody,
  type FridayMemorySpineDispatchService,
} from "../../../../src/api/http/routes/friday-memory-spine-routes.js";
import type { FridayRustHubMemoryDecisionResult } from "../../../../src/api/mission-spine/friday-rust-hub-agent-run-ws-sealed-client.js";

// (Lane M) The memory-confirmation loop's terminal route. MIRRORS the mission-spine dispatch routes:
// guard order is (1) dispatch-disabled (flag-OFF) → 503 FIRST regardless of caller; (2)
// bound-principal → 401; (3) body validation → 400; (4) seal + dispatch. DARK by default (503).

const RESULT: FridayRustHubMemoryDecisionResult = {
  truthLabel: "rust_wired",
  memoryId: "mem-1",
  state: "confirmed",
  status: "confirmed",
  recallable: true,
};

const VALID_BODY = {
  memoryId: "mem-1",
  ownerPrincipal: "owner-1",
  decision: "confirm",
};

function makeCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "req-memory-spine-decide",
    receivedAt: "2026-06-14T00:00:00Z",
    params: {},
    query: {},
    body: null,
    headers: {},
    principal: {
      principalId: "principal-1",
      userId: "user-1",
      principalType: "user",
      role: "admin",
      scopes: ["hub.admin"],
    },
    ...overrides,
  };
}

function makeDispatch(overrides: Partial<FridayMemorySpineDispatchService> = {}): {
  dispatch: FridayMemorySpineDispatchService;
  decide: ReturnType<typeof vi.fn>;
} {
  const decide = vi.fn(async () => RESULT);
  return {
    dispatch: { decideMemory: decide, ...overrides },
    decide,
  };
}

function findRoute(routes: ReturnType<typeof createFridayMemorySpineRoutes>) {
  const route = routes.find((candidate) => candidate.operationId === "memory.spine.decide.apply");
  if (!route) throw new Error("memory.spine.decide.apply route missing");
  return route;
}

describe("createFridayMemorySpineRoutes (Lane M, dark)", () => {
  it("registers a single public POST /v1/memory-spine/decide route", () => {
    const { dispatch } = makeDispatch();
    const routes = createFridayMemorySpineRoutes({ dispatch });
    expect(routes).toHaveLength(1);
    const route = findRoute(routes);
    expect(route.method).toBe("POST");
    expect(route.path).toBe("/v1/memory-spine/decide");
    expect(route.auth).toEqual({ public: true });
  });

  describe("DEFAULT-OFF (no dispatch service) → honest-unavailable 503", () => {
    it("returns 503 MEMORY_SPINE_DISPATCH_UNAVAILABLE when dispatch is omitted, no send", async () => {
      const { decide } = makeDispatch();
      const routes = createFridayMemorySpineRoutes({});
      const route = findRoute(routes);
      let thrown: unknown = null;
      try {
        await route.handler(makeCtx({ body: VALID_BODY }) as never);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(FridayDomainError);
      const error = thrown as FridayDomainError;
      expect(error.code).toBe("MEMORY_SPINE_DISPATCH_UNAVAILABLE");
      expect(error.httpStatus).toBe(503);
      expect(decide).not.toHaveBeenCalled();
    });

    it("503 also when dispatch is explicitly null", async () => {
      const routes = createFridayMemorySpineRoutes({ dispatch: null });
      const route = findRoute(routes);
      const error = await route.handler(makeCtx({ body: VALID_BODY }) as never).catch((e) => e);
      expect((error as FridayDomainError).code).toBe("MEMORY_SPINE_DISPATCH_UNAVAILABLE");
      expect((error as FridayDomainError).httpStatus).toBe(503);
    });

    it("503-unavailable fires FIRST — even for a null (unauthenticated) principal", async () => {
      const routes = createFridayMemorySpineRoutes({});
      const route = findRoute(routes);
      const error = await route
        .handler(makeCtx({ principal: null, body: VALID_BODY }) as never)
        .catch((e) => e);
      // Flag-OFF is a uniform honest-unavailable, NOT a principal refusal.
      expect((error as FridayDomainError).code).toBe("MEMORY_SPINE_DISPATCH_UNAVAILABLE");
    });
  });

  describe("flag-ON: bound-principal gate", () => {
    it("refuses the synthetic public (null) principal with a 401, no dispatch", async () => {
      const { dispatch, decide } = makeDispatch();
      const routes = createFridayMemorySpineRoutes({ dispatch });
      const route = findRoute(routes);
      const error = await route
        .handler(makeCtx({ principal: null, body: VALID_BODY }) as never)
        .catch((e) => e);
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).httpStatus).toBe(401);
      expect(decide).not.toHaveBeenCalled();
    });
  });

  describe("flag-ON: validation — a 4xx (never a 500), no send", () => {
    it("maps a valid body to the typed request and passes through the refs-only result", async () => {
      const { dispatch, decide } = makeDispatch();
      const routes = createFridayMemorySpineRoutes({ dispatch });
      const route = findRoute(routes);
      const response = (await route.handler(makeCtx({ body: VALID_BODY }) as never)) as {
        result: FridayRustHubMemoryDecisionResult;
      };
      expect(response.result).toBe(RESULT);
      expect(decide).toHaveBeenCalledTimes(1);
      expect(decide).toHaveBeenCalledWith({
        memoryId: "mem-1",
        ownerPrincipal: "owner-1",
        decision: "confirm",
      });
    });

    it("a missing field → 400, no send", async () => {
      const { dispatch, decide } = makeDispatch();
      const routes = createFridayMemorySpineRoutes({ dispatch });
      const route = findRoute(routes);
      const error = await route
        .handler(makeCtx({ body: { memoryId: "mem-1", decision: "confirm" } }) as never)
        .catch((e) => e);
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe("MEMORY_SPINE_DECISION_REQUEST_INVALID");
      expect((error as FridayDomainError).httpStatus).toBe(400);
      expect(decide).not.toHaveBeenCalled();
    });

    it("a `decision` not in {confirm,reject} → 400, no send", async () => {
      const { dispatch, decide } = makeDispatch();
      const routes = createFridayMemorySpineRoutes({ dispatch });
      const route = findRoute(routes);
      const error = await route
        .handler(makeCtx({ body: { ...VALID_BODY, decision: "maybe" } }) as never)
        .catch((e) => e);
      expect((error as FridayDomainError).httpStatus).toBe(400);
      expect(JSON.stringify((error as FridayDomainError).details)).toContain(
        "decision_not_confirm_or_reject",
      );
      expect(decide).not.toHaveBeenCalled();
    });

    it("an empty/non-object body → 400, no send", async () => {
      const { dispatch, decide } = makeDispatch();
      const routes = createFridayMemorySpineRoutes({ dispatch });
      const route = findRoute(routes);
      const error = await route.handler(makeCtx({ body: null }) as never).catch((e) => e);
      expect((error as FridayDomainError).httpStatus).toBe(400);
      expect(decide).not.toHaveBeenCalled();
    });
  });
});

describe("validateMemoryDecisionBody (pure)", () => {
  it("accepts both confirm and reject; trims whitespace", () => {
    expect(validateMemoryDecisionBody({ memoryId: " m ", ownerPrincipal: " o ", decision: "reject" })).toEqual(
      { memoryId: "m", ownerPrincipal: "o", decision: "reject" },
    );
  });

  it("rejects an empty-string field as a 400", () => {
    const error = (() => {
      try {
        validateMemoryDecisionBody({ memoryId: "", ownerPrincipal: "o", decision: "confirm" });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect((error as FridayDomainError).httpStatus).toBe(400);
    expect(JSON.stringify((error as FridayDomainError).details)).toContain("memoryId_missing_or_empty");
  });
});
