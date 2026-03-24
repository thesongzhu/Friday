/**
 * Mock hub environment for E2E tests without real LLM providers.
 *
 * Creates a fresh Friday hub with all 5 provider kinds registered,
 * backed by mock fetch functions that return deterministic responses.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";

import { createFridayHub } from "#hub";
import type { FridayHub } from "#hub";
import { createFridayHttpServer } from "#api";
import type { FridayHttpServer } from "#api";

import type {
  FridayProviderApi,
  FridayProviderKind,
} from "../../../../src/providers/model/friday-provider.types.js";
import {
  createMockFetch,
  resetMockCounters,
  type MockFetch,
} from "../../../_mocks/mock-llm-providers.js";
import {
  createMockFetchRouter,
  type MockRouteEntry,
} from "./mock-fetch-router.js";
import { PROVIDER_MATRIX, type ProviderMatrixEntry } from "./provider-matrix.js";

// ─── Types ───

export interface InstalledMockProvider {
  kind: FridayProviderKind;
  api: FridayProviderApi;
  providerId: string;
  baseUrl: string;
  model: string;
}

export interface MockHubEnv {
  hub: FridayHub;
  httpServer: FridayHttpServer;
  baseUrl: string;
  stateDir: string;
  accessToken: string;
  providers: Record<string, InstalledMockProvider>;
  mocks: Record<FridayProviderApi, MockFetch>;
  /** Get mock by provider kind */
  mockFor: (kind: FridayProviderKind) => MockFetch;
  /** Restore original fetch */
  cleanup: () => Promise<void>;
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

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function apiFetch<T>(
  baseUrl: string,
  token: string,
  method: string,
  urlPath: string,
  body?: unknown,
  fetchImpl?: typeof fetch,
): Promise<{ status: number; json: T }> {
  // Use the provided fetch so API calls to localhost go through normally
  const doFetch = fetchImpl ?? globalThis.fetch;
  const res = await doFetch(`${baseUrl}${urlPath}`, {
    method,
    headers: authHeaders(token),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json()) as T;
  return { status: res.status, json };
}

type LoginEnvelope = {
  ok: boolean;
  data?: { accessToken: string };
  error?: { code?: string; message?: string };
};

async function loginAdmin(
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const tryLogin = async (
    body: Record<string, unknown>,
  ): Promise<LoginEnvelope> => {
    const res = await fetchImpl(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as LoginEnvelope;
  };

  const firstAttempt = await tryLogin({ local: true });
  if (firstAttempt.ok && firstAttempt.data?.accessToken) {
    return firstAttempt.data.accessToken;
  }

  const passphrase = process.env.FRIDAY_TEST_LOCAL_PASSPHRASE ?? "friday-e2e-passphrase";
  const bootstrapStatusRes = await fetchImpl(`${baseUrl}/v1/auth/bootstrap/status`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });
  const bootstrapStatus = (await bootstrapStatusRes.json()) as {
    ok: boolean;
    data?: {
      bootstrapRequired: boolean;
      allowPasswordlessLocalLogin: boolean;
    };
  };

  const requiresBootstrap = Boolean(bootstrapStatus.data?.bootstrapRequired);
  if (requiresBootstrap) {
    await fetchImpl(`${baseUrl}/v1/auth/bootstrap/local-passphrase`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passphrase }),
    });
  }

  const passphraseAttempt = await tryLogin({ localPassphrase: passphrase });
  if (passphraseAttempt.ok && passphraseAttempt.data?.accessToken) {
    return passphraseAttempt.data.accessToken;
  }

  if (bootstrapStatus.data?.allowPasswordlessLocalLogin) {
    const fallbackPasswordless = await tryLogin({ local: true });
    if (fallbackPasswordless.ok && fallbackPasswordless.data?.accessToken) {
      return fallbackPasswordless.data.accessToken;
    }
  }

  throw new Error(
    `Admin login failed: first=${JSON.stringify(firstAttempt)} passphrase=${JSON.stringify(passphraseAttempt)}`,
  );
}

// ─── Track original fetch ───
// NOTE: _originalFetch is only used inside createMockHubEnv closures.
// Each env captures its own instance-local reference to avoid races.
//
// ⚠️  CONCURRENT SAFETY LIMITATION:
// globalThis.fetch is a shared singleton — creating multiple MockHubEnv
// instances concurrently would cause fetch routing races (env A's cleanup
// could restore the original fetch while env B's router is still active).
// This is acceptable because:
//   1. Vitest runs test *files* sequentially by default (no cross-file races).
//   2. Within a file, tests share a single env via beforeAll/afterAll.
// Do NOT create multiple MockHubEnv instances in parallel (e.g. Promise.all).

// ─── Create provider via hub API ───

async function installProvider(
  baseUrl: string,
  token: string,
  entry: ProviderMatrixEntry,
  fetchImpl?: typeof fetch,
): Promise<InstalledMockProvider> {
  const { status, json } = await apiFetch<{
    ok: boolean;
    data: { provider: { id: string } };
  }>(baseUrl, token, "POST", "/v1/providers", {
    kind: entry.kind,
    name: `Mock ${entry.kind}`,
    baseUrl: entry.baseUrl,
    authMode: entry.authMode,
    api: entry.api,
    supportedModels: [entry.model],
    defaultModel: entry.model,
    enabled: true,
    validateOnSave: false,
    // For api-key providers, provide a mock key
    ...(entry.authMode === "api-key"
      ? { apiKey: "mock-key-for-testing" } // pragma: allowlist secret
      : {}),
  }, fetchImpl);

  if (status !== 200 || !json.ok) {
    throw new Error(
      `Failed to create mock ${entry.kind} provider: ${JSON.stringify(json)}`,
    );
  }

  return {
    kind: entry.kind,
    api: entry.api,
    providerId: json.data.provider.id,
    baseUrl: entry.baseUrl,
    model: entry.model,
  };
}

// ─── Factory ───

export async function createMockHubEnv(opts?: {
  /** Which providers to install. Defaults to all 5. */
  providerKinds?: FridayProviderKind[];
  /** Optional explicit channel config passed to createFridayHub. */
  channels?: Record<string, unknown>;
  /** Optional skill discovery directories for hub bootstrap. Defaults to []. */
  skillDirs?: string[];
  /** Optional static UI directory served by the test HTTP server. */
  uiStaticDir?: string;
  /** Optional hook invoked after hub creation and before hub.start(). */
  beforeStart?: (hub: FridayHub) => Promise<void> | void;
}): Promise<MockHubEnv> {
  // Reset deterministic counters
  resetMockCounters();

  // Capture original fetch instance-locally to avoid races between multiple envs
  const originalFetch = globalThis.fetch;

  // 1. Create temp state dir
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "friday-mock-e2e-"),
  );

  // 2. Create hub
  const hub = await createFridayHub({
    stateDir,
    skillDirs: opts?.skillDirs ?? [],
    port: 0,
    logRequests: false,
    channels: opts?.channels,
  });
  await opts?.beforeStart?.(hub);
  await hub.start();

  // 3. Spin up HTTP server
  const port = await findFreePort();
  const httpServer = createFridayHttpServer({
    routes: hub.apiRuntime.routes,
    wsGateway: hub.apiRuntime.wsGateway,
    middleware: hub.apiRuntime.middleware,
    webchatWsService: hub.webchatWsService,
    uiStaticDir: opts?.uiStaticDir,
    port,
    host: "127.0.0.1",
    logRequests: false,
  });
  await httpServer.listen();
  const hubBaseUrl = `http://127.0.0.1:${String(port)}`;

  // 4. Login as admin (supports both dev passwordless and production passphrase flows)
  const accessToken = await loginAdmin(hubBaseUrl, originalFetch);

  // 5. Build mock fetches per API
  const mocks: Record<string, MockFetch> = {};
  const routes: MockRouteEntry[] = [];

  const selectedKinds = opts?.providerKinds ?? PROVIDER_MATRIX.map((p) => p.kind);
  const selectedEntries = PROVIDER_MATRIX.filter((p) => selectedKinds.includes(p.kind));

  for (const entry of selectedEntries) {
    const mock = createMockFetch(entry.api);
    mocks[entry.api] = mock;
    routes.push({
      urlPrefix: entry.baseUrl,
      api: entry.api,
      mockFetch: mock,
    });
  }

  // 6. Install router as globalThis.fetch
  const router = createMockFetchRouter(routes, originalFetch);
  (globalThis as unknown as { fetch: unknown }).fetch = router;

  // 7. Register providers via API
  const providers: Record<string, InstalledMockProvider> = {};
  for (const entry of selectedEntries) {
    const installed = await installProvider(hubBaseUrl, accessToken, entry, originalFetch);
    providers[installed.kind] = installed;
  }

  // 8. Set routing: use first provider as default, rest as fallbacks
  const providerIds = Object.values(providers).map((p) => p.providerId);
  if (providerIds.length > 0) {
    await apiFetch(hubBaseUrl, accessToken, "PUT", "/v1/model-routing", {
      defaultProviderId: providerIds[0],
      fallbackProviderIds: providerIds.slice(1),
    }, originalFetch);
  }

  // Build helper maps
  const kindToApi: Record<string, FridayProviderApi> = {};
  for (const entry of selectedEntries) {
    kindToApi[entry.kind] = entry.api;
  }

  return {
    hub,
    httpServer,
    baseUrl: hubBaseUrl,
    stateDir,
    accessToken,
    providers,
    mocks: mocks as Record<FridayProviderApi, MockFetch>,
    mockFor(kind: FridayProviderKind): MockFetch {
      const api = kindToApi[kind];
      if (!api || !mocks[api]) {
        throw new Error(`No mock registered for provider kind: ${kind}`);
      }
      return mocks[api]!;
    },
    async cleanup(): Promise<void> {
      const closeTimeout = setTimeout(() => {
        console.warn("[Mock E2E] Cleanup timeout — continuing without forced exit");
      }, 10_000);
      try {
        // Restore original fetch from instance-local capture
        (globalThis as unknown as { fetch: unknown }).fetch = originalFetch;
        if (httpServer) await httpServer.close();
        if (hub) await hub.stop();
        if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
      } finally {
        clearTimeout(closeTimeout);
      }
    },
  };
}
