import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3241";
const dbPath = process.env.DB_PATH;
const outDir = process.env.OUT_DIR;
const skillId = process.env.SKILL_ID ?? "audit-shell-env-presence-probe";

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
        body: redactTokens(responseBody),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function dbGet(sql, ...params) {
  return db.prepare(sql).get(...params) ?? null;
}

function dbAll(sql, ...params) {
  return db.prepare(sql).all(...params);
}

function uniqStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function selectProvider(items) {
  const candidates = Array.isArray(items) ? items : [];
  return candidates.find((provider) =>
    provider?.enabled !== false
      && typeof provider?.id === "string"
      && provider.id.length > 0
      && typeof provider?.defaultModel === "string"
      && provider.defaultModel.length > 0
      && provider?.kind === "anthropic",
  ) ?? candidates.find((provider) =>
    provider?.enabled !== false
      && typeof provider?.id === "string"
      && provider.id.length > 0
      && typeof provider?.defaultModel === "string"
      && provider.defaultModel.length > 0,
  ) ?? null;
}

function extractVisibleEnv(output) {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const visibleEnv = output.visibleEnv;
    if (visibleEnv && typeof visibleEnv === "object" && !Array.isArray(visibleEnv)) {
      return visibleEnv;
    }
  }
  return null;
}

function secretsHidden(visibleEnv) {
  if (!visibleEnv) return false;
  return visibleEnv.OPENAI_API_KEY === false
    && visibleEnv.ANTHROPIC_API_KEY === false
    && visibleEnv.FRIDAY_ANTHROPIC_API_KEY === false
    && visibleEnv.FRIDAY_MASTER_KEY === false;
}

async function pollAgentRun(token, runId, maxAttempts = 45, delayMs = 2_000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await apiRequest("GET", `/v1/agent/runs/${encodeURIComponent(runId)}`, null, token, 30_000);
    const status = result.rawBody?.data?.run?.status;
    if (typeof status === "string" && ["completed", "failed", "cancelled", "timed_out"].includes(status)) {
      return result;
    }
    if (attempt < maxAttempts) {
      await sleep(delayMs);
    }
  }
  return apiRequest("GET", `/v1/agent/runs/${encodeURIComponent(runId)}`, null, token, 30_000);
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
const provider = selectProvider(providers.rawBody?.data?.items ?? []);

const direct = await apiRequest(
  "POST",
  `/v1/skills/${encodeURIComponent(skillId)}/run`,
  { input: {} },
  token,
  30_000,
);
await writeJson("direct-skill-run.json", direct);

const directRunId = direct.rawBody?.data?.runId ?? direct.rawBody?.runId ?? null;
const directOutput = direct.rawBody?.data?.output ?? direct.rawBody?.output ?? null;
const directVisibleEnv = extractVisibleEnv(directOutput);
const directRunRow = typeof directRunId === "string"
  ? dbGet(
    `SELECT id, namespace, key, value_json, created_at, updated_at
       FROM memory_items
      WHERE namespace = 'skill_runs'
        AND key = ?`,
    directRunId,
  )
  : null;
await writeJson("direct-skill-run-row.json", directRunRow);

let agentSummary = null;
if (provider) {
  const agentStartedAt = new Date().toISOString();
  const agentStart = await apiRequest(
    "POST",
    "/v1/agent/runs",
    {
      task: `Use the skill_run tool immediately with skillId "${skillId}" and input {}. Do not call skills_list first, do not filter for starter or bundled skills, and do not claim the skill is unavailable unless skill_run itself fails. Return only the skill's visibleEnv JSON and nothing else.`,
      providerId: provider.id,
      model: provider.defaultModel,
      timeoutMs: 120_000,
    },
    token,
    120_000,
  );
  await writeJson("agent-start.json", agentStart);
  const agentRunId = agentStart.rawBody?.data?.runId;
  if (typeof agentRunId !== "string" || agentRunId.length === 0) {
    throw new Error("Agent runId missing");
  }

  const agentFinal = await pollAgentRun(token, agentRunId);
  await writeJson("agent-final.json", agentFinal);
  const agentAudit = await apiRequest("GET", `/v1/agent/runs/${encodeURIComponent(agentRunId)}/audit`, null, token, 30_000);
  await writeJson("agent-audit.json", agentAudit);
  const agentEventRows = dbAll(
    `SELECT run_id, seq, event_name, payload_json, emitted_at
       FROM friday_agent_run_events
      WHERE run_id = ?
      ORDER BY seq ASC`,
    agentRunId,
  );
  await writeJson("agent-event-rows.json", agentEventRows);
  const agentUsageRows = dbAll(
    `SELECT id, provider_id, provider_kind, provider_api, model, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, total_tokens, cost_usd, metadata_json, created_at
       FROM llm_usage_records
      WHERE provider_id = ?
        AND model = ?
        AND created_at >= ?
      ORDER BY created_at ASC`,
    provider.id,
    provider.defaultModel,
    agentStartedAt,
  );
  await writeJson("agent-usage-rows.json", agentUsageRows);

  const auditEvents = Array.isArray(agentAudit.rawBody?.data?.events) ? agentAudit.rawBody.data.events : [];
  const skillRunEvents = auditEvents.filter((event) =>
    event?.type === "agent.run.tool_start" || event?.type === "agent.run.tool_end");
  const serializedSkillEvents = skillRunEvents.map((event) => JSON.stringify(event)).join("\n");
  const agentFinalText = typeof agentFinal.rawBody?.data?.run?.responseText === "string"
    ? agentFinal.rawBody.data.run.responseText
    : typeof agentFinal.rawBody?.data?.run?.response === "string"
      ? agentFinal.rawBody.data.run.response
      : typeof agentFinal.rawBody?.data?.run?.summary === "string"
        ? agentFinal.rawBody.data.run.summary
        : null;
  const invokedSkillRun = /skill_run/.test(serializedSkillEvents) && serializedSkillEvents.includes(skillId);
  const hiddenInAgentText = /OPENAI_API_KEY[^a-zA-Z0-9]+false/i.test(agentFinalText ?? "")
    && /ANTHROPIC_API_KEY[^a-zA-Z0-9]+false/i.test(agentFinalText ?? "");

  agentSummary = {
    runId: agentRunId,
    provider: {
      id: provider.id,
      kind: provider.kind,
      model: provider.defaultModel,
    },
    finalStatus: agentFinal.rawBody?.data?.run?.status ?? null,
    finalText: agentFinalText,
    auditEventCount: auditEvents.length,
    eventNames: uniqStrings(agentEventRows.map((row) => row.event_name ?? null)),
    invokedSkillRun,
    usageRowCount: agentUsageRows.length,
    usageProviderKinds: uniqStrings(agentUsageRows.map((row) => row.provider_kind ?? null)),
    usageModels: uniqStrings(agentUsageRows.map((row) => row.model ?? null)),
    hiddenInAgentText,
  };
}

const summary = {
  checkedAt: new Date().toISOString(),
  baseUrl,
  dbPath,
  skillId,
  direct: {
    status: direct.response.status,
    runId: directRunId,
    visibleEnv: directVisibleEnv,
    secretsHidden: secretsHidden(directVisibleEnv),
    safeBaselinePresent: Boolean(directVisibleEnv?.PATH) && Boolean(directVisibleEnv?.HOME),
    persistedRunRow: Boolean(directRunRow),
  },
  agent: agentSummary,
  passed: secretsHidden(directVisibleEnv)
    && Boolean(directRunRow)
    && (agentSummary == null || (agentSummary.invokedSkillRun && agentSummary.usageRowCount > 0)),
};

await writeJson("issue-00199-summary.json", summary);

db.close();
