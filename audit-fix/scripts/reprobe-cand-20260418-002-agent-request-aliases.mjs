import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3242";
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

function dbAll(sql, ...params) {
  return db.prepare(sql).all(...params);
}

function dbGet(sql, ...params) {
  return db.prepare(sql).get(...params) ?? null;
}

await resetDir(outDir);

const login = await apiRequest("POST", "/v1/auth/login", { local: true }, null, 15_000);
await writeJson("login.json", login);
const token = login.rawBody?.data?.accessToken;
if (typeof token !== "string" || token.length === 0) {
  throw new Error("Failed to obtain access token");
}

const providers = await apiRequest("GET", "/v1/providers", null, token, 30_000);
await writeJson("providers.json", providers);
const providerItems = Array.isArray(providers.rawBody?.data?.items) ? providers.rawBody.data.items : [];
const openAiProvider = providerItems.find((provider) => provider.kind === "openai");
const anthropicProvider = providerItems.find((provider) => provider.kind === "anthropic");
if (!openAiProvider?.id) {
  throw new Error("Expected an OpenAI provider to exist for alias rerun");
}

const routing = await apiRequest("GET", "/v1/providers/routing", null, token, 30_000);
await writeJson("routing.json", routing);

const start = await apiRequest(
  "POST",
  "/v1/agent/runs",
  {
    task: "Reply with only ALIAS_PROVIDER_ROUTE_OK.",
    requestedProviderId: openAiProvider.id,
    requestedModel: openAiProvider.defaultModel ?? "gpt-4o",
  },
  token,
  120_000,
);
await writeJson("start-run.json", start);

const runId = start.rawBody?.data?.runId;
if (typeof runId !== "string" || runId.length === 0) {
  throw new Error("Run ID missing from alias rerun");
}

const final = await apiRequest("GET", `/v1/agent/runs/${encodeURIComponent(runId)}`, null, token, 30_000);
await writeJson("final-run.json", final);

const audit = await apiRequest("GET", `/v1/agent/runs/${encodeURIComponent(runId)}/audit`, null, token, 30_000);
await writeJson("audit.json", audit);

await writeJson(
  "agent-run-events-db.json",
  dbAll(
    `SELECT run_id, seq, event_name, payload_json, emitted_at
     FROM friday_agent_run_events
     WHERE run_id = ?
     ORDER BY seq`,
    runId,
  ),
);
await writeJson(
  "agent-run-row-db.json",
  dbGet(
    `SELECT id, provider_id, status, response_text, metadata_json, created_at, completed_at
     FROM friday_agent_runs
     WHERE id = ?`,
    runId,
  ),
);

const routeSelected = (Array.isArray(audit.rawBody?.data?.events) ? audit.rawBody.data.events : [])
  .find((event) => event?.type === "agent.run.route_selected");
const actualExecution = final.rawBody?.data?.run?.actualExecution ?? null;
const routingDefaultProviderId = routing.rawBody?.data?.defaultProviderId ?? null;

await writeJson("cand-20260418-002-summary.json", {
  checkedAt: new Date().toISOString(),
  runId,
  requestedProviderId: openAiProvider.id,
  requestedModel: openAiProvider.defaultModel ?? "gpt-4o",
  routingDefaultProviderId,
  providerCount: providerItems.length,
  hasAnthropicProvider: Boolean(anthropicProvider?.id),
  defaultProviderDiffersFromAliasTarget:
    typeof routingDefaultProviderId === "string" && routingDefaultProviderId !== openAiProvider.id,
  actualProviderId: actualExecution?.actualProviderId ?? null,
  actualProviderKind: actualExecution?.actualProviderKind ?? null,
  actualModel: actualExecution?.actualModel ?? null,
  routeSelectedRequestedProviderId: routeSelected?.payload?.requestedProviderId ?? null,
  routeSelectedRequestedModel: routeSelected?.payload?.requestedModel ?? null,
  aliasHonored:
    actualExecution?.actualProviderId === openAiProvider.id
    && routeSelected?.payload?.requestedProviderId === openAiProvider.id
    && routeSelected?.payload?.requestedModel === (openAiProvider.defaultModel ?? "gpt-4o"),
  finalStatus: final.rawBody?.data?.run?.status ?? null,
  responseText: final.rawBody?.data?.run?.responseText ?? null,
});
