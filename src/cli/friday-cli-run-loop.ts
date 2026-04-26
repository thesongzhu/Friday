/**
 * Phase 3 Batch 2 — CLI run loop.
 *
 * Keeps the Friday process alive after hub.start() by listening on
 * an HTTP server and handling graceful shutdown via SIGINT/SIGTERM.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FridayHub } from "#hub";
import { createFridayHttpServer } from "../api/http/friday-http-server.js";
import type { FridayHttpTrustProxyMode } from "../api/http/friday-http-client-ip.js";
import { buildOpenBrowserUrlCommand } from "./friday-cli-open-url.js";

// Resolve the UI bundle shipped alongside this CLI module.
// After build, this file lives at dist/cli/friday-cli-run-loop.js, so dist/ui
// is a sibling: `../ui` relative to __dirname. This lets `npm install -g`
// users run `friday start` from any directory without setting
// FRIDAY_UI_DIST_DIR. As a secondary fallback for local dev where a user
// runs an unbuilt module directly, also accept `process.cwd()/dist/ui`.
function resolveBundledUiStaticDir(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const bundled = resolve(here, "../ui");
    if (existsSync(bundled)) return bundled;
  } catch {
    // fall through to cwd-based fallback
  }
  return resolve(process.cwd(), "dist/ui");
}

// ─── Types ───

export interface FridayCliRunLoopDeps {
  hub: FridayHub;
  port: number;
  host?: string;
  corsOrigins?: string[];
  logRequests?: boolean;
  trustProxyMode?: FridayHttpTrustProxyMode;
  /** Directory containing static UI assets. Default: dist/ui bundled alongside this module. */
  uiStaticDir?: string;
  /** Override process.exit for testing. Defaults to process.exit. */
  exit?: (code: number) => void;
}

// ─── Run loop ───

export function runFridayCliLoop(deps: FridayCliRunLoopDeps): Promise<void> {
  const { hub, port, host, corsOrigins, logRequests, exit = (code: number) => process.exit(code) } = deps;
  const listenHost = host ?? "127.0.0.1";
  const uiStaticDir = deps.uiStaticDir ?? resolveBundledUiStaticDir();

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
        console.log(`   Open ${url} in your browser to get started.`);

        // Auto-open browser for local mode (not when binding to all interfaces for remote access).
        if (
          process.env.FRIDAY_AUTO_OPEN_UI !== "false" &&
          (listenHost === "127.0.0.1" || listenHost === "localhost")
        ) {
          const { command, args } = buildOpenBrowserUrlCommand(url);
          execFile(command, args, { windowsHide: true }, () => {
            // Best-effort — ignore errors (e.g., headless server, no display).
          });
        }
      })
      .catch((err: unknown) => {
        // P1-05: Detect EADDRINUSE and provide actionable guidance
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "EADDRINUSE") {
          console.error(
            `❌ Port ${String(port)} is already in use.\n` +
            `  Try: friday start --port ${String(port + 1)}\n` +
            `  Or:  lsof -i :${String(port)}  (to find the process using it)`,
          );
        } else {
          console.error("❌ Failed to start HTTP server:", err);
        }
        exit(1);
      });

    // Graceful shutdown handler with timeout guard
    const SHUTDOWN_TIMEOUT_MS = 30_000;
    const shutdown = async () => {
      console.log("\n🛑 Shutting down Friday…");

      const forceExitTimer = setTimeout(() => {
        console.error("[friday][cli-run-loop] Graceful shutdown timed out after 30s, forcing exit");
        exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      // Ensure timer doesn't keep the process alive if shutdown completes
      forceExitTimer.unref();

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

      clearTimeout(forceExitTimer);
      resolve();
      exit(0);
    };

    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  });
}
