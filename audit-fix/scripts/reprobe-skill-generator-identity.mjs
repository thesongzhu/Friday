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

await resetDir(outDir);

const login = await apiRequest("POST", "/v1/auth/login", { local: true }, null);
await writeJson("login.json", login);

const token = login.rawBody?.data?.accessToken;
const principalUserId = login.rawBody?.data?.user?.id;
if (typeof token !== "string" || token.length === 0 || typeof principalUserId !== "string") {
  throw new Error("Failed to obtain access token from /v1/auth/login");
}

const sessionCountBefore = dbGet(
  `SELECT COUNT(*) AS count
   FROM memory_items
   WHERE namespace = 'skill-generator-session'`,
);
await writeJson("session-count-before.json", sessionCountBefore);

const mismatch = await apiRequest(
  "POST",
  "/v1/skills/generator/sessions",
  {
    goal: `Audit skill generator mismatch ${Date.now()}`,
    userId: "victim-999",
    channel: "assistant",
  },
  token,
);
await writeJson("session-start-mismatch.json", mismatch);

const sessionCountAfterMismatch = dbGet(
  `SELECT COUNT(*) AS count
   FROM memory_items
   WHERE namespace = 'skill-generator-session'`,
);
await writeJson("session-count-after-mismatch.json", sessionCountAfterMismatch);

const success = await apiRequest(
  "POST",
  "/v1/skills/generator/sessions",
  {
    goal: `Audit skill generator principal ${Date.now()}`,
    userId: principalUserId,
    channel: "assistant",
  },
  token,
);
await writeJson("session-start-success.json", success);

const sessionId = success.rawBody?.data?.session?.sessionId;
if (typeof sessionId !== "string") {
  throw new Error("Failed to create skill generator session");
}

const getSession = await apiRequest(
  "GET",
  `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}`,
  null,
  token,
);
await writeJson("session-get.json", getSession);

const persisted = dbGet(
  `SELECT key, value_json, created_at, updated_at
   FROM memory_items
   WHERE namespace = 'skill-generator-session' AND key = ?`,
  sessionId,
);
const persistedValue = persisted?.value_json ? JSON.parse(persisted.value_json) : null;
await writeJson("session-db.json", {
  ...persisted,
  value_json: persistedValue,
});

await writeJson("skill-generator-identity-summary.json", {
  mismatchStatus: mismatch.response.status,
  mismatchErrorCode: mismatch.response.body?.error?.code ?? null,
  mismatchCountUnchanged:
    sessionCountBefore?.count === sessionCountAfterMismatch?.count,
  successStatus: success.response.status,
  sessionId,
  responseUserId: getSession.rawBody?.data?.session?.userId ?? null,
  responseTenantUserId: getSession.rawBody?.data?.session?.tenantContext?.userId ?? null,
  dbUserId: persistedValue?.userId ?? null,
  dbTenantUserId: persistedValue?.tenantContext?.userId ?? null,
  dbTenantHubId: persistedValue?.tenantContext?.hubId ?? null,
  identityConsistent:
    getSession.rawBody?.data?.session?.userId === principalUserId
    && getSession.rawBody?.data?.session?.tenantContext?.userId === principalUserId
    && persistedValue?.userId === principalUserId
    && persistedValue?.tenantContext?.userId === principalUserId,
});

db.close();
