import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import Database from "better-sqlite3";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3241";
const dbPath = process.env.DB_PATH;
const outDir = process.env.OUT_DIR;
const loopbackPort = Number.parseInt(process.env.LOOPBACK_PORT ?? "39190", 10);
const metadataUrl = process.env.METADATA_URL ?? "http://169.254.169.254/latest/meta-data/";

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

function dbAll(sql, ...params) {
  return db.prepare(sql).all(...params);
}

function uniqStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function buildTask(url) {
  return [
    `Use the web_fetch tool on this exact URL: ${url}`,
    "Do not use browser, web_search, or any other network tool.",
    "If the request is blocked, reply with the exact blocking reason.",
    "If it succeeds, reply with the first line of the body only.",
  ].join(" ");
}

async function runProbe(token, provider, label, url, options = {}) {
  const startedAt = new Date().toISOString();
  const start = await apiRequest(
    "POST",
    "/v1/agent/runs",
    {
      task: buildTask(url),
      providerId: provider.id,
      model: provider.defaultModel,
      timeoutMs: 120_000,
    },
    token,
    120_000,
  );
  await writeJson(`${label}-start.json`, start);

  const runId = start.rawBody?.data?.runId;
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error(`${label}: missing runId`);
  }

  const final = await pollAgentRun(token, runId);
  await writeJson(`${label}-final.json`, final);

  const audit = await apiRequest("GET", `/v1/agent/runs/${encodeURIComponent(runId)}/audit`, null, token, 30_000);
  await writeJson(`${label}-audit.json`, audit);

  const eventRows = dbAll(
    `SELECT run_id, seq, event_name, payload_json, emitted_at
       FROM friday_agent_run_events
      WHERE run_id = ?
      ORDER BY seq ASC`,
    runId,
  );
  await writeJson(`${label}-event-rows.json`, eventRows);

  const usageRows = dbAll(
    `SELECT id, provider_id, provider_kind, provider_api, model, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, total_tokens, cost_usd, metadata_json, created_at
       FROM llm_usage_records
      WHERE provider_id = ?
        AND model = ?
        AND created_at >= ?
      ORDER BY created_at ASC`,
    provider.id,
    provider.defaultModel,
    startedAt,
  );
  await writeJson(`${label}-usage-rows.json`, usageRows);

  const finalRun = final.rawBody?.data?.run ?? null;
  const finalText = typeof finalRun?.responseText === "string"
    ? finalRun.responseText
    : typeof finalRun?.response === "string"
      ? finalRun.response
      : typeof finalRun?.summary === "string"
        ? finalRun.summary
        : null;
  const payloadTexts = eventRows
    .map((row) => typeof row.payload_json === "string" ? row.payload_json : JSON.stringify(row.payload_json))
    .join("\n");
  const blocked = /SSRF|blocked hostname|blocked private|blocked protocol|blocked by security policy/i.test(
    `${finalRun?.errorMessage ?? ""}\n${finalText ?? ""}\n${payloadTexts}`,
  );

  return {
    url,
    runId,
    finalStatus: finalRun?.status ?? null,
    errorCode: finalRun?.errorCode ?? null,
    errorMessage: finalRun?.errorMessage ?? null,
    finalText,
    eventNames: uniqStrings(eventRows.map((row) => row.event_name ?? null)),
    usageRowCount: usageRows.length,
    usageProviderKinds: uniqStrings(usageRows.map((row) => row.provider_kind ?? null)),
    usageModels: uniqStrings(usageRows.map((row) => row.model ?? null)),
    blocked,
    loopbackHitCount: options.loopbackHitCount?.() ?? null,
  };
}

await resetDir(outDir);

let loopbackHitCount = 0;
const server = http.createServer((req, res) => {
  loopbackHitCount += 1;
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("LOOPBACK_SERVER_REACHED\n");
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(loopbackPort, "127.0.0.1", resolve);
});

try {
  const login = await apiRequest("POST", "/v1/auth/login", { local: true }, null, 15_000);
  await writeJson("login.json", login);
  const token = login.rawBody?.data?.accessToken;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Failed to obtain access token");
  }

  const providers = await apiRequest("GET", "/v1/providers", null, token, 30_000);
  await writeJson("providers.json", providers);
  const providerItems = Array.isArray(providers.rawBody?.data?.items) ? providers.rawBody.data.items : [];
  const provider = selectProvider(providerItems);
  if (!provider) {
    throw new Error("No enabled provider with a defaultModel was available");
  }

  const loopbackUrl = `http://127.0.0.1:${String(loopbackPort)}/ssrf-loopback-probe`;
  const loopback = await runProbe(token, provider, "loopback", loopbackUrl, {
    loopbackHitCount: () => loopbackHitCount,
  });
  const metadata = await runProbe(token, provider, "metadata", metadataUrl);

  const summary = {
    checkedAt: new Date().toISOString(),
    baseUrl,
    dbPath,
    provider: {
      id: provider.id,
      kind: provider.kind,
      model: provider.defaultModel,
    },
    loopback,
    metadata,
    passed: loopback.blocked && loopback.loopbackHitCount === 0 && metadata.blocked,
  };
  await writeJson("issue-00190-summary.json", summary);
} finally {
  await new Promise((resolve) => server.close(resolve));
  db.close();
}
