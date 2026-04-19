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
const stateDir = path.dirname(dbPath);
const auditLogPath = path.join(stateDir, ".friday", "audit.jsonl");

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

async function readAuditJsonlMeta() {
  try {
    const content = await fs.readFile(auditLogPath, "utf8");
    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    const lastLine = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null;
    return {
      exists: true,
      lineCount: lines.length,
      lastLine,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        exists: false,
        lineCount: 0,
        lastLine: null,
      };
    }
    throw error;
  }
}

async function waitFor(check, label, timeoutMs = 5000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}`);
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

const authMe = await apiRequest("GET", "/v1/auth/me", null, token);
await writeJson("auth-me.json", authMe);

const auditCountBefore = dbGet("SELECT COUNT(*) AS count FROM audit_logs");
const auditJsonlBefore = await readAuditJsonlMeta();
await writeJson("audit-count-before.json", auditCountBefore);
await writeJson("audit-jsonl-before.json", auditJsonlBefore);

const nonce = Date.now();
const existingPublisher = dbGet(
  `SELECT id, display_name, tenant_id, principal_id
   FROM marketplace_publishers
   WHERE tenant_id = ? AND principal_id = ?
   ORDER BY created_at DESC
   LIMIT 1`,
  userId,
  userId,
);

let publisherId = existingPublisher?.id ?? null;
if (publisherId) {
  await writeJson("publisher-reuse.json", existingPublisher);
} else {
  const publisherCreate = await apiRequest(
    "POST",
    "/v1/marketplace/publishers",
    {
      displayName: `Audit Publisher ${nonce}`,
      contactEmail: `audit+${nonce}@example.com`,
    },
    token,
  );
  await writeJson("publisher-create.json", publisherCreate);
  publisherId = publisherCreate.rawBody?.data?.publisher?.id ?? null;
  if (typeof publisherId !== "string" || publisherId.length === 0) {
    throw new Error("Failed to create publisher");
  }
}

const listingCreate = await apiRequest(
  "POST",
  "/v1/marketplace/listings",
  {
    publisherId,
    slug: `audit-listing-${nonce}`,
    assetType: "agent",
    title: `Audit Listing ${nonce}`,
    description: "Audit listing for sqlite audit mirror reprobe",
    packageName: `@audit/issue-00187-${nonce}`,
    packageVersion: "1.0.0",
    pricingPlan: {
      type: "free",
    },
  },
  token,
);
await writeJson("listing-create.json", listingCreate);

const listingId = listingCreate.rawBody?.data?.listing?.id;
if (typeof listingId !== "string" || listingId.length === 0) {
  throw new Error("Failed to create listing");
}

const installDenied = await apiRequest(
  "POST",
  `/v1/marketplace/listings/${encodeURIComponent(listingId)}/install`,
  {},
  token,
);
await writeJson("install-denied.json", installDenied);

const latestAuditRow = await waitFor(async () => {
  const row = dbGet(
    `SELECT id, ts, actor_type, actor_id, action, resource_type, resource_id, details_json
     FROM audit_logs
     WHERE action = 'listing.installation.denied' AND resource_id = ?
     ORDER BY ts DESC
     LIMIT 1`,
    listingId,
  );
  return row;
}, "audit_logs sqlite mirror row");

const auditJsonlAfter = await waitFor(async () => {
  const meta = await readAuditJsonlMeta();
  if (meta.lineCount > auditJsonlBefore.lineCount) {
    return meta;
  }
  return null;
}, "audit jsonl append");

const auditCountAfter = dbGet("SELECT COUNT(*) AS count FROM audit_logs");
await writeJson("audit-count-after.json", auditCountAfter);
await writeJson("audit-jsonl-after.json", auditJsonlAfter);
await writeJson("latest-audit-row.json", latestAuditRow);

const parsedDetails = latestAuditRow?.details_json
  ? JSON.parse(latestAuditRow.details_json)
  : null;

const summary = {
  checkedAt: new Date().toISOString(),
  baseUrl,
  dbPath,
  listingId,
  publisherId,
  installDenied: {
    status: installDenied.response.status,
    code: installDenied.rawBody?.error?.code ?? null,
    message: installDenied.rawBody?.error?.message ?? null,
  },
  auditLogsBefore: auditCountBefore?.count ?? null,
  auditLogsAfter: auditCountAfter?.count ?? null,
  auditLogDelta:
    typeof auditCountBefore?.count === "number" && typeof auditCountAfter?.count === "number"
      ? auditCountAfter.count - auditCountBefore.count
      : null,
  sqliteMirrorRow: latestAuditRow
    ? {
        action: latestAuditRow.action,
        resourceType: latestAuditRow.resource_type,
        resourceId: latestAuditRow.resource_id,
        actorId: latestAuditRow.actor_id,
        reason: parsedDetails?.reason ?? null,
      }
    : null,
  auditJsonlBeforeLines: auditJsonlBefore.lineCount,
  auditJsonlAfterLines: auditJsonlAfter.lineCount,
  auditJsonlDelta: auditJsonlAfter.lineCount - auditJsonlBefore.lineCount,
  auditJsonlLastAction: auditJsonlAfter.lastLine?.action ?? null,
};

await writeJson("issue-00187-summary.json", summary);

readonlyDb.close();
