import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const baseUrl = process.env.BASE_URL;
const dbPath = process.env.DB_PATH;
const outDir = process.env.OUT_DIR;
const expectedProviderKind = process.env.EXPECTED_PROVIDER_KIND ?? "";
const marker = process.env.MARKER ?? `ISSUE-00150-MARKER-${Date.now()}`;

if (!baseUrl) throw new Error("BASE_URL is required");
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
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const response = await apiRequest("GET", `/v1/agent/runs/${encodeURIComponent(runId)}`, null, token, 30_000);
    const status = response.rawBody?.data?.run?.status;
    if (["completed", "failed", "failed_tests", "cancelled"].includes(status)) {
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Run ${runId} did not finish in time`);
}

function parseMaybeJson(value) {
  if (typeof value !== "string") {
    return value ?? null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function listAuditEvents(audit) {
  return Array.isArray(audit?.rawBody?.data?.events) ? audit.rawBody.data.events : [];
}

function findToolEvent(audit, type, toolName) {
  return listAuditEvents(audit).find((event) =>
    event?.type === type && event?.payload?.toolName === toolName);
}

await resetDir(outDir);

const login = await apiRequest("POST", "/v1/auth/login", { local: true }, null, 15_000);
await writeJson("login.json", login);
const token = login.rawBody?.data?.accessToken;
if (typeof token !== "string" || token.length === 0) {
  throw new Error("Failed to obtain access token");
}

const authMe = await apiRequest("GET", "/v1/auth/me", null, token, 30_000);
await writeJson("auth-me.json", authMe);

const providers = await apiRequest("GET", "/v1/providers", null, token, 30_000);
await writeJson("providers.json", providers);
const provider = providers.rawBody?.data?.items?.find?.((item) =>
  expectedProviderKind ? item.kind === expectedProviderKind : true,
);
if (!provider?.id) {
  throw new Error(`No provider found for kind=${expectedProviderKind || "<any>"}`);
}

const task = [
  "Persist and recall the marker below.",
  "Use memory_store exactly once with:",
  `- namespace: "agent"`,
  `- content: "${marker}"`,
  `- tags: ["issue-00150", "audit"]`,
  "Then use memory_search exactly once with:",
  `- namespace: "agent"`,
  `- query: "${marker}"`,
  "- limit: 5",
  `If the search result contains "${marker}", reply with exactly: FOUND ${marker}`,
  `Otherwise reply with exactly: MISSING ${marker}`,
  "Do not use any other tools and do not add any extra words.",
].join("\n");

const runStart = await apiRequest(
  "POST",
  "/v1/agent/runs",
  {
    task,
    providerId: provider.id,
    constraints: {
      readOnly: false,
      operationalMode: "execute",
    },
  },
  token,
);
await writeJson("run-start.json", runStart);
const runId = runStart.rawBody?.data?.runId;
if (typeof runId !== "string" || runId.length === 0) {
  throw new Error("Run did not return a runId");
}

const runFinal = await waitForRun(runId, token);
const runAudit = await apiRequest("GET", `/v1/agent/runs/${encodeURIComponent(runId)}/audit`, null, token, 30_000);
await writeJson("run-final.json", runFinal);
await writeJson("run-audit.json", runAudit);

const memoryStoreStart = findToolEvent(runAudit, "agent.run.tool_start", "memory_store");
const memoryStoreEnd = findToolEvent(runAudit, "agent.run.tool_end", "memory_store");
const memorySearchStart = findToolEvent(runAudit, "agent.run.tool_start", "memory_search");
const memorySearchEnd = findToolEvent(runAudit, "agent.run.tool_end", "memory_search");
const parsedStoreSummary = parseMaybeJson(memoryStoreEnd?.payload?.summary);
const parsedSearchSummary = parseMaybeJson(memorySearchEnd?.payload?.summary);
const storedItemId = typeof parsedStoreSummary?.itemId === "string" ? parsedStoreSummary.itemId : null;

const publicList = await apiRequest(
  "GET",
  `/v1/memory/items?namespace=${encodeURIComponent("agent")}&limit=20`,
  null,
  token,
  30_000,
);
const publicSearch = await apiRequest(
  "POST",
  "/v1/memory/search",
  { namespace: "agent", query: marker, limit: 5 },
  token,
  30_000,
);
await writeJson("public-memory-list.json", publicList);
await writeJson("public-memory-search.json", publicSearch);

const itemGet = storedItemId
  ? await apiRequest("GET", `/v1/memory/items/${encodeURIComponent(storedItemId)}`, null, token, 30_000)
  : null;
if (itemGet) {
  await writeJson("memory-item-get.json", itemGet);
}

const dbRowsById = storedItemId
  ? dbAll(
    `SELECT id, namespace, key, value_json, content_text, source, tags_json, created_at, updated_at
       FROM memory_items
      WHERE id = ?`,
    storedItemId,
  )
  : [];
const dbRowsByMarker = dbAll(
  `SELECT id, namespace, key, value_json, content_text, source, tags_json, created_at, updated_at
     FROM memory_items
    WHERE content_text LIKE ? OR value_json LIKE ?
    ORDER BY created_at DESC`,
  `%${marker}%`,
  `%${marker}%`,
);
await writeJson("db-rows-by-id.json", dbRowsById);
await writeJson("db-rows-by-marker.json", dbRowsByMarker);

const deleteResponse = storedItemId
  ? await apiRequest("DELETE", `/v1/memory/items/${encodeURIComponent(storedItemId)}`, null, token, 30_000)
  : null;
if (deleteResponse) {
  await writeJson("memory-item-delete.json", deleteResponse);
}

const dbRowsAfterDelete = storedItemId
  ? dbAll(
    `SELECT id, namespace, key, value_json, content_text, source, tags_json, created_at, updated_at
       FROM memory_items
      WHERE id = ?`,
    storedItemId,
  )
  : [];
await writeJson("db-rows-after-delete.json", dbRowsAfterDelete);

const runStatus = runFinal.rawBody?.data?.run?.status ?? null;
const responseText = String(runFinal.rawBody?.data?.run?.responseText ?? runFinal.rawBody?.data?.run?.summary ?? "").trim();
const searchResults = Array.isArray(parsedSearchSummary) ? parsedSearchSummary : [];
const searchContainsMarker = searchResults.some((item) => String(item?.content ?? "").includes(marker));
const dbNamespaces = [...new Set(dbRowsByMarker.map((row) => row.namespace))];

await writeJson("issue-00150-summary.json", {
  checkedAt: new Date().toISOString(),
  route: "/v1/agent/runs",
  providerKind: provider.kind,
  providerId: provider.id,
  marker,
  runId,
  runStatus,
  responseText,
  respondedFound: responseText === `FOUND ${marker}`,
  memoryStore: {
    toolStartParams: memoryStoreStart?.payload?.params ?? null,
    isError: memoryStoreEnd?.payload?.isError ?? null,
    summary: parsedStoreSummary,
    storedItemId,
  },
  memorySearch: {
    toolStartParams: memorySearchStart?.payload?.params ?? null,
    isError: memorySearchEnd?.payload?.isError ?? null,
    summary: parsedSearchSummary,
    resultCount: searchResults.length,
    containsMarker: searchContainsMarker,
  },
  publicMemorySearch: {
    status: publicSearch.response.status,
    itemCount: Array.isArray(publicSearch.rawBody?.data?.items) ? publicSearch.rawBody.data.items.length : null,
    containsMarker: Array.isArray(publicSearch.rawBody?.data?.items)
      ? publicSearch.rawBody.data.items.some((item) => String(item?.item?.content ?? "").includes(marker))
      : false,
  },
  db: {
    rowCountById: dbRowsById.length,
    rowCountByMarker: dbRowsByMarker.length,
    namespaces: dbNamespaces,
    storedUnderPlainAgentNamespace: dbNamespaces.includes("agent"),
    storedUnderScopedNamespace: dbNamespaces.some((namespace) => typeof namespace === "string" && namespace.startsWith("agent:")),
  },
  cleanup: {
    deleteStatus: deleteResponse?.response.status ?? null,
    remainingRowsAfterDelete: dbRowsAfterDelete.length,
  },
});
