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

const readonlyDb = new Database(dbPath, { readonly: true });
const lockDb = new Database(dbPath);
lockDb.pragma("busy_timeout = 1");

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
      headers: responseHeadersToObject(response.headers),
      body: redactTokens(responseBody),
    },
  };
}

function dbGet(sql, ...params) {
  return readonlyDb.prepare(sql).get(...params) ?? null;
}

await resetDir(outDir);

const health = await apiRequest("GET", "/v1/health", null, null);
await writeJson("health.json", health.response.body);

const loginBefore = await apiRequest("POST", "/v1/auth/login", { local: true }, null);
await writeJson("login-before-lock.json", loginBefore);

const token = loginBefore.rawBody?.data?.accessToken;
const userId = loginBefore.rawBody?.data?.user?.id;
if (typeof token !== "string" || token.length === 0) {
  throw new Error("Failed to obtain access token before DB lock");
}
if (typeof userId !== "string" || userId.length === 0) {
  throw new Error("Failed to determine user id before DB lock");
}

const secretRefKey = `audit.issue-00165.${Date.now()}`; // pragma: allowlist secret
const authSessionsBefore = dbGet(
  "SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?",
  userId,
);
const secretRowsBefore = dbGet(
  "SELECT COUNT(*) AS count FROM secrets WHERE scope = ? AND ref_key = ?",
  "user",
  secretRefKey,
);
await writeJson("auth-sessions-before.json", authSessionsBefore);
await writeJson("secret-rows-before.json", secretRowsBefore);

let lockedLogin;
let lockedSecretCreate;
let lockedAgentRuns;

lockDb.exec("BEGIN IMMEDIATE");
try {
  lockedLogin = await apiRequest("POST", "/v1/auth/login", { local: true }, null);
  lockedSecretCreate = await apiRequest(
    "POST",
    "/v1/secrets",
    {
      scope: "user",
      refKey: secretRefKey,
      value: "issue-00165-secret",
    },
    token,
  );
  lockedAgentRuns = await apiRequest("GET", "/v1/agent/runs?limit=1", null, token);
} finally {
  try {
    lockDb.exec("ROLLBACK");
  } finally {
    lockDb.close();
  }
}

await writeJson("locked-login.json", lockedLogin);
await writeJson("locked-secret-create.json", lockedSecretCreate);
await writeJson("locked-agent-runs.json", lockedAgentRuns);

const authSessionsAfter = dbGet(
  "SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?",
  userId,
);
const secretRowsAfter = dbGet(
  "SELECT COUNT(*) AS count FROM secrets WHERE scope = ? AND ref_key = ?",
  "user",
  secretRefKey,
);
await writeJson("auth-sessions-after.json", authSessionsAfter);
await writeJson("secret-rows-after.json", secretRowsAfter);

const summary = {
  checkedAt: new Date().toISOString(),
  baseUrl,
  dbPath,
  userId,
  secretRefKey,
  lockedLogin: {
    status: lockedLogin?.response?.status ?? null,
    code: lockedLogin?.rawBody?.error?.code ?? null,
    retryable: lockedLogin?.rawBody?.error?.retryable ?? null,
    retryAfterMs: lockedLogin?.rawBody?.error?.retryAfterMs ?? null,
    retryAfterHeader: lockedLogin?.response?.headers?.["retry-after"] ?? null,
  },
  lockedSecretCreate: {
    status: lockedSecretCreate?.response?.status ?? null,
    code: lockedSecretCreate?.rawBody?.error?.code ?? null,
    retryable: lockedSecretCreate?.rawBody?.error?.retryable ?? null,
    retryAfterMs: lockedSecretCreate?.rawBody?.error?.retryAfterMs ?? null,
    retryAfterHeader: lockedSecretCreate?.response?.headers?.["retry-after"] ?? null,
  },
  lockedAgentRuns: {
    status: lockedAgentRuns?.response?.status ?? null,
    ok: lockedAgentRuns?.rawBody?.ok ?? null,
  },
  authSessionsBefore: authSessionsBefore?.count ?? null,
  authSessionsAfter: authSessionsAfter?.count ?? null,
  authSessionInsertedUnderLock:
    typeof authSessionsBefore?.count === "number"
    && typeof authSessionsAfter?.count === "number"
    && authSessionsAfter.count > authSessionsBefore.count,
  secretRowsBefore: secretRowsBefore?.count ?? null,
  secretRowsAfter: secretRowsAfter?.count ?? null,
  secretPersistedUnderLock:
    typeof secretRowsBefore?.count === "number"
    && typeof secretRowsAfter?.count === "number"
    && secretRowsAfter.count > secretRowsBefore.count,
};

await writeJson("issue-00165-summary.json", summary);

readonlyDb.close();
