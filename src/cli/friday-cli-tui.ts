/**
 * Friday CLI TUI entry point.
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

interface FridayCliAuthEnvelope {
  ok: boolean;
  data?: {
    accessToken?: string;
  };
  error?: {
    code?: string;
    message?: string;
  };
}

function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    return parsed.hostname === "127.0.0.1"
      || parsed.hostname === "localhost"
      || parsed.hostname === "::1";
  } catch {
    return false;
  }
}

// ─── Factory ───

export async function runFridayCliTui(options: FridayCliTuiOptions = {}): Promise<void> {
  const config: FridayTuiConfig = {
    ...DEFAULT_TUI_CONFIG,
    ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
    ...(options.refreshIntervalMs ? { refreshIntervalMs: options.refreshIntervalMs } : {}),
    ...(options.realtimeEnabled !== undefined ? { realtimeEnabled: options.realtimeEnabled } : {}),
  };
  const configuredAccessToken = process.env.FRIDAY_TUI_ACCESS_TOKEN?.trim() || undefined;
  const localPassphrase = process.env.FRIDAY_TEST_LOCAL_PASSPHRASE?.trim()
    || process.env.FRIDAY_LOCAL_PASSPHRASE?.trim()
    || "friday-cli-tui-passphrase-123";
  const loopbackBaseUrl = isLoopbackBaseUrl(config.apiBaseUrl);
  let cachedAccessToken = configuredAccessToken;

  async function loginLocalPassphrase(): Promise<string> {
    const bootstrapStatusResponse = await fetch(`${config.apiBaseUrl}/v1/auth/bootstrap/status`);
    const bootstrapStatus = await bootstrapStatusResponse.json().catch(() => null) as {
      ok?: boolean;
      data?: { bootstrapRequired?: boolean };
    } | null;
    if (bootstrapStatusResponse.ok && bootstrapStatus?.ok === true && bootstrapStatus.data?.bootstrapRequired === true) {
      await fetch(`${config.apiBaseUrl}/v1/auth/bootstrap/local-passphrase`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localPassphrase }),
      });
    }

    const response = await fetch(`${config.apiBaseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPassphrase }),
    });
    const body = await response.json().catch(() => null) as FridayCliAuthEnvelope | null;
    if (!response.ok || body?.ok !== true || typeof body.data?.accessToken !== "string") {
      throw new FridayDomainError(
        typeof body?.error?.code === "string" ? body.error.code : "UNAUTHORIZED",
        typeof body?.error?.message === "string"
          ? body.error.message
          : `HTTP ${response.status}: ${response.statusText}`,
        { httpStatus: response.status },
      );
    }
    cachedAccessToken = body.data.accessToken;
    return cachedAccessToken;
  }

  async function resolveAccessToken(forceRefresh = false): Promise<string | undefined> {
    if (configuredAccessToken && !forceRefresh) {
      return configuredAccessToken;
    }
    if (cachedAccessToken && !forceRefresh) {
      return cachedAccessToken;
    }
    if (!loopbackBaseUrl) {
      return undefined;
    }
    return loginLocalPassphrase();
  }

  const apiClient = createFridayTuiApiClient({
    async fetchJson<T>(url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<T> {
      const doFetch = async (token: string | undefined) =>
        fetch(url, {
          method: init?.method ?? "GET",
          body: init?.body,
          headers: {
            ...init?.headers,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });

      let token = await resolveAccessToken(false);
      let res = await doFetch(token);

      if (res.status === 401 && !configuredAccessToken && loopbackBaseUrl) {
        token = await resolveAccessToken(true);
        res = await doFetch(token);
      }

      const body = await res.json().catch(() => null) as {
        error?: {
          code?: string;
          message?: string;
        };
      } | null;

      if (!res.ok) {
        throw new FridayDomainError(
          typeof body?.error?.code === "string" ? body.error.code : "INTERNAL_ERROR",
          typeof body?.error?.message === "string"
            ? body.error.message
            : `HTTP ${res.status}: ${res.statusText}`,
          { httpStatus: res.status },
        );
      }
      return body as T;
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
