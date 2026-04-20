import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";

const execFileAsync = promisify(execFile);

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3241";
const dbPath = process.env.DB_PATH;
const outDir = process.env.OUT_DIR;
const logPath = process.env.LOG_PATH;
const repoRoot = process.env.REPO_ROOT;

if (!dbPath) throw new Error("DB_PATH is required");
if (!outDir) throw new Error("OUT_DIR is required");
if (!logPath) throw new Error("LOG_PATH is required");
if (!repoRoot) throw new Error("REPO_ROOT is required");

const baseUrlObject = new URL(baseUrl);
const runtimeHost = baseUrlObject.hostname;
const runtimePort = baseUrlObject.port || (baseUrlObject.protocol === "https:" ? "443" : "80");
const runtimeStateDir = path.dirname(dbPath);

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

function dbAll(sql, ...params) {
  return db.prepare(sql).all(...params);
}

async function readLogTail(file, maxLines = 160) {
  const text = await fs.readFile(file, "utf8");
  return text.split(/\r?\n/).slice(-maxLines).join("\n");
}

async function runTuiCapture() {
  const capturePath = path.join(outDir, "tui-typescript.txt");
  const shellCommand = "(sleep 1; printf 'q\\n') | node dist/cli/friday-cli.js tui";
  const env = {
    ...process.env,
    HOME: process.env.HOME,
    FRIDAY_HOST: runtimeHost,
    FRIDAY_PORT: runtimePort,
    FRIDAY_STATE_DIR: runtimeStateDir,
    FRIDAY_TUI_BASE_URL: baseUrlObject.toString().replace(/\/$/, ""),
  };

  try {
    await execFileAsync(
      "script",
      ["-q", capturePath, "zsh", "-lc", shellCommand],
      {
        cwd: repoRoot,
        env,
        timeout: 15_000,
        maxBuffer: 1024 * 1024 * 4,
      },
    );
    const typescript = await fs.readFile(capturePath, "utf8");
    return {
      stdout: typescript,
      stderr: "",
      exitCode: 0,
      failed: false,
    };
  } catch (error) {
    const fallback = await execFileAsync(
      "zsh",
      ["-lc", shellCommand],
      {
        cwd: repoRoot,
        env,
        timeout: 15_000,
        maxBuffer: 1024 * 1024 * 4,
      },
    ).catch((fallbackError) => ({
      stdout: fallbackError.stdout ?? "",
      stderr: fallbackError.stderr ?? "",
      exitCode: typeof fallbackError.code === "number" ? fallbackError.code : null,
      failed: true,
    }));

    const scriptError = error instanceof Error ? error.message : String(error);
    return {
      ...fallback,
      stderr: [scriptError, fallback.stderr ?? ""].filter(Boolean).join("\n"),
    };
  }
}

await resetDir(outDir);

const login = await apiRequest("POST", "/v1/auth/login", { local: true }, null);
await writeJson("login.json", login);

const token = login.rawBody?.data?.accessToken;
if (typeof token !== "string" || token.length === 0) {
  throw new Error("Failed to obtain access token from /v1/auth/login");
}

const sessionCreate = await apiRequest(
  "POST",
  "/v1/sessions",
  {
    channel: "discord",
    accountId: "tui-audit",
    chatId: `issue-00140-${Date.now()}`,
  },
  token,
);
await writeJson("session-create.json", sessionCreate);

const status = await apiRequest("GET", "/v1/status", null, token);
await writeJson("status.json", status);

const jobs = await apiRequest("GET", "/v1/jobs", null, token);
await writeJson("jobs.json", jobs);

const sessions = await apiRequest("GET", "/v1/sessions", null, token);
await writeJson("sessions.json", sessions);

const pairings = await apiRequest("GET", "/v1/satellites/pairing", null, token);
await writeJson("pairings.json", pairings);

await writeJson(
  "state-active-sessions.json",
  dbGet("SELECT COUNT(*) AS count FROM sessions WHERE status = 'active'"),
);
await writeJson(
  "state-jobs.json",
  dbAll(
    `SELECT id, enabled, running_at, last_run_at, last_status, next_run_at
     FROM friday_scheduler_jobs
     ORDER BY id`,
  ),
);

const cliResult = await runTuiCapture();

await writeText("tui-stdout.txt", `${cliResult.stdout ?? ""}`);
await writeText("tui-stderr.txt", `${cliResult.stderr ?? ""}`);

const logTail = await readLogTail(logPath);
await writeText("runtime-log-tail.txt", `${logTail}\n`);

await writeJson("issue-00140-summary.json", {
  checkedAt: new Date().toISOString(),
  statusRouteStatus: status.response.status,
  jobsRouteStatus: jobs.response.status,
  sessionsRouteStatus: sessions.response.status,
  pairingsRouteStatus: pairings.response.status,
  statusRouteData: status.response.body?.data ?? null,
  jobsRouteCount: Array.isArray(jobs.response.body?.data) ? jobs.response.body.data.length : null,
  dbActiveSessionCount: dbGet("SELECT COUNT(*) AS count FROM sessions WHERE status = 'active'")?.count ?? null,
  dbJobCount: dbGet("SELECT COUNT(*) AS count FROM friday_scheduler_jobs")?.count ?? null,
  tuiRenderedDashboard: String(cliResult.stdout ?? "").includes("Friday TUI")
    && String(cliResult.stdout ?? "").includes("Dashboard"),
  tuiRenderedJobsLabel: String(cliResult.stdout ?? "").includes("jobs:"),
  tuiProcessExitCode: cliResult.exitCode ?? 0,
});
