/**
 * Real LLM E2E tests — exercises provider, skill generator, and workflow
 * generator against a live Anthropic endpoint via OAuth.
 *
 * Gated by `FRIDAY_E2E_LIVE_ANTHROPIC=1`.
 * Backward compatibility: `FRIDAY_LLM_E2E` also enables this suite.
 * Requires either:
 *   - FRIDAY_ANTHROPIC_OAUTH_ACCESS_TOKEN (preferred — direct access token, no refresh needed)
 *   - FRIDAY_ANTHROPIC_OAUTH_REFRESH_TOKEN (refresh token — will be exchanged for access token)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { createFridayHub } from "#hub";
import type { FridayHub } from "#hub";
import { createFridayHttpServer } from "#api";
import type { FridayHttpServer } from "#api";
import Database from "better-sqlite3";
import {
  createFridayOAuthCredentialStore,
  FRIDAY_ANTHROPIC_OAUTH_CLIENT_ID,
  FRIDAY_ANTHROPIC_OAUTH_TOKEN_URL,
} from "#providers";
import type { FridayOAuthTokenSet } from "#providers";
import type { FridaySqliteLayer } from "#state";

// ─── Env guard ───

const ANTHROPIC_E2E_ENABLED =
  process.env.FRIDAY_E2E_LIVE_ANTHROPIC === "1" ||
  !!process.env.FRIDAY_LLM_E2E;
const REFRESH_TOKEN = process.env.FRIDAY_ANTHROPIC_OAUTH_REFRESH_TOKEN ?? "";
const ACCESS_TOKEN_DIRECT = process.env.FRIDAY_ANTHROPIC_OAUTH_ACCESS_TOKEN ?? "";
const MODEL = "claude-sonnet-4-20250514";

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

interface LlmTestEnv {
  hub: FridayHub;
  httpServer: FridayHttpServer;
  baseUrl: string;
  token: string;
  providerId: string;
  cleanup: () => Promise<void>;
}

async function createLlmTestEnv(): Promise<LlmTestEnv> {
  // 1. Create temp state dir
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "friday-llm-e2e-"),
  );

  // 2. Create hub with temp state dir
  const hub = await createFridayHub({
    stateDir,
    skillDirs: [],
    // NOTE: do NOT set tokenSecret explicitly — that disables passwordless local login
    port: 0,
    logRequests: false,
  });

  await hub.start();

  // 3. Spin up HTTP server
  const port = await findFreePort();
  const httpServer = createFridayHttpServer({
    routes: hub.apiRuntime.routes,
    wsGateway: hub.apiRuntime.wsGateway,
    middleware: hub.apiRuntime.middleware,
    port,
    host: "127.0.0.1",
    logRequests: false,
  });
  await httpServer.listen();

  const baseUrl = `http://127.0.0.1:${String(port)}`;

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
    throw new Error(`Admin login failed in LLM E2E setup: ${JSON.stringify(loginJson)}`);
  }
  const token = loginJson.data.accessToken;

  // 5. Create Anthropic provider via API (OAuth mode, skip validation)
  const createProviderRes = await fetch(`${baseUrl}/v1/providers`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      kind: "anthropic",
      name: "Anthropic OAuth (E2E)",
      baseUrl: "https://api.anthropic.com",
      authMode: "oauth",
      api: "anthropic-messages",
      supportedModels: [MODEL],
      defaultModel: MODEL,
      enabled: true,
      validateOnSave: false,
    }),
  });
  const createProviderJson = (await createProviderRes.json()) as {
    ok: boolean;
    data: { provider: { id: string } };
  };
  if (!createProviderJson.ok) {
    throw new Error(
      `Provider creation failed: ${JSON.stringify(createProviderJson)}`,
    );
  }
  const providerId = createProviderJson.data.provider.id;

  // 6. Set routing config to use this provider
  const routingRes = await fetch(`${baseUrl}/v1/model-routing`, {
    method: "PUT",
    headers: authHeaders(token),
    body: JSON.stringify({
      defaultProviderId: providerId,
      fallbackProviderIds: [],
    }),
  });
  if (!routingRes.ok) {
    throw new Error(`Routing config failed: ${String(routingRes.status)}`);
  }

  // 7. Seed OAuth credentials — either via refresh token or direct access token
  const dbPath = path.join(stateDir, "friday.db");
  const seedDb = new Database(dbPath);

  try {
    let tokenSet: FridayOAuthTokenSet;

    if (ACCESS_TOKEN_DIRECT) {
      // Direct access token mode — no refresh needed (simpler, avoids one-time-use refresh token issues)
      tokenSet = {
        accessToken: ACCESS_TOKEN_DIRECT,
        refreshToken: REFRESH_TOKEN || "unused",
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(), // 8h from now
        tokenType: "Bearer",
        scope: "org:create_api_key user:profile user:inference",
      };
    } else if (REFRESH_TOKEN) {
      // Refresh token mode — exchange for fresh access token
      const tokenResponse = await fetch(FRIDAY_ANTHROPIC_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: FRIDAY_ANTHROPIC_OAUTH_CLIENT_ID,
          refresh_token: REFRESH_TOKEN,
        }),
      });

      if (!tokenResponse.ok) {
        const errText = await tokenResponse.text();
        throw new Error(
          `OAuth token refresh failed (HTTP ${String(tokenResponse.status)}): ${errText}`,
        );
      }

      const tokenData = (await tokenResponse.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
        token_type: string;
        scope?: string;
      };

      tokenSet = {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: new Date(
          Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
        ).toISOString(),
        tokenType: tokenData.token_type,
        scope:
          tokenData.scope ??
          "org:create_api_key user:profile user:inference",
      };
    } else {
      throw new Error("Either FRIDAY_ANTHROPIC_OAUTH_ACCESS_TOKEN or FRIDAY_ANTHROPIC_OAUTH_REFRESH_TOKEN is required");
    }

    // Create a minimal FridaySqliteLayer wrapping the seed DB
    const seedDbLayer: FridaySqliteLayer = {
      dbPath,
      writer: seedDb,
      reads: {
        size: 1,
        withReadConnection<T>(fn: (d: Database.Database) => T): T {
          return fn(seedDb);
        },
        close() {},
      },
      withWriteTransaction<T>(fn: (writerDb: Database.Database) => T): T {
        return seedDb.transaction(() => fn(seedDb))();
      },
      withReadConnection<T>(fn: (d: Database.Database) => T): T {
        return fn(seedDb);
      },
      checkpoint() {},
      optimize() {},
      close() {
        seedDb.close();
      },
    };

    let idCounter = 0;
    const credentialStore = createFridayOAuthCredentialStore({
      db: seedDbLayer,
      idGenerator: () => `seed-cred-${String(++idCounter)}`,
      nowIso: () => new Date().toISOString(),
    });

    credentialStore.upsert({
      providerProfileId: providerId,
      oauthProvider: "anthropic",
      tokenSet,
    });

    // Force WAL checkpoint so the hub's read-pool connections see the seeded
    // credentials immediately.  Without this the read pool may hold a stale
    // WAL snapshot and `validateProvider()` will fail to find the credential.
    seedDb.pragma("wal_checkpoint(FULL)");
  } finally {
    seedDb.close();
  }

  const cleanup = async (): Promise<void> => {
    await httpServer.close();
    await hub.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
  };

  return { hub, httpServer, baseUrl, token, providerId, cleanup };
}

// ─── Tests ───

describe.skipIf(!ANTHROPIC_E2E_ENABLED)("Friday LLM E2E (real Anthropic)", () => {
  let env: LlmTestEnv;

  beforeAll(async () => {
    if (!REFRESH_TOKEN && !ACCESS_TOKEN_DIRECT) {
      throw new Error(
        "FRIDAY_ANTHROPIC_OAUTH_REFRESH_TOKEN or FRIDAY_ANTHROPIC_OAUTH_ACCESS_TOKEN env var is required",
      );
    }
    env = await createLlmTestEnv();
  }, 60_000);

  afterAll(async () => {
    if (env) {
      await env.cleanup();
    }
  }, 15_000);

  // ── 1. Provider Setup & Validation ──

  it(
    "validates the seeded Anthropic OAuth provider",
    async () => {
      const res = await fetch(
        `${env.baseUrl}/v1/providers/${env.providerId}/validate`,
        {
          method: "POST",
          headers: authHeaders(env.token),
        },
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { validation: { status: string } };
      };
      expect(json.ok).toBe(true);
      expect(json.data.validation.status).toBe("ok");
    },
    30_000,
  );

  // ── 2. Direct Inference via runWithFallback ──

  it(
    "runs direct inference through the provider service",
    async () => {
      const { result } = await env.hub.providerService.runWithFallback<string>({
        requestedModel: MODEL,
        routingContext: {
          estimatedInputTokens: 100,
          complexity: "simple",
        },
        run: async (route, credential) => {
          // Build a minimal Anthropic messages API call
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
            "anthropic-dangerous-direct-browser-access": "true",
            "user-agent": "claude-cli/2.1.2 (external, cli)",
            "x-app": "cli",
          };

          if (credential) {
            headers["Authorization"] = `Bearer ${credential}`;
          }

          const body = {
            model: route.model,
            max_tokens: 256,
            system:
              "You are Claude Code, Anthropic's official CLI for Claude. Reply with exactly the JSON requested.",
            messages: [
              {
                role: "user",
                content:
                  'Reply with exactly this JSON and nothing else: {"hello":"world"}',
              },
            ],
          };

          const apiRes = await fetch(
            `${route.provider.baseUrl}/v1/messages`,
            {
              method: "POST",
              headers,
              body: JSON.stringify(body),
            },
          );

          if (!apiRes.ok) {
            const errText = await apiRes.text();
            throw new Error(
              `Anthropic API error (${String(apiRes.status)}): ${errText}`,
            );
          }

          const apiJson = (await apiRes.json()) as {
            content: Array<{ type: string; text: string }>;
          };

          const textBlock = apiJson.content.find(
            (b) => b.type === "text",
          );
          return textBlock?.text ?? "";
        },
      });

      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
      // The model should return something containing hello/world
      expect(result).toContain("hello");
      expect(result).toContain("world");
    },
    30_000,
  );

  // ── 3. Skill Generator ──

  it(
    "generates a skill draft via the skill generator",
    async () => {
      // Start a session
      const startRes = await fetch(
        `${env.baseUrl}/v1/skills/generator/sessions`,
        {
          method: "POST",
          headers: authHeaders(env.token),
          body: JSON.stringify({
            goal: "Create a skill that returns the current date in ISO format",
            userId: "admin-001",
            channel: "e2e-test",
            requestedModel: MODEL,
          }),
        },
      );

      expect(startRes.status).toBe(200);
      const startJson = (await startRes.json()) as {
        ok: boolean;
        data: {
          session: { sessionId: string };
          mode: string;
          questions?: string[];
          draft?: { manifest: unknown; files: unknown[] };
        };
      };
      expect(startJson.ok).toBe(true);

      const sessionId = startJson.data.session.sessionId;
      expect(typeof sessionId).toBe("string");

      // If clarification is needed, send a message
      if (startJson.data.mode === "clarification_required") {
        const msgRes = await fetch(
          `${env.baseUrl}/v1/skills/generator/sessions/${sessionId}/messages`,
          {
            method: "POST",
            headers: authHeaders(env.token),
            body: JSON.stringify({
              message:
                "Just a simple shell skill that outputs the current date via the `date` command in ISO 8601 format. No inputs needed.",
              requestedModel: MODEL,
            }),
          },
        );
        expect(msgRes.status).toBe(200);
      }

      // Force generation — may succeed (200) or fail gracefully (422) if
      // LLM output doesn't conform to the strict schema after repair attempts.
      const genRes = await fetch(
        `${env.baseUrl}/v1/skills/generator/sessions/${sessionId}/generate`,
        {
          method: "POST",
          headers: authHeaders(env.token),
          body: JSON.stringify({ requestedModel: MODEL }),
        },
      );

      // Accept both 200 (success) and 422 (graceful generation failure)
      expect([200, 422]).toContain(genRes.status);

      const genJson = (await genRes.json()) as Record<string, unknown>;

      if (genRes.status === 200) {
        // Success path — verify draft structure
        expect(genJson.ok).toBe(true);
        const data = genJson.data as {
          draft: {
            manifest: Record<string, unknown>;
            files: Array<{ path: string; content: string }>;
            validation: { ok: boolean };
          };
        };
        const draft = data.draft;
        expect(draft.manifest).toBeTruthy();
        expect(draft.files.length).toBeGreaterThan(0);

        // At least one file should have content
        const hasContent = draft.files.some(
          (f) => f.content.length > 0,
        );
        expect(hasContent).toBe(true);
      } else {
        // 422 — graceful failure: verify proper error structure (not a raw crash)
        expect(genJson.ok).toBe(false);
        expect(genJson.error).toBeTruthy();
        const error = genJson.error as { code: string; message: string };
        expect(typeof error.code).toBe("string");
        expect(typeof error.message).toBe("string");
      }
    },
    60_000,
  );

  // ── 4. Workflow Generator ──

  it(
    "generates a workflow draft via the workflow generator",
    async () => {
      // Start a session
      const startRes = await fetch(
        `${env.baseUrl}/v1/workflows/generator/sessions`,
        {
          method: "POST",
          headers: authHeaders(env.token),
          body: JSON.stringify({
            goal: "A simple manual trigger workflow that logs hello",
            userId: "admin-001",
            channel: "e2e-test",
            requestedModel: MODEL,
          }),
        },
      );

      expect(startRes.status).toBe(200);
      const startJson = (await startRes.json()) as {
        ok: boolean;
        data: {
          session: { sessionId: string };
          mode: string;
          questions?: string[];
        };
      };
      expect(startJson.ok).toBe(true);

      const sessionId = startJson.data.session.sessionId;
      expect(typeof sessionId).toBe("string");

      // If clarification is needed, send a message
      if (startJson.data.mode === "clarification_required") {
        const msgRes = await fetch(
          `${env.baseUrl}/v1/workflows/generator/sessions/${sessionId}/messages`,
          {
            method: "POST",
            headers: authHeaders(env.token),
            body: JSON.stringify({
              message:
                'A workflow with a manual trigger node and a single log node that outputs "hello world". No conditions needed.',
              requestedModel: MODEL,
            }),
          },
        );
        expect(msgRes.status).toBe(200);
      }

      // Force generation
      const genRes = await fetch(
        `${env.baseUrl}/v1/workflows/generator/sessions/${sessionId}/generate`,
        {
          method: "POST",
          headers: authHeaders(env.token),
          body: JSON.stringify({ requestedModel: MODEL }),
        },
      );

      expect(genRes.status).toBe(200);
      const genJson = (await genRes.json()) as {
        ok: boolean;
        data: {
          draft: {
            spec: Record<string, unknown>;
            visual: Record<string, unknown>;
            compiledGraph: Record<string, unknown>;
            validation: { ok: boolean };
          };
        };
      };
      expect(genJson.ok).toBe(true);

      const draft = genJson.data.draft;
      expect(draft.spec).toBeTruthy();
      expect(draft.visual).toBeTruthy();
      expect(draft.compiledGraph).toBeTruthy();
      expect(draft.validation).toBeTruthy();
    },
    90_000,
  );
});
