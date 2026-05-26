import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeLarkFrame } from "../../../../src/channels/lark/internal/lark-ws-frame.js";

// ─── Fake `ws` module ───
//
// vi.mock is hoisted above all imports, so the FakeWebSocket class and the
// shared mutable state must be defined inside a `vi.hoisted` block so they
// are available when the factory runs.

const { FakeWebSocket, wsState } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  const wsState: {
    instances: FakeWebSocketInstance[];
    lastUrl: string | null;
  } = {
    instances: [],
    lastUrl: null,
  };
  type FakeWebSocketInstance = InstanceType<typeof FakeWebSocketClass>;
  const FakeWebSocketClass = class FakeWebSocket extends EventEmitter {
    static OPEN = 1;
    static CLOSED = 3;

    readyState = 0;
    url: string;
    sent: Uint8Array[] = [];
    closed = false;
    terminated = false;

    constructor(url: string) {
      super();
      this.url = url;
      wsState.lastUrl = url;
      wsState.instances.push(this);
    }

    send(data: Uint8Array, cb?: (err?: Error) => void): void {
      this.sent.push(data);
      cb?.();
    }

    close(): void {
      this.closed = true;
      this.readyState = FakeWebSocketClass.CLOSED;
      this.emit("close");
    }

    terminate(): void {
      this.terminated = true;
      this.readyState = FakeWebSocketClass.CLOSED;
      this.emit("close");
    }

    /** Test helper: deliver an inbound frame. */
    deliver(bytes: Uint8Array): void {
      this.emit("message", Buffer.from(bytes));
    }

    /** Test helper: resolve handshake. */
    fireOpen(): void {
      this.readyState = FakeWebSocketClass.OPEN;
      this.emit("open");
    }
  };
  return { FakeWebSocket: FakeWebSocketClass, wsState };
});

vi.mock("ws", () => ({
  default: FakeWebSocket,
  WebSocket: FakeWebSocket,
}));

import { LarkWsClient, unrefTimer } from "../../../../src/channels/lark/internal/lark-ws-client.js";
import { LarkDomain } from "../../../../src/channels/lark/internal/lark-domain.js";
import { LarkEventDispatcher } from "../../../../src/channels/lark/internal/lark-event-dispatcher.js";

// ─── Helpers ───

interface FakeFetchResponse {
  status: number;
  body: unknown;
}

function installFetchMock(responses: FakeFetchResponse[]): { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const queue = [...responses];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
    calls.push({ url, ...(init !== undefined ? { init } : {}) });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch call: ${url}`);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    } as Response;
  }) as typeof globalThis.fetch;
  return { calls };
}

async function flushMicrotasks(): Promise<void> {
  // pullConnectConfig chains: fetch -> json -> connect -> new WebSocket.
  // A few `await Promise.resolve()` rounds plus an immediate hop reliably
  // drains those queued microtasks without depending on real timers.
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function controlPongFrame(payload: object): Uint8Array {
  return encodeLarkFrame({
    SeqID: 0,
    LogID: 0,
    service: 1,
    method: 0, // control
    headers: [{ key: "type", value: "pong" }],
    payload: new TextEncoder().encode(JSON.stringify(payload)),
  });
}

function dataEventFrame(eventBody: object, opts: { messageId: string; sum: number; seq: number; traceId: string; SeqID?: number; LogID?: number; service?: number }): Uint8Array {
  return encodeLarkFrame({
    SeqID: opts.SeqID ?? 1,
    LogID: opts.LogID ?? 1,
    service: opts.service ?? 1,
    method: 1, // data
    headers: [
      { key: "type", value: "event" },
      { key: "message_id", value: opts.messageId },
      { key: "sum", value: String(opts.sum) },
      { key: "seq", value: String(opts.seq) },
      { key: "trace_id", value: opts.traceId },
    ],
    payload: new TextEncoder().encode(JSON.stringify(eventBody)),
  });
}

describe("LarkWsClient lifecycle", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    wsState.instances = [];
    wsState.lastUrl = null;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("unrefs lifecycle timers so cleanup timers cannot hold the listener process open", () => {
    const unref = vi.fn();
    unrefTimer({ unref } as unknown as NodeJS.Timeout);
    expect(unref).toHaveBeenCalledOnce();
    expect(() => unrefTimer(undefined)).not.toThrow();
  });

  it("rejects malformed appId without opening any WebSocket", async () => {
    const { calls } = installFetchMock([]);
    const onError = vi.fn();
    const client = new LarkWsClient({
      appId: "not-a-valid-appid",
      appSecret: "secret-test", // pragma: allowlist secret
      domain: LarkDomain.Feishu,
      onError,
    });
    await client.start({ eventDispatcher: new LarkEventDispatcher() });
    expect(wsState.instances).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it("happy path: pull config -> open -> ping -> pong -> data -> ack", async () => {
    const { calls: fetchCalls } = installFetchMock([
      {
        status: 200,
        body: {
          code: 0,
          msg: "ok",
          data: {
            URL: "wss://lark.example/ws?device_id=dev-1&service_id=42",
            ClientConfig: {
              PingInterval: 60,
              ReconnectCount: 3,
              ReconnectInterval: 5,
              ReconnectNonce: 0,
            },
          },
        },
      },
    ]);
    const onReady = vi.fn();
    const handler = vi.fn(async () => ({ status: "ok" }));
    const dispatcher = new LarkEventDispatcher().register({
      "im.message.receive_v1": handler,
    });
    const client = new LarkWsClient({
      appId: "cli_0123456789abcdef",
      appSecret: "secret-test", // pragma: allowlist secret
      domain: LarkDomain.Feishu,
      autoReconnect: false,
      onReady,
    });
    const startPromise = client.start({ eventDispatcher: dispatcher });

    // Allow pullConnectConfig microtasks (fetch -> json -> connect) to resolve.
    await flushMicrotasks();
    expect(wsState.instances).toHaveLength(1);
    const ws = wsState.instances[0]!;
    expect(ws.url).toBe("wss://lark.example/ws?device_id=dev-1&service_id=42");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("https://open.feishu.cn/callback/ws/endpoint");

    // Simulate WS open — start() should resolve and onReady should fire.
    ws.fireOpen();
    await startPromise;
    expect(onReady).toHaveBeenCalledOnce();

    // Ping is sent immediately on open via pingLoop.
    expect(ws.sent).toHaveLength(1);

    // Server sends pong with a new ping interval — client should update internal state.
    ws.deliver(controlPongFrame({
      PingInterval: 30,
      ReconnectCount: 5,
      ReconnectInterval: 10,
      ReconnectNonce: 0,
    }));

    // Deliver a data event frame — client should call the dispatcher and ACK back.
    ws.deliver(dataEventFrame(
      { schema: "2.0", header: { event_type: "im.message.receive_v1" }, event: { foo: 1 } },
      { messageId: "m-1", sum: 1, seq: 0, traceId: "t-1", SeqID: 7, LogID: 11, service: 42 },
    ));

    // dispatcher invocation is async — flush microtasks.
    await flushMicrotasks();
    expect(handler).toHaveBeenCalledOnce();
    const passed = handler.mock.calls[0]![0] as Record<string, unknown>;
    expect(passed.event_type).toBe("im.message.receive_v1");
    expect(passed.foo).toBe(1);

    // ACK should have been queued (second send after the initial ping).
    expect(ws.sent.length).toBeGreaterThanOrEqual(2);
    // Decode the ACK payload — must be {code:200, data:base64(JSON(handlerResult))}.
    const ackBytes = ws.sent[ws.sent.length - 1]!;
    const ackText = new TextDecoder("utf-8").decode(ackBytes);
    expect(ackText).toContain('"code":200');
    // base64(JSON.stringify({status:"ok"})) for the handler return value.
    const expectedB64 = Buffer.from(JSON.stringify({ status: "ok" })).toString("base64");
    expect(ackText).toContain(expectedB64);

    client.close({ force: true });
  });

  it("chunked data event: only invokes handler after all chunks arrive, in any order", async () => {
    installFetchMock([
      {
        status: 200,
        body: {
          code: 0,
          msg: "ok",
          data: {
            URL: "wss://lark.example/ws?device_id=d&service_id=1",
            ClientConfig: { PingInterval: 60, ReconnectCount: 0, ReconnectInterval: 5, ReconnectNonce: 0 },
          },
        },
      },
    ]);
    const handler = vi.fn(async () => undefined);
    const dispatcher = new LarkEventDispatcher().register({ "im.message.receive_v1": handler });
    const client = new LarkWsClient({
      appId: "cli_0123456789abcdef",
      appSecret: "x",
      autoReconnect: false,
    });
    const startPromise = client.start({ eventDispatcher: dispatcher });
    await flushMicrotasks();
    const ws = wsState.instances[0]!;
    ws.fireOpen();
    await startPromise;

    const full = new TextEncoder().encode(JSON.stringify({
      schema: "2.0",
      header: { event_type: "im.message.receive_v1" },
      event: { piece: "complete" },
    }));
    const mid = Math.floor(full.byteLength / 2);
    const first = full.slice(0, mid);
    const second = full.slice(mid);

    // Deliver second chunk first to verify reassembly is order-tolerant.
    ws.deliver(encodeLarkFrame({
      SeqID: 1, LogID: 1, service: 1, method: 1,
      headers: [
        { key: "type", value: "event" },
        { key: "message_id", value: "chunked-msg" },
        { key: "sum", value: "2" },
        { key: "seq", value: "1" },
        { key: "trace_id", value: "tr" },
      ],
      payload: second,
    }));
    await flushMicrotasks();
    expect(handler).not.toHaveBeenCalled();
    ws.deliver(encodeLarkFrame({
      SeqID: 1, LogID: 1, service: 1, method: 1,
      headers: [
        { key: "type", value: "event" },
        { key: "message_id", value: "chunked-msg" },
        { key: "sum", value: "2" },
        { key: "seq", value: "0" },
        { key: "trace_id", value: "tr" },
      ],
      payload: first,
    }));
    await flushMicrotasks();
    expect(handler).toHaveBeenCalledOnce();
    const merged = handler.mock.calls[0]![0] as Record<string, unknown>;
    expect(merged.piece).toBe("complete");

    client.close({ force: true });
  });

  it("non-retryable pull-config failure invokes onError and stops", async () => {
    installFetchMock([
      { status: 200, body: { code: 403, msg: "forbidden" } },
    ]);
    const onError = vi.fn();
    const onReady = vi.fn();
    const client = new LarkWsClient({
      appId: "cli_0123456789abcdef",
      appSecret: "s",
      autoReconnect: false,
      onError,
      onReady,
    });
    await client.start({ eventDispatcher: new LarkEventDispatcher() });
    // pullConfig returned non-retryable; no WS constructed.
    expect(wsState.instances).toHaveLength(0);
    expect(onError).toHaveBeenCalledOnce();
    expect(onReady).not.toHaveBeenCalled();
    expect((onError.mock.calls[0]![0] as Error).message).toMatch(/pullConnectConfig failed/);
  });

  it("close() invalidates further reconnect attempts via generation counter", async () => {
    installFetchMock([
      {
        status: 200,
        body: {
          code: 0, msg: "ok",
          data: {
            URL: "wss://lark.example/ws?device_id=d&service_id=1",
            ClientConfig: { PingInterval: 60, ReconnectCount: 0, ReconnectInterval: 5, ReconnectNonce: 0 },
          },
        },
      },
    ]);
    const client = new LarkWsClient({
      appId: "cli_0123456789abcdef",
      appSecret: "s",
      autoReconnect: true,
    });
    const startPromise = client.start({ eventDispatcher: new LarkEventDispatcher() });
    await flushMicrotasks();
    const ws = wsState.instances[0]!;
    ws.fireOpen();
    await startPromise;

    // Force close — emit close after we call close({force:true}); generation
    // bump in close() should prevent a fresh reconnect cycle from firing.
    client.close({ force: true });
    // give the (suppressed) close handler a chance to schedule reConnect
    await flushMicrotasks();
    expect(wsState.instances).toHaveLength(1); // no new WS opened
  });

  it("handler exception results in an ACK with code 500, not a thrown rejection", async () => {
    installFetchMock([
      {
        status: 200,
        body: {
          code: 0, msg: "ok",
          data: {
            URL: "wss://lark.example/ws?device_id=d&service_id=1",
            ClientConfig: { PingInterval: 60, ReconnectCount: 0, ReconnectInterval: 5, ReconnectNonce: 0 },
          },
        },
      },
    ]);
    const dispatcher = new LarkEventDispatcher().register({
      "im.message.receive_v1": async () => {
        throw new Error("handler boom");
      },
    });
    const client = new LarkWsClient({
      appId: "cli_0123456789abcdef",
      appSecret: "s",
      autoReconnect: false,
    });
    const startPromise = client.start({ eventDispatcher: dispatcher });
    await flushMicrotasks();
    const ws = wsState.instances[0]!;
    ws.fireOpen();
    await startPromise;
    const pingCount = ws.sent.length; // ping after open
    ws.deliver(dataEventFrame(
      { schema: "2.0", header: { event_type: "im.message.receive_v1" }, event: {} },
      { messageId: "m", sum: 1, seq: 0, traceId: "t" },
    ));
    await flushMicrotasks();
    expect(ws.sent.length).toBe(pingCount + 1);
    // Last send is the ACK; payload should be JSON {code:500}
    const ack = ws.sent[ws.sent.length - 1]!;
    // We don't decode the whole frame here — just assert the payload contains
    // the code:500 marker (it's encoded as plain JSON in the wire payload).
    const ackText = new TextDecoder("utf-8").decode(ack);
    expect(ackText).toContain('"code":500');
    client.close({ force: true });
  });
});
