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

async function apiRequest(method, pathname, body, token, timeoutMs = 120_000) {
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

await resetDir(outDir);

const invalidProviderId = "missing-provider-issue-00149";

const login = await apiRequest("POST", "/v1/auth/login", { local: true }, null, 15_000);
await writeJson("login.json", login);
const token = login.rawBody?.data?.accessToken;
if (typeof token !== "string" || token.length === 0) {
  throw new Error("Failed to obtain access token");
}

const providers = await apiRequest("GET", "/v1/providers", null, token, 30_000);
await writeJson("providers.json", providers);
const providerItems = Array.isArray(providers.rawBody?.data?.items) ? providers.rawBody.data.items : [];
const defaultProvider = providerItems[0] ?? null;
if (!defaultProvider?.defaultModel) {
  throw new Error("Expected at least one provider with a default model");
}

const beforeCounts = dbGet(
  `SELECT COUNT(*) AS runCount,
          MAX(created_at) AS latestCreatedAt
     FROM friday_agent_runs`,
);
await writeJson("agent-run-count-before.json", beforeCounts);

const start = await apiRequest(
  "POST",
  "/v1/agent/runs",
  {
    task: "Reply with only INVALID_PROVIDER_PRECHECK_OK.",
    providerId: invalidProviderId,
    model: defaultProvider.defaultModel,
  },
  token,
  30_000,
);
await writeJson("start-invalid-run.json", start);

const afterCounts = dbGet(
  `SELECT COUNT(*) AS runCount,
          MAX(created_at) AS latestCreatedAt
     FROM friday_agent_runs`,
);
await writeJson("agent-run-count-after.json", afterCounts);

const invalidProviderRows = dbAll(
  `SELECT id, provider_id, status, response_text, metadata_json, created_at, completed_at
     FROM friday_agent_runs
    WHERE provider_id = ?
    ORDER BY created_at DESC`,
  invalidProviderId,
);
await writeJson("agent-run-invalid-provider-rows.json", invalidProviderRows);

await writeJson("issue-00149-summary.json", {
  checkedAt: new Date().toISOString(),
  invalidProviderId,
  attemptedModel: defaultProvider.defaultModel,
  responseStatus: start.response.status,
  responseBody: start.response.body,
  returnedRunId: start.rawBody?.data?.runId ?? null,
  errorCode: start.rawBody?.error?.code ?? start.rawBody?.code ?? null,
  errorMessage:
    start.rawBody?.error?.message
    ?? start.rawBody?.message
    ?? start.rawBody?.error
    ?? null,
  runCountBefore: beforeCounts?.runCount ?? null,
  runCountAfter: afterCounts?.runCount ?? null,
  runCountUnchanged: beforeCounts?.runCount === afterCounts?.runCount,
  latestCreatedAtBefore: beforeCounts?.latestCreatedAt ?? null,
  latestCreatedAtAfter: afterCounts?.latestCreatedAt ?? null,
  invalidProviderRowCount: invalidProviderRows.length,
  preflightRejected:
    start.response.status >= 400
    && start.rawBody?.data?.runId == null
    && beforeCounts?.runCount === afterCounts?.runCount
    && invalidProviderRows.length === 0,
});
