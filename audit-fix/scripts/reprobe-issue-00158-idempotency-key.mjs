import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3241";
const dbPath = process.env.DB_PATH;
const outDir = process.env.OUT_DIR;
const agentTask = process.env.AGENT_TASK ?? "Reply with the exact text idempotent-ok and nothing else.";

if (!dbPath) {
  throw new Error("DB_PATH is required");
}

if (!outDir) {
  throw new Error("OUT_DIR is required");
}

const readonlyDb = new Database(dbPath, { readonly: true });

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

function responseHeadersToObject(headers) {
  return Object.fromEntries(headers.entries());
}

async function apiRequest(method, pathname, body, token, extraHeaders = {}) {
  const url = `${baseUrl}${pathname}`;
  const headers = {
    "content-type": "application/json",
    ...extraHeaders,
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
      headers: responseHeadersToObject(response.headers),
      body: redactTokens(responseBody),
    },
  };
}

function dbAll(sql, ...params) {
  return readonlyDb.prepare(sql).all(...params);
}

function uniqStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollAgentRun(token, runId, maxAttempts = 30, delayMs = 2_000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await apiRequest("GET", `/v1/agent/runs/${encodeURIComponent(runId)}`, null, token);
    const status = result.rawBody?.data?.run?.status;
    if (typeof status === "string" && ["completed", "failed", "cancelled", "timed_out"].includes(status)) {
      return result;
    }
    if (attempt < maxAttempts) {
      await sleep(delayMs);
    }
  }
  return apiRequest("GET", `/v1/agent/runs/${encodeURIComponent(runId)}`, null, token);
}

await resetDir(outDir);

const health = await apiRequest("GET", "/v1/health", null, null);
await writeJson("health.json", health.response.body);

const login = await apiRequest("POST", "/v1/auth/login", { local: true }, null);
await writeJson("login.json", login);

const token = login.rawBody?.data?.accessToken;
const userId = login.rawBody?.data?.user?.id;
if (typeof token !== "string" || token.length === 0) {
  throw new Error("Failed to obtain access token");
}
if (typeof userId !== "string" || userId.length === 0) {
  throw new Error("Failed to determine user id");
}

const providers = await apiRequest("GET", "/v1/providers", null, token);
await writeJson("providers.json", providers);
const providerItems = Array.isArray(providers.rawBody?.data?.items) ? providers.rawBody.data.items : [];
const anthropicProvider = providerItems.find((provider) =>
  provider?.kind === "anthropic"
    && typeof provider?.id === "string"
    && provider.id.length > 0
    && typeof provider?.defaultModel === "string"
    && provider.defaultModel.length > 0
    && provider?.enabled !== false,
);

const nonce = Date.now();
const memoryIdempotencyKey = `issue-00158-memory-${nonce}`;
const memoryBody = {
  namespace: "default",
  content: `issue-00158 memory payload ${nonce}`,
  source: "audit.issue-00158",
  tags: ["issue-00158", "idempotency"],
};

const memoryRowsBefore = dbAll(
  `SELECT id, created_at, metadata_json
   FROM memory_items
   WHERE json_extract(metadata_json, '$.apiRequest.principalId') = ?
     AND json_extract(metadata_json, '$.apiRequest.idempotencyKey') = ?
   ORDER BY created_at ASC`,
  userId,
  memoryIdempotencyKey,
);
await writeJson("memory-rows-before.json", memoryRowsBefore);

const memoryAttempts = [];
for (let attempt = 1; attempt <= 3; attempt += 1) {
  const result = await apiRequest(
    "POST",
    "/v1/memory/items",
    memoryBody,
    token,
    { "idempotency-key": memoryIdempotencyKey },
  );
  memoryAttempts.push(result);
  await writeJson(`memory-attempt-${attempt}.json`, result);
}

const memoryRowsAfter = dbAll(
  `SELECT id, created_at, metadata_json
   FROM memory_items
   WHERE json_extract(metadata_json, '$.apiRequest.principalId') = ?
     AND json_extract(metadata_json, '$.apiRequest.idempotencyKey') = ?
   ORDER BY created_at ASC`,
  userId,
  memoryIdempotencyKey,
);
await writeJson("memory-rows-after.json", memoryRowsAfter);

const agentIdempotencyKey = `issue-00158-agent-${nonce}`;
const agentProbeStartedAt = new Date().toISOString();
const agentBody = {
  task: agentTask,
  timeoutMs: 120000,
  ...(anthropicProvider
    ? {
      providerId: anthropicProvider.id,
      model: anthropicProvider.defaultModel,
    }
    : {}),
};

const agentRowsBefore = dbAll(
  `SELECT id, status, provider_id, model, created_at, metadata_json
   FROM friday_agent_runs
   WHERE json_extract(metadata_json, '$.apiRequest.principalId') = ?
     AND json_extract(metadata_json, '$.apiRequest.idempotencyKey') = ?
   ORDER BY created_at ASC`,
  userId,
  agentIdempotencyKey,
);
await writeJson("agent-rows-before.json", agentRowsBefore);

const agentAttempts = [];
for (let attempt = 1; attempt <= 3; attempt += 1) {
  const result = await apiRequest(
    "POST",
    "/v1/agent/runs",
    agentBody,
    token,
    { "idempotency-key": agentIdempotencyKey },
  );
  agentAttempts.push(result);
  await writeJson(`agent-attempt-${attempt}.json`, result);
}

const agentRowsAfter = dbAll(
  `SELECT id, status, provider_id, model, created_at, metadata_json
   FROM friday_agent_runs
   WHERE json_extract(metadata_json, '$.apiRequest.principalId') = ?
     AND json_extract(metadata_json, '$.apiRequest.idempotencyKey') = ?
   ORDER BY created_at ASC`,
  userId,
  agentIdempotencyKey,
);
await writeJson("agent-rows-after.json", agentRowsAfter);

const memoryResponseIds = uniqStrings(
  memoryAttempts.map((attempt) => attempt.rawBody?.data?.item?.id ?? null),
);
const agentResponseIds = uniqStrings(
  agentAttempts.map((attempt) => attempt.rawBody?.data?.runId ?? null),
);
const finalRunId = agentResponseIds[0] ?? null;
const agentFinal = typeof finalRunId === "string" && finalRunId.length > 0
  ? await pollAgentRun(token, finalRunId)
  : null;
if (agentFinal) {
  await writeJson("agent-final.json", agentFinal);
}
const agentAudit = typeof finalRunId === "string" && finalRunId.length > 0
  ? await apiRequest("GET", `/v1/agent/runs/${encodeURIComponent(finalRunId)}/audit`, null, token)
  : null;
if (agentAudit) {
  await writeJson("agent-audit.json", agentAudit);
}
const agentEventRows = typeof finalRunId === "string" && finalRunId.length > 0
  ? dbAll(
    `SELECT run_id, seq, event_name, payload_json, emitted_at
       FROM friday_agent_run_events
      WHERE run_id = ?
      ORDER BY seq ASC`,
    finalRunId,
  )
  : [];
await writeJson("agent-event-rows.json", agentEventRows);
const usageRows = anthropicProvider
  ? dbAll(
    `SELECT id, provider_id, provider_kind, provider_api, model, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, total_tokens, cost_usd, metadata_json, created_at
       FROM llm_usage_records
      WHERE provider_id = ?
        AND model = ?
        AND created_at >= ?
      ORDER BY created_at ASC`,
    anthropicProvider.id,
    anthropicProvider.defaultModel,
    agentProbeStartedAt,
  )
  : [];
await writeJson("agent-usage-rows.json", usageRows);

const summary = {
  checkedAt: new Date().toISOString(),
  baseUrl,
  dbPath,
  userId,
  anthropicProvider: anthropicProvider
    ? {
      id: anthropicProvider.id,
      model: anthropicProvider.defaultModel,
    }
    : null,
  memory: {
    idempotencyKey: memoryIdempotencyKey,
    statuses: memoryAttempts.map((attempt) => attempt.response.status),
    responseItemIds: memoryResponseIds,
    responseItemIdCount: memoryResponseIds.length,
    sqliteRowIds: memoryRowsAfter.map((row) => row.id),
    sqliteRowCount: memoryRowsAfter.length,
    passed: memoryResponseIds.length === 1 && memoryRowsAfter.length === 1,
  },
  agent: {
    idempotencyKey: agentIdempotencyKey,
    statuses: agentAttempts.map((attempt) => attempt.response.status),
    responseRunIds: agentResponseIds,
    responseRunIdCount: agentResponseIds.length,
    sqliteRowIds: agentRowsAfter.map((row) => row.id),
    sqliteRowCount: agentRowsAfter.length,
    providerIds: uniqStrings(agentRowsAfter.map((row) => row.provider_id ?? null)),
    models: uniqStrings(agentRowsAfter.map((row) => row.model ?? null)),
    finalStatus: agentFinal?.rawBody?.data?.run?.status ?? null,
    finalResponse: typeof agentFinal?.rawBody?.data?.run?.response === "string"
      ? agentFinal.rawBody.data.run.response
      : null,
    auditEventCount: Array.isArray(agentAudit?.rawBody?.data?.events) ? agentAudit.rawBody.data.events.length : 0,
    eventNames: uniqStrings(agentEventRows.map((row) => row.event_name ?? null)),
    usageRowCount: usageRows.length,
    usageProviderKinds: uniqStrings(usageRows.map((row) => row.provider_kind ?? null)),
    usageModels: uniqStrings(usageRows.map((row) => row.model ?? null)),
    passed: agentResponseIds.length === 1 && agentRowsAfter.length === 1,
  },
};

await writeJson("issue-00158-summary.json", summary);

readonlyDb.close();
