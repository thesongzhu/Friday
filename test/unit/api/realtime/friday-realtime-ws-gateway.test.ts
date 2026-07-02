import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import {
  createFridayRealtimeWsGateway,
  type FridayRealtimeWsGateway,
  type FridayWsConnection,
  createFridayRealtimeSubscriptionService,
  createFridayRealtimeEventRepository,
  createFridayRealtimeCheckpointRepository,
  createFridayRealtimeFrameCrypto,
} from "#api";
import { createFridayRealtimeEventBus } from "#api";
import {
  createFridayTokenValidator,
  encodeToken,
  FridayTokenValidationError,
} from "#api";
import type {
  FridayRealtimeClientFrame,
  FridayRealtimeServerFrame,
} from "#api";
import type { FridayAccessTokenClaims } from "#api";

describe("FridayRealtimeWsGateway", () => {
  let db: FridaySqliteLayer;
  let gateway: FridayRealtimeWsGateway;
  let subscriptionService: ReturnType<typeof createFridayRealtimeSubscriptionService>;
  let eventBus: ReturnType<typeof createFridayRealtimeEventBus>;
  let tokenValidator: ReturnType<typeof createFridayTokenValidator>;
  const NOW = "2025-06-15T10:00:00.000Z";
  const NOW_MS = new Date(NOW).getTime();
  const TOKEN_SECRET = "test-secret-for-ws";
  const EPOCH = 1;

  function makeToken(
    overrides: Partial<FridayAccessTokenClaims> = {},
  ): string {
    const claims: FridayAccessTokenClaims = {
      tokenId: "tok-1",
      principalType: "user",
      principalId: "user-1",
      userId: "user-1",
      role: "admin",
      scopes: [
        "workflow.read",
        "workflow.write",
        "fleet.read",
        "satellite.read",
        "security.read",
        "diagnosis.read",
        "session.read",
        "session.write",
      ],
      iat: Math.floor(NOW_MS / 1000) - 60,
      exp: Math.floor(NOW_MS / 1000) + 900,
      ...overrides,
    };
    return encodeToken(claims, TOKEN_SECRET);
  }

  beforeEach(() => {
    db = createTestDb();
    const eventRepo = createFridayRealtimeEventRepository();
    const checkpointRepo = createFridayRealtimeCheckpointRepository();
    subscriptionService = createFridayRealtimeSubscriptionService({
      db,
      eventRepo,
      checkpointRepo,
      nowIso: () => NOW,
      currentEpoch: EPOCH,
      // TS-runtime-retirement (method guard): the shared service must allow the
      // legacy ackEvent path so flag-enabled gateways below can succeed. The
      // retirement test builds a gateway WITHOUT the gateway flag and asserts the
      // WS ack frame fail-closes at the gateway BEFORE reaching ackEvent.
      allowTestOnlyRealtimeExecution: true,
    });
    eventBus = createFridayRealtimeEventBus({
      idGenerator: () => "bus-evt-1",
      nowIso: () => NOW,
    });
    tokenValidator = createFridayTokenValidator({
      tokenSecret: TOKEN_SECRET,
      nowMs: () => NOW_MS,
      lookupTokenRevocation: () => false,
    });

    gateway = createFridayRealtimeWsGateway({
      tokenValidator,
      subscriptionService,
      eventBus,
      nowIso: () => NOW,
      serverVersion: "1.0.0-test",
      currentEpoch: EPOCH,
      // Test-oracle: exercise the real WS checkpoint-ack logic. Default/live
      // leaves this unset so the ack frame fail-closes (see retirement test).
      allowTestOnlyRealtimeExecution: true,
    });
  });

  afterEach(() => {
    db.close();
  });

  // ─── Connection creation ───

  it("creates an unauthenticated connection", () => {
    const conn = gateway.createConnection("conn-1");
    expect(conn.connId).toBe("conn-1");
    expect(conn.authenticated).toBe(false);
    expect(conn.principal).toBeNull();
    expect(conn.subscriptions.size).toBe(0);
  });

  // ─── Hello frame ───

  it("hello with valid token authenticates connection", () => {
    const conn = gateway.createConnection("conn-1");
    const token = makeToken();

    const responses = gateway.handleClientFrame(conn, {
      type: "hello",
      token,
    });

    expect(conn.authenticated).toBe(true);
    expect(conn.principal).not.toBeNull();
    expect(conn.principal!.principalId).toBe("user-1");
    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe("hello_ack");

    const ack = responses[0] as Extract<FridayRealtimeServerFrame, { type: "hello_ack" }>;
    expect(ack.connId).toBe("conn-1");
    expect(ack.protocolVersion).toBe("1.0");
    expect(ack.serverVersion).toBe("1.0.0-test");
    expect(ack.epoch).toBe(EPOCH);
  });

  it("accepts encrypted client frames and emits encrypted server envelopes when frame crypto is configured", () => {
    const eventRepo = createFridayRealtimeEventRepository();
    const checkpointRepo = createFridayRealtimeCheckpointRepository();
    const subscriptionService = createFridayRealtimeSubscriptionService({
      db,
      eventRepo,
      checkpointRepo,
      nowIso: () => NOW,
      currentEpoch: EPOCH,
      allowTestOnlyRealtimeExecution: true,
    });
    const wsFrameKeyMaterial = ["ws", "frame", "secret"].join("-");
    const frameCrypto = createFridayRealtimeFrameCrypto({
      secret: wsFrameKeyMaterial,
      keyId: "ws-test-key",
      randomBytes: (size) => Buffer.alloc(size, 3),
    });
    const encryptedGateway = createFridayRealtimeWsGateway({
      tokenValidator: createFridayTokenValidator({
        tokenSecret: TOKEN_SECRET,
        nowMs: () => NOW_MS,
        lookupTokenRevocation: () => false,
      }),
      subscriptionService,
      eventBus: createFridayRealtimeEventBus({
        idGenerator: () => "bus-evt-enc",
        nowIso: () => NOW,
      }),
      nowIso: () => NOW,
      serverVersion: "1.0.0-test",
      currentEpoch: EPOCH,
      frameCrypto,
      allowTestOnlyRealtimeExecution: true,
    });
    const conn = encryptedGateway.createConnection("conn-encrypted");

    const responses = encryptedGateway.handleClientFrame(
      conn,
      frameCrypto.encryptClientFrame({ type: "hello", token: makeToken() }),
    );
    const wireFrame = encryptedGateway.encodeServerFrame!(responses[0]!);

    expect(conn.authenticated).toBe(true);
    expect(wireFrame.type).toBe("encrypted");
    expect(JSON.stringify(wireFrame)).not.toContain("hello_ack");
    expect(frameCrypto.decryptServerFrame(wireFrame)).toMatchObject({
      type: "hello_ack",
      connId: "conn-encrypted",
    });
  });

  it("hello with invalid token returns error", () => {
    const conn = gateway.createConnection("conn-1");

    const responses = gateway.handleClientFrame(conn, {
      type: "hello",
      token: "invalid.token",
    });

    expect(conn.authenticated).toBe(false);
    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe("error");

    const err = responses[0] as Extract<FridayRealtimeServerFrame, { type: "error" }>;
    expect(err.retryable).toBe(false);
  });

  it("hello with initial subscriptions processes them", () => {
    const conn = gateway.createConnection("conn-1");
    const token = makeToken();

    const responses = gateway.handleClientFrame(conn, {
      type: "hello",
      token,
      subscriptions: [
        {
          subscriptionId: "sub-1",
          streamId: "workflow:wf-1",
          topic: "workflow",
        },
      ],
    });

    expect(responses).toHaveLength(2);
    expect(responses[0].type).toBe("hello_ack");
    expect(responses[1].type).toBe("subscribed");

    const subscribed = responses[1] as Extract<
      FridayRealtimeServerFrame,
      { type: "subscribed" }
    >;
    expect(subscribed.accepted).toHaveLength(1);
    expect(conn.subscriptions.size).toBe(1);
  });

  // ─── Subscribe frame ───

  it("subscribe before hello returns error", () => {
    const conn = gateway.createConnection("conn-1");

    const responses = gateway.handleClientFrame(conn, {
      type: "subscribe",
      subscriptions: [
        { subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" },
      ],
    });

    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe("error");
    const err = responses[0] as Extract<FridayRealtimeServerFrame, { type: "error" }>;
    expect(err.code).toBe("NOT_AUTHENTICATED");
  });

  it("subscribe after hello accepts valid subscriptions", () => {
    const conn = gateway.createConnection("conn-1");
    gateway.handleClientFrame(conn, { type: "hello", token: makeToken() });

    const responses = gateway.handleClientFrame(conn, {
      type: "subscribe",
      subscriptions: [
        { subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" },
        { subscriptionId: "sub-2", streamId: "fleet:global", topic: "fleet" },
      ],
    });

    expect(responses).toHaveLength(1);
    const subscribed = responses[0] as Extract<
      FridayRealtimeServerFrame,
      { type: "subscribed" }
    >;
    expect(subscribed.accepted).toHaveLength(2);
    expect(conn.subscriptions.size).toBe(2);
  });

  // ─── Unsubscribe frame ───

  it("unsubscribe removes subscriptions", () => {
    const conn = gateway.createConnection("conn-1");
    gateway.handleClientFrame(conn, { type: "hello", token: makeToken() });
    gateway.handleClientFrame(conn, {
      type: "subscribe",
      subscriptions: [
        { subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" },
        { subscriptionId: "sub-2", streamId: "fleet:global", topic: "fleet" },
      ],
    });

    expect(conn.subscriptions.size).toBe(2);

    const responses = gateway.handleClientFrame(conn, {
      type: "unsubscribe",
      subscriptionIds: ["sub-1"],
    });

    expect(responses).toHaveLength(0);
    expect(conn.subscriptions.size).toBe(1);
    expect(conn.subscriptions.has("sub-2")).toBe(true);
  });

  // ─── Ack frame ───

  it("ack before hello returns error", () => {
    const conn = gateway.createConnection("conn-1");
    const responses = gateway.handleClientFrame(conn, {
      type: "ack",
      streamId: "workflow:wf-1",
      seq: 1,
      epoch: EPOCH,
    });

    expect(responses[0].type).toBe("error");
  });

  it("ack with matching epoch returns ack_ok", () => {
    const conn = gateway.createConnection("conn-1");
    gateway.handleClientFrame(conn, { type: "hello", token: makeToken() });
    // Must subscribe to the stream first
    gateway.handleClientFrame(conn, {
      type: "subscribe",
      subscriptions: [
        { subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" },
      ],
    });

    const responses = gateway.handleClientFrame(conn, {
      type: "ack",
      streamId: "workflow:wf-1",
      seq: 5,
      epoch: EPOCH,
    });

    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe("ack_ok");
    const ackOk = responses[0] as Extract<FridayRealtimeServerFrame, { type: "ack_ok" }>;
    expect(ackOk.streamId).toBe("workflow:wf-1");
    expect(ackOk.seq).toBe(5);
  });

  it("TS runtime retirement: ack frame fail-closes (error frame) when allowTestOnlyRealtimeExecution is unset", () => {
    // Default/live wiring leaves the flag unset; the WS ack frame is the second
    // ackEvent call site (the first is POST /v1/realtime/ack) and must also
    // fail-close so the checkpoint-cursor mutation is fully retired.
    const retiredGateway = createFridayRealtimeWsGateway({
      tokenValidator,
      subscriptionService,
      eventBus,
      nowIso: () => NOW,
      serverVersion: "1.0.0-test",
      currentEpoch: EPOCH,
      // allowTestOnlyRealtimeExecution intentionally unset.
    });
    const conn = retiredGateway.createConnection("conn-retired");
    retiredGateway.handleClientFrame(conn, { type: "hello", token: makeToken() });
    retiredGateway.handleClientFrame(conn, {
      type: "subscribe",
      subscriptions: [
        { subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" },
      ],
    });

    const responses = retiredGateway.handleClientFrame(conn, {
      type: "ack",
      streamId: "workflow:wf-1",
      seq: 5,
      epoch: EPOCH,
    });

    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe("error");
    expect((responses[0] as Extract<FridayRealtimeServerFrame, { type: "error" }>).message)
      .toContain("TS_RUNTIME_REALTIME_RETIRED");
    // The cursor was NOT advanced: a fresh authorized ack via a flag-enabled
    // gateway still succeeds (proving the retirement is the only thing blocking).
    const okConn = gateway.createConnection("conn-ok");
    gateway.handleClientFrame(okConn, { type: "hello", token: makeToken() });
    gateway.handleClientFrame(okConn, {
      type: "subscribe",
      subscriptions: [
        { subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" },
      ],
    });
    const okResponses = gateway.handleClientFrame(okConn, {
      type: "ack",
      streamId: "workflow:wf-1",
      seq: 5,
      epoch: EPOCH,
    });
    expect(okResponses[0].type).toBe("ack_ok");
  });

  it("ack with stale epoch returns resync_required", () => {
    const conn = gateway.createConnection("conn-1");
    gateway.handleClientFrame(conn, { type: "hello", token: makeToken() });
    // Must subscribe to the stream first
    gateway.handleClientFrame(conn, {
      type: "subscribe",
      subscriptions: [
        { subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" },
      ],
    });

    const responses = gateway.handleClientFrame(conn, {
      type: "ack",
      streamId: "workflow:wf-1",
      seq: 5,
      epoch: EPOCH + 99,
    });

    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe("resync_required");
    const resync = responses[0] as Extract<
      FridayRealtimeServerFrame,
      { type: "resync_required" }
    >;
    expect(resync.reason).toBe("STREAM_EPOCH_STALE");
  });

  // ─── Resume frame ───

  it("resume before hello returns error", () => {
    const conn = gateway.createConnection("conn-1");
    const responses = gateway.handleClientFrame(conn, {
      type: "resume",
      streamId: "workflow:wf-1",
      lastAckedSeq: 0,
      epoch: EPOCH,
      cursor: "c",
      subscriptions: [],
    });
    expect(responses[0].type).toBe("error");
  });

  it("resume with stale epoch returns resync_required", () => {
    const conn = gateway.createConnection("conn-1");
    gateway.handleClientFrame(conn, { type: "hello", token: makeToken() });

    const responses = gateway.handleClientFrame(conn, {
      type: "resume",
      streamId: "workflow:wf-1",
      lastAckedSeq: 0,
      epoch: EPOCH + 5,
      cursor: "c",
      subscriptions: [],
    });

    expect(responses[0].type).toBe("resync_required");
  });

  it("resume with valid epoch re-subscribes and replays events", () => {
    // Seed some events
    const eventRepo = createFridayRealtimeEventRepository();
    db.withWriteTransaction((w) => {
      eventRepo.append(w, {
        eventId: "evt-1",
        streamId: "workflow:wf-1",
        seq: 1,
        event: "workflow.updated",
        payload: { workflowId: "wf-1", revision: 1, etag: "a" },
        emittedAt: NOW,
      });
      eventRepo.append(w, {
        eventId: "evt-2",
        streamId: "workflow:wf-1",
        seq: 2,
        event: "workflow.updated",
        payload: { workflowId: "wf-1", revision: 2, etag: "b" },
        emittedAt: NOW,
      });
    });

    const conn = gateway.createConnection("conn-1");
    gateway.handleClientFrame(conn, { type: "hello", token: makeToken() });

    // Use empty cursor (no HMAC check needed when cursor is empty)
    const responses = gateway.handleClientFrame(conn, {
      type: "resume",
      streamId: "workflow:wf-1",
      lastAckedSeq: 0,
      epoch: EPOCH,
      cursor: "",
      subscriptions: [
        { subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" },
      ],
    });

    // First response is subscribed, then 2 event frames
    const types = responses.map((r) => r.type);
    expect(types[0]).toBe("subscribed");
    expect(types.filter((t) => t === "event")).toHaveLength(2);
  });

  it("redacts secret-shaped content while replaying stored events", () => {
    db.withWriteTransaction((writer) => {
      writer.prepare(
        `INSERT INTO realtime_events
          (event_id, stream_id, seq, event, payload_json, emitted_at, correlation_id, state_version_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "evt-ws-secret",
        "workflow:wf-1",
        1,
        "workflow.run.failed",
        JSON.stringify({
          runId: "run-1",
          error: {
            code: "NODE_EXECUTION_FAILED",
            message: "legacy row leaked Authorization: Bearer sk-a5-ws-replay-canary",
          },
        }),
        NOW,
        null,
        null,
        NOW,
      );
    });

    const conn = gateway.createConnection("conn-redaction");
    gateway.handleClientFrame(conn, { type: "hello", token: makeToken() });

    const responses = gateway.handleClientFrame(conn, {
      type: "resume",
      streamId: "workflow:wf-1",
      lastAckedSeq: 0,
      epoch: EPOCH,
      cursor: "",
      subscriptions: [
        { subscriptionId: "sub-redaction", streamId: "workflow:wf-1", topic: "workflow" },
      ],
    });
    const eventFrame = responses.find((frame): frame is Extract<FridayRealtimeServerFrame, { type: "event" }> =>
      frame.type === "event",
    );
    const serialized = JSON.stringify(eventFrame?.envelope.payload);

    expect(serialized).not.toContain("sk-a5-ws-replay-canary");
    expect(serialized).toContain("[REDACTED]");
  });

  // ─── Stream authorization enforcement ───

  it("ack on non-subscribed stream returns STREAM_NOT_AUTHORIZED", () => {
    const conn = gateway.createConnection("conn-1");
    gateway.handleClientFrame(conn, { type: "hello", token: makeToken() });
    // Subscribe to wf-1 only
    gateway.handleClientFrame(conn, {
      type: "subscribe",
      subscriptions: [
        { subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" },
      ],
    });

    // Try to ack wf-2 (not subscribed)
    const responses = gateway.handleClientFrame(conn, {
      type: "ack",
      streamId: "workflow:wf-2",
      seq: 1,
      epoch: EPOCH,
    });

    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe("error");
    const err = responses[0] as Extract<FridayRealtimeServerFrame, { type: "error" }>;
    expect(err.code).toBe("STREAM_NOT_AUTHORIZED");
  });

  it("ack with invalid cursor returns CURSOR_INVALID", () => {
    const conn = gateway.createConnection("conn-1");
    gateway.handleClientFrame(conn, { type: "hello", token: makeToken() });
    gateway.handleClientFrame(conn, {
      type: "subscribe",
      subscriptions: [
        { subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" },
      ],
    });

    const responses = gateway.handleClientFrame(conn, {
      type: "ack",
      streamId: "workflow:wf-1",
      seq: 5,
      epoch: EPOCH,
      cursor: "invalid-cursor-value",
    });

    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe("resync_required");
    const resync = responses[0] as Extract<FridayRealtimeServerFrame, { type: "resync_required" }>;
    expect(resync.reason).toBe("CURSOR_INVALID");
  });

  it("resume with invalid cursor returns CURSOR_INVALID", () => {
    const conn = gateway.createConnection("conn-1");
    gateway.handleClientFrame(conn, { type: "hello", token: makeToken() });

    const responses = gateway.handleClientFrame(conn, {
      type: "resume",
      streamId: "workflow:wf-1",
      lastAckedSeq: 0,
      epoch: EPOCH,
      cursor: "tampered-cursor",
      subscriptions: [
        { subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" },
      ],
    });

    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe("resync_required");
    const resync = responses[0] as Extract<FridayRealtimeServerFrame, { type: "resync_required" }>;
    expect(resync.reason).toBe("CURSOR_INVALID");
  });

  it("topic-stream binding rejection in subscription", () => {
    const conn = gateway.createConnection("conn-1");
    gateway.handleClientFrame(conn, { type: "hello", token: makeToken() });

    const responses = gateway.handleClientFrame(conn, {
      type: "subscribe",
      subscriptions: [
        // workflow topic with fleet: prefix → invalid
        { subscriptionId: "sub-bad", streamId: "fleet:global", topic: "workflow" },
      ],
    });

    expect(responses).toHaveLength(1);
    const subscribed = responses[0] as Extract<FridayRealtimeServerFrame, { type: "subscribed" }>;
    expect(subscribed.accepted).toHaveLength(0);
    expect(subscribed.rejected).toHaveLength(1);
    expect(subscribed.rejected[0].code).toBe("INVALID_STREAM_BINDING");
  });

  // ─── Ping frame ───

  it("ping returns pong", () => {
    const conn = gateway.createConnection("conn-1");
    const responses = gateway.handleClientFrame(conn, {
      type: "ping",
      at: NOW,
    });

    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe("pong");
    const pong = responses[0] as Extract<FridayRealtimeServerFrame, { type: "pong" }>;
    expect(pong.at).toBe(NOW);
  });

  // ─── shouldDeliverEvent ───

  it("shouldDeliverEvent returns false for unauthenticated connection", () => {
    const conn = gateway.createConnection("conn-1");
    const result = gateway.shouldDeliverEvent(conn, {
      eventId: "evt-1",
      streamId: "workflow:wf-1",
      seq: 1,
      event: "workflow.updated",
      payload: { workflowId: "wf-1", revision: 1, etag: "a" },
      emittedAt: NOW,
    });
    expect(result).toBe(false);
  });

  it("shouldDeliverEvent returns true when subscribed to the stream", () => {
    const conn = gateway.createConnection("conn-1");
    gateway.handleClientFrame(conn, { type: "hello", token: makeToken() });
    gateway.handleClientFrame(conn, {
      type: "subscribe",
      subscriptions: [
        { subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" },
      ],
    });

    const result = gateway.shouldDeliverEvent(conn, {
      eventId: "evt-1",
      streamId: "workflow:wf-1",
      seq: 1,
      event: "workflow.updated",
      payload: { workflowId: "wf-1", revision: 1, etag: "a" },
      emittedAt: NOW,
    });
    expect(result).toBe(true);
  });

  it("shouldDeliverEvent returns false for non-subscribed stream", () => {
    const conn = gateway.createConnection("conn-1");
    gateway.handleClientFrame(conn, { type: "hello", token: makeToken() });
    gateway.handleClientFrame(conn, {
      type: "subscribe",
      subscriptions: [
        { subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" },
      ],
    });

    const result = gateway.shouldDeliverEvent(conn, {
      eventId: "evt-1",
      streamId: "workflow:wf-2",
      seq: 1,
      event: "workflow.updated",
      payload: { workflowId: "wf-2", revision: 1, etag: "a" },
      emittedAt: NOW,
    });
    expect(result).toBe(false);
  });
});
