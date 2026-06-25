import { describe, expect, it } from "vitest";

import { FridayDomainError } from "../../../../src/errors/friday-domain-error.js";
import {
  buildRejectEnvelope,
  buildResumeEnvelope,
  createFridayRustHubAgentRunSealedClient,
  handlePaused,
  handleResult,
  handleServerClose,
  missionSpineUnavailableFromRustErrorEnvelope,
  parseControlResult,
  routeInboundEnvelope,
  type FridayRustHubAgentRunSealedDispatchOutcome,
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
function makeCtx(opts: { controlEnabled?: boolean } = {}): {
  ctx: InboundContext;
  succeeded: () => FridayRustHubAgentRunSealedDispatchOutcome | undefined;
  failed: () => FridayDomainError | undefined;
} {
  let succeededWith: FridayRustHubAgentRunSealedDispatchOutcome | undefined;
  let failedWith: FridayDomainError | undefined;
  let settled = false;
  const ctx: InboundContext = {
    sessionKey: new Uint8Array(0),
    refs: null,
    // (A3 courier) DEFAULT-OFF run-control flag — when omitted the paused branch is NOT recognized
    // (byte-identical to today). Tests opt in explicitly to exercise the paused settle.
    ...(opts.controlEnabled !== undefined ? { controlEnabled: opts.controlEnabled } : {}),
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

/** Narrow a settled outcome to the legacy refs-only result (asserts it is NOT a paused outcome). */
function asResult(
  outcome: FridayRustHubAgentRunSealedDispatchOutcome | undefined,
): FridayRustHubAgentRunSealedResult | undefined {
  if (outcome && "outcome" in outcome && outcome.outcome === "paused") {
    throw new Error("expected a refs-only result, got a paused outcome");
  }
  return outcome as FridayRustHubAgentRunSealedResult | undefined;
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
    const result = asResult(succeeded());
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

    const result = asResult(succeeded());
    expect(result?.turns).toBe(5);
    expect(result?.executedTools).toBe(3);
    // Token counts are DEFERRED server-side ⇒ omitted (never 0-faked).
    expect(result?.promptTokens).toBeUndefined();
    expect(result?.completionTokens).toBeUndefined();
  });
});

describe("friday-rust-hub-agent-run-ws-sealed-client mission-spine typed errors", () => {
  it("keeps Rust Error envelope diagnostics while still failing closed as a 503", () => {
    const err = missionSpineUnavailableFromRustErrorEnvelope("mission-intake", {
      kind: "Error",
      code: "Internal",
      message: "non-canonical Friday conversation id: codex-proof-conv-123",
    });

    expect(err).toBeInstanceOf(FridayDomainError);
    expect(err.code).toBe("MISSION_SPINE_RUST_AGENT_RUN_SEALED_WS_CLIENT_UNAVAILABLE");
    expect(err.httpStatus).toBe(503);
    expect(err.message).toContain("Rust Error envelope");
    expect(err.details).toMatchObject({
      surface: "service:rust_hub_agent_run_sealed_ws_client",
      bridge: "rust_wired",
      proofOnly: true,
      proofReady: false,
      leg: "mission-intake",
      rustError: {
        code: "Internal",
        message: "non-canonical Friday conversation id: codex-proof-conv-123",
      },
    });
  });

  it("maps mission-intake owner mismatch to a typed 403 without dropping Rust diagnostics", () => {
    const err = missionSpineUnavailableFromRustErrorEnvelope("mission-intake", {
      kind: "Error",
      code: "Internal",
      message: "mission intake owner_principal does not match the authenticated owner",
    });

    expect(err).toBeInstanceOf(FridayDomainError);
    expect(err.code).toBe("MISSION_SPINE_OWNER_PRINCIPAL_MISMATCH");
    expect(err.httpStatus).toBe(403);
    expect(err.message).toContain("owner_principal");
    expect(err.details).toMatchObject({
      surface: "service:rust_hub_agent_run_sealed_ws_client",
      bridge: "rust_wired",
      proofOnly: true,
      proofReady: false,
      leg: "mission-intake",
      rustError: {
        code: "Internal",
        message: "mission intake owner_principal does not match the authenticated owner",
      },
    });
  });
});

// (A3 courier) The pause/resume PRODUCT TRANSPORT — DARK, gated DEFAULT-OFF behind the courier's
// `agentRunControlViaRust` flag. These tests drive the EXPORTED settle handlers + the kind router
// against a fake InboundContext WITHOUT a socket. They prove:
//   (a) AgentRunPaused inbound → a refs-only paused outcome carrying the RIGHT refs (INV-1: no
//       signing material; the nonce→approvalId, action_digest→actionDigest, summary→ownerSealedSummary
//       mapping matches the merged `Message::AgentRunPaused` wire EXACTLY).
//   (b) resumeWithApproval sends `AgentRunResume {run_id, signed_blob}` UNCHANGED (the opaque blob
//       relayed verbatim; INV-1 pure courier) and parses the `AgentRunControlResult` reply.
//   (c) FLAG-OFF / no-pause is byte-identical: a flag-off `AgentRunPaused` is an unknown message ⇒
//       fail-closed (the SAME 503 as any unknown frame), and the `AgentRunResult` path is unchanged.
describe("friday-rust-hub-agent-run-ws-sealed-client A3 courier (pause/resume, dark, flag-gated)", () => {
  const PAUSED_FIELDS = {
    kind: "AgentRunPaused",
    run_id: "run-9",
    nonce: "approval-nonce-abc",
    action_digest: "d".repeat(64),
    summary: "write_file: /workspace/notes.md",
  };

  it("(a) AgentRunPaused inbound → a refs-only PAUSED outcome carrying the right refs (flag ON)", () => {
    const { ctx, succeeded, failed } = makeCtx({ controlEnabled: true });
    handlePaused(ctx, PAUSED_FIELDS);

    expect(failed()).toBeUndefined();
    const outcome = succeeded();
    // The mapping matches the merged `AgentRunPaused` wire EXACTLY: nonce→approvalId,
    // action_digest→actionDigest, summary→ownerSealedSummary. There is NO expiresAt on the wire.
    expect(outcome).toEqual({
      outcome: "paused",
      truthLabel: "rust_wired",
      runId: "run-9",
      approvalId: "approval-nonce-abc",
      actionDigest: "d".repeat(64),
      ownerSealedSummary: "write_file: /workspace/notes.md",
    });
    // INV-1: the paused outcome carries NO signing material / private key / blob / mutation body.
    const keys = Object.keys(outcome ?? {});
    for (const banned of ["signedBlob", "signed_blob", "privateKey", "signingKey", "body", "expiresAt"]) {
      expect(keys).not.toContain(banned);
    }
  });

  it("(a') a flag-ON AgentRunPaused via the kind ROUTER settles paused (not the unknown→fail path)", () => {
    const { ctx, succeeded, failed } = makeCtx({ controlEnabled: true });
    routeInboundEnvelope(ctx, { kind: "AgentRunPaused", fields: PAUSED_FIELDS });

    expect(failed()).toBeUndefined();
    const outcome = succeeded();
    expect(outcome && "outcome" in outcome && outcome.outcome).toBe("paused");
  });

  it("(a'') a paused frame MISSING a required ref (nonce) fails closed (503) — refs-surface contract", () => {
    const { ctx, succeeded, failed } = makeCtx({ controlEnabled: true });
    handlePaused(ctx, { kind: "AgentRunPaused", run_id: "run-9", action_digest: "d".repeat(64) });

    expect(succeeded()).toBeUndefined();
    expect(failed()?.httpStatus).toBe(503);
    expect(failed()?.message).toContain("pause is missing a required ref");
  });

  it("(a''') a paused frame WITHOUT a summary omits ownerSealedSummary (optional, never fabricated)", () => {
    const { ctx, succeeded } = makeCtx({ controlEnabled: true });
    handlePaused(ctx, {
      kind: "AgentRunPaused",
      run_id: "run-9",
      nonce: "approval-nonce-abc",
      action_digest: "d".repeat(64),
    });
    const outcome = succeeded();
    expect(outcome).toEqual({
      outcome: "paused",
      truthLabel: "rust_wired",
      runId: "run-9",
      approvalId: "approval-nonce-abc",
      actionDigest: "d".repeat(64),
    });
    expect(outcome && "ownerSealedSummary" in outcome).toBe(false);
  });

  it("(c) FLAG-OFF: an AgentRunPaused is an UNKNOWN message ⇒ fail-closed (byte-identical to today)", () => {
    // controlEnabled defaults OFF (omitted) — the SAME ctx shape today's code produces.
    const { ctx, succeeded, failed } = makeCtx();
    routeInboundEnvelope(ctx, { kind: "AgentRunPaused", fields: PAUSED_FIELDS });

    expect(succeeded()).toBeUndefined();
    const err = failed();
    expect(err?.httpStatus).toBe(503);
    // The EXACT same 503 message any unknown frame produces — a paused frame is not special with
    // the flag off, so the settle is indistinguishable from today's unknown→fail-closed.
    expect(err?.message).toContain("unknown message shape");
  });

  it("(c') FLAG-OFF: an AgentRunResult still settles UNCHANGED (the result path is flag-independent)", () => {
    const { ctx, succeeded, failed } = makeCtx(); // flag off
    routeInboundEnvelope(ctx, {
      kind: "AgentRunResult",
      fields: { kind: "AgentRunResult", run_id: "run-1", status: "finished" },
    });
    expect(failed()).toBeUndefined();
    expect(succeeded()).toEqual({ truthLabel: "rust_wired", runId: "run-1", status: "finished" });
  });

  it("(c'') FLAG-ON: an AgentRunResult still settles UNCHANGED (the flag never touches the result path)", () => {
    const { ctx, succeeded, failed } = makeCtx({ controlEnabled: true });
    routeInboundEnvelope(ctx, {
      kind: "AgentRunResult",
      fields: { kind: "AgentRunResult", run_id: "run-1", status: "finished", turns: 3, executed_tools: 2 },
    });
    expect(failed()).toBeUndefined();
    expect(asResult(succeeded())).toEqual({
      truthLabel: "rust_wired",
      runId: "run-1",
      status: "finished",
      turns: 3,
      executedTools: 2,
    });
  });

  // ── (b) the AgentRunResume WIRE SHAPE — buildResumeEnvelope sends it unchanged ────────────────
  it("(b) buildResumeEnvelope produces the EXACT merged AgentRunResume wire {run_id, signed_blob}", () => {
    const blob = new Uint8Array([0, 1, 250, 255, 42]);
    const envelope = buildResumeEnvelope("run-9", blob) as {
      schema_version: number;
      msg_id: string;
      correlation_id: string;
      sent_at: number;
      message: Record<string, unknown>;
    };
    // The inner message matches the merged `Message::AgentRunResume` EXACTLY: kind + run_id +
    // signed_blob. serde `Vec<u8>` is a JSON ARRAY of byte NUMBERS (NOT base64/hex) — the blob is
    // relayed VERBATIM via Array.from (same encoding as the dispatch envelope's auth_proof).
    expect(envelope.message).toEqual({
      kind: "AgentRunResume",
      run_id: "run-9",
      signed_blob: [0, 1, 250, 255, 42],
    });
    // INV-1: the message carries ONLY {kind, run_id, signed_blob} — no auth_proof, no forwarded
    // principal, no signing key, no derived/authored material. The blob is the operator's, opaque.
    expect(Object.keys(envelope.message).sort()).toEqual(["kind", "run_id", "signed_blob"]);
    expect(Array.isArray(envelope.message.signed_blob)).toBe(true);
    // The signed_blob is the byte-array of the SAME bytes (no transform, no truncation, no re-encode).
    expect(envelope.message.signed_blob).toEqual(Array.from(blob));
    // Envelope framing mirrors the dispatch envelope (schema version + correlation id on run id).
    expect(envelope.schema_version).toBe(12);
    expect(envelope.correlation_id).toBe("agent-run-resume-run-9");
  });

  it("(b0) buildRejectEnvelope produces the EXACT owner-authed AgentRunReject refs-only wire", () => {
    const authProof = new Uint8Array([9, 8, 7]);
    const envelope = buildRejectEnvelope("run-9", "approval-abc", "admin-001", authProof) as {
      schema_version: number;
      msg_id: string;
      correlation_id: string;
      message: Record<string, unknown>;
    };

    expect(envelope.schema_version).toBe(12);
    expect(envelope.msg_id).toBe("agent-run-reject-run-9-approval-abc");
    expect(envelope.correlation_id).toBe("agent-run-reject-run-9-approval-abc");
    expect(envelope.message).toEqual({
      kind: "AgentRunReject",
      run_id: "run-9",
      approval_id: "approval-abc",
      forwarded_principal: "admin-001",
      auth_proof: [9, 8, 7],
    });
    expect(Object.keys(envelope.message).sort()).toEqual([
      "approval_id",
      "auth_proof",
      "forwarded_principal",
      "kind",
      "run_id",
    ]);
  });

  // ── parseControlResult: the resume reply parse (the OTHER half of test b) ─────────────────────
  it("(b) parseControlResult maps an ACCEPTED AgentRunControlResult to a refs-only resume result", () => {
    const parsed = parseControlResult({
      kind: "AgentRunControlResult",
      run_id: "run-9",
      op: "resume",
      accepted: true,
      status: "executed",
      audit_ref: "audit:abc123",
    });
    expect(parsed).toEqual({
      truthLabel: "rust_wired",
      runId: "run-9",
      op: "resume",
      accepted: true,
      status: "executed",
      auditRef: "audit:abc123",
    });
  });

  it("(b') parseControlResult maps a REFUSAL (accepted=false) — a valid refusal outcome, not a parse error", () => {
    const parsed = parseControlResult({
      kind: "AgentRunControlResult",
      run_id: "run-9",
      op: "resume",
      accepted: false,
      status: "operator_vk_unprovisioned",
    });
    expect(parsed?.accepted).toBe(false);
    expect(parsed?.status).toBe("operator_vk_unprovisioned");
    expect(parsed && "auditRef" in parsed).toBe(false);
  });

  it("(b'') parseControlResult returns undefined for a frame missing a required ref / non-bool accepted", () => {
    expect(parseControlResult({ run_id: "run-9", op: "resume", status: "executed" })).toBeUndefined();
    expect(
      parseControlResult({ run_id: "run-9", op: "resume", status: "executed", accepted: "yes" }),
    ).toBeUndefined();
    expect(parseControlResult({ op: "resume", accepted: true, status: "executed" })).toBeUndefined();
  });

  // ── resumeWithApproval: the relay method ──────────────────────────────────────────────────────
  it("(b''') resumeWithApproval is FAIL-CLOSED when the run-control flag is OFF (relays nothing)", async () => {
    const client = createFridayRustHubAgentRunSealedClient({
      port: 1, // never dialed — the flag-off guard rejects before any connect
      clientSecret: new Uint8Array(32).fill(7),
    });
    await expect(
      client.resumeWithApproval({ runId: "run-9", opaqueSignedBlob: new Uint8Array([1, 2, 3]) }),
    ).rejects.toMatchObject({ httpStatus: 503 });
  });

  it("(b'''') resumeWithApproval (flag ON) rejects an EMPTY blob before opening a socket (INV-1 guard)", async () => {
    const client = createFridayRustHubAgentRunSealedClient({
      port: 1,
      clientSecret: new Uint8Array(32).fill(7),
      agentRunControlViaRust: true,
    });
    await expect(
      client.resumeWithApproval({ runId: "run-9", opaqueSignedBlob: new Uint8Array(0) }),
    ).rejects.toMatchObject({ httpStatus: 503 });
  });

  it("(b''''') resumeWithApproval (flag ON) rejects a missing run id before opening a socket", async () => {
    const client = createFridayRustHubAgentRunSealedClient({
      port: 1,
      clientSecret: new Uint8Array(32).fill(7),
      agentRunControlViaRust: true,
    });
    await expect(
      client.resumeWithApproval({ runId: "", opaqueSignedBlob: new Uint8Array([1, 2, 3]) }),
    ).rejects.toMatchObject({ httpStatus: 503 });
  });

  it("(b'''''') rejectApproval is FAIL-CLOSED when the run-control flag is OFF (relays nothing)", async () => {
    const client = createFridayRustHubAgentRunSealedClient({
      port: 1,
      clientSecret: new Uint8Array(32).fill(7),
    });
    await expect(
      client.rejectApproval({
        runId: "run-9",
        approvalId: "approval-abc",
        forwardedPrincipal: "admin-001",
      }),
    ).rejects.toMatchObject({ httpStatus: 503 });
  });

  it("(b''''''') rejectApproval (flag ON) rejects missing refs before opening a socket", async () => {
    const client = createFridayRustHubAgentRunSealedClient({
      port: 1,
      clientSecret: new Uint8Array(32).fill(7),
      agentRunControlViaRust: true,
    });
    await expect(
      client.rejectApproval({
        runId: "",
        approvalId: "approval-abc",
        forwardedPrincipal: "admin-001",
      }),
    ).rejects.toMatchObject({ httpStatus: 503 });
    await expect(
      client.rejectApproval({
        runId: "run-9",
        approvalId: "",
        forwardedPrincipal: "admin-001",
      }),
    ).rejects.toMatchObject({ httpStatus: 503 });
    await expect(
      client.rejectApproval({
        runId: "run-9",
        approvalId: "approval-abc",
        forwardedPrincipal: "",
      }),
    ).rejects.toMatchObject({ httpStatus: 503 });
  });
});
