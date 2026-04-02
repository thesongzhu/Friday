#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const REPO_ROOT = process.cwd();
export const DATE_STAMP = new Date().toISOString().slice(0, 10);
export const REPORT_DIR = path.join(REPO_ROOT, "docs", "reports", "repo");
const SOURCE_MATRIX_BASENAME = "SELF_EVOLUTION_LIVE_AUDIT_MATRIX";
const SOURCE_REPORT_BASENAME = "SELF_EVOLUTION_LIVE_AUDIT";

function findLatestReportArtifact(prefix, extension) {
  if (!fs.existsSync(REPORT_DIR)) {
    return null;
  }
  const candidates = fs.readdirSync(REPORT_DIR)
    .filter((entry) => entry.startsWith(`${prefix}_`) && entry.endsWith(extension))
    .sort();
  if (candidates.length === 0) {
    return null;
  }
  return path.join(REPORT_DIR, candidates.at(-1));
}

export const SOURCE_MATRIX_PATH = findLatestReportArtifact(SOURCE_MATRIX_BASENAME, ".json")
  ?? path.join(REPORT_DIR, `${SOURCE_MATRIX_BASENAME}_${DATE_STAMP}.json`);
export const SOURCE_REPORT_PATH = findLatestReportArtifact(SOURCE_REPORT_BASENAME, ".md")
  ?? path.join(REPORT_DIR, `${SOURCE_REPORT_BASENAME}_${DATE_STAMP}.md`);

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export function writeText(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, value, "utf8");
}

export function sourceMatrixExists() {
  return fs.existsSync(SOURCE_MATRIX_PATH);
}

export function ensureSourceMatrix() {
  if (sourceMatrixExists()) {
    return;
  }
  const result = spawnSync("node", [path.join(REPO_ROOT, "scripts", "e2e", "run-self-evolution-live-audit.mjs")], {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.status !== 0 || !sourceMatrixExists()) {
    throw new Error("Failed to generate source self-evolution live audit matrix");
  }
}

export function loadSourceMatrix() {
  ensureSourceMatrix();
  return JSON.parse(fs.readFileSync(SOURCE_MATRIX_PATH, "utf8"));
}

export function readSourceReport() {
  if (!fs.existsSync(SOURCE_REPORT_PATH)) {
    return null;
  }
  return fs.readFileSync(SOURCE_REPORT_PATH, "utf8");
}

export function blockStatus(target, reason, extra = {}) {
  const blockerTypes = Array.isArray(extra.blockerTypes)
    ? [...new Set(extra.blockerTypes.filter((value) => typeof value === "string" && value.trim().length > 0))]
    : [];
  const blockerType = typeof extra.blockerType === "string" && extra.blockerType.trim().length > 0
    ? extra.blockerType
    : blockerTypes[0];
  return {
    target,
    status: "blocked",
    reason,
    ...(blockerType ? { blockerType } : {}),
    ...(blockerTypes.length > 0 ? { blockerTypes } : {}),
    ...extra,
  };
}

export function passStatus(target, summary, evidence = [], extra = {}) {
  return {
    target,
    status: "passed",
    summary,
    evidence,
    ...extra,
  };
}

export function contractStatus(input) {
  return {
    providerCreate: input.providerCreate === true,
    providerDoctor: input.providerDoctor === true,
    routingExplain: input.routingExplain === true,
    liveRun: input.liveRun === true,
    failureFallback: input.failureFallback === true,
    actualExecution: input.actualExecution === true,
  };
}

export function blockerTypesFromEnvironment({ credentialEnv = [], binary = null, runner = true, productSupport = true }) {
  const blockerTypes = [];
  if (runner !== true) {
    blockerTypes.push("missing_runner");
  }
  if (productSupport !== true) {
    blockerTypes.push("unsupported_boundary");
  }
  if (binary && !hasBinary(binary)) {
    blockerTypes.push("missing_runner");
  }
  if (credentialEnv.length > 0 && !credentialEnv.some((name) => hasEnv(name))) {
    blockerTypes.push("missing_credentials");
  }
  return blockerTypes.length > 0
    ? [...new Set(blockerTypes)]
    : ["not_yet_executed"];
}

export function blockerTypeFromEnvironment(input) {
  return blockerTypesFromEnvironment(input)[0];
}

export function buildMarkdownReport({ title, generatedAt, sourceMatrixPath, sourceReportPath, summary, results, blockers }) {
  const lines = [
    `# ${title}`,
    "",
    `- Generated at: ${generatedAt}`,
    `- Source matrix: ${sourceMatrixPath}`,
    `- Source report: ${sourceReportPath}`,
    "",
    "## Summary",
    "",
    summary,
    "",
    "## Results",
    "",
  ];
  for (const result of results) {
    lines.push(
      `- ${result.target}: ${result.status}${result.summary ? ` — ${result.summary}` : ""}${result.reason ? ` — ${result.reason}` : ""}`,
    );
    if (Array.isArray(result.blockerTypes) && result.blockerTypes.length > 0) {
      lines.push(`  - blockerTypes: ${result.blockerTypes.join(", ")}`);
    } else if (result.blockerType) {
      lines.push(`  - blockerType: ${result.blockerType}`);
    }
  }
  if (blockers.length > 0) {
    lines.push("", "## Blockers", "");
    for (const blocker of blockers) {
      lines.push(`- ${blocker.target}: ${blocker.reason}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function hasEnv(name) {
  return typeof process.env[name] === "string" && process.env[name].trim().length > 0;
}

export function hasBinary(name) {
  const result = spawnSync("bash", ["-lc", `command -v ${name}`], {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: "utf8",
  });
  return result.status === 0;
}

export function formatBlockedTargetActionItems(result) {
  const items = [];
  if (Array.isArray(result.requiredEnv) && result.requiredEnv.length > 0) {
    items.push(`set ${result.requiredEnv.join(", ")}`);
  }
  if (typeof result.requiredBinary === "string" && result.requiredBinary.trim().length > 0) {
    items.push(`install binary ${result.requiredBinary}`);
  }
  if (typeof result.requiredRunner === "string" && result.requiredRunner.trim().length > 0) {
    items.push(`run on ${result.requiredRunner}`);
  }
  if (Array.isArray(result.blockerTypes) && result.blockerTypes.includes("not_yet_executed")) {
    items.push("execute the dedicated live harness");
  }
  return items;
}
