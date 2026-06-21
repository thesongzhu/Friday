import { describe, expect, it, vi } from "vitest";

import { FridayDomainError } from "../../../../src/errors/friday-domain-error.js";
import {
  createFridayRunOutcomeLearningRoutes,
  validateRunOutcomeLearningDecisionBody,
  type FridayRunOutcomeLearningRoutesDispatchService,
} from "../../../../src/api/http/routes/friday-run-outcome-learning-routes.js";
import type { FridayRustHubRunOutcomeLearningDecisionResult } from "../../../../src/api/mission-spine/friday-rust-hub-agent-run-ws-sealed-client.js";

const RESULT: FridayRustHubRunOutcomeLearningDecisionResult = {
  truthLabel: "rust_wired",
  candidateId: "a1:run-1:preference",
  runId: "run-1",
  kind: "preference",
  state: "confirmed",
  status: "confirmed",
};

const VALID_BODY = {
  candidateId: "a1:run-1:preference",
  decision: "confirm",
  reason: "owner confirmed",
};

function makeCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "req-a1-decision",
    receivedAt: "2026-06-20T00:00:00Z",
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

function makeDispatch(): {
  dispatch: FridayRunOutcomeLearningRoutesDispatchService;
  decide: ReturnType<typeof vi.fn>;
} {
  const decide = vi.fn(async () => RESULT);
  return {
    dispatch: { decideRunOutcomeLearning: decide },
    decide,
  };
}

function findRoute(routes: ReturnType<typeof createFridayRunOutcomeLearningRoutes>) {
  const route = routes.find((candidate) => candidate.operationId === "run.outcome.learning.decide.apply");
  if (!route) throw new Error("run.outcome.learning.decide.apply route missing");
  return route;
}

describe("createFridayRunOutcomeLearningRoutes (A1 decision courier, dark)", () => {
  it("registers a public POST /v1/run-outcome-learning/decide route", () => {
    const { dispatch } = makeDispatch();
    const routes = createFridayRunOutcomeLearningRoutes({ dispatch });
    const route = findRoute(routes);
    expect(route.method).toBe("POST");
    expect(route.path).toBe("/v1/run-outcome-learning/decide");
    expect(route.auth).toEqual({ public: true });
  });

  it("default-off returns 503 before principal/body checks and sends nothing", async () => {
    const routes = createFridayRunOutcomeLearningRoutes({});
    const route = findRoute(routes);
    const error = await route
      .handler(makeCtx({ principal: null, body: VALID_BODY }) as never)
      .catch((e) => e);
    expect(error).toBeInstanceOf(FridayDomainError);
    expect((error as FridayDomainError).code).toBe("RUN_OUTCOME_LEARNING_DISPATCH_UNAVAILABLE");
    expect((error as FridayDomainError).httpStatus).toBe(503);
  });

  it("flag-on refuses the synthetic public principal before dispatch", async () => {
    const { dispatch, decide } = makeDispatch();
    const route = findRoute(createFridayRunOutcomeLearningRoutes({ dispatch }));
    const error = await route
      .handler(makeCtx({ principal: null, body: VALID_BODY }) as never)
      .catch((e) => e);
    expect((error as FridayDomainError).httpStatus).toBe(401);
    expect(decide).not.toHaveBeenCalled();
  });

  it("validates and dispatches a refs-only decision request", async () => {
    const { dispatch, decide } = makeDispatch();
    const route = findRoute(createFridayRunOutcomeLearningRoutes({ dispatch }));
    const response = (await route.handler(makeCtx({ body: VALID_BODY }) as never)) as {
      result: FridayRustHubRunOutcomeLearningDecisionResult;
    };
    expect(response.result).toBe(RESULT);
    expect(decide).toHaveBeenCalledWith({
      candidateId: "a1:run-1:preference",
      decision: "confirm",
      reason: "owner confirmed",
    });
  });

  it("rejects malformed bodies with 400 and no dispatch", async () => {
    const { dispatch, decide } = makeDispatch();
    const route = findRoute(createFridayRunOutcomeLearningRoutes({ dispatch }));
    const error = await route
      .handler(makeCtx({ body: { candidateId: "a1:run-1:preference", decision: "maybe" } }) as never)
      .catch((e) => e);
    expect((error as FridayDomainError).code).toBe("RUN_OUTCOME_LEARNING_DECISION_REQUEST_INVALID");
    expect((error as FridayDomainError).httpStatus).toBe(400);
    expect(decide).not.toHaveBeenCalled();
  });
});

describe("validateRunOutcomeLearningDecisionBody", () => {
  it("accepts reject and trims optional reason", () => {
    expect(
      validateRunOutcomeLearningDecisionBody({
        candidateId: " a1:run-1:world_model ",
        decision: "reject",
        reason: " no ",
      }),
    ).toEqual({
      candidateId: "a1:run-1:world_model",
      decision: "reject",
      reason: "no",
    });
  });
});
