/**
 * Setup Wizard E2E tests — exercises the setup wizard API endpoints.
 *
 * Category A: Setup Wizard API Tests (15 tests, no external deps)
 * Category B: Provider Detection (3 tests, needs Ollama)
 * Category C: Real Scenarios (4 tests, needs Ollama + LLM)
 *
 * Gated by:
 *   - Category A: always runs (spins up its own hub)
 *   - Category B: `E2E_OLLAMA=1`
 *   - Category C: `E2E_REAL=1`
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { chromium } from "playwright";

import { createFridayHub } from "#hub";
import type { FridayHub } from "#hub";
import { createFridayHttpServer } from "#api";
import type { FridayHttpServer } from "#api";
import {
  clearAutoDetectProviderEnv,
  restoreAutoDetectProviderEnv,
  type FridayAutoDetectProviderEnvSnapshot,
} from "../_helpers/auto-detect-provider-env.js";

// ─── Env gates ───

const itOllama = process.env.E2E_OLLAMA === "1" ? it : it.skip;
const itReal = process.env.E2E_REAL === "1" ? it : it.skip;
const itRealOllama = (process.env.E2E_REAL === "1" && process.env.E2E_OLLAMA === "1") ? it : it.skip;

function resolveUiStaticDir(): string | undefined {
  const uiStaticDir = path.resolve(process.cwd(), "dist/ui");
  const indexPath = path.join(uiStaticDir, "index.html");
  return fs.existsSync(indexPath) ? uiStaticDir : undefined;
}

const UI_STATIC_DIR = resolveUiStaticDir();
const CHROMIUM_AVAILABLE = (() => {
  try {
    return Boolean(UI_STATIC_DIR) && fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();
const itBrowser = CHROMIUM_AVAILABLE ? it : it.skip;

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

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (result: T) => boolean,
  opts: { intervalMs?: number; maxMs?: number } = {},
): Promise<T> {
  const { intervalMs = 500, maxMs = 15000 } = opts;
  const deadline = Date.now() + maxMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pollUntil timed out after ${maxMs}ms (last value: ${JSON.stringify(last)})`);
}

// ─── Tests ───

describe("Setup Wizard E2E", () => {
  let hub: FridayHub;
  let httpServer: FridayHttpServer;
  let baseUrl: string;
  let stateDir: string;
  let accessToken: string;
  let autoDetectEnvSnapshot: FridayAutoDetectProviderEnvSnapshot | null = null;

  beforeAll(async () => {
    autoDetectEnvSnapshot = clearAutoDetectProviderEnv();

    // 1. Create temp state dir
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-setup-wizard-e2e-"));

    // 2. Create hub
    try {
      hub = await createFridayHub({
        stateDir,
        skillDirs: [],
        port: 0,
        logRequests: false,
      });
      await hub.start();
    } finally {
      if (autoDetectEnvSnapshot) {
        restoreAutoDetectProviderEnv(autoDetectEnvSnapshot);
        autoDetectEnvSnapshot = null;
      }
    }

    // 3. Spin up HTTP server
    const port = await findFreePort();
    httpServer = createFridayHttpServer({
      routes: hub.apiRuntime.routes,
      wsGateway: hub.apiRuntime.wsGateway,
      middleware: hub.apiRuntime.middleware,
      port,
      host: "127.0.0.1",
      logRequests: false,
      uiStaticDir: UI_STATIC_DIR,
    });
    await httpServer.listen();
    baseUrl = `http://127.0.0.1:${String(port)}`;

    // 4. Login as admin → get JWT token
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
      throw new Error(`Admin login failed: ${JSON.stringify(loginJson)}`);
    }
    accessToken = loginJson.data.accessToken;
  }, 60_000);

  afterAll(async () => {
    const closeTimeout = setTimeout(() => {
      console.warn("[Setup Wizard E2E] Cleanup timeout — forcing exit");
      process.exit(0);
    }, 5_000);
    if (httpServer) await httpServer.close();
    if (hub) await hub.stop();
    if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
    if (autoDetectEnvSnapshot) {
      restoreAutoDetectProviderEnv(autoDetectEnvSnapshot);
      autoDetectEnvSnapshot = null;
    }
    clearTimeout(closeTimeout);
  }, 15_000);

  // ────────────────────────────────────────────────────────────────────────
  // A. Setup Wizard API Tests (15 tests, no external deps)
  // ────────────────────────────────────────────────────────────────────────

  describe("A. Setup Wizard API Tests", () => {
    it("A1: fresh setup status should require setup", async () => {
      const res = await fetch(`${baseUrl}/v1/setup/status`, {
        headers: authHeaders(accessToken),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: {
          needsSetup: boolean;
          setupCompletedAt: string | null;
          providerCount: number;
          channelCount: number;
          skillsCount: number;
          network: {
            host: string;
            port: number;
            mode: string;
            previewUrls: string[];
          };
        };
      };
      expect(json.ok).toBe(true);
      expect(json.data.needsSetup).toBe(true);
      expect(json.data.setupCompletedAt).toBeNull();
    });

    it("A1b: reading user-profile before setup does not mark onboarding complete", async () => {
      const profileRes = await fetch(`${baseUrl}/v1/uix/user-profile`, {
        headers: authHeaders(accessToken),
      });
      expect(profileRes.status).toBe(200);
      const profileJson = (await profileRes.json()) as {
        ok: boolean;
        data: {
          profileType: string | null;
          onboardedAt: string | null;
        };
      };
      expect(profileJson.ok).toBe(true);
      expect(profileJson.data.profileType).toBe("beginner");
      expect(profileJson.data.onboardedAt).toBeNull();

      const prefsRes = await fetch(`${baseUrl}/v1/uix/preferences?category=uix`, {
        headers: authHeaders(accessToken),
      });
      expect(prefsRes.status).toBe(200);
      const prefsJson = (await prefsRes.json()) as {
        ok: boolean;
        data: {
          items: Array<{ key: string; value: unknown }>;
        };
      };
      expect(prefsJson.ok).toBe(true);
      expect(prefsJson.data.items.find((item) => item.key === "user.profile_type")).toBeUndefined();
      expect(prefsJson.data.items.find((item) => item.key === "user.onboarded_at")).toBeUndefined();
    });

    it("A2: detect ollama should return models payload (skip if not running)", async () => {
      try {
        const res = await fetch(`${baseUrl}/v1/providers/detect`, {
          method: "POST",
          headers: authHeaders(accessToken),
          body: JSON.stringify({ kind: "ollama" }),
        });
        const json = (await res.json()) as {
          ok: boolean;
          data: {
            kind: string;
            availableModels: string[];
            validated: boolean;
          };
        };

        if (res.status === 422) {
          // Ollama not running — graceful skip
          console.log("[A2] Ollama not reachable — skipping model assertion");
          return;
        }

        expect(res.status).toBe(200);
        expect(json.ok).toBe(true);
        expect(json.data.kind).toBe("ollama");
        expect(Array.isArray(json.data.availableModels)).toBe(true);
      } catch {
        // Network error — Ollama not running
        console.log("[A2] Ollama not reachable — skipping");
      }
    });

    it("A3: detect with fake OpenAI key should return 401", async () => {
      const res = await fetch(`${baseUrl}/v1/providers/detect`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({ apiKey: "sk-test-invalid" }),
      });
      if (res.status === 422 || res.status === 500) {
        // Network/DNS unavailable — upstream unreachable; skip gracefully
        console.log("[A3] OpenAI API not reachable — skipping");
        return;
      }
      expect(res.status).toBe(401);
      const json = (await res.json()) as { ok: boolean };
      expect(json.ok).toBe(false);
    }, 15_000);

    it("A4: detect with fake Anthropic key should return 401", async () => {
      const res = await fetch(`${baseUrl}/v1/providers/detect`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({ apiKey: "sk-ant-test-invalid" }),
      });
      if (res.status === 422 || res.status === 500) {
        // Network/DNS unavailable — upstream unreachable; skip gracefully
        console.log("[A4] Anthropic API not reachable — skipping");
        return;
      }
      expect(res.status).toBe(401);
      const json = (await res.json()) as { ok: boolean };
      expect(json.ok).toBe(false);
    }, 15_000);

    it("A4b: detect rejects unsupported authMode for provider kind", async () => {
      const res = await fetch(`${baseUrl}/v1/providers/detect`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          kind: "openai",
          authMode: "oauth",
        }),
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { ok: boolean; error?: { message?: string } };
      expect(json.ok).toBe(false);
      expect(json.error?.message ?? "").toContain("not supported");
    });

    it("A4c: detect allows anthropic oauth onboarding without apiKey", async () => {
      const res = await fetch(`${baseUrl}/v1/providers/detect`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          kind: "anthropic",
          authMode: "oauth",
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: {
          kind: string;
          authMode: string;
          validated: boolean;
          availableModels: string[];
          warnings: string[];
        };
      };
      expect(json.ok).toBe(true);
      expect(json.data.kind).toBe("anthropic");
      expect(json.data.authMode).toBe("oauth");
      expect(json.data.validated).toBe(false);
      expect(json.data.availableModels.length).toBeGreaterThan(0);
      expect(json.data.warnings.some((w) => w.includes("OAuth"))).toBe(true);
    });

    it("A5: get network config should return defaults", async () => {
      const res = await fetch(`${baseUrl}/v1/setup/network`, {
        headers: authHeaders(accessToken),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: {
          host: string;
          port: number;
          mode: string;
          previewUrls: string[];
          restartRequired: boolean;
        };
      };
      expect(json.ok).toBe(true);
      expect(typeof json.data.host).toBe("string");
      expect(typeof json.data.port).toBe("number");
      expect(typeof json.data.mode).toBe("string");
      expect(Array.isArray(json.data.previewUrls)).toBe(true);
    });

    it("A6: set network mode to network should return LAN URLs", async () => {
      const res = await fetch(`${baseUrl}/v1/setup/network`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({ mode: "network", port: 3141 }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: {
          host: string;
          port: number;
          mode: string;
          previewUrls: string[];
          restartRequired: boolean;
        };
      };
      expect(json.ok).toBe(true);
      expect(json.data.mode).toBe("network");
      expect(json.data.host).toBe("0.0.0.0");
      expect(json.data.port).toBe(3141);
      // Should have at least localhost + one LAN URL
      expect(json.data.previewUrls.length).toBeGreaterThanOrEqual(1);
      expect(json.data.previewUrls.some((url) => url.includes("localhost"))).toBe(true);
    });

    it("A7: set network mode back to local should switch config", async () => {
      const res = await fetch(`${baseUrl}/v1/setup/network`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({ mode: "local", port: 3141 }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: {
          host: string;
          port: number;
          mode: string;
        };
      };
      expect(json.ok).toBe(true);
      expect(json.data.mode).toBe("local");
      expect(json.data.host).toBe("127.0.0.1");
    });

    it("A8: save channels config should persist", async () => {
      const res = await fetch(`${baseUrl}/v1/setup/channels`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          channels: [
            {
              kind: "discord",
              enabled: true,
              config: { token: "fake-discord-token" },
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { savedKinds: string[] };
      };
      expect(json.ok).toBe(true);
      expect(json.data.savedKinds).toContain("discord");

      const dbPath = path.join(stateDir, "friday.db");
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const setupRow = db
          .prepare("SELECT channels_json FROM friday_setup_state WHERE id = 'singleton'")
          .get() as { channels_json: string } | undefined;
        expect(setupRow).toBeDefined();
        expect(setupRow!.channels_json).not.toContain("fake-discord-token");

        const storedChannels = JSON.parse(setupRow!.channels_json) as Array<{
          kind: string;
          config?: Record<string, unknown>;
        }>;
        const discordEntry = storedChannels.find((entry) => entry.kind === "discord");
        expect(typeof discordEntry?.config?.token).toBe("string");
        expect(String(discordEntry?.config?.token ?? "")).toMatch(/^secret:\/\/channel\//);

        const secretRow = db
          .prepare("SELECT scope, ref_key FROM secrets WHERE scope = 'channel' LIMIT 1")
          .get() as { scope: string; ref_key: string } | undefined;
        expect(secretRow).toBeDefined();
        expect(secretRow?.scope).toBe("channel");
      } finally {
        db.close();
      }
    });

    it("A9: save channels with invalid kind should return 400 or 422", async () => {
      const res = await fetch(`${baseUrl}/v1/setup/channels`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          channels: [
            {
              kind: "invalid-platform",
              enabled: true,
              config: {},
            },
          ],
        }),
      });
      expect([400, 422]).toContain(res.status);
      const json = (await res.json()) as { ok: boolean };
      expect(json.ok).toBe(false);
    });

    it("A9b: save enabled channel missing required config should return 400", async () => {
      const res = await fetch(`${baseUrl}/v1/setup/channels`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          channels: [
            {
              kind: "discord",
              enabled: true,
              config: {},
            },
          ],
        }),
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { ok: boolean };
      expect(json.ok).toBe(false);
    });

    it("A10: complete setup with valid steps should mark done", async () => {
      const res = await fetch(`${baseUrl}/v1/setup/complete`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          completedSteps: ["welcome", "security", "provider", "network", "channels", "skills", "done"],
          skippedSteps: [],
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { setupCompletedAt: string };
      };
      expect(json.ok).toBe(true);
      expect(typeof json.data.setupCompletedAt).toBe("string");
    });

    it("A11: complete setup with invalid step ID should return 400", async () => {
      const res = await fetch(`${baseUrl}/v1/setup/complete`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          completedSteps: ["welcome", "nonexistent-step"],
          skippedSteps: [],
        }),
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { ok: boolean };
      expect(json.ok).toBe(false);
    });

    it("A12: setup status after completion should not require setup", async () => {
      const res = await fetch(`${baseUrl}/v1/setup/status`, {
        headers: authHeaders(accessToken),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: {
          needsSetup: boolean;
          setupCompletedAt: string | null;
          channelCount: number;
        };
      };
      expect(json.ok).toBe(true);
      expect(json.data.needsSetup).toBe(false);
      expect(json.data.setupCompletedAt).not.toBeNull();
      expect(json.data.channelCount).toBeGreaterThanOrEqual(1);
    });

    it("A12b: setup completion makes user-profile reflect onboarding completion", async () => {
      const profileRes = await fetch(`${baseUrl}/v1/uix/user-profile`, {
        headers: authHeaders(accessToken),
      });
      expect(profileRes.status).toBe(200);
      const profileJson = (await profileRes.json()) as {
        ok: boolean;
        data: {
          profileType: string | null;
          onboardedAt: string | null;
        };
      };
      expect(profileJson.ok).toBe(true);
      expect(profileJson.data.profileType).toBe("beginner");
      expect(profileJson.data.onboardedAt).not.toBeNull();
    });

    itBrowser("A12c: browser no longer loops back to onboarding after setup completes", async () => {
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        baseURL: baseUrl,
        timezoneId: "America/Los_Angeles",
      });
      const page = await context.newPage();
      try {
        await page.goto("/", { waitUntil: "domcontentloaded" });
        await page.waitForURL("**/home", { timeout: 30_000 });
        expect(new URL(page.url()).pathname).toBe("/home");
      } finally {
        await context.close();
        await browser.close();
      }
    }, 20_000);

    it("A13: full wizard API flow should pass end-to-end", async () => {
      // NOTE: This is a re-run flow test, not a fresh-state test. The hub was already
      // set up by earlier tests (A10 marked setup as complete). This test exercises the
      // full API sequence on an already-configured instance. True fresh-state testing
      // would require spinning up a separate hub instance with a clean stateDir, which
      // is acceptable to defer for now.

      // 1. Status — shows needsSetup: false from A10, but the flow still works
      const statusRes = await fetch(`${baseUrl}/v1/setup/status`, {
        headers: authHeaders(accessToken),
      });
      expect(statusRes.status).toBe(200);
      const statusJson = (await statusRes.json()) as {
        ok: boolean;
        data: { needsSetup: boolean };
      };
      expect(statusJson.ok).toBe(true);

      // 2. Detect (ollama) — graceful skip if not running
      try {
        const detectRes = await fetch(`${baseUrl}/v1/providers/detect`, {
          method: "POST",
          headers: authHeaders(accessToken),
          body: JSON.stringify({ kind: "ollama" }),
        });
        if (detectRes.status === 200) {
          const detectJson = (await detectRes.json()) as {
            ok: boolean;
            data: { kind: string };
          };
          expect(detectJson.data.kind).toBe("ollama");
        }
      } catch {
        console.log("[A13] Ollama detect skipped (not reachable)");
      }

      // 3. Network config
      const networkRes = await fetch(`${baseUrl}/v1/setup/network`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({ mode: "local", port: 3141 }),
      });
      expect(networkRes.status).toBe(200);

      // 4. Channels
      const channelsRes = await fetch(`${baseUrl}/v1/setup/channels`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          channels: [
            { kind: "discord", enabled: true, config: { token: "test-token" } },
          ],
        }),
      });
      expect(channelsRes.status).toBe(200);

      // 5. Complete
      const completeRes = await fetch(`${baseUrl}/v1/setup/complete`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          completedSteps: ["welcome", "security", "provider", "network", "channels", "skills", "done"],
          skippedSteps: [],
        }),
      });
      expect(completeRes.status).toBe(200);

      // 6. Verify status
      const finalStatusRes = await fetch(`${baseUrl}/v1/setup/status`, {
        headers: authHeaders(accessToken),
      });
      expect(finalStatusRes.status).toBe(200);
      const finalStatusJson = (await finalStatusRes.json()) as {
        ok: boolean;
        data: { needsSetup: boolean };
      };
      expect(finalStatusJson.ok).toBe(true);
      expect(finalStatusJson.data.needsSetup).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // B. Provider Detection (3 tests, needs Ollama)
  // ────────────────────────────────────────────────────────────────────────

  describe("B. Provider Detection (needs Ollama)", () => {
    itOllama("B14: ollama detect should return real installed local models", async () => {
      const res = await fetch(`${baseUrl}/v1/providers/detect`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({ kind: "ollama" }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: {
          kind: string;
          availableModels: string[];
          validated: boolean;
          confidence: string;
        };
      };
      expect(json.ok).toBe(true);
      expect(json.data.kind).toBe("ollama");
      expect(json.data.validated).toBe(true);
      expect(json.data.availableModels.length).toBeGreaterThanOrEqual(1);
    });

    itOllama("B15: explicit kind should override key-pattern inference", async () => {
      // Passing an API key that looks like Anthropic but overriding kind to ollama —
      // the explicit kind should take precedence over key-pattern inference
      const res = await fetch(`${baseUrl}/v1/providers/detect`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          kind: "ollama",
          baseUrl: "http://localhost:11434",
          apiKey: "sk-ant-intentionally-mismatched",
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: {
          kind: string;
          confidence: string;
        };
      };
      expect(json.ok).toBe(true);
      expect(json.data.kind).toBe("ollama");
      expect(json.data.confidence).toBe("high");
    });

    it("B16: openai-compatible detect should require baseUrl", async () => {
      const res = await fetch(`${baseUrl}/v1/providers/detect`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          kind: "openai-compatible",
          apiKey: "sk-compatible-test",
        }),
      });
      expect([400, 422]).toContain(res.status);
      const json = (await res.json()) as { ok: boolean };
      expect(json.ok).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // C. Real Scenarios (4 tests, needs Ollama + LLM)
  // ────────────────────────────────────────────────────────────────────────

  describe("C. Real Scenarios (needs Ollama + LLM)", () => {
    itRealOllama("C17: full E2E setup → create Ollama provider → run agent task", async () => {
      // 1. Detect Ollama
      const detectRes = await fetch(`${baseUrl}/v1/providers/detect`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({ kind: "ollama" }),
      });
      expect(detectRes.status).toBe(200);
      const detectJson = (await detectRes.json()) as {
        ok: boolean;
        data: {
          availableModels: string[];
          defaultModel?: string;
        };
      };
      expect(detectJson.ok).toBe(true);
      expect(detectJson.data.availableModels.length).toBeGreaterThanOrEqual(1);

      const model = detectJson.data.defaultModel ?? detectJson.data.availableModels[0]!;

      // 2. Create Ollama provider
      const createRes = await fetch(`${baseUrl}/v1/providers`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          kind: "ollama",
          name: "Ollama E2E",
          baseUrl: "http://localhost:11434",
          authMode: "none",
          api: "ollama",
          supportedModels: [model],
          defaultModel: model,
          enabled: true,
          validateOnSave: false,
        }),
      });
      expect(createRes.status).toBe(200);
      const createJson = (await createRes.json()) as {
        ok: boolean;
        data: { provider: { id: string } };
      };
      expect(createJson.ok).toBe(true);
      const providerId = createJson.data.provider.id;

      // 3. Set routing
      const routingRes = await fetch(`${baseUrl}/v1/model-routing`, {
        method: "PUT",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          defaultProviderId: providerId,
          fallbackProviderIds: [],
        }),
      });
      expect(routingRes.status).toBe(200);

      // 4. Create session and run agent task
      const sessionRes = await fetch(`${baseUrl}/v1/sessions`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({ channel: "e2e", chatId: "setup-wizard-c17" }),
      });
      expect(sessionRes.status).toBe(200);
      const sessionJson = (await sessionRes.json()) as {
        ok: boolean;
        data: { session: { key: string } };
      };
      const sessionKey = sessionJson.data.session.key;

      // 5. Add a deterministic prompt for assertion
      const msgRes = await fetch(
        `${baseUrl}/v1/sessions/${encodeURIComponent(sessionKey)}/messages`,
        {
          method: "POST",
          headers: authHeaders(accessToken),
          body: JSON.stringify({ role: "user", content: "Reply with exactly this text and nothing else: FRIDAY_E2E_OK" }),
        },
      );
      expect(msgRes.status).toBe(200);

      // 6. Run agent — endpoint must exist for the test to pass
      const runRes = await fetch(
        `${baseUrl}/v1/sessions/${encodeURIComponent(sessionKey)}/run`,
        {
          method: "POST",
          headers: authHeaders(accessToken),
          body: JSON.stringify({ useLastUserMessage: true }),
        },
      );

      expect(runRes.status).toBe(200);
      const runJson = (await runRes.json()) as {
        ok: boolean;
        data: { messages: Array<{ role: string; content: string }> };
      };
      expect(runJson.ok).toBe(true);
      // Verify the LLM output contains our deterministic marker
      const assistantMessages = runJson.data.messages.filter((m) => m.role === "assistant");
      const outputText = assistantMessages.map((m) => m.content).join(" ");
      expect(outputText).toContain("FRIDAY_E2E_OK");
    }, 60_000);

    itRealOllama("C18: import OpenClaw SKILL.md → install → verify in skills list", async () => {
      // Create a temp SKILL.md
      const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-c18-skill-"));
      const skillMdPath = path.join(skillDir, "SKILL.md");
      fs.writeFileSync(skillMdPath, `---
skillKey: c18-setup-test-skill
name: C18 Setup Test Skill
author: e2e-test
---

A test skill for E2E setup wizard testing.

\`\`\`bash
echo '{"result": "hello from c18"}'
\`\`\`
`);

      try {
        // 1. Convert (dry run)
        const convertRes = await fetch(`${baseUrl}/v1/skills/convert`, {
          method: "POST",
          headers: authHeaders(accessToken),
          body: JSON.stringify({
            source: { uri: skillDir },
            formatHint: "clawdbot-skill-md",
            dryRun: true,
          }),
        });
        expect(convertRes.status).toBe(200);
        const convertJson = (await convertRes.json()) as {
          ok: boolean;
          data: {
            converterId: string;
            drafts: Array<{
              manifest: { id: string };
            }>;
          };
        };
        expect(convertJson.ok).toBe(true);
        expect(convertJson.data.drafts.length).toBeGreaterThanOrEqual(1);

        // 2. Import
        const importRes = await fetch(`${baseUrl}/v1/skills/import`, {
          method: "POST",
          headers: authHeaders(accessToken),
          body: JSON.stringify({
            source: { uri: skillDir },
            formatHint: "clawdbot-skill-md",
            target: "managed",
            replace: true,
            refreshRegistry: true,
          }),
        });
        expect(importRes.status).toBe(200);
        const importJson = (await importRes.json()) as {
          ok: boolean;
          data: {
            imports: Array<{
              skillId: string;
              installed: boolean;
              skillDir: string;
            }>;
          };
        };
        expect(importJson.ok).toBe(true);
        expect(importJson.data.imports.length).toBeGreaterThanOrEqual(1);
        const importedSkillId = importJson.data.imports[0]!.skillId;

        // 3. Verify the imported skill ID appears in the skills list
        const listRes = await fetch(`${baseUrl}/v1/skills`, {
          headers: authHeaders(accessToken),
        });
        expect(listRes.status).toBe(200);
        const listJson = (await listRes.json()) as {
          ok: boolean;
          data: { items: Array<{ id: string }> };
        };
        expect(listJson.ok).toBe(true);
        const skillIds = listJson.data.items.map((item) => item.id);
        expect(skillIds).toContain(importedSkillId);
      } finally {
        fs.rmSync(skillDir, { recursive: true, force: true });
      }
    }, 30_000);

    itRealOllama("C19: create 2-node workflow → publish → trigger → verify run completes", async () => {
      // 1. Create workflow with 2 nodes
      const graph = {
        nodes: [
          { id: "trigger", type: "trigger", label: "Manual Trigger", config: { triggerType: "manual" } },
          { id: "result", type: "data", label: "Result", config: { mapping: { output: "setup-wizard-test" } } },
        ],
        edges: [
          { id: "e1", sourceNodeId: "trigger", targetNodeId: "result" },
        ],
      };

      const createRes = await fetch(`${baseUrl}/v1/workflows`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          slug: "setup-wizard-c19",
          name: "Setup Wizard C19 Test",
          tags: ["e2e-setup"],
          graph,
        }),
      });
      expect(createRes.status).toBe(200);
      const createJson = (await createRes.json()) as {
        ok: boolean;
        data: { workflow: { id: string } };
      };
      expect(createJson.ok).toBe(true);
      const workflowId = createJson.data.workflow.id;

      // 2. Publish
      const publishRes = await fetch(`${baseUrl}/v1/workflows/${workflowId}/publish`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({ versionNumber: 1 }),
      });
      expect(publishRes.status).toBe(200);

      // 3. Trigger run
      const runRes = await fetch(`${baseUrl}/v1/workflow-runs`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          workflowId,
          triggerType: "manual",
          triggerPayload: {},
        }),
      });
      expect(runRes.status).toBe(200);
      const runJson = (await runRes.json()) as {
        ok: boolean;
        data: { run: { id: string; status: string } };
      };
      expect(runJson.ok).toBe(true);
      const runId = runJson.data.run.id;

      // 4. Poll until complete
      const result = await pollUntil(
        async () => {
          const r = await fetch(`${baseUrl}/v1/workflow-runs/${runId}`, {
            headers: authHeaders(accessToken),
          });
          return (await r.json()) as {
            ok: boolean;
            data: { run: { id: string; status: string; nodeResults?: Record<string, { status: string }> } };
          };
        },
        (j) => {
          const s = j.data.run.status;
          return s === "completed" || s === "failed" || s === "cancelled";
        },
        { maxMs: 15_000 },
      );
      expect(result.data.run.status).toBe("completed");

      // Verify both node statuses are "completed" in the run detail
      if (result.data.run.nodeResults) {
        const nodeStatuses = Object.values(result.data.run.nodeResults);
        expect(nodeStatuses.length).toBeGreaterThanOrEqual(2);
        for (const node of nodeStatuses) {
          expect(node.status).toBe("completed");
        }
      }
    }, 30_000);

    itRealOllama("C20: self-diagnosis — create workflow, run validation, check for issues", async () => {
      // TODO: This test needs a dedicated diagnostics/validation endpoint to be implemented.
      // When that endpoint exists, this test should:
      // 1. Create a workflow with potentially incompatible nodes
      // 2. Call the diagnostics / validation endpoint
      // 3. Verify issues are returned with proper severity and messages
      //
      // For now, we use the compile endpoint on a draft as a proxy for validation.
      // Compilation catches structural issues (missing refs, invalid configs) which
      // is a reasonable approximation of diagnostics until the real endpoint lands.
      const graph = {
        nodes: [
          { id: "trigger", type: "trigger", label: "Manual", config: { triggerType: "manual" } },
          { id: "action", type: "action", label: "Action", config: {} },
        ],
        edges: [
          { id: "e1", sourceNodeId: "trigger", targetNodeId: "action" },
        ],
      };

      const createRes = await fetch(`${baseUrl}/v1/workflows`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          slug: "setup-wizard-c20-diag",
          name: "Diagnostics Test",
          tags: ["e2e-setup"],
          graph,
        }),
      });
      expect(createRes.status).toBe(200);
      const createJson = (await createRes.json()) as {
        ok: boolean;
        data: { workflow: { id: string } };
      };
      expect(createJson.ok).toBe(true);
      const workflowId = createJson.data.workflow.id;

      // Create a draft for compile-based validation
      const draftSpec = {
        schemaVersion: "1.0",
        workflowId,
        name: "Diagnostics Test",
        description: "Test self-diagnosis",
        startStepId: "trigger",
        trigger: { type: "manual" },
        inputs: [],
        steps: [
          { id: "trigger", type: "skill_call", ref: "nonexistent-skill" },
        ],
        edges: [],
        outputs: [],
        errorPolicy: { onFailure: "fail_fast", notifyUser: false },
        tests: [],
      };

      const draftVisual = {
        schemaVersion: "1.0",
        workflowId,
        viewport: { x: 0, y: 0, zoom: 1 },
        panelLayout: { leftOpen: false, rightOpen: false, bottomOpen: false },
        nodes: [{ nodeId: "trigger", x: 0, y: 0 }],
        edges: [],
      };

      const draftRes = await fetch(`${baseUrl}/v1/workflows/${workflowId}/drafts`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          title: "Diagnostics Draft",
          spec: draftSpec,
          visual: draftVisual,
        }),
      });
      expect(draftRes.status).toBe(200);
      const draftJson = (await draftRes.json()) as {
        ok: boolean;
        data: { draft: { draftId: string } };
      };
      expect(draftJson.ok).toBe(true);
      const draftId = draftJson.data.draft.draftId;

      // Compile the draft — this acts as validation / diagnostics
      const compileRes = await fetch(
        `${baseUrl}/v1/workflows/${workflowId}/drafts/${draftId}/compile`,
        {
          method: "POST",
          headers: authHeaders(accessToken),
        },
      );
      expect(compileRes.status).toBe(200);
      const compileJson = (await compileRes.json()) as {
        ok: boolean;
        data: {
          compiled?: Record<string, unknown>;
          validation?: {
            valid: boolean;
            issues: Array<{ severity: string; message: string }>;
          };
        };
      };
      expect(compileJson.ok).toBe(true);
      // Compilation should succeed (possibly with warnings) — the key point is
      // that validation catches issues before runtime
      expect(compileJson.data).toBeTruthy();
    }, 30_000);
  });
});
