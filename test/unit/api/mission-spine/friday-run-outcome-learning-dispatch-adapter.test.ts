import { describe, expect, it, vi } from "vitest";

import { FridayDomainError } from "../../../../src/errors/friday-domain-error.js";
import {
  createFridayRunOutcomeLearningDispatchAdapter,
  readRunOutcomeLearningRustWsPort,
} from "../../../../src/api/mission-spine/friday-run-outcome-learning-dispatch-adapter.js";
import type {
  CreateFridayRustHubAgentRunSealedClientOptions,
  FridayRustHubAgentRunSealedClient,
  FridayRustHubRunOutcomeLearningDecisionRequest,
  FridayRustHubRunOutcomeLearningDecisionResult,
} from "../../../../src/api/mission-spine/friday-rust-hub-agent-run-ws-sealed-client.js";

const SECRET = new Uint8Array(32).fill(9);

const REQUEST: FridayRustHubRunOutcomeLearningDecisionRequest = {
  candidateId: "a1:run-1:preference",
  decision: "confirm",
  reason: "owner confirmed",
};

const RESULT: FridayRustHubRunOutcomeLearningDecisionResult = {
  truthLabel: "rust_wired",
  candidateId: "a1:run-1:preference",
  runId: "run-1",
  kind: "preference",
  state: "confirmed",
  status: "confirmed",
};

function makeFakeClient(behavior: {
  decide?: FridayRustHubRunOutcomeLearningDecisionResult;
  reject?: unknown;
}) {
  const constructed: CreateFridayRustHubAgentRunSealedClientOptions[] = [];
  const decideCalls: FridayRustHubRunOutcomeLearningDecisionRequest[] = [];
  const createClient = vi.fn(
    (options: CreateFridayRustHubAgentRunSealedClientOptions): FridayRustHubAgentRunSealedClient => {
      constructed.push(options);
      return {
        dispatchRun: vi.fn(async () => {
          throw new Error("dispatchRun not used by the A1 decision adapter");
        }),
        resumeWithApproval: vi.fn(async () => {
          throw new Error("resumeWithApproval not used by the A1 decision adapter");
        }),
        intakeMission: vi.fn(async () => {
          throw new Error("intakeMission not used by the A1 decision adapter");
        }),
        transitionMission: vi.fn(async () => {
          throw new Error("transitionMission not used by the A1 decision adapter");
        }),
        transitionWorkItem: vi.fn(async () => {
          throw new Error("transitionWorkItem not used by the A1 decision adapter");
        }),
        controlRouteDecision: vi.fn(async () => {
          throw new Error("controlRouteDecision not used by the A1 decision adapter");
        }),
        decideMemory: vi.fn(async () => {
          throw new Error("decideMemory not used by the A1 decision adapter");
        }),
        decideRunOutcomeLearning: vi.fn(async (req: FridayRustHubRunOutcomeLearningDecisionRequest) => {
          decideCalls.push(req);
          if (behavior.reject !== undefined) throw behavior.reject;
          return behavior.decide!;
        }),
      };
    },
  );
  return { createClient, constructed, decideCalls };
}

describe("createFridayRunOutcomeLearningDispatchAdapter", () => {
  it("builds the sealed client lazily and delegates the refs-only decision", async () => {
    const fake = makeFakeClient({ decide: RESULT });
    const secretResolver = vi.fn(() => SECRET);
    const adapter = createFridayRunOutcomeLearningDispatchAdapter({
      host: "127.0.0.1",
      port: 48750,
      secretResolver,
      createClient: fake.createClient,
    });

    expect(secretResolver).not.toHaveBeenCalled();
    expect(fake.createClient).not.toHaveBeenCalled();

    expect(await adapter.decideRunOutcomeLearning(REQUEST)).toBe(RESULT);

    expect(secretResolver).toHaveBeenCalledTimes(1);
    expect(fake.createClient).toHaveBeenCalledTimes(1);
    expect(fake.constructed[0]).toMatchObject({ host: "127.0.0.1", port: 48750, clientSecret: SECRET });
    expect(fake.decideCalls).toEqual([REQUEST]);
  });

  it("passes through a Hub blocked refusal as a successful round-trip", async () => {
    const blocked: FridayRustHubRunOutcomeLearningDecisionResult = {
      truthLabel: "rust_wired",
      candidateId: "a1:run-1:preference",
      state: "pending",
      status: "blocked",
      blocker: "owner_scope_mismatch",
    };
    const fake = makeFakeClient({ decide: blocked });
    const adapter = createFridayRunOutcomeLearningDispatchAdapter({
      port: 48750,
      secretResolver: () => SECRET,
      createClient: fake.createClient,
    });
    expect(await adapter.decideRunOutcomeLearning({ ...REQUEST, decision: "reject" })).toBe(blocked);
  });

  it("fails closed when the secret is unavailable or the client throws", async () => {
    const fake = makeFakeClient({ decide: RESULT });
    const noSecret = createFridayRunOutcomeLearningDispatchAdapter({
      port: 48750,
      secretResolver: () => null,
      createClient: fake.createClient,
    });
    await expect(noSecret.decideRunOutcomeLearning(REQUEST)).rejects.toMatchObject({
      code: "RUN_OUTCOME_LEARNING_DISPATCH_RUST_UNAVAILABLE",
      httpStatus: 503,
    });
    expect(fake.createClient).not.toHaveBeenCalled();

    const inner = new FridayDomainError("INNER", "inner", { httpStatus: 503 });
    const failing = makeFakeClient({ reject: inner });
    const adapter = createFridayRunOutcomeLearningDispatchAdapter({
      port: 48750,
      secretResolver: () => SECRET,
      createClient: failing.createClient,
    });
    await expect(adapter.decideRunOutcomeLearning(REQUEST)).rejects.toBe(inner);
  });
});

describe("readRunOutcomeLearningRustWsPort", () => {
  it("parses valid ports and fails closed to 0 for missing/bad values", () => {
    expect(readRunOutcomeLearningRustWsPort("48750")).toBe(48750);
    expect(readRunOutcomeLearningRustWsPort(undefined)).toBe(0);
    expect(readRunOutcomeLearningRustWsPort("")).toBe(0);
    expect(readRunOutcomeLearningRustWsPort("-1")).toBe(0);
    expect(readRunOutcomeLearningRustWsPort("abc")).toBe(0);
  });
});
