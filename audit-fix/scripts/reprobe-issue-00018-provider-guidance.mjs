import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3242";
const dbPath = process.env.DB_PATH;
const outDir = process.env.OUT_DIR;
const logPath = process.env.LOG_PATH;

if (!dbPath) throw new Error("DB_PATH is required");
if (!outDir) throw new Error("OUT_DIR is required");
if (!logPath) throw new Error("LOG_PATH is required");

const db = new Database(dbPath, { readonly: true });

async function resetDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

async function writeJson(name, value) {
  await fs.writeFile(path.join(outDir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(name, value) {
  await fs.writeFile(path.join(outDir, name), value, "utf8");
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

function redactHeaders(headers = {}) {
  return {
    ...headers,
    authorization: headers.authorization ? "Bearer <redacted>" : undefined,
  };
}

async function apiRequest(method, pathname, body, token, timeoutMs = 120_000) {
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
  } finally {
    clearTimeout(timer);
  }
}

function dbAll(sql, ...params) {
  return db.prepare(sql).all(...params);
}

function dbGet(sql, ...params) {
  return db.prepare(sql).get(...params) ?? null;
}

async function readLogTail(file, maxLines = 200) {
  const text = await fs.readFile(file, "utf8");
  return text.split(/\r?\n/).slice(-maxLines).join("\n");
}

await resetDir(outDir);

const login = await apiRequest("POST", "/v1/auth/login", { local: true }, null, 15_000);
await writeJson("login.json", login);
const token = login.rawBody?.data?.accessToken;
if (typeof token !== "string" || token.length === 0) {
  throw new Error("Failed to obtain access token from /v1/auth/login");
}

const providersBefore = await apiRequest("GET", "/v1/providers", null, token, 30_000);
await writeJson("providers-before.json", providersBefore);
const anthropicProvider = providersBefore.rawBody?.data?.items?.find?.((provider) => provider.kind === "anthropic");
if (!anthropicProvider?.id) {
  throw new Error("Anthropic provider was not available before the repro run");
}

const providerProfilesBefore = dbAll(
  `SELECT id, kind, display_name, enabled, default_model, config_json, updated_at
   FROM provider_profiles
   ORDER BY id`,
);
const routingBefore = dbGet(
  `SELECT key, value_json
   FROM hub_settings
   WHERE key = 'llm.routing.v1'`,
);
await writeJson(
  "provider-profiles-before-db.json",
  providerProfilesBefore,
);
await writeJson(
  "routing-before-db.json",
  routingBefore,
);

const start = await apiRequest(
  "POST",
  "/v1/agent/runs",
  {
    task: "I just installed Friday. How do I connect my Anthropic API key? Please guide me step by step.",
    providerId: anthropicProvider.id,
  },
  token,
);
await writeJson("start-run.json", start);

const runId = start.rawBody?.data?.runId;
if (typeof runId !== "string" || runId.length === 0) {
  throw new Error("Run ID missing from /v1/agent/runs response");
}

const final = await apiRequest("GET", `/v1/agent/runs/${encodeURIComponent(runId)}`, null, token, 30_000);
await writeJson("final-run.json", final);

const audit = await apiRequest("GET", `/v1/agent/runs/${encodeURIComponent(runId)}/audit`, null, token, 30_000);
await writeJson("audit.json", audit);

const providersAfter = await apiRequest("GET", "/v1/providers", null, token, 30_000);
await writeJson("providers-after.json", providersAfter);
const providerProfilesAfter = dbAll(
  `SELECT id, kind, display_name, enabled, default_model, config_json, updated_at
   FROM provider_profiles
   ORDER BY id`,
);
const routingAfter = dbGet(
  `SELECT key, value_json
   FROM hub_settings
   WHERE key = 'llm.routing.v1'`,
);
await writeJson(
  "provider-profiles-after-db.json",
  providerProfilesAfter,
);
await writeJson(
  "routing-after-db.json",
  routingAfter,
);
await writeJson(
  "agent-run-events-db.json",
  dbAll(
    `SELECT run_id, seq, event_name, payload_json, emitted_at
     FROM friday_agent_run_events
     WHERE run_id = ?
     ORDER BY seq`,
    runId,
  ),
);

const logTail = await readLogTail(logPath);
await writeText("runtime-log-tail.txt", `${logTail}\n`);

const auditEvents = Array.isArray(audit.rawBody?.data?.events) ? audit.rawBody.data.events : [];
const blockedProviderMutation = auditEvents.find((event) =>
  event?.type === "agent.run.tool_end"
    && event?.payload?.toolName === "provider"
    && event?.payload?.routeId === "agent.execute.tool.policy"
    && typeof event?.payload?.summary === "string"
    && event.payload.summary.includes("must not mutate provider configuration"),
);
const providerUpdateAttempt = auditEvents.find((event) =>
  event?.type === "agent.run.tool_start"
    && event?.payload?.toolName === "provider"
    && event?.payload?.params?.action === "update",
);
const providerValidateAttempt = auditEvents.find((event) =>
  event?.type === "agent.run.tool_start"
    && event?.payload?.toolName === "provider"
    && event?.payload?.params?.action === "validate",
);
const providerSetDefaultAttempt = auditEvents.find((event) =>
  event?.type === "agent.run.tool_start"
    && event?.payload?.toolName === "provider"
    && event?.payload?.params?.action === "set_default",
);
const responseText = String(
  final.response.body?.data?.run?.response
  ?? start.response.body?.data?.response
  ?? "",
);

await writeJson("issue-00018-summary.json", {
  checkedAt: new Date().toISOString(),
  runId,
  finalStatus: final.response.body?.data?.run?.status ?? start.response.body?.data?.status ?? null,
  toolCallCount: start.response.body?.data?.toolCallCount ?? null,
  providerMutationBlockedByPolicy: Boolean(blockedProviderMutation),
  blockedMutationSummary: blockedProviderMutation?.payload?.summary ?? null,
  providerUpdateAttempted: Boolean(providerUpdateAttempt),
  providerValidateAttempted: Boolean(providerValidateAttempt),
  providerSetDefaultAttempted: Boolean(providerSetDefaultAttempt),
  providerProfilesChanged:
    JSON.stringify(providerProfilesBefore) !== JSON.stringify(providerProfilesAfter),
  routingChanged:
    JSON.stringify(routingBefore) !== JSON.stringify(routingAfter),
  responseRequestsConfirmation:
    /确认后我就开始执行配置步骤|确认后我可以帮你执行配置步骤|等待你的确认|你准备好开始配置了吗|请确认|请告诉我|是否同意|reply 同意|are you ready|confirm/i.test(responseText),
  responseMentionsSteps:
    /配置步骤|步骤 1|步骤 2|step 1|step 2/i.test(responseText),
  providerProfilesRowCount: providerProfilesAfter.length,
});
