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

async function readLogTail(file, maxLines = 120) {
  const text = await fs.readFile(file, "utf8");
  return text.split(/\r?\n/).slice(-maxLines).join("\n");
}

await resetDir(outDir);

const publicHealth = await apiRequest("GET", "/v1/health", null, null);
await writeJson("public-health.json", publicHealth);

const unauthCapabilities = await apiRequest("GET", "/v1/health/capabilities", null, null);
await writeJson("unauth-capabilities.json", unauthCapabilities);

const login = await apiRequest("POST", "/v1/auth/login", { local: true }, null);
await writeJson("login.json", login);

const token = login.rawBody?.data?.accessToken;
if (typeof token !== "string" || token.length === 0) {
  throw new Error("Failed to obtain access token from /v1/auth/login");
}

const authCapabilities = await apiRequest("GET", "/v1/health/capabilities", null, token);
await writeJson("auth-capabilities.json", authCapabilities);

const logTail = await readLogTail(logPath);
await fs.writeFile(path.join(outDir, "runtime-log-tail.txt"), `${logTail}\n`, "utf8");

await writeJson("issue-00065-summary.json", {
  checkedAt: new Date().toISOString(),
  publicHealthStatus: publicHealth.response.status,
  publicHasCapabilities: Object.prototype.hasOwnProperty.call(publicHealth.response.body?.data ?? {}, "capabilities"),
  unauthCapabilitiesStatus: unauthCapabilities.response.status,
  unauthCapabilitiesError: unauthCapabilities.response.body?.error ?? null,
  authCapabilitiesStatus: authCapabilities.response.status,
  authHasCapabilities: Object.prototype.hasOwnProperty.call(authCapabilities.response.body?.data ?? {}, "capabilities"),
  authCapabilityKeys: Object.keys(authCapabilities.response.body?.data?.capabilities ?? {}),
});
