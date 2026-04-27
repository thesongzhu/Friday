#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();

const EXCLUDED_PATHS = [
  /^node_modules\//,
  /^dist\//,
  /^coverage\//,
  /^package-lock\.json$/,
  /^pnpm-lock\.yaml$/,
  /^\.secrets\.baseline$/,
  /\.snap$/,
  /^docs\/reports\//,
  /^screenshots\//,
  /^friday-static(?:\.prod)?\.html$/,
  /^polish-report\.html$/,
  /^qa-report\.html$/,
];

const SECRET_PATTERNS = [
  {
    name: "OpenAI project key",
    regex: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    name: "DeepSeek-style hex key",
    regex: /\bsk-[a-f0-9]{32}\b/gi,
  },
  {
    name: "Generic provider sk key",
    regex: /\bsk-[A-Za-z0-9_-]{24,}\b/g,
  },
];

const FALSE_POSITIVE_HINTS = [
  "pragma: allowlist secret",
  "fake",
  "fixture",
  "intentionally",
  "deliberately",
  "not-real",
  "test-token",
  "session-token",
  "expired-token",
  "sk-test-",
  "sk-ant-",
  "sk-secret-api-key",
];

function isExcluded(filePath) {
  return EXCLUDED_PATHS.some((pattern) => pattern.test(filePath));
}

function isAllowlistedLine(line) {
  const normalized = line.toLowerCase();
  return FALSE_POSITIVE_HINTS.some((hint) => normalized.includes(hint));
}

function redact(secret) {
  if (secret.length <= 12) {
    return "[redacted]";
  }
  return `${secret.slice(0, 5)}...${secret.slice(-4)}`;
}

function trackedFiles() {
  const raw = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return raw.split("\0").filter(Boolean).filter((filePath) => !isExcluded(filePath));
}

const findings = [];

for (const relativePath of trackedFiles()) {
  const absolutePath = path.join(REPO_ROOT, relativePath);
  let text;
  try {
    text = fs.readFileSync(absolutePath, "utf8");
  } catch {
    continue;
  }

  const lines = text.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (isAllowlistedLine(line)) {
      continue;
    }
    for (const pattern of SECRET_PATTERNS) {
      pattern.regex.lastIndex = 0;
      for (const match of line.matchAll(pattern.regex)) {
        findings.push({
          path: relativePath,
          line: lineIndex + 1,
          kind: pattern.name,
          token: redact(match[0]),
        });
      }
    }
  }
}

if (findings.length > 0) {
  console.error("Provider/API key shaped secrets found in tracked files:");
  for (const finding of findings) {
    console.error(`- ${finding.path}:${finding.line} ${finding.kind} ${finding.token}`);
  }
  console.error("Remove the value or add a very narrow false-positive marker only for intentionally invalid fixtures.");
  process.exit(1);
}

console.log("No provider/API key shaped secrets found in tracked files.");
