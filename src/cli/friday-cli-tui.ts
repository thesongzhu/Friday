/**
 * Internal experimental CLI TUI entry point.
 *
 * This module is intentionally not wired into the public CLI parser.
 *
 * @module cli/friday-cli-tui
 */

import { FridayDomainError } from "#errors";
import { createFridayTuiApiClient } from "../tui/friday-tui-api-client.js";
import { createFridayTuiRenderer } from "../tui/friday-tui-renderer.js";
import { createFridayTuiController } from "../tui/friday-tui-controller.js";
import { DEFAULT_TUI_CONFIG } from "../tui/friday-tui.types.js";
import type { FridayTuiConfig, FridayTuiEvent } from "../tui/friday-tui.types.js";

// ─── Types ───

export interface FridayCliTuiOptions {
  readonly apiBaseUrl?: string;
  readonly refreshIntervalMs?: number;
  readonly realtimeEnabled?: boolean;
}

// ─── Factory ───

export async function runFridayCliTui(options: FridayCliTuiOptions = {}): Promise<void> {
  const config: FridayTuiConfig = {
    ...DEFAULT_TUI_CONFIG,
    ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
    ...(options.refreshIntervalMs ? { refreshIntervalMs: options.refreshIntervalMs } : {}),
    ...(options.realtimeEnabled !== undefined ? { realtimeEnabled: options.realtimeEnabled } : {}),
  };

  const apiClient = createFridayTuiApiClient({
    async fetchJson<T>(url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<T> {
      const res = await fetch(url, {
        method: init?.method ?? "GET",
        body: init?.body,
        headers: init?.headers,
      });
      if (!res.ok) throw new FridayDomainError("INTERNAL_ERROR", `HTTP ${res.status}: ${res.statusText}`, { httpStatus: 500 });
      return res.json() as Promise<T>;
    },
    baseUrl: config.apiBaseUrl,
  });

  const renderer = createFridayTuiRenderer();

  // readline for user input
  const readline = await import("node:readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  const controller = createFridayTuiController({
    apiClient,
    renderer,
    config,
    nowIso: () => new Date().toISOString(),
    write: (text: string) => {
      process.stdout.write("\x1b[2J\x1b[H"); // clear screen
      process.stdout.write(text);
      rl.prompt();
    },
    onInput: (cb: (line: string) => void) => {
      rl.on("line", cb);
      return () => rl.removeListener("line", cb);
    },
    onRealtimeEvent: config.realtimeEnabled
      ? (cb: (event: FridayTuiEvent) => void) => {
        // Placeholder — would connect to SSE/WebSocket endpoint
        void cb;
        return () => {};
      }
      : undefined,
  });

  // Graceful shutdown
  process.on("SIGINT", () => {
    controller.stop();
    rl.close();
  });

  rl.on("close", () => {
    controller.stop();
    process.exit(0);
  });

  await controller.start();
}
