import { describe, expect, it, vi } from "vitest";

import { FridayDomainError } from "../../../../src/errors/friday-domain-error.js";
import { createFridayRustHubAgentRunSealedClientService } from "../../../../src/api/mission-spine/friday-rust-hub-agent-run-sealed-client-service.js";
import type {
  CreateFridayRustHubAgentRunSealedClientOptions,
  FridayRustHubAgentRunSealedClient,
  FridayRustHubAgentRunSealedResult,
} from "../../../../src/api/mission-spine/friday-rust-hub-agent-run-ws-sealed-client.js";

// execrun B1-compose (DARK): the service ADAPTER that lets compose drive the PROVEN sealed WS
// client through a `dispatchRun({...,clientSecret})` seam over the REAL ECDH protocol. These tests
// mock the underlying sealed client at the `createClient` seam — so we exercise the adapter's
// wiring / refs-mapping / fail-closed WITHOUT a socket and WITHOUT re-proving the (already-proven)
// interop. The RAW sealed client↔server interop is proven elsewhere (KAT 9/9 + interop 3/3 + live).

const SECRET = new Uint8Array(32).fill(7);

/** A fake underlying sealed client + a recorder of how it was constructed/dispatched. */
function makeFakeClient(behavior: {
  result?: FridayRustHubAgentRunSealedResult;
  reject?: unknown;
}) {
  const constructed: CreateFridayRustHubAgentRunSealedClientOptions[] = [];
  const dispatched: Array<{
    runId: string;
    task: string;
    forwardedPrincipal: string;
    sessionKey?: string;
  }> = [];
  const createClient = vi.fn(
    (options: CreateFridayRustHubAgentRunSealedClientOptions): FridayRustHubAgentRunSealedClient => {
      constructed.push(options);
      return {
        dispatchRun: vi.fn(async (req) => {
          dispatched.push(req);
          if (behavior.reject !== undefined) {
            throw behavior.reject;
          }
          return behavior.result!;
        }),
      };
    },
  );
  return { createClient, constructed, dispatched };
}

describe("createFridayRustHubAgentRunSealedClientService (B1-compose, dark, adapter)", () => {
  it("factory is SIDE-EFFECT-FREE: constructs no underlying client until dispatchRun is called", () => {
    const fake = makeFakeClient({ result: deliveredResult() });
    createFridayRustHubAgentRunSealedClientService({
      host: "127.0.0.1",
      port: 4123,
      createClient: fake.createClient,
    });
    // No socket, no underlying client, no secret touched at construction time.
    expect(fake.createClient).not.toHaveBeenCalled();
  });

  it("threads host/port/timeout + the per-dispatch clientSecret into the underlying client", async () => {
    const fake = makeFakeClient({ result: deliveredResult() });
    const service = createFridayRustHubAgentRunSealedClientService({
      host: "127.0.0.1",
      port: 4123,
      timeoutMs: 5_000,
      createClient: fake.createClient,
    });

    await service.dispatchRun({
      runId: "run-1",
      task: "read README.md",
      forwardedPrincipal: "owner-1",
      clientSecret: SECRET,
    });

    expect(fake.createClient).toHaveBeenCalledTimes(1);
    const opts = fake.constructed[0];
    expect(opts.host).toBe("127.0.0.1");
    expect(opts.port).toBe(4123);
    expect(opts.timeoutMs).toBe(5_000);
    expect(Buffer.from(opts.clientSecret).equals(Buffer.from(SECRET))).toBe(true);
    // The dispatch carried the run fields (NOT the secret — the secret is on the constructor).
    expect(fake.dispatched).toHaveLength(1);
    expect(fake.dispatched[0]).toMatchObject({
      runId: "run-1",
      task: "read README.md",
      forwardedPrincipal: "owner-1",
    });
  });

  it("maps the sealed result to REFS-ONLY (the client no longer carries an in-band body)", async () => {
    // (leg-A decouple, #655 Part 4) The underlying sealed client now SETTLES on the refs envelope
    // alone and surfaces NO `body` — so the adapter receives refs-only and maps refs-only. (The
    // adapter already dropped any body; this asserts the post-decouple shape end-to-end.)
    const fake = makeFakeClient({
      result: {
        truthLabel: "rust_wired",
        runId: "run-1",
        status: "finished",
        answerSha256: "a".repeat(64),
        answerLen: 4,
      },
    });
    const service = createFridayRustHubAgentRunSealedClientService({
      port: 4123,
      createClient: fake.createClient,
    });

    const result = await service.dispatchRun({
      runId: "run-1",
      task: "ping",
      forwardedPrincipal: "owner-1",
      clientSecret: SECRET,
    });

    expect(result).toEqual({
      truthLabel: "rust_wired",
      runId: "run-1",
      status: "finished",
      answerSha256: "a".repeat(64),
      answerLen: 4,
    });
    // No body is surfaced (compose's body source is the slice-3 owner-gated DB readback).
    expect("body" in result).toBe(false);
  });

  it("maps a no-answer result (no fingerprint) to refs-only with the bare status", async () => {
    const fake = makeFakeClient({
      result: { truthLabel: "rust_wired", runId: "run-1", status: "no_answer" },
    });
    const service = createFridayRustHubAgentRunSealedClientService({
      port: 4123,
      createClient: fake.createClient,
    });

    const result = await service.dispatchRun({
      runId: "run-1",
      task: "ping",
      forwardedPrincipal: "owner-1",
      clientSecret: SECRET,
    });

    expect(result).toEqual({ truthLabel: "rust_wired", runId: "run-1", status: "no_answer" });
    expect(result.answerSha256).toBeUndefined();
    expect(result.answerLen).toBeUndefined();
  });

  it("surfaces the underlying client's FridayDomainError (503) unchanged on a closed session", async () => {
    const domainErr = new FridayDomainError(
      "MISSION_SPINE_RUST_AGENT_RUN_SEALED_WS_CLIENT_UNAVAILABLE",
      "Sealed agent-run client connection closed before a result.",
      { httpStatus: 503 },
    );
    const fake = makeFakeClient({ reject: domainErr });
    const service = createFridayRustHubAgentRunSealedClientService({
      port: 4123,
      createClient: fake.createClient,
    });

    await expect(
      service.dispatchRun({
        runId: "run-1",
        task: "ping",
        forwardedPrincipal: "owner-1",
        clientSecret: SECRET,
      }),
    ).rejects.toBe(domainErr);
  });

  it("wraps a NON-domain throw as a fail-closed 503", async () => {
    const fake = makeFakeClient({ reject: new Error("raw socket boom") });
    const service = createFridayRustHubAgentRunSealedClientService({
      port: 4123,
      createClient: fake.createClient,
    });

    await expect(
      service.dispatchRun({
        runId: "run-1",
        task: "ping",
        forwardedPrincipal: "owner-1",
        clientSecret: SECRET,
      }),
    ).rejects.toMatchObject({ httpStatus: 503 });
  });

  it("(A2a Phase 1) forwards a NON-EMPTY sessionKey to the underlying client", async () => {
    const fake = makeFakeClient({ result: deliveredResult() });
    const service = createFridayRustHubAgentRunSealedClientService({
      port: 4123,
      createClient: fake.createClient,
    });
    await service.dispatchRun({
      runId: "run-1",
      task: "compare it to the other file",
      forwardedPrincipal: "owner-1",
      clientSecret: SECRET,
      sessionKey: "chat-session-xyz",
    });
    expect(fake.dispatched[0].sessionKey).toBe("chat-session-xyz");
  });

  it("(A2a Phase 1) does NOT set sessionKey on the inner dispatch when it is absent (byte-identical sessionless)", async () => {
    const fake = makeFakeClient({ result: deliveredResult() });
    const service = createFridayRustHubAgentRunSealedClientService({
      port: 4123,
      createClient: fake.createClient,
    });
    await service.dispatchRun({
      runId: "run-1",
      task: "read README.md",
      forwardedPrincipal: "owner-1",
      clientSecret: SECRET,
      // no sessionKey
    });
    expect("sessionKey" in fake.dispatched[0]).toBe(false);
  });

  it("fails closed (503) when the underlying client construction throws (e.g. a non-32-byte secret)", async () => {
    // The default REAL sealed client throws a RangeError on a non-32-byte secret. Prove the adapter
    // maps a construction throw to a 503 (rather than letting the RangeError escape).
    const service = createFridayRustHubAgentRunSealedClientService({
      port: 4123,
      createClient: () => {
        throw new RangeError("clientSecret must be 32 bytes");
      },
    });

    await expect(
      service.dispatchRun({
        runId: "run-1",
        task: "ping",
        forwardedPrincipal: "owner-1",
        clientSecret: new Uint8Array(16),
      }),
    ).rejects.toMatchObject({ httpStatus: 503 });
  });
});

function deliveredResult(): FridayRustHubAgentRunSealedResult {
  // (leg-A decouple, #655 Part 4) A delivered result is REFS-ONLY — the client no longer surfaces
  // an in-band body; the owner-gated DB readback supplies the answer to compose.
  return {
    truthLabel: "rust_wired",
    runId: "run-1",
    status: "finished",
    answerSha256: "a".repeat(64),
    answerLen: 4,
  };
}
