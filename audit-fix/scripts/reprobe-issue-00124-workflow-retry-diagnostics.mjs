import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3241";
const dbPath = process.env.DB_PATH;
const outDir = process.env.OUT_DIR;

if (!dbPath) throw new Error("DB_PATH is required");
if (!outDir) throw new Error("OUT_DIR is required");

const db = new Database(dbPath, { readonly: true });

async function resetDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

async function writeJson(name, value) {
  await fs.writeFile(path.join(outDir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function redactHeaders(headers = {}) {
  return {
    ...headers,
    authorization: headers.authorization ? "Bearer <redacted>" : undefined,
  };
}

async function apiRequest(method, pathname, body, token, timeoutMs = 30_000) {
  const url = `${baseUrl}${pathname}`;
  const headers = {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const responseBody = await response.json().catch(() => null);
    return {
      rawBody: responseBody,
      request: {
        method,
        url,
        headers: redactHeaders(headers),
        body: body ?? null,
      },
      response: {
        status: response.status,
        body: responseBody,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function dbGet(sql, ...params) {
  return db.prepare(sql).get(...params) ?? null;
}

function dbAll(sql, ...params) {
  return db.prepare(sql).all(...params);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollRun(runId, token) {
  const samples = [];
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const result = await apiRequest("GET", `/v1/workflow-runs/${encodeURIComponent(runId)}`, null, token);
    const run = result.rawBody?.data?.run ?? null;
    samples.push({
      attempt,
      status: run?.status ?? null,
      failure: run?.failure ?? null,
    });
    if (typeof run?.status === "string" && ["completed", "failed", "cancelled", "paused"].includes(run.status)) {
      return { final: result, samples };
    }
    await sleep(1000);
  }
  return {
    final: await apiRequest("GET", `/v1/workflow-runs/${encodeURIComponent(runId)}`, null, token),
    samples,
  };
}

await resetDir(outDir);

const login = await apiRequest("POST", "/v1/auth/login", { local: true }, null, 15_000);
await writeJson("login.json", login);
const token = login.rawBody?.data?.accessToken;
if (typeof token !== "string" || token.length === 0) {
  throw new Error("Failed to obtain access token");
}

const slug = `wf-retry-diag-${Date.now()}`;
const createWorkflow = await apiRequest(
  "POST",
  "/v1/workflows",
  {
    slug,
    name: "Workflow Retry Diagnostics Probe",
    graph: {
      schemaVersion: "2.0",
      workflowId: "wf-retry-diag-placeholder",
      workflowVersionId: "wv-retry-diag-placeholder",
      sourceSpecSchemaVersion: "1.0",
      graph: {
        variables: {
          runTimeoutMs: 60_000,
        },
        nodes: [
          {
            id: "trigger",
            type: "trigger",
            label: "Trigger",
            config: {},
          },
          {
            id: "missing-skill-action",
            type: "action",
            label: "Missing Skill Action",
            config: {
              skillId: "missing-skill-issue-00124",
              args: {},
            },
          },
        ],
        edges: [
          {
            id: "e1",
            sourceNodeId: "trigger",
            targetNodeId: "missing-skill-action",
          },
        ],
      },
      failurePolicy: {
        onFailure: "fail_fast",
        notifyUser: false,
      },
      tests: [],
      checksum: "placeholder",
    },
  },
  token,
);
await writeJson("create-workflow.json", createWorkflow);

const workflowId = createWorkflow.rawBody?.data?.workflow?.id;
const versionId = createWorkflow.rawBody?.data?.version?.id;
const versionNumber = createWorkflow.rawBody?.data?.version?.versionNumber;
if (typeof workflowId !== "string" || typeof versionId !== "string") {
  throw new Error("Failed to create workflow");
}

const publishWorkflow = await apiRequest(
  "POST",
  `/v1/workflows/${encodeURIComponent(workflowId)}/publish`,
  { versionNumber },
  token,
);
await writeJson("publish-workflow.json", publishWorkflow);

const startRun = await apiRequest(
  "POST",
  "/v1/workflow-runs",
  {
    workflowId,
    workflowVersionId: versionId,
    triggerType: "manual",
    triggerPayload: {},
  },
  token,
);
await writeJson("start-run.json", startRun);

const runId = startRun.rawBody?.data?.run?.id;
if (typeof runId !== "string" || runId.length === 0) {
  throw new Error("Run ID missing from ISSUE-00124 repro");
}

const runPoll = await pollRun(runId, token);
await writeJson("poll-run.json", runPoll);
await writeJson("final-run.json", runPoll.final);

const runNodes = await apiRequest(
  "GET",
  `/v1/workflow-runs/${encodeURIComponent(runId)}/nodes`,
  null,
  token,
);
await writeJson("run-nodes.json", runNodes);

const runEvidence = await apiRequest(
  "GET",
  `/v1/workflow-runs/${encodeURIComponent(runId)}/evidence?modules=retry`,
  null,
  token,
);
await writeJson("run-evidence-retry.json", runEvidence);

await writeJson(
  "workflow-run-db.json",
  dbGet(
    `SELECT id, workflow_id, workflow_version_id, status, failure_code, failure_message, created_at, finished_at
       FROM workflow_runs
      WHERE id = ?`,
    runId,
  ),
);
await writeJson(
  "workflow-run-nodes-db.json",
  dbAll(
    `SELECT run_id, node_id, attempt, status, error_json, created_at, finished_at
       FROM workflow_run_nodes
      WHERE run_id = ?
      ORDER BY node_id, attempt`,
    runId,
  ),
);
await writeJson(
  "workflow-run-retry-traces-db.json",
  dbAll(
    `SELECT id, run_id, node_id, attempt, category, error_code, error_message, decision_json, timestamp
       FROM workflow_run_retry_traces
      WHERE run_id = ?
      ORDER BY timestamp ASC, id ASC`,
    runId,
  ),
);
await writeJson(
  "workflow-run-retry-events-db.json",
  dbAll(
    `SELECT event_id, run_id, node_id, attempt, module, event_name, payload_json, emitted_at
       FROM workflow_run_pipeline_events
      WHERE run_id = ?
        AND module = 'retry'
      ORDER BY emitted_at ASC, event_id ASC`,
    runId,
  ),
);

const finalRun = runPoll.final.rawBody?.data?.run ?? null;
const nodeItems = Array.isArray(runNodes.rawBody?.data?.items) ? runNodes.rawBody.data.items : [];
const retryEvidence = runEvidence.rawBody?.data ?? null;
const retryTraces = Array.isArray(retryEvidence?.retry?.traces) ? retryEvidence.retry.traces : [];
const retryEvents = Array.isArray(retryEvidence?.retry?.events) ? retryEvidence.retry.events : [];
const failedNode = nodeItems.find((item) => item?.nodeId === "missing-skill-action") ?? null;
const firstTrace = retryTraces[0] ?? null;
const exhaustedEvent = retryEvents.find((event) => event?.event === "pipeline.retry.exhausted") ?? null;
const retryTraceDbRows = dbAll(
  `SELECT category, error_code, error_message
     FROM workflow_run_retry_traces
    WHERE run_id = ?
    ORDER BY timestamp ASC, id ASC`,
  runId,
);

await writeJson("issue-00124-summary.json", {
  checkedAt: new Date().toISOString(),
  workflowId,
  versionId,
  runId,
  finalRunStatus: finalRun?.status ?? null,
  finalRunFailureCode: finalRun?.failure?.code ?? null,
  failedNodeStatus: failedNode?.status ?? null,
  failedNodeErrorCode: failedNode?.error?.code ?? null,
  failedNodeErrorMessage: failedNode?.error?.message ?? null,
  retryEvidenceStatus: runEvidence.response.status,
  retryTraceCount: retryTraces.length,
  retryEventCount: retryEvents.length,
  retryTraceCategory: firstTrace?.category ?? null,
  retryTraceErrorCode: firstTrace?.errorCode ?? null,
  retryTraceErrorMessage: firstTrace?.errorMessage ?? null,
  retryExhaustedCategory: exhaustedEvent?.payload?.category ?? null,
  retryTraceDbCategory: retryTraceDbRows[0]?.category ?? null,
  retryTraceDbErrorCode: retryTraceDbRows[0]?.error_code ?? null,
  retryTraceDbErrorMessage: retryTraceDbRows[0]?.error_message ?? null,
  residualUnknownCategoryClosed:
    (firstTrace?.category ?? null) !== "unknown"
    && (exhaustedEvent?.payload?.category ?? null) !== "unknown",
  retryTraceCarriesErrorMessage:
    typeof firstTrace?.errorMessage === "string"
    && firstTrace.errorMessage.length > 0
    && typeof retryTraceDbRows[0]?.error_message === "string"
    && retryTraceDbRows[0].error_message.length > 0,
});
