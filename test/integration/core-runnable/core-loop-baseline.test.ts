import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMockHubEnv, type MockHubEnv } from "../../e2e/mock/_helpers/mock-env.js";
import { PROVIDER_MATRIX } from "../../e2e/mock/_helpers/provider-matrix.js";

/**
 * (CORE-RUNNABLE-001 / CORE-A CR-0) RED-FIRST black-box HONESTY baseline.
 *
 * This test drives the SERVED public HTTP seam (a real `createFridayHub` + HTTP server, stood up
 * the SAME way the mock E2E tests do) on a clean, RELEASE-LIKE profile — the canonical mutation
 * gate ON and every legacy TS execution oracle OFF — and ASSERTS the current HONEST state: the
 * core public loop is RETIRED/DARK. Each core public entrypoint fail-closes with its documented
 * code rather than doing real work.
 *
 * It ENCODES the R14 CR-0 STARTING STATE (the fixed "0/7" the closure measures against): this test
 * PASSES NOW because it asserts the dark state. Later CORE-A slices FLIP these assertions to green,
 * one Rust-owned entrypoint at a time — so a future failure here is a SIGNAL that a real path has
 * landed and this baseline needs to advance, not a regression to paper over.
 */

interface ErrorEnvelope {
  ok: boolean;
  error?: { code?: string; message?: string };
}

async function apiFetch(
  env: Pick<MockHubEnv, "baseUrl" | "accessToken">,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: ErrorEnvelope }> {
  const res = await fetch(`${env.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.accessToken}`,
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json()) as ErrorEnvelope;
  return { status: res.status, json };
}

describe("CORE-A CR-0 — core loop honest baseline (retired/dark, release-like profile)", () => {
  let env: MockHubEnv;

  beforeAll(async () => {
    env = await createMockHubEnv({
      // No mock providers needed: every assertion below fail-closes BEFORE any provider call.
      providerKinds: [],
      // Release-like profile: the canonical mutation gate is ON (so provider mutations require an
      // approved plan digest) and every legacy TS execution oracle is OFF (so the retired public
      // entrypoints stay fail-closed, exactly as a stock release build).
      canonicalGate: true,
      allowTestOnlySessionExecution: false,
      allowTestOnlySessionRunExecution: false,
      allowTestOnlyAgentRunStartExecution: false,
      allowTestOnlySkillRunExecution: false,
    });
  }, 60_000);

  afterAll(async () => {
    await env?.cleanup();
  });

  it("POST /v1/sessions → 503 TS_RUNTIME_SESSION_RETIRED", async () => {
    const { status, json } = await apiFetch(env, "POST", "/v1/sessions", {
      channel: "discord",
      chatId: "core-a-baseline",
    });
    expect(status).toBe(503);
    expect(json.error?.code).toBe("TS_RUNTIME_SESSION_RETIRED");
  });

  it("POST /v1/agent/runs → 503 TS_RUNTIME_AGENT_RUNS_RETIRED", async () => {
    const { status, json } = await apiFetch(env, "POST", "/v1/agent/runs", {
      task: "hello from the core-a baseline",
    });
    expect(status).toBe(503);
    expect(json.error?.code).toBe("TS_RUNTIME_AGENT_RUNS_RETIRED");
  });

  it("POST /v1/skills/:id/run → 503 TS_RUNTIME_SKILL_RUNS_RETIRED", async () => {
    const { status, json } = await apiFetch(
      env,
      "POST",
      "/v1/skills/core-a-baseline-skill/run",
      {},
    );
    expect(status).toBe(503);
    expect(json.error?.code).toBe("TS_RUNTIME_SKILL_RUNS_RETIRED");
  });

  it("POST /v1/providers WITHOUT planDigest (canonical gate ON) → 403 PROVIDER_MUTATION_PLAN_DIGEST_REQUIRED", async () => {
    const entry = PROVIDER_MATRIX[0]!;
    // A structurally VALID create body (so validation passes and the request reaches the gate) that
    // deliberately OMITS the plan digest → the canonical gate refuses the mutation with 403.
    const { status, json } = await apiFetch(env, "POST", "/v1/providers", {
      kind: entry.kind,
      name: `CORE-A baseline ${entry.kind}`,
      baseUrl: entry.baseUrl,
      authMode: entry.authMode,
      api: entry.api,
      supportedModels: [entry.model],
      defaultModel: entry.model,
      enabled: true,
      validateOnSave: false,
      apiKey: "mock-key-for-core-a-baseline", // pragma: allowlist secret -- deterministic non-secret for the 403 probe
    });
    expect(status).toBe(403);
    expect(json.error?.code).toBe("PROVIDER_MUTATION_PLAN_DIGEST_REQUIRED");
  });
});
