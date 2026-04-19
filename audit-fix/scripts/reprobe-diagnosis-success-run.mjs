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

await resetDir(outDir);

const login = await apiRequest("POST", "/v1/auth/login", { local: true }, null);
await writeJson("login.json", login);
const token = login.rawBody?.data?.accessToken;
if (typeof token !== "string" || token.length === 0) {
  throw new Error("Failed to obtain access token from /v1/auth/login");
}

const providers = await apiRequest("GET", "/v1/providers", null, token);
await writeJson("providers.json", providers);

const provider = providers.rawBody?.data?.items?.[0];
if (!provider?.id || !provider?.defaultModel) {
  throw new Error("Failed to locate a runnable provider");
}

const startRun = await apiRequest(
  "POST",
  "/v1/agent/runs",
  {
    task: "Use the shell-skill-current-datetime skill and report only the returned datetime.",
    providerId: provider.id,
    model: provider.defaultModel,
    sessionKey: `audit:issue-00104:${Date.now()}`,
  },
  token,
);
await writeJson("agent-run-start.json", startRun);

const runId = startRun.rawBody?.data?.runId;
if (typeof runId !== "string") {
  throw new Error("Failed to create agent run");
}

const audit = await apiRequest("GET", `/v1/agent/runs/${runId}/audit`, null, token);
await writeJson("agent-run-audit.json", audit);

const runRow = dbGet(
  `SELECT id, status, error_code, error_message, response_text, summary, created_at, completed_at
   FROM friday_agent_runs
   WHERE id = ?`,
  runId,
);
await writeJson("agent-run-db.json", runRow);

const incidentRows = dbAll(
  `SELECT incident_id, category, severity, status, context_json, created_at, updated_at
   FROM error_incidents
   WHERE json_extract(context_json, '$.agentRunId') = ?
   ORDER BY created_at DESC`,
  runId,
);
await writeJson("agent-run-incidents-db.json", incidentRows);

const failedEvents = (audit.rawBody?.data?.events ?? []).filter((event) => event.type === "agent.run.failed");
const completedEvents = (audit.rawBody?.data?.events ?? []).filter((event) => event.type === "agent.run.completed");

await writeJson("diagnosis-success-run-summary.json", {
  providerId: provider.id,
  providerKind: provider.kind,
  model: provider.defaultModel,
  runId,
  runStatus: startRun.rawBody?.data?.status ?? null,
  failedEventCount: failedEvents.length,
  completedEventCount: completedEvents.length,
  incidentCount: incidentRows.length,
  responseText: runRow?.response_text ?? null,
  containsSuccessIncident: incidentRows.some((row) =>
    typeof row.context_json === "string" && row.context_json.includes("Successfully executed"),
  ),
});

db.close();
