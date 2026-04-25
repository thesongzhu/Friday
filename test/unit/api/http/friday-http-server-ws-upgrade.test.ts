import * as net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFridayHttpRouteRegistry,
  createFridayHttpServer,
} from "#api";
import type { FridayAuthMiddlewareFactory, FridayHttpServer, FridayRealtimeWsGateway } from "#api";
import { createWebchatWsService } from "#channels";

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

function makeStubWsGateway(): FridayRealtimeWsGateway {
  return {
    createConnection: (connId) => ({
      connId,
      principal: null,
      subscriptions: new Map(),
      authenticated: false,
    }),
    handleClientFrame: () => [],
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

async function sendUpgradeRequest(
  port: number,
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("upgrade response timeout"));
    }, 5000);

    socket.on("connect", () => {
      const headerLines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${String(port)}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        ...Object.entries(extraHeaders).map(([key, value]) => `${key}: ${value}`),
        "",
        "",
      ];
      socket.write(headerLines.join("\r\n"));
    });

    socket.on("data", (chunk) => {
      response += chunk.toString("utf-8");
      if (response.includes("\r\n\r\n")) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.end();
        resolve(response);
      }
    });

    socket.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe("FridayHttpServer WS upgrade routing", () => {
  let server: FridayHttpServer | null = null;
  let port = 0;

  beforeEach(async () => {
    port = await findFreePort();
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("accepts realtime websocket upgrade on canonical and compatibility paths", async () => {
    server = createFridayHttpServer({
      routes: createFridayHttpRouteRegistry(),
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      host: "127.0.0.1",
      port,
    });
    await server.listen();

    const realtimeResponse = await sendUpgradeRequest(port, "/v1/realtime/ws");
    expect(realtimeResponse.startsWith("HTTP/1.1 101 Switching Protocols")).toBe(true);

    const compatibilityResponse = await sendUpgradeRequest(port, "/v1/ws");
    expect(compatibilityResponse.startsWith("HTTP/1.1 101 Switching Protocols")).toBe(true);

    const invalidResponse = await sendUpgradeRequest(port, "/v1/realtime/other");
    expect(invalidResponse.startsWith("HTTP/1.1 404 Not Found")).toBe(true);
  });

  it("routes /ws/chat websocket upgrades to webchat service", async () => {
    const webchatWsService = createWebchatWsService();
    await webchatWsService.start("/ws/chat", [], () => {});

    server = createFridayHttpServer({
      routes: createFridayHttpRouteRegistry(),
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      webchatWsService,
      host: "127.0.0.1",
      port,
    });
    await server.listen();

    const response = await sendUpgradeRequest(port, "/ws/chat");
    expect(response.startsWith("HTTP/1.1 101 Switching Protocols")).toBe(true);

    await webchatWsService.stop();
  });

  it("rejects webchat upgrades when token auth mode lacks a verifier", async () => {
    const webchatWsService = createWebchatWsService();
    await webchatWsService.start("/ws/chat", [], () => {}, { authMode: "token" });

    server = createFridayHttpServer({
      routes: createFridayHttpRouteRegistry(),
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      webchatWsService,
      host: "127.0.0.1",
      port,
    });
    await server.listen();

    const response = await sendUpgradeRequest(port, "/ws/chat");
    expect(response.startsWith("HTTP/1.1 401 Unauthorized")).toBe(true);

    await webchatWsService.stop();
  });
});
