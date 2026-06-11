import { describe, expect, it } from "vitest";

import { FridayDomainError } from "../../../../src/errors/friday-domain-error.js";
import {
  handleResult,
  handleServerClose,
  type FridayRustHubAgentRunSealedResult,
  type InboundContext,
} from "../../../../src/api/mission-spine/friday-rust-hub-agent-run-ws-sealed-client.js";

// (leg-A decouple, #655 Part 4) The sealed WS client now SETTLES on the FIRST (refs) envelope
// ALONE — it no longer awaits or surfaces the SECOND owner-sealed body frame. compose sources the
// authoritative answer body from the owner-gated DB readback, and the Rust server persists the
// body to the Hub DB BEFORE emitting refs (so a committed row always exists when refs arrive).
//
// These tests drive the EXPORTED settle handlers against a fake InboundContext — proving the
// settle-branch logic WITHOUT a socket. The REAL socket round-trip (TS-seal → Rust-open over the
// genuine sealed protocol, refs settle, body send still lands server-side) is proven by the Rust
// `#[ignore]` interop test `interop_ts_client_full_round_trip_pong` (run with --ignored), which
// also asserts the client surfaces NO body and the server still serves Ok(1).

/** A fake InboundContext that records exactly one terminal settle (succeed XOR fail). */
function makeCtx(): {
  ctx: InboundContext;
  succeeded: () => FridayRustHubAgentRunSealedResult | undefined;
  failed: () => FridayDomainError | undefined;
} {
  let succeededWith: FridayRustHubAgentRunSealedResult | undefined;
  let failedWith: FridayDomainError | undefined;
  let settled = false;
  const ctx: InboundContext = {
    sessionKey: new Uint8Array(0),
    refs: null,
    succeed(result) {
      if (settled) return;
      settled = true;
      succeededWith = result;
    },
    fail(error) {
      if (settled) return;
      settled = true;
      failedWith = error;
    },
  };
  return { ctx, succeeded: () => succeededWith, failed: () => failedWith };
}

describe("friday-rust-hub-agent-run-ws-sealed-client settle handlers (leg-A decouple)", () => {
  it("(a) settles on a DELIVERED refs envelope ALONE — no body frame awaited, no body surfaced", () => {
    const { ctx, succeeded, failed } = makeCtx();
    handleResult(ctx, {
      kind: "AgentRunResult",
      run_id: "run-1",
      status: "finished",
      answer_sha256: "a".repeat(64),
      answer_len: 4,
      turns: 2,
      executed_tools: 1,
    });

    // Settled SYNCHRONOUSLY on the refs — even though a fingerprint (sha256/len) is present, the
    // client no longer waits for the SECOND (body) envelope.
    expect(failed()).toBeUndefined();
    const result = succeeded();
    expect(result).toEqual({
      truthLabel: "rust_wired",
      runId: "run-1",
      status: "finished",
      answerSha256: "a".repeat(64),
      answerLen: 4,
      turns: 2,
      executedTools: 1,
    });
    // The decoupled client carries NO body — compose's body source is the owner-gated DB readback.
    expect(result && "body" in result).toBe(false);
  });

  it("(a') settles on a NO-ANSWER refs envelope (no fingerprint) — refs-only, bare status", () => {
    const { ctx, succeeded, failed } = makeCtx();
    handleResult(ctx, { kind: "AgentRunResult", run_id: "run-1", status: "no_answer" });

    expect(failed()).toBeUndefined();
    expect(succeeded()).toEqual({
      truthLabel: "rust_wired",
      runId: "run-1",
      status: "no_answer",
    });
  });

  it("(b) a server close BEFORE any refs stays FAIL-CLOSED (503) — forged peer / bad principal", () => {
    const { ctx, succeeded, failed } = makeCtx();
    // No refs accumulated (the server established no session / ran nothing) → close → 503.
    handleServerClose(ctx);

    expect(succeeded()).toBeUndefined();
    const err = failed();
    expect(err).toBeInstanceOf(FridayDomainError);
    expect(err?.httpStatus).toBe(503);
    expect(err?.message).toContain("closed before a result");
  });

  it("(b') a server close AFTER the client already settled on refs is a guarded no-op (no double-settle)", () => {
    const { ctx, succeeded, failed } = makeCtx();
    handleResult(ctx, {
      kind: "AgentRunResult",
      run_id: "run-1",
      status: "finished",
      answer_sha256: "a".repeat(64),
      answer_len: 4,
    });
    // The client settled on refs; the later session close must NOT flip the result to a 503.
    handleServerClose(ctx);

    expect(failed()).toBeUndefined();
    expect(succeeded()?.status).toBe("finished");
  });

  it("(c) a refs envelope MISSING a required ref (run_id) fails closed (503) — refs-surface contract preserved", () => {
    const { ctx, succeeded, failed } = makeCtx();
    handleResult(ctx, { kind: "AgentRunResult", status: "finished" });

    expect(succeeded()).toBeUndefined();
    const err = failed();
    expect(err?.httpStatus).toBe(503);
    expect(err?.message).toContain("missing a required ref");
  });

  it("(c') a refs envelope MISSING status fails closed (503)", () => {
    const { ctx, succeeded, failed } = makeCtx();
    handleResult(ctx, { kind: "AgentRunResult", run_id: "run-1" });

    expect(succeeded()).toBeUndefined();
    expect(failed()?.httpStatus).toBe(503);
  });

  it("(c'') an ABSENT fingerprint with a non-numeric answer_len is treated as no-answer (no 0-fake, no body)", () => {
    const { ctx, succeeded, failed } = makeCtx();
    handleResult(ctx, {
      kind: "AgentRunResult",
      run_id: "run-1",
      status: "no_answer",
      // Non-numeric / absent counts must be OMITTED (undefined), never coerced to 0.
      answer_len: "not-a-number",
      turns: null,
    });

    expect(failed()).toBeUndefined();
    const result = succeeded();
    expect(result?.answerLen).toBeUndefined();
    expect(result?.turns).toBeUndefined();
    expect(result && "body" in result).toBe(false);
  });

  it("surfaces the A1 run COUNTS from the refs when the server carried them (counts only, never a body)", () => {
    const { ctx, succeeded } = makeCtx();
    handleResult(ctx, {
      kind: "AgentRunResult",
      run_id: "run-1",
      status: "finished",
      answer_sha256: "b".repeat(64),
      answer_len: 7,
      turns: 5,
      executed_tools: 3,
    });

    const result = succeeded();
    expect(result?.turns).toBe(5);
    expect(result?.executedTools).toBe(3);
    // Token counts are DEFERRED server-side ⇒ omitted (never 0-faked).
    expect(result?.promptTokens).toBeUndefined();
    expect(result?.completionTokens).toBeUndefined();
  });
});
