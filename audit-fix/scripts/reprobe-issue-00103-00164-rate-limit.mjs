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
        headers: Object.fromEntries(response.headers.entries()),
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

const login = await apiRequest("POST", "/v1/auth/login", { local: true }, null, 15_000);
await writeJson("login.json", login);
const token = login.rawBody?.data?.accessToken;
if (typeof token !== "string" || token.length === 0) {
  throw new Error("Failed to obtain access token");
}

const me = await apiRequest("GET", "/v1/auth/me", null, token, 15_000);
await writeJson("auth-me.json", me);
const principalId = me.rawBody?.data?.principal?.principalId ?? null;

const providers = await apiRequest("GET", "/v1/providers", null, token, 30_000);
await writeJson("providers.json", providers);
const providerItems = Array.isArray(providers.rawBody?.data?.items) ? providers.rawBody.data.items : [];
const anthropicProvider = providerItems.find((provider) => provider.kind === "anthropic");
if (!anthropicProvider?.id || !anthropicProvider?.defaultModel) {
  throw new Error("Anthropic provider was not available");
}

const beforeAgentRows = dbAll(
  `SELECT bucket_key, window_start, hit_count, updated_at
     FROM api_rate_limit_counters
    WHERE bucket_key LIKE 'agent.run:%'
    ORDER BY updated_at DESC, bucket_key DESC`,
);
await writeJson("agent-run-counters-before.json", beforeAgentRows);

const beforeMemoryRows = dbAll(
  `SELECT bucket_key, window_start, hit_count, updated_at
     FROM api_rate_limit_counters
    WHERE bucket_key LIKE 'memory.write:%'
    ORDER BY updated_at DESC, bucket_key DESC`,
);
await writeJson("memory-write-counters-before.json", beforeMemoryRows);

const memoryWrite = await apiRequest(
  "POST",
  "/v1/memory/items",
  {
    namespace: "default",
    content: "RATE_LIMIT_MEMORY_HEADER_OK",
    source: "rate-limit-reprobe",
    key: `rate-limit-${Date.now()}`,
  },
  token,
  30_000,
);
await writeJson("memory-write.json", memoryWrite);

const runRequests = Array.from({ length: 15 }, (_, index) =>
  apiRequest(
    "POST",
    "/v1/agent/runs",
    {
      task: `Reply with only RATE_LIMIT_PROBE_OK_${index}.`,
      providerId: anthropicProvider.id,
      model: anthropicProvider.defaultModel,
    },
    token,
    120_000,
  ),
);
const runResponses = await Promise.all(runRequests);
await writeJson("agent-run-starts.json", runResponses);

const acceptedRunIds = runResponses
  .map((entry) => entry.rawBody?.data?.runId)
  .filter((value) => typeof value === "string");

const cancelResponses = await Promise.all(
  acceptedRunIds.map((runId) =>
    apiRequest("POST", `/v1/agent/runs/${encodeURIComponent(runId)}/cancel`, null, token, 30_000),
  ),
);
await writeJson("agent-run-cancels.json", cancelResponses);

const afterAgentRows = dbAll(
  `SELECT bucket_key, window_start, hit_count, updated_at
     FROM api_rate_limit_counters
    WHERE bucket_key LIKE 'agent.run:%'
    ORDER BY updated_at DESC, bucket_key DESC`,
);
await writeJson("agent-run-counters-after.json", afterAgentRows);

const afterMemoryRows = dbAll(
  `SELECT bucket_key, window_start, hit_count, updated_at
     FROM api_rate_limit_counters
    WHERE bucket_key LIKE 'memory.write:%'
    ORDER BY updated_at DESC, bucket_key DESC`,
);
await writeJson("memory-write-counters-after.json", afterMemoryRows);

const createdRuns = dbGet(
  `SELECT COUNT(*) AS runCount
     FROM friday_agent_runs
    WHERE provider_id = ?
      AND created_at >= datetime('now', '-10 minutes')`,
  anthropicProvider.id,
);
await writeJson("recent-agent-run-count.json", createdRuns);

const summary = {
  checkedAt: new Date().toISOString(),
  principalId,
  anthropicProviderId: anthropicProvider.id,
  anthropicModel: anthropicProvider.defaultModel,
  acceptedCount: runResponses.filter((entry) => entry.response.status === 200).length,
  rateLimitedCount: runResponses.filter((entry) => entry.response.status === 429).length,
  distinctRunIds: [...new Set(acceptedRunIds)].length,
  anyUnexpectedStatuses: runResponses
    .map((entry) => entry.response.status)
    .filter((status) => status !== 200 && status !== 429),
  agentRunCounterRowsAfter: afterAgentRows.length,
  latestAgentRunCounter: afterAgentRows[0] ?? null,
  memoryWriteStatus: memoryWrite.response.status,
  memoryWriteRateLimitLimit: memoryWrite.response.headers["x-ratelimit-limit"] ?? null,
  memoryWriteRateLimitRemaining: memoryWrite.response.headers["x-ratelimit-remaining"] ?? null,
  memoryWriteCounterRowsAfter: afterMemoryRows.length,
  latestMemoryWriteCounter: afterMemoryRows[0] ?? null,
};

await writeJson("issues-00103-00164-summary.json", summary);
