import fs from "node:fs/promises";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
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

function responseHeadersToObject(headers) {
  return Object.fromEntries(headers.entries());
}

function redactHeaders(headers = {}) {
  return {
    ...headers,
    authorization: headers.authorization ? "Bearer <redacted>" : undefined,
  };
}

async function apiRequest(method, pathname, body, token, timeoutMs = 30_000) {
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
        headers: responseHeadersToObject(response.headers),
        body: responseBody,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function checkpointRow(satelliteId, streamId) {
  return db.prepare(
    `SELECT key, value_json, revision, created_at, updated_at
       FROM hub_settings
      WHERE key = ?`,
  ).get(`ack_checkpoint:${satelliteId}:${streamId}`) ?? null;
}

await resetDir(outDir);

const login = await apiRequest("POST", "/v1/auth/login", { local: true }, null);
await writeJson("login.json", login);
const adminToken = login.rawBody?.data?.accessToken;
if (typeof adminToken !== "string" || adminToken.length === 0) {
  throw new Error("Failed to obtain admin access token");
}

const { publicKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

const register = await apiRequest(
  "POST",
  "/v1/satellites/register",
  {
    type: "desktop",
    displayName: "Audit Resume Cursor Probe",
    publicKey: publicKeyPem,
    runtime: {
      platform: "darwin",
      arch: "arm64",
      appVersion: "audit-probe",
      nodeVersion: process.version,
    },
    transport: "http-poll",
  },
  null,
);
await writeJson("register.json", register);
const satelliteId = register.rawBody?.data?.satelliteId;
if (typeof satelliteId !== "string" || satelliteId.length === 0) {
  throw new Error("Satellite registration did not return satelliteId");
}

const approve = await apiRequest(
  "POST",
  `/v1/satellites/${encodeURIComponent(satelliteId)}/pairing/approve`,
  { scopes: ["satellite.write"], tokenTtlMs: 300_000 },
  adminToken,
);
await writeJson("approve.json", approve);
const satelliteToken = approve.rawBody?.data?.token;
if (typeof satelliteToken !== "string" || satelliteToken.length === 0) {
  throw new Error("Satellite approval did not return token");
}

const streamId = `satellite:${satelliteId}`;
await writeJson("checkpoint-before.json", checkpointRow(satelliteId, streamId));

const pull = await apiRequest(
  "POST",
  `/v1/satellites/${encodeURIComponent(satelliteId)}/sync/pull`,
  {
    streamId,
    lastAckedSeq: 0,
    subscriptions: [streamId],
  },
  satelliteToken,
);
await writeJson("sync-pull.json", pull);
const epoch = pull.rawBody?.data?.epoch;
const nextCursor = pull.rawBody?.data?.nextCursor;
if (typeof epoch !== "number" || typeof nextCursor !== "string" || nextCursor.length === 0) {
  throw new Error("Sync pull did not return epoch and nextCursor");
}

const tamperedCursor = `${nextCursor.slice(0, -5)}xxxxx`;
const invalidPush = await apiRequest(
  "POST",
  `/v1/satellites/${encodeURIComponent(satelliteId)}/sync/push`,
  {
    acks: [
      {
        streamId,
        seq: 0,
        epoch,
        cursor: tamperedCursor,
      },
    ],
  },
  satelliteToken,
);
await writeJson("sync-push-invalid.json", invalidPush);
const checkpointAfterInvalid = checkpointRow(satelliteId, streamId);
await writeJson("checkpoint-after-invalid.json", checkpointAfterInvalid);

const validPush = await apiRequest(
  "POST",
  `/v1/satellites/${encodeURIComponent(satelliteId)}/sync/push`,
  {
    acks: [
      {
        streamId,
        seq: 1,
        epoch,
      },
    ],
  },
  satelliteToken,
);
await writeJson("sync-push-valid.json", validPush);
const checkpointAfterValid = checkpointRow(satelliteId, streamId);
await writeJson("checkpoint-after-valid.json", checkpointAfterValid);

const invalidConflicts = invalidPush.rawBody?.data?.conflicts ?? [];
const validAccepted = validPush.rawBody?.data?.acceptedAcks ?? [];

await writeJson("issue-00205-summary.json", {
  checkedAt: new Date().toISOString(),
  baseUrl,
  dbPath,
  satelliteId,
  streamId,
  invalidPush: {
    status: invalidPush.response.status,
    conflictCount: Array.isArray(invalidConflicts) ? invalidConflicts.length : 0,
    conflictCodes: Array.isArray(invalidConflicts)
      ? [...new Set(invalidConflicts.map((entry) => entry?.code).filter((value) => typeof value === "string"))]
      : [],
    checkpointPersistedAfterInvalid: Boolean(checkpointAfterInvalid),
  },
  validPush: {
    status: validPush.response.status,
    acceptedCount: Array.isArray(validAccepted) ? validAccepted.length : 0,
    acceptedSeqs: Array.isArray(validAccepted) ? validAccepted.map((entry) => entry?.seq ?? null) : [],
    checkpointPersistedAfterValid: Boolean(checkpointAfterValid),
    checkpointValueAfterValid: checkpointAfterValid?.value_json ?? null,
  },
  passed:
    invalidPush.response.status === 200
    && Array.isArray(invalidConflicts)
    && invalidConflicts.some((entry) => entry?.code === "AUTH_UNAUTHORIZED")
    && !checkpointAfterInvalid
    && validPush.response.status === 200
    && Array.isArray(validAccepted)
    && validAccepted.some((entry) => entry?.seq === 1)
    && checkpointAfterValid?.value_json === "1",
});
