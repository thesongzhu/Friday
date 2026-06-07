import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { chromium } from "playwright";

import {
  createFridayRealBrowserE2eEnv,
  type FridayBrowserPageHandle,
  type FridayRealBrowserE2eEnv,
} from "./_helpers/browser-env.js";
import {
  createFridayAgentEventEmitter,
  createFridayAgentMemoryTools,
  createFridayAgentRunEventRepository,
  createFridayAgentRuntime,
  createFridayAgentWorkflowListTool,
  createFridayAgentWorkflowTool,
  type FridayAgentLlmClient,
  type FridayAgentMessage,
  type FridayContextEngine,
} from "#agent";
import {
  createFridayApiRuntime,
  createFridayReflexRoutes,
  createFridayHttpServer,
  encodeToken,
  type FridayHttpServer,
} from "#api";
import {
  createFridayEpisodeExtractor,
  createFridayMemoryGuardServiceFactory,
  createFridayMemoryService,
  createFridayPatternExtractor,
} from "#memory";
import { createFridayProviderService } from "#providers";
import type { FridaySkillRegistry } from "#skills";
import type { FridaySqliteLayer } from "#state";
import {
  createFridayReflexCandidateRepository,
  createFridayReflexOnboardingRepository,
  createFridayReflexService,
} from "../../../src/reflex/index.js";
import { createFridayUixUserPreferenceRepository } from "../../../src/uix/persistence/friday-uix-user-preference-repository.js";
import type { ReflexCandidate, ReflexPreference } from "../../../ui/src/lib/api/reflex";
import {
  createFridayWorkflowRuntime,
  createFridayWorkflowTriggerRepository,
  type FridayCompiledWorkflowGraphV2,
} from "#workflows";
import { createTestDb, createTestIdGenerator } from "../../helpers/friday-test-db.helper.js";

const CHROMIUM_AVAILABLE = (() => {
  try {
    const pw = require("playwright") as { chromium: { executablePath: () => string } };
    return fs.existsSync(pw.chromium.executablePath());
  } catch {
    return false;
  }
})();

const DP10_DOGFOOD_NOW = "2026-05-27T05:15:00.000Z";
const DP10_DOGFOOD_AUTH_TOKEN_TEST_KEY = "dp10-dogfood-token-test-key";
const DP10_DOGFOOD_USER_ID = "dp10-dogfood-user";
const DP10_DOGFOOD_TENANT_ID = "dp10-dogfood-tenant";
const DP10_DOGFOOD_WORKFLOW_SKILL_ID = "dp10-dogfood-workflow-skill";

interface SetupCompleteResponse {
  setupCompletedAt: string;
}

interface PreferenceCandidateResponse {
  requiresConfirmation: boolean;
  candidate?: ReflexCandidate;
}

interface AuthMeResponse {
  user: {
    id: string;
    displayName: string;
    role: string;
  };
  scopes: string[];
}

interface WorkflowRunResponse {
  run: {
    id: string;
    status: string;
  };
}

interface WorkflowEvidenceResponse {
  summary: {
    totalEvents: number;
  };
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function resolveBuiltUiStaticDir(): string {
  const uiStaticDir = path.resolve(process.cwd(), "dist/ui");
  const indexPath = path.join(uiStaticDir, "index.html");
  if (!fs.existsSync(indexPath)) {
    throw new Error(`Built UI not found at ${indexPath}. Run "npm run build:ui" before this browser proof.`);
  }
  return uiStaticDir;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close();
      if (!addr || typeof addr === "string") {
        reject(new Error("No free port"));
        return;
      }
      resolve(addr.port);
    });
    srv.on("error", reject);
  });
}

function dp10DogfoodAuthHeaders(): Record<string, string> {
  const nowSec = Math.floor(Date.parse(DP10_DOGFOOD_NOW) / 1000);
  const token = encodeToken(
    {
      tokenId: "dp10-dogfood-token",
      principalType: "user",
      principalId: DP10_DOGFOOD_USER_ID,
      tenantId: DP10_DOGFOOD_TENANT_ID,
      userId: DP10_DOGFOOD_USER_ID,
      role: "admin",
      scopes: [
        "agent.run",
        "hub.admin",
        "memory.read",
        "memory.write",
        "session.read",
        "session.write",
        "workflow.write",
      ],
      iat: nowSec,
      exp: nowSec + 3600,
    },
    DP10_DOGFOOD_AUTH_TOKEN_TEST_KEY,
  );
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function dp10DogfoodFetch<T>(
  baseUrl: string,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; json: { ok: boolean; data: T; error?: { code?: string; message?: string } } }> {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: dp10DogfoodAuthHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    json: (await response.json()) as { ok: boolean; data: T; error?: { code?: string; message?: string } },
  };
}

function textFromMessages(messages: FridayAgentMessage[]): string {
  return messages
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content))
    .join("\n");
}

function createDp10DogfoodSkillRegistry(): FridaySkillRegistry {
  return {
    list: () => [],
    get: () => null,
    resolveByIntent: () => null,
    validateAll: () => [],
    reload: async () => undefined,
    refresh: async () => undefined,
    isCompatible: () => ({ compatible: true, reasons: [] }),
    startWatching: async () => undefined,
    stopWatching: async () => undefined,
    close: async () => undefined,
  };
}

function makeDp10DogfoodWorkflowGraph(
  workflowId = "wf-placeholder",
  versionId = "wv-placeholder",
): FridayCompiledWorkflowGraphV2 {
  const graph: FridayCompiledWorkflowGraphV2 = {
    schemaVersion: "2.0",
    workflowId,
    workflowVersionId: versionId,
    sourceSpecSchemaVersion: "1.0",
    graph: {
      nodes: [
        { id: "trigger", type: "trigger", label: "Trigger", config: {} },
        {
          id: "action1",
          type: "action",
          label: "Write DP-10 dogfood output",
          config: {
            skillId: DP10_DOGFOOD_WORKFLOW_SKILL_ID,
            args: {
              outboxPath: "$inputs.outboxPath",
              triggerPhrase: "$inputs.triggerPhrase",
            },
          },
        },
      ],
      edges: [{ id: "edge-trigger-action", sourceNodeId: "trigger", targetNodeId: "action1" }],
    },
    failurePolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
    checksum: "placeholder-checksum",
  };
  return {
    ...graph,
    checksum: sha256(JSON.stringify({ ...graph, checksum: "" })),
  };
}

async function waitForNewestWorkflowRun(
  workflowRuntime: ReturnType<typeof createFridayWorkflowRuntime>,
  workflowId: string,
  previousRunIds: Set<string>,
  timeoutMs = 20_000,
): Promise<string> {
  const terminal = new Set(["completed", "failed", "cancelled"]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = workflowRuntime.execution.listRuns(workflowId, undefined, 20);
    const newest = runs.find((run) => !previousRunIds.has(run.id) && terminal.has(run.status));
    if (newest) {
      return newest.id;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Workflow ${workflowId} did not produce a new terminal run after ids ${Array.from(previousRunIds).join(",")}`);
}

function makeReviewCenterWorkflowGraph(
  workflowId = "wf-placeholder",
  versionId = "wv-placeholder",
): FridayCompiledWorkflowGraphV2 {
  const graph: FridayCompiledWorkflowGraphV2 = {
    schemaVersion: "2.0",
    workflowId,
    workflowVersionId: versionId,
    sourceSpecSchemaVersion: "1.0",
    graph: {
      nodes: [
        { id: "trigger", type: "trigger", label: "Manual trigger", config: {} },
        {
          id: "receipt",
          type: "data",
          label: "Produce deterministic receipt",
          config: {
            mapping: {
              marker: "DP10_REVIEW_CENTER_WORKFLOW_EXECUTED",
              triggerPhrase: "$inputs.triggerPhrase",
            },
          },
        },
      ],
      edges: [{ id: "edge-trigger-receipt", sourceNodeId: "trigger", targetNodeId: "receipt" }],
    },
    failurePolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
    checksum: "placeholder-checksum",
  };
  return {
    ...graph,
    checksum: sha256(JSON.stringify({ ...graph, checksum: "" })),
  };
}

async function completeSetup(env: FridayRealBrowserE2eEnv): Promise<void> {
  const response = await env.apiFetch<SetupCompleteResponse>("POST", "/v1/setup/complete", {
    completedSteps: [
      "welcome",
      "security",
      "communication",
      "provider",
      "network",
      "channels",
      "skills",
      "done",
    ],
    skippedSteps: [],
  });
  expect(response.status).toBe(200);
  expect(response.json.ok).toBe(true);
}

async function seedBrowserProfile(pageHandle: FridayBrowserPageHandle): Promise<void> {
  await pageHandle.page.addInitScript(() => {
    window.localStorage.setItem("friday.uix.user-profile", JSON.stringify({
      profileType: "developer",
      onboardedAt: new Date().toISOString(),
    }));
    window.localStorage.setItem("friday.auth.user", JSON.stringify({
      id: "admin-001",
      email: "admin@friday.local",
      displayName: "Friday Admin",
      role: "admin",
    }));
  });
}

async function readUserId(env: FridayRealBrowserE2eEnv): Promise<string> {
  const response = await env.apiFetch<AuthMeResponse>("GET", "/v1/auth/me");
  expect(response.status).toBe(200);
  expect(response.json.ok).toBe(true);
  expect(response.json.data.user.id).toBeTruthy();
  return response.json.data.user.id;
}

function seedWorkflowCandidate(input: {
  env: FridayRealBrowserE2eEnv;
  userId: string;
  candidateId: string;
  generatorSessionId: string;
  title: string;
}): ReflexCandidate {
  const db = new Database(path.join(input.env.stateDir, "friday.db"));
  try {
    return createFridayReflexCandidateRepository().insert(db, {
      id: input.candidateId,
      nowIso: new Date().toISOString(),
      userId: input.userId,
      kind: "workflow",
      origin: "post_run",
      status: "ready_for_review",
      sourceRunId: `run-${input.candidateId}`,
      sessionKey: `session-${input.candidateId}`,
      title: input.title,
      summary: "Review Center browser proof workflow candidate",
      payload: {
        goal: "Create a safe deterministic workflow candidate for Review Center approval proof.",
      },
      evidence: {
        generatorSessionId: input.generatorSessionId,
        mode: "test_fixture",
        draftWorkflowId: `draft-${input.candidateId}`,
        draftName: input.title,
        validationOk: true,
        qaVerdict: { status: "passed", source: "review-center-real-browser-proof" },
        harness: { status: "passed", source: "review-center-real-browser-proof" },
      },
      confidence: 0.92,
      riskTier: 3,
    });
  } finally {
    db.close();
  }
}

function seedSkillCandidate(input: {
  env: FridayRealBrowserE2eEnv;
  userId: string;
  candidateId: string;
  generatorSessionId: string;
  title: string;
}): ReflexCandidate {
  const db = new Database(path.join(input.env.stateDir, "friday.db"));
  try {
    return createFridayReflexCandidateRepository().insert(db, {
      id: input.candidateId,
      nowIso: new Date().toISOString(),
      userId: input.userId,
      kind: "skill",
      origin: "post_run",
      status: "ready_for_review",
      sourceRunId: `run-${input.candidateId}`,
      sessionKey: `session-${input.candidateId}`,
      title: input.title,
      summary: "Review Center browser proof skill candidate",
      payload: {
        goal: "Create a safe deterministic skill candidate for Review Center approval proof.",
      },
      evidence: {
        generatorSessionId: input.generatorSessionId,
        mode: "test_fixture",
        draftSkillId: `draft-${input.candidateId}`,
        draftName: input.title,
        validationOk: true,
        qaVerdict: { status: "passed", source: "review-center-skill-browser-proof" },
        harness: { status: "passed", source: "review-center-skill-browser-proof" },
      },
      confidence: 0.9,
      riskTier: 3,
    });
  } finally {
    db.close();
  }
}

async function requestReviewCandidate(
  env: FridayRealBrowserE2eEnv,
  key: string,
  value: string,
): Promise<ReflexCandidate> {
  const response = await env.apiFetch<PreferenceCandidateResponse>(
    "PATCH",
    `/v1/reflex/preferences/${encodeURIComponent(key)}`,
    {
      category: "reflex",
      value,
      sourceSurface: "review_center",
    },
  );
  expect(response.status).toBe(200);
  expect(response.json.ok).toBe(true);
  expect(response.json.data.requiresConfirmation).toBe(true);
  expect(response.json.data.candidate?.id).toBeTruthy();
  expect(response.json.data.candidate?.status).toBe("ready_for_review");
  return response.json.data.candidate!;
}

async function listPreferences(env: FridayRealBrowserE2eEnv): Promise<ReflexPreference[]> {
  const response = await env.apiFetch<{ items: ReflexPreference[] }>("GET", "/v1/reflex/preferences");
  expect(response.status).toBe(200);
  expect(response.json.ok).toBe(true);
  return response.json.data.items;
}

async function waitForPreference(
  env: FridayRealBrowserE2eEnv,
  key: string,
  value: string,
): Promise<ReflexPreference> {
  const deadline = Date.now() + 20_000;
  let lastItems: ReflexPreference[] = [];
  while (Date.now() < deadline) {
    lastItems = await listPreferences(env);
    const preference = lastItems.find((item) =>
      item.category === "reflex"
      && item.key === key
      && item.value === value
      && item.source === "explicit"
    );
    if (preference) return preference;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for preference ${key}=${value}. Last preferences: ${JSON.stringify(lastItems)}`);
}

async function waitForWorkflowRunTerminal(
  env: FridayRealBrowserE2eEnv,
  runId: string,
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const terminal = new Set(["completed", "failed", "cancelled"]);
  let lastStatus = "";
  while (Date.now() < deadline) {
    const response = await env.apiFetch<WorkflowRunResponse>("GET", `/v1/workflow-runs/${encodeURIComponent(runId)}`);
    expect(response.status).toBe(200);
    expect(response.json.ok).toBe(true);
    lastStatus = response.json.data.run.status;
    if (terminal.has(lastStatus)) {
      return lastStatus;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for workflow run ${runId}. Last status: ${lastStatus}`);
}

describe.skipIf(!CHROMIUM_AVAILABLE)("Friday Reflex Review Center real-browser flow", () => {
  let env: FridayRealBrowserE2eEnv | null = null;
  let pageHandle: FridayBrowserPageHandle | null = null;

  afterEach(async () => {
    if (pageHandle) {
      await pageHandle.close();
      pageHandle = null;
    }
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it("approves and rejects high-impact Reflex candidates through the real Review Center UI", { timeout: 180_000 }, async () => {
    env = await createFridayRealBrowserE2eEnv();
    await completeSetup(env);

    const approveCandidate = await requestReviewCandidate(
      env,
      "testing.live_llm_policy",
      "allowed_with_cost_notice",
    );
    const rejectCandidate = await requestReviewCandidate(
      env,
      "workflows.generation_policy",
      "draft_workflow",
    );

    expect((await listPreferences(env)).some((item) => item.key === "testing.live_llm_policy")).toBe(false);
    expect((await listPreferences(env)).some((item) => item.key === "workflows.generation_policy")).toBe(false);

    pageHandle = await env.newPage();
    await seedBrowserProfile(pageHandle);
    await pageHandle.page.goto("/reflex", { waitUntil: "networkidle" });
    await pageHandle.page.getByText("Friday Reflex").first().waitFor({ state: "visible", timeout: 60_000 });

    await pageHandle.page.locator(`[data-testid="reflex-candidate-card-${approveCandidate.id}"]`).waitFor({
      state: "visible",
      timeout: 60_000,
    });
    await pageHandle.page.locator(`[data-testid="reflex-candidate-card-${rejectCandidate.id}"]`).waitFor({
      state: "visible",
      timeout: 60_000,
    });

    await pageHandle.page.locator(`[data-testid="reflex-candidate-approve-${approveCandidate.id}"]`).click();
    const approvedPreference = await waitForPreference(env, "testing.live_llm_policy", "allowed_with_cost_notice");
    expect(approvedPreference.confidence).toBe(1);

    await pageHandle.page.locator(`[data-testid="reflex-candidate-reject-${rejectCandidate.id}"]`).click();
    await pageHandle.page.waitForFunction(
      (candidateId) => !document.querySelector(`[data-testid="reflex-candidate-card-${candidateId}"]`),
      rejectCandidate.id,
      { timeout: 20_000 },
    );

    const preferencesAfterReject = await listPreferences(env);
    expect(preferencesAfterReject.some((item) => item.key === "workflows.generation_policy")).toBe(false);

    const rejectedCandidates = await env.apiFetch<{ items: ReflexCandidate[] }>(
      "GET",
      "/v1/reflex/candidates?status=rejected&kind=preference",
    );
    expect(rejectedCandidates.status).toBe(200);
    expect(rejectedCandidates.json.ok).toBe(true);
    expect(rejectedCandidates.json.data.items.some((item) => item.id === rejectCandidate.id)).toBe(true);
  });

  it("approves and rejects skill candidates in the real Review Center UI without making staged skills runnable", { timeout: 180_000 }, async () => {
    env = await createFridayRealBrowserE2eEnv();
    await completeSetup(env);
    const userId = await readUserId(env);

    const approveAndSaveCalls: string[] = [];
    const originalApproveAndSave = env.hub.skillGenerator.approveAndSave.bind(env.hub.skillGenerator);

    try {
      env.hub.skillGenerator.approveAndSave = async (sessionId: string) => {
        approveAndSaveCalls.push(sessionId);
        if (sessionId !== "skill-ui-approve-session") {
          throw new Error(`Unexpected skill generator approval session: ${sessionId}`);
        }
        return {
          sessionId,
          skillId: "review-center-approved-skill",
          skillDir: path.join(env!.stateDir, "generated-skills", "review-center-approved-skill"),
          candidateId: "review-center-approved-skill-candidate",
          candidateDir: path.join(env!.stateDir, "skill-candidates", "review-center-approved-skill-candidate"),
          savedFiles: ["skill.manifest.json", "SKILL.md", "run.sh"],
          registryRefreshed: false,
          promotionStage: "candidate_staged",
          candidateManifestTags: ["skill.lifecycle.candidate"],
          promotedManifestTags: [],
          evidence: {
            packageLoaded: true,
            packageValidated: true,
            registryRefreshed: false,
            candidateStaged: true,
          },
          harness: { status: "passed", source: "review-center-skill-browser-proof" },
          qaVerdict: { verdict: "pass", summary: "deterministic Review Center skill proof passed" },
        };
      };

      const approveCandidate = seedSkillCandidate({
        env,
        userId,
        candidateId: "skill-ui-approve-candidate",
        generatorSessionId: "skill-ui-approve-session",
        title: "Approve deterministic Review Center skill",
      });
      const rejectCandidate = seedSkillCandidate({
        env,
        userId,
        candidateId: "skill-ui-reject-candidate",
        generatorSessionId: "skill-ui-reject-session",
        title: "Reject deterministic Review Center skill",
      });

      pageHandle = await env.newPage();
      await seedBrowserProfile(pageHandle);
      await pageHandle.page.goto("/reflex", { waitUntil: "networkidle" });
      await pageHandle.page.getByText("Friday Reflex").first().waitFor({ state: "visible", timeout: 60_000 });

      await pageHandle.page.locator(`[data-testid="reflex-candidate-card-${approveCandidate.id}"]`).waitFor({
        state: "visible",
        timeout: 60_000,
      });
      await pageHandle.page.locator(`[data-testid="reflex-candidate-card-${rejectCandidate.id}"]`).waitFor({
        state: "visible",
        timeout: 60_000,
      });

      await pageHandle.page.locator(`[data-testid="reflex-candidate-reject-${rejectCandidate.id}"]`).click();
      await pageHandle.page.waitForFunction(
        (candidateId) => !document.querySelector(`[data-testid="reflex-candidate-card-${candidateId}"]`),
        rejectCandidate.id,
        { timeout: 20_000 },
      );
      expect(approveAndSaveCalls).toHaveLength(0);

      await pageHandle.page.locator(`[data-testid="reflex-candidate-approve-${approveCandidate.id}"]`).click();
      await pageHandle.page.waitForFunction(
        (candidateId) => !document.querySelector(`[data-testid="reflex-candidate-card-${candidateId}"]`),
        approveCandidate.id,
        { timeout: 20_000 },
      );
      expect(approveAndSaveCalls).toEqual(["skill-ui-approve-session"]);

      const approvedCandidates = await env.apiFetch<{ items: ReflexCandidate[] }>(
        "GET",
        "/v1/reflex/candidates?status=approved&kind=skill",
      );
      expect(approvedCandidates.status).toBe(200);
      expect(approvedCandidates.json.ok).toBe(true);
      const approved = approvedCandidates.json.data.items.find((item) => item.id === approveCandidate.id);
      expect(approved?.evidence).toMatchObject({
        savedSkillId: "review-center-approved-skill",
        stagedCandidateId: "review-center-approved-skill-candidate",
        registryRefreshed: false,
        promotionStage: "candidate_staged",
        lifecycleBoundary: "candidate_staged_not_installed_or_promoted",
      });

      const rejectedCandidates = await env.apiFetch<{ items: ReflexCandidate[] }>(
        "GET",
        "/v1/reflex/candidates?status=rejected&kind=skill",
      );
      expect(rejectedCandidates.status).toBe(200);
      expect(rejectedCandidates.json.ok).toBe(true);
      expect(rejectedCandidates.json.data.items.some((item) => item.id === rejectCandidate.id)).toBe(true);

      const runStagedSkill = await env.apiFetch<Record<string, unknown>>(
        "POST",
        "/v1/skills/review-center-approved-skill/run",
        { input: {}, channel: "api", sessionId: "review-center-staged-skill-run-denied" },
      );
      expect(runStagedSkill.status).not.toBe(200);
    } finally {
      env.hub.skillGenerator.approveAndSave = originalApproveAndSave;
    }
  });

  it("approves a workflow candidate in the real Review Center UI and runs the published workflow", { timeout: 180_000 }, async () => {
    env = await createFridayRealBrowserE2eEnv({ allowTestOnlyWorkflowRunExecution: true });
    await completeSetup(env);
    const userId = await readUserId(env);

    let approvedWorkflowId = "";
    let approvedWorkflowVersionId = "";
    const approveAndSaveCalls: string[] = [];
    const originalApproveAndSave = env.hub.workflowGenerator.approveAndSave.bind(env.hub.workflowGenerator);
    env.hub.workflowGenerator.approveAndSave = async (sessionId: string) => {
      approveAndSaveCalls.push(sessionId);
      if (sessionId !== "workflow-ui-approve-session") {
        throw new Error(`Unexpected workflow generator approval session: ${sessionId}`);
      }
      const { workflow, version } = env!.hub.workflowRuntime.crud.createWorkflowWithVersion(
        {
          slug: "dp10-review-center-approved-workflow",
          name: "DP-10 Review Center approved workflow",
          description: "Deterministic workflow created after browser Review Center approval.",
          tags: ["dp10-review-center-ui"],
          ownerUserId: userId,
        },
        makeReviewCenterWorkflowGraph(),
        userId,
        "Approved through Review Center real-browser proof.",
      );
      const published = env!.hub.workflowRuntime.crud.publishVersion(workflow.id, version.versionNumber);
      approvedWorkflowId = workflow.id;
      approvedWorkflowVersionId = published.id;
      return {
        sessionId,
        workflowId: workflow.id,
        workflowVersionId: published.id,
        versionNumber: published.versionNumber,
        slug: workflow.slug,
        published: true,
        publicationBoundary: {
          stage: "published_version",
          lifecyclePromotion: "not_lifecycle_promoted",
          proofBoundary: "crud_publish_only",
          summary: "Published for deterministic Review Center browser proof; lifecycle promotion remains separate.",
        },
      };
    };

    const approveCandidate = seedWorkflowCandidate({
      env,
      userId,
      candidateId: "workflow-ui-approve-candidate",
      generatorSessionId: "workflow-ui-approve-session",
      title: "Approve deterministic Review Center workflow",
    });
    const rejectCandidate = seedWorkflowCandidate({
      env,
      userId,
      candidateId: "workflow-ui-reject-candidate",
      generatorSessionId: "workflow-ui-reject-session",
      title: "Reject deterministic Review Center workflow",
    });

    expect(env.hub.workflowRuntime.crud.listWorkflows({ tag: "dp10-review-center-ui", archived: false })).toHaveLength(0);

    pageHandle = await env.newPage();
    await seedBrowserProfile(pageHandle);
    await pageHandle.page.goto("/reflex", { waitUntil: "networkidle" });
    await pageHandle.page.getByText("Friday Reflex").first().waitFor({ state: "visible", timeout: 60_000 });

    await pageHandle.page.locator(`[data-testid="reflex-candidate-card-${approveCandidate.id}"]`).waitFor({
      state: "visible",
      timeout: 60_000,
    });
    await pageHandle.page.locator(`[data-testid="reflex-candidate-card-${rejectCandidate.id}"]`).waitFor({
      state: "visible",
      timeout: 60_000,
    });

    await pageHandle.page.locator(`[data-testid="reflex-candidate-reject-${rejectCandidate.id}"]`).click();
    await pageHandle.page.waitForFunction(
      (candidateId) => !document.querySelector(`[data-testid="reflex-candidate-card-${candidateId}"]`),
      rejectCandidate.id,
      { timeout: 20_000 },
    );
    expect(approveAndSaveCalls).toHaveLength(0);
    expect(env.hub.workflowRuntime.crud.listWorkflows({ tag: "dp10-review-center-ui", archived: false })).toHaveLength(0);

    await pageHandle.page.locator(`[data-testid="reflex-candidate-approve-${approveCandidate.id}"]`).click();
    await pageHandle.page.waitForFunction(
      (candidateId) => !document.querySelector(`[data-testid="reflex-candidate-card-${candidateId}"]`),
      approveCandidate.id,
      { timeout: 20_000 },
    );

    expect(approveAndSaveCalls).toEqual(["workflow-ui-approve-session"]);
    expect(approvedWorkflowId).toBeTruthy();
    expect(approvedWorkflowVersionId).toBeTruthy();
    const workflows = env.hub.workflowRuntime.crud.listWorkflows({ tag: "dp10-review-center-ui", archived: false });
    expect(workflows.map((workflow) => workflow.id)).toContain(approvedWorkflowId);

    const approvedCandidates = await env.apiFetch<{ items: ReflexCandidate[] }>(
      "GET",
      "/v1/reflex/candidates?status=approved&kind=workflow",
    );
    expect(approvedCandidates.status).toBe(200);
    expect(approvedCandidates.json.ok).toBe(true);
    const approved = approvedCandidates.json.data.items.find((item) => item.id === approveCandidate.id);
    expect(approved?.evidence.savedWorkflowId).toBe(approvedWorkflowId);
    expect(approved?.evidence.workflowVersionId).toBe(approvedWorkflowVersionId);

    const rejectedCandidates = await env.apiFetch<{ items: ReflexCandidate[] }>(
      "GET",
      "/v1/reflex/candidates?status=rejected&kind=workflow",
    );
    expect(rejectedCandidates.status).toBe(200);
    expect(rejectedCandidates.json.ok).toBe(true);
    expect(rejectedCandidates.json.data.items.some((item) => item.id === rejectCandidate.id)).toBe(true);

    const startRun = await env.apiFetch<WorkflowRunResponse>("POST", "/v1/workflow-runs", {
      workflowId: approvedWorkflowId,
      workflowVersionId: approvedWorkflowVersionId,
      triggerType: "manual",
      triggerPayload: { triggerPhrase: "run the review center approved workflow" },
    });
    expect(startRun.status).toBe(200);
    expect(startRun.json.ok).toBe(true);
    const terminalStatus = await waitForWorkflowRunTerminal(env, startRun.json.data.run.id);
    expect(terminalStatus).toBe("completed");

    const evidence = await env.apiFetch<WorkflowEvidenceResponse>(
      "GET",
      `/v1/workflow-runs/${encodeURIComponent(startRun.json.data.run.id)}/evidence`,
    );
    expect(evidence.status).toBe(200);
    expect(evidence.json.ok).toBe(true);
    expect(evidence.json.data.summary.totalEvents).toBeGreaterThan(0);

    env.hub.workflowGenerator.approveAndSave = originalApproveAndSave;
  });

  it("keeps a Review Center approved workflow executable after a hub restart", { timeout: 180_000 }, async () => {
    env = await createFridayRealBrowserE2eEnv({ allowTestOnlyWorkflowRunExecution: true });
    await completeSetup(env);
    const userId = await readUserId(env);

    let approvedWorkflowId = "";
    let approvedWorkflowVersionId = "";
    const originalApproveAndSave = env.hub.workflowGenerator.approveAndSave.bind(env.hub.workflowGenerator);

    try {
      env.hub.workflowGenerator.approveAndSave = async (sessionId: string) => {
        if (sessionId !== "workflow-ui-restart-session") {
          throw new Error(`Unexpected workflow generator approval session: ${sessionId}`);
        }
        const { workflow, version } = env!.hub.workflowRuntime.crud.createWorkflowWithVersion(
          {
            slug: "dp10-review-center-restart-workflow",
            name: "DP-10 Review Center restart workflow",
            description: "Deterministic workflow created before hub restart.",
            tags: ["dp10-review-center-restart"],
            ownerUserId: userId,
          },
          makeReviewCenterWorkflowGraph(),
          userId,
          "Approved through Review Center before restart proof.",
        );
        const published = env!.hub.workflowRuntime.crud.publishVersion(workflow.id, version.versionNumber);
        approvedWorkflowId = workflow.id;
        approvedWorkflowVersionId = published.id;
        return {
          sessionId,
          workflowId: workflow.id,
          workflowVersionId: published.id,
          versionNumber: published.versionNumber,
          slug: workflow.slug,
          published: true,
          publicationBoundary: {
            stage: "published_version",
            lifecyclePromotion: "not_lifecycle_promoted",
            proofBoundary: "crud_publish_only",
            summary: "Published for deterministic Review Center restart proof; lifecycle promotion remains separate.",
          },
        };
      };

      const approveCandidate = seedWorkflowCandidate({
        env,
        userId,
        candidateId: "workflow-ui-restart-approve-candidate",
        generatorSessionId: "workflow-ui-restart-session",
        title: "Approve deterministic restart workflow",
      });

      pageHandle = await env.newPage();
      await seedBrowserProfile(pageHandle);
      await pageHandle.page.goto("/reflex", { waitUntil: "networkidle" });
      await pageHandle.page.getByText("Friday Reflex").first().waitFor({ state: "visible", timeout: 60_000 });
      await pageHandle.page.locator(`[data-testid="reflex-candidate-card-${approveCandidate.id}"]`).waitFor({
        state: "visible",
        timeout: 60_000,
      });
      await pageHandle.page.locator(`[data-testid="reflex-candidate-approve-${approveCandidate.id}"]`).click();
      await pageHandle.page.waitForFunction(
        (candidateId) => !document.querySelector(`[data-testid="reflex-candidate-card-${candidateId}"]`),
        approveCandidate.id,
        { timeout: 20_000 },
      );

      expect(approvedWorkflowId).toBeTruthy();
      expect(approvedWorkflowVersionId).toBeTruthy();
    } finally {
      env.hub.workflowGenerator.approveAndSave = originalApproveAndSave;
    }

    await pageHandle.close();
    pageHandle = null;

    await env.restartHubPreservingState();

    const workflowsAfterRestart = env.hub.workflowRuntime.crud.listWorkflows({
      tag: "dp10-review-center-restart",
      archived: false,
    });
    expect(workflowsAfterRestart.map((workflow) => workflow.id)).toContain(approvedWorkflowId);

    pageHandle = await env.newPage();
    await seedBrowserProfile(pageHandle);
    await pageHandle.page.goto("/reflex", { waitUntil: "networkidle" });
    await pageHandle.page.getByText("Friday Reflex").first().waitFor({ state: "visible", timeout: 60_000 });

    const approvedCandidatesAfterRestart = await env.apiFetch<{ items: ReflexCandidate[] }>(
      "GET",
      "/v1/reflex/candidates?status=approved&kind=workflow",
    );
    expect(approvedCandidatesAfterRestart.status).toBe(200);
    expect(approvedCandidatesAfterRestart.json.ok).toBe(true);
    expect(approvedCandidatesAfterRestart.json.data.items.some((item) =>
      item.evidence.savedWorkflowId === approvedWorkflowId
      && item.evidence.workflowVersionId === approvedWorkflowVersionId
    )).toBe(true);

    const startRun = await env.apiFetch<WorkflowRunResponse>("POST", "/v1/workflow-runs", {
      workflowId: approvedWorkflowId,
      workflowVersionId: approvedWorkflowVersionId,
      triggerType: "manual",
      triggerPayload: { triggerPhrase: "run the restart-persisted review center workflow" },
    });
    expect(startRun.status).toBe(200);
    expect(startRun.json.ok).toBe(true);
    const terminalStatus = await waitForWorkflowRunTerminal(env, startRun.json.data.run.id);
    expect(terminalStatus).toBe("completed");

    const evidence = await env.apiFetch<WorkflowEvidenceResponse>(
      "GET",
      `/v1/workflow-runs/${encodeURIComponent(startRun.json.data.run.id)}/evidence`,
    );
    expect(evidence.status).toBe(200);
    expect(evidence.json.ok).toBe(true);
    expect(evidence.json.data.summary.totalEvents).toBeGreaterThan(0);
  });

  it("dogfoods organic workflow candidates through Review Center approval and fresh trigger execution", { timeout: 180_000 }, async () => {
    let db: FridaySqliteLayer | null = null;
    let server: FridayHttpServer | null = null;
    let workspaceDir: string | null = null;
    const customBrowser = await chromium.launch({ headless: true });
    const customContext = await customBrowser.newContext({
      baseURL: "about:blank",
      timezoneId: "America/Los_Angeles",
    });

    try {
      db = createTestDb();
      workspaceDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "friday-dp10-dogfood-"));
      db.withWriteTransaction((writer) => {
        writer.prepare(
          `INSERT OR IGNORE INTO users (id, display_name, role, is_local_only, created_at, updated_at)
           VALUES (?, ?, 'admin', 1, ?, ?)`,
        ).run(DP10_DOGFOOD_USER_ID, "DP10 Dogfood User", DP10_DOGFOOD_NOW, DP10_DOGFOOD_NOW);
      });

      const idGenerator = createTestIdGenerator();
      const providerService = createFridayProviderService({
        db,
        idGenerator,
        nowIso: () => DP10_DOGFOOD_NOW,
      });
      const memoryService = createFridayMemoryService({
        db,
        providerService,
        idGenerator,
        nowIso: () => DP10_DOGFOOD_NOW,
      });
      const memoryGuardFactory = createFridayMemoryGuardServiceFactory({
        core: memoryService,
        db,
        nowIso: () => DP10_DOGFOOD_NOW,
        nowMs: () => Date.parse(DP10_DOGFOOD_NOW),
      });

      const workflowInvocations: Array<{
        runId: string;
        outputPath: string;
        checksum: string;
      }> = [];

      const createDogfoodWorkflowRuntime = () =>
        createFridayWorkflowRuntime({
          allowTestOnlyWorkflowRunExecution: true, // TS-retirement method guard: test-oracle opt-in
          db,
          idGenerator,
          nowIso: () => DP10_DOGFOOD_NOW,
          computeChecksum: sha256,
          resolveSkill: (skillId) => skillId === DP10_DOGFOOD_WORKFLOW_SKILL_ID ? { id: skillId } : null,
          invokeSkill: async (_skillId, runId, _nodeId, payload) => {
            const outboxPath = String(payload.outboxPath ?? "");
            expect(path.isAbsolute(outboxPath)).toBe(false);
            expect(outboxPath.split(/[\\/]/)).not.toContain("..");
            const absoluteOutputPath = path.join(workspaceDir!, outboxPath);
            const content = [
              "DP10_DOGFOOD_WORKFLOW_OUTPUT",
              `triggerPhrase=${String(payload.triggerPhrase ?? "")}`,
              `runId=${runId}`,
            ].join("\n");
            await fs.promises.mkdir(path.dirname(absoluteOutputPath), { recursive: true });
            await fs.promises.writeFile(absoluteOutputPath, `${content}\n`, "utf8");
            const checksum = sha256(content);
            workflowInvocations.push({ runId, outputPath: outboxPath, checksum });
            return { outputPath: outboxPath, checksum };
          },
          triggerRepo: createFridayWorkflowTriggerRepository({ db }),
        });

      let workflowRuntime = createDogfoodWorkflowRuntime();

      let generatorSessionCounter = 0;
      let approvedWorkflowId = "";
      let approvedWorkflowVersionId = "";
      let approvedSopMemoryId = "";
      const approveAndSaveCalls: string[] = [];
      const workflowGenerator = {
        startSession: async () => {
          generatorSessionCounter += 1;
          return {
            mode: "new",
            session: { sessionId: `dp10-dogfood-generator-${String(generatorSessionCounter)}` },
          };
        },
        submitTurn: async () => {},
        getSession: async () => undefined,
        generateDraft: async (sessionId: string) => ({
          spec: {
            workflowId: `draft-${sessionId}`,
            name: "DP-10 dogfood generated workflow",
          },
          validation: { ok: true },
        }),
        getQaVerdict: async () => ({ status: "passed", source: "dp10-dogfood-deterministic-generator" }),
        getHarnessSummary: async () => ({ status: "passed", source: "dp10-dogfood-deterministic-generator" }),
        approveAndSave: async (sessionId: string) => {
          approveAndSaveCalls.push(sessionId);
          const { workflow, version } = workflowRuntime.crud.createWorkflowWithVersion(
            {
              slug: `dp10-dogfood-approved-${sessionId}`,
              name: "DP-10 dogfood approved workflow",
              description: "Generated from repeated DP-10 product-entrypoint behavior and approved in Review Center.",
              tags: ["dp10-dogfood", "refund-followup"],
              ownerUserId: DP10_DOGFOOD_USER_ID,
            },
            makeDp10DogfoodWorkflowGraph(),
            DP10_DOGFOOD_USER_ID,
            "Approved through DP-10 dogfood Review Center proof.",
          );
          const published = workflowRuntime.crud.publishVersion(workflow.id, version.versionNumber);
          approvedWorkflowId = workflow.id;
          approvedWorkflowVersionId = published.id;
          const sopMemory = await memoryService.store(
            "default",
            [
              "DP10_DOGFOOD_APPROVED_SOP",
              "Trigger phrases: run the approved weekly refund followup automation; do the approved refund followup cleanup; compile the approved refund followup receipt pack.",
              "Workflow lookup: use read-only workflow_list with tag dp10-dogfood before running.",
              "Allowed mutation: write deterministic refund followup outputs inside the isolated workspace.",
              "Approval boundary: deletion, external send, or writes outside workspace require separate explicit approval.",
            ].join("\n"),
            {
              source: "dp10-dogfood-review-center",
              tags: ["dp10-dogfood", "approved-sop", "refund-followup"],
              memoryType: "procedure",
              confidence: 0.97,
            },
          );
          approvedSopMemoryId = sopMemory.id;
          return {
            sessionId,
            workflowId: workflow.id,
            workflowVersionId: published.id,
            versionNumber: published.versionNumber,
            slug: workflow.slug,
            published: true,
            publicationBoundary: {
              stage: "published_version",
              lifecyclePromotion: "not_lifecycle_promoted",
              proofBoundary: "deterministic_dogfood_fixture",
              summary: "Published for isolated DP-10 dogfood proof; live LLM generation remains separate.",
            },
          };
        },
        cancelSession: async () => {},
      };

      const reflexService = createFridayReflexService({
        db,
        candidateRepo: createFridayReflexCandidateRepository(),
        onboardingRepo: createFridayReflexOnboardingRepository(),
        preferenceRepo: createFridayUixUserPreferenceRepository(),
        memoryService,
        workflowGenerator: workflowGenerator as never,
        idGenerator,
        nowIso: () => DP10_DOGFOOD_NOW,
      });

      let repeatedStep = 0;
      let approvedExecutionStep = 0;
      let approvedRunIndex = 0;
      let pendingApprovedTriggerPhrase = "";
      const approvalPrompts: Array<{ toolName: string; canonicalAction?: string }> = [];
      const llmClient: FridayAgentLlmClient = {
        async *stream(params) {
          const prompt = textFromMessages(params.messages);
          const destructiveApprovedTrigger = /delete .*approved.*refund followup/i.test(prompt);
          const approvedTriggerPhrase = prompt.includes("do the approved refund followup cleanup")
            ? "do the approved refund followup cleanup"
            : prompt.includes("run the approved weekly refund followup automation")
              ? "run the approved weekly refund followup automation"
              : prompt.includes("compile the approved refund followup receipt pack")
                ? "compile the approved refund followup receipt pack"
                : "";

          if (destructiveApprovedTrigger) {
            yield {
              type: "text_delta",
              text: "DP10_DOGFOOD_REFUSED_DESTRUCTIVE_TRIGGER: deletion requires separate explicit approval; no workflow was started.",
            };
            yield { type: "message_end", stopReason: "end_turn", inputTokens: 30, outputTokens: 10 };
            return;
          }

          if (approvedTriggerPhrase || approvedExecutionStep > 0) {
            if (approvedTriggerPhrase) {
              pendingApprovedTriggerPhrase = approvedTriggerPhrase;
            }
            if (approvedExecutionStep === 0) {
              approvedExecutionStep = 1;
              yield {
                type: "tool_use",
                id: `dp10-dogfood-memory-search-${idGenerator()}`,
                name: "memory_search",
                input: {
                  query: "DP10_DOGFOOD_APPROVED_SOP weekly refund followup cleanup approval boundary",
                  namespace: "default",
                  limit: 5,
                },
              };
              yield { type: "message_end", stopReason: "tool_use", inputTokens: 28, outputTokens: 6 };
              return;
            }
            if (approvedExecutionStep === 1) {
              approvedExecutionStep = 2;
              yield {
                type: "tool_use",
                id: `dp10-dogfood-workflow-list-${idGenerator()}`,
                name: "workflow_list",
                input: {
                  tag: "dp10-dogfood",
                  publishedOnly: true,
                  limit: 5,
                },
              };
              yield { type: "message_end", stopReason: "tool_use", inputTokens: 28, outputTokens: 6 };
              return;
            }
            if (approvedExecutionStep === 2) {
              approvedExecutionStep = 3;
              approvedRunIndex += 1;
              yield {
                type: "tool_use",
                id: `dp10-dogfood-workflow-run-${idGenerator()}`,
                name: "workflow_run",
                input: {
                  workflowId: approvedWorkflowId,
                  versionId: approvedWorkflowVersionId,
                  input: {
                    triggerPhrase: pendingApprovedTriggerPhrase,
                    outboxPath: `outbox/dp10-dogfood-followup-${approvedRunIndex}.md`,
                  },
                },
              };
              yield { type: "message_end", stopReason: "tool_use", inputTokens: 30, outputTokens: 8 };
              return;
            }
            approvedExecutionStep = 0;
            yield {
              type: "text_delta",
              text: "DP10_DOGFOOD_APPROVED_WORKFLOW_EXECUTED: approved workflow ran from a fresh trigger after memory recall and workflow_list discovery.",
            };
            yield { type: "message_end", stopReason: "end_turn", inputTokens: 30, outputTokens: 12 };
            return;
          }

          if (repeatedStep === 0) {
            repeatedStep = 1;
            yield {
              type: "tool_use",
              id: `dp10-dogfood-search-${idGenerator()}`,
              name: "memory_search",
              input: {
                query: "weekly refund followup reusable path",
                namespace: "agent",
                limit: 3,
              },
            };
            yield { type: "message_end", stopReason: "tool_use", inputTokens: 20, outputTokens: 5 };
            return;
          }
          if (repeatedStep === 1) {
            repeatedStep = 2;
            yield {
              type: "tool_use",
              id: `dp10-dogfood-store-${idGenerator()}`,
              name: "memory_store",
              input: {
                content: "DP10_DOGFOOD_REUSABLE_STEP: weekly refund followup pack uses memory_search -> memory_store -> memory_search.",
                namespace: "agent",
                tags: ["dp10-dogfood", "repeated-success"],
              },
            };
            yield { type: "message_end", stopReason: "tool_use", inputTokens: 25, outputTokens: 8 };
            return;
          }
          if (repeatedStep === 2) {
            repeatedStep = 3;
            yield {
              type: "tool_use",
              id: `dp10-dogfood-confirm-${idGenerator()}`,
              name: "memory_search",
              input: {
                query: "DP10_DOGFOOD_REUSABLE_STEP weekly refund followup",
                namespace: "agent",
                limit: 3,
              },
            };
            yield { type: "message_end", stopReason: "tool_use", inputTokens: 25, outputTokens: 8 };
            return;
          }
          repeatedStep = 0;
          yield {
            type: "text_delta",
            text: "DP10_DOGFOOD_REPEATED_RUN_COMPLETED: repeated task completed; reusable automation remains review-gated.",
          };
          yield { type: "message_end", stopReason: "end_turn", inputTokens: 30, outputTokens: 12 };
        },
      };

      let baseUrl = "";
      const startDogfoodRuntimeServer = async () => {
        const runEventRepository = createFridayAgentRunEventRepository();
        const episodeExtractor = createFridayEpisodeExtractor({
          db,
          idGenerator,
          nowIso: () => DP10_DOGFOOD_NOW,
        });
        const patternExtractor = createFridayPatternExtractor({
          db,
          idGenerator,
          nowIso: () => DP10_DOGFOOD_NOW,
        });
        const contextEngine: FridayContextEngine = {
          async afterTurn(input) {
            const episode = await episodeExtractor.extractFromRun(input.runId, input.userId ?? DP10_DOGFOOD_USER_ID);
            if (episode) {
              await patternExtractor.extractPatterns(episode.userId, 50);
            }
            const toolSequence = db!.withReadConnection((reader) =>
              runEventRepository.list(reader, input.runId)
                .filter((event) => event.eventName === "agent.run.tool_end")
                .map((event) => typeof event.payload.toolName === "string" ? event.payload.toolName : undefined)
                .filter((toolName): toolName is string => Boolean(toolName)));
            await reflexService.processRunCompletion({
              userId: input.userId ?? DP10_DOGFOOD_USER_ID,
              runId: input.runId,
              sessionKey: input.sessionKey,
              task: input.task,
              outcome: input.status === "completed" ? "success" : input.status === "failed" ? "failure" : "unknown",
              toolSequence,
            });
          },
        };

        const eventEmitter = createFridayAgentEventEmitter();
        const agentRuntime = createFridayAgentRuntime({
          db,
          llmClient,
          model: "dp10-dogfood-deterministic-model",
          providerId: "dp10-dogfood-deterministic-provider",
          systemPrompt: "You are Friday. Recall memory, list workflows before running, and require approval for workflow_run.",
          tools: [
            ...createFridayAgentMemoryTools({
              memoryService,
              memoryGuardFactory,
            }),
            createFridayAgentWorkflowListTool({ workflowCrudService: workflowRuntime.crud }),
            createFridayAgentWorkflowTool({ workflowExecutionService: workflowRuntime.execution }),
          ],
          eventEmitter,
          runEventRepository,
          contextEngine,
          idGenerator,
          nowIso: () => DP10_DOGFOOD_NOW,
          canonicalMutatingActionGate: true,
          canonicalApprovalSecret: DP10_DOGFOOD_AUTH_TOKEN_TEST_KEY,
          toolApprovalResolver: async (prompt) => {
            approvalPrompts.push({
              toolName: prompt.toolName,
              canonicalAction: prompt.canonicalAction,
            });
            return {
              approved: true,
              decidedByPrincipalId: DP10_DOGFOOD_USER_ID,
              decidedByPrincipalType: "user",
              approvalSurface: "dp10-dogfood-review-center",
            };
          },
        });

        const runtime = createFridayApiRuntime({
          db,
          idGenerator,
          nowIso: () => DP10_DOGFOOD_NOW,
          providerService,
          memoryService,
          workflowRuntime,
          agentRuntime,
          agentEventEmitter: eventEmitter,
          reflexService,
          skillRegistry: createDp10DogfoodSkillRegistry(),
          tokenSecret: DP10_DOGFOOD_AUTH_TOKEN_TEST_KEY,
          computeChecksum: sha256,
          allowTestOnlySessionExecution: true,
          allowTestOnlySessionRunExecution: true,
          allowTestOnlySessionMemoryExtractionExecution: true,
        });
        for (const route of createFridayReflexRoutes({ service: reflexService })) {
          runtime.routes.register(route);
        }

        const port = await findFreePort();
        server = createFridayHttpServer({
          routes: runtime.routes,
          wsGateway: runtime.wsGateway,
          middleware: runtime.middleware,
          port,
          host: "127.0.0.1",
          uiStaticDir: resolveBuiltUiStaticDir(),
        });
        await server.listen();
        baseUrl = `http://127.0.0.1:${String(port)}`;
      };

      const restartDogfoodRuntimeServer = async () => {
        await server?.close();
        server = null;
        workflowRuntime = createDogfoodWorkflowRuntime();
        await startDogfoodRuntimeServer();
      };

      await startDogfoodRuntimeServer();

      const setup = await dp10DogfoodFetch<SetupCompleteResponse>(
        baseUrl,
        "POST",
        "/v1/setup/complete",
        {
          completedSteps: ["welcome", "security", "communication", "provider", "network", "channels", "skills", "done"],
          skippedSteps: [],
        },
      );
      expect(setup.status).toBe(200);
      expect(setup.json.ok).toBe(true);

      async function runSessionTask(task: string, chatId: string): Promise<{
        response: string;
        toolCallCount: number;
      }> {
        const createSession = await dp10DogfoodFetch<{ session: { key: string } }>(
          baseUrl,
          "POST",
          "/v1/sessions",
          { channel: "dp10-dogfood", chatId },
        );
        expect(createSession.status).toBe(200);
        const sessionKey = createSession.json.data.session.key;

        const reset = await dp10DogfoodFetch(baseUrl, "POST", `/v1/sessions/${encodeURIComponent(sessionKey)}/reset`);
        expect(reset.status).toBe(200);

        const run = await dp10DogfoodFetch<{ run: { status: string; response: string; toolCallCount: number } }>(
          baseUrl,
          "POST",
          `/v1/sessions/${encodeURIComponent(sessionKey)}/run`,
          { task },
        );
        expect(run.status).toBe(200);
        expect(run.json.data.run.status).toBe("completed");
        return {
          response: run.json.data.run.response,
          toolCallCount: run.json.data.run.toolCallCount,
        };
      }

      await runSessionTask("prepare the weekly refund followup pack", "dogfood-refund-a");
      await runSessionTask("prepare the weekly refund followup pack", "dogfood-refund-b");
      await runSessionTask("prepare the vendor invoice followup pack", "dogfood-invoice-a");
      await runSessionTask("prepare the vendor invoice followup pack", "dogfood-invoice-b");

      const workflowCandidates = reflexService.listCandidates({
        userId: DP10_DOGFOOD_USER_ID,
        kind: "workflow",
        status: "ready_for_review",
      });
      expect(workflowCandidates).toHaveLength(2);
      const approveCandidate = workflowCandidates.find((candidate) =>
        candidate.title.includes("weekly refund followup"));
      const rejectCandidate = workflowCandidates.find((candidate) =>
        candidate.title.includes("vendor invoice followup"));
      expect(approveCandidate).toBeDefined();
      expect(rejectCandidate).toBeDefined();
      expect(workflowRuntime.crud.listWorkflows({ tag: "dp10-dogfood", archived: false })).toHaveLength(0);

      const token = dp10DogfoodAuthHeaders().Authorization.replace("Bearer ", "");
      await customContext.addInitScript(
        ({ accessToken }) => {
          window.localStorage.setItem("friday.auth.accessToken", accessToken);
          window.localStorage.setItem("friday.auth.user", JSON.stringify({
            id: "dp10-dogfood-user",
            email: "dp10-dogfood@friday.local",
            displayName: "DP10 Dogfood User",
            role: "admin",
          }));
          window.localStorage.setItem("friday.uix.user-profile", JSON.stringify({
            profileType: "developer",
            onboardedAt: new Date().toISOString(),
          }));
        },
        { accessToken: token },
      );
      const page = await customContext.newPage();
      await page.goto(`${baseUrl}/reflex`, { waitUntil: "networkidle" });
      await page.getByText("Friday Reflex").first().waitFor({ state: "visible", timeout: 60_000 });
      await page.locator(`[data-testid="reflex-candidate-card-${approveCandidate!.id}"]`).waitFor({
        state: "visible",
        timeout: 60_000,
      });
      await page.locator(`[data-testid="reflex-candidate-card-${rejectCandidate!.id}"]`).waitFor({
        state: "visible",
        timeout: 60_000,
      });

      await page.locator(`[data-testid="reflex-candidate-reject-${rejectCandidate!.id}"]`).click();
      await page.waitForFunction(
        (candidateId) => !document.querySelector(`[data-testid="reflex-candidate-card-${candidateId}"]`),
        rejectCandidate!.id,
        { timeout: 20_000 },
      );
      expect(approveAndSaveCalls).toHaveLength(0);
      expect(workflowRuntime.crud.listWorkflows({ tag: "dp10-dogfood", archived: false })).toHaveLength(0);

      await page.locator(`[data-testid="reflex-candidate-approve-${approveCandidate!.id}"]`).click();
      await page.waitForFunction(
        (candidateId) => !document.querySelector(`[data-testid="reflex-candidate-card-${candidateId}"]`),
        approveCandidate!.id,
        { timeout: 20_000 },
      );
      expect(approveAndSaveCalls).toEqual([String(approveCandidate!.evidence.generatorSessionId)]);
      expect(approvedWorkflowId).toBeTruthy();
      expect(approvedWorkflowVersionId).toBeTruthy();
      expect(approvedSopMemoryId).toBeTruthy();

      const approvedCandidates = await dp10DogfoodFetch<{ items: ReflexCandidate[] }>(
        baseUrl,
        "GET",
        "/v1/reflex/candidates?status=approved&kind=workflow",
      );
      expect(approvedCandidates.status).toBe(200);
      expect(approvedCandidates.json.data.items.find((candidate) => candidate.id === approveCandidate!.id)?.evidence)
        .toMatchObject({
          savedWorkflowId: approvedWorkflowId,
          workflowVersionId: approvedWorkflowVersionId,
          published: true,
        });
      const rejectedCandidates = await dp10DogfoodFetch<{ items: ReflexCandidate[] }>(
        baseUrl,
        "GET",
        "/v1/reflex/candidates?status=rejected&kind=workflow",
      );
      expect(rejectedCandidates.status).toBe(200);
      expect(rejectedCandidates.json.data.items.some((candidate) => candidate.id === rejectCandidate!.id)).toBe(true);

      await restartDogfoodRuntimeServer();
      expect(workflowRuntime.crud.listWorkflows({ tag: "dp10-dogfood", archived: false })
        .map((workflow) => workflow.id)).toContain(approvedWorkflowId);
      const approvedCandidatesAfterRestart = await dp10DogfoodFetch<{ items: ReflexCandidate[] }>(
        baseUrl,
        "GET",
        "/v1/reflex/candidates?status=approved&kind=workflow",
      );
      expect(approvedCandidatesAfterRestart.status).toBe(200);
      expect(approvedCandidatesAfterRestart.json.data.items.find((candidate) => candidate.id === approveCandidate!.id)?.evidence)
        .toMatchObject({
          savedWorkflowId: approvedWorkflowId,
          workflowVersionId: approvedWorkflowVersionId,
          published: true,
        });

      const memoryBeforeTriggers = db.withReadConnection((reader) =>
        reader.prepare(
          "SELECT access_count, last_accessed_at FROM memory_items WHERE id = ? LIMIT 1",
        ).get(approvedSopMemoryId) as { access_count: number; last_accessed_at: string | null } | undefined);
      expect(memoryBeforeTriggers).toBeDefined();

      const beforeFirstRunIds = new Set(workflowRuntime.execution.listRuns(approvedWorkflowId, undefined, 20).map((run) => run.id));
      const triggerOne = await runSessionTask(
        "run the approved weekly refund followup automation",
        "dogfood-trigger-one",
      );
      expect(triggerOne.response).toContain("DP10_DOGFOOD_APPROVED_WORKFLOW_EXECUTED");
      expect(triggerOne.toolCallCount).toBe(3);
      const runOneId = await waitForNewestWorkflowRun(workflowRuntime, approvedWorkflowId, beforeFirstRunIds);
      const evidenceOne = workflowRuntime.evidence.getRunEvidence(runOneId);
      expect(evidenceOne.evidenceStatus).toBe("available");
      expect(evidenceOne.summary.totalEvents).toBeGreaterThan(0);

      const beforeSecondRunIds = new Set(workflowRuntime.execution.listRuns(approvedWorkflowId, undefined, 20).map((run) => run.id));
      const triggerTwo = await runSessionTask(
        "do the approved refund followup cleanup",
        "dogfood-trigger-two",
      );
      expect(triggerTwo.response).toContain("DP10_DOGFOOD_APPROVED_WORKFLOW_EXECUTED");
      expect(triggerTwo.toolCallCount).toBe(3);
      const runTwoId = await waitForNewestWorkflowRun(workflowRuntime, approvedWorkflowId, beforeSecondRunIds);
      const evidenceTwo = workflowRuntime.evidence.getRunEvidence(runTwoId);
      expect(evidenceTwo.evidenceStatus).toBe("available");
      expect(evidenceTwo.summary.totalEvents).toBeGreaterThan(0);

      const beforeThirdRunIds = new Set(workflowRuntime.execution.listRuns(approvedWorkflowId, undefined, 20).map((run) => run.id));
      const triggerThree = await runSessionTask(
        "compile the approved refund followup receipt pack",
        "dogfood-trigger-three",
      );
      expect(triggerThree.response).toContain("DP10_DOGFOOD_APPROVED_WORKFLOW_EXECUTED");
      expect(triggerThree.toolCallCount).toBe(3);
      const runThreeId = await waitForNewestWorkflowRun(workflowRuntime, approvedWorkflowId, beforeThirdRunIds);
      const evidenceThree = workflowRuntime.evidence.getRunEvidence(runThreeId);
      expect(evidenceThree.evidenceStatus).toBe("available");
      expect(evidenceThree.summary.totalEvents).toBeGreaterThan(0);

      expect(workflowInvocations).toHaveLength(3);
      for (const invocation of workflowInvocations) {
        const output = await fs.promises.readFile(path.join(workspaceDir, invocation.outputPath), "utf8");
        expect(output).toContain("DP10_DOGFOOD_WORKFLOW_OUTPUT");
        expect(sha256(output.trim())).toBe(invocation.checksum);
      }

      const memoryAfterTriggers = db.withReadConnection((reader) =>
        reader.prepare(
          "SELECT access_count, last_accessed_at FROM memory_items WHERE id = ? LIMIT 1",
        ).get(approvedSopMemoryId) as { access_count: number; last_accessed_at: string | null } | undefined);
      expect(memoryAfterTriggers?.access_count ?? 0).toBeGreaterThan(memoryBeforeTriggers!.access_count);
      expect(memoryAfterTriggers?.last_accessed_at).toBeTruthy();

      const beforeNegativeRunIds = workflowRuntime.execution.listRuns(approvedWorkflowId, undefined, 20).map((run) => run.id);
      const negative = await runSessionTask(
        "delete outputs from the approved weekly refund followup automation",
        "dogfood-trigger-negative",
      );
      expect(negative.response).toContain("DP10_DOGFOOD_REFUSED_DESTRUCTIVE_TRIGGER");
      expect(workflowRuntime.execution.listRuns(approvedWorkflowId, undefined, 20).map((run) => run.id)).toEqual(beforeNegativeRunIds);
      expect(workflowInvocations).toHaveLength(3);
      const workflowRunApprovalPrompts = approvalPrompts.filter((prompt) => prompt.toolName === "workflow_run");
      expect(workflowRunApprovalPrompts).toHaveLength(3);
      expect(workflowRunApprovalPrompts.every((prompt) => prompt.canonicalAction === "agent.tool.workflow_run")).toBe(true);

      const ruleAuditRows = db.withReadConnection((reader) =>
        reader.prepare("SELECT COUNT(*) AS count FROM rule_evaluation_log WHERE workflow_id = ?").get(approvedWorkflowId) as { count: number });
      expect(ruleAuditRows.count).toBeGreaterThanOrEqual(3);

      workflowRuntime.crud.archiveWorkflow(approvedWorkflowId, DP10_DOGFOOD_USER_ID);
      expect(workflowRuntime.crud.listWorkflows({ tag: "dp10-dogfood", archived: false })
        .map((workflow) => workflow.id)).not.toContain(approvedWorkflowId);
      await fs.promises.rm(path.join(workspaceDir, "outbox"), { recursive: true, force: true });
      await expect(fs.promises.stat(path.join(workspaceDir, "outbox"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await customContext.close();
      await customBrowser.close();
      await server?.close();
      db?.close();
      if (workspaceDir) {
        await fs.promises.rm(workspaceDir, { recursive: true, force: true });
      }
    }
  });
});
