/**
 * Web Chat service — WebSocket endpoint abstraction.
 *
 * Includes a real RFC 6455 implementation for the HTTP server upgrade flow
 * and a stub implementation for isolated unit tests.
 */

import * as crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { URL } from "node:url";

// ─── Types ───

export interface WebchatInboundMessage {
  type: "message";
  id: string;
  clientId: string;
  clientName?: string;
  text: string;
  images?: string[];
  replyTo?: string;
  timestamp: number;
}

export interface WebchatOutboundMessage {
  type: "message";
  id: string;
  text: string;
  images?: string[];
  replyTo?: string;
  timestamp: number;
}

// ─── Service Interface ───

export interface WebchatWsService {
  /** Start the WebSocket server on the given path. */
  start(
    wsPath: string,
    allowedOrigins: string[],
    onMessage: (msg: WebchatInboundMessage) => void,
  ): Promise<void>;
  /** Stop the WebSocket server. */
  stop(): Promise<void>;
  /** Send a message to a specific client. */
  sendToClient(clientId: string, message: WebchatOutboundMessage): Promise<void>;
  /** Broadcast a message to all connected clients. */
  broadcast(message: WebchatOutboundMessage): Promise<void>;
  /** Get number of connected clients. */
  clientCount(): number;
  /** Check if the server is running. */
  isRunning(): boolean;
  /** True when this service should handle a WS upgrade for the given pathname. */
  matchesPath(pathname: string): boolean;
  /**
   * Handle a Node HTTP upgrade request. Returns true if this service accepted
   * and handled the connection, false when the request should be routed elsewhere.
   */
  handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): boolean;
}

function normalizeWsPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed === "/") return "/";
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return prefixed.length > 1 ? prefixed.replace(/\/+$/, "") : prefixed;
}

function computeWsAccept(key: string): string {
  return crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-5ABB0DC85B12`)
    .digest("base64");
}

function encodeWsTextFrame(payload: string): Buffer {
  const data = Buffer.from(payload, "utf-8");
  const len = data.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

function sendWsClose(socket: Socket, code = 1000): void {
  const frame = Buffer.alloc(4);
  frame[0] = 0x88;
  frame[1] = 2;
  frame.writeUInt16BE(code, 2);
  socket.write(frame);
}

function buildClientId(url: URL): string {
  const explicit = url.searchParams.get("clientId")?.trim();
  if (explicit) return explicit;
  return crypto.randomUUID();
}

function buildClientName(url: URL): string | undefined {
  const value = url.searchParams.get("name")?.trim();
  return value && value.length > 0 ? value : undefined;
}

// ─── Real Implementation ───

export function createWebchatWsService(): WebchatWsService {
  let running = false;
  let wsPath = "/ws/chat";
  let allowedOrigins: string[] = [];
  let onMessage: ((msg: WebchatInboundMessage) => void) | null = null;

  const clients = new Map<string, Socket>();
  const socketToClientId = new Map<Socket, string>();
  const socketBuffers = new Map<Socket, Buffer>();

  function isOriginAllowed(origin: string | undefined): boolean {
    if (allowedOrigins.length === 0 || allowedOrigins.includes("*")) {
      return true;
    }
    if (!origin) return false;
    return allowedOrigins.includes(origin);
  }

  function cleanupSocket(socket: Socket): void {
    const clientId = socketToClientId.get(socket);
    if (clientId) {
      clients.delete(clientId);
      socketToClientId.delete(socket);
    }
    socketBuffers.delete(socket);
  }

  function writeJsonToClient(socket: Socket, payload: unknown): void {
    if (!socket.writable) return;
    socket.write(encodeWsTextFrame(JSON.stringify(payload)));
  }

  return {
    async start(path, origins, handler) {
      running = true;
      wsPath = normalizeWsPath(path);
      allowedOrigins = [...origins];
      onMessage = handler;
    },

    async stop() {
      running = false;
      onMessage = null;
      for (const socket of clients.values()) {
        try {
          sendWsClose(socket, 1001);
          socket.destroy();
        } catch (err) {
        console.warn("[friday][webchat-service] operation failed:", err instanceof Error ? err.message : String(err));
          // Best-effort cleanup.
        }
      }
      clients.clear();
      socketToClientId.clear();
      socketBuffers.clear();
    },

    async sendToClient(clientId, message) {
      const socket = clients.get(clientId);
      if (!socket || !socket.writable) return;
      writeJsonToClient(socket, message);
    },

    async broadcast(message) {
      for (const socket of clients.values()) {
        if (!socket.writable) continue;
        writeJsonToClient(socket, message);
      }
    },

    clientCount() {
      return clients.size;
    },

    isRunning() {
      return running;
    },

    matchesPath(pathname: string): boolean {
      return running && normalizeWsPath(pathname) === wsPath;
    },

    handleUpgrade(req, socket, head) {
      if (!running || !onMessage) {
        return false;
      }

      const parsedUrl = new URL(req.url ?? "/", "http://localhost");
      if (!this.matchesPath(parsedUrl.pathname)) {
        return false;
      }

      const origin = req.headers.origin;
      if (!isOriginAllowed(origin)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return true;
      }

      const wsKey = req.headers["sec-websocket-key"];
      if (!wsKey || req.headers["upgrade"]?.toLowerCase() !== "websocket") {
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return true;
      }

      const accept = computeWsAccept(wsKey);
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n` +
          "\r\n",
      );

      const clientId = buildClientId(parsedUrl);
      const clientName = buildClientName(parsedUrl);
      const previous = clients.get(clientId);
      if (previous && previous !== socket) {
        try {
          sendWsClose(previous, 1001);
          previous.destroy();
        } catch (err) {
        console.warn("[friday][webchat-service] operation failed:", err instanceof Error ? err.message : String(err));
          // Best-effort stale client replacement.
        }
      }

      clients.set(clientId, socket);
      socketToClientId.set(socket, clientId);
      socketBuffers.set(socket, head.length > 0 ? Buffer.from(head) : Buffer.alloc(0));

      // Optional hello frame for browser clients.
      writeJsonToClient(socket, {
        type: "hello",
        clientId,
      });

      socket.on("data", (chunk: Buffer) => {
        const prior = socketBuffers.get(socket) ?? Buffer.alloc(0);
        let buffer = Buffer.concat([prior, chunk]);

        while (buffer.length >= 2) {
          const firstByte = buffer[0]!;
          const secondByte = buffer[1]!;
          const opcode = firstByte & 0x0f;
          const masked = (secondByte & 0x80) !== 0;
          let payloadLen = secondByte & 0x7f;
          let offset = 2;

          if (payloadLen === 126) {
            if (buffer.length < 4) break;
            payloadLen = buffer.readUInt16BE(2);
            offset = 4;
          } else if (payloadLen === 127) {
            if (buffer.length < 10) break;
            payloadLen = Number(buffer.readBigUInt64BE(2));
            offset = 10;
          }

          const maskSize = masked ? 4 : 0;
          const totalLen = offset + maskSize + payloadLen;
          if (buffer.length < totalLen) break;

          const maskKey = masked ? buffer.subarray(offset, offset + 4) : undefined;
          const payloadData = Buffer.from(buffer.subarray(offset + maskSize, totalLen));
          if (maskKey) {
            for (let i = 0; i < payloadData.length; i++) {
              payloadData[i] = payloadData[i]! ^ maskKey[i % 4]!;
            }
          }
          buffer = buffer.subarray(totalLen);

          if (opcode === 0x1) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(payloadData.toString("utf-8"));
            } catch (err) {
        console.warn("[friday][webchat-service] operation failed:", err instanceof Error ? err.message : String(err));
              writeJsonToClient(socket, {
                type: "error",
                code: "INVALID_JSON",
                message: "Webchat frame payload must be valid JSON.",
              });
              continue;
            }

            const payload = parsed as {
              type?: unknown;
              id?: unknown;
              text?: unknown;
              images?: unknown;
              replyTo?: unknown;
              timestamp?: unknown;
            };
            if (payload.type !== "message" || typeof payload.text !== "string") {
              continue;
            }

            const message: WebchatInboundMessage = {
              type: "message",
              id:
                typeof payload.id === "string" && payload.id.trim().length > 0
                  ? payload.id
                  : crypto.randomUUID(),
              clientId,
              clientName,
              text: payload.text,
              images: Array.isArray(payload.images)
                ? payload.images.filter((entry): entry is string => typeof entry === "string")
                : undefined,
              replyTo:
                typeof payload.replyTo === "string" && payload.replyTo.trim().length > 0
                  ? payload.replyTo
                  : undefined,
              timestamp:
                typeof payload.timestamp === "number" && Number.isFinite(payload.timestamp)
                  ? payload.timestamp
                  : Date.now(),
            };
            const handler = onMessage;
            if (handler) {
              handler(message);
            }
          } else if (opcode === 0x8) {
            sendWsClose(socket, 1000);
            cleanupSocket(socket);
            socket.destroy();
            return;
          } else if (opcode === 0x9) {
            const pong = Buffer.alloc(2 + payloadData.length);
            pong[0] = 0x8a;
            pong[1] = payloadData.length;
            payloadData.copy(pong, 2);
            socket.write(pong);
          }
        }

        socketBuffers.set(socket, buffer);
      });

      socket.on("close", () => {
        cleanupSocket(socket);
      });
      socket.on("error", () => {
        cleanupSocket(socket);
        socket.destroy();
      });

      return true;
    },
  };
}

// ─── Stub Implementation ───

export function createWebchatWsServiceStub(): WebchatWsService {
  let running = false;
  let wsPath = "/ws/chat";
  let clients = 0;

  return {
    async start(configuredWsPath, _allowedOrigins, _onMessage) {
      running = true;
      wsPath = normalizeWsPath(configuredWsPath);
      // Stub: in production, creates a WebSocket server
    },
    async stop() {
      running = false;
      clients = 0;
    },
    async sendToClient(_clientId, _message) {
      // Stub: sends to specific WebSocket client
    },
    async broadcast(_message) {
      // Stub: broadcasts to all clients
    },
    clientCount() {
      return clients;
    },
    isRunning() {
      return running;
    },
    matchesPath(pathname) {
      return running && normalizeWsPath(pathname) === wsPath;
    },
    handleUpgrade(_req, _socket, _head) {
      return false;
    },
  };
}
