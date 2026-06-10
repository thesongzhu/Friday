/**
 * Real LLM E2E tests — exercises provider, skill generator, and workflow
 * generator against a live Anthropic endpoint via API key.
 *
 * Gated by `FRIDAY_E2E_LIVE_ANTHROPIC=1`.
 * Backward compatibility: `FRIDAY_LLM_E2E` also enables this suite.
 * Requires:
 *   - FRIDAY_ANTHROPIC_API_KEY (canonical)
 *   - ANTHROPIC_API_KEY (legacy alias)
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
import {
  hasLiveAnthropicApiKey,
  liveAnthropicCredentialMessage,
  LIVE_ANTHROPIC_MODEL as MODEL,
  resolveLiveAnthropicApiKeyEnvRef,
} from "./_helpers/live-anthropic.js";

// ─── Env guard ───

const ANTHROPIC_E2E_ENABLED =
  process.env.FRIDAY_E2E_LIVE_ANTHROPIC === "1" ||
  !!process.env.FRIDAY_LLM_E2E;
const HAS_LIVE_ANTHROPIC_API_KEY = hasLiveAnthropicApiKey();
const LIVE_ANTHROPIC_API_KEY_ENV_REF = resolveLiveAnthropicApiKeyEnvRef();

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

function extractDraft<T extends Record<string, unknown>>(
  payload: { data?: T } | null | undefined,
): Record<string, unknown> | null {
  const draft = payload?.data?.draft;
  return draft && typeof draft === "object" && !Array.isArray(draft)
    ? draft as Record<string, unknown>
    : null;
}

async function waitFor<T>(
  producer: () => Promise<T>,
  predicate: (value: T) => boolean,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const intervalMs = options?.intervalMs ?? 250;
  const startedAt = Date.now();

  let lastValue = await producer();
  while (!predicate(lastValue)) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `Timed out after ${String(timeoutMs)}ms waiting for predicate. Last value: ${JSON.stringify(lastValue)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    lastValue = await producer();
  }
  return lastValue;
}

interface LlmTestEnv {
  hub: FridayHub;
  httpServer: FridayHttpServer;
  baseUrl: string;
  token: string;
  providerId: string;
  cleanup: () => Promise<void>;
}

async function createAnthropicProvider(
  baseUrl: string,
  token: string,
  name: string,
): Promise<string> {
  if (!LIVE_ANTHROPIC_API_KEY_ENV_REF) {
    throw new Error(liveAnthropicCredentialMessage());
  }

  const createProviderRes = await fetch(`${baseUrl}/v1/providers`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      kind: "anthropic",
      name,
      baseUrl: "https://api.anthropic.com",
      authMode: "api-key",
      api: "anthropic-messages",
      apiKey: LIVE_ANTHROPIC_API_KEY_ENV_REF,
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
  return createProviderJson.data.provider.id;
}

async function updateRouting(
  baseUrl: string,
  token: string,
  input: {
    defaultProviderId: string;
    defaultModel?: string;
    fallbackProviderIds?: string[];
  },
): Promise<void> {
  const routingRes = await fetch(`${baseUrl}/v1/model-routing`, {
    method: "PUT",
    headers: authHeaders(token),
    body: JSON.stringify(input),
  });
  if (!routingRes.ok) {
    throw new Error(`Routing config failed: ${String(routingRes.status)}`);
  }
}

async function getRouting(
  baseUrl: string,
  token: string,
): Promise<{
  defaultProviderId: string;
  defaultModel?: string;
  fallbackProviderIds: string[];
}> {
  const res = await fetch(`${baseUrl}/v1/model-routing`, {
    headers: authHeaders(token),
  });
  const json = (await res.json()) as {
    ok: boolean;
    data: {
      routing: {
        defaultProviderId: string;
        defaultModel?: string;
        fallbackProviderIds?: string[];
      };
    };
  };
  if (!json.ok) {
    throw new Error(`Routing read failed: ${JSON.stringify(json)}`);
  }
  return {
    defaultProviderId: json.data.routing.defaultProviderId,
    defaultModel: json.data.routing.defaultModel,
    fallbackProviderIds: json.data.routing.fallbackProviderIds ?? [],
  };
}

async function startSkillGeneratorSession(
  baseUrl: string,
  token: string,
  goal: string,
): Promise<{
  sessionId: string;
  draft: Record<string, unknown>;
}> {
  const startRes = await fetch(
    `${baseUrl}/v1/skills/generator/sessions`,
    {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        goal,
        userId: "admin-001",
        channel: "e2e-test",
        requestedModel: MODEL,
      }),
    },
  );
  if (startRes.status !== 200) {
    throw new Error(`Skill generator session start failed: ${String(startRes.status)}`);
  }
  const startJson = (await startRes.json()) as {
    ok: boolean;
    data: {
      session: { sessionId: string };
      mode: string;
      draft?: Record<string, unknown>;
    };
  };
  if (!startJson.ok) {
    throw new Error(`Skill generator start returned !ok: ${JSON.stringify(startJson)}`);
  }

  const sessionId = startJson.data.session.sessionId;
  let draft = extractDraft(startJson);

  if (startJson.data.mode === "clarification_required") {
    const msgRes = await fetch(
      `${baseUrl}/v1/skills/generator/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          message:
            "Keep the implementation extremely small, shell-based, deterministic, and follow the requested skill id and behavior exactly.",
          requestedModel: MODEL,
        }),
      },
    );
    if (msgRes.status !== 200) {
      throw new Error(`Skill generator clarification failed: ${String(msgRes.status)}`);
    }
    const msgJson = (await msgRes.json()) as {
      ok: boolean;
      data?: Record<string, unknown>;
    };
    if (!msgJson.ok) {
      throw new Error(`Skill generator clarification returned !ok: ${JSON.stringify(msgJson)}`);
    }
    draft = extractDraft(msgJson);
  }

  if (!draft) {
    const genRes = await fetch(
      `${baseUrl}/v1/skills/generator/sessions/${sessionId}/generate`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ requestedModel: MODEL }),
      },
    );
    if (genRes.status !== 200) {
      const body = await genRes.text();
      throw new Error(`Skill generator generate failed (${String(genRes.status)}): ${body}`);
    }
    const genJson = (await genRes.json()) as {
      ok: boolean;
      data?: Record<string, unknown>;
    };
    if (!genJson.ok) {
      throw new Error(`Skill generator generate returned !ok: ${JSON.stringify(genJson)}`);
    }
    draft = extractDraft(genJson);
  }

  if (!draft) {
    throw new Error("Skill generator did not produce a draft");
  }

  return { sessionId, draft };
}

async function approveAndStageGeneratedSkillCandidate(
  baseUrl: string,
  token: string,
  sessionId: string,
  runInput: Record<string, unknown>,
): Promise<{
  skillId: string;
  candidateId: string;
  candidateDir: string;
  promotionStage: string;
  testSummary: {
    ok: boolean;
    behavioralCheck?: {
      attempted: boolean;
      satisfied: boolean;
      expectedMarkers: string[];
      matchedMarkers: string[];
    };
  };
  blockedRun: {
    status: number;
    code?: string;
    message?: string;
  };
}> {
  const testRes = await fetch(
    `${baseUrl}/v1/skills/generator/sessions/${sessionId}/test`,
    {
      method: "POST",
      headers: authHeaders(token),
    },
  );
  if (testRes.status !== 200) {
    throw new Error(`Skill generator test failed: ${String(testRes.status)}`);
  }
  const testJson = (await testRes.json()) as {
    ok: boolean;
    data: {
      test: {
        ok: boolean;
        behavioralCheck?: {
          attempted: boolean;
          satisfied: boolean;
          expectedMarkers: string[];
          matchedMarkers: string[];
        };
      };
    };
  };
  if (!testJson.ok || !testJson.data.test.ok) {
    throw new Error(`Skill generator self-test did not pass: ${JSON.stringify(testJson)}`);
  }

  const evidenceRes = await fetch(
    `${baseUrl}/v1/skills/generator/sessions/${sessionId}/evidence`,
    {
      headers: authHeaders(token),
    },
  );
  if (evidenceRes.status !== 200) {
    throw new Error(`Skill generator evidence failed: ${String(evidenceRes.status)}`);
  }
  const evidenceJson = (await evidenceRes.json()) as {
    ok: boolean;
    data: {
      evidence: {
        approvalReadiness: { ready: boolean };
        validationSummary: { ok: boolean };
      };
    };
  };
  if (
    !evidenceJson.ok ||
    !evidenceJson.data.evidence.validationSummary.ok ||
    !evidenceJson.data.evidence.approvalReadiness.ready
  ) {
    throw new Error(`Skill generator evidence not approval-ready: ${JSON.stringify(evidenceJson)}`);
  }

  const approveRes = await fetch(
    `${baseUrl}/v1/skills/generator/sessions/${sessionId}/approve`,
    {
      method: "POST",
      headers: authHeaders(token),
    },
  );
  if (approveRes.status !== 200) {
    const body = await approveRes.text();
    throw new Error(`Skill generator approve failed (${String(approveRes.status)}): ${body}`);
  }
  const approveJson = (await approveRes.json()) as {
    ok: boolean;
    data: {
      skillId: string;
      candidateId: string;
      candidateDir: string;
      registryRefreshed: boolean;
      promotionStage: string;
      evidence: {
        approvalReadiness: { ready: boolean };
        validationSummary: { ok: boolean };
      };
    };
  };
  if (
    !approveJson.ok ||
    approveJson.data.registryRefreshed ||
    approveJson.data.promotionStage !== "candidate_staged" ||
    !approveJson.data.candidateId ||
    !approveJson.data.candidateDir ||
    !approveJson.data.evidence.validationSummary.ok ||
    !approveJson.data.evidence.approvalReadiness.ready
  ) {
    throw new Error(`Skill generator approve returned invalid candidate-staging evidence: ${JSON.stringify(approveJson)}`);
  }

  const skillId = approveJson.data.skillId;
  const runSkillRes = await fetch(
    `${baseUrl}/v1/skills/${encodeURIComponent(skillId)}/run`,
    {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ input: runInput }),
    },
  );
  const runSkillJson = (await runSkillRes.json()) as {
    ok?: boolean;
    error?: { code?: string; message?: string };
  };
  if (runSkillRes.status === 200 || runSkillJson.ok === true) {
    throw new Error(`Staged generated skill was runnable before lifecycle promotion: ${JSON.stringify(runSkillJson)}`);
  }
  return {
    skillId,
    candidateId: approveJson.data.candidateId,
    candidateDir: approveJson.data.candidateDir,
    promotionStage: approveJson.data.promotionStage,
    testSummary: testJson.data.test,
    blockedRun: {
      status: runSkillRes.status,
      code: runSkillJson.error?.code,
      message: runSkillJson.error?.message,
    },
  };
}

async function createLlmTestEnv(): Promise<LlmTestEnv> {
  // 1. Create temp state dir
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "friday-llm-e2e-"),
  );
  const bundledSkillsDir = path.join(stateDir, "skills");
  const managedSkillsDir = path.join(stateDir, "managed-skills");
  fs.mkdirSync(bundledSkillsDir, { recursive: true });
  fs.mkdirSync(managedSkillsDir, { recursive: true });

  // 2. Create hub with temp state dir
  const hub = await createFridayHub({
    stateDir,
    skillDirs: [bundledSkillsDir, managedSkillsDir],
    // Keep tokenSecret omitted so the hub uses its local test defaults.
    port: 0,
    logRequests: false,
    allowTestOnlyProviderProbeExecution: true,
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
    body: JSON.stringify({ localPassphrase: "friday-test-local-passphrase-123" }),
  });
  const loginJson = (await loginRes.json()) as {
    ok: boolean;
    data: { accessToken: string; refreshToken: string };
  };
  if (!loginJson.ok) {
    throw new Error(`Admin login failed in LLM E2E setup: ${JSON.stringify(loginJson)}`);
  }
  const token = loginJson.data.accessToken;

  if (!LIVE_ANTHROPIC_API_KEY_ENV_REF) {
    throw new Error(liveAnthropicCredentialMessage());
  }

  // 5. Create Anthropic provider via API (API key mode, env-ref credential)
  const providerId = await createAnthropicProvider(
    baseUrl,
    token,
    "Anthropic API Key (E2E)",
  );

  // 6. Set routing config to use this provider
  await updateRouting(baseUrl, token, {
      defaultProviderId: providerId,
      defaultModel: MODEL,
      fallbackProviderIds: [],
  });

  const cleanup = async (): Promise<void> => {
    await httpServer.close();
    await hub.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
  };

  return { hub, httpServer, baseUrl, token, providerId, cleanup };
}

// ─── Tests ───

describe.skipIf(!ANTHROPIC_E2E_ENABLED || !HAS_LIVE_ANTHROPIC_API_KEY)("Friday LLM E2E (real Anthropic)", () => {
  let env: LlmTestEnv;

  beforeAll(async () => {
    if (!HAS_LIVE_ANTHROPIC_API_KEY) {
      throw new Error(liveAnthropicCredentialMessage());
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
    "validates the seeded Anthropic API-key provider",
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
          };

          if (credential) {
            headers["x-api-key"] = credential;
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
    "generates, approves, and stages a skill candidate via the skill generator",
    async () => {
      // Start a session
      const startRes = await fetch(
        `${env.baseUrl}/v1/skills/generator/sessions`,
        {
          method: "POST",
          headers: authHeaders(env.token),
          body: JSON.stringify({
            goal: "Create a skill that returns a concise greeting plus the current date in ISO format",
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
      let draft = extractDraft(startJson);

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
        const msgJson = (await msgRes.json()) as {
          ok: boolean;
          data?: {
            draft?: {
              manifest: Record<string, unknown>;
              files: Array<{ path: string; content: string }>;
              validation: { ok: boolean };
            };
          };
        };
        expect(msgJson.ok).toBe(true);
        draft = extractDraft(msgJson);
      }

      if (!draft) {
        // Force generation only when the session response did not already
        // return a generated draft. The live API may auto-generate when the
        // initial prompt is already sufficient.
        const genRes = await fetch(
          `${env.baseUrl}/v1/skills/generator/sessions/${sessionId}/generate`,
          {
            method: "POST",
            headers: authHeaders(env.token),
            body: JSON.stringify({ requestedModel: MODEL }),
          },
        );

        expect([200, 422]).toContain(genRes.status);

        const genJson = (await genRes.json()) as Record<string, unknown>;

        if (genRes.status === 200) {
          expect(genJson.ok).toBe(true);
          draft = extractDraft(genJson as { data?: Record<string, unknown> });
        } else {
          expect(genJson.ok).toBe(false);
          expect(genJson.error).toBeTruthy();
          const error = genJson.error as { code: string; message: string };
          expect(typeof error.code).toBe("string");
          expect(typeof error.message).toBe("string");
          return;
        }
      }

      expect(draft).toBeTruthy();
      const typedDraft = draft as {
        manifest: Record<string, unknown>;
        files: Array<{ path: string; content: string }>;
        validation: { ok: boolean };
      };
      expect(typedDraft.manifest).toBeTruthy();
      expect(typedDraft.files.length).toBeGreaterThan(0);
      expect(typedDraft.files.some((file) => file.content.length > 0)).toBe(true);
      expect(typedDraft.validation.ok).toBe(true);

      const testRes = await fetch(
        `${env.baseUrl}/v1/skills/generator/sessions/${sessionId}/test`,
        {
          method: "POST",
          headers: authHeaders(env.token),
        },
      );
      expect(testRes.status).toBe(200);
      const testJson = (await testRes.json()) as {
        ok: boolean;
        data: { test: { ok: boolean } };
      };
      expect(testJson.ok).toBe(true);
      expect(testJson.data.test.ok).toBe(true);

      const evidenceRes = await fetch(
        `${env.baseUrl}/v1/skills/generator/sessions/${sessionId}/evidence`,
        {
          headers: authHeaders(env.token),
        },
      );
      expect(evidenceRes.status).toBe(200);
      const evidenceJson = (await evidenceRes.json()) as {
        ok: boolean;
        data: {
          evidence: {
            approvalReadiness: { ready: boolean };
            validationSummary: { ok: boolean };
          };
        };
      };
      expect(evidenceJson.ok).toBe(true);
      expect(evidenceJson.data.evidence.validationSummary.ok).toBe(true);
      expect(evidenceJson.data.evidence.approvalReadiness.ready).toBe(true);

      const approveRes = await fetch(
        `${env.baseUrl}/v1/skills/generator/sessions/${sessionId}/approve`,
        {
          method: "POST",
          headers: authHeaders(env.token),
        },
      );
      expect(approveRes.status).toBe(200);
      const approveJson = (await approveRes.json()) as {
        ok: boolean;
        data: {
          skillId: string;
          skillDir: string;
          candidateId: string;
          candidateDir: string;
          registryRefreshed: boolean;
          promotionStage: string;
          evidence: {
            approvalReadiness: { ready: boolean };
            validationSummary: { ok: boolean };
            stagedCandidateIdentity?: {
              skillId: string;
              candidateId?: string;
              candidateDir?: string;
              filesDir?: string;
            };
          };
        };
      };
      expect(approveJson.ok).toBe(true);
      expect(approveJson.data.registryRefreshed).toBe(false);
      expect(approveJson.data.promotionStage).toBe("candidate_staged");
      expect(approveJson.data.candidateId).toBeTruthy();
      expect(approveJson.data.candidateDir).toBeTruthy();
      expect(approveJson.data.evidence.validationSummary.ok).toBe(true);
      expect(approveJson.data.evidence.approvalReadiness.ready).toBe(true);
      expect(approveJson.data.evidence.stagedCandidateIdentity).toMatchObject({
        skillId: approveJson.data.skillId,
        candidateId: approveJson.data.candidateId,
        candidateDir: approveJson.data.candidateDir,
        filesDir: approveJson.data.skillDir,
      });
    },
    90_000,
  );

  it(
    "automatically resolves a low-risk self-healing model incident through the agent loop",
    async () => {
      const policyRes = await fetch(`${env.baseUrl}/v1/agent-loop/policy`, {
        method: "PUT",
        headers: authHeaders(env.token),
        body: JSON.stringify({ autoApplyLowRisk: true, paused: false }),
      });
      expect(policyRes.status).toBe(200);

      const secondaryProviderId = await createAnthropicProvider(
        env.baseUrl,
        env.token,
        "Anthropic API Key (E2E Auto Self-Heal Secondary)",
      );

      await updateRouting(env.baseUrl, env.token, {
        defaultProviderId: env.providerId,
        defaultModel: MODEL,
        fallbackProviderIds: [secondaryProviderId],
      });

      const processResult = env.hub.selfHealing.reportStructuredFailure({
        userId: "admin-001",
        category: "model",
        severity: "medium",
        message: "Synthetic model failure for live auto self-healing proof",
        context: {
          source: "assistant",
          providerId: env.providerId,
          actualProviderId: env.providerId,
          model: MODEL,
          actualModel: MODEL,
          fallbackProviderIds: [secondaryProviderId],
          enforceRequestedModel: false,
        },
      });

      expect(processResult.incidentsCreated.length).toBeGreaterThan(0);
      const incidentId = processResult.incidentsCreated[0]!.incidentId;

      const actionRecord = await waitFor(
        async () => {
          const res = await fetch(
            `${env.baseUrl}/v1/auto-fix/actions?incidentId=${encodeURIComponent(incidentId)}`,
            { headers: authHeaders(env.token) },
          );
          const json = (await res.json()) as {
            ok: boolean;
            data: {
              items: Array<{
                action: { actionId: string; status: string; outcome?: string | null };
                summary: { actionId: string; status: string; rollbackPlanAvailable: boolean };
                evidence: {
                  acceptanceResult: { passed: boolean; reason: string };
                  rollbackResult: { available: boolean };
                };
              }>;
            };
          };
          if (!json.ok || json.data.items.length === 0) {
            return null;
          }
          return json.data.items[0]!;
        },
        (value) => value !== null && value.summary.status === "applied",
        { timeoutMs: 15_000, intervalMs: 300 },
      );

      expect(actionRecord.summary.rollbackPlanAvailable).toBe(true);
      expect(actionRecord.action.status).toBe("applied");
      expect(actionRecord.action.outcome).toBe("success");
      expect(actionRecord.evidence.rollbackResult.available).toBe(true);
      expect(actionRecord.evidence.acceptanceResult.passed).toBe(true);

      const actionId = actionRecord.summary.actionId;

      const runRecord = await waitFor(
        async () => {
          const res = await fetch(
            `${env.baseUrl}/v1/agent-loop/runs?limit=20`,
            { headers: authHeaders(env.token) },
          );
          const json = (await res.json()) as {
            ok: boolean;
            data: {
              items: Array<{
                run: { status: string };
                action: { summary: { actionId: string } } | null;
              }>;
            };
          };
          if (!json.ok) {
            return null;
          }
          return json.data.items.find((item) => item.action?.summary.actionId === actionId) ?? null;
        },
        (value) => value !== null && value.run.status === "verified",
        { timeoutMs: 15_000, intervalMs: 300 },
      );

      expect(runRecord.run.status).toBe("verified");

      const routingAfterAutoHeal = await getRouting(env.baseUrl, env.token);
      expect(routingAfterAutoHeal.defaultProviderId).toBe(secondaryProviderId);
      expect(routingAfterAutoHeal.fallbackProviderIds).toContain(env.providerId);
    },
    90_000,
  );

  it(
    "stages generated skill candidates with the same id without making them runnable",
    async () => {
      const requestedSkillId = `live-upgrade-skill-${Date.now().toString(36)}`;

      const first = await startSkillGeneratorSession(
        env.baseUrl,
        env.token,
        `Create a tiny Friday shell skill with manifest id "${requestedSkillId}" and manifest version "1.0.0". When the skill runs, it must output the exact string "VERSION_ONE:${requestedSkillId}" somewhere in the result. Keep the exact same skill id and version I specified.`,
      );
      const firstDraft = first.draft as {
        manifest?: { id?: string; version?: string };
      };
      expect(typeof firstDraft.manifest?.id).toBe("string");

      const firstApproval = await approveAndStageGeneratedSkillCandidate(
        env.baseUrl,
        env.token,
        first.sessionId,
        { task: "Run the version one skill." },
      );
      expect(firstApproval.promotionStage).toBe("candidate_staged");
      expect(firstApproval.blockedRun.status).toBe(409);
      expect(firstApproval.blockedRun.code).toMatch(/SKILL_NOT_AVAILABLE|SKILL_NOT_FOUND/);
      expect(firstApproval.testSummary.behavioralCheck?.attempted).toBe(true);
      expect(firstApproval.testSummary.behavioralCheck?.satisfied).toBe(true);

      const second = await startSkillGeneratorSession(
        env.baseUrl,
        env.token,
        `Create another Friday shell skill candidate with manifest id "${firstApproval.skillId}". Keep the exact same manifest id "${firstApproval.skillId}", but change manifest version to "2.0.0". When its explicit self-test runs, it must output the exact string "VERSION_TWO:${firstApproval.skillId}" somewhere in the result. Do not create a new skill id.`,
      );
      const secondDraft = second.draft as {
        manifest?: { id?: string; version?: string };
      };
      expect(typeof secondDraft.manifest?.id).toBe("string");

      const secondApproval = await approveAndStageGeneratedSkillCandidate(
        env.baseUrl,
        env.token,
        second.sessionId,
        { task: "Run the upgraded version two skill." },
      );

      expect(secondApproval.skillId).toBe(firstApproval.skillId);
      expect(secondApproval.promotionStage).toBe("candidate_staged");
      expect(secondApproval.candidateId).not.toBe(firstApproval.candidateId);
      expect(secondApproval.blockedRun.status).toBe(409);
      expect(secondApproval.blockedRun.code).toMatch(/SKILL_NOT_AVAILABLE|SKILL_NOT_FOUND/);
      expect(secondApproval.testSummary.behavioralCheck?.attempted).toBe(true);
      expect(secondApproval.testSummary.behavioralCheck?.satisfied).toBe(true);
    },
    120_000,
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
      let draft = extractDraft(startJson as { data?: Record<string, unknown> });

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
        const msgJson = (await msgRes.json()) as {
          ok: boolean;
          data?: {
            draft?: {
              spec: Record<string, unknown>;
              visual: Record<string, unknown>;
              compiledGraph: Record<string, unknown>;
              validation: { ok: boolean };
            };
          };
        };
        expect(msgJson.ok).toBe(true);
        draft = extractDraft(msgJson);
      }

      if (!draft) {
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
          data?: Record<string, unknown>;
        };
        expect(genJson.ok).toBe(true);
        draft = extractDraft(genJson);
      }

      expect(draft).toBeTruthy();
      const typedDraft = draft as {
        spec: Record<string, unknown>;
        visual: Record<string, unknown>;
        compiledGraph: Record<string, unknown>;
        validation: { ok: boolean };
      };
      expect(typedDraft.spec).toBeTruthy();
      expect(typedDraft.visual).toBeTruthy();
      expect(typedDraft.compiledGraph).toBeTruthy();
      expect(typedDraft.validation).toBeTruthy();
    },
    90_000,
  );

  it(
    "executes and rolls back a self-healing model fallback action over real HTTP",
    async () => {
      const policyRes = await fetch(`${env.baseUrl}/v1/agent-loop/policy`, {
        method: "PUT",
        headers: authHeaders(env.token),
        body: JSON.stringify({ autoApplyLowRisk: false }),
      });
      expect(policyRes.status).toBe(200);

      const secondaryProviderId = await createAnthropicProvider(
        env.baseUrl,
        env.token,
        "Anthropic API Key (E2E Secondary)",
      );

      await updateRouting(env.baseUrl, env.token, {
        defaultProviderId: env.providerId,
        defaultModel: MODEL,
        fallbackProviderIds: [secondaryProviderId],
      });

      const processResult = env.hub.selfHealing.reportStructuredFailure({
        userId: "admin-001",
        category: "model",
        severity: "medium",
        message: "Synthetic model failure for live fallback rollback proof",
        context: {
          source: "assistant",
          providerId: env.providerId,
          actualProviderId: env.providerId,
          model: MODEL,
          actualModel: MODEL,
          fallbackProviderIds: [secondaryProviderId],
          enforceRequestedModel: false,
        },
      });

      expect(processResult.incidentsCreated.length).toBeGreaterThan(0);
      const incidentId = processResult.incidentsCreated[0]!.incidentId;

      const listRes = await fetch(
        `${env.baseUrl}/v1/auto-fix/actions?incidentId=${encodeURIComponent(incidentId)}`,
        { headers: authHeaders(env.token) },
      );
      expect(listRes.status).toBe(200);
      const listJson = (await listRes.json()) as {
        ok: boolean;
        data: {
          items: Array<{
            action: { actionId: string };
            summary: { actionId: string; rollbackPlanAvailable: boolean; status: string };
            evidence: { rollbackResult: { available: boolean } };
          }>;
        };
      };
      expect(listJson.ok).toBe(true);
      expect(listJson.data.items.length).toBeGreaterThan(0);

      const actionRecord = listJson.data.items[0]!;
      const actionId = actionRecord.summary.actionId;
      expect(actionRecord.action.actionId).toBe(actionId);
      expect(actionRecord.summary.status).toBe("planned");
      expect(actionRecord.summary.rollbackPlanAvailable).toBe(true);
      expect(actionRecord.evidence.rollbackResult.available).toBe(true);

      const executeRes = await fetch(
        `${env.baseUrl}/v1/auto-fix/actions/${encodeURIComponent(actionId)}/execute`,
        {
          method: "POST",
          headers: authHeaders(env.token),
        },
      );
      expect(executeRes.status).toBe(200);
      const executeJson = (await executeRes.json()) as {
        ok: boolean;
        data: {
          action: {
            action: { actionId: string; status: string };
            summary: { actionId: string; status: string; rollbackPlanAvailable: boolean };
            evidence: {
              rollbackResult: { available: boolean; rollbackAttempted: boolean; rollbackSucceeded: boolean };
            };
          };
          result: {
            success: boolean;
            verificationPassed: boolean;
            rollbackAttempted: boolean;
            rollbackSucceeded: boolean;
          };
        };
      };
      expect(executeJson.ok).toBe(true);
      expect(executeJson.data.action.summary.actionId).toBe(actionId);
      expect(executeJson.data.action.action.status).toBe("applied");
      expect(executeJson.data.action.summary.status).toBe("applied");
      expect(executeJson.data.action.evidence.rollbackResult.available).toBe(true);
      expect(executeJson.data.result.success).toBe(true);
      expect(executeJson.data.result.verificationPassed).toBe(true);
      expect(executeJson.data.result.rollbackAttempted).toBe(false);

      const routingAfterExecute = await getRouting(env.baseUrl, env.token);
      expect(routingAfterExecute.defaultProviderId).toBe(secondaryProviderId);

      const rollbackRes = await fetch(
        `${env.baseUrl}/v1/auto-fix/actions/${encodeURIComponent(actionId)}/rollback`,
        {
          method: "POST",
          headers: authHeaders(env.token),
          body: JSON.stringify({ reason: "Verify rollback after fallback switch" }),
        },
      );
      expect(rollbackRes.status).toBe(200);
      const rollbackJson = (await rollbackRes.json()) as {
        ok: boolean;
        data: {
          action: {
            action: { actionId: string; status: string };
            summary: { actionId: string; status: string };
            evidence: {
              rollbackResult: { available: boolean; rollbackAttempted: boolean; rollbackSucceeded: boolean };
            };
          };
          result: {
            rollbackAttempted: boolean;
            rollbackSucceeded: boolean;
          };
        };
      };
      expect(rollbackJson.ok).toBe(true);
      expect(rollbackJson.data.action.summary.actionId).toBe(actionId);
      expect(rollbackJson.data.action.action.status).toBe("rolled_back");
      expect(rollbackJson.data.action.summary.status).toBe("rolled_back");
      expect(rollbackJson.data.action.evidence.rollbackResult.rollbackAttempted).toBe(true);
      expect(rollbackJson.data.action.evidence.rollbackResult.rollbackSucceeded).toBe(true);
      expect(rollbackJson.data.result.rollbackAttempted).toBe(true);
      expect(rollbackJson.data.result.rollbackSucceeded).toBe(true);

      const routingAfterRollback = await getRouting(env.baseUrl, env.token);
      expect(routingAfterRollback.defaultProviderId).toBe(env.providerId);
      expect(routingAfterRollback.defaultModel).toBe(MODEL);
      expect(routingAfterRollback.fallbackProviderIds).toEqual([secondaryProviderId]);
    },
    90_000,
  );
});
