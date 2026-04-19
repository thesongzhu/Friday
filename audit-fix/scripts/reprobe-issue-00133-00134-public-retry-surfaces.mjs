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
  for (let attempt = 0; attempt < 40; attempt += 1) {
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
    await sleep(250);
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

const skillProbe = await apiRequest("GET", "/v1/skills/shell-skill-current-datetime", null, token);
await writeJson("skill-probe.json", skillProbe);
if (skillProbe.response.status !== 200) {
  throw new Error("shell-skill-current-datetime is not available for retry surface repro");
}

const workflowSlug = `wf-public-retry-${Date.now()}`;
const timeoutNodeId = `timeout-node-${Date.now().toString(36)}`;
const createWorkflow = await apiRequest(
  "POST",
  "/v1/workflows",
  {
    slug: workflowSlug,
    name: "Public Retry Surface Probe",
    graph: {
      schemaVersion: "2.0",
      workflowId: "wf-public-retry-placeholder",
      workflowVersionId: "wv-public-retry-placeholder",
      sourceSpecSchemaVersion: "1.0",
      graph: {
        nodes: [
          {
            id: "trigger",
            type: "trigger",
            label: "Trigger",
            config: {},
          },
          {
            id: timeoutNodeId,
            type: "action",
            label: "Timeout Action",
            timeoutMs: 0,
            config: {
              skillId: "shell-skill-current-datetime",
              args: {},
            },
          },
        ],
        edges: [
          {
            id: "e1",
            sourceNodeId: "trigger",
            targetNodeId: timeoutNodeId,
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
  throw new Error("Failed to create retry surface workflow");
}

const publishWorkflow = await apiRequest(
  "POST",
  `/v1/workflows/${encodeURIComponent(workflowId)}/publish`,
  { versionNumber },
  token,
);
await writeJson("publish-workflow.json", publishWorkflow);

const runs = [];
for (let index = 1; index <= 3; index += 1) {
  const start = await apiRequest(
    "POST",
    "/v1/workflow-runs",
    {
      workflowId,
      workflowVersionId: versionId,
      triggerType: "manual",
      triggerPayload: { attemptWave: index },
    },
    token,
  );
  await writeJson(`run${index}-start.json`, start);
  const runId = start.rawBody?.data?.run?.id;
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error(`Failed to create run ${index}`);
  }
  const poll = await pollRun(runId, token);
  await writeJson(`run${index}-poll.json`, poll);
  await writeJson(`run${index}-final.json`, poll.final);
  runs.push({
    runId,
    finalStatus: poll.final.rawBody?.data?.run?.status ?? null,
    finalFailureCode: poll.final.rawBody?.data?.run?.failure?.code ?? null,
  });
}

const finalRunId = runs[runs.length - 1]?.runId;
if (typeof finalRunId !== "string") {
  throw new Error("Final run ID missing");
}

const finalNodes = await apiRequest(
  "GET",
  `/v1/workflow-runs/${encodeURIComponent(finalRunId)}/nodes`,
  null,
  token,
);
await writeJson("final-run-nodes.json", finalNodes);

const finalEvidence = await apiRequest(
  "GET",
  `/v1/workflow-runs/${encodeURIComponent(finalRunId)}/evidence?modules=retry`,
  null,
  token,
);
await writeJson("final-run-evidence-retry.json", finalEvidence);

const retryTraces = await apiRequest(
  "GET",
  `/v1/retry/traces?runId=${encodeURIComponent(finalRunId)}`,
  null,
  token,
);
await writeJson("retry-traces.json", retryTraces);

const retryEscalations = await apiRequest("GET", "/v1/retry/escalations?limit=20", null, token);
await writeJson("retry-escalations.json", retryEscalations);

const retryCircuitBreakers = await apiRequest("GET", "/v1/retry/circuit-breakers", null, token);
await writeJson("retry-circuit-breakers.json", retryCircuitBreakers);

await writeJson(
  "retry-traces-db.json",
  dbAll(
    `SELECT id, run_id, workflow_id, node_id, status, original_failure_category, original_error_code, original_error_message, updated_at
       FROM retry_traces
      WHERE workflow_id = ?
      ORDER BY updated_at DESC`,
    workflowId,
  ),
);
await writeJson(
  "retry-escalations-db.json",
  dbAll(
    `SELECT e.id, e.trace_id, e.target, e.channel, e.reason, e.failure_category, e.attempt_count, e.escalated_at
       FROM retry_escalations e
       JOIN retry_traces t ON t.id = e.trace_id
      WHERE t.workflow_id = ?
      ORDER BY e.escalated_at DESC`,
    workflowId,
  ),
);
await writeJson(
  "retry-circuit-breakers-db.json",
  dbAll(
    `SELECT target_id, state, consecutive_failures, failure_threshold, last_opened_at, trip_count, updated_at
       FROM retry_circuit_breakers
      WHERE target_id LIKE ?
      ORDER BY updated_at DESC`,
    `${workflowId}:%`,
  ),
);

const evidenceData = finalEvidence.rawBody?.data ?? null;
const evidenceEvents = Array.isArray(evidenceData?.retry?.events) ? evidenceData.retry.events : [];
const evidenceTraces = Array.isArray(evidenceData?.retry?.traces) ? evidenceData.retry.traces : [];
const circuitEvent = evidenceEvents.find((event) => event?.event === "pipeline.retry.circuit.opened") ?? null;
const retryTraceItems = Array.isArray(retryTraces.rawBody?.data?.items) ? retryTraces.rawBody.data.items : [];
const retryEscalationItems = Array.isArray(retryEscalations.rawBody?.data?.items) ? retryEscalations.rawBody.data.items : [];
const retryCircuitItems = Array.isArray(retryCircuitBreakers.rawBody?.data?.items) ? retryCircuitBreakers.rawBody.data.items : [];

await writeJson("issue-00133-00134-summary.json", {
  checkedAt: new Date().toISOString(),
  workflowId,
  versionId,
  timeoutNodeId,
  runs,
  finalRunId,
  finalRunStatus: runs[runs.length - 1]?.finalStatus ?? null,
  evidenceRetryTraceCount: evidenceTraces.length,
  evidenceRetryEventCount: evidenceEvents.length,
  evidenceCircuitOpened: Boolean(circuitEvent),
  retryTracesStatus: retryTraces.response.status,
  retryTracesCount: retryTraceItems.length,
  retryTracesNonEmpty: retryTraceItems.length > 0,
  retryEscalationsStatus: retryEscalations.response.status,
  retryEscalationsCount: retryEscalationItems.length,
  retryEscalationsNonEmpty: retryEscalationItems.length > 0,
  retryCircuitBreakersStatus: retryCircuitBreakers.response.status,
  retryCircuitBreakersCount: retryCircuitItems.length,
  retryCircuitBreakerOpenVisible: retryCircuitItems.some((item) => item?.state === "open"),
  dbRetryTracesCount: dbGet(`SELECT COUNT(*) AS count FROM retry_traces WHERE workflow_id = ?`, workflowId)?.count ?? 0,
  dbRetryEscalationsCount:
    dbGet(
      `SELECT COUNT(*) AS count
         FROM retry_escalations e
         JOIN retry_traces t ON t.id = e.trace_id
        WHERE t.workflow_id = ?`,
      workflowId,
    )?.count ?? 0,
  dbRetryCircuitBreakersCount:
    dbGet(`SELECT COUNT(*) AS count FROM retry_circuit_breakers WHERE target_id LIKE ?`, `${workflowId}:%`)?.count ?? 0,
});
