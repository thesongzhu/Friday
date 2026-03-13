import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;
const LOG_FILE_EXTENSIONS = new Set([".log", ".out", ".err", ".txt"]);
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "tmp",
  "temp",
]);

export function readWorkspaceRoot(input) {
  if (input && typeof input.workspaceRoot === "string" && input.workspaceRoot.trim().length > 0) {
    return path.resolve(input.workspaceRoot.trim());
  }
  return process.cwd();
}

export async function findRepoRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
}

export async function fileExists(targetPath) {
  try {
    await fsp.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile(targetPath) {
  try {
    const text = await fsp.readFile(targetPath, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function readPackageJson(rootDir) {
  return readJsonFile(path.join(rootDir, "package.json"));
}

export function detectPackageManager(rootDir) {
  if (fs.existsSync(path.join(rootDir, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(rootDir, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(rootDir, "bun.lockb")) || fs.existsSync(path.join(rootDir, "bun.lock"))) {
    return "bun";
  }
  return "npm";
}

export async function runCommand(command, args = [], options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: -1,
        stdout,
        stderr: stderr || error.message,
        durationMs: Date.now() - startedAt,
        timedOut,
        command: [command, ...args].join(" "),
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: !timedOut && code === 0,
        exitCode: code ?? -1,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        command: [command, ...args].join(" "),
      });
    });

    if (options.stdin) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

export async function runPackageScript(rootDir, scriptName, timeoutMs = 300_000) {
  const manager = detectPackageManager(rootDir);
  const command =
    manager === "yarn"
      ? "yarn"
      : manager === "pnpm"
        ? "pnpm"
        : manager === "bun"
          ? "bun"
          : "npm";
  const args =
    manager === "bun"
      ? ["run", scriptName]
      : ["run", scriptName];

  return {
    manager,
    ...(await runCommand(command, args, { cwd: rootDir, timeoutMs })),
  };
}

export function parseGitStatusLines(stdout) {
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => ({
      code: line.slice(0, 2),
      path: line.slice(3).trim(),
    }));
}

export function summarizeGitChanges(entries) {
  const changed = entries.filter((entry) => entry.code.trim() !== "??");
  const untracked = entries.filter((entry) => entry.code.trim() === "??");
  return {
    total: entries.length,
    changedCount: changed.length,
    untrackedCount: untracked.length,
    changedPaths: entries.map((entry) => entry.path),
  };
}

export function normalizeLineFingerprint(line) {
  return line
    .replace(/\b\d{4}-\d{2}-\d{2}[tT ][\d:.+-Z]+\b/g, "<ts>")
    .replace(/\b0x[a-fA-F0-9]+\b/g, "<hex>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

export function analyzeLogText(text) {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const buckets = new Map();
  let errorLines = 0;
  let warningLines = 0;

  for (const line of lines) {
    const lowered = line.toLowerCase();
    const severity =
      /\b(fatal|panic|exception|error)\b/.test(lowered)
        ? "error"
        : /\bwarn(ing)?\b/.test(lowered)
          ? "warning"
          : null;

    if (!severity) continue;
    if (severity === "error") errorLines += 1;
    if (severity === "warning") warningLines += 1;

    const fingerprint = normalizeLineFingerprint(line);
    const current = buckets.get(fingerprint) ?? {
      fingerprint,
      severity,
      count: 0,
      sample: line.trim().slice(0, 240),
    };
    current.count += 1;
    if (severity === "error") current.severity = "error";
    buckets.set(fingerprint, current);
  }

  const topIssues = [...buckets.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, 8);

  return {
    lineCount: lines.length,
    errorLines,
    warningLines,
    topIssues,
  };
}

export async function readTail(targetPath, maxBytes = 64 * 1024) {
  const handle = await fsp.open(targetPath, "r");
  try {
    const stat = await handle.stat();
    const size = stat.size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function walkLogFiles(currentDir, depth, maxFiles, found) {
  if (depth < 0 || found.length >= maxFiles) {
    return;
  }

  let entries = [];
  try {
    entries = await fsp.readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (found.length >= maxFiles) {
      return;
    }
    const absolute = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walkLogFiles(absolute, depth - 1, maxFiles, found);
      continue;
    }

    const lower = entry.name.toLowerCase();
    if (
      LOG_FILE_EXTENSIONS.has(path.extname(lower))
      || lower.includes("error")
      || lower.includes("debug")
    ) {
      found.push(absolute);
    }
  }
}

export async function discoverLogFiles(rootDir, options = {}) {
  const explicitPath = typeof options.explicitPath === "string" && options.explicitPath.trim().length > 0
    ? path.resolve(options.explicitPath.trim())
    : null;
  const maxFiles = options.maxFiles ?? 5;

  if (explicitPath) {
    const stat = await fsp.stat(explicitPath).catch(() => null);
    if (!stat) return [];
    if (stat.isFile()) return [explicitPath];
    const found = [];
    await walkLogFiles(explicitPath, 2, maxFiles, found);
    return found;
  }

  const candidates = [
    path.join(rootDir, "logs"),
    path.join(rootDir, "log"),
    rootDir,
  ];
  const found = [];
  for (const candidate of candidates) {
    if (!(await fileExists(candidate))) continue;
    await walkLogFiles(candidate, candidate === rootDir ? 1 : 2, maxFiles, found);
    if (found.length >= maxFiles) break;
  }
  return [...new Set(found)].slice(0, maxFiles);
}

export async function triageLogs(rootDir, options = {}) {
  const logFiles = await discoverLogFiles(rootDir, options);
  const files = [];
  const issues = new Map();

  for (const filePath of logFiles) {
    let text = "";
    try {
      text = await readTail(filePath, options.maxBytes ?? 64 * 1024);
    } catch {
      continue;
    }
    const analyzed = analyzeLogText(text);
    files.push({
      path: filePath,
      lineCount: analyzed.lineCount,
      errorLines: analyzed.errorLines,
      warningLines: analyzed.warningLines,
    });
    for (const issue of analyzed.topIssues) {
      const current = issues.get(issue.fingerprint) ?? { ...issue };
      current.count += issue.count;
      if (issue.severity === "error") current.severity = "error";
      issues.set(issue.fingerprint, current);
    }
  }

  return {
    files,
    topIssues: [...issues.values()]
      .sort((left, right) => right.count - left.count)
      .slice(0, 8),
  };
}

export async function fetchHealthCheck(url, timeoutMs = 10_000) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/json, text/plain;q=0.9, */*;q=0.8" },
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? await response.json().catch(() => null)
      : await response.text().catch(() => "");
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      body,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      statusText: error instanceof Error ? error.message : String(error),
      body: null,
    };
  }
}

export async function detectPortListeners(port) {
  if (!Number.isFinite(Number(port))) {
    return [];
  }
  const lsof = await runCommand(
    "lsof",
    ["-nP", `-iTCP:${String(port)}`, "-sTCP:LISTEN"],
    { timeoutMs: 10_000 },
  );
  if (lsof.ok && lsof.stdout.trim().length > 0) {
    return lsof.stdout.trim().split("\n").slice(1);
  }

  const ss = await runCommand(
    "ss",
    ["-ltnp", `sport = :${String(port)}`],
    { timeoutMs: 10_000 },
  );
  if (ss.ok && ss.stdout.trim().length > 0) {
    return ss.stdout.trim().split("\n").slice(1);
  }

  return [];
}

export async function detectProcessesByName(processName) {
  if (!processName || String(processName).trim().length === 0) {
    return [];
  }
  const probe = await runCommand("pgrep", ["-fl", String(processName).trim()], { timeoutMs: 10_000 });
  if (!probe.ok || probe.stdout.trim().length === 0) {
    return [];
  }
  return probe.stdout.trim().split("\n");
}

export function truncate(value, maxLength = 220) {
  if (typeof value !== "string") return "";
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

export function buildReadFirstPermissions(includeShell = false, includeNetwork = false) {
  const grants = [
    {
      id: "filesystem-read",
      resource: "filesystem",
      action: "read",
      required: true,
      reason: "Read repository files, logs, and local metadata to produce diagnostics.",
    },
  ];
  if (includeShell) {
    grants.push({
      id: "shell-execute",
      resource: "shell",
      action: "execute",
      required: false,
      reason: "Run bounded local inspection commands such as git, lsof, pgrep, and package scripts.",
    });
  }
  if (includeNetwork) {
    grants.push({
      id: "network-connect",
      resource: "network",
      action: "connect",
      required: false,
      reason: "Check a local or user-provided health endpoint to confirm service status.",
    });
  }
  return {
    grants,
    promptOn: [
      ...(includeShell ? ["shell.execute"] : []),
      ...(includeNetwork ? ["network.connect"] : []),
    ],
  };
}

export function makeStarterManifest(input) {
  return {
    schemaVersion: "2.0",
    id: input.id,
    name: input.name,
    description: input.description,
    version: "1.0.0",
    kind: "system",
    category: input.category ?? "utility",
    author: { name: "Friday" },
    tags: ["starter", "starter.devops", ...(input.tags ?? [])],
    runtime: {
      kind: "node",
      entrypoint: "index.mjs",
      minHubVersion: "1.0.0",
      apiVersion: "1",
      timeoutMsDefault: input.timeoutMsDefault ?? 120_000,
    },
    triggers: {
      intents: input.intents ?? [],
      phrases: input.phrases ?? [],
      channels: ["*"],
    },
    invocation: {
      userInvocable: true,
      modelInvocable: true,
      priority: input.priority ?? 80,
      modes: ["intent"],
    },
    requirements: {
      bins: input.bins ?? [],
      env: [],
      config: [],
      os: ["darwin", "linux"],
    },
    inputs: input.inputs ?? [],
    outputs: input.outputs ?? [],
    permissions: input.permissions,
    schemas: null,
    flow: null,
    executionTargets: {
      allowedSatelliteTypes: ["desktop", "cloud-vm"],
      requiredCapabilities: [],
    },
    telemetry: {
      events: [
        "starter_skill_invoked",
        "starter_skill_suggested",
      ],
    },
  };
}
