import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createFridayHttpServer, createFridayHttpRouteRegistry } from "#api";
import type { FridayHttpServer } from "#api";
import type { FridayRealtimeWsGateway } from "#api";
import type { FridayAuthMiddlewareFactory } from "#api";

// ─── Helpers ───

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("Could not determine free port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function makeStubWsGateway(): FridayRealtimeWsGateway {
  return {
    handleClientFrame: () => ({ handled: false }),
    addConnection: () => {},
    removeConnection: () => {},
    broadcastEvent: () => {},
  } as unknown as FridayRealtimeWsGateway;
}

function makeStubMiddleware(): FridayAuthMiddlewareFactory {
  return {
    requireAuth: () => ({ passed: true as const }),
    requireAnyScope: () => ({ passed: true as const }),
    requireAnyRole: () => ({ passed: true as const }),
    enforceRateLimit: () => ({ passed: true as const }),
  };
}

function createRoutesWithPing() {
  const routes = createFridayHttpRouteRegistry();
  routes.register({
    operationId: "test.ping",
    method: "GET",
    path: "/v1/ping",
    auth: { public: true },
    async handler() {
      return { pong: true };
    },
  });
  return routes;
}

// ─── Tests ───

describe("FridayHttpServer — Static UI Serving", () => {
  let server: FridayHttpServer;
  let port: number;
  let baseUrl: string;
  let tmpDir: string;

  beforeEach(async () => {
    port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-ui-test-"));
  });

  afterEach(async () => {
    if (server) {
      await server.close();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("serves static files from uiStaticDir", async () => {
    const assetsDir = path.join(tmpDir, "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, "app.js"), "console.log('hello');");

    server = createFridayHttpServer({
      routes: createRoutesWithPing(),
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      port,
      host: "127.0.0.1",
      uiStaticDir: tmpDir,
    });
    await server.listen();

    const res = await fetch(`${baseUrl}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const body = await res.text();
    expect(body).toBe("console.log('hello');");
  });

  it("falls back to index.html for unknown non-API paths (SPA history)", async () => {
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<html>SPA</html>");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      server = createFridayHttpServer({
        routes: createRoutesWithPing(),
        wsGateway: makeStubWsGateway(),
        middleware: makeStubMiddleware(),
        port,
        host: "127.0.0.1",
        uiStaticDir: tmpDir,
      });
      await server.listen();

      const res = await fetch(`${baseUrl}/automations`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(body).toBe("<html>SPA</html>");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not intercept /v1/* API routes", async () => {
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<html>SPA</html>");

    server = createFridayHttpServer({
      routes: createRoutesWithPing(),
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      port,
      host: "127.0.0.1",
      uiStaticDir: tmpDir,
    });
    await server.listen();

    const res = await fetch(`${baseUrl}/v1/ping`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.pong).toBe(true);
  });

  it("returns 404 for /v1/* routes that don't match any handler", async () => {
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<html>SPA</html>");

    server = createFridayHttpServer({
      routes: createRoutesWithPing(),
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      port,
      host: "127.0.0.1",
      uiStaticDir: tmpDir,
    });
    await server.listen();

    const res = await fetch(`${baseUrl}/v1/nonexistent`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("blocks path traversal attempts", async () => {
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<html>SPA</html>");
    // Create a file outside the UI dir
    const secretPath = path.join(os.tmpdir(), "friday-test-secret.txt");
    fs.writeFileSync(secretPath, "SECRET");

    server = createFridayHttpServer({
      routes: createRoutesWithPing(),
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      port,
      host: "127.0.0.1",
      uiStaticDir: tmpDir,
    });
    await server.listen();

    const res = await fetch(`${baseUrl}/../friday-test-secret.txt`);
    // Should get SPA fallback or 200 with index.html, NOT the secret file
    const body = await res.text();
    expect(body).not.toContain("SECRET");

    fs.rmSync(secretPath, { force: true });
  });

  it("does not serve SPA fallback for filesystem-like paths", async () => {
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<html>SPA</html>");

    server = createFridayHttpServer({
      routes: createRoutesWithPing(),
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      port,
      host: "127.0.0.1",
      uiStaticDir: tmpDir,
    });
    await server.listen();

    const res = await fetch(`${baseUrl}/etc/passwd`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("sets immutable cache headers for /assets/ paths", async () => {
    const assetsDir = path.join(tmpDir, "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, "style.css"), "body{}");

    server = createFridayHttpServer({
      routes: createRoutesWithPing(),
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      port,
      host: "127.0.0.1",
      uiStaticDir: tmpDir,
    });
    await server.listen();

    const res = await fetch(`${baseUrl}/assets/style.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("returns no-cache for non-asset files like index.html", async () => {
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<html></html>");

    server = createFridayHttpServer({
      routes: createRoutesWithPing(),
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      port,
      host: "127.0.0.1",
      uiStaticDir: tmpDir,
    });
    await server.listen();

    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });
});
