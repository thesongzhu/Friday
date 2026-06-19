import { describe, expect, it, vi } from "vitest";

import {
  createFridayMissionAutoDispatchDriver,
  type MissionAutoDispatchStartRun,
} from "../../../../src/api/mission-spine/friday-mission-auto-dispatch-driver.js";
import {
  RUST_ROUTE_CLAUDE_MODEL,
  RUST_ROUTE_CLAUDE_PROVIDER_ID,
  RUST_ROUTE_CODEX_MISSION_DISPATCH_TIMEOUT_MS,
} from "../../../../src/api/runtime/friday-rust-route-constants.js";
import type {
  FridayRustHubMissionIntakeRequest,
  FridayRustHubMissionIntakeResult,
} from "../../../../src/api/mission-spine/friday-rust-hub-agent-run-ws-sealed-client.js";

// (Organic mission→run binding PRODUCER — DARK) The driver is the MISSING producer that originates a
// `mission_context` handle on a live run. These tests stub `startRun` and assert the trigger
// condition, the server-validated handle (NOT a raw client body), async/non-blocking dispatch, and
// full error isolation (a rejecting run never perturbs the intake path). The full WorkItem walk to
// `completed_with_proof` is the Rust bound seam (already tested); the live joined proof is operator-gated.

const DEEPSEEK_PROVIDER = "deepseek";
const DEEPSEEK_FLASH = "deepseek-v4-flash";
const CODEX_PROVIDER = "codex";
const CODEX_MODEL = "gpt-5.5";
const CLAUDE_PROVIDER = RUST_ROUTE_CLAUDE_PROVIDER_ID;
const CLAUDE_MODEL = RUST_ROUTE_CLAUDE_MODEL;
const READ_TOOLS = ["read_file", "list_dir", "stat_file", "search"];

const REQUEST: FridayRustHubMissionIntakeRequest = {
  fridayConversationId: "conv-req",
  ownerPrincipal: "principal-owner",
  surfaceThreadId: "thread-1",
  surfaceKind: "mobile",
  deliveryRoute: "mobile",
  visibilityPolicy: "owner_only",
  // Deliberately DIFFERENT ids from the RESULT below — the no-raw-body proof.
  missionId: "mission-from-REQUEST-body",
  workItemId: "wi-from-REQUEST-body",
  title: "Summarize the repo",
  intent: "produce a read-only overview",
  lane: "lane",
};

const READY_RESULT: FridayRustHubMissionIntakeResult = {
  truthLabel: "rust_wired",
  // The SERVER-PRODUCED handle — these are the values the driver MUST bind to.
  fridayConversationId: "conv-from-SERVER-result",
  missionId: "mission-from-SERVER-result",
  workItemId: "wi-from-SERVER-result",
  surfaceThreadId: "thread-1",
  status: "ready",
  blockers: [],
  createdOrReady: true,
};

const BLOCKED_RESULT: FridayRustHubMissionIntakeResult = {
  truthLabel: "rust_wired",
  fridayConversationId: "conv-from-SERVER-result",
  missionId: "mission-from-SERVER-result",
  surfaceThreadId: "thread-1",
  status: "blocked",
  blockers: ["duplicate_open_mission"],
  duplicateMissionId: "mission-existing",
  createdOrReady: false,
};

// (Mission-intake clarification — DARK) A `needs_clarification` result: the Rust producer asked
// clarifying questions for an UNDER-SPECIFIED intent and wrote ZERO rows (no workItemId, status is
// NOT "ready", createdOrReady is false). This is the INTERACTION GUARD fixture — it must NEVER
// trigger auto-dispatch (we never dispatch an under-specified mission).
const NEEDS_CLARIFICATION_RESULT: FridayRustHubMissionIntakeResult = {
  truthLabel: "rust_wired",
  fridayConversationId: "conv-from-SERVER-result",
  missionId: "mission-from-SERVER-result",
  surfaceThreadId: "thread-1",
  status: "needs_clarification",
  blockers: [],
  createdOrReady: false,
  clarificationQuestions: [
    "What outcome matters most for this decision?",
    "What constraints, risks, or non-goals must the plan respect?",
  ],
};

function makeDriver(opts?: {
  startRun?: MissionAutoDispatchStartRun | undefined;
  onDispatchError?: (error: unknown) => void;
}) {
  const startRunImpl =
    opts && "startRun" in opts
      ? opts.startRun
      : (vi.fn(async () => ({
          runId: "run-1",
        })) as MissionAutoDispatchStartRun);
  const startRun = startRunImpl;
  const driver = createFridayMissionAutoDispatchDriver({
    startRun: () => startRun,
    deepseekProviderId: DEEPSEEK_PROVIDER,
    deepseekFlashModel: DEEPSEEK_FLASH,
    codexProviderId: CODEX_PROVIDER,
    codexModel: CODEX_MODEL,
    claudeProviderId: CLAUDE_PROVIDER,
    claudeModel: CLAUDE_MODEL,
    ...(opts?.onDispatchError ? { onDispatchError: opts.onDispatchError } : {}),
  });
  return { driver, startRun };
}

describe("createFridayMissionAutoDispatchDriver (organic mission→run binding PRODUCER, dark)", () => {
  describe("trigger condition", () => {
    it("dispatches EXACTLY ONCE for a fresh-ready intake with the read-only bound shape", async () => {
      const startRun = vi.fn(async () => ({
        runId: "run-1",
      })) as unknown as MissionAutoDispatchStartRun;
      const driver = createFridayMissionAutoDispatchDriver({
        startRun: () => startRun,
        deepseekProviderId: DEEPSEEK_PROVIDER,
        deepseekFlashModel: DEEPSEEK_FLASH,
        codexProviderId: CODEX_PROVIDER,
        codexModel: CODEX_MODEL,
        claudeProviderId: CLAUDE_PROVIDER,
        claudeModel: CLAUDE_MODEL,
      });

      driver.onIntakeReady(REQUEST, READY_RESULT);
      // Async/non-blocking: the call returned synchronously; flush the microtask queue to let the
      // fire-and-forget promise resolve before asserting.
      await Promise.resolve();
      await Promise.resolve();

      expect(startRun).toHaveBeenCalledTimes(1);
      const arg = (startRun as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(arg).toMatchObject({
        task: "Summarize the repo — produce a read-only overview",
        principalId: "principal-owner",
        providerId: DEEPSEEK_PROVIDER,
        model: DEEPSEEK_FLASH,
        constraints: { readOnly: true },
        allowedRustRouteTools: READ_TOOLS,
      });
      expect(arg.timeoutMs).toBeUndefined();
    });

    it("dispatches a codex-targeted intake with the Codex observe-wrapper route shape", async () => {
      const startRun = vi.fn(async () => ({
        runId: "run-1",
      })) as unknown as MissionAutoDispatchStartRun;
      const driver = createFridayMissionAutoDispatchDriver({
        startRun: () => startRun,
        deepseekProviderId: DEEPSEEK_PROVIDER,
        deepseekFlashModel: DEEPSEEK_FLASH,
        codexProviderId: CODEX_PROVIDER,
        codexModel: CODEX_MODEL,
        claudeProviderId: CLAUDE_PROVIDER,
        claudeModel: CLAUDE_MODEL,
      });

      driver.onIntakeReady(
        {
          ...REQUEST,
          lane: "codex",
          targetProviderOrAgent: "codex",
        },
        READY_RESULT,
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(startRun).toHaveBeenCalledTimes(1);
      const arg = (startRun as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(arg).toMatchObject({
        principalId: "principal-owner",
        providerId: CODEX_PROVIDER,
        model: CODEX_MODEL,
        constraints: { readOnly: true },
        allowedRustRouteTools: READ_TOOLS,
        timeoutMs: RUST_ROUTE_CODEX_MISSION_DISPATCH_TIMEOUT_MS,
        missionContext: {
          fridayConversationId: "conv-from-SERVER-result",
          missionId: "mission-from-SERVER-result",
          workItemId: "wi-from-SERVER-result",
        },
      });
    });

    it("uses the Rust-selected route for lane=auto instead of re-reading the raw request", async () => {
      const startRun = vi.fn(async () => ({
        runId: "run-1",
      })) as unknown as MissionAutoDispatchStartRun;
      const driver = createFridayMissionAutoDispatchDriver({
        startRun: () => startRun,
        deepseekProviderId: DEEPSEEK_PROVIDER,
        deepseekFlashModel: DEEPSEEK_FLASH,
        codexProviderId: CODEX_PROVIDER,
        codexModel: CODEX_MODEL,
        claudeProviderId: CLAUDE_PROVIDER,
        claudeModel: CLAUDE_MODEL,
      });

      driver.onIntakeReady(
        {
          ...REQUEST,
          lane: "auto",
          targetProviderOrAgent: undefined,
        },
        {
          ...READY_RESULT,
          selectedLane: "codex",
          selectedTargetProviderOrAgent: "codex",
        },
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(startRun).toHaveBeenCalledTimes(1);
      const arg = (startRun as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(arg).toMatchObject({
        providerId: CODEX_PROVIDER,
        model: CODEX_MODEL,
        timeoutMs: RUST_ROUTE_CODEX_MISSION_DISPATCH_TIMEOUT_MS,
      });
    });

    it("dispatches a claude-targeted intake with the Claude mission-bound route shape", async () => {
      const startRun = vi.fn(async () => ({
        runId: "run-1",
      })) as unknown as MissionAutoDispatchStartRun;
      const driver = createFridayMissionAutoDispatchDriver({
        startRun: () => startRun,
        deepseekProviderId: DEEPSEEK_PROVIDER,
        deepseekFlashModel: DEEPSEEK_FLASH,
        codexProviderId: CODEX_PROVIDER,
        codexModel: CODEX_MODEL,
        claudeProviderId: CLAUDE_PROVIDER,
        claudeModel: CLAUDE_MODEL,
      });

      driver.onIntakeReady(
        {
          ...REQUEST,
          lane: "claude",
          targetProviderOrAgent: "claude",
        },
        READY_RESULT,
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(startRun).toHaveBeenCalledTimes(1);
      const arg = (startRun as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(arg).toMatchObject({
        principalId: "principal-owner",
        providerId: CLAUDE_PROVIDER,
        model: CLAUDE_MODEL,
        constraints: { readOnly: true },
        allowedRustRouteTools: READ_TOOLS,
        missionContext: {
          fridayConversationId: "conv-from-SERVER-result",
          missionId: "mission-from-SERVER-result",
          workItemId: "wi-from-SERVER-result",
        },
      });
      expect(arg.timeoutMs).toBeUndefined();
    });

    it("does NOT dispatch for a blocked/duplicate intake (no re-spend)", async () => {
      const { driver, startRun } = makeDriver();

      driver.onIntakeReady(REQUEST, BLOCKED_RESULT);
      await Promise.resolve();
      await Promise.resolve();

      expect(startRun).not.toHaveBeenCalled();
    });

    it("does NOT dispatch when createdOrReady is false even if status is 'ready'", async () => {
      const { driver, startRun } = makeDriver();

      driver.onIntakeReady(REQUEST, { ...READY_RESULT, createdOrReady: false });
      await Promise.resolve();
      await Promise.resolve();

      expect(startRun).not.toHaveBeenCalled();
    });

    it("does NOT dispatch when the result carries no workItemId", async () => {
      const { driver, startRun } = makeDriver();
      const { workItemId: _omit, ...noWorkItem } = READY_RESULT;
      void _omit;

      driver.onIntakeReady(
        REQUEST,
        noWorkItem as FridayRustHubMissionIntakeResult,
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(startRun).not.toHaveBeenCalled();
    });

    // INTERACTION GUARD (Mission-intake clarification × auto-dispatch): a needs_clarification result
    // (status !== "ready", createdOrReady false, no workItemId) must NEVER auto-dispatch. The driver
    // keys on `status === "ready"`, so this naturally won't fire — this test PINS that invariant so
    // we can never auto-dispatch an under-specified mission.
    it("does NOT dispatch for a needs_clarification result (never dispatch an under-specified mission)", async () => {
      const { driver, startRun } = makeDriver();

      driver.onIntakeReady(REQUEST, NEEDS_CLARIFICATION_RESULT);
      await Promise.resolve();
      await Promise.resolve();

      expect(startRun).not.toHaveBeenCalled();
    });
  });

  describe("the handle is the SERVER-PRODUCED result — never a raw client body", () => {
    it("binds missionContext to the RESULT ids, NOT the (different) REQUEST body ids", async () => {
      const startRun = vi.fn(async () => ({
        runId: "run-1",
      })) as unknown as MissionAutoDispatchStartRun;
      const driver = createFridayMissionAutoDispatchDriver({
        startRun: () => startRun,
        deepseekProviderId: DEEPSEEK_PROVIDER,
        deepseekFlashModel: DEEPSEEK_FLASH,
        codexProviderId: CODEX_PROVIDER,
        codexModel: CODEX_MODEL,
        claudeProviderId: CLAUDE_PROVIDER,
        claudeModel: CLAUDE_MODEL,
      });

      driver.onIntakeReady(REQUEST, READY_RESULT);
      await Promise.resolve();
      await Promise.resolve();

      const arg = (startRun as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(arg.missionContext).toEqual({
        fridayConversationId: "conv-from-SERVER-result",
        missionId: "mission-from-SERVER-result",
        workItemId: "wi-from-SERVER-result",
      });
      // The REQUEST body ids must NOT have leaked into the handle.
      expect(arg.missionContext.missionId).not.toBe(REQUEST.missionId);
      expect(arg.missionContext.workItemId).not.toBe(REQUEST.workItemId);
      expect(arg.missionContext.fridayConversationId).not.toBe(
        REQUEST.fridayConversationId,
      );
    });
  });

  describe("async / non-blocking + error isolation (NO-DEGRADE)", () => {
    it("onIntakeReady returns synchronously WITHOUT awaiting the run", () => {
      let resolveRun: (() => void) | undefined;
      const startRun = vi.fn(
        () =>
          new Promise<{ runId: string }>((resolve) => {
            resolveRun = () => resolve({ runId: "run-1" });
          }),
      ) as unknown as MissionAutoDispatchStartRun;
      const driver = createFridayMissionAutoDispatchDriver({
        startRun: () => startRun,
        deepseekProviderId: DEEPSEEK_PROVIDER,
        deepseekFlashModel: DEEPSEEK_FLASH,
        codexProviderId: CODEX_PROVIDER,
        codexModel: CODEX_MODEL,
        claudeProviderId: CLAUDE_PROVIDER,
        claudeModel: CLAUDE_MODEL,
      });

      // The call must return (void) BEFORE the run promise settles — proving non-blocking.
      const returned = driver.onIntakeReady(REQUEST, READY_RESULT);
      expect(returned).toBeUndefined();
      // The run is still pending here (we have not resolved it).
      expect(resolveRun).toBeDefined();
      resolveRun?.();
    });

    it("a REJECTING startRun never throws into the intake path (routed to onDispatchError)", async () => {
      const onDispatchError = vi.fn();
      const startRun = vi.fn(async () => {
        throw new Error("run dispatch failed (e.g. flags misaligned → 503)");
      }) as unknown as MissionAutoDispatchStartRun;
      const driver = createFridayMissionAutoDispatchDriver({
        startRun: () => startRun,
        deepseekProviderId: DEEPSEEK_PROVIDER,
        deepseekFlashModel: DEEPSEEK_FLASH,
        codexProviderId: CODEX_PROVIDER,
        codexModel: CODEX_MODEL,
        claudeProviderId: CLAUDE_PROVIDER,
        claudeModel: CLAUDE_MODEL,
        onDispatchError,
      });

      // No throw, no unhandled rejection.
      expect(() => driver.onIntakeReady(REQUEST, READY_RESULT)).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();
      expect(onDispatchError).toHaveBeenCalledTimes(1);
      expect(onDispatchError.mock.calls[0][0]).toBeInstanceOf(Error);
    });

    it("a startRun thunk returning undefined (runtime had no agent surface) is a harmless no-op", () => {
      const driver = createFridayMissionAutoDispatchDriver({
        startRun: () => undefined,
        deepseekProviderId: DEEPSEEK_PROVIDER,
        deepseekFlashModel: DEEPSEEK_FLASH,
        codexProviderId: CODEX_PROVIDER,
        codexModel: CODEX_MODEL,
        claudeProviderId: CLAUDE_PROVIDER,
        claudeModel: CLAUDE_MODEL,
      });

      expect(() => driver.onIntakeReady(REQUEST, READY_RESULT)).not.toThrow();
    });
  });
});
