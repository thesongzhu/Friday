import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3241";
const dbPath = process.env.DB_PATH;
const outDir = process.env.OUT_DIR;
const skillId = process.env.SKILL_ID ?? "system-health-snapshot";
const runAgent = process.env.RUN_AGENT === "1";
const runAiInference = process.env.RUN_AI_INFERENCE === "1";
const preferredProviderKind = process.env.PREFERRED_PROVIDER_KIND ?? "anthropic";

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractErrorCode(rawBody) {
  return rawBody?.error?.code
    ?? rawBody?.code
    ?? rawBody?.data?.error?.code
    ?? rawBody?.data?.code
    ?? null;
}

function extractErrorMessage(rawBody) {
  return rawBody?.error?.message
    ?? rawBody?.message
    ?? rawBody?.data?.error?.message
    ?? rawBody?.data?.message
    ?? null;
}

function selectProvider(items) {
  const candidates = Array.isArray(items) ? items : [];
  return candidates.find((provider) =>
    provider?.enabled !== false
      && provider?.kind === preferredProviderKind
      && typeof provider?.id === "string"
      && provider.id.length > 0
      && typeof provider?.defaultModel === "string"
      && provider.defaultModel.length > 0,
  ) ?? candidates.find((provider) =>
    provider?.enabled !== false
      && typeof provider?.id === "string"
      && provider.id.length > 0
      && typeof provider?.defaultModel === "string"
      && provider.defaultModel.length > 0,
  ) ?? null;
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

const beforeSkillRunCount = dbGet("SELECT COUNT(*) AS count FROM memory_items WHERE namespace = 'skill_runs'");
await writeJson("skill-runs-before.json", beforeSkillRunCount);

const login = await apiRequest("POST", "/v1/auth/login", { local: true }, null, 15_000);
await writeJson("login.json", login);
const token = login.rawBody?.data?.accessToken;
if (typeof token !== "string" || token.length === 0) {
  throw new Error("Failed to obtain access token");
}

const directSessionId = `issue-00200-direct-${Date.now()}`;
const direct = await apiRequest(
  "POST",
  `/v1/skills/${encodeURIComponent(skillId)}/run`,
  {
    input: {},
    sessionId: directSessionId,
  },
  token,
  30_000,
);
await writeJson("direct-skill-run.json", direct);

const afterDirectSkillRunCount = dbGet("SELECT COUNT(*) AS count FROM memory_items WHERE namespace = 'skill_runs'");
await writeJson("skill-runs-after-direct.json", afterDirectSkillRunCount);

const directSummary = {
  status: direct.response.status,
  errorCode: extractErrorCode(direct.rawBody),
  errorMessage: extractErrorMessage(direct.rawBody),
  skillRunCountBefore: beforeSkillRunCount?.count ?? null,
  skillRunCountAfter: afterDirectSkillRunCount?.count ?? null,
  noSkillRunPersisted:
    (afterDirectSkillRunCount?.count ?? null) === (beforeSkillRunCount?.count ?? null),
  passed:
    direct.response.status === 501
    && extractErrorCode(direct.rawBody) === "CAPABILITY_DISABLED"
    && (afterDirectSkillRunCount?.count ?? null) === (beforeSkillRunCount?.count ?? null),
};

let agentSummary = null;
let aiInferenceSummary = null;
if (runAgent || runAiInference) {
  const providers = await apiRequest("GET", "/v1/providers", null, token, 30_000);
  await writeJson("providers.json", providers);
  const provider = selectProvider(providers.rawBody?.data?.items ?? []);
  if (!provider) {
    throw new Error("No enabled provider available for agent reprobe");
  }

  if (runAgent) {
    const startedAt = new Date().toISOString();
    const agentStart = await apiRequest(
      "POST",
      "/v1/agent/runs",
      {
        task: `Use the skill_run tool on skillId "${skillId}" with input {}. Do not summarize manually. If the tool is blocked or disabled, report the exact blocker and stop.`,
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

    const usageRows = dbAll(
      `SELECT id, provider_id, provider_kind, provider_api, model, total_tokens, cost_usd, created_at
         FROM llm_usage_records
        WHERE provider_id = ?
          AND model = ?
          AND created_at >= ?
        ORDER BY created_at ASC`,
      provider.id,
      provider.defaultModel,
      startedAt,
    );
    await writeJson("agent-usage-rows.json", usageRows);

    const afterAgentSkillRunCount = dbGet("SELECT COUNT(*) AS count FROM memory_items WHERE namespace = 'skill_runs'");
    await writeJson("skill-runs-after-agent.json", afterAgentSkillRunCount);

    const auditEvents = Array.isArray(agentAudit.rawBody?.data?.events) ? agentAudit.rawBody.data.events : [];
    const serializedEvents = auditEvents.map((event) => JSON.stringify(event)).join("\n");
    const finalText = typeof agentFinal.rawBody?.data?.run?.responseText === "string"
      ? agentFinal.rawBody.data.run.responseText
      : typeof agentFinal.rawBody?.data?.run?.response === "string"
        ? agentFinal.rawBody.data.run.response
        : typeof agentFinal.rawBody?.data?.run?.summary === "string"
          ? agentFinal.rawBody.data.run.summary
          : null;

    const invokedSkillRun =
      /skill_run/.test(serializedEvents) &&
      serializedEvents.includes(skillId);
    const blockedObserved =
      /CAPABILITY_DISABLED/.test(serializedEvents)
      || /skill_node_runtime/.test(serializedEvents)
      || /disabled/i.test(serializedEvents)
      || /CAPABILITY_DISABLED/.test(finalText ?? "")
      || /skill_node_runtime/.test(finalText ?? "")
      || /disabled/i.test(finalText ?? "");

    agentSummary = {
      runId: agentRunId,
      provider: {
        id: provider.id,
        kind: provider.kind,
        model: provider.defaultModel,
      },
      finalStatus: agentFinal.rawBody?.data?.run?.status ?? null,
      finalText,
      auditEventCount: auditEvents.length,
      invokedSkillRun,
      blockedObserved,
      usageRowCount: usageRows.length,
      skillRunCountAfterDirect: afterDirectSkillRunCount?.count ?? null,
      skillRunCountAfterAgent: afterAgentSkillRunCount?.count ?? null,
      noSkillRunPersisted:
        (afterAgentSkillRunCount?.count ?? null) === (afterDirectSkillRunCount?.count ?? null),
      passed:
        invokedSkillRun
        && blockedObserved
        && usageRows.length > 0
        && (afterAgentSkillRunCount?.count ?? null) === (afterDirectSkillRunCount?.count ?? null),
    };
  }

  if (runAiInference) {
    const startedAt = new Date().toISOString();
    const marker = "ISSUE-00200-ANTHROPIC-OK";
    const aiInference = await apiRequest(
      "POST",
      "/v1/skills/ai-inference/run",
      {
        input: {
          prompt: `Reply with exactly ${marker}`,
          model: provider.defaultModel,
        },
        sessionId: `issue-00200-ai-${Date.now()}`,
      },
      token,
      120_000,
    );
    await writeJson("ai-inference-run.json", aiInference);

    const usageRows = dbAll(
      `SELECT id, provider_id, provider_kind, provider_api, model, total_tokens, cost_usd, created_at
         FROM llm_usage_records
        WHERE model = ?
          AND created_at >= ?
        ORDER BY created_at ASC`,
      provider.defaultModel,
      startedAt,
    );
    await writeJson("ai-inference-usage-rows.json", usageRows);

    const output = aiInference.rawBody?.data?.output ?? aiInference.rawBody?.output ?? null;
    const text = typeof output?.text === "string"
      ? output.text
      : typeof output?.result === "string"
        ? output.result
        : null;

    aiInferenceSummary = {
      provider: {
        id: provider.id,
        kind: provider.kind,
        model: provider.defaultModel,
      },
      status: aiInference.response.status,
      text,
      usageRowCount: usageRows.length,
      usageStateObserved: usageRows.length > 0,
      passed:
        aiInference.response.status === 200
        && typeof text === "string"
        && text.includes(marker),
    };
  }
}

const summary = {
  skillId,
  baseUrl,
  runAgent,
  runAiInference,
  direct: directSummary,
  agent: agentSummary,
  aiInference: aiInferenceSummary,
  passed:
    directSummary.passed
    && (!runAgent || agentSummary?.passed === true)
    && (!runAiInference || aiInferenceSummary?.passed === true),
};

await writeJson("issue-00200-summary.json", summary);
console.log(JSON.stringify(summary, null, 2));
