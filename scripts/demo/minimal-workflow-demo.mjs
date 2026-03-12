#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..", "..");
const DIST_CLI = join(ROOT, "dist", "cli", "friday-cli.js");
const SAMPLE_WORKFLOW_PATH = join(
  ROOT,
  "examples",
  "workflows",
  "minimal-demo.workflow.json",
);

const HOST = "127.0.0.1";
const PORT = Number(process.env.FRIDAY_DEMO_PORT ?? "32141");
const BASE_URL = `http://${HOST}:${PORT}`;
const STATE_DIR = join(ROOT, ".friday", "demo-state");
const DEMO_HOME_DIR = join(STATE_DIR, ".demo-home");
const DEMO_ENV_FILE = join(STATE_DIR, ".demo.env");
const HEALTH_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 20_000;

let serverProc = null;
let serverStdout = "";
let serverStderr = "";

function logStep(message) {
  console.log(`\n[demo] ${message}`);
}

function runNpm(args) {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCmd, args, {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed with status ${result.status ?? "unknown"}`);
  }
}

function ensureBuild() {
  if (existsSync(DIST_CLI)) {
    return;
  }
  logStep("dist not found, running npm run build");
  runNpm(["run", "build"]);
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function throwWithContext(message) {
  const auditLogPath = join(STATE_DIR, ".friday", "audit.jsonl");
  const dbPath = join(STATE_DIR, "friday.db");
  const context = [
    "",
    "[demo] failure context",
    `- state dir: ${STATE_DIR}`,
    `- db path: ${dbPath}`,
    `- audit log path: ${auditLogPath}`,
    `- stdout (tail): ${serverStdout.slice(-2000) || "<empty>"}`,
    `- stderr (tail): ${serverStderr.slice(-2000) || "<empty>"}`,
  ].join("\n");
  throw new Error(`${message}${context}`);
}

async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/v1/health`);
      if (res.ok) {
        const body = await res.json();
        const status = body?.ok === true ? body?.data?.status : body?.status;
        if (status === "ok") {
          return body;
        }
      }
    } catch {
      // Server not ready yet
    }
    await sleep(300);
  }
  throwWithContext(`health check did not become ready within ${HEALTH_TIMEOUT_MS}ms`);
}

async function pollRunStatus(token, runId) {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE_URL}/v1/workflow-runs/${runId}`, {
      headers: authHeaders(token),
    });
    const json = await res.json();
    if (!res.ok || json?.ok !== true) {
      throwWithContext(`failed to query run status: HTTP ${res.status}`);
    }
    const status = json.data?.run?.status;
    if (status === "completed" || status === "failed" || status === "cancelled") {
      return json.data.run;
    }
    await sleep(400);
  }
  throwWithContext(`run did not reach terminal state within ${RUN_TIMEOUT_MS}ms`);
}

async function main() {
  ensureBuild();
  rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(STATE_DIR, { recursive: true });

  logStep(`starting Friday on ${BASE_URL}`);
  const env = {
    ...process.env,
    NODE_ENV: "development",
    HOME: DEMO_HOME_DIR,
    USERPROFILE: DEMO_HOME_DIR,
    FRIDAY_ENV_FILE: DEMO_ENV_FILE,
    FRIDAY_STATE_DIR: STATE_DIR,
    FRIDAY_LOG_REQUESTS: process.env.FRIDAY_LOG_REQUESTS ?? "true",
  };
  delete env.FRIDAY_TOKEN_SECRET;
  delete env.FRIDAY_CHANNELS_JSON;
  delete env.FRIDAY_CHANNEL_SECRET_POLICY;
  delete env.FRIDAY_MCP_SERVERS;
  delete env.FRIDAY_DESKTOP_ENABLED;
  delete env.FRIDAY_BROWSER_USE_HOST_CHROME;
  delete env.FRIDAY_BROWSER_HEADLESS;
  delete env.DISCORD_BOT_TOKEN;

  serverProc = spawn(
    process.execPath,
    [DIST_CLI, "start", "--host", HOST, "--port", String(PORT)],
    {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  serverProc.stdout.on("data", (chunk) => {
    serverStdout += chunk.toString();
  });
  serverProc.stderr.on("data", (chunk) => {
    serverStderr += chunk.toString();
  });

  const health = await waitForHealth();
  if (health?.data?.capabilities?.auth?.allowPasswordlessLocalLogin !== true) {
    throwWithContext(
      "passwordless local login is disabled; run demo with NODE_ENV=development and without FRIDAY_TOKEN_SECRET",
    );
  }

  logStep("logging in with local dev mode");
  const loginRes = await fetch(`${BASE_URL}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ local: true }),
  });
  const loginJson = await loginRes.json();
  if (!loginRes.ok || loginJson?.ok !== true) {
    throwWithContext(`login failed: HTTP ${loginRes.status}`);
  }
  const token = loginJson.data?.accessToken;
  if (typeof token !== "string" || token.length === 0) {
    throwWithContext("login response missing accessToken");
  }

  const sample = JSON.parse(readFileSync(SAMPLE_WORKFLOW_PATH, "utf-8"));
  const slug = `demo-minimal-${Date.now()}`;
  logStep("creating minimal workflow");
  const createRes = await fetch(`${BASE_URL}/v1/workflows`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      slug,
      name: sample.name,
      description: sample.description,
      tags: sample.tags,
      graph: sample.graph,
    }),
  });
  const createJson = await createRes.json();
  if (!createRes.ok || createJson?.ok !== true) {
    throwWithContext(`create workflow failed: HTTP ${createRes.status}`);
  }
  const workflowId = createJson.data?.workflow?.id;
  const versionNumber = createJson.data?.version?.versionNumber;
  if (typeof workflowId !== "string" || typeof versionNumber !== "number") {
    throwWithContext("create workflow response missing workflowId/versionNumber");
  }

  logStep("publishing workflow");
  const publishRes = await fetch(`${BASE_URL}/v1/workflows/${workflowId}/publish`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ versionNumber }),
  });
  const publishJson = await publishRes.json();
  if (!publishRes.ok || publishJson?.ok !== true) {
    throwWithContext(`publish workflow failed: HTTP ${publishRes.status}`);
  }

  logStep("triggering workflow run");
  const runRes = await fetch(`${BASE_URL}/v1/workflow-runs`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      workflowId,
      triggerType: "manual",
      triggerPayload: { source: "npm run demo" },
    }),
  });
  const runJson = await runRes.json();
  if (!runRes.ok || runJson?.ok !== true) {
    throwWithContext(`start run failed: HTTP ${runRes.status}`);
  }
  const runId = runJson.data?.run?.id;
  if (typeof runId !== "string") {
    throwWithContext("run response missing runId");
  }

  const run = await pollRunStatus(token, runId);
  if (run.status !== "completed") {
    throwWithContext(`run finished with status ${run.status}`);
  }

  console.log("\n✅ Friday one-command demo completed");
  console.log(`- workflowId: ${workflowId}`);
  console.log(`- runId: ${runId}`);
  console.log(`- state dir: ${STATE_DIR}`);
  console.log(`- inspect run: ${BASE_URL}/v1/workflow-runs/${runId}`);
}

async function shutdown() {
  if (!serverProc) {
    return;
  }

  serverProc.kill("SIGINT");
  const deadline = Date.now() + 8_000;
  while (serverProc.exitCode === null && Date.now() < deadline) {
    await sleep(200);
  }
  if (serverProc.exitCode === null) {
    serverProc.kill("SIGKILL");
  }
  serverProc = null;
}

main()
  .catch((error) => {
    console.error(`\n❌ Demo failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdown();
  });
