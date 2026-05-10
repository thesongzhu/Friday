import Database from "better-sqlite3";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { apiFetch } from "./_helpers/api.js";
import { pollUntil } from "./_helpers/poll.js";
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
      slug: string;
      latestVersionNumber: number;
      publishedVersionNumber?: number;
    };
    latestVersion: { id: string; versionNumber: number };
    publishedVersion?: { id: string; versionNumber: number };
  };
}

interface WorkflowVersionsEnvelope {
  ok: boolean;
  data: {
    items: Array<{ id: string; versionNumber: number; isPublished: boolean }>;
  };
}

interface WorkflowGeneratorSessionEnvelope {
  ok: boolean;
  data: {
    mode: string;
    session: { sessionId: string; status: string };
    draft?: {
      validation?: {
        ok: boolean;
        repaired?: boolean;
        repairAttempts?: number;
        issues?: Array<{ message: string }>;
      };
    };
  };
}

interface WorkflowGeneratorEvidenceEnvelope {
  ok: boolean;
  data: {
    evidence: {
      approvalReadiness: { ready: boolean; reason: string };
      validationSummary: {
        ok: boolean;
        repaired: boolean;
        repairAttempts: number;
        issueCount: number;
      };
      qaVerdict?: { verdict: string; summary: string } | null;
    };
  };
}

interface WorkflowGeneratorApproveEnvelope {
  ok: boolean;
  data: {
    workflowId: string;
    workflowVersionId: string;
    versionNumber: number;
    slug: string;
    published: boolean;
    evidence?: WorkflowGeneratorEvidenceEnvelope["data"]["evidence"];
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

interface WorkflowPublicationRow {
  latestVersionNumber: number;
  publishedVersionNumber: number | null;
}

interface PublishedVersionRow {
  id: string;
  versionNumber: number;
  isPublished: number;
}

interface WorkflowArtifactRow {
  nodeId: string;
  uri: string;
}

function openStateDb(stateDir: string): Database.Database {
  return new Database(path.join(stateDir, "friday.db"), { readonly: true, fileMustExist: true });
}

function readWorkflowPublication(stateDir: string, workflowId: string): WorkflowPublicationRow | null {
  const db = openStateDb(stateDir);
  try {
    return (
      db
        .prepare(
          `SELECT latest_version_number AS latestVersionNumber,
                  published_version_number AS publishedVersionNumber
             FROM workflows
            WHERE id = ?`,
        )
        .get(workflowId) as WorkflowPublicationRow | undefined
    ) ?? null;
  } finally {
    db.close();
  }
}

function readPublishedVersionRow(stateDir: string, workflowId: string, versionNumber: number): PublishedVersionRow | null {
  const db = openStateDb(stateDir);
  try {
    return (
      db
        .prepare(
          `SELECT id,
                  version_number AS versionNumber,
                  is_published AS isPublished
             FROM workflow_versions
            WHERE workflow_id = ? AND version_number = ?`,
        )
        .get(workflowId, versionNumber) as PublishedVersionRow | undefined
    ) ?? null;
  } finally {
    db.close();
  }
}

function readWorkflowArtifactCount(stateDir: string, runId: string): number {
  const db = openStateDb(stateDir);
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM workflow_artifacts
          WHERE run_id = ?`,
      )
      .get(runId) as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

function readWorkflowArtifacts(stateDir: string, runId: string): WorkflowArtifactRow[] {
  const db = openStateDb(stateDir);
  try {
    return db
      .prepare(
        `SELECT node_id AS nodeId,
                uri
           FROM workflow_artifacts
          WHERE run_id = ?
          ORDER BY created_at ASC`,
      )
      .all(runId) as WorkflowArtifactRow[];
  } finally {
    db.close();
  }
}

function decodeArtifactUri(uri: string): string {
  const prefix = "data:application/json;base64,";
  if (!uri.startsWith(prefix)) {
    return uri;
  }
  return Buffer.from(uri.slice(prefix.length), "base64").toString("utf8");
}

async function ensureWorkflowGeneratorDeepProofProviders(env: RealHubEnv): Promise<void> {
  await ensureFridayDeepProofProviders(env, {
    namePrefix: "Workflow Generator Deep Proof",
  });
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
      name: `Workflow Maintenance ${slug}`,
      description: "Baseline workflow before generator maintenance.",
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
            label: "Version One",
            config: { mapping: { message: "version one" } },
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

async function runWorkflowAndReadMessage(
  env: RealHubEnv,
  workflowId: string,
): Promise<{ runId: string; workflowVersionId?: string; message: string; artifactCount: number }> {
  const runRes = await apiFetch<WorkflowRunEnvelope>(
    env.baseUrl,
    env.accessToken,
    "POST",
    "/v1/workflow-runs",
    {
      workflowId,
      triggerType: "manual",
      triggerPayload: {},
    },
    { timeoutMs: 180_000 },
  );
  expect(runRes.status).toBe(200);
  expect(runRes.json.ok).toBe(true);

  const runId = runRes.json.data.run.id;
  const terminal = await pollRunTerminal(env.baseUrl, env.accessToken, runId, 90_000);
  expect(terminal.run.status).toBe("completed");

  const settledEvidence = await pollUntil(
    async () => {
      const nodesRes = await apiFetch<WorkflowRunNodesEnvelope>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/workflow-runs/${encodeURIComponent(runId)}/nodes`,
      );
      const dataNode = nodesRes.status === 200 && nodesRes.json.ok
        ? nodesRes.json.data.items.find(
          (item) => item.status === "completed" && JSON.stringify(item.output ?? {}).includes("\"message\""),
        )
        : undefined;
      const artifacts = readWorkflowArtifacts(env.stateDir!, runId);
      const artifactWithMessage = artifacts.find((item) => decodeArtifactUri(item.uri).includes("\"message\""));
      return {
        dataNode,
        artifactCount: readWorkflowArtifactCount(env.stateDir!, runId),
        artifactWithMessage,
        artifactPayloads: artifacts.map((item) => ({
          nodeId: item.nodeId,
          payload: decodeArtifactUri(item.uri),
        })),
        nodeItems: nodesRes.status === 200 && nodesRes.json.ok
          ? nodesRes.json.data.items.map((item) => ({
            nodeId: item.nodeId,
            status: item.status,
            output: item.output,
          }))
          : [],
        nodesStatus: nodesRes.status,
        nodesOk: nodesRes.status === 200 && nodesRes.json.ok,
      };
    },
    (value) =>
      value.nodesStatus === 200
      && value.nodesOk
      && (Boolean(value.dataNode) || Boolean(value.artifactWithMessage))
      && value.artifactCount > 0,
    { maxMs: 15_000, intervalMs: 250 },
  );

  expect(settledEvidence.dataNode || settledEvidence.artifactWithMessage).toBeTruthy();
  expect(settledEvidence.artifactCount).toBeGreaterThan(0);

  const message = settledEvidence.dataNode
    ? JSON.stringify(settledEvidence.dataNode.output ?? {})
    : decodeArtifactUri(settledEvidence.artifactWithMessage?.uri ?? "");
  return {
    runId,
    workflowVersionId: runRes.json.data.run.workflowVersionId,
    message,
    artifactCount: settledEvidence.artifactCount,
  };
}

async function getWorkflowDraftState(
  env: RealHubEnv,
  sessionId: string,
): Promise<WorkflowGeneratorSessionEnvelope["data"]["draft"] | undefined> {
  const sessionRes = await apiFetch<WorkflowGeneratorSessionEnvelope>(
    env.baseUrl,
    env.accessToken,
    "GET",
    `/v1/workflows/generator/sessions/${encodeURIComponent(sessionId)}`,
  );
  expect(sessionRes.status).toBe(200);
  expect(sessionRes.json.ok).toBe(true);
  return sessionRes.json.data.draft;
}

async function createValidatedWorkflowDraft(
  env: RealHubEnv,
  input: {
    targetWorkflowId: string;
    goal: string;
    clarification: string;
  },
): Promise<{ sessionId: string; evidence: WorkflowGeneratorEvidenceEnvelope["data"]["evidence"] }> {
  const startRes = await apiFetch<WorkflowGeneratorSessionEnvelope>(
    env.baseUrl,
    env.accessToken,
    "POST",
    "/v1/workflows/generator/sessions",
    {
      goal: input.goal,
      userId: "admin-001",
      channel: "deep-workflow-maintenance",
      requestedModel: FRIDAY_DEEP_PROOF_MODEL,
      targetWorkflowId: input.targetWorkflowId,
    },
    { timeoutMs: 300_000 },
  );
  expect(startRes.status).toBe(200);
  expect(startRes.json.ok).toBe(true);

  const sessionId = startRes.json.data.session.sessionId;
  if (startRes.json.data.mode === "clarification_required") {
    const replyRes = await apiFetch<{ ok: boolean }>(
      env.baseUrl,
      env.accessToken,
      "POST",
      `/v1/workflows/generator/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        message: input.clarification,
        requestedModel: FRIDAY_DEEP_PROOF_MODEL,
      },
      { timeoutMs: 300_000 },
    );
    expect(replyRes.status).toBe(200);
    expect(replyRes.json.ok).toBe(true);
  }

  let draft = startRes.json.data.draft ?? await getWorkflowDraftState(env, sessionId);
  let lastIssues = JSON.stringify(draft?.validation?.issues ?? []).slice(0, 1600);

  for (let attempt = 0; attempt < 4; attempt++) {
    if (draft?.validation?.ok) {
      const evidenceRes = await apiFetch<WorkflowGeneratorEvidenceEnvelope>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/workflows/generator/sessions/${encodeURIComponent(sessionId)}/evidence`,
      );
      expect(evidenceRes.status).toBe(200);
      expect(evidenceRes.json.ok).toBe(true);
      return {
        sessionId,
        evidence: evidenceRes.json.data.evidence,
      };
    }

    const generateRes = await apiFetch<{ ok: boolean; data: { draft: WorkflowGeneratorSessionEnvelope["data"]["draft"] } }>(
      env.baseUrl,
      env.accessToken,
      "POST",
      `/v1/workflows/generator/sessions/${encodeURIComponent(sessionId)}/generate`,
      { requestedModel: FRIDAY_DEEP_PROOF_MODEL },
      { timeoutMs: 300_000 },
    );
    expect(generateRes.status).toBe(200);
    expect(generateRes.json.ok).toBe(true);
    draft = generateRes.json.data.draft;
    lastIssues = JSON.stringify(draft?.validation?.issues ?? []).slice(0, 1600);

    if (draft?.validation?.ok) {
      const evidenceRes = await apiFetch<WorkflowGeneratorEvidenceEnvelope>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/workflows/generator/sessions/${encodeURIComponent(sessionId)}/evidence`,
      );
      expect(evidenceRes.status).toBe(200);
      expect(evidenceRes.json.ok).toBe(true);
      return {
        sessionId,
        evidence: evidenceRes.json.data.evidence,
      };
    }

    if (attempt < 3) {
      const feedbackRes = await apiFetch<{ ok: boolean }>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/workflows/generator/sessions/${encodeURIComponent(sessionId)}/messages`,
        {
          message:
            `The previous workflow draft still has validation issues: ${lastIssues}. ` +
            "Keep the same workflow identity, fix those exact issues, and regenerate.",
          requestedModel: FRIDAY_DEEP_PROOF_MODEL,
        },
        { timeoutMs: 300_000 },
      );
      expect(feedbackRes.status).toBe(200);
      expect(feedbackRes.json.ok).toBe(true);
      draft = await getWorkflowDraftState(env, sessionId);
    }
  }

  throw new Error(`Workflow generator draft never validated. Last issues: ${lastIssues}`);
}

describe.skipIf(!FRIDAY_DEEP_PROOF_GATED)(`Friday Workflow Generator Maintenance Live (${FRIDAY_DEEP_PROOF_PROVIDER_LABEL})`, () => {
  let env: RealHubEnv;

  beforeAll(async () => {
    env = await createFridayDeepProofHubEnv();
    await ensureWorkflowGeneratorDeepProofProviders(env);
  }, 120_000);

  afterAll(async () => {
    if (env) {
      await cleanupFridayDeepProofHubEnv(env);
    }
  }, 30_000);

  it(
    "publishes a new version onto the same workflow record and can roll publication back to the prior version",
    { timeout: 420_000, retry: 1 },
    async () => {
      const slug = `live-workflow-maint-${Date.now().toString(36)}`;
      const baseline = await createBaseWorkflow(env, slug);

      const baselineRun = await runWorkflowAndReadMessage(env, baseline.workflowId);
      expect(baselineRun.workflowVersionId).toBe(baseline.versionId);
      expect(baselineRun.message).toContain("version one");

      const beforeGet = await apiFetch<WorkflowGetEnvelope>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/workflows/${encodeURIComponent(baseline.workflowId)}`,
      );
      expect(beforeGet.status).toBe(200);
      expect(beforeGet.json.ok).toBe(true);
      expect(beforeGet.json.data.workflow.publishedVersionNumber).toBe(1);

      const workflowRowBefore = readWorkflowPublication(env.stateDir!, baseline.workflowId);
      expect(workflowRowBefore?.latestVersionNumber).toBe(1);
      expect(workflowRowBefore?.publishedVersionNumber).toBe(1);

      const updateSession = await createValidatedWorkflowDraft(env, {
        targetWorkflowId: baseline.workflowId,
        goal: [
          "Update the existing workflow in place.",
          "Keep it as a manual trigger workflow.",
          'Keep the same workflow identity and change the output payload so it now returns {"message":"version two"}.',
          "Do not create a replacement workflow.",
        ].join(" "),
        clarification: [
          "This is an in-place update to the existing workflow.",
          'Keep a manual trigger and a simple data output that returns {"message":"version two"}.',
          "Do not rename or replace the workflow identity.",
        ].join(" "),
      });
      expect(updateSession.evidence.validationSummary.ok).toBe(true);
      expect(updateSession.evidence.approvalReadiness.ready).toBe(true);

      const approveRes = await apiFetch<WorkflowGeneratorApproveEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/workflows/generator/sessions/${encodeURIComponent(updateSession.sessionId)}/approve`,
        undefined,
        { timeoutMs: 300_000 },
      );
      expect(approveRes.status).toBe(200);
      expect(approveRes.json.ok).toBe(true);
      expect(approveRes.json.data.workflowId).toBe(baseline.workflowId);
      expect(approveRes.json.data.workflowVersionId).not.toBe(baseline.versionId);
      expect(approveRes.json.data.versionNumber).toBe(2);
      expect(approveRes.json.data.slug).toBe(slug);
      expect(approveRes.json.data.published).toBe(true);
      expect(approveRes.json.data.evidence?.validationSummary.ok).toBe(true);

      const afterGet = await apiFetch<WorkflowGetEnvelope>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/workflows/${encodeURIComponent(baseline.workflowId)}`,
      );
      expect(afterGet.status).toBe(200);
      expect(afterGet.json.ok).toBe(true);
      expect(afterGet.json.data.workflow.latestVersionNumber).toBe(2);
      expect(afterGet.json.data.workflow.publishedVersionNumber).toBe(2);
      expect(afterGet.json.data.publishedVersion?.id).toBe(approveRes.json.data.workflowVersionId);

      const workflowRowAfter = readWorkflowPublication(env.stateDir!, baseline.workflowId);
      expect(workflowRowAfter?.latestVersionNumber).toBe(2);
      expect(workflowRowAfter?.publishedVersionNumber).toBe(2);

      const publishedV2 = readPublishedVersionRow(env.stateDir!, baseline.workflowId, 2);
      expect(publishedV2?.id).toBe(approveRes.json.data.workflowVersionId);
      expect(publishedV2?.isPublished).toBe(1);

      const upgradedRun = await runWorkflowAndReadMessage(env, baseline.workflowId);
      expect(upgradedRun.workflowVersionId).toBe(approveRes.json.data.workflowVersionId);
      expect(upgradedRun.message).toContain("version two");
      expect(upgradedRun.message).not.toContain("version one");

      const versionsRes = await apiFetch<WorkflowVersionsEnvelope>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/workflows/${encodeURIComponent(baseline.workflowId)}/versions`,
      );
      expect(versionsRes.status).toBe(200);
      expect(versionsRes.json.ok).toBe(true);
      expect(
        versionsRes.json.data.items.map((item) => item.versionNumber).sort((a, b) => a - b),
      ).toEqual([1, 2]);
      expect(
        versionsRes.json.data.items.find((item) => item.versionNumber === 2)?.isPublished,
      ).toBe(true);

      const rollbackRes = await apiFetch<{ ok: boolean; data: { publishedVersion: { id: string; versionNumber: number } } }>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/workflows/${encodeURIComponent(baseline.workflowId)}/publish`,
        { versionNumber: 1 },
      );
      expect(rollbackRes.status).toBe(200);
      expect(rollbackRes.json.ok).toBe(true);
      expect(rollbackRes.json.data.publishedVersion.id).toBe(baseline.versionId);
      expect(rollbackRes.json.data.publishedVersion.versionNumber).toBe(1);

      const rolledBackGet = await apiFetch<WorkflowGetEnvelope>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/workflows/${encodeURIComponent(baseline.workflowId)}`,
      );
      expect(rolledBackGet.status).toBe(200);
      expect(rolledBackGet.json.ok).toBe(true);
      expect(rolledBackGet.json.data.workflow.latestVersionNumber).toBe(2);
      expect(rolledBackGet.json.data.workflow.publishedVersionNumber).toBe(1);
      expect(rolledBackGet.json.data.publishedVersion?.id).toBe(baseline.versionId);

      const workflowRowRolledBack = readWorkflowPublication(env.stateDir!, baseline.workflowId);
      expect(workflowRowRolledBack?.latestVersionNumber).toBe(2);
      expect(workflowRowRolledBack?.publishedVersionNumber).toBe(1);

      const publishedV1 = readPublishedVersionRow(env.stateDir!, baseline.workflowId, 1);
      expect(publishedV1?.id).toBe(baseline.versionId);
      expect(publishedV1?.isPublished).toBe(1);

      const rolledBackRun = await runWorkflowAndReadMessage(env, baseline.workflowId);
      expect(rolledBackRun.workflowVersionId).toBe(baseline.versionId);
      expect(rolledBackRun.message).toContain("version one");
      expect(rolledBackRun.message).not.toContain("version two");
    },
  );
});
