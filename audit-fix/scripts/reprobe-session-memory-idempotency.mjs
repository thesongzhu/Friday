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

function dbAll(sql, ...params) {
  return db.prepare(sql).all(...params);
}

function getMemoryItemsForSession(sessionKey) {
  return dbAll(
    `SELECT id, namespace, metadata_json, created_at
     FROM memory_items
     WHERE json_extract(metadata_json, '$.sessionKey') = ?
     ORDER BY created_at ASC`,
    sessionKey,
  );
}

await resetDir(outDir);

const login = await apiRequest("POST", "/v1/auth/login", { local: true }, null);
await writeJson("login.json", login);

const token = login.rawBody?.data?.accessToken;
const userId = login.rawBody?.data?.user?.id;
if (typeof token !== "string" || token.length === 0) {
  throw new Error("Failed to obtain access token from /v1/auth/login");
}

const sessionSuffix = `${Date.now()}`;
const chatId = `issue-00117-idempotency-${sessionSuffix}`;
const sessionKey = `audit:default:${chatId}`;

const sessionCreate = await apiRequest(
  "POST",
  "/v1/sessions",
  {
    channel: "audit",
    chatId,
    userId,
  },
  token,
);
await writeJson("session-create.json", sessionCreate);

const userMessage = await apiRequest(
  "POST",
  `/v1/sessions/${encodeURIComponent(sessionKey)}/messages`,
  {
    role: "user",
    content: "Remember that I want weekly finance updates and I prefer dark mode.",
    contentText: "Remember that I want weekly finance updates and I prefer dark mode.",
  },
  token,
);
await writeJson("message-user.json", userMessage);

const assistantMessage = await apiRequest(
  "POST",
  `/v1/sessions/${encodeURIComponent(sessionKey)}/messages`,
  {
    role: "assistant",
    content: "Acknowledged. I will keep weekly finance updates and dark mode preference in mind.",
    contentText: "Acknowledged. I will keep weekly finance updates and dark mode preference in mind.",
  },
  token,
);
await writeJson("message-assistant.json", assistantMessage);

const userMessageId = userMessage.rawBody?.data?.message?.id;
if (typeof userMessageId !== "string" || userMessageId.length === 0) {
  throw new Error("Failed to obtain user message id");
}

const extract = await apiRequest(
  "POST",
  `/v1/sessions/${encodeURIComponent(sessionKey)}/memory/extract`,
  {
    trigger: "manual",
    mode: "inline",
  },
  token,
);
await writeJson("memory-extract.json", extract);

const sessionMessagesAfterExtract = dbAll(
  `SELECT id, role, memory_extract_status, memory_extracted_at, occurred_at
   FROM session_messages
   WHERE session_key = ?
   ORDER BY occurred_at ASC`,
  sessionKey,
);
await writeJson("session-messages-after-extract-db.json", sessionMessagesAfterExtract);

const memoryItemsAfterExtract = getMemoryItemsForSession(sessionKey);
await writeJson("memory-items-after-extract-db.json", memoryItemsAfterExtract);

const remember = await apiRequest(
  "POST",
  `/v1/sessions/${encodeURIComponent(sessionKey)}/memory/remember`,
  {
    messageIds: [userMessageId],
    mode: "inline",
  },
  token,
);
await writeJson("memory-remember.json", remember);

const memoryStatus = await apiRequest(
  "GET",
  `/v1/sessions/${encodeURIComponent(sessionKey)}/memory/extraction`,
  null,
  token,
);
await writeJson("memory-status.json", memoryStatus);

const sessionMessagesAfterRemember = dbAll(
  `SELECT id, role, memory_extract_status, memory_extracted_at, occurred_at
   FROM session_messages
   WHERE session_key = ?
   ORDER BY occurred_at ASC`,
  sessionKey,
);
await writeJson("session-messages-after-remember-db.json", sessionMessagesAfterRemember);

const memoryItemsAfterRemember = getMemoryItemsForSession(sessionKey);
await writeJson("memory-items-after-remember-db.json", memoryItemsAfterRemember);

const extractCount = memoryItemsAfterExtract.length;
const rememberCount = memoryItemsAfterRemember.length;

await writeJson("session-memory-summary.json", {
  sessionKey,
  userMessageId,
  extractStatus: extract.response.status,
  rememberStatus: remember.response.status,
  memoryItemsAfterExtract: extractCount,
  memoryItemsAfterRemember: rememberCount,
  memoryItemsDelta: rememberCount - extractCount,
  extractResult: extract.response.body?.data?.result ?? null,
  rememberResult: remember.response.body?.data?.result ?? null,
  extractionStatus: memoryStatus.response.body?.data?.status ?? null,
  idempotentRemember: rememberCount === extractCount,
});

db.close();
