import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3241";
const outDir = process.env.OUT_DIR;
const logPath = process.env.LOG_PATH;

if (!outDir) {
  throw new Error("OUT_DIR is required");
}

if (!logPath) {
  throw new Error("LOG_PATH is required");
}

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
  const url = pathname.startsWith("http") ? pathname : `${baseUrl}${pathname}`;
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

async function readLogTail(file, maxLines = 80) {
  const text = await fs.readFile(file, "utf8");
  return text.split(/\r?\n/).slice(-maxLines).join("\n");
}

await resetDir(outDir);

const health = await apiRequest("GET", "/v1/health", null, null);
await writeJson("health.json", health);

const login = await apiRequest("POST", "/v1/auth/login", { local: true }, null);
await writeJson("login.json", login);

const token = login.rawBody?.data?.accessToken;
if (typeof token !== "string" || token.length === 0) {
  throw new Error("Failed to obtain access token from /v1/auth/login");
}

const alertRulesBefore = await apiRequest("GET", "/v1/observability/alert-rules", null, token);
await writeJson("alert-rules-before.json", alertRulesBefore);

const invalidAlertRule = await apiRequest(
  "POST",
  "/v1/observability/alert-rules",
  { name: "min" },
  token,
);
await writeJson("alert-rule-invalid-create.json", invalidAlertRule);

const validAlertRule = await apiRequest(
  "POST",
  "/v1/observability/alert-rules",
  {
    name: `Audit Alert ${Date.now()}`,
    description: "current-schema create should succeed after the status fix",
    severity: "warning",
    condition: {
      type: "threshold",
      metric: "api.latency.p99",
      operator: "gt",
      value: 1000,
    },
    channelIds: [],
  },
  token,
);
await writeJson("alert-rule-valid-create.json", validAlertRule);

const createdRuleId = validAlertRule.rawBody?.data?.rule?.id ?? null;
const createdRuleEtag = validAlertRule.rawBody?.data?.rule?.etag ?? null;

const alertRulesAfterCreate = await apiRequest("GET", "/v1/observability/alert-rules", null, token);
await writeJson("alert-rules-after-create.json", alertRulesAfterCreate);

let deleteRule = null;
if (typeof createdRuleId === "string" && createdRuleId && typeof createdRuleEtag === "string" && createdRuleEtag) {
  deleteRule = await apiRequest(
    "DELETE",
    `/v1/observability/alert-rules/${createdRuleId}`,
    { etag: createdRuleEtag },
    token,
  );
}
await writeJson("alert-rule-delete.json", deleteRule);

const alertRulesAfterDelete = await apiRequest("GET", "/v1/observability/alert-rules", null, token);
await writeJson("alert-rules-after-delete.json", alertRulesAfterDelete);

const logTail = await readLogTail(logPath);
await fs.writeFile(path.join(outDir, "runtime-log-tail.txt"), `${logTail}\n`, "utf8");

const beforeCount = Array.isArray(alertRulesBefore.rawBody?.data?.items)
  ? alertRulesBefore.rawBody.data.items.length
  : null;
const afterCreateCount = Array.isArray(alertRulesAfterCreate.rawBody?.data?.items)
  ? alertRulesAfterCreate.rawBody.data.items.length
  : null;
const afterDeleteCount = Array.isArray(alertRulesAfterDelete.rawBody?.data?.items)
  ? alertRulesAfterDelete.rawBody.data.items.length
  : null;

await writeJson("issue-00040-summary.json", {
  checkedAt: new Date().toISOString(),
  alertRuleValidationStatus: invalidAlertRule.response.status,
  alertRuleValidationError: invalidAlertRule.response.body?.error ?? null,
  validCreateStatus: validAlertRule.response.status,
  validCreateRuleId: createdRuleId,
  validCreateRuleEtag: typeof createdRuleEtag === "string" ? "<redacted-etag>" : null,
  deleteStatus: deleteRule?.response?.status ?? null,
  alertRuleCountBefore: beforeCount,
  alertRuleCountAfterCreate: afterCreateCount,
  alertRuleCountAfterDelete: afterDeleteCount,
  alertRuleCreateDelta:
    typeof beforeCount === "number" && typeof afterCreateCount === "number"
      ? afterCreateCount - beforeCount
      : null,
  alertRuleDeleteDelta:
    typeof beforeCount === "number" && typeof afterDeleteCount === "number"
      ? afterDeleteCount - beforeCount
      : null,
});
