#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const REPO_ROOT = process.cwd();
export const DATE_STAMP = new Date().toISOString().slice(0, 10);
export const REPORT_DIR = path.join(REPO_ROOT, "docs", "reports", "repo");
export const SOURCE_MATRIX_PATH = path.join(
  REPORT_DIR,
  `SELF_EVOLUTION_LIVE_AUDIT_MATRIX_${DATE_STAMP}.json`,
);
export const SOURCE_REPORT_PATH = path.join(
  REPORT_DIR,
  `SELF_EVOLUTION_LIVE_AUDIT_${DATE_STAMP}.md`,
);

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
  return {
    target,
    status: "blocked",
    reason,
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
