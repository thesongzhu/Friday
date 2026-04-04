import fs from "node:fs";
import path from "node:path";

export function createRunId(now = new Date()) {
  const entropy = Math.random().toString(36).slice(2, 8);
  return `${now.toISOString().replace(/[:.]/g, "-")}-${entropy}`;
}

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

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function pathExists(filePath) {
  return fs.existsSync(filePath);
}

export function resolveValidationReportRoot(repoRoot, runId) {
  return path.join(repoRoot, "docs", "reports", "ops", "real-world-validation", runId);
}

export function resolveLatestPointerPath(repoRoot) {
  return path.join(repoRoot, "docs", "reports", "ops", "real-world-validation", "latest.json");
}
