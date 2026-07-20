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
} from "../../../../src/security/friday-mutating-action-gate.js";
import type {
  FridayCanonicalApprovalResolution,
  FridayMutatingActionRequest,
} from "../../../../src/security/friday-mutating-action-gate.js";
import {
  deviceOwnerPrincipalIdFor,
  generateTestDeviceKey,
  makeApprovalProof,
  makeApprovalTranscript,
} from "../../../helpers/friday-provider-approval-test-kit.js";
import {
  makeTranscript,
  signTranscriptLowS,
} from "../../../adversarial/_secsetup-s2a.helpers.js";
import { createTestNativeOwnerResolver } from "../../../adversarial/_native-owner-capability.helpers.js";
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

// ─── SEC-APPROVAL-AUTHORITY-001 · CR-2 (Option B*): REAL device-bound owner ───
//
// Provider mutations (create / routing.set / capabilities.doctor) require a
// DEVICE-AUTHORED owner approval: a P-256 `friday-provider-approval-v1` transcript
// signed by the OWNER DEVICE and merely VERIFIED by the Hub (the Hub holds NO
// signing key and REFUSES its own HMAC/unsigned approvals). Instead of fabricating a
// `device-owner:<hash>` token (which production never emits), we drive the REAL
// production auth path: this hub is created with an INJECTED native-owner claim
// resolver (`createTestNativeOwnerResolver()`, which runs the REAL capability mint
// over injected native-evidence doubles), then we run the REAL owner-bootstrap →
// deviceKeyLogin over HTTP with ONE software owner device key. The resulting session
// token's principal is the ordinary local owner `user.id` (NOT a device-owner
// principal); the server resolves the durable owner↔device binding
// (`users.password_hash = device-owner$v1$<sha256Hex(devicePublicKey)>`) server-side
// and binds each device-authored approval to that registered device. The SAME owner
// device key signs both the owner-claim/login transcripts AND every provider
// approval, so `sha256Hex(deviceKey)` matches the durable sentinel.
const MOCK_E2E_OWNER_DEVICE_KEY = generateTestDeviceKey();
const MOCK_E2E_OWNER_DEVICE_ID = "mock-e2e-owner-device";
const MOCK_E2E_OWNER_ORIGIN = "https://friday.localhost";
const MOCK_E2E_OWNER_INSTALL_ID = "mock-e2e-install";
const MOCK_E2E_OWNER_OS_USER = "mock-e2e";
// The device-authored approval's `decidedByPrincipalId` stays the CANONICAL device
// principal (`device-owner:<canonicalDevicePublicKeyHash>`) — the verifier binds it
// to the signing key via `canonicalDevicePublicKeyHash`. The DURABLE binding to the
// authenticated owner is enforced separately, server-side, via the sentinel hash.
const MOCK_E2E_DEVICE_OWNER_PRINCIPAL = deviceOwnerPrincipalIdFor(MOCK_E2E_OWNER_DEVICE_KEY);
const MOCK_E2E_PROVIDER_APPROVAL_EXPIRES_AT = "2099-01-01T00:00:00.000Z";

/** The action-digest actor for a real owner session: `user` principal = `user.id`. */
type OwnerSessionActor = { kind: "user"; id: string; principalId: string };

/**
 * Build a DEVICE-AUTHORED approval for a provider mutation: recompute the request's
 * action digest, then have the owner device sign a transcript bound to that exact
 * digest + canonical device principal + approvalId + expiry. The Hub verifies (never
 * signs) it, and binds the signing key to the authenticated owner's durable device.
 */
function mintDeviceOwnerApproval(
  request: FridayMutatingActionRequest,
  approvalId: string,
): FridayCanonicalApprovalResolution {
  const actionDigest = createFridayMutatingActionDigest(request);
  const expiresAt = MOCK_E2E_PROVIDER_APPROVAL_EXPIRES_AT;
  const transcript = makeApprovalTranscript(MOCK_E2E_OWNER_DEVICE_KEY, {
    actionDigest,
    approvalId,
    decidedByPrincipalId: MOCK_E2E_DEVICE_OWNER_PRINCIPAL,
    expiresAt,
  });
  return {
    decision: "approved",
    approvalId,
    decidedByPrincipalId: MOCK_E2E_DEVICE_OWNER_PRINCIPAL,
    actionDigest,
    expiresAt,
    issuer: "friday_device_owner",
    deviceProof: makeApprovalProof(MOCK_E2E_OWNER_DEVICE_KEY, transcript),
  };
}

/**
 * Drive the REAL production device-owner bootstrap over HTTP (challenge → owner-claim
 * → login-challenge → deviceKeyLogin), signing every transcript with the owner device
 * key. Returns the minted session token (principal = the local owner `user.id`) and
 * that owner user id (for the action-digest actor). Requires the hub to have been
 * created with an injected native-owner claim resolver (else claim/login fail closed).
 */
async function deviceOwnerBootstrapLogin(
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<{ accessToken: string; ownerActor: OwnerSessionActor }> {
  const key = MOCK_E2E_OWNER_DEVICE_KEY;
  const deviceId = MOCK_E2E_OWNER_DEVICE_ID;
  const post = async (pathname: string, body: unknown): Promise<any> => {
    const res = await fetchImpl(`${baseUrl}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: MOCK_E2E_OWNER_ORIGIN },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok?: boolean; data?: any; error?: any };
    if (!res.ok || json.ok === false) {
      throw new Error(
        `device-owner bootstrap step ${pathname} failed (${res.status}): ${JSON.stringify(json)}`,
      );
    }
    return json.data;
  };

  // 1) install challenge → 2) sign + claim the owner slot.
  const challenge = await post("/v1/auth/bootstrap/challenge", {
    installId: MOCK_E2E_OWNER_INSTALL_ID,
    osUser: MOCK_E2E_OWNER_OS_USER,
    origin: MOCK_E2E_OWNER_ORIGIN,
  });
  const claimTranscript = makeTranscript(key, {
    action: challenge.action,
    nonce: challenge.nonce,
    origin: challenge.origin,
    deviceId,
    hubId: challenge.hubId,
    installId: challenge.installId,
    osUser: challenge.osUser,
    expiresAt: challenge.expiresAt,
  });
  await post("/v1/auth/bootstrap/device-claim", {
    nonce: challenge.nonce,
    devicePublicKey: key.spkiDerBase64,
    deviceId,
    origin: challenge.origin,
    installId: challenge.installId,
    osUser: challenge.osUser,
    deviceClaimProof: {
      transcript: claimTranscript,
      signature: { encoding: "ieee-p1363-base64", value: signTranscriptLowS(key, claimTranscript) },
    },
  });

  // 3) server-issued single-use login challenge → 4) sign owner-login + mint session.
  const loginChallenge = await post("/v1/auth/login/challenge", {
    installId: MOCK_E2E_OWNER_INSTALL_ID,
    osUser: MOCK_E2E_OWNER_OS_USER,
    origin: MOCK_E2E_OWNER_ORIGIN,
    deviceId,
    devicePublicKey: key.spkiDerBase64,
  });
  const loginTranscript = makeTranscript(key, {
    action: "owner-login",
    nonce: loginChallenge.nonce,
    origin: loginChallenge.origin,
    deviceId,
    hubId: loginChallenge.hubId,
    installId: loginChallenge.installId,
    osUser: loginChallenge.osUser,
    expiresAt: loginChallenge.expiresAt,
  });
  const login = await post("/v1/auth/login", {
    devicePublicKey: key.spkiDerBase64,
    deviceId,
    origin: loginChallenge.origin,
    deviceLoginProof: {
      transcript: loginTranscript,
      signature: { encoding: "ieee-p1363-base64", value: signTranscriptLowS(key, loginTranscript) },
    },
  });
  const ownerUserId = login.user.id as string;
  return {
    accessToken: login.accessToken as string,
    ownerActor: { kind: "user", id: ownerUserId, principalId: ownerUserId },
  };
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
  ownerToken: string,
  ownerActor: OwnerSessionActor,
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
    actor: ownerActor,
    surface: "api:/v1/providers/create",
    parameters: body,
    planDigest,
    idempotencyKey,
  });
  const { status, json } = await apiFetch<{
    ok: boolean;
    data: { provider: { id: string } };
  }>(baseUrl, ownerToken, "POST", "/v1/providers", {
    ...body,
    planDigest,
    idempotencyKey,
    canonicalApproval: mintDeviceOwnerApproval(
      request,
      `mock-e2e-provider-create:${entry.kind}`,
    ),
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
  /** Test-oracle opt-in for legacy TS skill-run execution; set false to prove default fail-closed behavior. */
  allowTestOnlySkillRunExecution?: boolean;
  /** Test-oracle opt-in for legacy TS skill verification; set false to prove default fail-closed behavior. */
  allowTestOnlySkillVerifyExecution?: boolean;
  /** Test-oracle opt-in for legacy TS skill generator sessions; set false to prove default fail-closed behavior. */
  allowTestOnlySkillGeneratorExecution?: boolean;
  /** Test-oracle opt-in for legacy TS workflow generator sessions; set false to prove default fail-closed behavior. */
  allowTestOnlyWorkflowGeneratorExecution?: boolean;
  /** Test-oracle opt-in for legacy TS workflow catalog mutations; set false to prove default fail-closed behavior. */
  allowTestOnlyWorkflowCatalogMutationExecution?: boolean;
  allowTestOnlyWorkflowBuilderDraftExecution?: boolean;
  /** Test-oracle opt-in for legacy TS workflow deploy execution; set false to prove default fail-closed behavior. */
  allowTestOnlyWorkflowDeployExecution?: boolean;
  /** Test-oracle opt-in for legacy TS agent-run execution; set false to prove default fail-closed behavior. */
  allowTestOnlyAgentRunStartExecution?: boolean;
  /** Test-oracle opt-in for legacy TS agent-run controls; set false to prove default fail-closed behavior. */
  allowTestOnlyAgentRunControlExecution?: boolean;
  /** Test-oracle opt-in for the legacy TS agent run loop executeRun method; set false to prove default fail-closed behavior. */
  allowTestOnlyAgentRunExecution?: boolean;
  /** Test-oracle opt-in for legacy TS durable memory writes; set false to prove default fail-closed behavior. */
  allowTestOnlyTsMemoryWrites?: boolean;
  /** Test-oracle opt-in for legacy TS session lifecycle/message mutations; set false to prove default fail-closed behavior. */
  allowTestOnlySessionExecution?: boolean;
  /** Test-oracle opt-in for legacy TS session agent-run execution; set false to prove default fail-closed behavior. */
  allowTestOnlySessionRunExecution?: boolean;
  /** Test-oracle opt-in for legacy TS session memory extraction mutations; set false to prove default fail-closed behavior. */
  allowTestOnlySessionMemoryExtractionExecution?: boolean;
  /** Test-oracle opt-in for legacy TS cross-border pack mutations; set false to prove default fail-closed behavior. */
  allowTestOnlyCrossBorderPackExecution?: boolean;
  /** Test-oracle opt-in for legacy TS self-healing diagnosis mutations; set false to prove default fail-closed behavior. */
  allowTestOnlyDiagnosisExecution?: boolean;
  /** Test-oracle opt-in for legacy TS realtime checkpoint-ack mutation; set false to prove default fail-closed behavior. */
  allowTestOnlyRealtimeExecution?: boolean;
  /** Test-oracle opt-in for legacy TS skill-converter convert/import/pack mutations; set false to prove default fail-closed behavior. */
  allowTestOnlySkillConverterExecution?: boolean;
  /** Test-oracle opt-in for the legacy TS provider-detect probe; set false to prove default fail-closed behavior. */
  allowTestOnlyProviderDetectExecution?: boolean;
  /** Test-oracle opt-in for the legacy TS provider probe surfaces (validate/doctor/capabilities.doctor); set false to prove default fail-closed behavior. */
  allowTestOnlyProviderProbeExecution?: boolean;
  /** Test-oracle opt-in for the legacy TS provider routing-controls surfaces (routing.pin/routing.penalty.clear); set false to prove default fail-closed behavior. */
  allowTestOnlyProviderRoutingControlsExecution?: boolean;
  /** Test-oracle opt-in for legacy TS capability-acquisition run mutations; set false to prove default fail-closed behavior. */
  allowTestOnlyCapabilityAcquisitionExecution?: boolean;
  /**
   * TS Runtime Retirement — GAP G2: DEFAULT-OFF (INVERTED polarity) guard for the
   * UIX starter-skill execution lane + UIX-driven skill-generator mutators. Unlike
   * the `allowTestOnly*` flags (which default TRUE here so legacy TS runs in
   * tests), this DEFAULTS FALSE — the guard stays INERT so UIX starter-skill
   * execution keeps working exactly as today (zero degradation, all current green
   * preserved). Set true to PROVE the lever fires (503
   * TS_RUNTIME_SKILL_RUNS_RETIRED / TS_RUNTIME_SKILL_GENERATOR_RETIRED).
   * (Anchored above `allowTestOnlySystemIntentExecution` to leave intervening
   * context vs the concurrent G1 sibling PR's adjacent flag insertion.)
   */
  enforceUixSkillExecRetirement?: boolean;
  /** Test-oracle opt-in for the legacy TS system-service `executeIntent` method; set false to prove default fail-closed behavior. */
  allowTestOnlySystemIntentExecution?: boolean;
  /** Test-oracle opt-in for the legacy TS auto-fix executor `execute()` method (route + non-route self-healing path); set false to prove default fail-closed behavior. */
  allowTestOnlyAutoFixExecution?: boolean;
  /**
   * execrun-replacement slice 4 (DARK): per-run Rust-route flag. DEFAULT-FALSE here (honest
   * dark) — the predicate is unconsumed this slice so the value is cosmetic; the ui browser
   * e2e exercises /v1/workflow-runs (workflow runtime), NOT the agent startRun route, so no
   * mock value can change its behavior. Plumbed only for allowTestOnly-pattern consistency.
   */
  routeAgentRunViaRust?: boolean;
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
      // Option C / Option B*: inject a native-owner claim resolver that runs the REAL
      // capability mint over injected native-evidence doubles, so the REAL owner-claim
      // → deviceKeyLogin path mints a genuine `user.id` session (no fabricated token).
      // The surface flag reports device-claim availability honestly (native seam
      // injected here). NEVER flips NATIVE_IPC_ATTESTATION_AVAILABLE.
      resolveNativeOwnerClaimContext: createTestNativeOwnerResolver(),
      nativeOwnerClaimSurfaceAvailable: () => true,
      allowTestOnlyWorkflowRunExecution: opts?.allowTestOnlyWorkflowRunExecution ?? true,
      allowTestOnlySkillRunExecution: opts?.allowTestOnlySkillRunExecution ?? true,
      allowTestOnlySkillVerifyExecution: opts?.allowTestOnlySkillVerifyExecution ?? true,
      allowTestOnlySkillGeneratorExecution: opts?.allowTestOnlySkillGeneratorExecution ?? true,
      allowTestOnlyWorkflowGeneratorExecution: opts?.allowTestOnlyWorkflowGeneratorExecution ?? true,
      allowTestOnlyWorkflowCatalogMutationExecution: opts?.allowTestOnlyWorkflowCatalogMutationExecution ?? true,
      allowTestOnlyWorkflowBuilderDraftExecution: opts?.allowTestOnlyWorkflowBuilderDraftExecution ?? true,
      allowTestOnlyWorkflowDeployExecution: opts?.allowTestOnlyWorkflowDeployExecution ?? true,
      allowTestOnlyAgentRunStartExecution: opts?.allowTestOnlyAgentRunStartExecution ?? true,
      allowTestOnlyAgentRunControlExecution: opts?.allowTestOnlyAgentRunControlExecution ?? true,
      allowTestOnlyAgentRunExecution: opts?.allowTestOnlyAgentRunExecution ?? true,
      allowTestOnlyTsMemoryWrites: opts?.allowTestOnlyTsMemoryWrites ?? true,
      allowTestOnlySessionExecution: opts?.allowTestOnlySessionExecution ?? true,
      allowTestOnlySessionRunExecution: opts?.allowTestOnlySessionRunExecution ?? true,
      allowTestOnlySessionMemoryExtractionExecution: opts?.allowTestOnlySessionMemoryExtractionExecution ?? true,
      allowTestOnlyCrossBorderPackExecution: opts?.allowTestOnlyCrossBorderPackExecution ?? true,
      allowTestOnlyDiagnosisExecution: opts?.allowTestOnlyDiagnosisExecution ?? true,
      allowTestOnlyRealtimeExecution: opts?.allowTestOnlyRealtimeExecution ?? true,
      allowTestOnlySkillConverterExecution: opts?.allowTestOnlySkillConverterExecution ?? true,
      allowTestOnlyProviderDetectExecution: opts?.allowTestOnlyProviderDetectExecution ?? true,
      allowTestOnlyProviderProbeExecution: opts?.allowTestOnlyProviderProbeExecution ?? true,
      allowTestOnlyProviderRoutingControlsExecution: opts?.allowTestOnlyProviderRoutingControlsExecution ?? true,
      allowTestOnlyCapabilityAcquisitionExecution: opts?.allowTestOnlyCapabilityAcquisitionExecution ?? true,
      // TS Runtime Retirement — GAP G2: DEFAULT-FALSE (INVERTED polarity), unlike
      // the allowTestOnly* flags which default true. Default-off keeps UIX
      // starter-skill execution + skill-gen mutators live (zero degradation);
      // a focused test passes true to prove the 503 lever fires. (Anchored above
      // allowTestOnlySystemIntentExecution to leave intervening context vs the
      // concurrent G1 sibling PR's adjacent flag insertion.)
      enforceUixSkillExecRetirement: opts?.enforceUixSkillExecRetirement ?? false,
      allowTestOnlySystemIntentExecution: opts?.allowTestOnlySystemIntentExecution ?? true,
      allowTestOnlyAutoFixExecution: opts?.allowTestOnlyAutoFixExecution ?? true,
      // execrun-replacement slice 4 (DARK): default-FALSE (honest dark), unlike the
      // allowTestOnly* flags which default true. The predicate is unconsumed this slice.
      routeAgentRunViaRust: opts?.routeAgentRunViaRust ?? false,
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
  // Real production owner-bootstrap → deviceKeyLogin (principal = local owner
  // `user.id`). The injected native-owner claim resolver makes the claim/login mint;
  // the server resolves the durable owner↔device binding for provider mutations.
  const { accessToken, ownerActor } = await deviceOwnerBootstrapLogin(hubBaseUrl, originalFetch);

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

  // 7. Register providers via API.
  // Provider mutations require a DEVICE-AUTHORED owner approval (CR-2). We drive them
  // AS the REAL owner session (principal = `user.id`); the server binds each approval
  // to the authenticated owner's durable device (Option B*), and the SAME owner device
  // key that claimed the owner slot signs every approval.
  const providers: Record<string, InstalledMockProvider> = {};
  for (const entry of selectedEntries) {
    const installed = await installProvider(hubBaseUrl, accessToken, ownerActor, entry, originalFetch);
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
      actor: ownerActor,
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
      canonicalApproval: mintDeviceOwnerApproval(request, "mock-e2e-provider-routing"),
    }, originalFetch);
    const doctorBody = { providerIds };
    const doctorPlanDigest = "mock-e2e-capability-doctor";
    const doctorRequest = createFridayProviderSetupMutatingActionRequest({
      action: "capabilities.doctor",
      actor: ownerActor,
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
      canonicalApproval: mintDeviceOwnerApproval(doctorRequest, doctorPlanDigest),
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
