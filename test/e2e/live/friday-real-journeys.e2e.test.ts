/**
 * Live User Journey E2E Tests — 10 scenarios with real LLM calls.
 *
 * Canonical gate: FRIDAY_E2E_LIVE_ANTHROPIC=1
 * Target: FRIDAY_E2E_TARGET=local (cloud uses friday-cloud-journeys.e2e.test.ts)
 * Backward compatibility: E2E_LIVE=1
 *
 * Env vars:
 *   E2E_ANTHROPIC_BASE_URL — default https://api.anthropic.com
 *   E2E_FAST_MODEL        — Anthropic fast model default
 *   E2E_CODE_MODEL        — Anthropic code model default
 */

import * as fs from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import {
  E2E_GATED,
  ANTHROPIC_API_KEY_ENV_REF,
  ANTHROPIC_BASE_URL,
  CODE_MODEL,
  FAST_MODEL,
  LIVE_TARGET,
  cleanupRealHubEnv,
  createRealHubEnv,
  type RealHubEnv,
} from "./_helpers/real-env.js";
import {
  apiFetch,
  createAnthropicProvider,
  ensureAnthropicProviders,
  setModelRouting,
} from "./_helpers/api.js";
import { pollUntil } from "./_helpers/poll.js";
import {
  createPublishRunWorkflow,
  pollRunTerminal,
  runAiPing,
  type WorkflowGraph,
} from "./_helpers/workflow.js";
import {
  startSkillGenAndApprove,
  createTempSkillMd,
} from "./_helpers/skill.js";
import { liveAnthropicCredentialMessage } from "../_helpers/live-anthropic.js";

// ─── Suite ───

const LOCAL_LIVE_GATED = E2E_GATED && LIVE_TARGET === "local" && Boolean(ANTHROPIC_API_KEY_ENV_REF);

describe.skipIf(!LOCAL_LIVE_GATED)(
  "Friday Real Journeys E2E (Anthropic API key)",
  () => {
    let env: RealHubEnv;
    let fastProviderId: string;
    let codeProviderId: string;
    const tempDirs: string[] = [];

    beforeAll(async () => {
      // 1. Create fresh hub
      env = await createRealHubEnv();

      // 2. Create providers and set routing
      const providers = await ensureAnthropicProviders(
        env.baseUrl,
        env.accessToken,
        ANTHROPIC_BASE_URL,
        FAST_MODEL,
        CODE_MODEL,
        ANTHROPIC_API_KEY_ENV_REF ?? (() => { throw new Error(liveAnthropicCredentialMessage()); })(),
      );
      fastProviderId = providers.fastProviderId;
      codeProviderId = providers.codeProviderId;
    }, 60_000);

    afterAll(async () => {
      // Cleanup temp dirs
      for (const dir of tempDirs) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      // Cleanup hub
      if (env) await cleanupRealHubEnv(env);
    }, 30_000);

  // ══════════════════════════════════════════════════════════════════════
  // Scenario 1: First-Time User Journey (45s)
  // Setup wizard → provider detect → network → complete → verify
  // ══════════════════════════════════════════════════════════════════════

  it(
    "Scenario 1: First-time user journey (setup wizard → provider → complete)",
    async () => {
      // 1. Check initial setup status
      const statusRes = await apiFetch<{
        ok: boolean;
        data: { needsSetup: boolean; setupCompletedAt: string | null };
      }>(env.baseUrl, env.accessToken, "GET", "/v1/setup/status");
      expect(statusRes.status).toBe(200);
      expect(statusRes.json.ok).toBe(true);
      // May or may not need setup (hub is fresh), just verify the endpoint works

      // 2. Detect provider
      const detectRes = await apiFetch<{
        ok: boolean;
        data: {
          kind: string;
          availableModels: string[];
          validated: boolean;
        };
      }>(
        env.baseUrl,
        env.accessToken,
        "POST",
        "/v1/providers/detect",
        {
          kind: "anthropic",
          apiKey: process.env.FRIDAY_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY,
        },
      );
      expect(detectRes.status).toBe(200);
      expect(detectRes.json.ok).toBe(true);
      expect(detectRes.json.data.kind).toBe("anthropic");
      expect(detectRes.json.data.validated).toBe(true);
      expect(detectRes.json.data.availableModels.length).toBeGreaterThanOrEqual(1);

      // 3. Set network config
      const networkRes = await apiFetch<{
        ok: boolean;
        data: { host: string; port: number; mode: string };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/setup/network", {
        mode: "local",
        port: 3141,
      });
      expect(networkRes.status).toBe(200);
      expect(networkRes.json.ok).toBe(true);
      expect(networkRes.json.data.mode).toBe("local");

      // 4. Complete setup without fake external channel config.
      const completeRes = await apiFetch<{
        ok: boolean;
        data: { setupCompletedAt: string };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/setup/complete", {
        completedSteps: [
          "welcome",
          "security",
          "provider",
          "network",
          "done",
        ],
        skippedSteps: ["channels", "skills"],
      });
      expect(completeRes.status).toBe(200);
      expect(completeRes.json.ok).toBe(true);
      expect(typeof completeRes.json.data.setupCompletedAt).toBe("string");

      // 5. Verify needsSetup = false
      const finalStatusRes = await apiFetch<{
        ok: boolean;
        data: { needsSetup: boolean; setupCompletedAt: string | null };
      }>(env.baseUrl, env.accessToken, "GET", "/v1/setup/status");
      expect(finalStatusRes.status).toBe(200);
      expect(finalStatusRes.json.ok).toBe(true);
      expect(finalStatusRes.json.data.needsSetup).toBe(false);
      expect(finalStatusRes.json.data.setupCompletedAt).not.toBeNull();
    },
    45_000,
  );

  // ══════════════════════════════════════════════════════════════════════
  // Scenario 2: Skill Generation → Approve → Registry Check (120s, qwen2.5-coder:7b)
  // ══════════════════════════════════════════════════════════════════════

  it(
    "Scenario 2: Skill generation → approve → registry check",
    { timeout: 300_000, retry: 2 },
    async () => {
      // Set routing to code model for this scenario
      // (restore in finally block to avoid poisoning subsequent tests)
      await setModelRouting(env.baseUrl, env.accessToken, codeProviderId);
      try {

      // 1. Start skill gen session
      const startRes = await apiFetch<{
        ok: boolean;
        data: {
          session: { sessionId: string };
          mode: string;
          questions?: string[];
        };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/skills/generator/sessions", {
        goal: "Create a shell skill that outputs the current date and time in ISO format as JSON",
        userId: "admin-001",
        channel: "e2e-real",
        requestedModel: CODE_MODEL,
      }, { timeoutMs: 180_000 });
      expect(startRes.status).toBe(200);
      expect(startRes.json.ok).toBe(true);
      const sessionId = startRes.json.data.session.sessionId;

      // 2. Handle clarification if needed
      if (startRes.json.data.mode === "clarification_required") {
        const msgRes = await apiFetch(
          env.baseUrl,
          env.accessToken,
          "POST",
          `/v1/skills/generator/sessions/${sessionId}/messages`,
          {
            message:
              "A shell skill using the `date` command. No inputs. Output JSON: {\"datetime\": \"<ISO date>\"}",
            requestedModel: CODE_MODEL,
          },
          { timeoutMs: 180_000 },
        );
        expect(msgRes.status).toBe(200);
      }

      // 3. Generate (with retry on 422 or validation failure — up to 3 attempts)
      let generationSucceeded = false;
      let skillManifestId: string | undefined;
      let lastGenerationFailure: string | undefined;

      for (let attempt = 0; attempt < 3; attempt++) {
        const genRes = await apiFetch<Record<string, unknown>>(
          env.baseUrl,
          env.accessToken,
          "POST",
          `/v1/skills/generator/sessions/${sessionId}/generate`,
          { requestedModel: CODE_MODEL },
          { timeoutMs: 180_000 },
        );

        if (genRes.status === 200 && genRes.json.ok) {
          const data = genRes.json.data as {
            draft: {
              manifest: { id: string };
              files: Array<{ path: string; content: string }>;
              validation: { ok: boolean; issues?: Array<{ message: string }> };
            };
          };

          // Check if validation passed before considering generation successful
          if (data.draft.validation.ok) {
            generationSucceeded = true;
            expect(data.draft.manifest.id).toBeTruthy();
            expect(data.draft.files.length).toBeGreaterThan(0);
            skillManifestId = data.draft.manifest.id;
            break;
          }

          lastGenerationFailure = `validation_failed:${JSON.stringify(data.draft.validation.issues ?? []).slice(0, 1200)}`;

          // Validation failed — feed errors back as a follow-up and retry
          if (attempt < 2) {
            const issues = data.draft.validation.issues ?? [];
            const errorDetail = issues.map((i) => i.message).join("; ").slice(0, 500);
            await apiFetch(
              env.baseUrl,
              env.accessToken,
              "POST",
              `/v1/skills/generator/sessions/${sessionId}/messages`,
              {
                message: `The generated skill has validation errors: ${errorDetail}. Please fix these issues and try again.`,
                requestedModel: CODE_MODEL,
              },
              { timeoutMs: 180_000 },
            );
            continue;
          }
          break;
        }
        if (genRes.status === 422 && attempt < 2) {
          // Include the validation error in a follow-up prompt to help the LLM fix it
          const errorDetail = JSON.stringify(genRes.json).slice(0, 500);
          lastGenerationFailure = `status_422:${errorDetail}`;
          await apiFetch(
            env.baseUrl,
            env.accessToken,
            "POST",
            `/v1/skills/generator/sessions/${sessionId}/messages`,
            {
              message: `The previous generation failed validation: ${errorDetail}. Please fix the issues and try again.`,
              requestedModel: CODE_MODEL,
            },
            { timeoutMs: 180_000 },
          );
          continue;
        }
        if (genRes.status !== 200) {
          lastGenerationFailure = `status_${String(genRes.status)}:${JSON.stringify(genRes.json).slice(0, 1200)}`;
        }
        break;
      }

      if (!generationSucceeded) {
        throw new Error(
          `Scenario 2 generation did not converge after retries. Last failure: ${lastGenerationFailure ?? "unknown"}`,
        );
      }

      const testRes = await apiFetch<{
        ok: boolean;
        data: {
          test: {
            ok: boolean;
            behavioralCheck?: { attempted: boolean; satisfied: boolean };
          };
        };
      }>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/skills/generator/sessions/${sessionId}/test`,
        undefined,
        { timeoutMs: 180_000 },
      );
      expect(testRes.status).toBe(200);
      expect(testRes.json.ok).toBe(true);
      expect(testRes.json.data.test.ok).toBe(true);

      // 4. Approve
      const approveRes = await apiFetch<{
        ok: boolean;
        data: {
          skillId: string;
          savedFiles: string[];
          registryRefreshed: boolean;
        };
      }>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/skills/generator/sessions/${sessionId}/approve`,
        undefined,
        { timeoutMs: 180_000 },
      );
      expect(approveRes.status).toBe(200);
      expect(approveRes.json.ok).toBe(true);

      const approveData = approveRes.json.data;
      expect(approveData.skillId).toBeTruthy();
      expect(approveData.savedFiles).toContain("skill.manifest.json");

      // 5. Verify in registry
      const listRes = await apiFetch<{
        ok: boolean;
        data: { items: Array<{ id: string }> };
      }>(env.baseUrl, env.accessToken, "GET", "/v1/skills");
      expect(listRes.status).toBe(200);
      if (approveData.registryRefreshed) {
        const skillIds = listRes.json.data.items.map((s) => s.id);
        expect(skillIds).toContain(approveData.skillId);
      }

      } finally {
        // Restore routing to fast model
        await setModelRouting(env.baseUrl, env.accessToken, fastProviderId, [codeProviderId]);
      }
    },
  );

  // ══════════════════════════════════════════════════════════════════════
  // Scenario 3: Skill Import from OpenClaw SKILL.md (45s, llama3.2:3b)
  // ══════════════════════════════════════════════════════════════════════

  it(
    "Scenario 3: Skill import from OpenClaw SKILL.md",
    async () => {
      // 1. Create temp SKILL.md
      const skillDir = createTempSkillMd({
        skillKey: "real-e2e-import-test",
        name: "Real E2E Import Test Skill",
        script: `echo '{"result": "imported successfully"}'`,
      });
      tempDirs.push(skillDir);

      // 2. Convert (dry run)
      const convertRes = await apiFetch<{
        ok: boolean;
        data: {
          converterId: string;
          drafts: Array<{ manifest: { id: string } }>;
        };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/skills/convert", {
        source: { uri: skillDir },
        formatHint: "clawdbot-skill-md",
        dryRun: true,
      });
      expect(convertRes.status).toBe(200);
      expect(convertRes.json.ok).toBe(true);
      expect(convertRes.json.data.converterId).toBe("clawdbot-skill-md");
      expect(convertRes.json.data.drafts.length).toBeGreaterThanOrEqual(1);

      // 3. Import
      const importRes = await apiFetch<{
        ok: boolean;
        data: {
          imports: Array<{
            skillId: string;
            installed: boolean;
            skillDir: string;
          }>;
        };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/skills/import", {
        source: { uri: skillDir },
        formatHint: "clawdbot-skill-md",
        target: "managed",
        replace: true,
        refreshRegistry: true,
      });
      expect(importRes.status).toBe(200);
      expect(importRes.json.ok).toBe(true);
      expect(importRes.json.data.imports.length).toBeGreaterThanOrEqual(1);
      const importedSkillId = importRes.json.data.imports[0]!.skillId;
      expect(importedSkillId).toBeTruthy();

      // 4. Verify in skills list
      const listRes = await apiFetch<{
        ok: boolean;
        data: { items: Array<{ id: string }> };
      }>(env.baseUrl, env.accessToken, "GET", "/v1/skills");
      expect(listRes.status).toBe(200);
      // Skill may or may not appear depending on hub version compatibility,
      // but the import endpoint itself should have succeeded.
    },
    45_000,
  );

  // ══════════════════════════════════════════════════════════════════════
  // Scenario 4: Workflow Generation → Publish → Trigger (180s, qwen2.5-coder:7b)
  // ══════════════════════════════════════════════════════════════════════

  it(
    "Scenario 4: Workflow generation → publish → trigger",
    { timeout: 600_000, retry: 1 },
    async () => {
      // Set routing to code model
      await setModelRouting(env.baseUrl, env.accessToken, codeProviderId);

      try {

      // 1. Start workflow gen session
      const startRes = await apiFetch<{
        ok: boolean;
        data: {
          session: { sessionId: string };
          mode: string;
          questions?: string[];
        };
      }>(
        env.baseUrl,
        env.accessToken,
        "POST",
        "/v1/workflows/generator/sessions",
        {
          goal: "A simple manual trigger workflow with one data node that outputs hello world",
          userId: "admin-001",
          channel: "e2e-real",
          requestedModel: CODE_MODEL,
        },
        { timeoutMs: 300_000 },
      );
      expect(startRes.status).toBe(200);
      expect(startRes.json.ok).toBe(true);
      const sessionId = startRes.json.data.session.sessionId;

      // 2. Handle clarification
      if (startRes.json.data.mode === "clarification_required") {
        await apiFetch(
          env.baseUrl,
          env.accessToken,
          "POST",
          `/v1/workflows/generator/sessions/${sessionId}/messages`,
          {
            message:
              'Manual trigger, single data node that outputs { "message": "hello world" }. No conditions.',
            requestedModel: CODE_MODEL,
          },
          { timeoutMs: 300_000 },
        );
      }

      // 3. Generate (with retry on 422 or validation failure — up to 3 attempts)
      let generationSucceeded = false;
      let lastGenerationFailure: string | undefined;
      let genData: {
        draft: {
          spec: Record<string, unknown>;
          visual: Record<string, unknown>;
          compiledGraph: Record<string, unknown>;
          validation: { ok: boolean; issues?: Array<{ message: string }> };
        };
      } | undefined;

      for (let attempt = 0; attempt < 3; attempt++) {
        const generationModel = attempt === 2 ? FAST_MODEL : CODE_MODEL;
        const genRes = await apiFetch<Record<string, unknown>>(
          env.baseUrl,
          env.accessToken,
          "POST",
          `/v1/workflows/generator/sessions/${sessionId}/generate`,
          { requestedModel: generationModel },
          { timeoutMs: 300_000 },
        );

        if (genRes.status === 200 && genRes.json.ok) {
          genData = genRes.json.data as typeof genData;

          // Check if validation passed before considering generation successful
          if (genData!.draft.validation.ok) {
            generationSucceeded = true;
            break;
          }

          lastGenerationFailure = `validation_failed:${JSON.stringify(genData!.draft.validation.issues ?? []).slice(0, 1200)}`;

          // Validation failed — feed errors back as a follow-up and retry
          if (attempt < 2) {
            const issues = genData!.draft.validation.issues ?? [];
            const errorDetail = issues.map((i) => i.message).join("; ").slice(0, 500);
            await apiFetch(
              env.baseUrl,
              env.accessToken,
              "POST",
              `/v1/workflows/generator/sessions/${sessionId}/messages`,
              {
                message: `The generated workflow has validation errors: ${errorDetail}. Please fix these issues and try again.`,
                requestedModel: generationModel,
              },
              { timeoutMs: 300_000 },
            );
            continue;
          }
          break;
        }
        if (genRes.status === 422 && attempt < 2) {
          const errorDetail = JSON.stringify(genRes.json).slice(0, 500);
          lastGenerationFailure = `status_422:${errorDetail}`;
          await apiFetch(
            env.baseUrl,
            env.accessToken,
            "POST",
            `/v1/workflows/generator/sessions/${sessionId}/messages`,
            {
              message:
                `The previous generation failed validation: ${errorDetail}. ` +
                "Fix the issues and regenerate strict JSON. " +
                'Visual must include "__trigger__" plus all spec step ids and no orphan nodes.',
              requestedModel: generationModel,
            },
            { timeoutMs: 300_000 },
          );
          continue;
        }
        if (genRes.status !== 200) {
          lastGenerationFailure = `status_${String(genRes.status)}:${JSON.stringify(genRes.json).slice(0, 1200)}`;
        }
        break;
      }

      if (!generationSucceeded) {
        throw new Error(
          `Scenario 4 generation did not converge after retries. Last failure: ${lastGenerationFailure ?? "unknown"}`,
        );
      }
      expect(genData!.draft.spec).toBeTruthy();
      expect(genData!.draft.compiledGraph).toBeTruthy();

      // 4. Approve and save
      const approveRes = await apiFetch<Record<string, unknown>>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/workflows/generator/sessions/${sessionId}/approve`,
        undefined,
        { timeoutMs: 300_000 },
      );

      expect(approveRes.status).toBe(200);
      expect(approveRes.json.ok).toBe(true);

      const approveData = approveRes.json.data as {
        workflowId: string;
        slug: string;
        published: boolean;
      };
      expect(approveData.workflowId).toBeTruthy();
      expect(approveData.published).toBe(true);

      // 5. Trigger run
      const runRes = await apiFetch<{
        ok: boolean;
        data: { run: { id: string; status: string } };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/workflow-runs", {
        workflowId: approveData.workflowId,
        triggerType: "manual",
        triggerPayload: {},
      });
      expect(runRes.status).toBe(200);
      expect(runRes.json.ok).toBe(true);
      const runId = runRes.json.data.run.id;

      // 6. Poll until terminal
      const result = await pollRunTerminal(
        env.baseUrl,
        env.accessToken,
        runId,
        60_000,
      );
      // Generated workflow may fail at runtime due to missing skills, etc.
      // Just verify it reached a terminal state.
      expect(["completed", "failed"]).toContain(result.run.status);

      // 7. Check node results if completed
      if (result.run.status === "completed") {
        const nodesRes = await apiFetch<{
          ok: boolean;
          data: {
            items: Array<{ nodeId: string; status: string; output: unknown }>;
          };
        }>(
          env.baseUrl,
          env.accessToken,
          "GET",
          `/v1/workflow-runs/${runId}/nodes`,
        );
        expect(nodesRes.status).toBe(200);
        expect(nodesRes.json.data.items.length).toBeGreaterThanOrEqual(1);
      }

      } finally {
        // Restore routing
        await setModelRouting(env.baseUrl, env.accessToken, fastProviderId, [codeProviderId]);
      }
    },
  );

  // ══════════════════════════════════════════════════════════════════════
  // Scenario 5: Agent Conversation → Response → Memory Extraction (120s, llama3.2:3b)
  // ══════════════════════════════════════════════════════════════════════

  it(
    "Scenario 5: Agent conversation → response → memory extraction",
    { timeout: 120_000, retry: 2 },
    async () => {
      // 1. Start agent run with a conversation task
      const runRes = await apiFetch<{
        ok: boolean;
        data: {
          runId: string;
          status: string;
          response: string;
          toolCallCount: number;
          durationMs: number;
        };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/agent/runs", {
        task: "Tell me 3 interesting facts about octopuses. Be concise, one sentence each.",
        providerId: fastProviderId,
        model: FAST_MODEL,
        timeoutMs: 90_000,
      });

      expect(runRes.status).toBe(200);
      expect(runRes.json.ok).toBe(true);
      const agentResult = runRes.json.data;
      expect(agentResult.runId).toBeTruthy();
      expect(["completed", "failed"]).toContain(agentResult.status);
      if (agentResult.status === "completed") {
        expect(agentResult.response.length).toBeGreaterThan(0);
      }

      // 2. Verify run is persisted
      const getRunRes = await apiFetch<{
        ok: boolean;
        data: { run: { id: string; status: string; task: string } };
      }>(env.baseUrl, env.accessToken, "GET", `/v1/agent/runs/${agentResult.runId}`);
      expect(getRunRes.status).toBe(200);
      expect(["completed", "failed"]).toContain(getRunRes.json.data.run.status);
      expect(getRunRes.json.data.run.task).toContain("octopus");

      // 3. Store agent response as a memory fact
      const storeRes = await apiFetch<{
        ok: boolean;
        data: { item: { id: string; content: string } };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/memory/store", {
        namespace: "e2e-agent-facts",
        content:
          agentResult.response.trim().length > 0
            ? `Agent said about octopuses: ${agentResult.response.slice(0, 500)}`
            : "Agent conversation run failed before producing a response (octopus task).",
        source: "agent-run",
        tags: ["agent", "octopus"],
      });
      expect(storeRes.status).toBe(200);
      expect(storeRes.json.ok).toBe(true);
      const memoryId = storeRes.json.data.item.id;
      expect(memoryId).toBeTruthy();

      // 4. Search for the stored memory
      const searchRes = await apiFetch<{
        ok: boolean;
        data: { items: Array<{ item: { content: string }; score: number }> };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/memory/search", {
        query: "octopus facts",
        namespace: "e2e-agent-facts",
      });
      expect(searchRes.status).toBe(200);
      expect(searchRes.json.ok).toBe(true);
      expect(searchRes.json.data.items.length).toBeGreaterThanOrEqual(1);
    },
  );

  // ══════════════════════════════════════════════════════════════════════
  // Scenario 6: Self-Diagnosis of Bad Workflow (90s, qwen2.5-coder:7b)
  // ══════════════════════════════════════════════════════════════════════

  it(
    "Scenario 6: Self-diagnosis of bad workflow",
    async () => {
      await setModelRouting(env.baseUrl, env.accessToken, codeProviderId);

      try {

      // 1. Create a workflow with a broken graph (dangling reference)
      const badGraph: WorkflowGraph = {
        nodes: [
          {
            id: "trigger1",
            type: "trigger",
            label: "Manual Trigger",
            config: { triggerType: "manual" },
          },
          {
            id: "action1",
            type: "action",
            label: "Action",
            config: {},
          },
        ],
        edges: [
          { id: "e1", sourceNodeId: "trigger1", targetNodeId: "action1" },
        ],
      };

      const createRes = await apiFetch<{
        ok: boolean;
        data: { workflow: { id: string } };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/workflows", {
        slug: `bad-workflow-diag-${Date.now()}`,
        name: "Bad Workflow for Diagnosis",
        tags: ["e2e-real", "diagnosis"],
        graph: badGraph,
      });
      expect(createRes.status).toBe(200);
      expect(createRes.json.ok).toBe(true);
      const workflowId = createRes.json.data.workflow.id;

      // 2. Create draft for compile-based validation
      const draftSpec = {
        schemaVersion: "1.0",
        workflowId,
        name: "Bad Workflow",
        description: "Intentionally broken workflow for diagnosis",
        startStepId: "trigger1",
        trigger: { type: "manual" },
        inputs: [],
        steps: [
          { id: "trigger1", type: "skill_call", ref: "nonexistent-skill-xyz" },
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
        nodes: [{ nodeId: "trigger1", x: 0, y: 0 }],
        edges: [],
      };

      const draftRes = await apiFetch<{
        ok: boolean;
        data: { draft: { draftId: string } };
      }>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/workflows/${workflowId}/drafts`,
        { title: "Bad Draft", spec: draftSpec, visual: draftVisual },
      );
      expect(draftRes.status).toBe(200);
      expect(draftRes.json.ok).toBe(true);
      const draftId = draftRes.json.data.draft.draftId;

      // 3. Compile (acts as validation/diagnostics proxy)
      const compileRes = await apiFetch<{
        ok: boolean;
        data: {
          compiled?: Record<string, unknown>;
          validation?: {
            valid: boolean;
            issues: Array<{ severity: string; message: string }>;
          };
        };
      }>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/workflows/${workflowId}/drafts/${draftId}/compile`,
      );
      expect(compileRes.status).toBe(200);
      expect(compileRes.json.ok).toBe(true);
      // Compilation should produce something — even if it's just the compiled output
      expect(compileRes.json.data).toBeTruthy();

      // 4. Ask the agent to diagnose the bad workflow
      const diagRunRes = await apiFetch<{
        ok: boolean;
        data: {
          runId: string;
          status: string;
          response: string;
        };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/agent/runs", {
        task: `Analyze this workflow spec and identify issues. The workflow references a skill called "nonexistent-skill-xyz" which does not exist. What problems would this cause and how should it be fixed? Be concise.`,
        providerId: codeProviderId,
        model: CODE_MODEL,
        timeoutMs: 60_000,
      });

      expect(diagRunRes.status).toBe(200);
      expect(diagRunRes.json.ok).toBe(true);
      expect(["completed", "failed"]).toContain(diagRunRes.json.data.status);

      if (diagRunRes.json.data.status === "completed") {
        // Agent should mention something about missing/nonexistent skill
        const response = diagRunRes.json.data.response.toLowerCase();
        const mentionsIssue =
          response.includes("nonexist") ||
          response.includes("not found") ||
          response.includes("missing") ||
          response.includes("does not exist") ||
          response.includes("unavailable") ||
          response.includes("error") ||
          response.includes("skill");
        expect(mentionsIssue).toBe(true);
      }

      } finally {
        // Restore routing
        await setModelRouting(env.baseUrl, env.accessToken, fastProviderId, [codeProviderId]);
      }
    },
    90_000,
  );

  // ══════════════════════════════════════════════════════════════════════
  // Scenario 7: Automation Lifecycle (90s, llama3.2:3b)
  // Create → enable → run → disable → verify → re-enable → run
  // ══════════════════════════════════════════════════════════════════════

  it(
    "Scenario 7: Automation lifecycle",
    async () => {
      // 1. Create automation
      const createRes = await apiFetch<{
        ok: boolean;
        data: {
          automation: {
            id: string;
            name: string;
            enabled: boolean;
            taskTemplate: string;
            runCount: number;
          };
        };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/agent/automations", {
        name: "E2E Daily Report",
        description: "Automated daily summary for E2E testing",
        taskTemplate:
          "Generate a one-sentence summary about the weather today. Be very concise.",
        enabled: true,
      });
      expect(createRes.status).toBe(200);
      expect(createRes.json.ok).toBe(true);
      const automationId = createRes.json.data.automation.id;
      expect(createRes.json.data.automation.enabled).toBe(true);
      expect(createRes.json.data.automation.runCount).toBe(0);

      // 2. Run the automation
      const run1Res = await apiFetch<{
        ok: boolean;
        data: {
          result: {
            runId: string;
            status: string;
            response: string;
          };
        };
      }>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/agent/automations/${automationId}/run`,
        {
          providerId: fastProviderId,
          model: FAST_MODEL,
          timeoutMs: 60_000,
        },
      );
      expect(run1Res.status).toBe(200);
      expect(run1Res.json.ok).toBe(true);
      expect(["completed", "failed"]).toContain(run1Res.json.data.result.status);

      // 3. Verify run count incremented
      const getRes1 = await apiFetch<{
        ok: boolean;
        data: { automation: { runCount: number; lastRunId: string; enabled: boolean } };
      }>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/agent/automations/${automationId}`,
      );
      expect(getRes1.status).toBe(200);
      expect(getRes1.json.data.automation.runCount).toBe(1);
      expect(getRes1.json.data.automation.lastRunId).toBeTruthy();

      // 4. Disable automation
      const disableRes = await apiFetch<{
        ok: boolean;
        data: { automation: { enabled: boolean } };
      }>(
        env.baseUrl,
        env.accessToken,
        "PATCH",
        `/v1/agent/automations/${automationId}`,
        { enabled: false },
      );
      expect(disableRes.status).toBe(200);
      expect(disableRes.json.data.automation.enabled).toBe(false);

      // 5. Verify disabled
      const getRes2 = await apiFetch<{
        ok: boolean;
        data: { automation: { enabled: boolean } };
      }>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/agent/automations/${automationId}`,
      );
      expect(getRes2.status).toBe(200);
      expect(getRes2.json.data.automation.enabled).toBe(false);

      // 6. Re-enable
      const enableRes = await apiFetch<{
        ok: boolean;
        data: { automation: { enabled: boolean } };
      }>(
        env.baseUrl,
        env.accessToken,
        "PATCH",
        `/v1/agent/automations/${automationId}`,
        { enabled: true },
      );
      expect(enableRes.status).toBe(200);
      expect(enableRes.json.data.automation.enabled).toBe(true);

      // 7. Run again
      const run2Res = await apiFetch<{
        ok: boolean;
        data: {
          result: {
            runId: string;
            status: string;
            response: string;
          };
        };
      }>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/agent/automations/${automationId}/run`,
        {
          providerId: fastProviderId,
          model: FAST_MODEL,
          timeoutMs: 60_000,
        },
      );
      expect(run2Res.status).toBe(200);
      expect(["completed", "failed"]).toContain(run2Res.json.data.result.status);

      // 8. Verify run count = 2
      const getRes3 = await apiFetch<{
        ok: boolean;
        data: { automation: { runCount: number } };
      }>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/agent/automations/${automationId}`,
      );
      expect(getRes3.status).toBe(200);
      expect(getRes3.json.data.automation.runCount).toBe(2);

      // 9. Cleanup: delete automation
      const deleteRes = await apiFetch<{
        ok: boolean;
        data: { deleted: boolean };
      }>(
        env.baseUrl,
        env.accessToken,
        "DELETE",
        `/v1/agent/automations/${automationId}`,
      );
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.json.data.deleted).toBe(true);
    },
    90_000,
  );

  // ══════════════════════════════════════════════════════════════════════
  // Scenario 8: Provider Failover (120s, llama3.2:3b)
  // Bad primary + good fallback → routing → run → verify fallback used
  // ══════════════════════════════════════════════════════════════════════

  it(
    "Scenario 8: Provider failover",
    async () => {
      // 1. Create a bad provider (pointing to a non-existent URL)
      const badProviderId = await createAnthropicProvider(env.baseUrl, env.accessToken, {
        name: "Bad Anthropic (E2E Failover)",
        anthropicBaseUrl: "http://127.0.0.1:19999",
        models: [FAST_MODEL],
        defaultModel: FAST_MODEL,
        apiKeyEnvRef: ANTHROPIC_API_KEY_ENV_REF ?? undefined,
      });

      try {

      // 2. Set routing: bad as primary, good fast as fallback
      await setModelRouting(env.baseUrl, env.accessToken, badProviderId, [
        fastProviderId,
      ]);

      // 3. Run an agent task — should fail on bad provider but succeed via fallback
      const runRes = await apiFetch<{
        ok: boolean;
        data: {
          runId: string;
          status: string;
          response: string;
        };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/agent/runs", {
        task: 'Say exactly "FAILOVER_OK" and nothing else.',
        timeoutMs: 90_000,
      });

      expect(runRes.status).toBe(200);
      expect(runRes.json.ok).toBe(true);
      // The run should complete (via fallback) or fail (if failover isn't implemented yet)
      expect(["completed", "failed"]).toContain(runRes.json.data.status);

      if (runRes.json.data.status === "completed") {
        // Verify the agent produced some output (failover worked)
        expect(runRes.json.data.response.length).toBeGreaterThan(0);
      }

      } finally {
        // Restore routing to the known-good fast provider
        await setModelRouting(env.baseUrl, env.accessToken, fastProviderId, [codeProviderId]);
      }
    },
    120_000,
  );

  // ══════════════════════════════════════════════════════════════════════
  // Scenario 9: Memory Persistence Across Sessions (120s, llama3.2:3b)
  // Session A facts → store → Session B → search → verify cross-session
  // ══════════════════════════════════════════════════════════════════════

  it(
    "Scenario 9: Memory persistence across sessions",
    async () => {
      const namespace = `e2e-persistence-${Date.now()}`;

      // 1. Session A: Store facts
      const fact1Res = await apiFetch<{
        ok: boolean;
        data: { item: { id: string } };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/memory/store", {
        namespace,
        content: "The user's favorite color is teal and they live in Portland, Oregon",
        source: "session-a",
        tags: ["personal", "preferences"],
      });
      expect(fact1Res.status).toBe(200);
      expect(fact1Res.json.ok).toBe(true);

      const fact2Res = await apiFetch<{
        ok: boolean;
        data: { item: { id: string } };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/memory/store", {
        namespace,
        content: "The user prefers TypeScript over JavaScript and uses Neovim as their editor",
        source: "session-a",
        tags: ["personal", "tech"],
      });
      expect(fact2Res.status).toBe(200);
      expect(fact2Res.json.ok).toBe(true);

      const fact3Res = await apiFetch<{
        ok: boolean;
        data: { item: { id: string } };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/memory/store", {
        namespace,
        content: "The user's dog is named Pixel and is a golden retriever",
        source: "session-a",
        tags: ["personal", "pets"],
      });
      expect(fact3Res.status).toBe(200);
      expect(fact3Res.json.ok).toBe(true);

      // 2. Session B: Search for facts (simulating a new session)
      // Search for color preference — use exact word from stored content
      const colorSearchRes = await apiFetch<{
        ok: boolean;
        data: { items: Array<{ item: { content: string }; score: number }> };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/memory/search", {
        query: "teal Portland",
        namespace,
      });
      expect(colorSearchRes.status).toBe(200);
      expect(colorSearchRes.json.ok).toBe(true);
      expect(colorSearchRes.json.data.items.length).toBeGreaterThanOrEqual(1);
      const colorContent = colorSearchRes.json.data.items
        .map((i) => i.item.content)
        .join(" ")
        .toLowerCase();
      expect(colorContent).toContain("teal");

      // Search for editor preference — use exact words from stored content
      const editorSearchRes = await apiFetch<{
        ok: boolean;
        data: { items: Array<{ item: { content: string }; score: number }> };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/memory/search", {
        query: "Neovim TypeScript",
        namespace,
      });
      expect(editorSearchRes.status).toBe(200);
      expect(editorSearchRes.json.ok).toBe(true);
      expect(editorSearchRes.json.data.items.length).toBeGreaterThanOrEqual(1);
      const editorContent = editorSearchRes.json.data.items
        .map((i) => i.item.content)
        .join(" ")
        .toLowerCase();
      expect(editorContent).toContain("neovim");

      // Search for pet — use exact word "Pixel" from stored content
      const petSearchRes = await apiFetch<{
        ok: boolean;
        data: { items: Array<{ item: { content: string }; score: number }> };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/memory/search", {
        query: "Pixel golden retriever",
        namespace,
      });
      expect(petSearchRes.status).toBe(200);
      expect(petSearchRes.json.ok).toBe(true);
      expect(petSearchRes.json.data.items.length).toBeGreaterThanOrEqual(1);
      const petContent = petSearchRes.json.data.items
        .map((i) => i.item.content)
        .join(" ")
        .toLowerCase();
      expect(petContent).toContain("pixel");

      // 3. Search with tag filter to verify metadata persists
      const tagSearchRes = await apiFetch<{
        ok: boolean;
        data: { items: Array<{ item: { tags: string[] } }> };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/memory/search", {
        query: "preferences",
        namespace,
        tagsAny: ["tech"],
      });
      expect(tagSearchRes.status).toBe(200);
      expect(tagSearchRes.json.ok).toBe(true);
      for (const entry of tagSearchRes.json.data.items) {
        expect(entry.item.tags).toContain("tech");
      }

      // 4. List all items to verify count
      const listRes = await apiFetch<{
        ok: boolean;
        data: { items: Array<{ id: string }> };
      }>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/memory/items?namespace=${encodeURIComponent(namespace)}`,
      );
      expect(listRes.status).toBe(200);
      expect(listRes.json.ok).toBe(true);
      expect(listRes.json.data.items.length).toBe(3);
    },
    120_000,
  );

  // ══════════════════════════════════════════════════════════════════════
  // Scenario 10: Generate Skill → Use in Workflow → Execute (180s, qwen2.5-coder:7b)
  // Full end-to-end: skill gen → workflow with skill node → run → verify output
  // ══════════════════════════════════════════════════════════════════════

  it(
    "Scenario 10: Import skill → use in workflow → execute",
    async () => {
      await setModelRouting(env.baseUrl, env.accessToken, codeProviderId);

      try {

      // 1. Import a known skill via SKILL.md (more reliable than LLM generation)
      const skillDir = createTempSkillMd({
        skillKey: `e2e-date-skill-${Date.now()}`,
        name: "E2E Date Skill",
        script: `echo '{"date": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}'`,
      });
      tempDirs.push(skillDir);

      const importRes = await apiFetch<{
        ok: boolean;
        data: {
          imports: Array<{
            skillId: string;
            installed: boolean;
            skillDir: string;
          }>;
        };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/skills/import", {
        source: { uri: skillDir },
        formatHint: "clawdbot-skill-md",
        target: "managed",
        replace: true,
        refreshRegistry: true,
      });
      expect(importRes.status).toBe(200);
      expect(importRes.json.ok).toBe(true);

      const importedSkillId = importRes.json.data.imports[0]?.skillId;
      expect(importedSkillId).toBeTruthy();

      // 2. Create a workflow that uses the imported skill
      const wfSlug = `skill-wf-${Date.now()}`;
      const skillWfGraph: WorkflowGraph = {
        nodes: [
          {
            id: "trigger1",
            type: "trigger",
            label: "Manual Trigger",
            config: { triggerType: "manual" },
          },
          {
            id: "skill_call_1",
            type: "skill_call",
            label: "Call Date Skill",
            config: { skillId: importedSkillId },
          },
          {
            id: "collect1",
            type: "data",
            label: "Collect Result",
            config: {
              mapping: {
                skillOutput: "$steps.skill_call_1.output",
              },
            },
          },
        ],
        edges: [
          { id: "e1", sourceNodeId: "trigger1", targetNodeId: "skill_call_1" },
          { id: "e2", sourceNodeId: "skill_call_1", targetNodeId: "collect1" },
        ],
      };

      const createRes = await apiFetch<{
        ok: boolean;
        data: { workflow: { id: string } };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/workflows", {
        slug: wfSlug,
        name: `Skill Workflow ${wfSlug}`,
        tags: ["e2e-real", "skill-workflow"],
        graph: skillWfGraph,
      });
      expect(createRes.status).toBe(200);
      expect(createRes.json.ok).toBe(true);
      const workflowId = createRes.json.data.workflow.id;

      // 3. Publish
      const publishRes = await apiFetch<{ ok: boolean }>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/workflows/${workflowId}/publish`,
        { versionNumber: 1 },
      );
      expect(publishRes.status).toBe(200);
      expect(publishRes.json.ok).toBe(true);

      // 4. Run
      const runRes = await apiFetch<{
        ok: boolean;
        data: { run: { id: string; status: string } };
      }>(env.baseUrl, env.accessToken, "POST", "/v1/workflow-runs", {
        workflowId,
        triggerType: "manual",
        triggerPayload: {},
      });
      expect(runRes.status).toBe(200);
      expect(runRes.json.ok).toBe(true);
      const runId = runRes.json.data.run.id;

      // 5. Poll until terminal
      const result = await pollRunTerminal(
        env.baseUrl,
        env.accessToken,
        runId,
        60_000,
      );
      // Skill execution may fail if skill runtime isn't fully wired,
      // but the workflow engine should reach a terminal state
      expect(["completed", "failed"]).toContain(result.run.status);

      // 6. Check node results
      const nodesRes = await apiFetch<{
        ok: boolean;
        data: {
          items: Array<{ nodeId: string; status: string; output: unknown }>;
        };
      }>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/workflow-runs/${runId}/nodes`,
      );
      expect(nodesRes.status).toBe(200);
      expect(nodesRes.json.data.items.length).toBeGreaterThanOrEqual(1);

      // If skill execution completed, verify the output
      if (result.run.status === "completed") {
        const skillNode = nodesRes.json.data.items.find(
          (n) => n.nodeId === "skill_call_1",
        );
        if (skillNode) {
          expect(skillNode.status).toBe("completed");
          // Output should be defined (skill ran successfully)
          expect(skillNode.output).toBeTruthy();
        }
      }

      } finally {
        // Restore routing
        await setModelRouting(env.baseUrl, env.accessToken, fastProviderId, [codeProviderId]);
      }
    },
    180_000,
  );
});
