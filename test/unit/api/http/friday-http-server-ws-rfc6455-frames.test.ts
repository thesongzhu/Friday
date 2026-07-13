import * as net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFridayHttpRouteRegistry,
  createFridayHttpServer,
} from "#api";
import type {
  FridayAuthMiddlewareFactory,
  FridayHttpServer,
  FridayRealtimeClientFrame,
  FridayRealtimeServerFrame,
  FridayRealtimeWsGateway,
} from "#api";

// ─────────────────────────────────────────────────────────────────────────────
// Harness: a real net.Socket pair driving the actual friday-http-server WS
// realtime upgrade + inbound frame parser (handleRealtimeUpgrade). Every test
// exercises the real code path — no mocking of the parser.
// ─────────────────────────────────────────────────────────────────────────────

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("failed to allocate free port"));
        return;
      }
      const port = addr.port;
      server.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}

interface RecordingGateway extends FridayRealtimeWsGateway {
  received: FridayRealtimeClientFrame[];
}

function makeRecordingWsGateway(
  respond: FridayRealtimeServerFrame[] = [],
): RecordingGateway {
  const received: FridayRealtimeClientFrame[] = [];
  return {
    received,
    createConnection: (connId) => ({
      connId,
      principal: null,
      subscriptions: new Map(),
      authenticated: false,
    }),
    handleClientFrame: (_conn, frame) => {
      received.push(frame);
      return respond;
    },
    shouldDeliverEvent: () => false,
  };
}

function makeStubMiddleware(): FridayAuthMiddlewareFactory {
  return {
    requireAuth: () => ({ passed: true as const }),
    requireAnyScope: () => ({ passed: true as const }),
    requireAnyRole: () => ({ passed: true as const }),
    enforceRateLimit: () => ({ passed: true as const }),
  };
}

/** Perform the HTTP upgrade and return the connected socket once 101 arrives. */
function wsHandshake(
  port: number,
  path = "/v1/realtime/ws",
  extraHeaders: Record<string, string> = {},
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("handshake timeout"));
    }, 4000);
    const onData = (chunk: Buffer): void => {
      response += chunk.toString("utf-8");
      if (response.includes("\r\n\r\n")) {
        clearTimeout(timeout);
        socket.removeListener("data", onData);
        if (response.startsWith("HTTP/1.1 101")) {
          resolve(socket);
        } else {
          socket.destroy();
          reject(new Error(`handshake not 101: ${response.split("\r\n")[0]}`));
        }
      }
    };
    socket.on("connect", () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${String(port)}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
        "",
        "",
      ];
      socket.write(lines.join("\r\n"));
    });
    socket.on("data", onData);
    socket.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/** Return the raw HTTP status line for an upgrade attempt (used for Origin gating). */
function upgradeStatusLine(
  port: number,
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("upgrade timeout"));
    }, 4000);
    socket.on("connect", () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${String(port)}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
        "",
        "",
      ];
      socket.write(lines.join("\r\n"));
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf-8");
      if (response.includes("\r\n")) {
        clearTimeout(timeout);
        socket.destroy();
        resolve(response.split("\r\n")[0] ?? "");
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

interface BuildFrameOpts {
  opcode: number;
  payload?: Buffer;
  fin?: boolean;
  /** RSV bits already positioned in the 0x70 mask (e.g. 0x40 = RSV1). */
  rsv?: number;
  masked?: boolean;
  maskKey?: Buffer;
}

/** Craft a raw client→server WebSocket frame (masked by default per RFC 6455). */
function buildFrame(opts: BuildFrameOpts): Buffer {
  const payload = opts.payload ?? Buffer.alloc(0);
  const fin = opts.fin ?? true;
  const rsv = opts.rsv ?? 0;
  const masked = opts.masked ?? true;
  const firstByte = (fin ? 0x80 : 0) | (rsv & 0x70) | (opts.opcode & 0x0f);
  const len = payload.length;
  const maskBit = masked ? 0x80 : 0;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([firstByte, maskBit | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = firstByte;
    header[1] = maskBit | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = firstByte;
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  if (!masked) return Buffer.concat([header, payload]);
  const maskKey = opts.maskKey ?? Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = payload[i]! ^ maskKey[i % 4]!;
  return Buffer.concat([header, maskKey, out]);
}

interface ParsedFrame {
  opcode: number;
  payload: Buffer;
}

/** Parse unmasked server→client frames from a raw buffer. */
function parseServerFrames(buf: Buffer): ParsedFrame[] {
  const out: ParsedFrame[] = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const opcode = buf[off]! & 0x0f;
    let len = buf[off + 1]! & 0x7f;
    let hdr = 2;
    if (len === 126) {
      if (off + 4 > buf.length) break;
      len = buf.readUInt16BE(off + 2);
      hdr = 4;
    } else if (len === 127) {
      if (off + 10 > buf.length) break;
      len = Number(buf.readBigUInt64BE(off + 2));
      hdr = 10;
    }
    if (off + hdr + len > buf.length) break;
    out.push({ opcode, payload: buf.subarray(off + hdr, off + hdr + len) });
    off += hdr + len;
  }
  return out;
}

interface DriveResult {
  frames: ParsedFrame[];
  closeCode: number | null;
  texts: string[];
  closed: boolean;
}

/** Write frames to the socket, collect the server's reply, resolve on close/quiet. */
function driveFrames(
  socket: net.Socket,
  frames: Buffer[],
  waitMs = 400,
): Promise<DriveResult> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let closed = false;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeAllListeners("data");
      const parsed = parseServerFrames(buf);
      let closeCode: number | null = null;
      const texts: string[] = [];
      for (const f of parsed) {
        if (f.opcode === 0x8 && f.payload.length >= 2) closeCode = f.payload.readUInt16BE(0);
        else if (f.opcode === 0x1) texts.push(f.payload.toString("utf-8"));
      }
      socket.destroy();
      resolve({ frames: parsed, closeCode, texts, closed });
    };
    socket.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
    });
    socket.on("close", () => {
      closed = true;
      finish();
    });
    socket.on("error", () => {
      closed = true;
      finish();
    });
    const timer = setTimeout(finish, waitMs);
    try {
      for (const fr of frames) {
        if (socket.destroyed) break;
        socket.write(fr);
      }
    } catch {
      // Peer may tear down mid-write (expected for flood / oversize cases).
    }
  });
}

const TEXT = (s: string): Buffer => Buffer.from(s, "utf-8");

describe("FridayHttpServer realtime WS — RFC 6455 inbound frame validation", () => {
  let server: FridayHttpServer | null = null;
  let port = 0;
  let gateway: RecordingGateway;

  beforeEach(async () => {
    port = await findFreePort();
    gateway = makeRecordingWsGateway([{ type: "pong", at: "2026-07-13T00:00:00.000Z" }]);
    server = createFridayHttpServer({
      routes: createFridayHttpRouteRegistry(),
      wsGateway: gateway,
      middleware: makeStubMiddleware(),
      host: "127.0.0.1",
      port,
      // DEFAULT security posture: empty CORS allowlist (matches production default).
    });
    await server.listen();
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  // ── Defect #1: unmasked client frames MUST be rejected (close 1002) ──────────
  it("[#1] rejects an UNMASKED client text frame with close 1002", async () => {
    const socket = await wsHandshake(port);
    const res = await driveFrames(socket, [
      buildFrame({ opcode: 0x1, payload: TEXT('{"type":"ping","at":"x"}'), masked: false }),
    ]);
    expect(res.closeCode).toBe(1002);
    expect(gateway.received).toHaveLength(0);
  });

  it("[#1 no-degrade] a normal MASKED text frame still round-trips to handleClientFrame", async () => {
    const socket = await wsHandshake(port);
    const frame: FridayRealtimeClientFrame = { type: "ping", at: "2026-07-13T12:00:00.000Z" };
    const res = await driveFrames(socket, [
      buildFrame({ opcode: 0x1, payload: TEXT(JSON.stringify(frame)) }),
    ]);
    expect(res.closeCode).toBeNull();
    expect(gateway.received).toEqual([frame]);
    // Server frame echoed back unchanged (byte-for-byte prior behavior).
    expect(res.texts.some((t) => t.includes('"pong"'))).toBe(true);
  });

  // ── Defect #2: any RSV bit set (no extension negotiated) → close 1002 ─────────
  it("[#2] rejects a frame with RSV1 set with close 1002", async () => {
    const socket = await wsHandshake(port);
    const res = await driveFrames(socket, [
      buildFrame({ opcode: 0x1, payload: TEXT('{"type":"ping","at":"x"}'), rsv: 0x40 }),
    ]);
    expect(res.closeCode).toBe(1002);
    expect(gateway.received).toHaveLength(0);
  });

  // ── Defect #3: reserved opcodes 0x3-0x7 / 0xb-0xf → close 1002 ────────────────
  it("[#3] rejects a reserved data opcode 0x3 with close 1002", async () => {
    const socket = await wsHandshake(port);
    const res = await driveFrames(socket, [
      buildFrame({ opcode: 0x3, payload: TEXT("x") }),
    ]);
    expect(res.closeCode).toBe(1002);
  });

  it("[#3] rejects a reserved control opcode 0xb with close 1002", async () => {
    const socket = await wsHandshake(port);
    const res = await driveFrames(socket, [
      buildFrame({ opcode: 0xb, payload: TEXT("x") }),
    ]);
    expect(res.closeCode).toBe(1002);
  });

  // ── Defect #4: control frames MUST be ≤125 bytes and unfragmented (FIN=1) ─────
  it("[#4] rejects an oversized (>125B) control ping with close 1002", async () => {
    const socket = await wsHandshake(port);
    const res = await driveFrames(socket, [
      buildFrame({ opcode: 0x9, payload: Buffer.alloc(200, 0x61) }),
    ]);
    expect(res.closeCode).toBe(1002);
  });

  it("[#4] rejects a fragmented control ping (FIN=0) with close 1002", async () => {
    const socket = await wsHandshake(port);
    const res = await driveFrames(socket, [
      buildFrame({ opcode: 0x9, payload: TEXT("hi"), fin: false }),
    ]);
    expect(res.closeCode).toBe(1002);
  });

  it("[#4 no-degrade] a valid ≤125B ping is echoed as a pong without corruption", async () => {
    const socket = await wsHandshake(port);
    const pingPayload = TEXT("keepalive-123");
    const res = await driveFrames(socket, [
      buildFrame({ opcode: 0x9, payload: pingPayload }),
    ]);
    expect(res.closeCode).toBeNull();
    const pong = res.frames.find((f) => f.opcode === 0xa);
    expect(pong).toBeDefined();
    expect(pong!.payload.equals(pingPayload)).toBe(true);
  });

  // ── Defect #5: invalid UTF-8 in a text frame → close 1007 (before JSON.parse) ─
  it("[#5] rejects invalid UTF-8 in a text frame with close 1007", async () => {
    const socket = await wsHandshake(port);
    // 0xff is never a valid UTF-8 byte.
    const bad = Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]); // { " <0xff> " }
    const res = await driveFrames(socket, [buildFrame({ opcode: 0x1, payload: bad })]);
    expect(res.closeCode).toBe(1007);
    expect(gateway.received).toHaveLength(0);
  });

  it("[#5 no-degrade] valid multibyte UTF-8 text is decoded and forwarded intact", async () => {
    const socket = await wsHandshake(port);
    const frame = { type: "ping", at: "文字-café-2026" } as unknown as FridayRealtimeClientFrame;
    const res = await driveFrames(socket, [
      buildFrame({ opcode: 0x1, payload: TEXT(JSON.stringify(frame)) }),
    ]);
    expect(res.closeCode).toBeNull();
    expect(gateway.received).toEqual([frame]);
  });

  // ── Defect #6: fragmentation / continuation (opcode 0x0) ──────────────────────
  it("[#6] rejects a continuation frame with no message in progress (close 1002)", async () => {
    const socket = await wsHandshake(port);
    const res = await driveFrames(socket, [
      buildFrame({ opcode: 0x0, payload: TEXT("orphan") }),
    ]);
    expect(res.closeCode).toBe(1002);
  });

  it("[#6] rejects a new data frame while a fragmented message is in progress (close 1002)", async () => {
    const socket = await wsHandshake(port);
    const res = await driveFrames(socket, [
      buildFrame({ opcode: 0x1, payload: TEXT('{"type":'), fin: false }),
      buildFrame({ opcode: 0x1, payload: TEXT('"ping"}'), fin: true }),
    ]);
    expect(res.closeCode).toBe(1002);
  });

  it("[#6 no-degrade] a properly fragmented text message reassembles and forwards", async () => {
    const socket = await wsHandshake(port);
    const whole = '{"type":"ping","at":"2026-07-13T00:00:00.000Z"}';
    const mid = 10;
    const res = await driveFrames(socket, [
      buildFrame({ opcode: 0x1, payload: TEXT(whole.slice(0, mid)), fin: false }),
      buildFrame({ opcode: 0x0, payload: TEXT(whole.slice(mid)), fin: true }),
    ]);
    expect(res.closeCode).toBeNull();
    expect(gateway.received).toEqual([JSON.parse(whole)]);
  });

  // ── Defect #6 (DoS): bound the reassembly accumulation ────────────────────────
  it("[#6-dos] tears down a zero-length continuation flood within a bounded frame count (1009)", async () => {
    const socket = await wsHandshake(port);
    // Start a fragmented text message, then stream empty continuations. Each adds
    // 0 bytes (never trips the size cap) but MUST be bounded by the fragment count.
    const frames: Buffer[] = [buildFrame({ opcode: 0x1, payload: Buffer.alloc(0), fin: false })];
    // Comfortably past MAX_WS_FRAGMENTS (1024) so the count cap must fire.
    for (let i = 0; i < 1100; i++) {
      frames.push(buildFrame({ opcode: 0x0, payload: Buffer.alloc(0), fin: false }));
    }
    const res = await driveFrames(socket, frames, 1500);
    expect(res.closeCode).toBe(1009);
    expect(gateway.received).toHaveLength(0); // message never completes
  });

  it("[#6-dos] tears down when accumulated fragments exceed the 4MB message cap (1009)", async () => {
    const socket = await wsHandshake(port);
    const chunk = Buffer.alloc(1_000_000, 0x61); // 1MB, under the 1MB single-frame cap
    const frames: Buffer[] = [buildFrame({ opcode: 0x1, payload: chunk, fin: false })];
    // 1 start + 4 continuations = 5MB > 4MB assembled ceiling.
    for (let i = 0; i < 4; i++) {
      frames.push(buildFrame({ opcode: 0x0, payload: chunk, fin: false }));
    }
    const res = await driveFrames(socket, frames, 1500);
    expect(res.closeCode).toBe(1009);
    expect(gateway.received).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Defect #7: Origin hardening — default DENY cross-site, ALLOW localhost/native.
// Runs on the DEFAULT empty-allowlist config (production posture).
// ─────────────────────────────────────────────────────────────────────────────
describe("FridayHttpServer realtime WS — Origin hardening (default empty allowlist)", () => {
  let server: FridayHttpServer | null = null;
  let port = 0;

  beforeEach(async () => {
    port = await findFreePort();
    server = createFridayHttpServer({
      routes: createFridayHttpRouteRegistry(),
      wsGateway: makeRecordingWsGateway(),
      middleware: makeStubMiddleware(),
      host: "127.0.0.1",
      port,
      // corsOrigins defaults to [] — cross-site hijacking must still be blocked.
    });
    await server.listen();
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("[#7] rejects a hostile cross-site browser Origin with 403", async () => {
    const line = await upgradeStatusLine(port, "/v1/realtime/ws", {
      Origin: "https://evil.example.com",
    });
    expect(line).toContain("403");
  });

  it("[#7 no-degrade] allows a missing Origin (native / non-browser client)", async () => {
    const socket = await wsHandshake(port, "/v1/realtime/ws");
    socket.destroy();
    // wsHandshake resolves only on HTTP/1.1 101.
    expect(socket).toBeDefined();
  });

  it("[#7 no-degrade] allows a same-host localhost Origin", async () => {
    const line = await upgradeStatusLine(port, "/v1/realtime/ws", {
      Origin: `http://127.0.0.1:${String(port)}`,
    });
    expect(line).toContain("101");
  });

  it("[#7 no-degrade] allows a loopback (localhost) Origin on a different port", async () => {
    const line = await upgradeStatusLine(port, "/v1/realtime/ws", {
      Origin: "http://localhost:5173",
    });
    expect(line).toContain("101");
  });
});
