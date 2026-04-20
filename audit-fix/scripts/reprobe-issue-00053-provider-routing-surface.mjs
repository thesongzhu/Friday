import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3241";
const outDir = process.env.OUT_DIR;

if (!outDir) throw new Error("OUT_DIR is required");

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

await resetDir(outDir);

const login = await apiRequest("POST", "/v1/auth/login", { local: true }, null, 15_000);
await writeJson("login.json", login);
const token = login.rawBody?.data?.accessToken;
if (typeof token !== "string" || token.length === 0) {
  throw new Error("Failed to obtain access token");
}

const modelRouting = await apiRequest("GET", "/v1/model-routing", null, token);
const providerHealth = await apiRequest("GET", "/v1/providers/health", null, token);
const legacyActive = await apiRequest("GET", "/v1/providers/active", null, token);
const legacyRouting = await apiRequest("GET", "/v1/providers/routing", null, token);

await writeJson("model-routing.json", modelRouting);
await writeJson("provider-health.json", providerHealth);
await writeJson("legacy-providers-active.json", legacyActive);
await writeJson("legacy-providers-routing.json", legacyRouting);

const routing = modelRouting.rawBody?.data?.routing ?? null;
const providerHealthItems = Array.isArray(providerHealth.rawBody?.data?.items)
  ? providerHealth.rawBody.data.items
  : [];

await writeJson("issue-00053-summary.json", {
  checkedAt: new Date().toISOString(),
  modelRoutingStatus: modelRouting.response.status,
  modelRoutingDefaultProviderId: routing?.defaultProviderId ?? null,
  providerHealthStatus: providerHealth.response.status,
  providerHealthHasPrimary: providerHealthItems.some((item) => item?.lane === "primary"),
  legacyActiveStatus: legacyActive.response.status,
  legacyRoutingStatus: legacyRouting.response.status,
  legacyRoutesAbsent:
    legacyActive.response.status === 404 && legacyRouting.response.status === 404,
  canonicalSurfaceHealthy:
    modelRouting.response.status === 200 && providerHealth.response.status === 200,
});
