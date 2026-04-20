import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3241";
const outDir = process.env.OUT_DIR;

if (!outDir) {
  throw new Error("OUT_DIR is required");
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

await resetDir(outDir);

const health = await apiRequest("GET", "/v1/health", null, null);
await writeJson("health.json", health);

const login = await apiRequest("POST", "/v1/auth/login", { local: true }, null);
await writeJson("login.json", login);

const token = login.rawBody?.data?.accessToken;
if (typeof token !== "string" || token.length === 0) {
  throw new Error("Failed to obtain access token from /v1/auth/login");
}

const initialize = await apiRequest(
  "POST",
  "/v1/mcp",
  {
    jsonrpc: "2.0",
    id: "audit-00033",
    method: "initialize",
    params: {},
  },
  token,
);
await writeJson("mcp-initialize.json", initialize);

await writeJson("issue-00033-summary.json", {
  checkedAt: new Date().toISOString(),
  mcpEnabledInHealth: health.rawBody?.data?.capabilities?.mcp?.enabled ?? null,
  initializeStatus: initialize.response.status,
  initializeError: initialize.response.body?.error ?? null,
});
