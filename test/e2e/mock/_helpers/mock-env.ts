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
import { resetMasterKeyCache } from "#providers";
import { createFridayProviderSetupMutatingActionRequest } from "../../../../src/api/http/routes/friday-provider-routes.js";

import type {
  FridayProviderApi,
  FridayProviderKind,
} from "../../../../src/providers/model/friday-provider.types.js";
import {
  createFridayMutatingActionDigest,
  signFridayCanonicalApproval,
} from "../../../../src/security/friday-mutating-action-gate.js";
import {
  createMockFetch,
  resetMockCounters,
  type MockFetch,
} from "../../../_mocks/mock-llm-providers.js";
import {
  createMockFetchRouter,
  type MockRouteEntry,
  type MockFetchRouter,
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
  fetchRouter: MockFetchRouter;
  installFetchRouter: () => void;
  providers: Record<string, InstalledMockProvider>;
  mocks: Record<FridayProviderApi, MockFetch>;
  /** Get mock by provider kind */
  mockFor: (kind: FridayProviderKind) => MockFetch;
  /** Restore original fetch */
  cleanup: () => Promise<void>;
}

interface MockAgentRunEnvelope {
  ok: boolean;
  data: {
    runId: string;
    status: string;
    response: string;
    toolCallCount: number;
    images?: string[];
  };
  error?: { code?: string; message?: string };
}

interface MockAgentRunListEnvelope {
  ok: boolean;
  data: {
    items: Array<{
      id: string;
      task: string;
      status: string;
    }>;
  };
}

interface MockSubagentListEnvelope {
  ok: boolean;
  data: {
    items: Array<{
      id: string;
      task: string;
      status: string;
      childRunId: string;
    }>;
  };
}

interface MockToolApprovalEnvelope {
  ok: boolean;
  data?: {
    resolved: boolean;
    grantId?: string;
    decision?: "approved" | "rejected";
  };
  error?: { code?: string; message?: string };
}

const AUTO_DETECT_PROVIDER_ENV_VARS = [
  "FRIDAY_ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "OLLAMA_BASE_URL",
] as const;
const MOCK_E2E_TOKEN_SECRET = "mock-e2e-token-secret"; // pragma: allowlist secret -- deterministic signing key for canonical-gate mock E2E setup
const MOCK_E2E_MASTER_KEY = Buffer.alloc(32, 23).toString("hex");
const MOCK_E2E_ACTOR = {
  kind: "user",
  id: "admin-001",
  principalId: "admin-001",
} as const;

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

  const passphrase = process.env.FRIDAY_TEST_LOCAL_PASSPHRASE ?? "friday-e2e-passphrase-123";
  const bootstrapStatusRes = await fetchImpl(`${baseUrl}/v1/auth/bootstrap/status`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });
  const bootstrapStatus = (await bootstrapStatusRes.json()) as {
    ok: boolean;
    data?: {
      bootstrapRequired: boolean;
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

  throw new Error(
    `Admin login failed: passphrase=${JSON.stringify(passphraseAttempt)}`,
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
  const body = {
    kind: entry.kind,
    name: `Mock ${entry.kind}`,
    baseUrl: entry.baseUrl,
    authMode: entry.authMode,
    api: entry.api,
    supportedModels: [entry.model],
    defaultModel: entry.model,
    enabled: true,
    validateOnSave: false,
    runtimeCapabilities: [
      {
        capability: "text",
        model: entry.model,
        status: "verified",
        verified: true,
        verifiedAt: new Date(0).toISOString(),
        notes: "Mock provider route is backed by deterministic test fetch.",
      },
    ],
    // For api-key providers, provide a mock key
    ...(entry.authMode === "api-key"
      ? { apiKey: "mock-key-for-testing" } // pragma: allowlist secret
      : {}),
  };
  const planDigest = `mock-e2e-provider-create:${entry.kind}`;
  const idempotencyKey = `mock-e2e-provider-create:${entry.kind}`;
  const request = createFridayProviderSetupMutatingActionRequest({
    action: "providers.create",
    actor: MOCK_E2E_ACTOR,
    surface: "api:/v1/providers/create",
    parameters: body,
    planDigest,
    idempotencyKey,
  });
  const { status, json } = await apiFetch<{
    ok: boolean;
    data: { provider: { id: string } };
  }>(baseUrl, token, "POST", "/v1/providers", {
    ...body,
    planDigest,
    idempotencyKey,
    canonicalApproval: signFridayCanonicalApproval({
      decision: "approved",
      approvalId: `mock-e2e-provider-create:${entry.kind}`,
      decidedByPrincipalId: MOCK_E2E_ACTOR.principalId,
      actionDigest: createFridayMutatingActionDigest(request),
      expiresAt: "2099-01-01T00:00:00.000Z",
    }, MOCK_E2E_TOKEN_SECRET),
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
  /** Optional SSRF guard policy override. Defaults to { allowPrivateNetwork: true } for mock E2E tests. */
  ssrfPolicy?: { allowPrivateNetwork?: boolean; hostnameAllowlist?: string[] };
  /** Enable the canonical mutating-action gate for this mock hub. */
  canonicalGate?: boolean;
  /** Test-oracle opt-in for legacy TS workflow-run execution; set false to prove default fail-closed behavior. */
  allowTestOnlyWorkflowRunExecution?: boolean;
  /** Test-oracle opt-in for legacy TS agent-run execution; set false to prove default fail-closed behavior. */
  allowTestOnlyAgentRunStartExecution?: boolean;
  /** Test-oracle opt-in for legacy TS agent-run controls; set false to prove default fail-closed behavior. */
  allowTestOnlyAgentRunControlExecution?: boolean;
}): Promise<MockHubEnv> {
  // Reset deterministic counters
  resetMockCounters();

  // Capture original fetch instance-locally to avoid races between multiple envs
  const originalFetch = globalThis.fetch;
  const originalWarningSuppression = process.env.FRIDAY_SUPPRESS_TEST_ENV_SECURITY_WARNINGS;
  const originalCanonicalGate = process.env.FRIDAY_CANONICAL_GATE;
  const originalMasterKey = process.env.FRIDAY_MASTER_KEY;
  const originalAutoDetectEnv = new Map<string, string | undefined>(
    AUTO_DETECT_PROVIDER_ENV_VARS.map((key) => [key, process.env[key]]),
  );
  process.env.FRIDAY_SUPPRESS_TEST_ENV_SECURITY_WARNINGS = "1";
  process.env.FRIDAY_MASTER_KEY = MOCK_E2E_MASTER_KEY;
  resetMasterKeyCache();
  if (opts?.canonicalGate !== undefined) {
    process.env.FRIDAY_CANONICAL_GATE = opts.canonicalGate ? "true" : "false";
  }
  for (const key of AUTO_DETECT_PROVIDER_ENV_VARS) {
    delete process.env[key];
  }

  // 1. Create temp state dir
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "friday-mock-e2e-"),
  );
  const defaultSkillDirs = [
    path.resolve(process.cwd(), "skills"),
    path.join(stateDir, "managed-skills"),
  ];

  // 2. Create hub
  let hub;
  try {
    hub = await createFridayHub({
      stateDir,
      skillDirs: opts?.skillDirs ?? defaultSkillDirs,
      port: 0,
      logRequests: false,
      channels: opts?.channels,
      tokenSecret: MOCK_E2E_TOKEN_SECRET,
      allowTestOnlyWorkflowRunExecution: opts?.allowTestOnlyWorkflowRunExecution ?? true,
      allowTestOnlyAgentRunStartExecution: opts?.allowTestOnlyAgentRunStartExecution ?? true,
      allowTestOnlyAgentRunControlExecution: opts?.allowTestOnlyAgentRunControlExecution ?? true,
      // Allow private-network targets so mock E2E tests don't require DNS resolution
      ssrfPolicy: opts?.ssrfPolicy ?? { allowPrivateNetwork: true },
    });
    await opts?.beforeStart?.(hub);
    await hub.start();
  } finally {
    if (opts?.canonicalGate !== undefined) {
      if (originalCanonicalGate === undefined) {
        delete process.env.FRIDAY_CANONICAL_GATE;
      } else {
        process.env.FRIDAY_CANONICAL_GATE = originalCanonicalGate;
      }
    }
    for (const [key, value] of originalAutoDetectEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

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

  // 4. Login as admin with local passphrase auth.
  const accessToken = await loginAdmin(hubBaseUrl, originalFetch);

  // 5. Build mock fetches per API
  const mocks: Record<string, MockFetch> = {};
  const routes: MockRouteEntry[] = [];

  const selectedKinds = opts?.providerKinds ?? PROVIDER_MATRIX.map((p) => p.kind);
  const selectedEntries = PROVIDER_MATRIX.filter((p) => selectedKinds.includes(p.kind));

  for (const entry of selectedEntries) {
    const mock = createMockFetch(entry.api);
    mock.setDefault({ type: "text", text: "mock provider validation ok" });
    mocks[entry.api] = mock;
    routes.push({
      urlPrefix: entry.baseUrl,
      api: entry.api,
      mockFetch: mock,
    });
  }

  // 6. Install router as globalThis.fetch
  const router = createMockFetchRouter(routes, originalFetch);
  const installFetchRouter = (): void => {
    (globalThis as unknown as { fetch: unknown }).fetch = router;
  };
  installFetchRouter();

  // 7. Register providers via API
  const providers: Record<string, InstalledMockProvider> = {};
  for (const entry of selectedEntries) {
    const installed = await installProvider(hubBaseUrl, accessToken, entry, originalFetch);
    providers[installed.kind] = installed;
  }

  // 8. Set routing: use first provider as default, rest as fallbacks
  const providerIds = Object.values(providers).map((p) => p.providerId);
  if (providerIds.length > 0) {
    const routingBody = {
      defaultProviderId: providerIds[0],
      fallbackProviderIds: providerIds.slice(1),
    };
    const planDigest = "mock-e2e-provider-routing";
    const idempotencyKey = "mock-e2e-provider-routing";
    const request = createFridayProviderSetupMutatingActionRequest({
      action: "providers.routing.set",
      actor: MOCK_E2E_ACTOR,
      surface: "api:/v1/model-routing/set",
      resourceId: "model-routing",
      parameters: routingBody,
      planDigest,
      idempotencyKey,
    });
    await apiFetch(hubBaseUrl, accessToken, "PUT", "/v1/model-routing", {
      ...routingBody,
      planDigest,
      idempotencyKey,
      canonicalApproval: signFridayCanonicalApproval({
        decision: "approved",
        approvalId: "mock-e2e-provider-routing",
        decidedByPrincipalId: MOCK_E2E_ACTOR.principalId,
        actionDigest: createFridayMutatingActionDigest(request),
        expiresAt: "2099-01-01T00:00:00.000Z",
      }, MOCK_E2E_TOKEN_SECRET),
    }, originalFetch);
    const doctorBody = { providerIds };
    const doctorPlanDigest = "mock-e2e-capability-doctor";
    const doctorRequest = createFridayProviderSetupMutatingActionRequest({
      action: "capabilities.doctor",
      actor: MOCK_E2E_ACTOR,
      surface: "api:/v1/capabilities/doctor",
      resourceId: providerIds.join(","),
      parameters: doctorBody,
      planDigest: doctorPlanDigest,
      idempotencyKey: doctorPlanDigest,
    });
    await apiFetch(hubBaseUrl, accessToken, "POST", "/v1/capabilities/doctor", {
      ...doctorBody,
      planDigest: doctorPlanDigest,
      idempotencyKey: doctorPlanDigest,
      canonicalApproval: signFridayCanonicalApproval({
        decision: "approved",
        approvalId: doctorPlanDigest,
        decidedByPrincipalId: MOCK_E2E_ACTOR.principalId,
        actionDigest: createFridayMutatingActionDigest(doctorRequest),
        expiresAt: "2099-01-01T00:00:00.000Z",
      }, MOCK_E2E_TOKEN_SECRET),
    }, originalFetch);
  }
  for (const mock of Object.values(mocks)) {
    mock.reset();
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
    fetchRouter: router,
    installFetchRouter,
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
        if (originalWarningSuppression === undefined) {
          delete process.env.FRIDAY_SUPPRESS_TEST_ENV_SECURITY_WARNINGS;
        } else {
          process.env.FRIDAY_SUPPRESS_TEST_ENV_SECURITY_WARNINGS = originalWarningSuppression;
        }
        if (originalMasterKey === undefined) {
          delete process.env.FRIDAY_MASTER_KEY;
        } else {
          process.env.FRIDAY_MASTER_KEY = originalMasterKey;
        }
        resetMasterKeyCache();
        clearTimeout(closeTimeout);
      }
    },
  };
}

async function waitForMockCondition<T>(
  poll: () => Promise<T | null>,
  options: { timeoutMs: number; intervalMs?: number; label: string },
): Promise<T> {
  const startedAt = Date.now();
  const intervalMs = options.intervalMs ?? 100;
  while (Date.now() - startedAt < options.timeoutMs) {
    const value = await poll();
    if (value !== null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${options.label}`);
}

export async function findMockAgentRunIdByTask(
  env: Pick<MockHubEnv, "baseUrl" | "accessToken">,
  task: string,
  options?: { timeoutMs?: number },
): Promise<string> {
  return waitForMockCondition(
    async () => {
      const res = await apiFetch<MockAgentRunListEnvelope>(
        env.baseUrl,
        env.accessToken,
        "GET",
        "/v1/agent/runs?limit=20",
      );
      if (res.status !== 200 || !res.json.ok) {
        return null;
      }
      return res.json.data.items.find((run) => run.task === task)?.id ?? null;
    },
    {
      timeoutMs: options?.timeoutMs ?? 10_000,
      label: `agent run for task ${task}`,
    },
  );
}

export async function approveMockAgentToolCall(
  env: Pick<MockHubEnv, "baseUrl" | "accessToken">,
  input: { task: string; toolCallId: string; toolName?: string; timeoutMs?: number },
): Promise<NonNullable<MockToolApprovalEnvelope["data"]>> {
  const runId = await findMockAgentRunIdByTask(env, input.task, {
    timeoutMs: input.timeoutMs,
  });
  const tryApprove = async (
    targetRunId: string,
    toolCallId: string,
  ): Promise<NonNullable<MockToolApprovalEnvelope["data"]> | null> => {
    const res = await apiFetch<MockToolApprovalEnvelope>(
      env.baseUrl,
      env.accessToken,
      "POST",
      `/v1/agent/runs/${encodeURIComponent(targetRunId)}/approve-tool`,
      { toolCallId },
    );
    if (res.status !== 200 || !res.json.ok || !res.json.data?.resolved) {
      return null;
    }
    return res.json.data;
  };
  const readChildRunIds = async (): Promise<string[]> => {
    const res = await apiFetch<MockSubagentListEnvelope>(
      env.baseUrl,
      env.accessToken,
      "GET",
      `/v1/agent/runs/${encodeURIComponent(runId)}/subagents`,
    );
    if (res.status !== 200 || !res.json.ok) {
      return [];
    }
    return res.json.data.items
      .map((item) => item.childRunId)
      .filter((childRunId): childRunId is string => typeof childRunId === "string" && childRunId.length > 0);
  };
  return waitForMockCondition(
    async () => {
      const requestedApproval = await tryApprove(runId, input.toolCallId);
      if (requestedApproval) {
        return requestedApproval;
      }
      for (const childRunId of await readChildRunIds()) {
        const childApproval = await tryApprove(childRunId, input.toolCallId);
        if (childApproval) {
          return childApproval;
        }
      }
      return null;
    },
    {
      timeoutMs: input.timeoutMs ?? 10_000,
      label: `tool approval ${input.toolCallId}`,
    },
  );
}

export async function startMockAgentRunAndApproveTools<T extends MockAgentRunEnvelope = MockAgentRunEnvelope>(
  env: Pick<MockHubEnv, "baseUrl" | "accessToken">,
  body: Record<string, unknown> & { task: string },
  toolCallIds: readonly string[],
  options?: { timeoutMs?: number },
): Promise<{ status: number; json: T }> {
  const runPromise = apiFetch<T>(
    env.baseUrl,
    env.accessToken,
    "POST",
    "/v1/agent/runs",
    body,
  );

  for (const toolCallId of toolCallIds) {
    await approveMockAgentToolCall(env, {
      task: body.task,
      toolCallId,
      timeoutMs: options?.timeoutMs,
    });
  }

  return await runPromise;
}
