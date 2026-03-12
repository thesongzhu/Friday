/**
 * Phase 3 Batch 2 — CLI run loop.
 *
 * Keeps the Friday process alive after hub.start() by listening on
 * an HTTP server and handling graceful shutdown via SIGINT/SIGTERM.
 */

import { resolve } from "node:path";
import type { FridayHub } from "#hub";
import { createFridayHttpServer } from "../api/http/friday-http-server.js";

// ─── Types ───

export interface FridayCliRunLoopDeps {
  hub: FridayHub;
  port: number;
  host?: string;
  corsOrigins?: string[];
  logRequests?: boolean;
  /** Directory containing static UI assets. Default: dist/ui relative to cwd. */
  uiStaticDir?: string;
  /** Override process.exit for testing. Defaults to process.exit. */
  exit?: (code: number) => void;
}

// ─── Run loop ───

export function runFridayCliLoop(deps: FridayCliRunLoopDeps): Promise<void> {
  const { hub, port, host, corsOrigins, logRequests, exit = (code: number) => process.exit(code) } = deps;
  const listenHost = host ?? "127.0.0.1";
  const uiStaticDir = deps.uiStaticDir ?? resolve(process.cwd(), "dist/ui");

  const httpServer = createFridayHttpServer({
    routes: hub.apiRuntime.routes,
    wsGateway: hub.apiRuntime.wsGateway,
    eventBus: hub.apiRuntime.eventBus,
    middleware: hub.apiRuntime.middleware,
    webchatWsService: hub.webchatWsService,
    port,
    host: listenHost,
    corsOrigins,
    logRequests,
    uiStaticDir,
  });

  return new Promise<void>((resolve) => {
    // Start listening
    httpServer
      .listen()
      .then(() => {
        console.log(`🚀 Friday API server listening on http://${listenHost}:${port}`);
      })
      .catch((err: unknown) => {
        console.error("❌ Failed to start HTTP server:", err);
        exit(1);
      });

    // Graceful shutdown handler
    const shutdown = async () => {
      console.log("\n🛑 Shutting down Friday…");

      try {
        await httpServer.close();
      } catch {
        // Best-effort close
      }

      try {
        await hub.stop();
      } catch {
        // Best-effort stop
      }

      resolve();
      exit(0);
    };

    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  });
}
