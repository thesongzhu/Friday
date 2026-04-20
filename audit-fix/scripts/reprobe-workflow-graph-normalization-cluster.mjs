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
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await apiRequest("GET", `/v1/workflow-runs/${encodeURIComponent(runId)}`, null, token, 30_000);
    samples.push({
      attempt,
      status: result.rawBody?.data?.run?.status ?? null,
      failure: result.rawBody?.data?.run?.failure ?? null,
    });
    const status = result.rawBody?.data?.run?.status;
    if (typeof status === "string" && ["completed", "failed", "cancelled", "paused"].includes(status)) {
      return { final: result, samples };
    }
    await sleep(1000);
  }
  return {
    final: await apiRequest("GET", `/v1/workflow-runs/${encodeURIComponent(runId)}`, null, token, 30_000),
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

const slug = `wf-normalize-${Date.now()}`;
const createRaw = await apiRequest(
  "POST",
  "/v1/workflows",
  {
    slug,
    name: "Workflow Graph Normalize Probe",
    graph: {
      nodes: [
        { id: "n1", kind: "start", data: {} },
        { id: "n2", kind: "data", data: { mapping: { ok: true } } },
      ],
      edges: [{ from: "n1", to: "n2" }],
    },
  },
  token,
  30_000,
);
await writeJson("create-raw-workflow.json", createRaw);

const workflowId = createRaw.rawBody?.data?.workflow?.id;
const versionId = createRaw.rawBody?.data?.version?.id;
const versionNumber = createRaw.rawBody?.data?.version?.versionNumber;
if (typeof workflowId !== "string" || typeof versionId !== "string") {
  throw new Error("Failed to create raw workflow");
}

const publish = await apiRequest(
  "POST",
  `/v1/workflows/${encodeURIComponent(workflowId)}/publish`,
  { versionNumber },
  token,
  30_000,
);
await writeJson("publish-workflow.json", publish);

const visualization = await apiRequest(
  "GET",
  `/v1/workflows/${encodeURIComponent(workflowId)}/visualization`,
  null,
  token,
  30_000,
);
await writeJson("visualization.json", visualization);

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
  30_000,
);
await writeJson("start-run.json", startRun);

const runId = startRun.rawBody?.data?.run?.id;
if (typeof runId !== "string" || runId.length === 0) {
  throw new Error("Run ID missing from workflow normalization rerun");
}

const runPoll = await pollRun(runId, token);
await writeJson("poll-run.json", runPoll);
await writeJson("final-run.json", runPoll.final);

const runNodes = await apiRequest(
  "GET",
  `/v1/workflow-runs/${encodeURIComponent(runId)}/nodes`,
  null,
  token,
  30_000,
);
await writeJson("run-nodes.json", runNodes);

const invalidCompiled = await apiRequest(
  "POST",
  "/v1/workflows",
  {
    slug: `${slug}-bad`,
    name: "Workflow Bad Compiled Start",
    graph: {
      schemaVersion: "2.0",
      workflowId: "wf-bad",
      workflowVersionId: "wv-bad",
      sourceSpecSchemaVersion: "1.0",
      graph: {
        nodes: [
          { id: "start", type: "start", label: "Start", config: {} },
          { id: "next", type: "data", label: "Next", config: { mapping: { ok: true } } },
        ],
        edges: [{ id: "e1", sourceNodeId: "start", targetNodeId: "next" }],
      },
      failurePolicy: { onFailure: "fail_fast", notifyUser: false },
      tests: [],
      checksum: "placeholder",
    },
  },
  token,
  30_000,
);
await writeJson("create-invalid-compiled-workflow.json", invalidCompiled);

await writeJson(
  "workflow-version-db.json",
  dbGet(
    `SELECT id, workflow_id, version_number, checksum, graph_json, is_published, created_at
       FROM workflow_versions
      WHERE id = ?`,
    versionId,
  ),
);
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

const finalStatus = runPoll.final.rawBody?.data?.run?.status ?? null;
const finalFailureCode = runPoll.final.rawBody?.data?.run?.failure?.code ?? null;
const nodeItems = Array.isArray(runNodes.rawBody?.data?.items) ? runNodes.rawBody.data.items : [];

await writeJson("workflow-graph-normalization-summary.json", {
  checkedAt: new Date().toISOString(),
  workflowId,
  versionId,
  runId,
  visualizationStatus: visualization.response.status,
  visualizationOk: visualization.rawBody?.ok ?? null,
  startRunStatus: startRun.response.status,
  finalRunStatus: finalStatus,
  finalRunFailureCode: finalFailureCode,
  nodeStatuses: nodeItems.map((item) => ({ nodeId: item?.nodeId ?? null, status: item?.status ?? null })),
  rawGraphRunSucceededWithoutLegacyEdgeFailure:
    startRun.response.status === 200
    && finalStatus === "completed"
    && finalFailureCode == null
    && !nodeItems.some((item) => item?.error?.code === "WORKFLOW_INVALID_EDGE" || item?.error?.code === "NODE_RUNNER_UNSUPPORTED_NODE_TYPE"),
  invalidCompiledStatus: invalidCompiled.response.status,
  invalidCompiledErrorCode: invalidCompiled.rawBody?.error?.code ?? null,
  invalidCompiledRejectedAtCreate:
    invalidCompiled.response.status === 400
    && invalidCompiled.rawBody?.error?.code === "WORKFLOW_UNSUPPORTED_NODE_TYPE",
});
