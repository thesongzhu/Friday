import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3241";
const dbPath = process.env.DB_PATH;
const outDir = process.env.OUT_DIR;

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
    return value.map((item) => redactTokens(item));
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

async function waitFor(check, label, timeoutMs = 15000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

await resetDir(outDir);

const health = await apiRequest("GET", "/v1/health", null, null);
await writeJson("health.json", health.response.body);

const login = await apiRequest("POST", "/v1/auth/login", { local: true }, null);
await writeJson("login.json", login);

const token = login.rawBody?.data?.accessToken;
if (typeof token !== "string" || token.length === 0) {
  throw new Error("Failed to obtain access token from /v1/auth/login");
}

await writeJson("login-redacted-summary.json", {
  status: login.response.status,
  userId: login.rawBody?.data?.user?.id ?? null,
  email: login.rawBody?.data?.user?.email ?? null,
  authMode: "local",
});

const bundleCreate = await apiRequest(
  "POST",
  "/v1/rules/bundles",
  {
    name: "Audit Bundle Group1",
    description: "blocker group 1 validation rerun",
    tags: ["audit", "group1", "rerun"],
  },
  token,
);
await writeJson("rules-bundle-create.json", bundleCreate);

const bundleId = bundleCreate.response.body?.data?.bundle?.id;
const bundleEtag = bundleCreate.rawBody?.data?.bundle?.etag;
if (typeof bundleId !== "string" || typeof bundleEtag !== "string") {
  throw new Error("Failed to create rules bundle");
}

const bundleUpdate = await apiRequest(
  "PATCH",
  `/v1/rules/bundles/${bundleId}`,
  {
    etag: bundleEtag,
    name: "Audit Bundle Group1 v2",
    tags: ["audit", "group1", "rerun", "updated"],
    changeNote: "verify version persistence rerun",
  },
  token,
);
await writeJson("rules-bundle-update.json", bundleUpdate);

const bundleVersions = await apiRequest(
  "GET",
  `/v1/rules/bundles/${bundleId}/versions`,
  null,
  token,
);
await writeJson("rules-bundle-versions.json", bundleVersions);

await writeJson(
  "rules-bundle-versions-db.json",
  dbAll(
    `SELECT id, bundle_id, version, changed_by, change_note, created_at
     FROM rule_policy_bundle_versions
     WHERE bundle_id = ?
     ORDER BY version DESC`,
    bundleId,
  ),
);

const slug = `audit-group1-rerun-${Date.now()}`;
const workflowCreate = await apiRequest(
  "POST",
  "/v1/workflows",
  {
    slug,
    name: "Audit Group1 Workflow Rerun",
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
            id: "approval1",
            type: "approval",
            label: "Approval Gate",
            config: {
              approverRole: "admin",
              message: "Please approve",
              timeoutMs: 3600000,
            },
          },
          {
            id: "action1",
            type: "action",
            label: "Action 1",
            config: {
              skillId: "test-skill",
            },
          },
        ],
        edges: [
          {
            id: "e1",
            sourceNodeId: "trigger",
            targetNodeId: "approval1",
          },
          {
            id: "e2",
            sourceNodeId: "approval1",
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

const missingLock = await apiRequest(
  "POST",
  "/v1/workflows/nonexistent-workflow/locks/acquire",
  {
    ownerUserId: "admin-001",
    ttlSec: 120,
  },
  token,
);
await writeJson("workflow-lock-acquire-nonexistent.json", missingLock);
await writeJson(
  "workflow-lock-acquire-nonexistent-db.json",
  dbAll(`SELECT * FROM workflow_locks WHERE workflow_id = ?`, "nonexistent-workflow"),
);

const mismatchLock = await apiRequest(
  "POST",
  `/v1/workflows/${workflowId}/locks/acquire`,
  {
    ownerUserId: "not-admin",
    ttlSec: 120,
  },
  token,
);
await writeJson("workflow-lock-acquire-mismatch.json", mismatchLock);
await writeJson(
  "workflow-lock-acquire-mismatch-db.json",
  dbAll(`SELECT * FROM workflow_locks WHERE workflow_id = ?`, workflowId),
);

const validLock = await apiRequest(
  "POST",
  `/v1/workflows/${workflowId}/locks/acquire`,
  {
    ownerUserId: "admin-001",
    ttlSec: 120,
  },
  token,
);
await writeJson("workflow-lock-acquire-valid.json", validLock);

await waitFor(
  async () => {
    const row = dbGet(
      `SELECT workflow_id, lock_token, owner_user_id, owner_session_id, acquired_at, heartbeat_at, expires_at, created_at, updated_at
       FROM workflow_locks
       WHERE workflow_id = ?`,
      workflowId,
    );
    return row;
  },
  "workflow lock row",
);

const lockDbRow = dbGet(
  `SELECT workflow_id, lock_token, owner_user_id, owner_session_id, acquired_at, heartbeat_at, expires_at, created_at, updated_at
   FROM workflow_locks
   WHERE workflow_id = ?`,
  workflowId,
);
await writeJson("workflow-lock-valid-db.json", lockDbRow);

const lockToken = validLock.rawBody?.data?.lock?.lockToken;
if (typeof lockToken !== "string") {
  throw new Error("Failed to acquire workflow lock");
}

const releaseLock = await apiRequest(
  "POST",
  `/v1/workflows/${workflowId}/locks/release`,
  { lockToken },
  token,
);
await writeJson("workflow-lock-release-valid.json", releaseLock);
await writeJson(
  "workflow-lock-release-db.json",
  dbAll(`SELECT * FROM workflow_locks WHERE workflow_id = ?`, workflowId),
);

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

const pausedRun = await waitFor(
  async () => {
    const response = await apiRequest("GET", `/v1/workflow-runs/${runId}`, null, token);
    if (response.response.body?.data?.run?.status === "paused") {
      return response;
    }
    return null;
  },
  "workflow paused state",
);
await writeJson("workflow-run-paused.json", pausedRun);
await writeJson(
  "workflow-run-paused-db.json",
  dbGet(
    `SELECT id, status, deadline_at, paused_at, resumed_at, finished_at, updated_at
     FROM workflow_runs
     WHERE id = ?`,
    runId,
  ),
);

const approvals = await waitFor(
  async () => {
    const response = await apiRequest("GET", "/v1/workflow-approvals", null, token);
    const item = response.response.body?.data?.items?.find?.((entry) => entry.runId === runId);
    if (item) {
      return response;
    }
    return null;
  },
  "workflow approval row",
);
await writeJson("workflow-approvals-list.json", approvals);

const approval = approvals.response.body.data.items.find((entry) => entry.runId === runId);
const approvalId = approval?.id;
if (typeof approvalId !== "string") {
  throw new Error("Failed to locate pending approval");
}

const approvalDecision = await apiRequest(
  "POST",
  `/v1/workflow-approvals/${approvalId}/approve`,
  { comment: "approve for blocker-group1 rerun validation" },
  token,
);
await writeJson("workflow-approval-approve.json", approvalDecision);

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
await writeJson(
  "workflow-run-final-db.json",
  dbGet(
    `SELECT id, status, deadline_at, paused_at, resumed_at, finished_at, updated_at
     FROM workflow_runs
     WHERE id = ?`,
    runId,
  ),
);

await writeJson("blocker-group1-summary.json", {
  health: {
    status: health.response.body?.ok === true ? 200 : health.response.status,
    auth: health.rawBody?.data?.capabilities?.auth ?? null,
  },
  rulesBundle: {
    bundleId,
    createStatus: bundleCreate.response.status,
    updateStatus: bundleUpdate.response.status,
    routeVersionCount: bundleVersions.response.body?.data?.items?.length ?? 0,
    dbVersionCount: dbAll(
      `SELECT id FROM rule_policy_bundle_versions WHERE bundle_id = ?`,
      bundleId,
    ).length,
    latestVersion: dbGet(
      `SELECT id, bundle_id, version, changed_by, change_note, created_at
       FROM rule_policy_bundle_versions
       WHERE bundle_id = ?
       ORDER BY version DESC
       LIMIT 1`,
      bundleId,
    ),
    updatedName: bundleUpdate.response.body?.data?.bundle?.name ?? null,
  },
  workflowLocks: {
    workflowId,
    nonexistentStatus: missingLock.response.status,
    mismatchStatus: mismatchLock.response.status,
    validAcquireStatus: validLock.response.status,
    persistedLockRow: lockDbRow,
    releaseStatus: releaseLock.response.status,
    releaseDbRows: dbAll(`SELECT * FROM workflow_locks WHERE workflow_id = ?`, workflowId),
  },
  workflowRun: {
    runId,
    pausedStatus: pausedRun.response.body?.data?.run?.status ?? null,
    pausedAt: pausedRun.response.body?.data?.run?.pausedAt ?? null,
    deadlineAt: pausedRun.response.body?.data?.run?.deadlineAt ?? null,
    resumedAtAfterApproval: finalRun.response.body?.data?.run?.resumedAt ?? null,
    finishedAt: finalRun.response.body?.data?.run?.finishedAt ?? null,
    finalStatus: finalRun.response.body?.data?.run?.status ?? null,
  },
  approval: {
    approvalId,
    approveStatus: approvalDecision.response.status,
  },
});

db.close();
