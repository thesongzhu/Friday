import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3241";
const outDir = process.env.OUT_DIR;
const dbPath = process.env.DB_PATH;
const logPath = process.env.LOG_PATH;
const secretPath = process.env.SECRET_PATH;

if (!outDir) {
  throw new Error("OUT_DIR is required");
}

if (!dbPath) {
  throw new Error("DB_PATH is required");
}

if (!logPath) {
  throw new Error("LOG_PATH is required");
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

function decodeAccessToken(accessToken) {
  const [payloadB64] = accessToken.split(".");
  return JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
}

function encodeAccessToken(claims, secret) {
  const payloadB64 = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signature}`;
}

function readTokenState(tokenId, sessionId) {
  const revokedAccessToken = db
    .prepare("SELECT token_id, expires_at_epoch, revoked_at FROM revoked_access_tokens WHERE token_id = ?")
    .get(tokenId);
  const trackedAccessToken = db
    .prepare(
      "SELECT token_id, session_id, user_id, expires_at_epoch, revoked_at, created_at, updated_at FROM auth_access_tokens WHERE token_id = ?",
    )
    .get(tokenId);
  const authSession = sessionId
    ? db
      .prepare("SELECT id, user_id, revoked_at, expires_at, updated_at FROM auth_sessions WHERE id = ?")
      .get(sessionId)
    : null;
  return {
    revokedAccessToken: revokedAccessToken ?? null,
    trackedAccessToken: trackedAccessToken ?? null,
    authSession: authSession ?? null,
  };
}

async function readLogTail(file, maxLines = 120) {
  const text = await fs.readFile(file, "utf8");
  return text.split(/\r?\n/).slice(-maxLines).join("\n");
}

await resetDir(outDir);

const schemaVersion = db.prepare("SELECT MAX(version) as version FROM schema_migrations").get();
await writeJson("schema-version.json", schemaVersion);

const health = await apiRequest("GET", "/v1/health", null, null);
await writeJson("health.json", health);

const login = await apiRequest("POST", "/v1/auth/login", { local: true }, null);
await writeJson("login.json", login);

const accessToken = login.rawBody?.data?.accessToken;
if (typeof accessToken !== "string" || accessToken.length === 0) {
  throw new Error("Failed to obtain access token from /v1/auth/login");
}

const claims = decodeAccessToken(accessToken);
await writeJson("access-token-claims.json", claims);

const stateBefore = readTokenState(claims.tokenId, claims.sid);
await writeJson("state-before.json", stateBefore);

const revoke = await apiRequest(
  "POST",
  "/v1/security/tokens/revoke",
  { tokenId: claims.tokenId },
  accessToken,
);
await writeJson("revoke.json", revoke);

const meAfter = await apiRequest("GET", "/v1/auth/me", null, accessToken);
await writeJson("auth-me-after-revoke.json", meAfter);

const stateAfter = readTokenState(claims.tokenId, claims.sid);
await writeJson("state-after.json", stateAfter);

let legacyProbeSummary = null;
if (secretPath) {
  const secret = (await fs.readFile(secretPath, "utf8")).trim();
  const legacyClaims = {
    ...claims,
    tokenId: crypto.randomUUID(),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
    sid: crypto.randomUUID(),
  };
  const legacyToken = encodeAccessToken(legacyClaims, secret);
  const legacyStateBefore = readTokenState(legacyClaims.tokenId, legacyClaims.sid);
  await writeJson("legacy-state-before.json", legacyStateBefore);
  const legacyAuthMe = await apiRequest("GET", "/v1/auth/me", null, legacyToken);
  await writeJson("legacy-auth-me.json", legacyAuthMe);
  const legacyStateAfter = readTokenState(legacyClaims.tokenId, legacyClaims.sid);
  await writeJson("legacy-state-after.json", legacyStateAfter);
  legacyProbeSummary = {
    tokenId: legacyClaims.tokenId,
    sessionId: legacyClaims.sid,
    authMeStatus: legacyAuthMe.response.status,
    authMeError: legacyAuthMe.response.body?.error ?? null,
    trackedBefore: legacyStateBefore.trackedAccessToken !== null,
    trackedAfter: legacyStateAfter.trackedAccessToken !== null,
  };
}

const logTail = await readLogTail(logPath);
await fs.writeFile(path.join(outDir, "runtime-log-tail.txt"), `${logTail}\n`, "utf8");

await writeJson("issue-00186-summary.json", {
  checkedAt: new Date().toISOString(),
  schemaVersion: schemaVersion?.version ?? null,
  tokenId: claims.tokenId,
  sessionId: claims.sid ?? null,
  revokeStatus: revoke.response.status,
  revokeBody: revoke.response.body,
  authMeAfterStatus: meAfter.response.status,
  authMeAfterError: meAfter.response.body?.error ?? null,
  trackedBefore: stateBefore.trackedAccessToken !== null,
  trackedAfterRevokedAt: stateAfter.trackedAccessToken?.revoked_at ?? null,
  sessionAfterRevokedAt: stateAfter.authSession?.revoked_at ?? null,
  revokedAccessTokenPersisted: stateAfter.revokedAccessToken !== null,
  legacyProbe: legacyProbeSummary,
});
