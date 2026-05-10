import * as fs from "node:fs";
import * as path from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FridayCompiledWorkflowGraphV2 } from "#workflows";
import {
  apiFetch,
  createDeepSeekProvider,
  createOpenAiProvider,
  verifyProviderTextCapability,
} from "./_helpers/api.js";
import { pollUntil } from "./_helpers/poll.js";
import {
  cleanupRealHubEnv,
  createRealHubEnv,
  DEEPSEEK_API_KEY_ENV,
  DEEPSEEK_BASE_URL,
  E2E_GATED,
  FAST_MODEL,
  LIVE_PROVIDER_KIND,
  OPENAI_API_KEY_ENV,
  OPENAI_BASE_URL,
  type RealHubEnv,
} from "./_helpers/real-env.js";

// Mirrors the learning-live gate pattern: accept openai or deepseek as the
// active provider lane. Self-healing logic is provider-agnostic (incident +
// lesson + auto-fix is Friday-internal); the provider only supplies the
// underlying LLM substrate. Active-provider evidence labelling stays honest:
// a DeepSeek run proves DeepSeek self-healing, not OpenAI.
const SELF_HEALING_PROOF_GATED =
  E2E_GATED && (LIVE_PROVIDER_KIND === "openai" || LIVE_PROVIDER_KIND === "deepseek");
const LIVE_PROVIDER_LABEL = LIVE_PROVIDER_KIND === "deepseek" ? "DeepSeek" : "OpenAI";
const LIVE_MODEL = FAST_MODEL;
const BUNDLED_SKILLS_DIR = path.join(process.cwd(), "skills");

interface RoutingSnapshot {
  defaultProviderId: string;
  defaultModel?: string;
  fallbackProviderIds: string[];
}

interface AutoFixActionRecord {
  action: {
    actionId: string;
    incidentId: string;
    status: string;
    outcome?: string | null;
    plan: {
      title: string;
      summary: string;
      steps: Array<{
        stepId: string;
        kind: string;
        target: string;
      }>;
      evidence: {
        fingerprint: string;
        matchedLessonIds: string[];
      };
    };
  };
  approval: {
    status: string;
  } | null;
  summary: {
    actionId: string;
    incidentId: string;
    status: string;
    title: string;
    summary: string;
    rollbackPlanAvailable: boolean;
  };
  evidence: {
    acceptanceResult: { passed: boolean; reason: string };
    rollbackResult: {
      available: boolean;
      rollbackAttempted?: boolean;
      rollbackSucceeded?: boolean;
    };
    extractedLesson?: {
      id: string;
      title: string;
      cause: string;
      fix: string;
    };
  };
}

interface DiagnosisDetails {
  incident: {
    incidentId: string;
    status: string;
  };
  diagnosis: {
    id: string;
    diagnosis: {
      matchedLessonIds?: string[];
      summary?: string;
    };
  } | null;
  summary: {
    matchedLessonIds: string[];
    recurrenceCount: number;
  };
  action: AutoFixActionRecord | null;
}

interface LearningOverview {
  coverage: {
    incidents: number;
    diagnoses: number;
    autoFixActions: number;
  };
  lessons: Array<{
    lesson: {
      id: string;
      fingerprint: string;
      title: string;
      sourceIncidentId?: string;
    };
    disabled: boolean;
    disabledReason?: string;
  }>;
}

function openStateDb(stateDir: string): Database.Database {
  return new Database(path.join(stateDir, "friday.db"), { readonly: true, fileMustExist: true });
}

function withStateDb<T>(stateDir: string, fn: (db: Database.Database) => T): T {
  const db = openStateDb(stateDir);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function readLessonRow(stateDir: string, lessonId: string): {
  id: string;
  fingerprint: string;
  title: string;
  sourceIncidentId: string | null;
} | null {
  return withStateDb(stateDir, (db) =>
    (db
      .prepare(
        `SELECT id, fingerprint, title, source_incident_id AS sourceIncidentId
           FROM learned_lessons
          WHERE id = ?`,
      )
      .get(lessonId) as {
      id: string;
      fingerprint: string;
      title: string;
      sourceIncidentId: string | null;
    } | undefined) ?? null);
}

function readActionRow(stateDir: string, actionId: string): {
  actionId: string;
  status: string;
  outcome: string | null;
} | null {
  return withStateDb(stateDir, (db) =>
    (db
      .prepare(
        `SELECT action_id AS actionId, status, outcome
           FROM auto_fix_actions
          WHERE action_id = ?`,
      )
      .get(actionId) as {
      actionId: string;
      status: string;
      outcome: string | null;
    } | undefined) ?? null);
}

function readIncidentByRunId(stateDir: string, runId: string): {
  incidentId: string;
  category: string;
  severity: string;
  nodeId: string | null;
  contextJson: string;
  status: string;
} | null {
  return withStateDb(stateDir, (db) =>
    (db
      .prepare(
        `SELECT incident_id AS incidentId,
                category,
                severity,
                node_id AS nodeId,
                context_json AS contextJson,
                status
           FROM error_incidents
          WHERE run_id = ?
          ORDER BY created_at DESC
          LIMIT 1`,
      )
      .get(runId) as {
      incidentId: string;
      category: string;
      severity: string;
      nodeId: string | null;
      contextJson: string;
      status: string;
    } | undefined) ?? null);
}

function readLatestAgentLoopRun(stateDir: string): {
  status: string;
  riskTier: number;
  approvalRequired: number;
} | null {
  return withStateDb(stateDir, (db) =>
    (db
      .prepare(
        `SELECT status,
                risk_tier AS riskTier,
                approval_required AS approvalRequired
           FROM friday_agent_loop_runs
          ORDER BY created_at DESC
          LIMIT 1`,
      )
      .get() as {
      status: string;
      riskTier: number;
      approvalRequired: number;
    } | undefined) ?? null);
}

function readLessonDisableFact(
  stateDir: string,
  userId: string,
  lessonId: string,
): { key: string; valueJson: string } | null {
  return withStateDb(stateDir, (db) =>
    (db
      .prepare(
        `SELECT key, value_json AS valueJson
           FROM preference_facts
          WHERE user_id = ? AND key = ?`,
      )
      .get(userId, `lesson_disabled:${lessonId}`) as {
      key: string;
      valueJson: string;
    } | undefined) ?? null);
}

function buildBundledNodeSkillManifest(skillId: string, version = "1.0.0"): Record<string, unknown> {
  return {
    schemaVersion: "2.0",
    id: skillId,
    name: skillId,
    description: `Temporary live E2E skill for ${skillId}`,
    version,
    kind: "workflow",
    category: "automation",
    author: { name: "Friday" },
    tags: ["generated", "e2e"],
    runtime: {
      kind: "node",
      entrypoint: "index.mjs",
      minHubVersion: "1.0.0",
      apiVersion: "1",
      timeoutMsDefault: 30_000,
    },
    triggers: {
      intents: [skillId],
      phrases: [skillId],
      channels: ["*"],
    },
    invocation: {
      userInvocable: true,
      modelInvocable: true,
      priority: 50,
      modes: ["intent"],
    },
    requirements: {
      bins: [],
      env: [],
      config: [],
      os: ["darwin", "linux", "win32"],
      mcpServers: [],
    },
    inputs: [],
    outputs: [],
    permissions: {
      grants: [],
      promptOn: [],
    },
    schemas: null,
    flow: null,
    executionTargets: {
      allowedSatelliteTypes: ["desktop", "cloud-vm"],
      requiredCapabilities: [],
    },
    telemetry: {
      events: [],
    },
  };
}

function writeBundledNodeSkill(input: {
  skillId: string;
  code: string;
  manifest?: Record<string, unknown>;
}): string {
  const skillDir = path.join(BUNDLED_SKILLS_DIR, input.skillId);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "index.mjs"), input.code, "utf8");
  fs.writeFileSync(
    path.join(skillDir, "skill.manifest.json"),
    JSON.stringify(input.manifest ?? buildBundledNodeSkillManifest(input.skillId), null, 2),
    "utf8",
  );
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `# ${input.skillId}\n\nTemporary live E2E skill.\n`,
    "utf8",
  );
  return skillDir;
}

function removeBundledSkill(skillId: string): void {
  fs.rmSync(path.join(BUNDLED_SKILLS_DIR, skillId), { recursive: true, force: true });
}

function makeFailingActionGraph(
  workflowId: string,
  versionId: string,
  skillId: string,
): FridayCompiledWorkflowGraphV2 {
  return {
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
          label: "Broken Action",
          config: {
            skillId,
          },
        },
      ],
      edges: [{ id: "e1", sourceNodeId: "trigger", targetNodeId: "action1" }],
    },
    failurePolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
    checksum: "placeholder",
  };
}

async function readUserId(env: RealHubEnv): Promise<string> {
  const { status, json } = await apiFetch<{
    ok: boolean;
    data: { user: { id: string } };
  }>(env.baseUrl, env.accessToken, "GET", "/v1/auth/me");
  if (status !== 200 || !json.ok || typeof json.data.user.id !== "string") {
    throw new Error(`Failed to resolve authenticated user: ${JSON.stringify(json)}`);
  }
  return json.data.user.id;
}

async function createProviderPair(env: RealHubEnv): Promise<{ primaryProviderId: string; secondaryProviderId: string }> {
  // Branch on LIVE_PROVIDER_KIND to create the active-lane primary +
  // secondary provider pair. Mirrors learning-live's ensureLiveLearningProvider
  // pattern. Provider names embed LIVE_PROVIDER_LABEL so the persisted rows
  // are diagnosable per lane.
  const create = async (name: string): Promise<string> =>
    LIVE_PROVIDER_KIND === "deepseek"
      ? createDeepSeekProvider(env.baseUrl, env.accessToken, {
          name,
          deepSeekBaseUrl: DEEPSEEK_BASE_URL,
          models: [LIVE_MODEL],
          defaultModel: LIVE_MODEL,
          apiKeyEnvRef: `$${DEEPSEEK_API_KEY_ENV}`,
        })
      : createOpenAiProvider(env.baseUrl, env.accessToken, {
          name,
          openAiBaseUrl: OPENAI_BASE_URL,
          models: [LIVE_MODEL],
          defaultModel: LIVE_MODEL,
          apiKeyEnvRef: `$${OPENAI_API_KEY_ENV}`,
        });

  const primaryProviderId = await create(`${LIVE_PROVIDER_LABEL} Primary Self-Healing (Live Proof)`);
  const secondaryProviderId = await create(`${LIVE_PROVIDER_LABEL} Secondary Self-Healing (Live Proof)`);
  await verifyProviderTextCapability(env.baseUrl, env.accessToken, primaryProviderId, LIVE_MODEL, {
    doctorProviderIds: [primaryProviderId, secondaryProviderId],
  });
  await verifyProviderTextCapability(env.baseUrl, env.accessToken, secondaryProviderId, LIVE_MODEL, { runDoctor: false });
  return { primaryProviderId, secondaryProviderId };
}

async function putRouting(
  env: RealHubEnv,
  input: { defaultProviderId: string; defaultModel?: string; fallbackProviderIds?: string[] },
): Promise<void> {
  const { status, json } = await apiFetch<{ ok: boolean }>(
    env.baseUrl,
    env.accessToken,
    "PUT",
    "/v1/model-routing",
    input,
  );
  if (status !== 200 || !json.ok) {
    throw new Error(`Failed to update routing: ${JSON.stringify(json)}`);
  }
}

async function getRouting(env: RealHubEnv): Promise<RoutingSnapshot> {
  const { status, json } = await apiFetch<{
    ok: boolean;
    data: {
      routing: {
        defaultProviderId: string;
        defaultModel?: string;
        fallbackProviderIds?: string[];
      };
    };
  }>(env.baseUrl, env.accessToken, "GET", "/v1/model-routing");
  if (status !== 200 || !json.ok) {
    throw new Error(`Failed to read routing: ${JSON.stringify(json)}`);
  }
  return {
    defaultProviderId: json.data.routing.defaultProviderId,
    defaultModel: json.data.routing.defaultModel,
    fallbackProviderIds: json.data.routing.fallbackProviderIds ?? [],
  };
}

async function putAgentLoopPolicy(
  env: RealHubEnv,
  input: { autoApplyLowRisk: boolean; paused?: boolean },
): Promise<void> {
  const { status, json } = await apiFetch<{ ok: boolean }>(
    env.baseUrl,
    env.accessToken,
    "PUT",
    "/v1/agent-loop/policy",
    input,
  );
  if (status !== 200 || !json.ok) {
    throw new Error(`Failed to update agent-loop policy: ${JSON.stringify(json)}`);
  }
}

async function listActionForIncident(
  env: RealHubEnv,
  incidentId: string,
): Promise<AutoFixActionRecord | null> {
  const { status, json } = await apiFetch<{
    ok: boolean;
    data?: { items?: AutoFixActionRecord[] };
  }>(
    env.baseUrl,
    env.accessToken,
    "GET",
    `/v1/auto-fix/actions?incidentId=${encodeURIComponent(incidentId)}`,
  );
  if (status !== 200 || !json.ok) {
    throw new Error(`Failed to list auto-fix actions: ${JSON.stringify(json)}`);
  }
  return json.data?.items?.[0] ?? null;
}

async function getAction(
  env: RealHubEnv,
  actionId: string,
): Promise<AutoFixActionRecord> {
  const { status, json } = await apiFetch<{
    ok: boolean;
    data: AutoFixActionRecord;
  }>(env.baseUrl, env.accessToken, "GET", `/v1/auto-fix/actions/${encodeURIComponent(actionId)}`);
  if (status !== 200 || !json.ok) {
    throw new Error(`Failed to read auto-fix action: ${JSON.stringify(json)}`);
  }
  return json.data;
}

async function getIncidentDiagnosis(
  env: RealHubEnv,
  incidentId: string,
): Promise<DiagnosisDetails> {
  const { status, json } = await apiFetch<{
    ok: boolean;
    data: DiagnosisDetails;
  }>(
    env.baseUrl,
    env.accessToken,
    "GET",
    `/v1/diagnosis/incidents/${encodeURIComponent(incidentId)}/diagnosis`,
  );
  if (status !== 200 || !json.ok) {
    throw new Error(`Failed to read incident diagnosis: ${JSON.stringify(json)}`);
  }
  return json.data;
}

async function getLearningOverview(
  env: RealHubEnv,
): Promise<LearningOverview> {
  const { status, json } = await apiFetch<{
    ok: boolean;
    data: LearningOverview;
  }>(env.baseUrl, env.accessToken, "GET", "/v1/diagnosis/learning/overview?limit=50");
  if (status !== 200 || !json.ok) {
    throw new Error(`Failed to read learning overview: ${JSON.stringify(json)}`);
  }
  return json.data;
}

async function waitForAgentLoopRunVerified(
  env: RealHubEnv,
  actionId: string,
): Promise<void> {
  await pollUntil(
    async () => {
      const { status, json } = await apiFetch<{
        ok: boolean;
        data?: {
          items?: Array<{
            run?: { status?: string };
            action?: { summary?: { actionId?: string } } | null;
          }>;
        };
      }>(env.baseUrl, env.accessToken, "GET", "/v1/agent-loop/runs?limit=20");
      if (status !== 200 || !json.ok) {
        throw new Error(`Failed to list agent-loop runs: ${JSON.stringify(json)}`);
      }
      return json.data?.items?.find((item) => item.action?.summary?.actionId === actionId) ?? null;
    },
    (item) => item?.run?.status === "verified",
    { intervalMs: 300, maxMs: 20_000 },
  );
}

async function approveIfNeeded(
  env: RealHubEnv,
  actionId: string,
): Promise<void> {
  const current = await getAction(env, actionId);
  if (current.approval?.status !== "pending") {
    return;
  }
  const { status, json } = await apiFetch<{ ok: boolean }>(
    env.baseUrl,
    env.accessToken,
    "POST",
    `/v1/auto-fix/actions/${encodeURIComponent(actionId)}/approve`,
    { reason: "Approve deep self-healing proof" },
  );
  if (status !== 200 || !json.ok) {
    throw new Error(`Failed to approve auto-fix action: ${JSON.stringify(json)}`);
  }
}

async function executeOrObserveApprovedAction(
  env: RealHubEnv,
  actionId: string,
): Promise<AutoFixActionRecord> {
  await approveIfNeeded(env, actionId);
  const current = await getAction(env, actionId);
  if (current.action.status !== "planned") {
    return current;
  }
  const { status, json } = await apiFetch<{
    ok: boolean;
    data: {
      action: AutoFixActionRecord;
      result: {
        success: boolean;
        verificationPassed: boolean;
        rollbackAttempted?: boolean;
        rollbackSucceeded?: boolean;
      };
    };
  }>(
    env.baseUrl,
    env.accessToken,
    "POST",
    `/v1/auto-fix/actions/${encodeURIComponent(actionId)}/execute`,
  );
  if (status !== 200 || !json.ok) {
    throw new Error(`Failed to execute auto-fix action: ${JSON.stringify(json)}`);
  }
  expect(json.data.result.success).toBe(true);
  expect(json.data.result.verificationPassed).toBe(true);
  return json.data.action;
}

async function setLessonEnabled(
  env: RealHubEnv,
  lessonId: string,
  enabled: boolean,
  reason: string,
): Promise<void> {
  const { status, json } = await apiFetch<{
    ok: boolean;
    data: {
      lesson: {
        lesson: { id: string };
        disabled: boolean;
      };
    };
  }>(
    env.baseUrl,
    env.accessToken,
    "POST",
    `/v1/diagnosis/lessons/${encodeURIComponent(lessonId)}/enabled`,
    { enabled, reason },
  );
  if (status !== 200 || !json.ok) {
    throw new Error(`Failed to toggle lesson state: ${JSON.stringify(json)}`);
  }
  expect(json.data.lesson.lesson.id).toBe(lessonId);
  expect(json.data.lesson.disabled).toBe(!enabled);
}

async function waitForWorkflowRunStable(
  env: RealHubEnv,
  runId: string,
  timeoutMs = 10_000,
): Promise<string> {
  const start = Date.now();
  const transient = new Set(["pending", "queued", "running"]);
  while (Date.now() - start < timeoutMs) {
    const run = env.hub!.workflowRuntime.execution.getRun(runId);
    if (run && !transient.has(run.status)) {
      return run.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return env.hub!.workflowRuntime.execution.getRun(runId)?.status ?? "unknown";
}

describe.skipIf(!SELF_HEALING_PROOF_GATED)(`Friday Self-Healing Full Matrix (${LIVE_PROVIDER_LABEL} API key)`, () => {
  let env: RealHubEnv;
  let userId: string;
  let primaryProviderId: string;
  let secondaryProviderId: string;
  let learnedMessage: string;
  let learnedLessonId: string | null = null;

  beforeAll(async () => {
    env = await createRealHubEnv();
    userId = await readUserId(env);
    ({ primaryProviderId, secondaryProviderId } = await createProviderPair(env));
    learnedMessage = `Synthetic self-healing recurrence ${Date.now().toString(36)}`;
  }, 90_000);

  afterAll(async () => {
    await cleanupRealHubEnv(env);
  }, 30_000);

  it(
    "auto-applies a low-risk fallback fix, writes a lesson, and changes the next action via lesson readback",
    async () => {
      await putRouting(env, {
        defaultProviderId: primaryProviderId,
        defaultModel: LIVE_MODEL,
        fallbackProviderIds: [secondaryProviderId],
      });
      await putAgentLoopPolicy(env, { autoApplyLowRisk: true, paused: false });

      const first = env.hub!.selfHealing.reportStructuredFailure({
        userId,
        category: "model",
        severity: "medium",
        message: learnedMessage,
        correlationId: `self-heal-live-${Date.now().toString(36)}`,
        context: {
          source: "assistant",
          providerId: primaryProviderId,
          actualProviderId: primaryProviderId,
          model: LIVE_MODEL,
          actualModel: LIVE_MODEL,
          fallbackProviderIds: [secondaryProviderId],
          enforceRequestedModel: false,
        },
      });

      expect(first.incidentsCreated.length).toBeGreaterThan(0);
      const firstIncidentId = first.incidentsCreated[0]!.incidentId;

      const firstAction = await pollUntil(
        async () => listActionForIncident(env, firstIncidentId),
        (record) =>
          record !== null
          && record.summary.status === "applied"
          && record.evidence.acceptanceResult.passed === true
          && typeof record.evidence.extractedLesson?.id === "string",
        { intervalMs: 300, maxMs: 20_000 },
      );

      const firstActionDetails = await getAction(env, firstAction.summary.actionId);
      expect(firstActionDetails.action.plan.evidence.matchedLessonIds).toEqual([]);
      expect(firstActionDetails.summary.rollbackPlanAvailable).toBe(true);
      expect(firstActionDetails.action.status).toBe("applied");
      expect(firstActionDetails.action.outcome).toBe("success");
      expect(firstActionDetails.evidence.rollbackResult.available).toBe(true);

      learnedLessonId = firstAction.evidence.extractedLesson?.id ?? null;
      expect(learnedLessonId).toBeTruthy();

      const lessonRow = readLessonRow(env.stateDir!, learnedLessonId!);
      expect(lessonRow?.id).toBe(learnedLessonId);
      expect(lessonRow?.sourceIncidentId).toBe(firstIncidentId);

      await waitForAgentLoopRunVerified(env, firstAction.summary.actionId);

      const routingAfterAutoHeal = await getRouting(env);
      expect(routingAfterAutoHeal.defaultProviderId).toBe(secondaryProviderId);
      expect(routingAfterAutoHeal.fallbackProviderIds).toContain(primaryProviderId);

      const second = env.hub!.selfHealing.reportStructuredFailure({
        userId,
        category: "model",
        severity: "medium",
        message: learnedMessage,
        correlationId: `self-heal-live-repeat-${Date.now().toString(36)}`,
        context: {
          source: "assistant",
          providerId: primaryProviderId,
          actualProviderId: primaryProviderId,
          model: LIVE_MODEL,
          actualModel: LIVE_MODEL,
          fallbackProviderIds: [secondaryProviderId],
          enforceRequestedModel: false,
        },
      });
      const secondIncidentId = second.incidentsCreated[0]!.incidentId;

      const secondDiagnosis = await pollUntil(
        async () => getIncidentDiagnosis(env, secondIncidentId),
        (details) => details.summary.matchedLessonIds.includes(learnedLessonId!),
        { intervalMs: 300, maxMs: 20_000 },
      );

      const secondAction = await pollUntil(
        async () => listActionForIncident(env, secondIncidentId),
        (record) =>
          record !== null
          && record.action.plan.evidence.matchedLessonIds.includes(learnedLessonId!),
        { intervalMs: 300, maxMs: 20_000 },
      );

      expect(secondDiagnosis.summary.recurrenceCount).toBeGreaterThanOrEqual(2);
      expect(secondDiagnosis.summary.matchedLessonIds).toContain(learnedLessonId);

      const secondActionDetails = await getAction(env, secondAction.summary.actionId);
      expect(secondActionDetails.action.plan.evidence.matchedLessonIds).toEqual([learnedLessonId!]);
      expect(secondActionDetails.action.plan.evidence.fingerprint).toBe(
        firstActionDetails.action.plan.evidence.fingerprint,
      );

      const overview = await getLearningOverview(env);
      expect(overview.lessons.some((item) => item.lesson.id === learnedLessonId && item.disabled !== true)).toBe(true);
    },
    120_000,
  );

  it(
    "executes and rolls back a self-healing fallback action over real HTTP",
    async () => {
      await putRouting(env, {
        defaultProviderId: primaryProviderId,
        defaultModel: LIVE_MODEL,
        fallbackProviderIds: [secondaryProviderId],
      });
      await putAgentLoopPolicy(env, { autoApplyLowRisk: false, paused: false });

      const processResult = env.hub!.selfHealing.reportStructuredFailure({
        userId,
        category: "model",
        severity: "medium",
        message: `Synthetic fallback rollback ${Date.now().toString(36)}`,
        correlationId: `self-heal-rollback-${Date.now().toString(36)}`,
        context: {
          source: "assistant",
          providerId: primaryProviderId,
          actualProviderId: primaryProviderId,
          model: LIVE_MODEL,
          actualModel: LIVE_MODEL,
          fallbackProviderIds: [secondaryProviderId],
          enforceRequestedModel: false,
        },
      });

      const incidentId = processResult.incidentsCreated[0]!.incidentId;
      const actionRecord = await pollUntil(
        async () => listActionForIncident(env, incidentId),
        (record) => record !== null && record.summary.status === "planned",
        { intervalMs: 300, maxMs: 20_000 },
      );
      const actionId = actionRecord.summary.actionId;
      expect(actionRecord.summary.rollbackPlanAvailable).toBe(true);
      expect(actionRecord.evidence.rollbackResult.available).toBe(true);

      const { status: executeStatus, json: executeJson } = await apiFetch<{
        ok: boolean;
        data: {
          action: AutoFixActionRecord;
          result: {
            success: boolean;
            verificationPassed: boolean;
            rollbackAttempted: boolean;
            rollbackSucceeded: boolean;
          };
        };
      }>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/auto-fix/actions/${encodeURIComponent(actionId)}/execute`,
      );
      expect(executeStatus).toBe(200);
      expect(executeJson.ok).toBe(true);
      expect(executeJson.data.action.summary.status).toBe("applied");
      expect(executeJson.data.result.success).toBe(true);
      expect(executeJson.data.result.verificationPassed).toBe(true);
      expect(executeJson.data.result.rollbackAttempted).toBe(false);

      const routingAfterExecute = await getRouting(env);
      expect(routingAfterExecute.defaultProviderId).toBe(secondaryProviderId);
      expect(readActionRow(env.stateDir!, actionId)?.status).toBe("applied");

      const { status: rollbackStatus, json: rollbackJson } = await apiFetch<{
        ok: boolean;
        data: {
          action: AutoFixActionRecord;
          result: {
            rollbackAttempted: boolean;
            rollbackSucceeded: boolean;
          };
        };
      }>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/auto-fix/actions/${encodeURIComponent(actionId)}/rollback`,
        { reason: "Verify rollback in deep self-healing proof" },
      );
      expect(rollbackStatus).toBe(200);
      expect(rollbackJson.ok).toBe(true);
      expect(rollbackJson.data.action.summary.status).toBe("rolled_back");
      expect(rollbackJson.data.action.evidence.rollbackResult.rollbackAttempted).toBe(true);
      expect(rollbackJson.data.action.evidence.rollbackResult.rollbackSucceeded).toBe(true);
      expect(rollbackJson.data.result.rollbackAttempted).toBe(true);
      expect(rollbackJson.data.result.rollbackSucceeded).toBe(true);

      const routingAfterRollback = await getRouting(env);
      expect(routingAfterRollback.defaultProviderId).toBe(primaryProviderId);
      expect(routingAfterRollback.fallbackProviderIds).toEqual([secondaryProviderId]);
      expect(readActionRow(env.stateDir!, actionId)?.status).toBe("rolled_back");
    },
    120_000,
  );

  it(
    "supports anti-learning by disabling a lesson and suppressing future lesson matches for the same fingerprint",
    async () => {
      expect(learnedLessonId).toBeTruthy();
      const lessonId = learnedLessonId!;

      await setLessonEnabled(env, lessonId, false, "Deep self-healing anti-learning proof");
      const disabledFact = readLessonDisableFact(env.stateDir!, userId, lessonId);
      expect(disabledFact?.key).toBe(`lesson_disabled:${lessonId}`);

      const overview = await getLearningOverview(env);
      expect(overview.lessons.some((item) => item.lesson.id === lessonId && item.disabled === true)).toBe(true);
      const lessonRow = readLessonRow(env.stateDir!, lessonId);

      const repeated = env.hub!.selfHealing.reportStructuredFailure({
        userId,
        category: "model",
        severity: "medium",
        message: learnedMessage,
        correlationId: `self-heal-disabled-${Date.now().toString(36)}`,
        context: {
          source: "assistant",
          providerId: primaryProviderId,
          actualProviderId: primaryProviderId,
          model: LIVE_MODEL,
          actualModel: LIVE_MODEL,
          fallbackProviderIds: [secondaryProviderId],
          enforceRequestedModel: false,
        },
      });
      const incidentId =
        repeated.incidentsCreated[0]?.incidentId
        ?? env.hub!.selfHealing.listIncidents({ userId, limit: 50 })
          .find((details) => details.incident.signature === lessonRow?.fingerprint)
          ?.incident.incidentId;
      expect(incidentId).toBeTruthy();

      const diagnosis = await pollUntil(
        async () => getIncidentDiagnosis(env, incidentId!),
        (details) => details.diagnosis !== null,
        { intervalMs: 300, maxMs: 20_000 },
      );
      expect(diagnosis.summary.matchedLessonIds.includes(lessonId)).toBe(false);

      if (repeated.incidentsCreated.length > 0) {
        const action = await pollUntil(
          async () => listActionForIncident(env, incidentId!),
          (record) => record !== null,
          { intervalMs: 300, maxMs: 20_000 },
        );
        expect(action.action.plan.evidence.matchedLessonIds.includes(lessonId)).toBe(false);
      }
    },
    120_000,
  );

  it(
    "records a real workflow failure as a self-healing incident and loop run",
    async () => {
      await putAgentLoopPolicy(env, { autoApplyLowRisk: false, paused: false });

      const missingSkillId = `e2e-self-heal-missing-skill-${Date.now().toString(36)}`;
      const workflow = env.hub!.workflowRuntime.crud.createWorkflow({
        slug: missingSkillId,
        name: "Workflow Self-Healing Live Missing Skill",
      });
      const version = env.hub!.workflowRuntime.crud.createVersion(
        workflow.id,
        makeFailingActionGraph(workflow.id, "placeholder", missingSkillId),
      );
      env.hub!.workflowRuntime.crud.publishVersion(workflow.id, version.versionNumber);

      const run = await env.hub!.workflowRuntime.execution.startRun({
        workflowId: workflow.id,
        workflowVersionId: version.id,
        triggerType: "manual",
        startedByUserId: userId,
      });

      const failedStatus = await waitForWorkflowRunStable(env, run.id, 10_000);
      expect(failedStatus).toBe("failed");

      const incident = await pollUntil(
        async () => readIncidentByRunId(env.stateDir!, run.id),
        (details) => details != null,
        { intervalMs: 300, maxMs: 30_000 },
      );
      expect(incident.category).toBe("workflow");
      expect(incident.severity).toBe("medium");
      expect(incident.nodeId).toBe("action1");
      const context = JSON.parse(incident.contextJson) as Record<string, unknown>;
      expect(context["source"]).toBe("workflow_runtime");
      expect(context["workflowId"]).toBe(workflow.id);
      expect(context["failedNodeId"]).toBe("action1");

      const loopRun = await pollUntil(
        async () => readLatestAgentLoopRun(env.stateDir!),
        (details) => details != null,
        { intervalMs: 300, maxMs: 10_000 },
      );
      expect(loopRun.riskTier).toBeGreaterThanOrEqual(0);
      expect(["verified", "awaiting_approval", "paused", "cooldown", "running", "failed", "halted"]).toContain(
        loopRun.status,
      );
    },
    120_000,
  );

  it(
    "turns a real skill verification drift into a disable-skill self-healing action that verifies",
    async () => {
      await putAgentLoopPolicy(env, { autoApplyLowRisk: false, paused: false });

      const skillId = `e2e-skill-drift-${Date.now().toString(36)}`;
      const skillDir = writeBundledNodeSkill({
        skillId,
        code: `
export async function execute() {
  return { ok: true };
}
`.trim(),
      });
      await env.hub!.skills.refresh();

      const manifestPath = path.join(skillDir, "skill.manifest.json");
      const originalManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      const missingBin = `friday-missing-bin-${Date.now().toString(36)}`;
      const brokenManifest = {
        ...originalManifest,
        requirements: {
          bins: [missingBin],
          env: [],
          config: [],
          os: ["darwin", "linux", "win32"],
          mcpServers: [],
        },
      };
      fs.writeFileSync(manifestPath, JSON.stringify(brokenManifest, null, 2), "utf8");
      await env.hub!.skills.refresh();

      try {
        const { status: verifyStatus, json: verifyJson } = await apiFetch<{
          ok?: boolean;
          data?: {
            evidence?: {
              ok: boolean;
              dependencyCheck?: {
                missingBins?: string[];
              };
            };
          };
        }>(
          env.baseUrl,
          env.accessToken,
          "POST",
          `/v1/skills/${encodeURIComponent(skillId)}/verify`,
        );
        expect(verifyStatus).toBe(200);
        expect(verifyJson.ok).toBe(true);
        expect(verifyJson.data?.evidence?.ok).toBe(false);
        expect(verifyJson.data?.evidence?.dependencyCheck?.missingBins).toContain(missingBin);

        const incident = await pollUntil(
          async () =>
            env.hub!.selfHealing.listIncidents({ userId, limit: 50 }).find((item) =>
              item.incident.context?.source === "skills_lifecycle"
              && item.incident.context?.skillId === skillId
              && item.incident.context?.stage === "verify"),
          (details) => details != null,
          { intervalMs: 300, maxMs: 20_000 },
        );

        const actionDetails = await pollUntil(
          async () => listActionForIncident(env, incident.incident.incidentId),
          (details) =>
            details != null
            && details.action.status === "planned"
            && details.action.plan.steps[0]?.kind === "disable_skill"
            && details.action.plan.steps[0]?.target === skillId,
          { intervalMs: 300, maxMs: 20_000 },
        );

        const executedAction = await executeOrObserveApprovedAction(env, actionDetails.summary.actionId);
        expect(executedAction.summary.status).toBe("applied");
        expect(executedAction.evidence.acceptanceResult.passed).toBe(true);

        await env.hub!.skills.refresh();
        const { status: getSkillStatus, json: getSkillJson } = await apiFetch<{
          ok: boolean;
          data: { skill: { skillId: string; status: string } };
        }>(env.baseUrl, env.accessToken, "GET", `/v1/skills/${encodeURIComponent(skillId)}`);
        expect(getSkillStatus).toBe(200);
        expect(getSkillJson.ok).toBe(true);
        expect(getSkillJson.data.skill.skillId).toBe(skillId);
        expect(getSkillJson.data.skill.status).toBe("disabled");
      } finally {
        fs.writeFileSync(manifestPath, JSON.stringify(originalManifest, null, 2), "utf8");
        removeBundledSkill(skillId);
        await env.hub!.skills.refresh();
      }
    },
    120_000,
  );
});
