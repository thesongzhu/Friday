#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildErroredResult, REAL_GREEN_GATE_RESULT_FILENAME } from "./lib/real-green-gate-result.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_RUNTIME_BOOT_TIMEOUT_MS = 90_000;
const DEFAULT_CHILD_STOP_GRACE_MS = 5_000;
const SELF_HOSTED_SETUP_COMPLETED_STEPS = ["welcome", "security", "network", "skills"];
const SELF_HOSTED_SETUP_SKIPPED_STEPS = ["communication", "provider", "channels"];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..", "..");

function parseArgs(argv) {
  const options = {
    repoRoot: DEFAULT_REPO_ROOT,
    reportRoot: path.join(os.tmpdir(), "real-green-gate"),
    runtimeBootTimeoutMs: DEFAULT_RUNTIME_BOOT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--repo-root":
        options.repoRoot = path.resolve(next);
        index += 1;
        break;
      case "--report-root":
        options.reportRoot = path.resolve(next);
        index += 1;
        break;
      case "--branch":
        options.branch = next;
        index += 1;
        break;
      case "--runtime-boot-timeout-ms":
        options.runtimeBootTimeoutMs = Number.parseInt(next, 10) || DEFAULT_RUNTIME_BOOT_TIMEOUT_MS;
        index += 1;
        break;
      default:
        break;
    }
  }

  return options;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function appendLogLine(filePath, line) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${line}\n`, "utf8");
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

async function findFreePort(host = DEFAULT_HOST) {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not determine a free TCP port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/v1/health`);
      if (response.ok) {
        return await response.json().catch(() => ({}));
      }
      lastError = new Error(`HTTP ${String(response.status)}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(1_000);
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Self-hosted Friday runtime did not become healthy${suffix}`);
}

async function bootstrapLocalPassphrase(baseUrl, localPassphrase) {
  const statusResponse = await fetch(`${baseUrl}/v1/auth/bootstrap/status`);
  const statusBody = await statusResponse.json().catch(() => ({}));
  if (!statusResponse.ok || statusBody?.ok !== true) {
    throw new Error(`Local auth bootstrap status failed with HTTP ${String(statusResponse.status)}`);
  }
  const bootstrapRequired = Boolean(statusBody?.data?.bootstrapRequired ?? statusBody?.bootstrapRequired);
  if (!bootstrapRequired) {
    return;
  }
  const bootstrapResponse = await fetch(`${baseUrl}/v1/auth/bootstrap/local-passphrase`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ localPassphrase }),
  });
  const bootstrapBody = await bootstrapResponse.json().catch(() => ({}));
  if (!bootstrapResponse.ok || bootstrapBody?.ok !== true) {
    throw new Error(`Local auth bootstrap failed with HTTP ${String(bootstrapResponse.status)}`);
  }
}

async function loginLocalPassphrase(baseUrl, localPassphrase) {
  const response = await fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ localPassphrase }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok !== true || typeof body?.data?.accessToken !== "string") {
    throw new Error(`Self-hosted local login failed with HTTP ${String(response.status)}`);
  }
  return body.data.accessToken;
}

export async function completeSelfHostedSetup(baseUrl, localPassphrase) {
  const accessToken = await loginLocalPassphrase(baseUrl, localPassphrase);
  const response = await fetch(`${baseUrl}/v1/setup/complete`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      completedSteps: SELF_HOSTED_SETUP_COMPLETED_STEPS,
      skippedSteps: SELF_HOSTED_SETUP_SKIPPED_STEPS,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok !== true) {
    throw new Error(`Self-hosted setup completion failed with HTTP ${String(response.status)}`);
  }
}

function createRuntimeEnv(baseEnv, paths, port, localPassphrase, tokenSecret) {
  return {
    ...baseEnv,
    FRIDAY_STATE_DIR: paths.stateDir,
    FRIDAY_TOKEN_SECRET: tokenSecret,
    FRIDAY_LOCAL_PASSPHRASE: localPassphrase,
    FRIDAY_PORT: String(port),
    FRIDAY_HOST: DEFAULT_HOST,
    FRIDAY_AUTO_OPEN_UI: "false",
    FRIDAY_BROWSER_HEADLESS: "true",
    FRIDAY_LOG_REQUESTS: "false",
    FRIDAY_CHANNELS_JSON: baseEnv.FRIDAY_CHANNELS_JSON ?? '{"enabled":true,"instances":[]}',
    FRIDAY_SYSTEM_ENABLED: baseEnv.FRIDAY_SYSTEM_ENABLED ?? "true",
  };
}

function createGateEnv(baseEnv, paths, baseUrl, localPassphrase, tokenSecret) {
  return {
    ...baseEnv,
    FRIDAY_STATE_DIR: paths.stateDir,
    FRIDAY_TOKEN_SECRET: tokenSecret,
    FRIDAY_BASE_URL: baseUrl,
    FRIDAY_UI_BASE_URL: baseUrl,
    FRIDAY_LOCAL_PASSPHRASE: localPassphrase,
    FRIDAY_CHANNELS_JSON: baseEnv.FRIDAY_CHANNELS_JSON ?? '{"enabled":true,"instances":[]}',
    FRIDAY_BROWSER_HEADLESS: "true",
  };
}

async function stopChild(child, graceMs = DEFAULT_CHILD_STOP_GRACE_MS) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      settle();
    }, graceMs);
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", settle);
      child.removeListener("error", settle);
      resolve();
    };
    child.once("close", settle);
    child.once("error", settle);
    child.kill("SIGTERM");
  });
}

function spawnLogged(command, args, { cwd, env, logPath }) {
  ensureDir(path.dirname(logPath));
  const stream = fs.createWriteStream(logPath, { flags: "w" });
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => stream.write(chunk));
  child.stderr.on("data", (chunk) => stream.write(chunk));
  child.once("close", () => stream.end());
  child.once("error", () => stream.end());
  return child;
}

async function runLogged(command, args, { cwd, env, logPath }) {
  const child = spawnLogged(command, args, { cwd, env, logPath });
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code: code ?? 1, signal });
    });
  });
}

function writeEarlyErrorArtifact(reportRoot, reason) {
  writeJson(path.join(reportRoot, REAL_GREEN_GATE_RESULT_FILENAME), buildErroredResult({
    commitSha: process.env.GITHUB_SHA ?? "",
    refName: process.env.GITHUB_REF_NAME ?? "",
    evaluatedAt: new Date().toISOString(),
    blockedReasons: [reason],
  }));
}

export async function runSelfHostedRealGreenGate(options) {
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const reportRoot = path.resolve(options.reportRoot);
  ensureDir(reportRoot);

  const distCli = path.join(repoRoot, "dist", "cli", "friday-cli.js");
  if (!fs.existsSync(distCli)) {
    throw new Error("dist/cli/friday-cli.js is missing; build the runtime before self-hosting RGG.");
  }

  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "friday-rgg-runtime-"));
  const paths = {
    runtimeRoot,
    stateDir: path.join(runtimeRoot, "state"),
    managedSkillsDir: path.join(runtimeRoot, "managed-skills"),
    runtimeLog: path.join(reportRoot, "self-hosted-runtime.log"),
    gateLog: path.join(reportRoot, "self-hosted-gate.log"),
  };
  ensureDir(paths.stateDir);
  ensureDir(paths.managedSkillsDir);

  const port = await findFreePort();
  const baseUrl = `http://${DEFAULT_HOST}:${String(port)}`;
  const localPassphrase = randomHex(24);
  const tokenSecret = randomHex(32);
  const runtimeEnv = createRuntimeEnv(process.env, paths, port, localPassphrase, tokenSecret);
  const runtime = spawnLogged(process.execPath, [
    distCli,
    "start",
    "--host",
    DEFAULT_HOST,
    "--port",
    String(port),
    "--skills-dir",
    path.join(repoRoot, "skills"),
    "--skills-dir",
    paths.managedSkillsDir,
    "--skills-dir",
    path.join(repoRoot, "managed-skills"),
  ], {
    cwd: repoRoot,
    env: runtimeEnv,
    logPath: paths.runtimeLog,
  });

  try {
    appendLogLine(path.join(reportRoot, "self-hosted-runtime-meta.txt"), `baseUrl=${baseUrl}`);
    await waitForHealth(baseUrl, options.runtimeBootTimeoutMs ?? DEFAULT_RUNTIME_BOOT_TIMEOUT_MS);
    await bootstrapLocalPassphrase(baseUrl, localPassphrase);
    await completeSelfHostedSetup(baseUrl, localPassphrase);

    const gateEnv = createGateEnv(process.env, paths, baseUrl, localPassphrase, tokenSecret);
    const gateArgs = [
      path.join(repoRoot, "scripts", "ops", "run-real-green-gate.mjs"),
      "--repo-root",
      repoRoot,
      "--base-url",
      baseUrl,
      "--ui-base-url",
      baseUrl,
      "--report-root",
      reportRoot,
    ];
    if (options.branch) {
      gateArgs.push("--branch", options.branch);
    }
    const gateResult = await runLogged(process.execPath, gateArgs, {
      cwd: repoRoot,
      env: gateEnv,
      logPath: paths.gateLog,
    });
    return gateResult;
  } finally {
    await stopChild(runtime);
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  try {
    const result = await runSelfHostedRealGreenGate(options);
    process.exitCode = result.code;
  } catch (error) {
    ensureDir(options.reportRoot);
    const message = error instanceof Error ? error.message : String(error);
    appendLogLine(path.join(options.reportRoot, "self-hosted-runtime-error.log"), message);
    writeEarlyErrorArtifact(options.reportRoot, "self_hosted_runtime_error");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
