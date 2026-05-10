import Database from "better-sqlite3";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { apiFetch } from "./_helpers/api.js";
import { pollRunTerminal } from "./_helpers/workflow.js";
import {
  cleanupFridayDeepProofHubEnv,
  createFridayDeepProofHubEnv,
  ensureFridayDeepProofProviders,
  FRIDAY_DEEP_PROOF_GATED,
  FRIDAY_DEEP_PROOF_MODEL,
  FRIDAY_DEEP_PROOF_PROVIDER_LABEL,
  type RealHubEnv,
} from "./_helpers/deep-proof-env.js";

interface WorkflowCreateEnvelope {
  ok: boolean;
  data: {
    workflow: { id: string; slug: string };
    version: { id: string; versionNumber: number };
  };
}

interface WorkflowGetEnvelope {
  ok: boolean;
  data: {
    workflow: {
      id: string;
      latestVersionNumber: number;
      publishedVersionNumber?: number;
      compatibilityStatus?: string;
      promotionChannel?: string;
      shadowVersionId?: string;
      canaryStats?: {
        sampleSize: number;
        successCount: number;
        failureCount: number;
        rollbackCount: number;
      };
    };
    latestVersion: { id: string; versionNumber: number };
    publishedVersion?: { id: string; versionNumber: number };
  };
}

interface WorkflowUpdateEnvelope {
  ok: boolean;
  data: {
    workflow: { id: string; latestVersionNumber: number; publishedVersionNumber?: number };
    version?: { id: string; versionNumber: number };
  };
}

interface WorkflowRunEnvelope {
  ok: boolean;
  data: {
    run: { id: string; status: string; workflowVersionId?: string };
  };
}

interface WorkflowRunNodesEnvelope {
  ok: boolean;
  data: {
    items: Array<{ nodeId: string; status: string; output: unknown }>;
  };
}

interface UpgradeStatusEnvelope {
  ok: boolean;
  data: {
    items: Array<{
      kind: string;
      id: string;
      compatibilityStatus: string;
      promotionChannel: string;
      shadowVersionId?: string;
      canaryStats?: {
        sampleSize: number;
        successCount: number;
        failureCount: number;
        rollbackCount: number;
      };
      recordedCompatibilityStatus: string;
      derivedCompatibilityStatus: string;
      strategy: string;
      nextStage: string;
      findings: Array<{ id: string; passed: boolean; severity: string }>;
    }>;
  };
}

interface WorkflowActionEnvelope {
  ok: boolean;
  data: {
    workflow: {
      id: string;
      publishedVersionNumber?: number;
      promotionChannel?: string;
      compatibilityStatus?: string;
      shadowVersionId?: string;
      canaryStats?: {
        sampleSize: number;
        successCount: number;
        failureCount: number;
        rollbackCount: number;
      };
    };
    status: UpgradeStatusEnvelope["data"]["items"][number] | null;
  };
}

interface RuntimeVersionEnvelope {
  ok: boolean;
  data: {
    version: string;
    apiVersion: string;
  };
}

interface WorkflowRowReadback {
  latestVersionNumber: number;
  publishedVersionNumber: number | null;
  compatibilityStatus: string;
  promotionChannel: string;
  shadowVersionId: string | null;
  canaryStatsJson: string;
}

interface WorkflowVersionRowReadback {
  id: string;
  versionNumber: number;
  isPublished: number;
}

function openStateDb(stateDir: string): Database.Database {
  return new Database(path.join(stateDir, "friday.db"), { readonly: true, fileMustExist: true });
}

function readWorkflowRow(stateDir: string, workflowId: string): WorkflowRowReadback | null {
  const db = openStateDb(stateDir);
  try {
    return (
      db
        .prepare(
          `SELECT latest_version_number AS latestVersionNumber,
                  published_version_number AS publishedVersionNumber,
                  compatibility_status AS compatibilityStatus,
                  promotion_channel AS promotionChannel,
                  shadow_version_id AS shadowVersionId,
                  canary_stats_json AS canaryStatsJson
             FROM workflows
            WHERE id = ?`,
        )
        .get(workflowId) as WorkflowRowReadback | undefined
    ) ?? null;
  } finally {
    db.close();
  }
}

function readWorkflowVersions(stateDir: string, workflowId: string): WorkflowVersionRowReadback[] {
  const db = openStateDb(stateDir);
  try {
    return db
      .prepare(
        `SELECT id,
                version_number AS versionNumber,
                is_published AS isPublished
           FROM workflow_versions
          WHERE workflow_id = ?
          ORDER BY version_number ASC`,
      )
      .all(workflowId) as WorkflowVersionRowReadback[];
  } finally {
    db.close();
  }
}

async function ensureWorkflowDeepProofProviders(env: RealHubEnv): Promise<void> {
  await ensureFridayDeepProofProviders(env, {
    namePrefix: "Workflow Self Upgrade Deep Proof",
  });
}

async function getRuntimeVersion(env: RealHubEnv): Promise<string> {
  const response = await apiFetch<RuntimeVersionEnvelope>(
    env.baseUrl,
    env.accessToken,
    "GET",
    "/v1/version",
  );
  expect(response.status).toBe(200);
  expect(response.json.ok).toBe(true);
  return response.json.data.version;
}

async function createBaseWorkflow(
  env: RealHubEnv,
  slug: string,
): Promise<{ workflowId: string; versionId: string }> {
  const createRes = await apiFetch<WorkflowCreateEnvelope>(
    env.baseUrl,
    env.accessToken,
    "POST",
    "/v1/workflows",
    {
      slug,
      name: `Workflow Self Upgrade ${slug}`,
      description: "Baseline workflow before self-upgrade.",
      graph: {
        nodes: [
          {
            id: "trigger1",
            type: "trigger",
            label: "Manual Trigger",
            config: { triggerType: "manual" },
          },
          {
            id: "data1",
            type: "data",
            label: "Baseline Output",
            config: {
              mapping: {
                version: "one",
                message: "version one",
              },
            },
          },
        ],
        edges: [
          { id: "edge-trigger-data", sourceNodeId: "trigger1", targetNodeId: "data1" },
        ],
      },
    },
  );
  expect(createRes.status).toBe(200);
  expect(createRes.json.ok).toBe(true);

  const publishRes = await apiFetch<{ ok: boolean }>(
    env.baseUrl,
    env.accessToken,
    "POST",
    `/v1/workflows/${encodeURIComponent(createRes.json.data.workflow.id)}/publish`,
    { versionNumber: 1 },
  );
  expect(publishRes.status).toBe(200);
  expect(publishRes.json.ok).toBe(true);

  return {
    workflowId: createRes.json.data.workflow.id,
    versionId: createRes.json.data.version.id,
  };
}

async function createUpgradeVersion(
  env: RealHubEnv,
  workflowId: string,
): Promise<{ versionId: string; versionNumber: number }> {
  const before = await apiFetch<WorkflowGetEnvelope>(
    env.baseUrl,
    env.accessToken,
    "GET",
    `/v1/workflows/${encodeURIComponent(workflowId)}`,
  );
  expect(before.status).toBe(200);
  expect(before.json.ok).toBe(true);

  const updateRes = await apiFetch<WorkflowUpdateEnvelope>(
    env.baseUrl,
    env.accessToken,
    "PATCH",
    `/v1/workflows/${encodeURIComponent(workflowId)}`,
    {
      expectedRevision: before.json.data.workflow.latestVersionNumber,
      etag: (before.json.data.workflow as unknown as { etag?: string }).etag ?? "\"missing-etag\"",
      name: `Workflow Self Upgrade ${workflowId}`,
      description: "Upgraded workflow with Anthropic replay lane.",
      graph: {
        nodes: [
          {
            id: "trigger1",
            type: "trigger",
            label: "Manual Trigger",
            config: { triggerType: "manual" },
          },
          {
            id: "ai1",
            type: "ai",
            label: "Anthropic Upgrade Probe",
            config: {
              prompt: "Reply with the exact text: upgraded by anthropic",
              model: FRIDAY_DEEP_PROOF_MODEL,
            },
          },
          {
            id: "data1",
            type: "data",
            label: "Upgrade Output",
            config: {
              mapping: {
                version: "two",
                providerProof: "$steps.ai1.output",
              },
            },
          },
        ],
        edges: [
          { id: "edge-trigger-ai", sourceNodeId: "trigger1", targetNodeId: "ai1" },
          { id: "edge-ai-data", sourceNodeId: "ai1", targetNodeId: "data1" },
        ],
      },
    },
  );
  expect(updateRes.status).toBe(200);
  expect(updateRes.json.ok).toBe(true);
  expect(updateRes.json.data.version).toBeTruthy();

  return {
    versionId: updateRes.json.data.version!.id,
    versionNumber: updateRes.json.data.version!.versionNumber,
  };
}

async function getWorkflow(env: RealHubEnv, workflowId: string): Promise<WorkflowGetEnvelope["data"]> {
  const response = await apiFetch<WorkflowGetEnvelope>(
    env.baseUrl,
    env.accessToken,
    "GET",
    `/v1/workflows/${encodeURIComponent(workflowId)}`,
  );
  expect(response.status).toBe(200);
  expect(response.json.ok).toBe(true);
  return response.json.data;
}

async function getUpgradeStatus(env: RealHubEnv, workflowId: string): Promise<UpgradeStatusEnvelope["data"]["items"][number]> {
  const response = await apiFetch<UpgradeStatusEnvelope>(
    env.baseUrl,
    env.accessToken,
    "GET",
    `/v1/autonomy/upgrade-status?kind=workflow&id=${encodeURIComponent(workflowId)}`,
  );
  expect(response.status).toBe(200);
  expect(response.json.ok).toBe(true);
  expect(response.json.data.items).toHaveLength(1);
  return response.json.data.items[0]!;
}

async function runWorkflowVersion(
  env: RealHubEnv,
  workflowId: string,
  workflowVersionId?: string,
): Promise<{
  runId: string;
  workflowVersionId?: string;
  dataNodeOutput: unknown;
  aiNodeOutput: unknown;
}> {
  const runRes = await apiFetch<WorkflowRunEnvelope>(
    env.baseUrl,
    env.accessToken,
    "POST",
    "/v1/workflow-runs",
    {
      workflowId,
      workflowVersionId,
      triggerType: "manual",
      triggerPayload: {},
    },
    { timeoutMs: 180_000 },
  );
  expect(runRes.status).toBe(200);
  expect(runRes.json.ok).toBe(true);

  const runId = runRes.json.data.run.id;
  const terminal = await pollRunTerminal(env.baseUrl, env.accessToken, runId, 120_000);
  expect(terminal.run.status).toBe("completed");

  const nodesRes = await apiFetch<WorkflowRunNodesEnvelope>(
    env.baseUrl,
    env.accessToken,
    "GET",
    `/v1/workflow-runs/${encodeURIComponent(runId)}/nodes`,
  );
  expect(nodesRes.status).toBe(200);
  expect(nodesRes.json.ok).toBe(true);

  const dataNode = nodesRes.json.data.items.find((item) => item.nodeId === "data1");
  const aiNode = nodesRes.json.data.items.find((item) => item.nodeId === "ai1");

  expect(dataNode?.status).toBe("completed");
  if (workflowVersionId) {
    expect(aiNode?.status).toBe("completed");
  }

  return {
    runId,
    workflowVersionId: runRes.json.data.run.workflowVersionId,
    dataNodeOutput: dataNode?.output,
    aiNodeOutput: aiNode?.output,
  };
}

describe.skipIf(!FRIDAY_DEEP_PROOF_GATED)(`Friday Workflow Self Upgrade Live (${FRIDAY_DEEP_PROOF_PROVIDER_LABEL})`, () => {
  let env: RealHubEnv;

  beforeAll(async () => {
    env = await createFridayDeepProofHubEnv();
    await ensureWorkflowDeepProofProviders(env);
  }, 120_000);

  afterAll(async () => {
    if (env) {
      await cleanupFridayDeepProofHubEnv(env);
    }
  }, 30_000);

  it(
    "proves workflow detect-adapt-replay-shadow-canary-promote-rollback with API and SQLite readback",
    { timeout: 420_000, retry: 1 },
    async () => {
      const runtimeVersion = await getRuntimeVersion(env);
      const slug = `wf-self-upgrade-${Date.now().toString(36)}`;
      const baseline = await createBaseWorkflow(env, slug);

      const baselineStatus = await getUpgradeStatus(env, baseline.workflowId);
      expect(baselineStatus.derivedCompatibilityStatus).toBe("compatible");
      expect(baselineStatus.strategy).toBe("noop");

      const baselineRun = await runWorkflowVersion(env, baseline.workflowId);
      expect(JSON.stringify(baselineRun.dataNodeOutput)).toContain("version one");

      const upgraded = await createUpgradeVersion(env, baseline.workflowId);
      const afterAdaptWorkflow = await getWorkflow(env, baseline.workflowId);
      expect(afterAdaptWorkflow.workflow.latestVersionNumber).toBe(2);
      expect(afterAdaptWorkflow.workflow.publishedVersionNumber).toBe(1);

      const detectStatus = await getUpgradeStatus(env, baseline.workflowId);
      expect(detectStatus.derivedCompatibilityStatus).toBe("adaptation_required");
      expect(detectStatus.strategy).toBe("regenerate");
      expect(
        detectStatus.findings.some((finding) => finding.id === "workflow_version_gap" && !finding.passed),
      ).toBe(true);

      const shadowRes = await apiFetch<WorkflowActionEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/autonomy/workflows/${encodeURIComponent(baseline.workflowId)}/shadow`,
        {
          workflowVersionId: upgraded.versionId,
          runtimeVersion,
          providerModel: FRIDAY_DEEP_PROOF_MODEL,
        },
      );
      expect(shadowRes.status).toBe(200);
      expect(shadowRes.json.ok).toBe(true);
      expect(shadowRes.json.data.workflow.promotionChannel).toBe("shadow");
      expect(shadowRes.json.data.status?.promotionChannel).toBe("shadow");
      expect(shadowRes.json.data.status?.shadowVersionId).toBe(upgraded.versionId);

      const replayRun = await runWorkflowVersion(env, baseline.workflowId, upgraded.versionId);
      expect(replayRun.workflowVersionId).toBe(upgraded.versionId);
      expect(JSON.stringify(replayRun.dataNodeOutput)).toContain("\"two\"");
      expect(JSON.stringify(replayRun.aiNodeOutput)).not.toHaveLength(0);

      const canaryRes = await apiFetch<WorkflowActionEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/autonomy/workflows/${encodeURIComponent(baseline.workflowId)}/canary`,
        {
          success: true,
        },
      );
      expect(canaryRes.status).toBe(200);
      expect(canaryRes.json.ok).toBe(true);
      expect(canaryRes.json.data.workflow.promotionChannel).toBe("canary");
      expect(canaryRes.json.data.workflow.canaryStats?.sampleSize).toBe(1);
      expect(canaryRes.json.data.workflow.canaryStats?.successCount).toBe(1);

      const promoteRes = await apiFetch<WorkflowActionEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/autonomy/workflows/${encodeURIComponent(baseline.workflowId)}/promote`,
        {
          versionNumber: upgraded.versionNumber,
          runtimeVersion,
          providerModel: FRIDAY_DEEP_PROOF_MODEL,
        },
      );
      expect(promoteRes.status).toBe(200);
      expect(promoteRes.json.ok).toBe(true);
      expect(promoteRes.json.data.workflow.publishedVersionNumber).toBe(2);
      expect(promoteRes.json.data.status?.promotionChannel).toBe("active");
      expect(promoteRes.json.data.status?.derivedCompatibilityStatus).toBe("compatible");

      const activeRun = await runWorkflowVersion(env, baseline.workflowId);
      expect(activeRun.workflowVersionId).toBe(upgraded.versionId);
      expect(JSON.stringify(activeRun.dataNodeOutput)).toContain("\"two\"");

      const rollbackRes = await apiFetch<WorkflowActionEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/autonomy/workflows/${encodeURIComponent(baseline.workflowId)}/rollback`,
        {
          targetVersionNumber: 1,
          runtimeVersion,
          providerModel: FRIDAY_DEEP_PROOF_MODEL,
        },
      );
      expect(rollbackRes.status).toBe(200);
      expect(rollbackRes.json.ok).toBe(true);
      expect(rollbackRes.json.data.workflow.promotionChannel).toBe("rolled_back");
      expect(rollbackRes.json.data.status?.promotionChannel).toBe("rolled_back");
      expect(rollbackRes.json.data.status?.derivedCompatibilityStatus).toBe("adaptation_required");

      const rolledBackRun = await runWorkflowVersion(env, baseline.workflowId);
      expect(rolledBackRun.workflowVersionId).toBe(baseline.versionId);
      expect(JSON.stringify(rolledBackRun.dataNodeOutput)).toContain("version one");

      const workflowRow = readWorkflowRow(env.stateDir!, baseline.workflowId);
      expect(workflowRow).not.toBeNull();
      expect(workflowRow?.publishedVersionNumber).toBe(1);
      expect(workflowRow?.promotionChannel).toBe("rolled_back");
      expect(workflowRow?.compatibilityStatus).toBe("adaptation_required");
      expect(workflowRow?.shadowVersionId).toBeNull();
      const canaryStats = JSON.parse(workflowRow?.canaryStatsJson ?? "{}") as {
        sampleSize?: number;
        successCount?: number;
        rollbackCount?: number;
      };
      expect(canaryStats.sampleSize).toBe(1);
      expect(canaryStats.successCount).toBe(1);
      expect(canaryStats.rollbackCount).toBe(1);

      const versions = readWorkflowVersions(env.stateDir!, baseline.workflowId);
      expect(versions.map((item) => [item.versionNumber, item.isPublished])).toEqual([
        [1, 1],
        [2, 0],
      ]);
    },
  );
});
