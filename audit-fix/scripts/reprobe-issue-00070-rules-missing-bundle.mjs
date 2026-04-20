import fs from "node:fs/promises";
import path from "node:path";
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

await resetDir(outDir);

const login = await apiRequest("POST", "/v1/auth/login", { local: true }, null, 15_000);
await writeJson("login.json", login);
const token = login.rawBody?.data?.accessToken;
if (typeof token !== "string" || token.length === 0) {
  throw new Error("Failed to obtain access token");
}

const missingBundleId = "missing-bundle-issue-00070";
const auditBefore = dbGet("SELECT COUNT(*) AS count FROM rule_evaluation_log");
await writeJson("evaluation-log-before.json", auditBefore);

const missingEval = await apiRequest(
  "POST",
  "/v1/rules/evaluate",
  {
    bundleId: missingBundleId,
    resource: "workflow",
    action: "execute",
    args: { task: "blocked" },
  },
  token,
  30_000,
);
await writeJson("missing-evaluate.json", missingEval);

const createdBundle = await apiRequest(
  "POST",
  "/v1/rules/bundles",
  {
    name: `bundle-${Date.now()}`,
    rules: [
      {
        name: "allow-all",
        resource: "workflow",
        action: "execute",
        decision: "allow",
        conditions: {},
      },
    ],
  },
  token,
  30_000,
);
await writeJson("create-bundle.json", createdBundle);

const bundleId = createdBundle.rawBody?.data?.bundle?.id;
if (typeof bundleId !== "string" || bundleId.length === 0) {
  throw new Error("Failed to create control bundle");
}

const validEval = await apiRequest(
  "POST",
  "/v1/rules/evaluate",
  {
    bundleId,
    resource: "workflow",
    action: "execute",
    args: { task: "allowed" },
  },
  token,
  30_000,
);
await writeJson("valid-evaluate.json", validEval);

const auditAfter = dbGet("SELECT COUNT(*) AS count FROM rule_evaluation_log");
await writeJson("evaluation-log-after.json", auditAfter);
await writeJson(
  "bundle-row-db.json",
  dbGet("SELECT id, name, version, enabled, checksum, created_at FROM rule_policy_bundles WHERE id = ?", bundleId),
);

await writeJson("issue-00070-summary.json", {
  checkedAt: new Date().toISOString(),
  missingBundleStatus: missingEval.response.status,
  missingBundleErrorCode: missingEval.rawBody?.error?.code ?? null,
  missingBundleBlocked:
    missingEval.response.status === 404
    && missingEval.rawBody?.error?.code === "RULES_BUNDLE_NOT_FOUND",
  validBundleId: bundleId,
  validEvaluateStatus: validEval.response.status,
  validDecision: validEval.rawBody?.data?.result?.decision ?? validEval.rawBody?.result?.decision ?? null,
  evaluationLogBefore: auditBefore?.count ?? null,
  evaluationLogAfter: auditAfter?.count ?? null,
  missingCallDidNotSilentlyAllow:
    missingEval.response.status >= 400
    && (auditAfter?.count ?? 0) >= (auditBefore?.count ?? 0),
});
