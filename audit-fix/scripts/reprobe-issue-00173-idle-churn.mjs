import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3241";
const dbPath = process.env.DB_PATH;
const outDir = process.env.OUT_DIR;
const preIdleMs = Number(process.env.PRE_IDLE_MS ?? "130000");
const postFailureSoakMs = Number(process.env.POST_FAILURE_SOAK_MS ?? "130000");

if (!dbPath) {
  throw new Error("DB_PATH is required");
}

if (!outDir) {
  throw new Error("OUT_DIR is required");
}

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

function redactTokens(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => redactTokens(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        if (key === "accessToken" || key === "refreshToken") {
          return [key, "<redacted>"];
        }
        return [key, redactTokens(entry)];
      }),
    );
  }
  return value;
}

async function apiRequest(method, pathname, body, token) {
  const url = `${baseUrl}${pathname}`;
  const headers = {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
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
      body: redactTokens(responseBody),
    },
  };
}

function dbGet(sql, ...params) {
  return db.prepare(sql).get(...params) ?? null;
}

function dbAll(sql, ...params) {
  return db.prepare(sql).all(...params);
}

async function waitFor(check, label, timeoutMs = 30000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) {
      return value;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function snapshotCounts() {
  return {
    takenAt: new Date().toISOString(),
    learningEvents: dbGet("SELECT COUNT(*) AS count FROM learning_events")?.count ?? 0,
    errorIncidents: dbGet("SELECT COUNT(*) AS count FROM error_incidents")?.count ?? 0,
    openErrorIncidents:
      dbGet("SELECT COUNT(*) AS count FROM error_incidents WHERE status = 'open'")?.count ?? 0,
    autoFixActions: dbGet("SELECT COUNT(*) AS count FROM auto_fix_actions")?.count ?? 0,
    plannedAutoFixActions:
      dbGet("SELECT COUNT(*) AS count FROM auto_fix_actions WHERE status = 'planned'")?.count ?? 0,
    learnedLessons: dbGet("SELECT COUNT(*) AS count FROM learned_lessons")?.count ?? 0,
  };
}

await resetDir(outDir);

const health = await apiRequest("GET", "/v1/health", null, null);
await writeJson("health.json", health);

const login = await apiRequest("POST", "/v1/auth/login", { local: true }, null);
await writeJson("login.json", login);
const token = login.rawBody?.data?.accessToken;
if (typeof token !== "string" || token.length === 0) {
  throw new Error("Failed to obtain access token from /v1/auth/login");
}

const baseline = snapshotCounts();
await writeJson("baseline-counts.json", baseline);

await sleep(preIdleMs);

const postIdle = snapshotCounts();
await writeJson("post-idle-counts.json", postIdle);

const slug = `issue-00173-postfix-${Date.now()}`;
const workflowCreate = await apiRequest(
  "POST",
  "/v1/workflows",
  {
    slug,
    name: "Issue 00173 Postfix Repro",
    graph: {
      schemaVersion: "2.0",
      workflowId: "wf-placeholder",
      workflowVersionId: "wv-placeholder",
      sourceSpecSchemaVersion: "1.0",
      graph: {
        variables: {
          runTimeoutMs: 60000,
        },
        nodes: [
          {
            id: "trigger",
            type: "trigger",
            label: "Trigger",
            config: {},
          },
          {
            id: "action1",
            type: "action",
            label: "Action 1",
            config: {
              skillId: "missing-skill-postfix",
            },
          },
        ],
        edges: [
          {
            id: "e1",
            sourceNodeId: "trigger",
            targetNodeId: "action1",
          },
        ],
      },
      failurePolicy: {
        onFailure: "fail_fast",
        notifyUser: false,
      },
      tests: [],
      checksum: "placeholder-checksum",
    },
  },
  token,
);
await writeJson("workflow-create.json", workflowCreate);

const workflowId = workflowCreate.rawBody?.data?.workflow?.id;
const workflowVersionId = workflowCreate.rawBody?.data?.version?.id;
if (typeof workflowId !== "string" || typeof workflowVersionId !== "string") {
  throw new Error("Failed to create workflow");
}

const workflowPublish = await apiRequest(
  "POST",
  `/v1/workflows/${workflowId}/publish`,
  { versionNumber: 1 },
  token,
);
await writeJson("workflow-publish.json", workflowPublish);

const workflowRunStart = await apiRequest(
  "POST",
  "/v1/workflow-runs",
  {
    workflowId,
    workflowVersionId,
    triggerType: "manual",
  },
  token,
);
await writeJson("workflow-run-start.json", workflowRunStart);

const runId = workflowRunStart.rawBody?.data?.run?.id;
if (typeof runId !== "string") {
  throw new Error("Failed to start workflow run");
}

const finalRun = await waitFor(
  async () => {
    const response = await apiRequest("GET", `/v1/workflow-runs/${runId}`, null, token);
    const status = response.response.body?.data?.run?.status;
    if (status && !["queued", "running", "paused", "pausing", "compensating"].includes(status)) {
      return response;
    }
    return null;
  },
  "workflow final state",
);
await writeJson("workflow-run-final.json", finalRun);

const countsAfterFailure = snapshotCounts();
await writeJson("post-failure-counts.json", countsAfterFailure);

await writeJson(
  "workflow-run-db.json",
  dbGet(
    `SELECT id, workflow_id, workflow_version_id, status, failure_code, failure_message, deadline_at, finished_at, updated_at
     FROM workflow_runs
     WHERE id = ?`,
    runId,
  ),
);

await writeJson(
  "workflow-run-nodes-db.json",
  dbAll(
    `SELECT run_id, node_id, attempt, status, error_json, created_at, updated_at
     FROM workflow_run_nodes
     WHERE run_id = ?
     ORDER BY attempt ASC`,
    runId,
  ),
);

await writeJson(
  "post-failure-learning-rows.json",
  {
    incidents: dbAll(
      `SELECT incident_id, run_id, node_id, status, signature, created_at, updated_at, context_json
       FROM error_incidents
       WHERE run_id = ?
       ORDER BY created_at ASC`,
      runId,
    ),
    actions: dbAll(
      `SELECT action_id, incident_id, status, outcome, created_at, updated_at, plan_json
       FROM auto_fix_actions
       WHERE incident_id IN (
         SELECT incident_id FROM error_incidents WHERE run_id = ?
       )
       ORDER BY created_at ASC`,
      runId,
    ),
    diagnoses: dbAll(
      `SELECT id, incident_id, error_fingerprint, confidence, resolved_at, diagnosis_json, created_at
       FROM diagnosis_records
       WHERE incident_id IN (
         SELECT incident_id FROM error_incidents WHERE run_id = ?
       )
       ORDER BY created_at ASC`,
      runId,
    ),
  },
);

await sleep(postFailureSoakMs);

const postSoak = snapshotCounts();
await writeJson("post-soak-counts.json", postSoak);

await writeJson(
  "post-soak-learning-rows.json",
  {
    incidents: dbAll(
      `SELECT incident_id, run_id, node_id, status, signature, created_at, updated_at, context_json
       FROM error_incidents
       WHERE run_id = ?
       ORDER BY created_at ASC`,
      runId,
    ),
    actions: dbAll(
      `SELECT action_id, incident_id, status, outcome, created_at, updated_at, plan_json
       FROM auto_fix_actions
       WHERE incident_id IN (
         SELECT incident_id FROM error_incidents WHERE run_id = ?
       )
       ORDER BY created_at ASC`,
      runId,
    ),
    runNodes: dbAll(
      `SELECT run_id, node_id, attempt, status, error_json, created_at, updated_at
       FROM workflow_run_nodes
       WHERE run_id = ?
       ORDER BY attempt ASC`,
      runId,
    ),
  },
);

const summary = {
  baseUrl,
  dbPath,
  preIdleMs,
  postFailureSoakMs,
  workflowId,
  workflowVersionId,
  runId,
  baseline,
  postIdle,
  countsAfterFailure,
  postSoak,
  deltas: {
    idleLearningEvents: postIdle.learningEvents - baseline.learningEvents,
    idleErrorIncidents: postIdle.errorIncidents - baseline.errorIncidents,
    idleAutoFixActions: postIdle.autoFixActions - baseline.autoFixActions,
    failureToSoakLearningEvents: postSoak.learningEvents - countsAfterFailure.learningEvents,
    failureToSoakErrorIncidents: postSoak.errorIncidents - countsAfterFailure.errorIncidents,
    failureToSoakAutoFixActions: postSoak.autoFixActions - countsAfterFailure.autoFixActions,
  },
};
await writeJson("issue-00173-summary.json", summary);

db.close();
