import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";

import { FridayDomainError } from "../../../../src/errors/friday-domain-error.js";
import {
  createFridayRustHubAgentRunWsClientService,
  type FridayRustHubAgentRunWsRequest,
} from "../../../../src/api/mission-spine/friday-rust-hub-agent-run-ws-client.js";

/**
 * WS-transport substrate sub-slice S-D (DARK, refs-only) — TS agent-run WS CLIENT test.
 *
 * Hermetic: every test drives a REAL in-process `ws` `WebSocketServer` bound to
 * `127.0.0.1:0` (ephemeral port) — NO real Rust bin, NO provider, NO network egress
 * beyond loopback-to-stub. The stub server scripts the server side of the S-A
 * `AgentRunRequest`/`AgentRunResult` exchange so each fail-closed branch (connection
 * error / unexpected close / timeout / malformed JSON / unknown shape / missing ref)
 * is exercised against a REAL socket, and the refs-only / body-drop contract is proven
 * end-to-end.
 *
 * The composition slice (S-F) wires this client into a route; this test only proves
 * the dark client parses the wire faithfully and fails closed.
 */

/** A request fixture — the proof bytes are shape-only on the wire (not trusted here). */
const REQUEST: FridayRustHubAgentRunWsRequest = {
  runId: "agent_run_probe",
  task: "summarize the changelog",
  forwardedPrincipal: "principal:owner-alice",
  authProof: new Uint8Array([1, 2, 3, 4]),
};

/** A server-side scripted handler: given the inbound raw request, return a reply or null. */
type ScriptedServer = {
  readonly port: number;
  close(): Promise<void>;
};

/**
 * Start a stub WS server on an ephemeral loopback port. `onMessage` receives the raw
 * inbound frame and returns the raw string to send back (or `null` to send nothing).
 * If `onConnect` is provided it runs first (e.g. to close the socket abruptly).
 */
async function startStubServer(opts: {
  onMessage?: (raw: string, socket: WsSocket) => string | null;
  onConnect?: (socket: WsSocket) => void;
}): Promise<ScriptedServer> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  server.on("connection", (socket) => {
    opts.onConnect?.(socket);
    socket.on("message", (data) => {
      const reply = opts.onMessage?.(data.toString(), socket);
      if (reply !== null && reply !== undefined) socket.send(reply);
    });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of server.clients) c.terminate();
        server.close(() => resolve());
      }),
  };
}

/** Assert a thrown value is the slice's 503-shaped fail-closed error. */
function expectFailClosed(error: unknown): FridayDomainError {
  expect(error).toBeInstanceOf(FridayDomainError);
  const domain = error as FridayDomainError;
  expect(domain.httpStatus).toBe(503);
  expect(domain.code).toBe("MISSION_SPINE_RUST_AGENT_RUN_WS_CLIENT_UNAVAILABLE");
  return domain;
}

describe("friday-rust-hub-agent-run-ws-client (S-D dark refs-only WS client)", () => {
  let stub: ScriptedServer | undefined;

  afterEach(async () => {
    if (stub) {
      await stub.close();
      stub = undefined;
    }
  });

  it("round-trips a well-formed AgentRunResult to exactly the refs fields", async () => {
    stub = await startStubServer({
      onMessage: () =>
        JSON.stringify({
          kind: "AgentRunResult",
          run_id: "agent_run_probe",
          status: "completed",
          answer_sha256: "a".repeat(64),
          answer_len: 1234,
        }),
    });
    const service = createFridayRustHubAgentRunWsClientService({ port: stub.port });

    const result = await service.dispatchRun(REQUEST);

    expect(result).toEqual({
      truthLabel: "rust_wired",
      runId: "agent_run_probe",
      status: "completed",
      answerSha256: "a".repeat(64),
      answerLen: 1234,
    });
    // The wire keys surfaced are EXACTLY the refs set (+ the local truth label).
    expect(Object.keys(result).sort()).toEqual(
      ["answerLen", "answerSha256", "runId", "status", "truthLabel"].sort(),
    );
  });

  it("accepts a well-formed result with NO answer refs (optional fields absent)", async () => {
    stub = await startStubServer({
      onMessage: () =>
        JSON.stringify({
          kind: "AgentRunResult",
          run_id: "agent_run_probe",
          status: "no_answer",
        }),
    });
    const service = createFridayRustHubAgentRunWsClientService({ port: stub.port });

    const result = await service.dispatchRun(REQUEST);

    expect(result).toEqual({
      truthLabel: "rust_wired",
      runId: "agent_run_probe",
      status: "no_answer",
    });
    expect("answerSha256" in result).toBe(false);
    expect("answerLen" in result).toBe(false);
  });

  it("sends an AgentRunRequest-shaped frame (refs-only request, shape-only proof)", async () => {
    let received: unknown;
    stub = await startStubServer({
      onMessage: (raw) => {
        received = JSON.parse(raw);
        return JSON.stringify({ kind: "AgentRunResult", run_id: "agent_run_probe", status: "completed" });
      },
    });
    const service = createFridayRustHubAgentRunWsClientService({ port: stub.port });

    await service.dispatchRun(REQUEST);

    expect(received).toEqual({
      kind: "AgentRunRequest",
      run_id: "agent_run_probe",
      task: "summarize the changelog",
      forwarded_principal: "principal:owner-alice",
      auth_proof: [1, 2, 3, 4],
    });
  });

  it("does NOT leak a body when the server smuggles one — only refs surface", async () => {
    const SECRET = "TOP-SECRET ANSWER BODY THAT MUST NEVER REACH THE CLIENT"; // pragma: allowlist secret
    stub = await startStubServer({
      onMessage: () =>
        JSON.stringify({
          kind: "AgentRunResult",
          run_id: "agent_run_probe",
          status: "completed",
          answer_sha256: "b".repeat(64),
          answer_len: SECRET.length,
          // Pathological body-bearing fields the client must DROP (not 503 on).
          answer: SECRET,
          final_message: SECRET,
          body: SECRET,
        }),
    });
    const service = createFridayRustHubAgentRunWsClientService({ port: stub.port });

    // Body-bearing is a SUCCESS that drops the body — NOT a fail-closed error.
    const result = await service.dispatchRun(REQUEST);

    expect(result).toEqual({
      truthLabel: "rust_wired",
      runId: "agent_run_probe",
      status: "completed",
      answerSha256: "b".repeat(64),
      answerLen: SECRET.length,
    });
    // The secret body appears NOWHERE in the surfaced receipt.
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect("answer" in result).toBe(false);
    expect("final_message" in result).toBe(false);
    expect("body" in result).toBe(false);
  });

  // ── Fail-closed branches: each → a 503-shaped error with NO body. ──

  it("fails closed on a connection error (server refused)", async () => {
    // Bind a server, capture its port, then close it so the connect is refused.
    const ephemeral = await startStubServer({});
    const port = ephemeral.port;
    await ephemeral.close();
    const service = createFridayRustHubAgentRunWsClientService({ port, timeoutMs: 2_000 });

    const error = await service.dispatchRun(REQUEST).catch((e: unknown) => e);
    expectFailClosed(error);
  });

  it("fails closed on an unexpected close before a result", async () => {
    stub = await startStubServer({
      // Accept the connection, then close it abruptly without ever replying.
      onConnect: (socket) => socket.close(),
    });
    const service = createFridayRustHubAgentRunWsClientService({ port: stub.port, timeoutMs: 2_000 });

    const error = await service.dispatchRun(REQUEST).catch((e: unknown) => e);
    expectFailClosed(error);
  });

  it("fails closed on a bounded timeout (server never replies)", async () => {
    stub = await startStubServer({
      // Accept + read the request but never send a result.
      onMessage: () => null,
    });
    const service = createFridayRustHubAgentRunWsClientService({ port: stub.port, timeoutMs: 50 });

    const error = await service.dispatchRun(REQUEST).catch((e: unknown) => e);
    const domain = expectFailClosed(error);
    expect(domain.message).toContain("timed out");
  });

  it("fails closed on malformed JSON", async () => {
    stub = await startStubServer({ onMessage: () => "{not valid json" });
    const service = createFridayRustHubAgentRunWsClientService({ port: stub.port, timeoutMs: 2_000 });

    const error = await service.dispatchRun(REQUEST).catch((e: unknown) => e);
    const domain = expectFailClosed(error);
    expect(domain.message).toContain("invalid JSON");
  });

  it("fails closed on an unknown message shape (wrong kind)", async () => {
    stub = await startStubServer({
      onMessage: () =>
        JSON.stringify({ kind: "SomethingElse", run_id: "agent_run_probe", status: "completed" }),
    });
    const service = createFridayRustHubAgentRunWsClientService({ port: stub.port, timeoutMs: 2_000 });

    const error = await service.dispatchRun(REQUEST).catch((e: unknown) => e);
    const domain = expectFailClosed(error);
    expect(domain.message).toContain("unknown message shape");
  });

  it("fails closed when a required ref is missing (no status)", async () => {
    stub = await startStubServer({
      onMessage: () =>
        JSON.stringify({ kind: "AgentRunResult", run_id: "agent_run_probe" }),
    });
    const service = createFridayRustHubAgentRunWsClientService({ port: stub.port, timeoutMs: 2_000 });

    const error = await service.dispatchRun(REQUEST).catch((e: unknown) => e);
    const domain = expectFailClosed(error);
    expect(domain.message).toContain("missing a required ref");
  });

  it("fails closed (no spawn) when the request has no run id", async () => {
    // No server needed — the precondition guard fails closed before any connect.
    const service = createFridayRustHubAgentRunWsClientService({ port: 1, timeoutMs: 2_000 });
    const error = await service
      .dispatchRun({ ...REQUEST, runId: "" })
      .catch((e: unknown) => e);
    const domain = expectFailClosed(error);
    expect(domain.message).toContain("requires a run id");
  });

  it("surfaces NO body on ANY fail-closed branch (error carries no answer text)", async () => {
    const SECRET = "leaked-body-should-never-appear"; // pragma: allowlist secret
    stub = await startStubServer({
      // A body-bearing frame that ALSO has a wrong kind → fail closed, body must not leak.
      onMessage: () =>
        JSON.stringify({ kind: "Error", run_id: "agent_run_probe", answer: SECRET, body: SECRET }),
    });
    const service = createFridayRustHubAgentRunWsClientService({ port: stub.port, timeoutMs: 2_000 });

    const error = await service.dispatchRun(REQUEST).catch((e: unknown) => e);
    const domain = expectFailClosed(error);
    expect(JSON.stringify({ message: domain.message, details: domain.details })).not.toContain(
      SECRET,
    );
  });
});
