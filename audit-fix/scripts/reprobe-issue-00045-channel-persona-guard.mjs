import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3241";
const outDir = process.env.OUT_DIR;
const dbPath = process.env.DB_PATH;
const logPath = process.env.LOG_PATH;

if (!outDir) {
  throw new Error("OUT_DIR is required");
}

if (!dbPath) {
  throw new Error("DB_PATH is required");
}

if (!logPath) {
  throw new Error("LOG_PATH is required");
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

function readPersonaState() {
  const row = db.prepare("SELECT value_json FROM hub_settings WHERE key = ?").get("channels.persona.v1");
  return row ? JSON.parse(row.value_json) : null;
}

async function readLogTail(file, maxLines = 80) {
  const text = await fs.readFile(file, "utf8");
  return text.split(/\r?\n/).slice(-maxLines).join("\n");
}

await resetDir(outDir);

const personaStateBefore = readPersonaState();
await writeJson("persona-state-before.json", personaStateBefore);

const login = await apiRequest("POST", "/v1/auth/login", { local: true }, null);
await writeJson("login.json", login);

const token = login.rawBody?.data?.accessToken;
if (typeof token !== "string" || token.length === 0) {
  throw new Error("Failed to obtain access token from /v1/auth/login");
}

const channelsList = await apiRequest("GET", "/v1/channels", null, token);
await writeJson("channels-list.json", channelsList);

const fakePersonaGet = await apiRequest("GET", "/v1/channels/fake-kind/persona", null, token);
await writeJson("fake-persona-get.json", fakePersonaGet);

const fakePersonaPut = await apiRequest(
  "PUT",
  "/v1/channels/fake-kind/persona",
  { persona: "audit", systemPrompt: "hello" },
  token,
);
await writeJson("fake-persona-put.json", fakePersonaPut);

const fakeChannelGet = await apiRequest("GET", "/v1/channels/fake-kind", null, token);
await writeJson("fake-channel-get.json", fakeChannelGet);

const personaStateAfter = readPersonaState();
await writeJson("persona-state-after.json", personaStateAfter);

const logTail = await readLogTail(logPath);
await fs.writeFile(path.join(outDir, "runtime-log-tail.txt"), `${logTail}\n`, "utf8");

await writeJson("issue-00045-summary.json", {
  checkedAt: new Date().toISOString(),
  channelsListCount: Array.isArray(channelsList.rawBody?.data?.items) ? channelsList.rawBody.data.items.length : null,
  fakePersonaGetStatus: fakePersonaGet.response.status,
  fakePersonaGetError: fakePersonaGet.response.body?.error ?? null,
  fakePersonaPutStatus: fakePersonaPut.response.status,
  fakePersonaPutError: fakePersonaPut.response.body?.error ?? null,
  fakeChannelGetStatus: fakeChannelGet.response.status,
  fakeChannelGetError: fakeChannelGet.response.body?.error ?? null,
  personaStateBeforeKeys: Object.keys(personaStateBefore ?? {}),
  personaStateAfterKeys: Object.keys(personaStateAfter ?? {}),
});
