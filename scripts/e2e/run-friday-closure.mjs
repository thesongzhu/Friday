#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { createSign, generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  buildClosureScratchEnv,
  FRIDAY_CLOSURE_STATUSES,
  collectCloudBlockers,
  createClosureRunId,
  resolveReadinessReport,
  resolveClosureRoot,
  resolveClosureVerdict,
} from "./friday-closure-lib.mjs";
import { acquireWorkspaceRunLock, releaseWorkspaceRunLock } from "../quality/workspace-run-lock.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DIST_CLI = path.join(REPO_ROOT, "dist", "cli", "friday-cli.js");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 180_000;
const ALL_MODES = process.argv.includes("--all");
const LOCAL_ONLY = process.argv.includes("--local-only");
const CLOUD_ONLY = process.argv.includes("--cloud-only");
const CLOUD_CLOSURE_ENABLED = process.env.FRIDAY_E2E_CLOUD_ENABLED === "1";
const SKIP_INSTALL = process.argv.includes("--skip-install") || process.env.FRIDAY_CLOSURE_SKIP_INSTALL === "1";
const SKIP_BACKSTOP = process.argv.includes("--skip-backstop") || process.env.FRIDAY_CLOSURE_SKIP_BACKSTOP === "1";
if (CLOUD_ONLY && !CLOUD_CLOSURE_ENABLED) {
  console.log("Cloud closure is disabled for this local-first Friday build. Set FRIDAY_E2E_CLOUD_ENABLED=1 to run the legacy cloud closure gate.");
  process.exit(0);
}
const CLOSURE_MODE = CLOUD_ONLY && CLOUD_CLOSURE_ENABLED
  ? "cloud"
  : ALL_MODES && CLOUD_CLOSURE_ENABLED
    ? "all"
    : LOCAL_ONLY || ALL_MODES || CLOUD_ONLY
      ? "local"
      : "local";

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, text, "utf8");
}

export async function closeWritableStream(stream, timeoutMs = 5_000) {
  if (!stream || stream.destroyed || stream.closed) {
    return;
  }
  await new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stream.removeListener("finish", settle);
      stream.removeListener("close", settle);
      stream.removeListener("error", settle);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        stream.destroy();
      } catch {
        // ignore cleanup failure
      }
      settle();
    }, timeoutMs);
    stream.once("finish", settle);
    stream.once("close", settle);
    stream.once("error", settle);
    try {
      if (!stream.writableEnded) {
        stream.end();
      } else if (stream.closed || stream.destroyed) {
        settle();
      }
    } catch {
      settle();
    }
  });
}

export async function stopManagedChildProcess(
  child,
  { graceMs = 5_000, forceKillMs = 2_000 } = {},
) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(forceKillTimer);
      clearTimeout(finalTimer);
      child.removeListener("close", settle);
      child.removeListener("error", settle);
      resolve();
    };
    const forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          settle();
        }
      }
    }, graceMs);
    const finalTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore duplicate cleanup failure
        }
      }
      settle();
    }, graceMs + forceKillMs);
    child.once("close", settle);
    child.once("error", settle);
    try {
      child.kill("SIGTERM");
    } catch {
      settle();
    }
  });
}

function createCleanupRegistry() {
  const tasks = [];
  return {
    add(task) {
      tasks.push(task);
    },
    async run() {
      const errors = [];
      while (tasks.length > 0) {
        const task = tasks.pop();
        try {
          await task();
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      return errors;
    },
  };
}

function sanitizeName(value) {
  return value.replace(/[^a-z0-9._-]+/gi, "-");
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, DEFAULT_HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not determine a free port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

export function createLedger(paths) {
  return {
    runId: paths.runId,
    startedAt: nowIso(),
    completedAt: null,
    lastUpdatedAt: nowIso(),
    cwd: REPO_ROOT,
    mode: CLOSURE_MODE,
    commitSha: spawnSyncOutput("git", ["rev-parse", "HEAD"]).trim(),
    paths,
    entries: [],
    activeStep: null,
    summary: { pass: 0, fail: 0, blocker: 0 },
    verdict: "NO-GO",
    readiness: null,
  };
}

export function persistLedger(ledger) {
  const resolved = resolveClosureVerdict(ledger.entries);
  ledger.summary = resolved.summary;
  ledger.verdict = resolved.verdict;
  ledger.readiness = resolveReadinessReport(ledger.entries, ledger.mode);
  ledger.lastUpdatedAt = nowIso();
  writeJson(path.join(ledger.paths.root, "ledger.json"), ledger);
}

export function markInterruptedClosureLedger(lockPayload) {
  const ledgerPath = typeof lockPayload?.ledgerPath === "string" ? lockPayload.ledgerPath : null;
  if (!ledgerPath || !fs.existsSync(ledgerPath)) {
    return;
  }

  let ledger = null;
  try {
    ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  } catch {
    return;
  }

  const interruptedAt = nowIso();
  const entries = Array.isArray(ledger?.entries) ? ledger.entries : [];
  const runningEntry = [...entries].reverse().find((entry) => entry?.status === FRIDAY_CLOSURE_STATUSES.RUNNING);
  if (runningEntry) {
    runningEntry.status = FRIDAY_CLOSURE_STATUSES.FAIL;
    runningEntry.completedAt = interruptedAt;
    runningEntry.durationMs = runningEntry.startedAt
      ? Math.max(0, Date.parse(interruptedAt) - Date.parse(runningEntry.startedAt))
      : runningEntry.durationMs ?? 0;
    runningEntry.details = {
      ...(runningEntry.details || {}),
      interrupted: true,
      error: `Closure process ${String(lockPayload?.pid ?? "unknown")} exited before completing the active step`,
    };
  }

  ledger.entries = entries;
  ledger.activeStep = null;
  ledger.completedAt = ledger.completedAt || interruptedAt;
  ledger.lastUpdatedAt = interruptedAt;
  const resolved = resolveClosureVerdict(entries);
  ledger.summary = resolved.summary;
  ledger.verdict = resolved.verdict;
  ledger.readiness = resolveReadinessReport(entries, ledger.mode ?? CLOSURE_MODE);

  writeJson(ledgerPath, ledger);
}

function spawnSyncOutput(cmd, args, cwd = REPO_ROOT) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function getValueAtPath(source, pathSegments) {
  let current = source;
  for (const segment of pathSegments) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function getFirstNonEmptyString(source, paths) {
  for (const pathSegments of paths) {
    const value = getValueAtPath(source, pathSegments);
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function getFirstArray(source, paths) {
  for (const pathSegments of paths) {
    const value = getValueAtPath(source, pathSegments);
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function inspectAgentClosureResult(envelope, { label, expectedText } = {}) {
  const resultLabel = label ?? "agentRun";
  const status = getFirstNonEmptyString(envelope, [
    ["data", "status"],
    ["data", "result", "status"],
    ["data", "run", "status"],
  ]);
  const responseText = getFirstNonEmptyString(envelope, [
    ["data", "response"],
    ["data", "responseText"],
    ["data", "result", "response"],
    ["data", "result", "responseText"],
    ["data", "run", "response"],
    ["data", "run", "responseText"],
  ]);

  const closureFailures = [];
  if (status !== "completed") {
    closureFailures.push(`${resultLabel}.status=${status ?? "missing"}`);
  }
  if (!responseText) {
    closureFailures.push(`${resultLabel}.response=missing`);
  }
  if (expectedText && (!responseText || !responseText.includes(expectedText))) {
    closureFailures.push(`${resultLabel}.responseMissingExpected=${expectedText}`);
  }

  return { status, responseText, closureFailures };
}

function appendLedgerEntry(ledger, entry) {
  ledger.entries.push(entry);
  persistLedger(ledger);
}

async function runCommand({
  id,
  stage,
  description,
  command,
  args,
  cwd = REPO_ROOT,
  env,
  logPath,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  ensureDir(path.dirname(logPath));
  const stream = fs.createWriteStream(logPath, { flags: "w" });
  const startedAt = Date.now();
  let timedOut = false;
  let forcedKill = false;
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let combined = "";
  const appendChunk = (chunk) => {
    const text = chunk.toString();
    combined += text;
    if (combined.length > 40_000) {
      combined = combined.slice(-40_000);
    }
    stream.write(text);
  };

  child.stdout.on("data", appendChunk);
  child.stderr.on("data", appendChunk);

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);
  const forceKillTimeout = setTimeout(() => {
    if (child.exitCode === null) {
      forcedKill = true;
      child.kill("SIGKILL");
    }
  }, timeoutMs + 5_000);

  let result;
  try {
    result = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => {
        resolve({
          code: code ?? 1,
          signal,
          output: combined,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  } finally {
    clearTimeout(timeout);
    clearTimeout(forceKillTimeout);
    await closeWritableStream(stream, 5_000);
  }

  return {
    id,
    stage,
    description,
    command: [command, ...args].join(" "),
    logPath,
    timedOut,
    forcedKill,
    ...result,
  };
}

async function waitForHealth(baseUrl, logPath, timeoutMs = 60_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/v1/health`);
      if (response.ok) {
        const body = await response.json();
        writeJson(logPath, body);
        return body;
      }
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for ${baseUrl}/v1/health`);
}

async function loginLocal(baseUrl) {
  const response = await fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ local: true }),
  });
  const body = await response.json();
  if (!response.ok || !body.ok || !body.data?.accessToken) {
    throw new Error(`Local login failed: ${JSON.stringify(body)}`);
  }
  return body.data;
}

function writeClosureConverterFixture(ledgerPaths) {
  const skillDir = path.join(ledgerPaths.skills, "hello-converter-e2e");
  ensureDir(skillDir);
  const skillMdPath = path.join(skillDir, "SKILL.md");
  writeText(skillMdPath, `---
skillKey: hello-converter-e2e
name: Hello Converter E2E
author: closure
---

Outputs a greeting message for converter closure testing.

\`\`\`bash
echo '{"greeting": "hello from converted skill"}'
\`\`\`
`);
  return skillMdPath;
}

async function apiFetch(baseUrl, token, method, routePath, body, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetch(`${baseUrl}${routePath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const json = await response.json().catch(() => ({}));
    return { status: response.status, json };
  } finally {
    clearTimeout(timer);
  }
}

function buildEntrySkeleton(id, stage, description) {
  return {
    id,
    stage,
    description,
    startedAt: nowIso(),
    completedAt: null,
    durationMs: 0,
    status: FRIDAY_CLOSURE_STATUSES.RUNNING,
    evidence: {},
    details: {},
  };
}

export async function runStep(ledger, { id, stage, description }, fn) {
  const entry = buildEntrySkeleton(id, stage, description);
  const startedAtMs = Date.now();
  ledger.activeStep = {
    id,
    stage,
    description,
    startedAt: entry.startedAt,
  };
  appendLedgerEntry(ledger, entry);
  try {
    const result = await fn(entry);
    entry.status = result?.status ?? FRIDAY_CLOSURE_STATUSES.PASS;
    entry.evidence = { ...(entry.evidence || {}), ...(result?.evidence || {}) };
    entry.details = { ...(entry.details || {}), ...(result?.details || {}) };
  } catch (error) {
    entry.status = FRIDAY_CLOSURE_STATUSES.FAIL;
    entry.details = {
      ...(entry.details || {}),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    entry.completedAt = nowIso();
    entry.durationMs = Date.now() - startedAtMs;
    if (ledger.activeStep?.id === id) {
      ledger.activeStep = null;
    }
    persistLedger(ledger);
  }
  return entry;
}

function writeResponseEvidence(paths, id, payload) {
  const responsePath = path.join(paths.responses, `${sanitizeName(id)}.json`);
  writeJson(responsePath, payload);
  return responsePath;
}

function writeCommandEvidence(paths, id, payload) {
  const commandPath = path.join(paths.logs, `${sanitizeName(id)}.log`);
  writeText(commandPath, payload);
  return commandPath;
}

function formatReadinessReport(readiness) {
  const lines = [];

  if (readiness.mode === "local") {
    lines.push(`Product Ready (Local): ${readiness.productReadyLocal}`);
    if (readiness.repoReady !== "NOT_RUN") {
      lines.push(`Repo Ready: ${readiness.repoReady}`);
    }
    return lines.join("\n");
  }

  if (readiness.mode === "cloud") {
    lines.push(`Cloud Ready: ${readiness.cloudReady}`);
    return lines.join("\n");
  }

  lines.push(`Repo Ready: ${readiness.repoReady}`);
  lines.push(`Product Ready (Local): ${readiness.productReadyLocal}`);
  lines.push(`Cloud Ready: ${readiness.cloudReady}`);
  lines.push(`Overall: ${readiness.overall}`);
  return lines.join("\n");
}

function formatConsoleSummary(readiness, ledgerPath) {
  if (readiness.mode === "local") {
    return `Product Ready (Local): ${readiness.productReadyLocal} (${ledgerPath})`;
  }

  if (readiness.mode === "cloud") {
    return `Cloud Ready: ${readiness.cloudReady} (${ledgerPath})`;
  }

  return `Repo Ready: ${readiness.repoReady}; Product Ready (Local): ${readiness.productReadyLocal}; Cloud Ready: ${readiness.cloudReady}; Overall: ${readiness.overall} (${ledgerPath})`;
}

function makeScratchPlugin(pluginRoot) {
  ensureDir(pluginRoot);
  const manifest = {
    schemaVersion: "1.0",
    id: "closure.test.plugin",
    version: "1.0.0",
    name: "Closure Test Plugin",
    description: "Scratch plugin for Friday closure runs.",
    kinds: ["skill"],
    entrypoints: { skill: "./index.js" },
    permissions: {
      grants: [
        {
          id: "perm-filesystem-read",
          resource: "filesystem",
          action: "read",
          required: true,
          reason: "Read scratch artifacts during the closure run",
        },
      ],
      promptOn: [],
    },
    compatibility: {
      minHubVersion: "0.1.0",
      apiVersion: "1",
    },
  };

  writeJson(path.join(pluginRoot, "friday.plugin.json"), manifest);
  writeText(
    path.join(pluginRoot, "index.js"),
    "export async function activate() {}\nexport async function deactivate() {}\n",
  );
  return manifest;
}

function makeScratchWorkflowSkill(skillRoot) {
  ensureDir(skillRoot);
  const manifest = {
    schemaVersion: "2.0",
    id: "closure-workflow-template",
    name: "Closure Workflow Template Skill",
    description: "Synthetic workflow-capable skill used by closure harness.",
    version: "1.0.0",
    kind: "conversation",
    category: "automation",
    author: { name: "closure-harness" },
    tags: ["closure", "workflow"],
    runtime: {
      kind: "shell",
      entrypoint: "run.sh",
      minHubVersion: "1.0.0",
      apiVersion: "1",
      timeoutMsDefault: 30000,
    },
    triggers: {
      intents: [],
      phrases: [],
      channels: ["*"],
    },
    invocation: {
      userInvocable: true,
      modelInvocable: false,
      priority: 10,
      modes: ["workflow"],
    },
    requirements: {
      bins: [],
      env: [],
      config: [],
      os: ["darwin", "linux", "win32"],
    },
    inputs: [],
    outputs: [
      {
        key: "status",
        type: "string",
        description: "Closure status output",
      },
    ],
    permissions: {
      grants: [],
      promptOn: [],
    },
    schemas: null,
    flow: null,
    executionTargets: {
      allowedSatelliteTypes: ["desktop", "cloud-vm"],
      requiredCapabilities: [],
    },
    telemetry: {
      events: [],
    },
  };

  writeJson(path.join(skillRoot, "skill.manifest.json"), manifest);
  const runPath = path.join(skillRoot, "run.sh");
  writeText(
    runPath,
    "#!/usr/bin/env bash\nset -euo pipefail\necho '{\"status\":\"ok\"}'\n",
  );
  fs.chmodSync(runPath, 0o755);
  return manifest;
}

function createSatelliteKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey };
}

function signSatelliteChallenge(privateKeyPem, challengeNonce) {
  const signer = createSign("SHA256");
  signer.update(challengeNonce);
  signer.end();
  return signer.sign(privateKeyPem, "base64");
}

function describeCommandFailure(result) {
  const parts = [
    `${result.description} failed`,
    `code ${String(result.code)}`,
  ];
  if (result.signal) {
    parts.push(`signal ${result.signal}`);
  }
  if (result.timedOut) {
    parts.push(`timeout ${String(result.durationMs)}ms`);
  }
  if (result.forcedKill) {
    parts.push("forced-kill");
  }
  return parts.join(" ");
}

function isDeepSeekStyleApiKey(value) {
  return /^sk-[a-f0-9]{32}$/i.test(String(value ?? "").trim());
}

function readEnvValue(env, name) {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveClosureProviderConfig(env = process.env) {
  const explicitKind = readEnvValue(env, "FRIDAY_CLOSURE_PROVIDER_KIND")?.toLowerCase();
  const explicitEnvVar = readEnvValue(env, "FRIDAY_CLOSURE_API_KEY_ENV");
  const explicitModel = readEnvValue(env, "FRIDAY_CLOSURE_MODEL");
  const explicitAgentModel = readEnvValue(env, "FRIDAY_CLOSURE_AGENT_MODEL");

  const candidates = [
    {
      kind: "deepseek",
      envVar: "FRIDAY_DEEPSEEK_API_KEY",
      name: "Closure DeepSeek",
      baseUrl: readEnvValue(env, "FRIDAY_CLOSURE_DEEPSEEK_BASE_URL") ?? "https://api.deepseek.com",
      api: "openai-completions",
      supportedModels: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
      defaultModel: explicitModel ?? "deepseek-v4-flash",
      generationModel: explicitModel ?? "deepseek-v4-pro",
      agentModel: explicitAgentModel ?? explicitModel ?? "deepseek-v4-flash",
    },
    {
      kind: "deepseek",
      envVar: "DEEPSEEK_API_KEY",
      name: "Closure DeepSeek",
      baseUrl: readEnvValue(env, "FRIDAY_CLOSURE_DEEPSEEK_BASE_URL") ?? "https://api.deepseek.com",
      api: "openai-completions",
      supportedModels: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
      defaultModel: explicitModel ?? "deepseek-v4-flash",
      generationModel: explicitModel ?? "deepseek-v4-pro",
      agentModel: explicitAgentModel ?? explicitModel ?? "deepseek-v4-flash",
    },
    {
      kind: isDeepSeekStyleApiKey(readEnvValue(env, "OPENAI_API_KEY")) ? "deepseek" : "openai",
      envVar: "OPENAI_API_KEY",
      name: isDeepSeekStyleApiKey(readEnvValue(env, "OPENAI_API_KEY")) ? "Closure DeepSeek" : "Closure OpenAI",
      baseUrl: isDeepSeekStyleApiKey(readEnvValue(env, "OPENAI_API_KEY"))
        ? readEnvValue(env, "FRIDAY_CLOSURE_DEEPSEEK_BASE_URL") ?? "https://api.deepseek.com"
        : readEnvValue(env, "E2E_OPENAI_BASE_URL") ?? "https://api.openai.com",
      api: isDeepSeekStyleApiKey(readEnvValue(env, "OPENAI_API_KEY")) ? "openai-completions" : "openai-responses",
      supportedModels: isDeepSeekStyleApiKey(readEnvValue(env, "OPENAI_API_KEY"))
        ? ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"]
        : ["gpt-4o-mini", "gpt-4o"],
      defaultModel: explicitModel ?? (isDeepSeekStyleApiKey(readEnvValue(env, "OPENAI_API_KEY")) ? "deepseek-v4-flash" : "gpt-4o-mini"),
      generationModel: explicitModel ?? (isDeepSeekStyleApiKey(readEnvValue(env, "OPENAI_API_KEY")) ? "deepseek-v4-pro" : "gpt-4o"),
      agentModel: explicitAgentModel ?? explicitModel ?? (isDeepSeekStyleApiKey(readEnvValue(env, "OPENAI_API_KEY")) ? "deepseek-v4-flash" : "gpt-4o-mini"),
    },
    {
      kind: "openai",
      envVar: "FRIDAY_OPENAI_API_KEY",
      name: "Closure OpenAI",
      baseUrl: readEnvValue(env, "E2E_OPENAI_BASE_URL") ?? "https://api.openai.com",
      api: "openai-responses",
      supportedModels: ["gpt-4o-mini", "gpt-4o"],
      defaultModel: explicitModel ?? "gpt-4o-mini",
      generationModel: explicitModel ?? "gpt-4o",
      agentModel: explicitAgentModel ?? explicitModel ?? "gpt-4o-mini",
    },
  ];

  const filtered = candidates.filter((candidate) => {
    if (explicitKind && candidate.kind !== explicitKind) {
      return false;
    }
    if (explicitEnvVar && candidate.envVar !== explicitEnvVar) {
      return false;
    }
    return Boolean(readEnvValue(env, candidate.envVar));
  });

  const selected = filtered[0] ?? null;
  if (!selected) {
    const expected = explicitEnvVar
      ? explicitEnvVar
      : explicitKind === "deepseek"
        ? "FRIDAY_DEEPSEEK_API_KEY or DEEPSEEK_API_KEY"
        : explicitKind === "openai"
          ? "OPENAI_API_KEY or FRIDAY_OPENAI_API_KEY"
          : "FRIDAY_DEEPSEEK_API_KEY, DEEPSEEK_API_KEY, OPENAI_API_KEY, or FRIDAY_OPENAI_API_KEY";
    return {
      available: false,
      blockerReason: `${expected} is not set`,
      kind: explicitKind ?? null,
      envVar: explicitEnvVar ?? null,
    };
  }

  return {
    ...selected,
    available: true,
    apiKey: readEnvValue(env, selected.envVar),
  };
}

async function createClosureProvider(baseUrl, token, providerConfig) {
  const createRes = await apiFetch(baseUrl, token, "POST", "/v1/providers", {
    kind: providerConfig.kind,
    name: providerConfig.name,
    baseUrl: providerConfig.baseUrl,
    authMode: "api-key",
    api: providerConfig.api,
    apiKey: `$${providerConfig.envVar}`,
    supportedModels: providerConfig.supportedModels,
    defaultModel: providerConfig.defaultModel,
    enabled: true,
    validateOnSave: false,
  });
  if (createRes.status !== 200 || !createRes.json.ok) {
    throw new Error(`Provider create failed: ${JSON.stringify(createRes.json)}`);
  }
  return createRes.json.data.provider.id;
}

async function setRouting(baseUrl, token, providerId, fallbackProviderIds = []) {
  const result = await apiFetch(baseUrl, token, "PUT", "/v1/model-routing", {
    defaultProviderId: providerId,
    fallbackProviderIds,
  });
  if (result.status !== 200 || !result.json.ok) {
    throw new Error(`Model routing update failed: ${JSON.stringify(result.json)}`);
  }
  return result.json;
}

async function pairSatellite(baseUrl, adminToken, input = {}) {
  const displayName = input.displayName ?? `Closure Satellite ${Date.now()}`;
  const keyPair = createSatelliteKeyPair();
  const register = await apiFetch(baseUrl, adminToken, "POST", "/v1/satellites/register", {
    type: input.type ?? "desktop",
    displayName,
    publicKey: keyPair.publicKey,
    transport: input.transport ?? "ws",
  });
  if (register.status !== 200 || !register.json.ok) {
    throw new Error(`Satellite register failed: ${JSON.stringify(register.json)}`);
  }

  const satelliteId = register.json.data?.satelliteId;
  const challengeNonce = register.json.data?.challengeNonce;
  if (typeof satelliteId !== "string" || typeof challengeNonce !== "string") {
    throw new Error(`Satellite register response missing identifiers: ${JSON.stringify(register.json)}`);
  }

  const approve = await apiFetch(baseUrl, adminToken, "POST", `/v1/satellites/${satelliteId}/pairing/approve`, {
    scopes: input.scopes ?? ["satellite.read", "satellite.write"],
  });
  if (approve.status !== 200 || !approve.json.ok) {
    throw new Error(`Satellite approve failed: ${JSON.stringify(approve.json)}`);
  }
  const satelliteToken = approve.json.data?.token;
  if (typeof satelliteToken !== "string" || satelliteToken.length === 0) {
    throw new Error(`Satellite approve response missing token: ${JSON.stringify(approve.json)}`);
  }

  const handshake = await apiFetch(baseUrl, satelliteToken, "POST", `/v1/satellites/${satelliteId}/handshake`, {
    token: satelliteToken,
    signedChallenge: signSatelliteChallenge(keyPair.privateKey, challengeNonce),
    challengeNonce,
    clientEphemeralPublicKey: "closure-client-ephemeral",
    supportedAlgorithms: ["aes-256-gcm"],
  });
  if (handshake.status !== 200 || !handshake.json.ok) {
    throw new Error(`Satellite handshake failed: ${JSON.stringify(handshake.json)}`);
  }

  const results = {
    register,
    approve,
    handshake,
    satelliteId,
    satelliteToken,
  };

  if (input.capabilities) {
    const capabilities = await apiFetch(baseUrl, satelliteToken, "POST", `/v1/satellites/${satelliteId}/capabilities`, {
      satelliteId,
      revision: 1,
      generatedAt: nowIso(),
      runtime: {
        os: "darwin",
        arch: "arm64",
        appVersion: "0.3.1",
        nodeVersion: process.version,
      },
      capabilities: input.capabilities,
    });
    if (capabilities.status !== 200 || !capabilities.json.ok) {
      throw new Error(`Satellite capabilities update failed: ${JSON.stringify(capabilities.json)}`);
    }
    results.capabilities = capabilities;
  }

  if (input.heartbeat) {
    const heartbeat = await apiFetch(baseUrl, satelliteToken, "POST", `/v1/satellites/${satelliteId}/heartbeat`, {
      ts: nowIso(),
      failureRate1m: input.heartbeat.failureRate1m,
      explicitDisconnect: input.heartbeat.explicitDisconnect,
      queueDepth: 0,
      activeRuns: 0,
      metrics: {
        cpuPercent: 10,
        memoryPercent: 20,
      },
      details: {
        source: input.heartbeat.source ?? "closure-harness",
      },
    });
    if (heartbeat.status !== 200 || !heartbeat.json.ok) {
      throw new Error(`Satellite heartbeat failed: ${JSON.stringify(heartbeat.json)}`);
    }
    results.heartbeat = heartbeat;
  }

  return results;
}

async function startSkillGenerator(baseUrl, token, userId, model) {
  const start = await apiFetch(baseUrl, token, "POST", "/v1/skills/generator/sessions", {
    goal: "Create a shell skill that outputs the current date and time in ISO format as JSON and must include the exact marker \"datetime\" in the runtime output",
    userId,
    channel: "closure",
    requestedModel: model,
  }, { timeoutMs: 300_000 });

  if (start.status !== 200 || !start.json.ok) {
    throw new Error(`Skill generator start failed: ${JSON.stringify(start.json)}`);
  }

  const sessionId = start.json.data.session.sessionId;
  if (start.json.data.mode === "clarification_required") {
    await apiFetch(baseUrl, token, "POST", `/v1/skills/generator/sessions/${sessionId}/messages`, {
      message: "Use the date command. No inputs. Output JSON with a datetime field in ISO 8601 format, and include the exact marker \"datetime\" in the runtime output.",
      requestedModel: model,
    }, { timeoutMs: 300_000 });
  }

  const generation = await apiFetch(baseUrl, token, "POST", `/v1/skills/generator/sessions/${sessionId}/generate`, {
    requestedModel: model,
  }, { timeoutMs: 300_000 });

  if (generation.status !== 200 || !generation.json.ok) {
    throw new Error(`Skill generator generate failed: ${JSON.stringify(generation.json)}`);
  }

  const test = await apiFetch(
    baseUrl,
    token,
    "POST",
    `/v1/skills/generator/sessions/${sessionId}/test`,
    undefined,
    { timeoutMs: 300_000 },
  );
  if (test.status !== 200 || !test.json.ok || !test.json.data?.test?.ok) {
    throw new Error(`Skill generator self-test failed: ${JSON.stringify(test.json)}`);
  }

  const evidence = await apiFetch(
    baseUrl,
    token,
    "GET",
    `/v1/skills/generator/sessions/${sessionId}/evidence`,
    undefined,
    { timeoutMs: 300_000 },
  );
  if (
    evidence.status !== 200
    || !evidence.json.ok
    || !evidence.json.data?.evidence?.validationSummary?.ok
    || !evidence.json.data?.evidence?.approvalReadiness?.ready
  ) {
    throw new Error(`Skill generator evidence is not approval-ready: ${JSON.stringify(evidence.json)}`);
  }

  const approval = await apiFetch(baseUrl, token, "POST", `/v1/skills/generator/sessions/${sessionId}/approve`, undefined, {
    timeoutMs: 300_000,
  });

  if (approval.status !== 200 || !approval.json.ok) {
    throw new Error(`Skill generator approve failed: ${JSON.stringify(approval.json)}`);
  }

  return {
    sessionId,
    draft: generation.json.data?.draft,
    test: test.json.data,
    evidence: evidence.json.data,
    approval: approval.json.data,
  };
}

async function startWorkflowGenerator(baseUrl, token, model) {
  const attemptErrors = [];
  const attemptRecords = [];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const attemptRecord = { attempt };
    const start = await apiFetch(baseUrl, token, "POST", "/v1/workflows/generator/sessions", {
      goal: "A simple manual trigger workflow with one data node that outputs hello world",
      userId: "closure-user",
      channel: "closure",
      requestedModel: model,
    }, { timeoutMs: 300_000 });
    attemptRecord.start = { status: start.status, body: start.json };

    if (start.status !== 200 || !start.json.ok) {
      attemptErrors.push(`attempt ${attempt}: start failed ${JSON.stringify(start.json)}`);
      attemptRecords.push(attemptRecord);
      continue;
    }

    const sessionId = start.json.data.session.sessionId;
    let readyResponse = start;

    if (start.json.data.mode === "clarification_required") {
      const clarification = await apiFetch(baseUrl, token, "POST", `/v1/workflows/generator/sessions/${sessionId}/messages`, {
        message: 'Manual trigger, single data node, output {"message":"hello world"}, no conditions.',
        requestedModel: model,
      }, { timeoutMs: 300_000 });
      attemptRecord.clarification = { status: clarification.status, body: clarification.json };
      if (clarification.status !== 200 || !clarification.json.ok) {
        attemptErrors.push(`attempt ${attempt}: clarification failed ${JSON.stringify(clarification.json)}`);
        await apiFetch(baseUrl, token, "DELETE", `/v1/workflows/generator/sessions/${sessionId}`);
        attemptRecords.push(attemptRecord);
        continue;
      }
      readyResponse = clarification;
    }

    const readyMode = readyResponse.json?.data?.mode;
    const readyStatus = readyResponse.json?.data?.session?.status;

    if (readyMode === "preview_ready" && readyStatus === "ready_for_review") {
      const approval = await apiFetch(baseUrl, token, "POST", `/v1/workflows/generator/sessions/${sessionId}/approve`, undefined, {
        timeoutMs: 300_000,
      });
      attemptRecord.approval = { status: approval.status, body: approval.json };
      attemptRecords.push(attemptRecord);

      if (approval.status !== 200 || !approval.json.ok) {
        attemptErrors.push(`attempt ${attempt}: approve failed ${JSON.stringify(approval.json)}`);
        await apiFetch(baseUrl, token, "DELETE", `/v1/workflows/generator/sessions/${sessionId}`);
        continue;
      }

      return {
        sessionId,
        draft: readyResponse.json.data?.draft,
        approval: approval.json.data,
        attempts: attempt,
        attemptRecords,
      };
    }

    const generation = await apiFetch(baseUrl, token, "POST", `/v1/workflows/generator/sessions/${sessionId}/generate`, {
      requestedModel: model,
    }, { timeoutMs: 300_000 });
    attemptRecord.generate = { status: generation.status, body: generation.json };

    if (generation.status !== 200 || !generation.json.ok) {
      attemptErrors.push(`attempt ${attempt}: generate failed ${JSON.stringify(generation.json)}`);
      await apiFetch(baseUrl, token, "DELETE", `/v1/workflows/generator/sessions/${sessionId}`);
      attemptRecords.push(attemptRecord);
      continue;
    }

    const session = await apiFetch(baseUrl, token, "GET", `/v1/workflows/generator/sessions/${sessionId}`, undefined, {
      timeoutMs: 60_000,
    });
    attemptRecord.session = { status: session.status, body: session.json };
    const sessionStatus = session.json?.data?.session?.status ?? session.json?.session?.status;
    if (session.status !== 200 || !session.json.ok || sessionStatus !== "ready_for_review") {
      attemptErrors.push(`attempt ${attempt}: session status is ${String(sessionStatus ?? "unknown")} after generate`);
      await apiFetch(baseUrl, token, "DELETE", `/v1/workflows/generator/sessions/${sessionId}`);
      attemptRecords.push(attemptRecord);
      continue;
    }

    const approval = await apiFetch(baseUrl, token, "POST", `/v1/workflows/generator/sessions/${sessionId}/approve`, undefined, {
      timeoutMs: 300_000,
    });
    attemptRecord.approval = { status: approval.status, body: approval.json };
    attemptRecords.push(attemptRecord);

    if (approval.status !== 200 || !approval.json.ok) {
      attemptErrors.push(`attempt ${attempt}: approve failed ${JSON.stringify(approval.json)}`);
      await apiFetch(baseUrl, token, "DELETE", `/v1/workflows/generator/sessions/${sessionId}`);
      continue;
    }

    return {
      sessionId,
      draft: generation.json.data?.draft,
      approval: approval.json.data,
      attempts: attempt,
      attemptRecords,
    };
  }

  const error = new Error(`Workflow generator failed after 2 attempts: ${attemptErrors.join(" | ")}`);
  error.closureAttempts = attemptRecords;
  throw error;
}

async function waitForWorkflowRun(baseUrl, token, runId, timeoutMs = 120_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await apiFetch(baseUrl, token, "GET", `/v1/workflow-runs/${runId}`);
    const status = result.json?.data?.run?.status;
    if (["completed", "failed", "cancelled"].includes(status)) {
      return result.json.data.run;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for workflow run ${runId}`);
}

async function createPublishedClosureWorkflow(baseUrl, token, templateId, titlePrefix) {
  const createWorkflow = await apiFetch(baseUrl, token, "POST", "/v1/workflows", {
    slug: `${sanitizeName(titlePrefix)}-${Date.now()}`,
    name: titlePrefix,
    graph: {
      nodes: [{ id: "trigger1", type: "trigger", label: "Trigger", config: { triggerType: "manual" } }],
      edges: [],
    },
  });
  if (createWorkflow.status !== 200 || !createWorkflow.json.ok) {
    throw new Error(`Realtime workflow create failed: ${JSON.stringify(createWorkflow.json)}`);
  }

  const workflowId = createWorkflow.json.data?.workflow?.id;
  const instantiate = await apiFetch(
    baseUrl,
    token,
    "POST",
    `/v1/workflow-builder/templates/${templateId}/instantiate`,
    { workflowId, title: `${titlePrefix} Draft` },
  );
  if (instantiate.status !== 200 || !instantiate.json.ok) {
    throw new Error(`Realtime workflow instantiate failed: ${JSON.stringify(instantiate.json)}`);
  }

  const draftId = instantiate.json?.data?.draft?.draftId ?? instantiate.json?.draft?.draftId;
  const compile = await apiFetch(
    baseUrl,
    token,
    "POST",
    `/v1/workflows/${workflowId}/drafts/${draftId}/compile`,
  );
  if (compile.status !== 200 || !compile.json.ok) {
    throw new Error(`Realtime workflow compile failed: ${JSON.stringify(compile.json)}`);
  }

  const deploy = await apiFetch(
    baseUrl,
    token,
    "POST",
    `/v1/workflows/${workflowId}/drafts/${draftId}/deploy`,
    { includeExport: false, runNow: false },
  );
  if (deploy.status !== 200 || !deploy.json.ok) {
    throw new Error(`Realtime workflow deploy failed: ${JSON.stringify(deploy.json)}`);
  }

  return {
    workflowId,
    workflowVersionId: deploy.json?.data?.version?.id ?? deploy.json?.version?.id,
    createWorkflow: createWorkflow.json,
    instantiate: instantiate.json,
    compile: compile.json,
    deploy: deploy.json,
  };
}

async function runLocalStage(ledger) {
  const stage = "local";
  const installCacheDir = path.join(ledger.paths.state, "npm-cache");
  const installEntry = !SKIP_INSTALL
    ? await runStep(ledger, {
      id: "local.preflight.install",
      stage: `${stage}.preflight`,
      description: "Install workspace dependencies with npm ci using an isolated cache",
    }, async () => {
      ensureDir(installCacheDir);
      const result = await runCommand({
        id: "local.preflight.install",
        stage: `${stage}.preflight`,
        description: "npm ci --include=dev --cache <closure-cache>",
        command: "npm",
        args: ["ci", "--include=dev", "--cache", installCacheDir],
        logPath: path.join(ledger.paths.logs, "local-preflight-install.log"),
        timeoutMs: 900_000,
      });
      if (result.code !== 0) {
        throw new Error(`npm ci failed with code ${String(result.code)}`);
      }

      const requiredArtifacts = [
        "node_modules/.bin/tsc",
        "node_modules/.bin/vite",
        "node_modules/.bin/vitest",
        "node_modules/typescript/package.json",
        "node_modules/vite/package.json",
        "node_modules/vite/bin/vite.js",
        "node_modules/vitest/package.json",
        "node_modules/vitest/suppress-warnings.cjs",
        "node_modules/csstype/index.d.ts",
      ];
      const missingArtifacts = requiredArtifacts.filter((artifact) => !fs.existsSync(path.join(REPO_ROOT, artifact)));
      if (missingArtifacts.length > 0) {
        throw new Error(`npm ci produced an incomplete workspace install: missing ${missingArtifacts.join(", ")}`);
      }

      return {
        evidence: {
          command: result.command,
          logPath: result.logPath,
        },
        details: {
          cacheDir: installCacheDir,
        },
      };
    })
    : null;
  if (installEntry && installEntry.status !== FRIDAY_CLOSURE_STATUSES.PASS) {
    return;
  }

  const buildEntry = await runStep(ledger, {
    id: "local.preflight.build",
    stage: `${stage}.preflight`,
    description: "Build Friday for CLI and HTTP operation",
  }, async () => {
    const result = await runCommand({
      id: "local.preflight.build",
      stage: `${stage}.preflight`,
      description: "npm run build",
      command: "npm",
      args: ["run", "build"],
      logPath: path.join(ledger.paths.logs, "local-preflight-build.log"),
      timeoutMs: 900_000,
    });
    if (result.code !== 0) {
      throw new Error(`npm run build failed with code ${String(result.code)}`);
    }
    return {
      evidence: {
        command: result.command,
        logPath: result.logPath,
      },
      details: installEntry ? { installCompleted: true } : {},
    };
  });
  if (buildEntry.status !== FRIDAY_CLOSURE_STATUSES.PASS) {
    return;
  }

  makeScratchWorkflowSkill(path.join(ledger.paths.skills, "closure-workflow-template"));

  const port = await findFreePort();
  const fridayEnv = buildClosureScratchEnv(process.env, ledger.paths);
  const serverLogPath = path.join(ledger.paths.logs, "local-friday-server.log");
  const server = spawn(process.execPath, [
    DIST_CLI,
    "start",
    "--host",
    DEFAULT_HOST,
    "--port",
    String(port),
    "--skills-dir",
    path.join(REPO_ROOT, "managed-skills"),
    "--skills-dir",
    ledger.paths.skills,
  ], {
    cwd: REPO_ROOT,
    env: fridayEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverLogStream = fs.createWriteStream(serverLogPath, { flags: "w" });
  const cleanupRegistry = createCleanupRegistry();
  cleanupRegistry.add(async () => {
    await closeWritableStream(serverLogStream, 5_000);
  });
  cleanupRegistry.add(async () => {
    await stopManagedChildProcess(server, { graceMs: 5_000, forceKillMs: 2_000 });
  });
  server.stdout.on("data", (chunk) => serverLogStream.write(chunk));
  server.stderr.on("data", (chunk) => serverLogStream.write(chunk));

  const baseUrl = `http://${DEFAULT_HOST}:${String(port)}`;
  let token = "";
  let principalUserId = "";
  let modelProviderId = "";
  let workflowGeneratorResult = null;
  const closureProvider = resolveClosureProviderConfig(process.env);

  try {
    await runStep(ledger, {
      id: "local.runtime.health",
      stage: `${stage}.runtime`,
      description: "Boot Friday via CLI and wait for health",
    }, async () => {
      const body = await waitForHealth(baseUrl, path.join(ledger.paths.responses, "local-runtime-health.json"));
      return {
        evidence: {
          responsePath: path.join(ledger.paths.responses, "local-runtime-health.json"),
          serverLogPath,
        },
        details: {
          version: body?.data?.version ?? null,
          uptime: body?.data?.uptime ?? null,
        },
      };
    });

    await runStep(ledger, {
      id: "local.auth.login",
      stage: `${stage}.auth`,
      description: "Login to the local Friday instance with dev auth",
    }, async () => {
      const login = await loginLocal(baseUrl);
      token = login.accessToken;
      principalUserId = typeof login.user?.id === "string" ? login.user.id : "";
      if (principalUserId.length === 0) {
        throw new Error(`Local login did not return a user id: ${JSON.stringify(login)}`);
      }
      const responsePath = writeResponseEvidence(ledger.paths, "local-auth-login", login);
      return {
        evidence: { responsePath },
      };
    });

    await runStep(ledger, {
      id: "local.cli.inventory",
      stage: `${stage}.cli`,
      description: "Exercise friday list and friday converters",
    }, async () => {
      const listResult = await runCommand({
        id: "local.cli.list",
        stage: `${stage}.cli`,
        description: "friday list",
        command: process.execPath,
        args: [DIST_CLI, "list", "--skills-dir", path.join(REPO_ROOT, "managed-skills"), "--skills-dir", ledger.paths.skills],
        logPath: path.join(ledger.paths.logs, "local-cli-list.log"),
        env: fridayEnv,
        timeoutMs: 30_000,
      });
      const convertersResult = await runCommand({
        id: "local.cli.converters",
        stage: `${stage}.cli`,
        description: "friday converters",
        command: process.execPath,
        args: [DIST_CLI, "converters"],
        logPath: path.join(ledger.paths.logs, "local-cli-converters.log"),
        env: fridayEnv,
        timeoutMs: 30_000,
      });
      const failures = [listResult, convertersResult].filter((result) => result.code !== 0);
      if (failures.length > 0) {
        throw new Error(failures.map(describeCommandFailure).join("; "));
      }
      return {
        evidence: {
          listLogPath: listResult.logPath,
          convertersLogPath: convertersResult.logPath,
        },
      };
    });

    await runStep(ledger, {
      id: "local.providers.detect",
      stage: `${stage}.providers`,
      description: "Detect model provider credentials through the public provider detect route",
    }, async () => {
      if (!closureProvider.available) {
        return {
          status: FRIDAY_CLOSURE_STATUSES.BLOCKER,
          details: { reason: closureProvider.blockerReason },
        };
      }
      const result = await apiFetch(baseUrl, token, "POST", "/v1/providers/detect", {
        kind: closureProvider.kind,
        apiKey: closureProvider.apiKey,
        baseUrl: closureProvider.baseUrl,
      });
      const responsePath = writeResponseEvidence(ledger.paths, "local-providers-detect", result);
      if (result.status !== 200 || !result.json.ok) {
        throw new Error(`${closureProvider.kind} detect failed: ${JSON.stringify(result.json)}`);
      }
      return {
        evidence: { responsePath },
        details: {
          kind: closureProvider.kind,
          envVar: closureProvider.envVar,
          defaultModel: result.json.data?.defaultModel ?? null,
          validated: result.json.data?.validated ?? null,
        },
      };
    });

    await runStep(ledger, {
      id: "local.providers.lifecycle",
      stage: `${stage}.providers`,
      description: "Create, validate, route, and budget a model provider",
    }, async () => {
      if (!closureProvider.available) {
        return {
          status: FRIDAY_CLOSURE_STATUSES.BLOCKER,
          details: { reason: closureProvider.blockerReason },
        };
      }
      modelProviderId = await createClosureProvider(baseUrl, token, closureProvider);
      const validateResult = await apiFetch(baseUrl, token, "POST", `/v1/providers/${modelProviderId}/validate`);
      const budgetSet = await apiFetch(baseUrl, token, "PUT", "/v1/providers/budget", {
        monthlyLimitUsd: 25,
      });
      const budgetGet = await apiFetch(baseUrl, token, "GET", "/v1/providers/budget");
      const usageGet = await apiFetch(baseUrl, token, "GET", "/v1/providers/usage");
      const routing = await setRouting(baseUrl, token, modelProviderId);
      const responsePath = writeResponseEvidence(ledger.paths, "local-providers-lifecycle", {
        providerId: modelProviderId,
        providerKind: closureProvider.kind,
        providerEnvVar: closureProvider.envVar,
        validateResult,
        budgetSet,
        budgetGet,
        usageGet,
        routing,
      });
      if (validateResult.status !== 200 || !validateResult.json.ok) {
        throw new Error(`Provider validate failed: ${JSON.stringify(validateResult.json)}`);
      }
      if (validateResult.json.data?.validation?.status !== "ok") {
        throw new Error(`Provider validation status is ${String(validateResult.json.data?.validation?.status ?? "missing")}: ${JSON.stringify(validateResult.json.data?.validation)}`);
      }
      if (budgetSet.status !== 200 || !budgetSet.json.ok) {
        throw new Error(`Budget set failed: ${JSON.stringify(budgetSet.json)}`);
      }
      return {
        evidence: { responsePath },
        details: {
          providerId: modelProviderId,
          kind: closureProvider.kind,
          defaultModel: closureProvider.defaultModel,
          generationModel: closureProvider.generationModel,
          agentModel: closureProvider.agentModel,
        },
      };
    });

    await runStep(ledger, {
      id: "local.cli.convert-import-pack-run",
      stage: `${stage}.cli`,
      description: "Exercise friday convert/import/pack/run through the compiled CLI",
    }, async () => {
      const convertOut = path.join(ledger.paths.exports, "converted-skills");
      const packedSkill = path.join(ledger.paths.exports, "output-current-date-time.friday.tgz");
      const importTarget = path.join(ledger.paths.skills, "imported");
      const converterFixturePath = writeClosureConverterFixture(ledger.paths);
      ensureDir(convertOut);
      ensureDir(importTarget);

      const convert = await runCommand({
        id: "local.cli.convert",
        stage: `${stage}.cli`,
        description: "friday convert",
        command: process.execPath,
        args: [
          DIST_CLI,
          "convert",
          converterFixturePath,
          "--out",
          convertOut,
        ],
        logPath: path.join(ledger.paths.logs, "local-cli-convert.log"),
        env: fridayEnv,
        timeoutMs: 30_000,
      });
      const pack = await runCommand({
        id: "local.cli.pack",
        stage: `${stage}.cli`,
        description: "friday pack",
        command: process.execPath,
        args: [
          DIST_CLI,
          "pack",
          path.join(REPO_ROOT, "managed-skills", "output-current-date-time"),
          "--out",
          packedSkill,
        ],
        logPath: path.join(ledger.paths.logs, "local-cli-pack.log"),
        env: fridayEnv,
        timeoutMs: 30_000,
      });
      const importRun = await runCommand({
        id: "local.cli.import",
        stage: `${stage}.cli`,
        description: "friday import",
        command: process.execPath,
        args: [
          DIST_CLI,
          "import",
          packedSkill,
          "--target",
          importTarget,
          "--no-refresh",
        ],
        logPath: path.join(ledger.paths.logs, "local-cli-import.log"),
        env: fridayEnv,
        timeoutMs: 30_000,
      });
      const runSkill = await runCommand({
        id: "local.cli.run",
        stage: `${stage}.cli`,
        description: "friday run output-current-date-time",
        command: process.execPath,
        args: [
          DIST_CLI,
          "run",
          "output-current-date-time",
          "--skills-dir",
          path.join(REPO_ROOT, "managed-skills"),
          "--skills-dir",
          importTarget,
        ],
        logPath: path.join(ledger.paths.logs, "local-cli-run.log"),
        env: fridayEnv,
        timeoutMs: 30_000,
      });

      for (const result of [convert, pack, importRun, runSkill]) {
        if (result.code !== 0) {
          throw new Error(describeCommandFailure(result));
        }
      }

      return {
        evidence: {
          convertLogPath: convert.logPath,
          packLogPath: pack.logPath,
          importLogPath: importRun.logPath,
          runLogPath: runSkill.logPath,
          packedSkill,
        },
      };
    });

    await runStep(ledger, {
      id: "local.uix.templates",
      stage: `${stage}.uix`,
      description: "List and execute every assistant template plus the guided wizard",
    }, async () => {
      const templates = await apiFetch(baseUrl, token, "GET", "/v1/uix/templates");
      if (templates.status !== 200 || !templates.json.ok) {
        throw new Error(`Template list failed: ${JSON.stringify(templates.json)}`);
      }

      const templateIds = templates.json.data.templates.map((template) => template.id);
      const expected = [
        "generate-skill",
        "generate-workflow",
        "deploy-workflow",
        "export-workflow-bundle",
        "recover-failed-deploy",
        "review-issues",
        "ask-for-help",
      ];
      for (const templateId of expected) {
        if (!templateIds.includes(templateId)) {
          throw new Error(`Missing template ${templateId}`);
        }
      }

      const executions = {};
      executions["ask-for-help"] = await apiFetch(baseUrl, token, "POST", "/v1/uix/templates/ask-for-help/execute", {
        parameters: {},
      });
      executions["review-issues"] = await apiFetch(baseUrl, token, "POST", "/v1/uix/templates/review-issues/execute", {
        parameters: {},
      });
      executions["recover-failed-deploy"] = await apiFetch(baseUrl, token, "POST", "/v1/uix/templates/recover-failed-deploy/execute", {
        parameters: {},
      });
      executions["generate-skill"] = await apiFetch(baseUrl, token, "POST", "/v1/uix/templates/generate-skill/execute", {
        parameters: {
          goal: "Create a shell skill that returns the current date and time as JSON.",
        },
      }, { timeoutMs: 300_000 });
      executions["generate-workflow"] = await apiFetch(baseUrl, token, "POST", "/v1/uix/templates/generate-workflow/execute", {
        parameters: {
          goal: "Create a workflow that emits hello world from a manual trigger.",
        },
      }, { timeoutMs: 300_000 });

      const wizardStart = await apiFetch(baseUrl, token, "POST", "/v1/uix/wizards/guided-assistant/start", {});
      if (wizardStart.status !== 200 || !wizardStart.json.ok) {
        throw new Error(`Wizard start failed: ${JSON.stringify(wizardStart.json)}`);
      }
      const contextId = wizardStart.json.data.wizard.contextId;
      const wizardContinue = await apiFetch(baseUrl, token, "POST", "/v1/uix/wizards/guided-assistant/continue", {
        contextId,
        values: { goal: "Help me create a skill that prints hello world." },
      }, { timeoutMs: 300_000 });

      const responsePath = writeResponseEvidence(ledger.paths, "local-uix-templates", {
        templates: templates.json,
        executions,
        wizardStart: wizardStart.json,
        wizardContinue: wizardContinue.json,
      });

      for (const [templateId, result] of Object.entries(executions)) {
        if (result.status !== 200 || !result.json.ok) {
          throw new Error(`Template ${templateId} failed: ${JSON.stringify(result.json)}`);
        }
      }

      return {
        evidence: { responsePath },
      };
    });

    await runStep(ledger, {
      id: "local.skills.generator",
      stage: `${stage}.skills`,
      description: "Generate, approve, and persist a skill through Friday's public generator API",
    }, async () => {
      const result = await startSkillGenerator(baseUrl, token, principalUserId, closureProvider.generationModel);
      const responsePath = writeResponseEvidence(ledger.paths, "local-skills-generator", result);
      return {
        evidence: { responsePath },
        details: {
          skillId: result.approval?.skillId ?? null,
        },
      };
    });

    await runStep(ledger, {
      id: "local.workflows.generator",
      stage: `${stage}.workflows`,
      description: "Generate, approve, and run a workflow through Friday's public workflow generator API",
    }, async () => {
      try {
        workflowGeneratorResult = await startWorkflowGenerator(baseUrl, token, closureProvider.generationModel);
      } catch (error) {
        const responsePath = writeResponseEvidence(ledger.paths, "local-workflows-generator-failure", {
          attempts: error?.closureAttempts ?? [],
          error: error instanceof Error ? error.message : String(error),
        });
        if (error instanceof Error) {
          error.message = `${error.message} (evidence: ${responsePath})`;
        }
        throw error;
      }
      const runTrigger = await apiFetch(baseUrl, token, "POST", "/v1/workflow-runs", {
        workflowId: workflowGeneratorResult.approval.workflowId,
        triggerType: "manual",
        triggerPayload: {},
      });
      if (runTrigger.status !== 200 || !runTrigger.json.ok) {
        throw new Error(`Workflow run trigger failed: ${JSON.stringify(runTrigger.json)}`);
      }
      const run = await waitForWorkflowRun(baseUrl, token, runTrigger.json.data.run.id);
      const responsePath = writeResponseEvidence(ledger.paths, "local-workflows-generator", {
        workflowGeneratorResult,
        runTrigger: runTrigger.json,
        run,
      });
      return {
        evidence: { responsePath },
        details: {
          workflowId: workflowGeneratorResult.approval.workflowId,
          runStatus: run.status,
        },
      };
    });

    await runStep(ledger, {
      id: "local.uix.deploy-export",
      stage: `${stage}.uix`,
      description: "Drive deploy/export workflow templates using the generated workflow session",
    }, async () => {
      if (!workflowGeneratorResult?.sessionId) {
        return {
          status: FRIDAY_CLOSURE_STATUSES.BLOCKER,
          details: {
            reason: "No generated workflow session is available for deploy/export template execution",
          },
        };
      }
      const deploy = await apiFetch(baseUrl, token, "POST", "/v1/uix/templates/deploy-workflow/execute", {
        parameters: {
          sessionId: workflowGeneratorResult.sessionId,
          runNow: true,
        },
      }, { timeoutMs: 300_000 });
      const exportBundle = await apiFetch(baseUrl, token, "POST", "/v1/uix/templates/export-workflow-bundle/execute", {
        parameters: {
          sessionId: workflowGeneratorResult.sessionId,
        },
      }, { timeoutMs: 300_000 });
      const responsePath = writeResponseEvidence(ledger.paths, "local-uix-deploy-export", {
        deploy: deploy.json,
        exportBundle: exportBundle.json,
      });
      if (deploy.status !== 200 || !deploy.json.ok) {
        throw new Error(`deploy-workflow template failed: ${JSON.stringify(deploy.json)}`);
      }
      if (exportBundle.status !== 200 || !exportBundle.json.ok) {
        throw new Error(`export-workflow-bundle template failed: ${JSON.stringify(exportBundle.json)}`);
      }
      return {
        evidence: { responsePath },
      };
    });

    await runStep(ledger, {
      id: "local.sessions-agent-memory",
      stage: `${stage}.agent`,
      description: "Exercise sessions, agent runs, memory store/search, and automations",
    }, async () => {
      const sessionCreate = await apiFetch(baseUrl, token, "POST", "/v1/sessions", {
        channel: "closure",
        chatId: `closure-chat-${Date.now()}`,
      });
      if (sessionCreate.status !== 200 || !sessionCreate.json.ok) {
        throw new Error(`Session create failed: ${JSON.stringify(sessionCreate.json)}`);
      }
      const sessionKey = sessionCreate.json.data.session.key;
      await apiFetch(baseUrl, token, "POST", `/v1/sessions/${encodeURIComponent(sessionKey)}/messages`, {
        role: "user",
        content: "Remember that my favorite color is teal.",
      });
      const run = await apiFetch(baseUrl, token, "POST", "/v1/agent/runs", {
        task: "Tell me 3 concise facts about octopuses.",
        providerId: modelProviderId,
        model: closureProvider.agentModel,
        timeoutMs: 90_000,
      }, { timeoutMs: 180_000 });
      if (run.status !== 200 || !run.json.ok) {
        throw new Error(`Agent run failed: ${JSON.stringify(run.json)}`);
      }
      const agentRunResult = inspectAgentClosureResult(run.json, { label: "agentRun" });
      const sessionNamespaceResponse = await apiFetch(
        baseUrl,
        token,
        "GET",
        `/v1/sessions/${encodeURIComponent(sessionKey)}/memory-namespace`,
      );
      if (sessionNamespaceResponse.status !== 200 || !sessionNamespaceResponse.json.ok) {
        throw new Error(
          `Session memory namespace failed: ${JSON.stringify(sessionNamespaceResponse.json)}`,
        );
      }
      const sessionMemoryNamespace = getFirstNonEmptyString(sessionNamespaceResponse.json, [
        ["data", "namespace"],
        ["namespace"],
      ]);
      if (!sessionMemoryNamespace) {
        throw new Error("Session memory namespace response did not include a namespace");
      }
      const store = await apiFetch(baseUrl, token, "POST", "/v1/memory/store", {
        namespace: "closure-agent",
        content: `Agent response: ${run.json.data.response ?? ""}`,
        source: "closure-run",
        tags: ["closure", "agent"],
      });
      const search = await apiFetch(baseUrl, token, "POST", "/v1/memory/search", {
        namespace: "closure-agent",
        query: "Agent response",
      });
      const automationCreate = await apiFetch(baseUrl, token, "POST", "/v1/agent/automations", {
        name: "Closure Automation",
        description: "Closure automation smoke",
        taskTemplate: "Say exactly CLOSURE_AUTOMATION_OK",
        enabled: true,
      });
      if (automationCreate.status !== 200 || !automationCreate.json.ok) {
        throw new Error(`Automation create failed: ${JSON.stringify(automationCreate.json)}`);
      }
      const automationId = automationCreate.json.data.automation.id;
      const automationRun = await apiFetch(baseUrl, token, "POST", `/v1/agent/automations/${automationId}/run`, {
        providerId: modelProviderId,
        model: closureProvider.agentModel,
        timeoutMs: 90_000,
      }, { timeoutMs: 180_000 });
      const automationDisable = await apiFetch(baseUrl, token, "PATCH", `/v1/agent/automations/${automationId}`, {
        enabled: false,
      });
      const automationEnable = await apiFetch(baseUrl, token, "PATCH", `/v1/agent/automations/${automationId}`, {
        enabled: true,
      });
      const automationDelete = await apiFetch(baseUrl, token, "DELETE", `/v1/agent/automations/${automationId}`);
      const responsePath = writeResponseEvidence(ledger.paths, "local-sessions-agent-memory", {
        sessionCreate: sessionCreate.json,
        agentRun: run.json,
        sessionMemoryNamespace: sessionNamespaceResponse.json,
        memoryStore: store.json,
        memorySearch: search.json,
        automationCreate: automationCreate.json,
        automationRun: automationRun.json,
        automationDisable: automationDisable.json,
        automationEnable: automationEnable.json,
        automationDelete: automationDelete.json,
      });
      if (store.status !== 200 || !store.json.ok) {
        throw new Error(`Memory store failed: ${JSON.stringify(store.json)}`);
      }
      if (search.status !== 200 || !search.json.ok) {
        throw new Error(`Memory search failed: ${JSON.stringify(search.json)}`);
      }
      if (automationRun.status !== 200 || !automationRun.json.ok) {
        throw new Error(`Automation run failed: ${JSON.stringify(automationRun.json)}`);
      }
      const automationResult = inspectAgentClosureResult(automationRun.json, {
        label: "automationRun",
        expectedText: "CLOSURE_AUTOMATION_OK",
      });
      const closureFailures = [
        ...agentRunResult.closureFailures,
        ...automationResult.closureFailures,
      ];
      if (!getFirstNonEmptyString(store.json, [["data", "item", "id"]])) {
        closureFailures.push("memoryStore.item.id=missing");
      }
      if (getFirstArray(search.json, [["data", "items"]]).length === 0) {
        closureFailures.push("memorySearch.items=0");
      }
      return {
        ...(closureFailures.length > 0 ? { status: FRIDAY_CLOSURE_STATUSES.FAIL } : {}),
        evidence: { responsePath },
        details: {
          sessionKey,
          automationId,
          runStatus: agentRunResult.status,
          automationStatus: automationResult.status,
          closureFailures,
        },
      };
    });

    await runStep(ledger, {
      id: "local.realtime",
      stage: `${stage}.realtime`,
      description: "Subscribe, pull, and ack realtime events for a concrete run stream",
    }, async () => {
      const workflow = await createPublishedClosureWorkflow(
        baseUrl,
        token,
        "builtin-blank",
        "Closure Realtime Workflow",
      );
      const run = await apiFetch(baseUrl, token, "POST", "/v1/workflow-runs", {
        workflowId: workflow.workflowId,
        ...(workflow.workflowVersionId ? { workflowVersionId: workflow.workflowVersionId } : {}),
        triggerType: "manual",
        triggerPayload: {},
      });
      if (run.status !== 200 || !run.json.ok || !run.json.data?.run?.id) {
        throw new Error(`Realtime setup workflow run failed: ${JSON.stringify(run.json)}`);
      }
      const workflowRun = await waitForWorkflowRun(baseUrl, token, run.json.data.run.id);
      const streamId = `run:${workflowRun.id}`;
      const subscribe = await apiFetch(baseUrl, token, "POST", "/v1/realtime/subscriptions", {
        subscriptions: [{
          subscriptionId: `closure-realtime-${workflowRun.id}`,
          streamId,
          topic: "workflow.run",
        }],
      });
      const pull = await apiFetch(baseUrl, token, "POST", "/v1/realtime/pull", {
        streamId,
        afterSeq: 0,
        limit: 25,
      });
      const ackSeq = pull.json?.data?.items?.[0]?.seq ?? 0;
      const epoch = pull.json?.data?.epoch ?? 0;
      const ack = await apiFetch(baseUrl, token, "POST", "/v1/realtime/ack", {
        streamId,
        seq: ackSeq,
        epoch,
      });
      const responsePath = writeResponseEvidence(ledger.paths, "local-realtime", {
        workflow,
        run: run.json,
        workflowRun,
        subscribe: subscribe.json,
        pull: pull.json,
        ack: ack.json,
      });
      if (subscribe.status !== 200 || !subscribe.json.ok) {
        throw new Error(`Realtime subscribe failed: ${JSON.stringify(subscribe.json)}`);
      }
      if (pull.status !== 200 || !pull.json.ok) {
        throw new Error(`Realtime pull failed: ${JSON.stringify(pull.json)}`);
      }
      if (ack.status !== 200 || !ack.json.ok) {
        throw new Error(`Realtime ack failed: ${JSON.stringify(ack.json)}`);
      }
      const closureFailures = [];
      if (workflowRun.status !== "completed") {
        closureFailures.push(`workflowRun.status=${workflowRun.status ?? "missing"}`);
      }
      if (getFirstArray(subscribe.json, [["data", "subscriptions"]]).length === 0) {
        closureFailures.push("realtimeSubscribe.subscriptions=0");
      }
      if (getFirstArray(pull.json, [["data", "items"]]).length === 0) {
        closureFailures.push("realtimePull.items=0");
      }
      return {
        ...(closureFailures.length > 0 ? { status: FRIDAY_CLOSURE_STATUSES.FAIL } : {}),
        evidence: { responsePath },
        details: {
          workflowId: workflow.workflowId,
          runStatus: workflowRun.status,
          closureFailures,
        },
      };
    });

    await runStep(ledger, {
      id: "local.workflows.builder-templates",
      stage: `${stage}.workflows`,
      description: "List, inspect, instantiate, compile, and deploy workflow builder templates",
    }, async () => {
      const templates = await apiFetch(baseUrl, token, "GET", "/v1/workflow-builder/templates");
      if (templates.status !== 200 || !templates.json.ok) {
        throw new Error(`Workflow builder template list failed: ${JSON.stringify(templates.json)}`);
      }
      const items = templates.json?.data?.items ?? templates.json?.items ?? [];
      const requiredTemplateIds = [
        "builtin-blank",
        "builtin-simple-action",
        "builtin-conditional",
        "skill-closure-workflow-template",
      ];
      for (const templateId of requiredTemplateIds) {
        if (!items.some((item) => item.templateId === templateId)) {
          throw new Error(`Missing workflow builder template "${templateId}"`);
        }
      }

      const results = {};
      for (const templateId of requiredTemplateIds) {
        const detail = await apiFetch(baseUrl, token, "GET", `/v1/workflow-builder/templates/${templateId}`);
        if (detail.status !== 200 || !detail.json.ok) {
          throw new Error(`Workflow builder template detail failed for ${templateId}: ${JSON.stringify(detail.json)}`);
        }
        const createWorkflow = await apiFetch(baseUrl, token, "POST", "/v1/workflows", {
          slug: `${sanitizeName(templateId)}-${Date.now()}`,
          name: `Closure ${templateId}`,
          graph: {
            nodes: [{ id: "trigger1", type: "trigger", label: "Trigger", config: { triggerType: "manual" } }],
            edges: [],
          },
        });
        if (createWorkflow.status !== 200 || !createWorkflow.json.ok) {
          throw new Error(`Workflow create failed for ${templateId}: ${JSON.stringify(createWorkflow.json)}`);
        }
        const workflowId = createWorkflow.json.data?.workflow?.id;
        const instantiate = await apiFetch(
          baseUrl,
          token,
          "POST",
          `/v1/workflow-builder/templates/${templateId}/instantiate`,
          { workflowId, title: `Instantiated ${templateId}` },
        );
        if (instantiate.status !== 200 || !instantiate.json.ok) {
          throw new Error(`Template instantiate failed for ${templateId}: ${JSON.stringify(instantiate.json)}`);
        }
        const draftId = instantiate.json?.data?.draft?.draftId ?? instantiate.json?.draft?.draftId;
        const compile = await apiFetch(
          baseUrl,
          token,
          "POST",
          `/v1/workflows/${workflowId}/drafts/${draftId}/compile`,
        );
        if (compile.status !== 200 || !compile.json.ok) {
          throw new Error(`Template compile failed for ${templateId}: ${JSON.stringify(compile.json)}`);
        }
        const deploy = await apiFetch(
          baseUrl,
          token,
          "POST",
          `/v1/workflows/${workflowId}/drafts/${draftId}/deploy`,
          { includeExport: true, runNow: false },
        );
        if (deploy.status !== 200 || !deploy.json.ok) {
          throw new Error(`Template deploy failed for ${templateId}: ${JSON.stringify(deploy.json)}`);
        }
        results[templateId] = {
          detail: detail.json,
          createWorkflow: createWorkflow.json,
          instantiate: instantiate.json,
          compile: compile.json,
          deploy: deploy.json,
        };
      }

      const responsePath = writeResponseEvidence(ledger.paths, "local-workflow-builder-templates", results);
      return {
        evidence: { responsePath },
        details: { templateCount: items.length },
      };
    });

    await runStep(ledger, {
      id: "local.plugins.lifecycle",
      stage: `${stage}.plugins`,
      description: "Install, enable, disable, and uninstall a local plugin through public plugin routes",
    }, async () => {
      const pluginRoot = path.join(ledger.paths.artifacts, "closure-plugin");
      const manifest = makeScratchPlugin(pluginRoot);
      const install = await apiFetch(baseUrl, token, "POST", `/v1/plugins/${manifest.id}/install`, {
        installPath: pluginRoot,
        userApproved: true,
      });
      const enable = await apiFetch(baseUrl, token, "POST", `/v1/plugins/${manifest.id}/enable`, {});
      const disable = await apiFetch(baseUrl, token, "POST", `/v1/plugins/${manifest.id}/disable`, {});
      const uninstall = await apiFetch(baseUrl, token, "DELETE", `/v1/plugins/${manifest.id}`);
      const marketplaceSearch = await apiFetch(baseUrl, token, "GET", "/v1/marketplace/plugins");
      const responsePath = writeResponseEvidence(ledger.paths, "local-plugins-lifecycle", {
        install: install.json,
        enable: enable.json,
        disable: disable.json,
        uninstall: uninstall.json,
        marketplaceSearch: marketplaceSearch.json,
      });
      if (install.status !== 200 || !install.json.ok) {
        throw new Error(`Plugin install failed: ${JSON.stringify(install.json)}`);
      }
      if (enable.status !== 200 || !enable.json.ok) {
        throw new Error(`Plugin enable failed: ${JSON.stringify(enable.json)}`);
      }
      if (disable.status !== 200 || !disable.json.ok) {
        throw new Error(`Plugin disable failed: ${JSON.stringify(disable.json)}`);
      }
      if (uninstall.status !== 200 || !uninstall.json.ok) {
        throw new Error(`Plugin uninstall failed: ${JSON.stringify(uninstall.json)}`);
      }
      return {
        evidence: { responsePath },
      };
    });

    await runStep(ledger, {
      id: "local.marketplace.requests",
      stage: `${stage}.marketplace`,
      description: "Exercise marketplace request board and catalog read surfaces",
    }, async () => {
      const requestCreate = await apiFetch(baseUrl, token, "POST", "/v1/marketplace/requests", {
        assetKind: "skill",
        title: "Need a shell skill",
        goal: "Create a shell skill that echoes hello",
        desiredOutcome: "Installable skill package",
        constraints: ["Use shell only"],
        budgetSupportIntent: "tip-if-useful",
        privacy: "public",
        publishability: "private_only",
      });
      if (requestCreate.status !== 200 || !requestCreate.json.ok) {
        throw new Error(`Marketplace request create failed: ${JSON.stringify(requestCreate.json)}`);
      }
      const requestId = requestCreate.json.data.request.id;
      const responseCreate = await apiFetch(baseUrl, token, "POST", `/v1/marketplace/requests/${requestId}/responses`, {
        message: "I can deliver this skill.",
      });
      const accept = await apiFetch(baseUrl, token, "POST", `/v1/marketplace/requests/${requestId}/accept`, {
        responseId: responseCreate.json?.data?.responses?.[0]?.id ?? responseCreate.json?.data?.response?.id ?? responseCreate.json?.data?.responses?.at?.(0)?.id,
      });
      const close = await apiFetch(baseUrl, token, "POST", `/v1/marketplace/requests/${requestId}/close`, {});
      const list = await apiFetch(baseUrl, token, "GET", "/v1/marketplace/requests");
      const assets = await apiFetch(baseUrl, token, "GET", "/v1/marketplace/assets");
      const creators = await apiFetch(baseUrl, token, "GET", "/v1/marketplace/creators");
      const responsePath = writeResponseEvidence(ledger.paths, "local-marketplace-requests", {
        requestCreate: requestCreate.json,
        responseCreate: responseCreate.json,
        accept: accept.json,
        close: close.json,
        list: list.json,
        assets: assets.json,
        creators: creators.json,
      });
      if (responseCreate.status !== 200 || !responseCreate.json.ok) {
        throw new Error(`Marketplace request response failed: ${JSON.stringify(responseCreate.json)}`);
      }
      if (accept.status !== 200 || !accept.json.ok) {
        throw new Error(`Marketplace accept failed: ${JSON.stringify(accept.json)}`);
      }
      if (close.status !== 200 || !close.json.ok) {
        throw new Error(`Marketplace close failed: ${JSON.stringify(close.json)}`);
      }
      return {
        evidence: { responsePath },
        details: {
          assetCount: assets.json?.data?.items?.length ?? assets.json?.items?.length ?? 0,
          creatorCount: creators.json?.data?.items?.length ?? creators.json?.items?.length ?? 0,
        },
      };
    });

    await runStep(ledger, {
      id: "local.marketplace.support",
      stage: `${stage}.marketplace`,
      description: "Seed a public marketplace asset and record creator support through public routes",
    }, async () => {
      const publisher = await apiFetch(baseUrl, token, "POST", "/v1/marketplace/publishers", {
        displayName: "Closure Publisher",
        contactEmail: "closure@example.com",
      });
      if (publisher.status !== 200 || !publisher.json.ok) {
        throw new Error(`Marketplace publisher create failed: ${JSON.stringify(publisher.json)}`);
      }
      const publisherId = publisher.json?.data?.publisher?.id ?? publisher.json?.publisher?.id;
      const verification = await apiFetch(baseUrl, token, "POST", `/v1/marketplace/publishers/${publisherId}/verification`, {
        legalName: "Closure Publisher LLC",
        taxId: "TAX-123",
        country: "US",
        payoutMethod: "stripe",
      });
      const verificationReview = await apiFetch(baseUrl, token, "POST", `/v1/marketplace/publishers/${publisherId}/verification/review`, {
        decision: "verified",
      });
      const listing = await apiFetch(baseUrl, token, "POST", "/v1/marketplace/listings", {
        publisherId,
        slug: `closure-support-${Date.now()}`,
        assetType: "workflow",
        title: "Closure Support Asset",
        description: "Closure support asset",
        packageName: "closure.support.asset",
        packageVersion: "1.0.0",
        pricingPlan: { type: "free" },
      });
      if (listing.status !== 200 || !listing.json.ok) {
        throw new Error(`Marketplace listing create failed: ${JSON.stringify(listing.json)}`);
      }
      const listingId = listing.json?.data?.listing?.id ?? listing.json?.listing?.id;
      const versionId = listing.json?.data?.version?.id ?? listing.json?.version?.id;
      const submitForReview = await apiFetch(baseUrl, token, "POST", `/v1/marketplace/listings/${listingId}/submit-for-review`, {
        versionId,
      });
      const listingReview = await apiFetch(baseUrl, token, "POST", `/v1/marketplace/listings/${listingId}/review`, {
        versionId,
        decision: "approved",
      });
      const assets = await apiFetch(baseUrl, token, "GET", "/v1/marketplace/assets");
      if (assets.status !== 200 || !assets.json.ok) {
        throw new Error(`Marketplace assets list failed: ${JSON.stringify(assets.json)}`);
      }
      const items = assets.json?.data?.items ?? assets.json?.items ?? [];
      const asset = Array.isArray(items)
        ? items.find((item) => item.listingId === listingId || item.slug === listing.json?.data?.listing?.slug)
        : null;
      const assetId = asset?.assetId ?? asset?.id;
      if (!assetId) {
        throw new Error(`Marketplace asset seed did not produce a public asset: ${JSON.stringify(assets.json)}`);
      }
      const support = await apiFetch(baseUrl, token, "POST", `/v1/marketplace/assets/${assetId}/support`, {
        amount: { amount: 500, currency: "USD" },
        message: "Closure support smoke test",
      });
      if (support.status !== 200 || !support.json.ok) {
        throw new Error(`Marketplace support failed: ${JSON.stringify(support.json)}`);
      }
      const responsePath = writeResponseEvidence(ledger.paths, "local-marketplace-support", {
        publisher: publisher.json,
        verification: verification.json,
        verificationReview: verificationReview.json,
        listing: listing.json,
        submitForReview: submitForReview.json,
        listingReview: listingReview.json,
        assets: assets.json,
        support: support.json,
      });
      return {
        evidence: { responsePath },
        details: { assetId, publisherId, listingId },
      };
    });

    await runStep(ledger, {
      id: "local.fleet-security",
      stage: `${stage}.fleet`,
      description: "Register a satellite and exercise fleet + security surfaces",
    }, async () => {
      const satellite = await pairSatellite(baseUrl, token, {
        displayName: "Closure Fleet Satellite",
        capabilities: [
          { key: "skill.run", available: true },
          { key: "sync.pull", available: true },
        ],
        heartbeat: { failureRate1m: 0.1, source: "local-fleet-security" },
      });
      const overview = await apiFetch(baseUrl, token, "GET", "/v1/fleet/overview");
      const list = await apiFetch(baseUrl, token, "GET", "/v1/fleet/satellites");
      const securityCenter = await apiFetch(baseUrl, token, "GET", "/v1/security/center");
      const pairingList = await apiFetch(baseUrl, token, "GET", "/v1/satellites/pairing");
      const responsePath = writeResponseEvidence(ledger.paths, "local-fleet-security", {
        register: satellite.register.json,
        approve: satellite.approve.json,
        handshake: satellite.handshake.json,
        capabilities: satellite.capabilities?.json ?? null,
        heartbeat: satellite.heartbeat?.json ?? null,
        overview: overview.json,
        list: list.json,
        securityCenter: securityCenter.json,
        pairingList: pairingList.json,
      });
      const satelliteId = satellite.satelliteId;
      return {
        evidence: { responsePath },
        details: { satelliteId },
      };
    });

    await runStep(ledger, {
      id: "local.observability-system",
      stage: `${stage}.system`,
      description: "Exercise observability and system remote read surfaces",
    }, async () => {
      const overview = await apiFetch(baseUrl, token, "GET", "/v1/observability/overview");
      const traces = await apiFetch(baseUrl, token, "GET", "/v1/observability/traces");
      const audit = await apiFetch(baseUrl, token, "GET", "/v1/observability/audit");
      const remoteDevices = await apiFetch(baseUrl, token, "GET", "/v1/system/remote/devices");
      const remoteSessions = await apiFetch(baseUrl, token, "GET", "/v1/system/remote/sessions");
      const responsePath = writeResponseEvidence(ledger.paths, "local-observability-system", {
        overview: overview.json,
        traces: traces.json,
        audit: audit.json,
        remoteDevices: remoteDevices.json,
        remoteSessions: remoteSessions.json,
      });
      if (overview.status !== 200 || !overview.json.ok) {
        throw new Error(`Observability overview failed: ${JSON.stringify(overview.json)}`);
      }
      if (traces.status !== 200 || !traces.json.ok) {
        throw new Error(`Observability traces failed: ${JSON.stringify(traces.json)}`);
      }
      if (audit.status !== 200 || !audit.json.ok) {
        throw new Error(`Observability audit failed: ${JSON.stringify(audit.json)}`);
      }
      if (remoteDevices.status !== 200 || !remoteDevices.json.ok) {
        throw new Error(`System remote devices failed: ${JSON.stringify(remoteDevices.json)}`);
      }
      if (remoteSessions.status !== 200 || !remoteSessions.json.ok) {
        throw new Error(`System remote sessions failed: ${JSON.stringify(remoteSessions.json)}`);
      }
      return {
        evidence: { responsePath },
      };
    });

    await runStep(ledger, {
      id: "local.rules-acceptance",
      stage: `${stage}.quality`,
      description: "Exercise rules and acceptance public route families",
    }, async () => {
      const bundle = await apiFetch(baseUrl, token, "POST", "/v1/rules/bundles", {
        name: "Closure Rule Bundle",
      });
      if (bundle.status !== 200 || !bundle.json.ok) {
        throw new Error(`Rule bundle create failed: ${JSON.stringify(bundle.json)}`);
      }
      const bundleId = bundle.json.data?.bundle?.id ?? bundle.json.bundle?.id ?? bundle.json.id ?? bundle.json.data?.id;
      const evaluate = await apiFetch(baseUrl, token, "POST", "/v1/rules/evaluate", {
        bundleId,
        facts: { status: "ok" },
      });
      const simulate = await apiFetch(baseUrl, token, "POST", "/v1/rules/simulate", {
        bundleId,
        facts: { status: "ok" },
      });
      const acceptanceRun = await apiFetch(baseUrl, token, "POST", "/v1/acceptance/run", {
        artifactType: "json",
        artifact: { status: "ok" },
      });
      const responsePath = writeResponseEvidence(ledger.paths, "local-rules-acceptance", {
        bundle: bundle.json,
        evaluate: evaluate.json,
        simulate: simulate.json,
        acceptanceRun: acceptanceRun.json,
      });
      if (evaluate.status !== 200 || !evaluate.json.ok) {
        throw new Error(`Rule evaluate failed: ${JSON.stringify(evaluate.json)}`);
      }
      if (simulate.status !== 200 || !simulate.json.ok) {
        throw new Error(`Rule simulate failed: ${JSON.stringify(simulate.json)}`);
      }
      if (acceptanceRun.status !== 200 || !acceptanceRun.json.ok) {
        throw new Error(`Acceptance run failed: ${JSON.stringify(acceptanceRun.json)}`);
      }
      return {
        evidence: { responsePath },
        details: { bundleId },
      };
    });

    await runStep(ledger, {
      id: "local.self-healing",
      stage: `${stage}.healing`,
      description: "Trigger repeated broken workflow deploys and close the diagnosis/auto-fix loop",
    }, async () => {
      const originalPolicy = await apiFetch(baseUrl, token, "GET", "/v1/agent-loop/policy");
      const policyBefore = originalPolicy.json?.data?.policy ?? originalPolicy.json?.policy ?? null;
      const policyUpdate = await apiFetch(baseUrl, token, "PUT", "/v1/agent-loop/policy", {
        autoApplyLowRisk: false,
      });
      if (policyUpdate.status !== 200 || !policyUpdate.json.ok) {
        throw new Error(`Agent loop policy update failed: ${JSON.stringify(policyUpdate.json)}`);
      }

      const DEPLOY_WORKFLOW_FAILURE_MESSAGE = "Generate a workflow draft before preparing deploy actions";
      const DEPLOY_WORKFLOW_FAILURE_EXPECTATION = "Expected repeated 4xx template execute responses for a missing sessionId so the self-healing loop could materialize a workflow incident and planned action for the deploy-workflow template.";
      const waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const listWorkflowDeployActionItems = async () => {
        const workflowIncidents = await apiFetch(baseUrl, token, "GET", "/v1/diagnosis/incidents");
        const workflowItems = workflowIncidents.json?.data?.items ?? workflowIncidents.json?.items ?? [];
        const workflowDeployActionItems = Array.isArray(workflowItems)
          ? workflowItems.filter((item) =>
            item?.incident?.category === "workflow"
            && item?.incident?.context?.detail === "deploy-workflow"
            && item?.incident?.context?.message === DEPLOY_WORKFLOW_FAILURE_MESSAGE
            && item?.action?.summary?.actionId
          )
          : [];
        return {
          workflowIncidents,
          workflowDeployActionItems,
        };
      };
      const waitForWorkflowDeployAction = async ({ excludeActionIds = [] } = {}) => {
        let latestWorkflowIncidents = null;
        let latestWorkflowDeployActionItems = [];
        for (let attempt = 0; attempt < 6; attempt += 1) {
          const result = await listWorkflowDeployActionItems();
          latestWorkflowIncidents = result.workflowIncidents;
          latestWorkflowDeployActionItems = result.workflowDeployActionItems;
          const actionItem = latestWorkflowDeployActionItems.find((item) => {
            const actionId = item?.action?.summary?.actionId;
            return typeof actionId === "string"
              && item?.action?.summary?.status === "planned"
              && !excludeActionIds.includes(actionId);
          }) ?? null;
          if (actionItem) {
            return {
              workflowIncidents: latestWorkflowIncidents,
              workflowDeployActionItems: latestWorkflowDeployActionItems,
              actionItem,
            };
          }
          if (attempt < 5) {
            await waitMs(250);
          }
        }
        return {
          workflowIncidents: latestWorkflowIncidents,
          workflowDeployActionItems: latestWorkflowDeployActionItems,
          actionItem: null,
        };
      };

      const deployAttempts = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const deploy = await apiFetch(
          baseUrl,
          token,
          "POST",
          "/v1/uix/templates/deploy-workflow/execute",
          {
            parameters: {
              sessionId: "missing-session-id",
              runNow: true,
            },
          },
        );
        deployAttempts.push({
          status: deploy.status,
          json: deploy.json,
        });
      }
      const deployProbeStatuses = deployAttempts.map((attempt) => attempt.status);
      const unexpectedDeployProbeStatuses = deployProbeStatuses.filter((status) => status < 400 || status >= 500);

      const initialWorkflowAction = await waitForWorkflowDeployAction();
      if (initialWorkflowAction.workflowIncidents?.status !== 200 || !initialWorkflowAction.workflowIncidents?.json?.ok) {
        throw new Error(`Diagnosis incidents failed: ${JSON.stringify(initialWorkflowAction.workflowIncidents?.json)}`);
      }
      if (!initialWorkflowAction.actionItem?.action?.summary?.actionId) {
        return {
          status: FRIDAY_CLOSURE_STATUSES.BLOCKER,
          details: {
            reason: "Repeated workflow deploy failures did not materialize the expected deploy-workflow self-healing action.",
            actionCount: initialWorkflowAction.workflowDeployActionItems.length,
            deployProbeStatuses,
            deployProbeExpectation: DEPLOY_WORKFLOW_FAILURE_EXPECTATION,
          },
          evidence: {
            responsePath: writeResponseEvidence(ledger.paths, "local-self-healing", {
              policyBefore,
              policyUpdate: policyUpdate.json,
              deployProbeExpectation: DEPLOY_WORKFLOW_FAILURE_EXPECTATION,
              deployProbeStatuses,
              deployAttempts,
              workflowIncidents: initialWorkflowAction.workflowIncidents?.json ?? null,
            }),
          },
        };
      }

      const denyActionId = initialWorkflowAction.actionItem.action.summary.actionId;
      const deny = await apiFetch(baseUrl, token, "POST", `/v1/auto-fix/actions/${denyActionId}/deny`, {
        reason: "Closure deny path validation",
      });
      if (deny.status !== 200 || !deny.json.ok) {
        throw new Error(`Auto-fix deny failed: ${JSON.stringify(deny.json)}`);
      }
      const postDenyDeployAttempts = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const deploy = await apiFetch(
          baseUrl,
          token,
          "POST",
          "/v1/uix/templates/deploy-workflow/execute",
          {
            parameters: {
              sessionId: "missing-session-id",
              runNow: true,
            },
          },
        );
        postDenyDeployAttempts.push({
          status: deploy.status,
          json: deploy.json,
        });
      }
      const postDenyDeployProbeStatuses = postDenyDeployAttempts.map((attempt) => attempt.status);
      const unexpectedPostDenyDeployProbeStatuses = postDenyDeployProbeStatuses
        .filter((status) => status < 400 || status >= 500);
      const recreatedWorkflowAction = await waitForWorkflowDeployAction({ excludeActionIds: [denyActionId] });
      if (recreatedWorkflowAction.workflowIncidents?.status !== 200 || !recreatedWorkflowAction.workflowIncidents?.json?.ok) {
        throw new Error(`Diagnosis incidents after deny failed: ${JSON.stringify(recreatedWorkflowAction.workflowIncidents?.json)}`);
      }
      if (!recreatedWorkflowAction.actionItem?.action?.summary?.actionId) {
        return {
          status: FRIDAY_CLOSURE_STATUSES.BLOCKER,
          details: {
            reason: "The deploy-workflow self-healing loop created a denyable action, but did not recreate a fresh planned action after rejection for approve-path validation.",
            deniedActionId: denyActionId,
            deployProbeStatuses,
            postDenyDeployProbeStatuses,
            deployProbeExpectation: DEPLOY_WORKFLOW_FAILURE_EXPECTATION,
          },
          evidence: {
            responsePath: writeResponseEvidence(ledger.paths, "local-self-healing", {
              policyBefore,
              policyUpdate: policyUpdate.json,
              deployProbeExpectation: DEPLOY_WORKFLOW_FAILURE_EXPECTATION,
              deployProbeStatuses,
              deployAttempts,
              initialWorkflowIncidents: initialWorkflowAction.workflowIncidents?.json ?? null,
              deny: deny.json,
              postDenyDeployProbeStatuses,
              postDenyDeployAttempts,
              recreatedWorkflowIncidents: recreatedWorkflowAction.workflowIncidents?.json ?? null,
            }),
          },
        };
      }

      const approveActionId = recreatedWorkflowAction.actionItem.action.summary.actionId;
      const approve = await apiFetch(baseUrl, token, "POST", `/v1/auto-fix/actions/${approveActionId}/approve`, {
        reason: "Closure approve path validation",
      });
      const approvedWorkflowActionDetail = await apiFetch(baseUrl, token, "GET", `/v1/auto-fix/actions/${approveActionId}`);

      const configSatellite = await pairSatellite(baseUrl, token, {
        displayName: "Closure Self-Healing Config Satellite",
        heartbeat: { failureRate1m: 0.75, source: "local-self-healing" },
      });
      let configIncidentList = await apiFetch(baseUrl, token, "GET", "/v1/diagnosis/incidents");
      let configIncidentItems = configIncidentList.json?.data?.items ?? configIncidentList.json?.items ?? [];
      let configIncident = Array.isArray(configIncidentItems)
        ? configIncidentItems.find((item) => item?.incident?.category === "config" && item?.action?.summary?.actionId)
        : null;
      if (!configIncident) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        configIncidentList = await apiFetch(baseUrl, token, "GET", "/v1/diagnosis/incidents");
        configIncidentItems = configIncidentList.json?.data?.items ?? configIncidentList.json?.items ?? [];
        configIncident = Array.isArray(configIncidentItems)
          ? configIncidentItems.find((item) => item?.incident?.category === "config" && item?.action?.summary?.actionId)
          : null;
      }
      if (!configIncident?.action?.summary?.actionId) {
        return {
          status: FRIDAY_CLOSURE_STATUSES.BLOCKER,
          details: {
            reason: "Satellite degraded heartbeat did not materialize a config auto-fix action for execute and rollback validation.",
            deployProbeStatuses,
            postDenyDeployProbeStatuses,
            deployProbeExpectation: DEPLOY_WORKFLOW_FAILURE_EXPECTATION,
          },
          evidence: {
            responsePath: writeResponseEvidence(ledger.paths, "local-self-healing", {
              policyBefore,
              policyUpdate: policyUpdate.json,
              deployProbeExpectation: DEPLOY_WORKFLOW_FAILURE_EXPECTATION,
              deployProbeStatuses,
              deployAttempts,
              initialWorkflowIncidents: initialWorkflowAction.workflowIncidents?.json ?? null,
              deny: deny.json,
              postDenyDeployProbeStatuses,
              postDenyDeployAttempts,
              recreatedWorkflowIncidents: recreatedWorkflowAction.workflowIncidents?.json ?? null,
              approve: approve.json,
              approvedWorkflowActionDetail: approvedWorkflowActionDetail.json,
              configSatellite: {
                register: configSatellite.register.json,
                approve: configSatellite.approve.json,
                handshake: configSatellite.handshake.json,
                heartbeat: configSatellite.heartbeat?.json ?? null,
              },
              configIncidents: configIncidentList.json,
            }),
          },
        };
      }

      const configActionId = configIncident.action.summary.actionId;
      const execute = await apiFetch(baseUrl, token, "POST", `/v1/auto-fix/actions/${configActionId}/execute`, {});
      const rollback = await apiFetch(baseUrl, token, "POST", `/v1/auto-fix/actions/${configActionId}/rollback`, {
        reason: "Closure rollback path validation",
      });
      const actionDetail = await apiFetch(baseUrl, token, "GET", `/v1/auto-fix/actions/${configActionId}`);
      const metrics = await apiFetch(baseUrl, token, "GET", "/v1/auto-fix/metrics");
      const responsePath = writeResponseEvidence(ledger.paths, "local-self-healing", {
        policyBefore,
        policyUpdate: policyUpdate.json,
        deployProbeExpectation: DEPLOY_WORKFLOW_FAILURE_EXPECTATION,
        deployProbeStatuses,
        deployAttempts,
        initialWorkflowIncidents: initialWorkflowAction.workflowIncidents?.json ?? null,
        postDenyDeployProbeStatuses,
        postDenyDeployAttempts,
        recreatedWorkflowIncidents: recreatedWorkflowAction.workflowIncidents?.json ?? null,
        approvedWorkflowActionDetail: approvedWorkflowActionDetail.json,
        configSatellite: {
          register: configSatellite.register.json,
          approve: configSatellite.approve.json,
          handshake: configSatellite.handshake.json,
          heartbeat: configSatellite.heartbeat?.json ?? null,
        },
        configIncidents: configIncidentList.json,
        metrics: metrics.json,
        deny: deny.json,
        approve: approve.json,
        execute: execute.json,
        rollback: rollback.json,
        actionDetail: actionDetail.json,
      });
      if (approve.status !== 200 || !approve.json.ok) {
        throw new Error(`Auto-fix approve failed: ${JSON.stringify(approve.json)}`);
      }
      if (unexpectedDeployProbeStatuses.length > 0) {
        throw new Error(`Workflow incident probes returned unexpected statuses: ${unexpectedDeployProbeStatuses.join(", ")}`);
      }
      if (unexpectedPostDenyDeployProbeStatuses.length > 0) {
        throw new Error(`Post-deny workflow incident probes returned unexpected statuses: ${unexpectedPostDenyDeployProbeStatuses.join(", ")}`);
      }
      if (execute.status !== 200 || !execute.json.ok) {
        throw new Error(`Auto-fix execute failed: ${JSON.stringify(execute.json)}`);
      }
      if (rollback.status !== 200 || !rollback.json.ok) {
        throw new Error(`Auto-fix rollback failed: ${JSON.stringify(rollback.json)}`);
      }
      return {
        evidence: { responsePath },
        details: {
          deniedActionId: denyActionId,
          approvedActionId: approveActionId,
          executedActionId: configActionId,
          configSatelliteId: configSatellite.satelliteId,
          deployProbeStatuses,
          postDenyDeployProbeStatuses,
          deployProbeExpectation: DEPLOY_WORKFLOW_FAILURE_EXPECTATION,
        },
      };
    });

    await runStep(ledger, {
      id: "local.browser-companion-release",
      stage: `${stage}.system`,
      description: "Run controlled desktop/browser/release environment checks",
    }, async () => {
      const browserCheck = await runCommand({
        id: "local.check.desktop-runtime",
        stage: `${stage}.system`,
        description: "npm run check:desktop-runtime",
        command: "npm",
        args: ["run", "check:desktop-runtime"],
        logPath: path.join(ledger.paths.logs, "local-check-desktop-runtime.log"),
        timeoutMs: 300_000,
      });
      const companionCheck = await runCommand({
        id: "local.check.companion-release-env",
        stage: `${stage}.system`,
        description: "npm run check:companion:release-env",
        command: "npm",
        args: ["run", "check:companion:release-env"],
        logPath: path.join(ledger.paths.logs, "local-check-companion-release-env.log"),
        timeoutMs: 300_000,
      });
      const releaseCheck = await runCommand({
        id: "local.release.check",
        stage: `${stage}.system`,
        description: "npm run release:check",
        command: "npm",
        args: ["run", "release:check"],
        logPath: path.join(ledger.paths.logs, "local-release-check.log"),
        timeoutMs: 300_000,
      });

      const failures = [browserCheck, companionCheck, releaseCheck].filter((result) => result.code !== 0);
      if (failures.length > 0) {
        return {
          status: FRIDAY_CLOSURE_STATUSES.BLOCKER,
          evidence: {
            desktopRuntimeLog: browserCheck.logPath,
            companionReleaseEnvLog: companionCheck.logPath,
            releaseCheckLog: releaseCheck.logPath,
          },
          details: {
            reason: "Controlled desktop/release checks did not all pass",
            failingCommands: failures.map((result) => result.command),
          },
        };
      }

      return {
        evidence: {
          desktopRuntimeLog: browserCheck.logPath,
          companionReleaseEnvLog: companionCheck.logPath,
          releaseCheckLog: releaseCheck.logPath,
        },
      };
    });

    if (!SKIP_BACKSTOP) {
      await runStep(ledger, {
        id: "local.backstop.check-all",
        stage: `${stage}.backstop`,
        description: "Run npm run check:all as a closure backstop",
      }, async () => {
        const result = await runCommand({
          id: "local.backstop.check-all",
          stage: `${stage}.backstop`,
          description: "npm run check:all",
          command: "npm",
          args: ["run", "check:all"],
          logPath: path.join(ledger.paths.logs, "local-backstop-check-all.log"),
          timeoutMs: 900_000,
        });
        if (result.code !== 0) {
          throw new Error(`npm run check:all failed with code ${String(result.code)}`);
        }
        return { evidence: { logPath: result.logPath } };
      });

      await runStep(ledger, {
        id: "local.backstop.release-verify",
        stage: `${stage}.backstop`,
        description: "Run npm run release:verify:repo as a closure backstop",
      }, async () => {
        const result = await runCommand({
          id: "local.backstop.release-verify",
          stage: `${stage}.backstop`,
          description: "npm run release:verify:repo",
          command: "npm",
          args: ["run", "release:verify:repo"],
          logPath: path.join(ledger.paths.logs, "local-backstop-release-verify.log"),
          timeoutMs: 1_800_000,
        });
        if (result.code !== 0) {
          throw new Error(`npm run release:verify:repo failed with code ${String(result.code)}`);
        }
        return { evidence: { logPath: result.logPath } };
      });
    }
  } finally {
    const cleanupErrors = await cleanupRegistry.run();
    if (cleanupErrors.length > 0) {
      writeJson(path.join(ledger.paths.logs, "local-runtime-cleanup-errors.json"), cleanupErrors);
    }
  }
}

async function runCloudStage(ledger) {
  await runStep(ledger, {
    id: "cloud.preflight.contract",
    stage: "cloud.preflight",
    description: "Validate required cloud env contract for the cloud closure stage",
  }, async () => {
    const blockers = collectCloudBlockers(process.env);
    if (blockers.length > 0) {
      return {
        status: FRIDAY_CLOSURE_STATUSES.BLOCKER,
        details: { blockers },
      };
    }
    const health = await fetch(`${process.env.FRIDAY_E2E_CLOUD_BASE_URL}/v1/health`);
    const body = await health.json().catch(() => ({}));
    const responsePath = writeResponseEvidence(ledger.paths, "cloud-preflight-health", {
      status: health.status,
      body,
    });
    if (!health.ok) {
      throw new Error(`Cloud health failed with status ${String(health.status)}`);
    }
    return {
      evidence: { responsePath },
      details: {
        authMode: process.env.FRIDAY_E2E_CLOUD_AUTH_MODE,
      },
    };
  });
}

async function main() {
  const runId = createClosureRunId();
  const root = resolveClosureRoot(REPO_ROOT, runId);
  const paths = {
    runId,
    root,
    state: path.join(root, "state"),
    skills: path.join(root, "skills"),
    artifacts: path.join(root, "artifacts"),
    logs: path.join(root, "logs"),
    exports: path.join(root, "exports"),
    responses: path.join(root, "responses"),
    transcripts: path.join(root, "transcripts"),
  };

  acquireWorkspaceRunLock({
    pid: process.pid,
    kind: "closure",
    mode: CLOSURE_MODE,
    runId,
    startedAt: nowIso(),
    ledgerPath: path.join(root, "ledger.json"),
  }, {
    onStaleLock: markInterruptedClosureLedger,
  });

  Object.values(paths).forEach((value) => {
    if (typeof value === "string" && value.startsWith(root)) {
      ensureDir(value);
    }
  });

  const ledger = createLedger(paths);
  persistLedger(ledger);

  try {
    try {
      if (CLOSURE_MODE !== "cloud") {
        await runLocalStage(ledger);
      }
      if (CLOSURE_MODE !== "local") {
        await runCloudStage(ledger);
      }
    } finally {
      ledger.completedAt = nowIso();
      persistLedger(ledger);
    }

    const verdictPath = path.join(paths.root, "verdict.txt");
    const readinessText = formatReadinessReport(ledger.readiness);
    writeText(verdictPath, `${readinessText}\n`);
    console.log(formatConsoleSummary(ledger.readiness, path.join(paths.root, "ledger.json")));
    if (ledger.verdict !== "GO") {
      process.exitCode = 1;
    }
  } finally {
    releaseWorkspaceRunLock({ runId });
  }
}

const EXECUTED_AS_SCRIPT = (() => {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (EXECUTED_AS_SCRIPT) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
