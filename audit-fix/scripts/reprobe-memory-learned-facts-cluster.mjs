import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const baseUrl = process.env.BASE_URL;
const dbPath = process.env.DB_PATH;
const outDir = process.env.OUT_DIR;
const expectedProviderKind = process.env.EXPECTED_PROVIDER_KIND ?? "";
const logPath = process.env.LOG_PATH ?? "";
const auditName = process.env.AUDIT_NAME ?? `MemoryAuditName-${Date.now()}`;

if (!baseUrl) throw new Error("BASE_URL is required");
if (!dbPath) throw new Error("DB_PATH is required");
if (!outDir) throw new Error("OUT_DIR is required");

const db = new Database(dbPath, { readonly: true });

async function resetDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
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

async function writeJson(name, value) {
  await fs.writeFile(path.join(outDir, name), `${JSON.stringify(redactTokens(value), null, 2)}\n`, "utf8");
}

async function writeText(name, value) {
  await fs.writeFile(path.join(outDir, name), value, "utf8");
}

async function maybeReadLogTail(file, lines = 200) {
  if (!file) return;
  try {
    const text = await fs.readFile(file, "utf8");
    await writeText("runtime-log-tail.txt", `${text.split(/\r?\n/).slice(-lines).join("\n")}\n`);
  } catch {
    // ignore
  }
}

function redactHeaders(headers = {}) {
  return {
    ...headers,
    authorization: headers.authorization ? "Bearer <redacted>" : undefined,
  };
}

async function apiRequest(method, pathname, body, token, timeoutMs = 180_000) {
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
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const rawBody = await response.json().catch(() => null);
    return {
      request: {
        method,
        url,
        headers: redactHeaders(headers),
        body: body ?? null,
      },
      response: {
        status: response.status,
        body: rawBody,
      },
      rawBody,
    };
  } finally {
    clearTimeout(timer);
  }
}

function dbAll(sql, ...params) {
  return db.prepare(sql).all(...params);
}

async function waitForRun(runId, token) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await apiRequest("GET", `/v1/agent/runs/${encodeURIComponent(runId)}`, null, token, 30_000);
    const status = response.rawBody?.data?.run?.status;
    if (["completed", "failed", "failed_tests", "cancelled"].includes(status)) {
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Run ${runId} did not finish in time`);
}

function findMemorySearchToolEvent(audit) {
  const events = Array.isArray(audit?.rawBody?.data?.events) ? audit.rawBody.data.events : [];
  return events.find((event) =>
    event?.type === "agent.run.tool_end" && event?.payload?.toolName === "memory_search");
}

function readResponseText(runResponse) {
  return String(runResponse?.rawBody?.data?.run?.responseText ?? runResponse?.rawBody?.data?.run?.summary ?? "");
}

function listLearnedFactItems(response) {
  return Array.isArray(response?.rawBody?.data?.items) ? response.rawBody.data.items : [];
}

function detectNameLearnedFactKey(response, expectedValue) {
  return listLearnedFactItems(response)
    .find((item) =>
      /(^|:)(?:display_name|user_name|name)$/i.test(String(item?.key ?? ""))
      && String(item?.value ?? "") === expectedValue)
    ?.key ?? null;
}

function hasLearnedFactMemoryItem(response, factKey) {
  if (!factKey) {
    return false;
  }
  return Array.isArray(response?.rawBody?.data?.items)
    ? response.rawBody.data.items.some((item) => item?.id === `learned-fact:${factKey}`)
    : false;
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
const provider = providers.rawBody?.data?.items?.find?.((item) =>
  expectedProviderKind ? item.kind === expectedProviderKind : true,
);
if (!provider?.id) {
  throw new Error(`No provider found for kind=${expectedProviderKind || "<any>"}`);
}

const clearBefore = await apiRequest("DELETE", "/v1/uix/learned-facts", null, token, 30_000);
await writeJson("learned-facts-clear-before.json", clearBefore);
const beforeFacts = await apiRequest("GET", "/v1/uix/learned-facts", null, token, 30_000);
const beforeMemoryList = await apiRequest("GET", "/v1/memory/items?limit=50", null, token, 30_000);
const beforeMemorySearch = await apiRequest("POST", "/v1/memory/search", { query: "call me", limit: 20 }, token, 30_000);
await writeJson("learned-facts-before.json", beforeFacts);
await writeJson("memory-list-before.json", beforeMemoryList);
await writeJson("memory-search-before.json", beforeMemorySearch);
await writeJson(
  "preference-facts-before-db.json",
  dbAll(
    `SELECT fact_id, user_id, key, value_json, confidence, evidence_count, last_confirmed_at, updated_at
       FROM preference_facts
      ORDER BY updated_at DESC`,
  ),
);

const teachRunStart = await apiRequest(
  "POST",
  "/v1/agent/runs",
  {
    task: `Call me ${auditName}.`,
    providerId: provider.id,
  },
  token,
);
await writeJson("teach-run-start.json", teachRunStart);
const teachRunId = teachRunStart.rawBody?.data?.runId;
if (typeof teachRunId !== "string" || teachRunId.length === 0) {
  throw new Error("Teach run did not return a runId");
}
const teachRunFinal = await waitForRun(teachRunId, token);
const teachRunAudit = await apiRequest("GET", `/v1/agent/runs/${encodeURIComponent(teachRunId)}/audit`, null, token, 30_000);
await writeJson("teach-run-final.json", teachRunFinal);
await writeJson("teach-run-audit.json", teachRunAudit);

const afterTeachFacts = await apiRequest("GET", "/v1/uix/learned-facts", null, token, 30_000);
const afterTeachMemoryList = await apiRequest("GET", "/v1/memory/items?limit=50", null, token, 30_000);
const afterTeachMemorySearch = await apiRequest(
  "POST",
  "/v1/memory/search",
  { query: "what should you call me", limit: 20 },
  token,
  30_000,
);
await writeJson("learned-facts-after-teach.json", afterTeachFacts);
await writeJson("memory-list-after-teach.json", afterTeachMemoryList);
await writeJson("memory-search-after-teach.json", afterTeachMemorySearch);
await writeJson(
  "preference-facts-after-teach-db.json",
  dbAll(
    `SELECT fact_id, user_id, key, value_json, confidence, evidence_count, last_confirmed_at, updated_at
       FROM preference_facts
      ORDER BY updated_at DESC`,
  ),
);
const learnedFactKeyAfterTeach = detectNameLearnedFactKey(afterTeachFacts, auditName);

async function runRecall(label, task) {
  const start = await apiRequest(
    "POST",
    "/v1/agent/runs",
    { task, providerId: provider.id },
    token,
  );
  await writeJson(`${label}-run-start.json`, start);
  const runId = start.rawBody?.data?.runId;
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error(`${label} run did not return a runId`);
  }
  const final = await waitForRun(runId, token);
  const audit = await apiRequest("GET", `/v1/agent/runs/${encodeURIComponent(runId)}/audit`, null, token, 30_000);
  await writeJson(`${label}-run-final.json`, final);
  await writeJson(`${label}-run-audit.json`, audit);
  return { runId, final, audit };
}

const naturalRecall = await runRecall("natural-recall", "What should you call me? Reply with only the name.");
const explicitRecall = await runRecall("explicit-recall", "Use memory_search if needed. What should you call me? Reply with only the name.");

const deleteByKey = await apiRequest(
  "DELETE",
  `/v1/uix/learned-facts/${encodeURIComponent(learnedFactKeyAfterTeach ?? "pref:display_name")}`,
  null,
  token,
  30_000,
);
await writeJson("learned-facts-delete-by-key.json", deleteByKey);

const afterDeleteFacts = await apiRequest("GET", "/v1/uix/learned-facts", null, token, 30_000);
const afterDeleteMemoryList = await apiRequest("GET", "/v1/memory/items?limit=50", null, token, 30_000);
const afterDeleteMemorySearch = await apiRequest(
  "POST",
  "/v1/memory/search",
  { query: "what should you call me", limit: 20 },
  token,
  30_000,
);
await writeJson("learned-facts-after-delete.json", afterDeleteFacts);
await writeJson("memory-list-after-delete.json", afterDeleteMemoryList);
await writeJson("memory-search-after-delete.json", afterDeleteMemorySearch);
await writeJson(
  "preference-facts-after-delete-db.json",
  dbAll(
    `SELECT fact_id, user_id, key, value_json, confidence, evidence_count, last_confirmed_at, updated_at
       FROM preference_facts
      ORDER BY updated_at DESC`,
  ),
);

await maybeReadLogTail(logPath);

const naturalToolEvent = findMemorySearchToolEvent(naturalRecall.audit);
const explicitToolEvent = findMemorySearchToolEvent(explicitRecall.audit);
const naturalResponse = readResponseText(naturalRecall.final).trim();
const explicitResponse = readResponseText(explicitRecall.final).trim();

await writeJson("memory-learned-facts-summary.json", {
  checkedAt: new Date().toISOString(),
  baseUrl,
  providerKind: provider.kind,
  providerId: provider.id,
  auditName,
  teachRunId,
  teachRunStatus: teachRunFinal.rawBody?.data?.run?.status ?? null,
  learnedFactKeyAfterTeach,
  learnedFactPresentAfterTeach: Boolean(learnedFactKeyAfterTeach),
  memoryListShowsLearnedFactAfterTeach: hasLearnedFactMemoryItem(afterTeachMemoryList, learnedFactKeyAfterTeach),
  memorySearchShowsLearnedFactAfterTeach: Array.isArray(afterTeachMemorySearch.rawBody?.data?.items)
    ? afterTeachMemorySearch.rawBody.data.items.some((item) => item.item?.id === `learned-fact:${learnedFactKeyAfterTeach}`)
    : false,
  naturalRecall: {
    runId: naturalRecall.runId,
    status: naturalRecall.final.rawBody?.data?.run?.status ?? null,
    responseText: naturalResponse,
    usedMemorySearch: Boolean(naturalToolEvent),
    memorySearchSummary: naturalToolEvent?.payload?.summary ?? null,
    answeredExpectedName: naturalResponse === auditName,
  },
  explicitRecall: {
    runId: explicitRecall.runId,
    status: explicitRecall.final.rawBody?.data?.run?.status ?? null,
    responseText: explicitResponse,
    usedMemorySearch: Boolean(explicitToolEvent),
    memorySearchSummary: explicitToolEvent?.payload?.summary ?? null,
    answeredExpectedName: explicitResponse === auditName,
  },
  deleteByKeyStatus: deleteByKey.response.status,
  deletedFactKey: learnedFactKeyAfterTeach,
  learnedFactPresentAfterDelete: Boolean(learnedFactKeyAfterTeach)
    && listLearnedFactItems(afterDeleteFacts).some((item) => item.key === learnedFactKeyAfterTeach),
  memoryListShowsLearnedFactAfterDelete: hasLearnedFactMemoryItem(afterDeleteMemoryList, learnedFactKeyAfterTeach),
});
