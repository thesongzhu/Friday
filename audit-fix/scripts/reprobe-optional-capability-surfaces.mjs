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

function dbGet(sql, ...params) {
  return db.prepare(sql).get(...params) ?? null;
}

await resetDir(outDir);

const login = await apiRequest("POST", "/v1/auth/login", { local: true }, null);
await writeJson("login.json", login);
const token = login.rawBody?.data?.accessToken;
if (typeof token !== "string" || token.length === 0) {
  throw new Error("Failed to obtain access token from /v1/auth/login");
}

const health = await apiRequest("GET", "/v1/health", null, token);
await writeJson("health.json", health);

const packagesList = await apiRequest("GET", "/v1/packages", null, token);
await writeJson("packages-list.json", packagesList);

const mcpInitialize = await apiRequest(
  "POST",
  "/v1/mcp",
  { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  token,
);
await writeJson("mcp-initialize.json", mcpInitialize);

const lineWebhook = await apiRequest(
  "POST",
  "/v1/channel-webhooks/line",
  { events: [] },
  null,
);
await writeJson("channel-webhook-line.json", lineWebhook);

const marketplacePlugins = await apiRequest("GET", "/v1/marketplace/plugins", null, token);
await writeJson("marketplace-plugins.json", marketplacePlugins);

const marketplaceSources = dbGet(
  `SELECT COUNT(*) AS count
   FROM marketplace_sources`,
);
await writeJson("marketplace-sources-count-db.json", marketplaceSources);

const pluginMarketplaceSources = dbGet(
  `SELECT COUNT(*) AS count
   FROM plugin_marketplace_sources`,
);
await writeJson("plugin-marketplace-sources-count-db.json", pluginMarketplaceSources);

await writeJson("optional-capability-summary.json", {
  healthStatus: health.response.status,
  packagingEnabled: health.response.body?.data?.capabilities?.packaging?.enabled ?? null,
  mcpEnabled: health.response.body?.data?.capabilities?.mcp?.enabled ?? null,
  channelWebhookEndpoints: health.response.body?.data?.capabilities?.channels?.webhookEndpoints ?? null,
  packagesStatus: packagesList.response.status,
  packagesErrorCode: packagesList.response.body?.error?.code ?? null,
  mcpStatus: mcpInitialize.response.status,
  mcpErrorCode: mcpInitialize.response.body?.error?.code ?? null,
  lineWebhookStatus: lineWebhook.response.status,
  lineWebhookErrorCode: lineWebhook.response.body?.error?.code ?? null,
  marketplacePluginsStatus: marketplacePlugins.response.status,
  marketplacePluginsTotal: marketplacePlugins.response.body?.data?.total ?? null,
  marketplaceSourcesCount: marketplaceSources?.count ?? null,
  pluginMarketplaceSourcesCount: pluginMarketplaceSources?.count ?? null,
});

db.close();
