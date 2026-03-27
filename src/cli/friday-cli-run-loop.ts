/**
 * Phase 3 Batch 2 — CLI run loop.
 *
 * Keeps the Friday process alive after hub.start() by listening on
 * an HTTP server and handling graceful shutdown via SIGINT/SIGTERM.
 */

import { exec } from "node:child_process";
import { resolve } from "node:path";
import type { FridayHub } from "#hub";
import { createFridayHttpServer } from "../api/http/friday-http-server.js";
import type { FridayHttpTrustProxyMode } from "../api/http/friday-http-client-ip.js";

// ─── Types ───

export interface FridayCliRunLoopDeps {
  hub: FridayHub;
  port: number;
  host?: string;
  corsOrigins?: string[];
  logRequests?: boolean;
  trustProxyMode?: FridayHttpTrustProxyMode;
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
    trustProxyMode: deps.trustProxyMode,
    uiStaticDir,
  });

  return new Promise<void>((resolve) => {
    // Start listening
    httpServer
      .listen()
      .then(() => {
        const url = `http://${listenHost === "0.0.0.0" ? "localhost" : listenHost}:${String(port)}`;
        console.log(`🚀 Friday API server listening on ${url}`);

        // Auto-open browser for local mode (not when binding to all interfaces for remote access).
        if (listenHost === "127.0.0.1" || listenHost === "localhost") {
          const openCmd = process.platform === "darwin"
            ? `open "${url}"`
            : process.platform === "win32"
              ? `start "" "${url}"`
              : `xdg-open "${url}"`;
          exec(openCmd, () => {
            // Best-effort — ignore errors (e.g., headless server, no display).
          });
        }
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
      } catch (err) {
        // Best-effort close
        console.warn("[friday][cli-run-loop] http server close failed:", err instanceof Error ? err.message : String(err));
      }

      try {
        await hub.stop();
      } catch (err) {
        // Best-effort stop
        console.warn("[friday][cli-run-loop] hub stop failed:", err instanceof Error ? err.message : String(err));
      }

      resolve();
      exit(0);
    };

    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  });
}
