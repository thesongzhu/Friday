import { describe, expect, it, vi } from "vitest";

import { FridayDomainError } from "../../../../src/errors/friday-domain-error.js";
import {
  createFridayMissionSpineDispatchAdapter,
  readMissionSpineRustWsPort,
} from "../../../../src/api/mission-spine/friday-mission-spine-dispatch-adapter.js";
import {
  createFridayMissionAutoDispatchDriver,
  type MissionAutoDispatchStartRun,
} from "../../../../src/api/mission-spine/friday-mission-auto-dispatch-driver.js";
import type {
  CreateFridayRustHubAgentRunSealedClientOptions,
  FridayRustHubAgentRunSealedClient,
  FridayRustHubMissionIntakeRequest,
  FridayRustHubMissionIntakeResult,
  FridayRustHubMissionLifecycleRequest,
  FridayRustHubMissionLifecycleResult,
  FridayRustHubWorkItemStatusRequest,
  FridayRustHubWorkItemStatusResult,
} from "../../../../src/api/mission-spine/friday-rust-hub-agent-run-ws-sealed-client.js";

// (Lane B-2) The bootstrap-side ADAPTER that satisfies `missionSpine.dispatch` so the three organic
// POST routes become callable. These tests mock the underlying sealed client at the `createClient`
// seam + the secret resolver — so we exercise the adapter's lazy-build / delegation / fail-closed
// WITHOUT a socket and WITHOUT re-proving the (already-proven) ECDH interop.

const SECRET = new Uint8Array(32).fill(7);

const INTAKE_REQ: FridayRustHubMissionIntakeRequest = {
  fridayConversationId: "conv-1",
  ownerPrincipal: "principal-owner",
  surfaceThreadId: "thread-1",
  surfaceKind: "mobile",
  deliveryRoute: "mobile",
  visibilityPolicy: "owner_only",
  missionId: "mission-1",
  workItemId: "wi-1",
  title: "title",
  intent: "intent",
  lane: "lane",
};

const INTAKE_RESULT: FridayRustHubMissionIntakeResult = {
  truthLabel: "rust_wired",
  fridayConversationId: "conv-1",
  missionId: "mission-1",
  surfaceThreadId: "thread-1",
  status: "ready",
  blockers: [],
  createdOrReady: true,
};

const LIFECYCLE_REQ: FridayRustHubMissionLifecycleRequest = {
  fridayConversationId: "conv-1",
  missionId: "mission-1",
  targetStatus: "queued",
  actorRef: "actor-1",
  reason: "advance",
};

const LIFECYCLE_RESULT: FridayRustHubMissionLifecycleResult = {
  truthLabel: "rust_wired",
  fridayConversationId: "conv-1",
  missionId: "mission-1",
  previousStatus: "ready",
  status: "queued",
  actorRef: "actor-1",
  reason: "advance",
  activeMissionIds: ["mission-1"],
  updatedAtMs: 1,
};

const WORKITEM_REQ: FridayRustHubWorkItemStatusRequest = {
  workItemId: "wi-1",
  targetStatus: "in_progress",
  actorRef: "actor-1",
  reason: "start",
};

const WORKITEM_RESULT: FridayRustHubWorkItemStatusResult = {
  truthLabel: "rust_wired",
  workItemId: "wi-1",
  missionId: "mission-1",
  previousStatus: "ready",
  status: "in_progress",
  actorRef: "actor-1",
  reason: "start",
  proofReceiptCount: 0,
  updatedAtMs: 1,
};

/** A fake underlying sealed client + a recorder of how it was constructed/called. */
function makeFakeClient(behavior: {
  intake?: FridayRustHubMissionIntakeResult;
  lifecycle?: FridayRustHubMissionLifecycleResult;
  workItem?: FridayRustHubWorkItemStatusResult;
  reject?: unknown;
}) {
  const constructed: CreateFridayRustHubAgentRunSealedClientOptions[] = [];
  const intakeCalls: FridayRustHubMissionIntakeRequest[] = [];
  const lifecycleCalls: FridayRustHubMissionLifecycleRequest[] = [];
  const workItemCalls: FridayRustHubWorkItemStatusRequest[] = [];
  const createClient = vi.fn(
    (options: CreateFridayRustHubAgentRunSealedClientOptions): FridayRustHubAgentRunSealedClient => {
      constructed.push(options);
      return {
        dispatchRun: vi.fn(async () => {
          throw new Error("dispatchRun not used by the mission adapter");
        }),
        resumeWithApproval: vi.fn(async () => {
          throw new Error("resumeWithApproval not used by the mission adapter");
        }),
        intakeMission: vi.fn(async (req: FridayRustHubMissionIntakeRequest) => {
          intakeCalls.push(req);
          if (behavior.reject !== undefined) throw behavior.reject;
          return behavior.intake!;
        }),
        transitionMission: vi.fn(async (req: FridayRustHubMissionLifecycleRequest) => {
          lifecycleCalls.push(req);
          if (behavior.reject !== undefined) throw behavior.reject;
          return behavior.lifecycle!;
        }),
        transitionWorkItem: vi.fn(async (req: FridayRustHubWorkItemStatusRequest) => {
          workItemCalls.push(req);
          if (behavior.reject !== undefined) throw behavior.reject;
          return behavior.workItem!;
        }),
      };
    },
  );
  return { createClient, constructed, intakeCalls, lifecycleCalls, workItemCalls };
}

describe("createFridayMissionSpineDispatchAdapter (Lane B-2, dark, adapter)", () => {
  describe("happy path — delegates to the (mocked) sealed client", () => {
    it("intakeMission builds the client lazily with the resolved secret + delegates the request", async () => {
      const fake = makeFakeClient({ intake: INTAKE_RESULT });
      const secretResolver = vi.fn(() => SECRET);
      const adapter = createFridayMissionSpineDispatchAdapter({
        host: "127.0.0.1",
        port: 48750,
        secretResolver,
        createClient: fake.createClient,
      });

      // Side-effect-free construction: NO secret resolved, NO client built until the first call.
      expect(secretResolver).not.toHaveBeenCalled();
      expect(fake.createClient).not.toHaveBeenCalled();

      const result = await adapter.intakeMission(INTAKE_REQ);

      expect(result).toBe(INTAKE_RESULT);
      expect(secretResolver).toHaveBeenCalledTimes(1);
      expect(fake.createClient).toHaveBeenCalledTimes(1);
      expect(fake.constructed[0]).toMatchObject({ host: "127.0.0.1", port: 48750, clientSecret: SECRET });
      expect(fake.intakeCalls).toEqual([INTAKE_REQ]);
    });

    it("transitionMission + transitionWorkItem delegate verbatim", async () => {
      const fake = makeFakeClient({ lifecycle: LIFECYCLE_RESULT, workItem: WORKITEM_RESULT });
      const adapter = createFridayMissionSpineDispatchAdapter({
        port: 48750,
        secretResolver: () => SECRET,
        createClient: fake.createClient,
      });

      expect(await adapter.transitionMission(LIFECYCLE_REQ)).toBe(LIFECYCLE_RESULT);
      expect(await adapter.transitionWorkItem(WORKITEM_REQ)).toBe(WORKITEM_RESULT);
      expect(fake.lifecycleCalls).toEqual([LIFECYCLE_REQ]);
      expect(fake.workItemCalls).toEqual([WORKITEM_REQ]);
    });
  });

  describe("fail-closed — never a fake success", () => {
    it("a null secret resolve → typed 503, no client built", async () => {
      const fake = makeFakeClient({ intake: INTAKE_RESULT });
      const adapter = createFridayMissionSpineDispatchAdapter({
        port: 48750,
        secretResolver: () => null,
        createClient: fake.createClient,
      });

      await expect(adapter.intakeMission(INTAKE_REQ)).rejects.toMatchObject({
        code: "MISSION_SPINE_DISPATCH_RUST_UNAVAILABLE",
        httpStatus: 503,
      });
      expect(fake.createClient).not.toHaveBeenCalled();
      expect(fake.intakeCalls).toEqual([]);
    });

    it("the underlying client constructor throwing → typed 503", async () => {
      const adapter = createFridayMissionSpineDispatchAdapter({
        port: 48750,
        secretResolver: () => SECRET,
        createClient: () => {
          throw new RangeError("clientSecret must be 32 bytes");
        },
      });

      const error = await adapter.transitionMission(LIFECYCLE_REQ).catch((e) => e);
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe("MISSION_SPINE_DISPATCH_RUST_UNAVAILABLE");
      expect((error as FridayDomainError).httpStatus).toBe(503);
    });

    it("an inner FridayDomainError (e.g. a WS error / server Error envelope) surfaces UNCHANGED", async () => {
      const innerWsError = new FridayDomainError(
        "MISSION_SPINE_RUST_AGENT_RUN_SEALED_WS_CLIENT_UNAVAILABLE",
        "sealed session closed before a result",
        { httpStatus: 503, details: { surface: "ws" } },
      );
      const fake = makeFakeClient({ reject: innerWsError });
      const adapter = createFridayMissionSpineDispatchAdapter({
        port: 48750,
        secretResolver: () => SECRET,
        createClient: fake.createClient,
      });

      const error = await adapter.transitionWorkItem(WORKITEM_REQ).catch((e) => e);
      // Surfaced unchanged → the route returns this exact 503 (never a fake-ready result).
      expect(error).toBe(innerWsError);
      expect((error as FridayDomainError).httpStatus).toBe(503);
    });

    it("a NON-domain inner throw is wrapped as a typed 503 (never leaks as an unhandled throw)", async () => {
      const fake = makeFakeClient({ reject: new Error("socket ECONNREFUSED") });
      const adapter = createFridayMissionSpineDispatchAdapter({
        port: 48750,
        secretResolver: () => SECRET,
        createClient: fake.createClient,
      });

      const error = await adapter.intakeMission(INTAKE_REQ).catch((e) => e);
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe("MISSION_SPINE_DISPATCH_RUST_UNAVAILABLE");
      expect((error as FridayDomainError).httpStatus).toBe(503);
    });
  });

  describe("auto-dispatch driver hook (organic mission→run binding PRODUCER, dark)", () => {
    it("WITH the driver injected, a Ready intake invokes onIntakeReady(request, result) AFTER dispatch", async () => {
      const fake = makeFakeClient({ intake: INTAKE_RESULT });
      const onIntakeReady = vi.fn();
      const adapter = createFridayMissionSpineDispatchAdapter({
        port: 48750,
        secretResolver: () => SECRET,
        createClient: fake.createClient,
        autoDispatchDriver: { onIntakeReady },
      });

      const result = await adapter.intakeMission(INTAKE_REQ);

      // Result returned verbatim AND the hook saw the SAME request + result objects.
      expect(result).toBe(INTAKE_RESULT);
      expect(onIntakeReady).toHaveBeenCalledTimes(1);
      expect(onIntakeReady).toHaveBeenCalledWith(INTAKE_REQ, INTAKE_RESULT);
    });

    it("WITHOUT the driver (the default) intakeMission is byte-identical — no hook is invoked", async () => {
      const fake = makeFakeClient({ intake: INTAKE_RESULT });
      const adapter = createFridayMissionSpineDispatchAdapter({
        port: 48750,
        secretResolver: () => SECRET,
        createClient: fake.createClient,
        // autoDispatchDriver omitted ⇒ default ⇒ no hook.
      });

      const result = await adapter.intakeMission(INTAKE_REQ);

      expect(result).toBe(INTAKE_RESULT);
      // transitionMission / transitionWorkItem never call the hook either (they have no driver path).
      expect(fake.intakeCalls).toEqual([INTAKE_REQ]);
    });

    it("the hook is NOT invoked when the dispatch itself fails (the result never existed)", async () => {
      const fake = makeFakeClient({ reject: new Error("socket ECONNREFUSED") });
      const onIntakeReady = vi.fn();
      const adapter = createFridayMissionSpineDispatchAdapter({
        port: 48750,
        secretResolver: () => SECRET,
        createClient: fake.createClient,
        autoDispatchDriver: { onIntakeReady },
      });

      await expect(adapter.intakeMission(INTAKE_REQ)).rejects.toBeInstanceOf(FridayDomainError);
      expect(onIntakeReady).not.toHaveBeenCalled();
    });
  });

  // End-to-end seam: the REAL driver injected into the REAL adapter (no spy across the seam). This
  // is the only non-operator-gated proof that an organic intake actually PRODUCES a bound run. Note
  // the trigger requires a `workItemId` on the RESULT — a ready result WITHOUT one (the shared
  // INTAKE_RESULT above) would NOT fire, so this uses a COMPLETE ready result.
  describe("real driver THROUGH real adapter (composed, organic mission→run binding PRODUCER)", () => {
    const READY_WITH_WORK_ITEM: FridayRustHubMissionIntakeResult = {
      truthLabel: "rust_wired",
      fridayConversationId: "conv-from-SERVER",
      missionId: "mission-from-SERVER",
      workItemId: "wi-from-SERVER",
      surfaceThreadId: "thread-1",
      status: "ready",
      blockers: [],
      createdOrReady: true,
    };
    const BLOCKED: FridayRustHubMissionIntakeResult = {
      ...READY_WITH_WORK_ITEM,
      status: "blocked",
      blockers: ["duplicate_open_mission"],
      createdOrReady: false,
    };

    function composeAdapter(result: FridayRustHubMissionIntakeResult) {
      const fake = makeFakeClient({ intake: result });
      const startRun = vi.fn(async () => ({ runId: "run-1" })) as unknown as MissionAutoDispatchStartRun;
      const driver = createFridayMissionAutoDispatchDriver({
        startRun: () => startRun,
        deepseekProviderId: "deepseek",
        deepseekFlashModel: "deepseek-v4-flash",
        codexProviderId: "codex",
        codexModel: "gpt-5.5",
      });
      const adapter = createFridayMissionSpineDispatchAdapter({
        port: 48750,
        secretResolver: () => SECRET,
        createClient: fake.createClient,
        autoDispatchDriver: driver,
      });
      return { adapter, startRun };
    }

    it("a complete Ready intake PRODUCES a bound read-only run with the RESULT-derived handle", async () => {
      const { adapter, startRun } = composeAdapter(READY_WITH_WORK_ITEM);

      const returned = await adapter.intakeMission(INTAKE_REQ);
      // Intake result returned verbatim, immediately.
      expect(returned).toBe(READY_WITH_WORK_ITEM);
      // The fire-and-forget run is initiated synchronously inside the hook; flush a microtask.
      await Promise.resolve();

      expect(startRun).toHaveBeenCalledTimes(1);
      const arg = (startRun as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(arg).toMatchObject({
        providerId: "deepseek",
        model: "deepseek-v4-flash",
        constraints: { readOnly: true },
        allowedRustRouteTools: ["read_file", "list_dir", "stat_file", "search"],
      });
      // Handle is the SERVER RESULT ids — never the request body.
      expect(arg.missionContext).toEqual({
        fridayConversationId: "conv-from-SERVER",
        missionId: "mission-from-SERVER",
        workItemId: "wi-from-SERVER",
      });
      expect(arg.missionContext.missionId).not.toBe(INTAKE_REQ.missionId);
    });

    it("a blocked/duplicate intake PRODUCES NO run (no re-spend) and still returns the result", async () => {
      const { adapter, startRun } = composeAdapter(BLOCKED);

      const returned = await adapter.intakeMission(INTAKE_REQ);
      await Promise.resolve();

      expect(returned).toBe(BLOCKED);
      expect(startRun).not.toHaveBeenCalled();
    });
  });

  describe("readMissionSpineRustWsPort — replicates the agent-run port parse exactly", () => {
    it("absent / blank / non-finite / negative ⇒ 0; a valid port parses", () => {
      expect(readMissionSpineRustWsPort(undefined)).toBe(0);
      expect(readMissionSpineRustWsPort("")).toBe(0);
      expect(readMissionSpineRustWsPort("not-a-number")).toBe(0);
      expect(readMissionSpineRustWsPort("-5")).toBe(0);
      expect(readMissionSpineRustWsPort("48750")).toBe(48750);
      expect(readMissionSpineRustWsPort("0")).toBe(0);
    });
  });
});
