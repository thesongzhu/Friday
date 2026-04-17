/**
 * Environment helpers for live E2E tests with real LLM providers.
 *
 * Canonical lane: FRIDAY_E2E_LIVE_ANTHROPIC=1 + FRIDAY_ANTHROPIC_API_KEY
 * Optional lanes: FRIDAY_E2E_LIVE_OPENAI=1, FRIDAY_E2E_LIVE_OLLAMA=1
 * Target: FRIDAY_E2E_TARGET=local|cloud (default: local)
 * Backward compatibility: E2E_LIVE=1
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";

import { createFridayHub } from "#hub";
import type { FridayHub } from "#hub";
import { createFridayHttpServer } from "#api";
import type { FridayHttpServer } from "#api";
import {
  E2E_TARGET,
  ensureCloudTargetReady,
  getCloudE2eConfig,
  loginCloudAndGetTokenPair,
  type FridayE2eTarget,
} from "./cloud-env.js";
import {
  hasLiveAnthropicApiKey,
  LIVE_ANTHROPIC_MODEL,
  liveAnthropicCredentialMessage,
  resolveLiveAnthropicApiKeyEnvRef,
} from "../../_helpers/live-anthropic.js";

// ─── Env constants ───

const FRIDAY_E2E_LIVE_ANTHROPIC = process.env.FRIDAY_E2E_LIVE_ANTHROPIC === "1";
const FRIDAY_E2E_LIVE_OLLAMA = process.env.FRIDAY_E2E_LIVE_OLLAMA === "1";
const FRIDAY_E2E_LIVE_OPENAI = process.env.FRIDAY_E2E_LIVE_OPENAI === "1";
const LEGACY_E2E_LIVE = process.env.E2E_LIVE === "1";
export const E2E_LIVE =
  FRIDAY_E2E_LIVE_ANTHROPIC || FRIDAY_E2E_LIVE_OLLAMA || FRIDAY_E2E_LIVE_OPENAI || LEGACY_E2E_LIVE;
/** @deprecated Use E2E_LIVE instead */
export const E2E_REAL = E2E_LIVE;
/** @deprecated Use E2E_LIVE instead */
export const E2E_OLLAMA = E2E_LIVE;
export const E2E_GATED = E2E_LIVE;

export type FridayLiveProviderKind = "anthropic" | "ollama" | "openai";
export const LIVE_PROVIDER_KIND: FridayLiveProviderKind =
  FRIDAY_E2E_LIVE_OPENAI
    ? "openai"
    : FRIDAY_E2E_LIVE_OLLAMA
      ? "ollama"
      : (FRIDAY_E2E_LIVE_ANTHROPIC || (LEGACY_E2E_LIVE && hasLiveAnthropicApiKey()))
        ? "anthropic"
        : "ollama";

export const OLLAMA_BASE_URL =
  process.env.E2E_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
export const OPENAI_BASE_URL =
  process.env.E2E_OPENAI_BASE_URL ?? "https://api.openai.com";
export const ANTHROPIC_BASE_URL =
  process.env.E2E_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
export const OPENAI_API_KEY_ENV =
  process.env.E2E_OPENAI_API_KEY_ENV ?? "OPENAI_API_KEY";
export const ANTHROPIC_API_KEY_ENV_REF = resolveLiveAnthropicApiKeyEnvRef();
export const FAST_MODEL =
  process.env.E2E_FAST_MODEL ??
  (LIVE_PROVIDER_KIND === "anthropic"
    ? LIVE_ANTHROPIC_MODEL
    : LIVE_PROVIDER_KIND === "openai"
      ? "gpt-4o-mini"
      : "llama3.2:3b");
export const CODE_MODEL =
  process.env.E2E_CODE_MODEL ??
  (LIVE_PROVIDER_KIND === "anthropic"
    ? LIVE_ANTHROPIC_MODEL
    : LIVE_PROVIDER_KIND === "openai"
      ? "gpt-4o"
      : "qwen2.5-coder:7b");
export const LIVE_TARGET: FridayE2eTarget = E2E_TARGET;

// ─── Types ───

export interface RealHubEnv {
  target: FridayE2eTarget;
  baseUrl: string;
  accessToken: string;
  refreshToken?: string;
  hub?: FridayHub;
  httpServer?: FridayHttpServer;
  stateDir?: string;
}

interface StartLocalRealHubEnvOptions {
  uiStaticDir?: string;
}

function providerEnvKeysToSanitize(): string[] {
  switch (LIVE_PROVIDER_KIND) {
    case "anthropic":
      return [
        "OPENAI_API_KEY",
        "GOOGLE_API_KEY",
        "OPENROUTER_API_KEY",
        "GROQ_API_KEY",
        "MISTRAL_API_KEY",
        "XAI_API_KEY",
        "OLLAMA_BASE_URL",
      ];
    case "openai":
      return [
        "FRIDAY_ANTHROPIC_API_KEY",
        "ANTHROPIC_API_KEY",
        "GOOGLE_API_KEY",
        "OPENROUTER_API_KEY",
        "GROQ_API_KEY",
        "MISTRAL_API_KEY",
        "XAI_API_KEY",
        "OLLAMA_BASE_URL",
      ];
    case "ollama":
      return [
        "FRIDAY_ANTHROPIC_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GOOGLE_API_KEY",
        "OPENROUTER_API_KEY",
        "GROQ_API_KEY",
        "MISTRAL_API_KEY",
        "XAI_API_KEY",
      ];
    default:
      return [];
  }
}

async function withSanitizedProviderEnv<T>(operation: () => Promise<T>): Promise<T> {
  const keys = providerEnvKeysToSanitize();
  if (keys.length === 0) {
    return operation();
  }

  const originalEntries = new Map<string, string | undefined>();
  for (const key of keys) {
    originalEntries.set(key, process.env[key]);
    delete process.env[key];
  }

  try {
    return await operation();
  } finally {
    for (const [key, value] of originalEntries.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

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

export function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export async function ensureOllamaReady(opts?: {
  requiredModels?: string[];
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 8_000;
  const requiredModels = opts?.requiredModels ?? [FAST_MODEL, CODE_MODEL];

  let res: Response;
  try {
    res = await fetchWithTimeout(`${OLLAMA_BASE_URL}/api/tags`, timeoutMs);
  } catch (error) {
    throw new Error(
      `[Real E2E] Ollama preflight failed: ${OLLAMA_BASE_URL}/api/tags unreachable (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  if (!res.ok) {
    throw new Error(
      `[Real E2E] Ollama preflight failed: /api/tags returned ${String(res.status)}`,
    );
  }

  const body = (await res.json()) as {
    models?: Array<{ name?: string }>;
  };
  const available = new Set<string>(
    (body.models ?? [])
      .map((m) => m.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0),
  );

  const missing = requiredModels.filter((model) => !available.has(model));
  if (missing.length > 0) {
    throw new Error(
      `[Real E2E] Ollama preflight failed: missing models (${missing.join(", ")}). Available: ${[...available].join(", ") || "(none)"}`,
    );
  }
}

export async function ensureOpenAiReady(opts?: {
  requiredKeyEnv?: string;
}): Promise<void> {
  const requiredKeyEnv = opts?.requiredKeyEnv ?? OPENAI_API_KEY_ENV;
  const value = process.env[requiredKeyEnv];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `[Real E2E] OpenAI preflight failed: environment variable '${requiredKeyEnv}' is not set`,
    );
  }
}

export async function ensureAnthropicReady(): Promise<void> {
  if (!ANTHROPIC_API_KEY_ENV_REF) {
    throw new Error(`[Real E2E] Anthropic preflight failed: ${liveAnthropicCredentialMessage()}`);
  }
}

// ─── Hub Environment Factory ───

async function startLocalRealHubEnv(
  stateDir: string,
  opts?: StartLocalRealHubEnvOptions,
): Promise<RealHubEnv> {
  const hub = await withSanitizedProviderEnv(async () => {
    const createdHub = await createFridayHub({
      stateDir,
      skillDirs: [],
      port: 0,
      logRequests: false,
    });
    await createdHub.start();
    return createdHub;
  });

  const port = await findFreePort();
  const httpServer = createFridayHttpServer({
    routes: hub.apiRuntime.routes,
    wsGateway: hub.apiRuntime.wsGateway,
    middleware: hub.apiRuntime.middleware,
    port,
    host: "127.0.0.1",
    logRequests: false,
    uiStaticDir: opts?.uiStaticDir,
  });
  await httpServer.listen();
  const baseUrl = `http://127.0.0.1:${String(port)}`;

  const loginRes = await fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ local: true }),
  });
  const loginJson = (await loginRes.json()) as {
    ok: boolean;
    data: { accessToken: string; refreshToken: string };
  };
  if (!loginJson.ok) {
    throw new Error(
      `Admin login failed: ${JSON.stringify(loginJson)}`,
    );
  }

  return {
    target: "local",
    hub,
    httpServer,
    baseUrl,
    stateDir,
    accessToken: loginJson.data.accessToken,
    refreshToken: loginJson.data.refreshToken,
  };
}

export async function createRealHubEnv(opts?: { uiStaticDir?: string }): Promise<RealHubEnv> {
  if (LIVE_PROVIDER_KIND === "anthropic") {
    await ensureAnthropicReady();
  } else if (LIVE_PROVIDER_KIND === "openai") {
    await ensureOpenAiReady();
  } else if (LIVE_TARGET === "local") {
    await ensureOllamaReady();
  }

  if (LIVE_TARGET === "cloud") {
    const cloudConfig = getCloudE2eConfig();
    if (!cloudConfig) {
      throw new Error("[Real E2E] Cloud target selected but cloud config is unavailable");
    }

    await ensureCloudTargetReady(cloudConfig);
    const tokens = await loginCloudAndGetTokenPair(cloudConfig.baseUrl, cloudConfig);

    return {
      target: "cloud",
      baseUrl: cloudConfig.baseUrl,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  // 1. Create temp state dir
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "friday-real-e2e-"),
  );
  return startLocalRealHubEnv(stateDir, opts);
}

export async function createRealHubEnvFromStateDir(
  stateDir: string,
  opts?: StartLocalRealHubEnvOptions,
): Promise<RealHubEnv> {
  if (LIVE_TARGET !== "local") {
    throw new Error("createRealHubEnvFromStateDir only supports local runtime targets");
  }
  if (!fs.existsSync(stateDir)) {
    throw new Error(`State dir does not exist: ${stateDir}`);
  }
  return startLocalRealHubEnv(stateDir, opts);
}

// ─── Cleanup ───

export async function shutdownRealHubEnv(
  env: RealHubEnv,
  opts: { removeStateDir?: boolean } = {},
): Promise<void> {
  if (env.target !== "local") {
    return;
  }

  const runWithTimeout = async (
    label: string,
    operation: () => Promise<void>,
    timeoutMs = 30_000,
  ): Promise<boolean> => {
    const completed = await Promise.race([
      operation().then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (!completed) {
      console.warn(`[Real E2E] Cleanup timeout — ${label} did not finish within ${String(timeoutMs)}ms`);
    }
    return completed;
  };

  if (env.httpServer) {
    await runWithTimeout("httpServer.close()", () => env.httpServer!.close());
  }
  if (env.hub) {
    await runWithTimeout("hub.stop()", () => env.hub!.stop());
  }
  if (opts.removeStateDir && env.stateDir) {
    try {
      fs.rmSync(env.stateDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(
        "[Real E2E] Cleanup warning — failed to remove stateDir:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

export async function cleanupRealHubEnv(env: RealHubEnv): Promise<void> {
  await shutdownRealHubEnv(env, { removeStateDir: true });
}
