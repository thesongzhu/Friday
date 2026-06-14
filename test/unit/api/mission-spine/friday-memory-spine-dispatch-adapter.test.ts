import { describe, expect, it, vi } from "vitest";

import { FridayDomainError } from "../../../../src/errors/friday-domain-error.js";
import {
  createFridayMemorySpineDispatchAdapter,
  readMemorySpineRustWsPort,
} from "../../../../src/api/mission-spine/friday-memory-spine-dispatch-adapter.js";
import type {
  CreateFridayRustHubAgentRunSealedClientOptions,
  FridayRustHubAgentRunSealedClient,
  FridayRustHubMemoryDecisionRequest,
  FridayRustHubMemoryDecisionResult,
} from "../../../../src/api/mission-spine/friday-rust-hub-agent-run-ws-sealed-client.js";

// (Lane M) The bootstrap-side ADAPTER that satisfies the memory-spine route's `dispatch` so
// POST /v1/memory-spine/decide becomes callable. These tests mock the underlying sealed client at
// the `createClient` seam + the secret resolver — so we exercise the adapter's lazy-build /
// delegation / fail-closed WITHOUT a socket (and without re-proving the proven ECDH interop).

const SECRET = new Uint8Array(32).fill(7);

const DECIDE_REQ: FridayRustHubMemoryDecisionRequest = {
  memoryId: "mem-1",
  ownerPrincipal: "owner-1",
  decision: "confirm",
};

const DECIDE_RESULT: FridayRustHubMemoryDecisionResult = {
  truthLabel: "rust_wired",
  memoryId: "mem-1",
  state: "confirmed",
  status: "confirmed",
  recallable: true,
};

/** A fake underlying sealed client + a recorder of how it was constructed/called. */
function makeFakeClient(behavior: {
  decide?: FridayRustHubMemoryDecisionResult;
  reject?: unknown;
}) {
  const constructed: CreateFridayRustHubAgentRunSealedClientOptions[] = [];
  const decideCalls: FridayRustHubMemoryDecisionRequest[] = [];
  const createClient = vi.fn(
    (options: CreateFridayRustHubAgentRunSealedClientOptions): FridayRustHubAgentRunSealedClient => {
      constructed.push(options);
      return {
        dispatchRun: vi.fn(async () => {
          throw new Error("dispatchRun not used by the memory adapter");
        }),
        resumeWithApproval: vi.fn(async () => {
          throw new Error("resumeWithApproval not used by the memory adapter");
        }),
        intakeMission: vi.fn(async () => {
          throw new Error("intakeMission not used by the memory adapter");
        }),
        transitionMission: vi.fn(async () => {
          throw new Error("transitionMission not used by the memory adapter");
        }),
        transitionWorkItem: vi.fn(async () => {
          throw new Error("transitionWorkItem not used by the memory adapter");
        }),
        decideMemory: vi.fn(async (req: FridayRustHubMemoryDecisionRequest) => {
          decideCalls.push(req);
          if (behavior.reject !== undefined) throw behavior.reject;
          return behavior.decide!;
        }),
      };
    },
  );
  return { createClient, constructed, decideCalls };
}

describe("createFridayMemorySpineDispatchAdapter (Lane M, dark, adapter)", () => {
  describe("happy path — delegates to the (mocked) sealed client", () => {
    it("decideMemory builds the client lazily with the resolved secret + delegates the request", async () => {
      const fake = makeFakeClient({ decide: DECIDE_RESULT });
      const secretResolver = vi.fn(() => SECRET);
      const adapter = createFridayMemorySpineDispatchAdapter({
        host: "127.0.0.1",
        port: 48750,
        secretResolver,
        createClient: fake.createClient,
      });

      // Side-effect-free construction: NO secret resolved, NO client built until the first call.
      expect(secretResolver).not.toHaveBeenCalled();
      expect(fake.createClient).not.toHaveBeenCalled();

      const result = await adapter.decideMemory(DECIDE_REQ);

      expect(result).toBe(DECIDE_RESULT);
      expect(secretResolver).toHaveBeenCalledTimes(1);
      expect(fake.createClient).toHaveBeenCalledTimes(1);
      expect(fake.constructed[0]).toMatchObject({ host: "127.0.0.1", port: 48750, clientSecret: SECRET });
      expect(fake.decideCalls).toEqual([DECIDE_REQ]);
    });

    it("a Hub `blocked` outcome is a SUCCESSFUL round-trip of a refusal (resolved, not thrown)", async () => {
      const blocked: FridayRustHubMemoryDecisionResult = {
        truthLabel: "rust_wired",
        memoryId: "mem-1",
        state: "rejected",
        status: "blocked",
        blocker: "owner_scope_mismatch",
        recallable: false,
      };
      const fake = makeFakeClient({ decide: blocked });
      const adapter = createFridayMemorySpineDispatchAdapter({
        port: 48750,
        secretResolver: () => SECRET,
        createClient: fake.createClient,
      });

      expect(await adapter.decideMemory({ ...DECIDE_REQ, decision: "reject" })).toBe(blocked);
    });
  });

  describe("fail-closed — never a fake success", () => {
    it("a null secret resolve → typed 503, no client built", async () => {
      const fake = makeFakeClient({ decide: DECIDE_RESULT });
      const adapter = createFridayMemorySpineDispatchAdapter({
        port: 48750,
        secretResolver: () => null,
        createClient: fake.createClient,
      });

      await expect(adapter.decideMemory(DECIDE_REQ)).rejects.toMatchObject({
        code: "MEMORY_SPINE_DISPATCH_RUST_UNAVAILABLE",
        httpStatus: 503,
      });
      expect(fake.createClient).not.toHaveBeenCalled();
      expect(fake.decideCalls).toEqual([]);
    });

    it("the underlying client constructor throwing → typed 503", async () => {
      const adapter = createFridayMemorySpineDispatchAdapter({
        port: 48750,
        secretResolver: () => SECRET,
        createClient: () => {
          throw new RangeError("clientSecret must be 32 bytes");
        },
      });

      const error = await adapter.decideMemory(DECIDE_REQ).catch((e) => e);
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe("MEMORY_SPINE_DISPATCH_RUST_UNAVAILABLE");
      expect((error as FridayDomainError).httpStatus).toBe(503);
    });

    it("an inner FridayDomainError (e.g. a WS error / server Error envelope) surfaces UNCHANGED", async () => {
      const innerWsError = new FridayDomainError(
        "MISSION_SPINE_RUST_AGENT_RUN_SEALED_WS_CLIENT_UNAVAILABLE",
        "sealed session closed before a result",
        { httpStatus: 503, details: { surface: "ws" } },
      );
      const fake = makeFakeClient({ reject: innerWsError });
      const adapter = createFridayMemorySpineDispatchAdapter({
        port: 48750,
        secretResolver: () => SECRET,
        createClient: fake.createClient,
      });

      const error = await adapter.decideMemory(DECIDE_REQ).catch((e) => e);
      expect(error).toBe(innerWsError);
      expect((error as FridayDomainError).httpStatus).toBe(503);
    });

    it("a NON-domain inner throw is wrapped as a typed 503 (never leaks as an unhandled throw)", async () => {
      const fake = makeFakeClient({ reject: new Error("socket ECONNREFUSED") });
      const adapter = createFridayMemorySpineDispatchAdapter({
        port: 48750,
        secretResolver: () => SECRET,
        createClient: fake.createClient,
      });

      const error = await adapter.decideMemory(DECIDE_REQ).catch((e) => e);
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe("MEMORY_SPINE_DISPATCH_RUST_UNAVAILABLE");
      expect((error as FridayDomainError).httpStatus).toBe(503);
    });
  });

  describe("readMemorySpineRustWsPort — replicates the agent-run port parse exactly", () => {
    it("absent / blank / non-finite / negative ⇒ 0; a valid port parses", () => {
      expect(readMemorySpineRustWsPort(undefined)).toBe(0);
      expect(readMemorySpineRustWsPort("")).toBe(0);
      expect(readMemorySpineRustWsPort("not-a-number")).toBe(0);
      expect(readMemorySpineRustWsPort("-5")).toBe(0);
      expect(readMemorySpineRustWsPort("48750")).toBe(48750);
      expect(readMemorySpineRustWsPort("0")).toBe(0);
    });
  });
});
