/**
 * Native Lark/Feishu WebSocket client.
 *
 * Vendor-adapted verbatim from `@larksuiteoapi/node-sdk` (MIT, lines
 * 88800–89500 of `es/index.js`). Replaces `Lark.WSClient` so Friday's
 * runtime install no longer pulls the SDK + its vulnerable axios chain.
 *
 * Behaviour mirrored from the SDK:
 *   - `POST {domain}/callback/ws/endpoint` with `{AppID, AppSecret}` to pull
 *     the per-session `wss://` URL + `PingInterval/ReconnectCount/Interval/Nonce`.
 *   - Standard `ws` WebSocket connection (no custom auth on top — the URL
 *     itself is signed by Lark's gateway).
 *   - Optional handshake watchdog (`handshakeTimeoutMs`).
 *   - Periodic ping (control frame, header `type=ping`) every `pingInterval`
 *     ms after open. Optional `pingTimeoutSec` watchdog cancels on any
 *     inbound frame (proof of life).
 *   - Pong (control frame, header `type=pong`) updates the ws config.
 *   - Data frames are reassembled by `message_id + sum + seq` via the
 *     `DataCache` helper, then dispatched to the user's `EventDispatcher`.
 *   - ACK frame is sent back with the SDK's exact shape:
 *       payload = JSON.stringify({ code: 200, data?: base64(handlerResult) })
 *       headers = original headers + { key: "biz_rt", value: String(startTime - endTime) }
 *   - Reconnect loop respects `reconnectCount`, `reconnectInterval`, and
 *     `reconnectNonce` jitter; uses a generation counter to invalidate
 *     stale loops on close/start.
 *   - Lifecycle callbacks: `onReady`, `onReconnecting`, `onReconnected`,
 *     `onError` fire at the same points the SDK fires them.
 */

import WebSocket from "ws";
import { decodeLarkFrame, encodeLarkFrame } from "./lark-ws-frame.js";
import type { LarkFrame, LarkFrameHeader } from "./lark-ws-frame.js";
import { LarkLoggerProxy } from "./lark-logger.js";
import type { LarkLogger, LarkLoggerLevelName } from "./lark-logger.js";
import { LarkDomain, formatLarkDomain } from "./lark-domain.js";
import type { LarkEventDispatcher } from "./lark-event-dispatcher.js";

// ─── Vendor enums (verbatim from SDK lines 88908–88947) ───

enum LarkFrameType {
  control = 0,
  data = 1,
}

enum LarkHeaderKey {
  type = "type",
  message_id = "message_id",
  sum = "sum",
  seq = "seq",
  trace_id = "trace_id",
  biz_rt = "biz_rt",
}

enum LarkMessageType {
  event = "event",
  ping = "ping",
  pong = "pong",
}

const LARK_ERROR_CODE_OK = 0;
const LARK_ERROR_CODE_INTERNAL = 1000040343;
const LARK_HTTP_OK = 200;
const LARK_HTTP_INTERNAL_ERROR = 500;
const DEFAULT_PULL_TIMEOUT_MS = 15_000;

// ─── Public types ───

export interface LarkWsClientOptions {
  appId: string;
  appSecret: string;
  domain?: LarkDomain | string;
  loggerLevel?: LarkLoggerLevelName | number;
  logger?: LarkLogger;
  autoReconnect?: boolean;
  source?: string;
  /** Optional handshake watchdog window in ms. */
  handshakeTimeoutMs?: number;
  /** Optional pong watchdog in seconds. */
  pingTimeoutSec?: number;
  onReady?: () => void;
  onReconnecting?: () => void;
  onReconnected?: () => void;
  onError?: (error: Error) => void;
}

export interface LarkWsStartOptions {
  eventDispatcher: LarkEventDispatcher;
}

export interface LarkWsCloseOptions {
  /** Use `terminate()` instead of `close()`. */
  force?: boolean;
}

interface LarkWsConfigState {
  appId: string;
  appSecret: string;
  domain: string;
}

interface LarkWsRuntimeState {
  connectUrl: string;
  pingInterval: number;
  reconnectCount: number;
  reconnectInterval: number;
  reconnectNonce: number;
  deviceId: string;
  serviceId: string;
  autoReconnect: boolean;
}

type PullResult =
  | { ok: true }
  | { ok: false; retryable: true }
  | { ok: false; retryable: false; error: string };

// ─── DataCache (vendor verbatim, SDK lines 88851–88906) ───

interface DataCacheChunk {
  buffer: Array<Uint8Array | undefined>;
  trace_id: string;
  message_id: string;
  create_time: number;
}

interface MergedLarkData {
  trace_id: string;
  message_id: string;
  data: Uint8Array;
}

class LarkDataCache {
  private readonly cache = new Map<string, DataCacheChunk>();
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly logger: LarkLogger;

  constructor(logger: LarkLogger, clearIntervalMs = 10_000) {
    this.logger = logger;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, value] of this.cache) {
        if (now - value.create_time > clearIntervalMs) {
          this.logger.debug(`${value.message_id} event data is deleted as expired, trace_id: ${value.trace_id}`);
          this.cache.delete(key);
        }
      }
    }, clearIntervalMs);
    // Don't block process exit on this housekeeping timer.
    if (typeof (this.cleanupTimer as { unref?: () => void }).unref === "function") {
      (this.cleanupTimer as { unref: () => void }).unref();
    }
  }

  mergeData(params: { message_id: string; sum: number; seq: number; trace_id: string; data: Uint8Array }): MergedLarkData | null {
    const { message_id, sum, seq, trace_id, data } = params;
    let entry = this.cache.get(message_id);
    if (!entry) {
      entry = {
        buffer: new Array<Uint8Array | undefined>(sum).fill(undefined),
        trace_id,
        message_id,
        create_time: Date.now(),
      };
      this.cache.set(message_id, entry);
    }
    entry.buffer[seq] = data;
    if (!entry.buffer.every((item): item is Uint8Array => item instanceof Uint8Array)) {
      return null;
    }
    let totalLen = 0;
    for (const buf of entry.buffer) totalLen += buf.byteLength;
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const buf of entry.buffer) {
      merged.set(buf, offset);
      offset += buf.byteLength;
    }
    this.cache.delete(message_id);
    return { trace_id, message_id, data: merged };
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
    this.cache.clear();
  }
}

// ─── LarkWsClient ───

export class LarkWsClient {
  private readonly logger: LarkLoggerProxy;
  private readonly opts: LarkWsClientOptions;
  private readonly clientConfig: LarkWsConfigState;
  private readonly runtime: LarkWsRuntimeState = {
    connectUrl: "",
    pingInterval: 120 * 1000,
    reconnectCount: -1,
    reconnectInterval: 120 * 1000,
    reconnectNonce: 30 * 1000,
    deviceId: "",
    serviceId: "",
    autoReconnect: true,
  };
  private wsInstance: WebSocket | null = null;
  private eventDispatcher: LarkEventDispatcher | undefined;
  private readonly dataCache: LarkDataCache;

  private pingTimer: NodeJS.Timeout | undefined;
  private livenessTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectGeneration = 0;
  private isConnecting = false;
  private hasEverConnected = false;
  private terminalError = false;

  constructor(options: LarkWsClientOptions) {
    if (!options.appId) throw new Error("LarkWsClient: appId is required");
    if (!options.appSecret) throw new Error("LarkWsClient: appSecret is required");
    this.opts = options;
    this.logger = new LarkLoggerProxy(options.loggerLevel ?? "info", options.logger);
    this.clientConfig = {
      appId: options.appId,
      appSecret: options.appSecret,
      domain: formatLarkDomain(options.domain ?? LarkDomain.Feishu),
    };
    this.runtime.autoReconnect = options.autoReconnect ?? true;
    this.dataCache = new LarkDataCache(this.logger);
  }

  // ─── Public API mirroring SDK surface ───

  async start(params: LarkWsStartOptions): Promise<void> {
    if (!/^cli_[0-9a-fA-F]{16}$/.test(this.clientConfig.appId)) {
      this.logger.error("[lark-ws]", `invalid appId: ${this.clientConfig.appId}`);
      return;
    }
    if (!params.eventDispatcher) {
      this.logger.warn("[lark-ws]", "client need to start with an eventDispatcher");
      return;
    }
    this.terminalError = false;
    this.eventDispatcher = params.eventDispatcher;
    await this.reConnect(true);
  }

  close(params: LarkWsCloseOptions = {}): void {
    const { force = false } = params;
    this.reconnectGeneration++;
    this.clearTimers();
    this.isConnecting = false;
    const wsInstance = this.wsInstance;
    if (wsInstance) {
      wsInstance.removeAllListeners();
      try {
        if (force) wsInstance.terminate(); else wsInstance.close();
      } catch {
        // best effort
      }
      this.wsInstance = null;
    }
    this.dataCache.dispose();
    this.logger.info("[lark-ws]", `ws client closed manually${force ? " (force)" : ""}`);
  }

  // ─── Internal lifecycle ───

  private clearTimers(): void {
    if (this.pingTimer) { clearTimeout(this.pingTimer); this.pingTimer = undefined; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    if (this.livenessTimer) { clearTimeout(this.livenessTimer); this.livenessTimer = undefined; }
  }

  private safeInvoke(label: string, fn: ((...a: unknown[]) => void) | undefined, ...args: unknown[]): void {
    if (!fn) return;
    try {
      fn(...args);
    } catch (e) {
      this.logger.error(`[lark-ws] ${label} callback threw`, e);
    }
  }

  private async pullConnectConfig(): Promise<PullResult> {
    const url = `${this.clientConfig.domain}/callback/ws/endpoint`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_PULL_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "locale": "zh",
          "User-Agent": this.userAgent(),
        },
        body: JSON.stringify({
          AppID: this.clientConfig.appId,
          AppSecret: this.clientConfig.appSecret,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.logger.error("[lark-ws]", `pullConnectConfig HTTP ${response.status}`);
        return { ok: false, retryable: true };
      }
      const body = await response.json() as {
        code: number;
        msg?: string;
        data?: {
          URL?: string;
          ClientConfig?: {
            PingInterval?: number;
            ReconnectCount?: number;
            ReconnectInterval?: number;
            ReconnectNonce?: number;
          };
        };
      };
      if (body.code !== LARK_ERROR_CODE_OK) {
        const reason = body.msg ?? "unknown";
        this.logger.error("[lark-ws]", `code: ${body.code}, ${reason}`);
        if (body.code === LARK_ERROR_CODE_INTERNAL) {
          return { ok: false, retryable: true };
        }
        return { ok: false, retryable: false, error: `pullConnectConfig failed: code=${body.code}, msg=${reason}` };
      }
      const data = body.data ?? {};
      const connectUrl = data.URL ?? "";
      if (!connectUrl) {
        return { ok: false, retryable: false, error: "pullConnectConfig: missing URL in response" };
      }
      const parsedQuery = parseQueryParams(connectUrl);
      const cfg = data.ClientConfig ?? {};
      this.runtime.connectUrl = connectUrl;
      this.runtime.deviceId = parsedQuery.device_id ?? "";
      this.runtime.serviceId = parsedQuery.service_id ?? "";
      if (typeof cfg.PingInterval === "number") this.runtime.pingInterval = cfg.PingInterval * 1000;
      if (typeof cfg.ReconnectCount === "number") this.runtime.reconnectCount = cfg.ReconnectCount;
      if (typeof cfg.ReconnectInterval === "number") this.runtime.reconnectInterval = cfg.ReconnectInterval * 1000;
      if (typeof cfg.ReconnectNonce === "number") this.runtime.reconnectNonce = cfg.ReconnectNonce * 1000;
      this.logger.debug("[lark-ws]", `get connect config success, ws url: ${connectUrl}`);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("[lark-ws]", message);
      return { ok: false, retryable: true };
    } finally {
      clearTimeout(timeout);
    }
  }

  private connect(): Promise<boolean> {
    let wsInstance: WebSocket;
    try {
      wsInstance = new WebSocket(this.runtime.connectUrl);
    } catch (e) {
      this.logger.error("[lark-ws]", "new WebSocket error", e);
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const settleOnce = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(ok);
      };
      const handshakeTimeoutMs = this.opts.handshakeTimeoutMs;
      if (handshakeTimeoutMs && handshakeTimeoutMs > 0) {
        timer = setTimeout(() => {
          this.logger.error("[lark-ws]", `handshake timeout after ${handshakeTimeoutMs}ms`);
          wsInstance.removeAllListeners();
          try { wsInstance.terminate(); } catch { /* best effort */ }
          settleOnce(false);
        }, handshakeTimeoutMs);
      }
      wsInstance.on("open", () => {
        this.logger.debug("[lark-ws]", "ws connect success");
        this.wsInstance = wsInstance;
        this.pingLoop();
        settleOnce(true);
      });
      wsInstance.on("error", (err) => {
        this.logger.error("[lark-ws]", "ws connect failed", err);
        settleOnce(false);
      });
    });
  }

  private async tryConnectCycle(): Promise<PullResult> {
    const pullResult = await this.pullConnectConfig();
    if (!pullResult.ok) return pullResult;
    const connected = await this.connect();
    if (!connected) return { ok: false, retryable: true };
    this.communicate();
    return { ok: true };
  }

  private async reConnect(isStart = false): Promise<void> {
    if (this.isConnecting && !isStart) {
      this.logger.debug("[lark-ws]", "repeat connection");
      return;
    }
    this.isConnecting = true;
    const currentGeneration = ++this.reconnectGeneration;

    if (this.pingTimer) { clearTimeout(this.pingTimer); this.pingTimer = undefined; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }

    const previousInstance = this.wsInstance;
    if (isStart) {
      if (previousInstance) {
        try { previousInstance.terminate(); } catch { /* best effort */ }
      }
      let result: PullResult = { ok: false, retryable: true };
      try {
        result = await this.tryConnectCycle();
      } finally {
        this.isConnecting = false;
      }
      if (result.ok) {
        this.hasEverConnected = true;
        this.safeInvoke("onReady", this.opts.onReady);
      } else if (!result.retryable) {
        this.hasEverConnected = false;
        this.terminalError = true;
        this.safeInvoke("onError", this.opts.onError as ((...a: unknown[]) => void) | undefined, new Error(result.error));
        return;
      } else {
        this.logger.error("[lark-ws]", "connect failed");
        await this.reConnect();
      }
      this.logger.info("[lark-ws]", "ws client ready");
      return;
    }

    const { autoReconnect, reconnectNonce, reconnectCount, reconnectInterval } = this.runtime;
    if (!autoReconnect) {
      if (!this.hasEverConnected) {
        this.terminalError = true;
        this.safeInvoke("onError", this.opts.onError as ((...a: unknown[]) => void) | undefined, new Error("WebSocket connect failed and autoReconnect is disabled"));
      }
      return;
    }
    this.logger.info("[lark-ws]", "reconnect");
    if (this.hasEverConnected) {
      this.safeInvoke("onReconnecting", this.opts.onReconnecting);
    }
    if (previousInstance) {
      try { previousInstance.terminate(); } catch { /* best effort */ }
    }
    this.wsInstance = null;

    const reconnectNonceTime = reconnectNonce ? reconnectNonce * Math.random() : 0;
    this.reconnectTimer = setTimeout(() => {
      const loopReConnect = async (count: number): Promise<void> => {
        if (currentGeneration !== this.reconnectGeneration) return;
        count++;
        const result = await this.tryConnectCycle();
        if (currentGeneration !== this.reconnectGeneration) return;
        if (result.ok) {
          this.logger.debug("[lark-ws]", "reconnect success");
          if (this.hasEverConnected) {
            this.safeInvoke("onReconnected", this.opts.onReconnected);
          } else {
            this.hasEverConnected = true;
            this.safeInvoke("onReady", this.opts.onReady);
          }
          this.isConnecting = false;
          return;
        }
        if (!result.retryable) {
          this.isConnecting = false;
          this.hasEverConnected = false;
          this.terminalError = true;
          this.safeInvoke("onError", this.opts.onError as ((...a: unknown[]) => void) | undefined, new Error(result.error));
          return;
        }
        this.logger.info("[lark-ws]", `unable to connect after ${count} attempts`);
        if (reconnectCount >= 0 && count >= reconnectCount) {
          this.isConnecting = false;
          this.terminalError = true;
          this.safeInvoke("onError", this.opts.onError as ((...a: unknown[]) => void) | undefined, new Error(`WebSocket reconnect exhausted after ${count} attempts`));
          return;
        }
        this.reconnectTimer = setTimeout(() => { void loopReConnect(count); }, reconnectInterval);
      };
      void loopReConnect(0);
    }, reconnectNonceTime);
  }

  private pingLoop(): void {
    const { serviceId, pingInterval } = this.runtime;
    const wsInstance = this.wsInstance;
    if (wsInstance && wsInstance.readyState === WebSocket.OPEN) {
      const frame: LarkFrame = {
        SeqID: 0,
        LogID: 0,
        service: Number(serviceId),
        method: LarkFrameType.control,
        headers: [{ key: LarkHeaderKey.type, value: LarkMessageType.ping }],
      };
      this.sendMessage(frame);
      this.armLiveness();
      this.logger.trace("[lark-ws]", "ping success");
    }
    this.pingTimer = setTimeout(() => { this.pingLoop(); }, pingInterval);
  }

  private armLiveness(): void {
    const pingTimeoutSec = this.opts.pingTimeoutSec;
    if (!pingTimeoutSec) return;
    if (this.livenessTimer) clearTimeout(this.livenessTimer);
    this.livenessTimer = setTimeout(() => {
      this.livenessTimer = undefined;
      this.logger.warn("[lark-ws]", `no pong/inbound within ${pingTimeoutSec}s, terminating to trigger reconnect`);
      try { this.wsInstance?.terminate(); } catch { /* best effort */ }
    }, pingTimeoutSec * 1000);
  }

  private clearLiveness(): void {
    if (this.livenessTimer) {
      clearTimeout(this.livenessTimer);
      this.livenessTimer = undefined;
    }
  }

  private communicate(): void {
    const wsInstance = this.wsInstance;
    if (!wsInstance) return;
    wsInstance.on("message", (buffer: Buffer | ArrayBuffer | Buffer[]) => {
      this.clearLiveness();
      const bytes = toUint8Array(buffer);
      let frame: LarkFrame;
      try {
        frame = decodeLarkFrame(bytes);
      } catch (e) {
        this.logger.error("[lark-ws]", "frame decode failed", e);
        return;
      }
      if (frame.method === LarkFrameType.control) {
        this.handleControlData(frame);
      } else if (frame.method === LarkFrameType.data) {
        void this.handleEventData(frame);
      }
    });
    wsInstance.on("error", (err) => {
      this.logger.error("[lark-ws]", "ws error", err);
    });
    wsInstance.on("close", () => {
      this.logger.debug("[lark-ws]", "client closed");
      this.clearLiveness();
      void this.reConnect();
    });
  }

  private handleControlData(frame: LarkFrame): void {
    const headers = frame.headers ?? [];
    const type = headers.find((h) => h.key === LarkHeaderKey.type)?.value;
    if (type === LarkMessageType.ping) return;
    if (type === LarkMessageType.pong && frame.payload && frame.payload.byteLength > 0) {
      this.logger.trace("[lark-ws]", "receive pong");
      try {
        const text = new TextDecoder("utf-8").decode(frame.payload);
        const parsed = JSON.parse(text) as {
          PingInterval?: number;
          ReconnectCount?: number;
          ReconnectInterval?: number;
          ReconnectNonce?: number;
        };
        if (typeof parsed.PingInterval === "number") this.runtime.pingInterval = parsed.PingInterval * 1000;
        if (typeof parsed.ReconnectCount === "number") this.runtime.reconnectCount = parsed.ReconnectCount;
        if (typeof parsed.ReconnectInterval === "number") this.runtime.reconnectInterval = parsed.ReconnectInterval * 1000;
        if (typeof parsed.ReconnectNonce === "number") this.runtime.reconnectNonce = parsed.ReconnectNonce * 1000;
      } catch (e) {
        this.logger.warn("[lark-ws]", "failed to parse pong payload", e);
      }
    }
  }

  private async handleEventData(frame: LarkFrame): Promise<void> {
    const headers = frame.headers ?? [];
    const headerMap: Record<string, string> = {};
    for (const h of headers) headerMap[h.key] = h.value;
    const { message_id, sum, seq, type, trace_id } = headerMap;
    if (type !== LarkMessageType.event) return;
    if (!message_id || sum === undefined || seq === undefined) return;
    const merged = this.dataCache.mergeData({
      message_id,
      sum: Number(sum),
      seq: Number(seq),
      trace_id: trace_id ?? "",
      data: frame.payload ?? new Uint8Array(0),
    });
    if (!merged) return;

    let parsedEvent: Record<string, unknown> | null = null;
    try {
      const text = new TextDecoder("utf-8").decode(merged.data);
      parsedEvent = JSON.parse(text) as Record<string, unknown>;
    } catch (e) {
      this.logger.error("[lark-ws]", "merged event JSON parse failed", e);
    }

    const respPayload: { code: number; data?: string } = { code: LARK_HTTP_OK };
    const startTime = Date.now();
    if (parsedEvent && this.eventDispatcher) {
      try {
        const result = await this.eventDispatcher.invoke(parsedEvent, { needCheck: false });
        if (result !== undefined && result !== null) {
          respPayload.data = Buffer.from(JSON.stringify(result)).toString("base64");
        }
      } catch (error) {
        respPayload.code = LARK_HTTP_INTERNAL_ERROR;
        this.logger.error("[lark-ws]", `invoke event failed, message_id: ${message_id}; trace_id: ${trace_id}; error: ${String(error)}`);
      }
    } else if (!parsedEvent) {
      respPayload.code = LARK_HTTP_INTERNAL_ERROR;
    }
    const endTime = Date.now();
    const ackHeaders: LarkFrameHeader[] = [
      ...headers,
      { key: LarkHeaderKey.biz_rt, value: String(startTime - endTime) },
    ];
    const ack: LarkFrame = {
      SeqID: frame.SeqID,
      LogID: frame.LogID,
      service: frame.service,
      method: frame.method,
      headers: ackHeaders,
      payloadEncoding: frame.payloadEncoding,
      payloadType: frame.payloadType,
      payload: new TextEncoder().encode(JSON.stringify(respPayload)),
      LogIDNew: frame.LogIDNew,
    };
    this.sendMessage(ack);
  }

  private sendMessage(frame: LarkFrame): void {
    const wsInstance = this.wsInstance;
    if (!wsInstance || wsInstance.readyState !== WebSocket.OPEN) return;
    const encoded = encodeLarkFrame(frame);
    wsInstance.send(encoded, (err) => {
      if (err) this.logger.error("[lark-ws]", "send data failed", err);
    });
  }

  private userAgent(): string {
    const source = this.opts.source ?? "friday";
    return `friday-lark-ws/1.0 (${source})`;
  }
}

// ─── Helpers ───

function toUint8Array(buffer: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (Array.isArray(buffer)) {
    return Uint8Array.from(Buffer.concat(buffer));
  }
  if (buffer instanceof ArrayBuffer) {
    return new Uint8Array(buffer);
  }
  // Node `Buffer` already extends Uint8Array.
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function parseQueryParams(urlString: string): Record<string, string> {
  const out: Record<string, string> = {};
  const queryIdx = urlString.indexOf("?");
  if (queryIdx < 0) return out;
  const qs = urlString.slice(queryIdx + 1);
  for (const pair of qs.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq < 0) {
      out[decodeURIComponent(pair)] = "";
    } else {
      out[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
    }
  }
  return out;
}

// Re-export for callers that need the enum.
export { LarkDomain };
