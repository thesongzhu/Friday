#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const pathIndex = args.indexOf("--path");
const scanPath = pathIndex >= 0 ? path.resolve(args[pathIndex + 1] ?? "") : null;
const root = scanPath ?? process.cwd();
const repoMode = scanPath === null;

const TEXT_EXTENSIONS = new Set([
  ".cjs", ".css", ".csv", ".cts", ".d.ts", ".html", ".js", ".json", ".jsx",
  ".mjs", ".md", ".mts", ".sh", ".sql", ".svg", ".ts", ".tsx", ".txt",
  ".yaml", ".yml", "",
]);

const ALLOWLIST_HINTS = [
  "$FRIDAY_",
  "allowlist secret",
  "deliberately",
  "expired-token",
  "fake",
  "fixture",
  "intentionally",
  "not-real",
  "placeholder",
  "sk-ant-test",
  "sk-bad",
  "sk-compatible-test",
  "sk-real-key-123",
  "sk-secret-api-key",
  "sk-test",
  "ghp_1234567890",
  "stub",
  "test-token",
  "xoxb-stub",
];

const CONTENT_PATTERNS = [
  { name: "private path /Users/jarvis", regex: /\/Users\/jarvis\b/g },
  { name: "private path /Users/wenxindou", regex: /\/Users\/wenxindou\b/g },
  { name: "private path /Users/you", regex: /\/Users\/you\b/g },
  { name: "Friday Map control path", regex: /Friday Map(?!s)/g },
  { name: "dogfood control package", regex: /Friday-real-user-dogfood/g },
  { name: "release closure package", regex: /Friday-release-closure/g },
  { name: "global execution package", regex: /Friday-global-execution/g },
  { name: "finding master package", regex: /finding\/_master|Finding\/_master/g },
  { name: "GitHub token", regex: /\bghp_[A-Za-z0-9_]{20,}\b/g },
  { name: "npm token", regex: /\bnpm_[A-Za-z0-9]{20,}\b/g },
  { name: "Slack token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "Telegram bot token", regex: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g },
  {
    name: "live-looking provider key",
    regex: /\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{16,}\b|\bsk-[A-Za-z0-9_-]{32,}\b/g,
  },
  {
    name: "literal Lark secret value",
    regex: /\bFRIDAY_LARK_APP_SECRET\s*[:=]\s*["'](?!\$FRIDAY_|<|fake|stub|test)[^"']{12,}["']/g,
  },
  {
    name: "literal bot token value",
    regex: /\bFRIDAY_(?:DISCORD|TELEGRAM)_BOT_TOKEN\s*[:=]\s*["'](?!\$FRIDAY_|<|fake|stub|test)[^"']{12,}["']/g,
  },
];

const FORBIDDEN_PATH_PATTERNS = [
  { name: "non-example env file", regex: /(^|\/)\.env($|\.(?!example$))/ },
  { name: "local Friday state directory", regex: /(^|\/)\.friday\// },
  { name: "database artifact", regex: /\.(?:db|sqlite)(?:$|-)|\.(?:db|sqlite)-(?:wal|shm)$/ },
  { name: "log artifact", regex: /\.log$/ },
  { name: "Desktop dogfood package", regex: /Friday-real-user-dogfood/ },
  { name: "Desktop release package", regex: /Friday-release-closure/ },
  { name: "Desktop global execution package", regex: /Friday-global-execution/ },
  { name: "Friday Map package", regex: /Friday Map/ },
  { name: "finding master package", regex: /finding\/_master|Finding\/_master/ },
];

const ARCHIVE_EXCLUDED_PATTERNS = [
  /^AGENTS\.md$/,
  /^context\/AGENTS\.md$/,
  /^\.secrets\.baseline$/,
  /^AUDIT-REPORT\.md$/,
  /^OVERNIGHT-TASK-SUMMARY\.csv$/,
  /^qa-report\.html$/,
  /^docs\/archive(?:\/|$)/,
  /^docs\/audit(?:\/|$)/,
  /^docs\/task(?:\/|$)/,
  /^docs\/reports\/benchmark(?:\/|$)/,
  /^reports(?:\/|$)/,
  /^test(?:\/|$)/,
  /^tests(?:\/|$)/,
  /^tests-overnight(?:\/|$)/,
];

const findings = [];
const stats = {
  trackedFiles: 0,
  packFiles: 0,
  archiveFiles: 0,
  scannedContentFiles: 0,
};

function run(command, argsList, options = {}) {
  return execFileSync(command, argsList, {
    cwd: root,
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function addFinding(scope, filePath, message, detail = "") {
  findings.push({ scope, path: filePath, message, detail });
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function isAllowlistedLine(line) {
  const normalized = line.toLowerCase();
  return ALLOWLIST_HINTS.some((hint) => normalized.includes(hint.toLowerCase()));
}

function looksText(buffer, filePath) {
  const ext = path.extname(filePath);
  if (!TEXT_EXTENSIONS.has(ext)) return false;
  if (buffer.includes(0)) return false;
  return true;
}

function scanContentFile(scope, relativePath, absolutePath) {
  if (relativePath === ".gitattributes") return;

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return;
  }
  if (!looksText(buffer, relativePath)) return;

  stats.scannedContentFiles += 1;
  const text = buffer.toString("utf8");
  const lines = text.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (relativePath === "scripts/quality/check-public-source-hygiene.mjs" && /regex:\s*\//.test(line)) {
      continue;
    }
    if (isAllowlistedLine(line)) continue;
    for (const pattern of CONTENT_PATTERNS) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(line)) {
        addFinding(scope, `${relativePath}:${lineIndex + 1}`, pattern.name, line.trim().slice(0, 220));
      }
    }
  }
}

function checkPathList(scope, files) {
  for (const filePath of files) {
    for (const pattern of FORBIDDEN_PATH_PATTERNS) {
      if (pattern.regex.test(filePath)) {
        addFinding(scope, filePath, pattern.name);
      }
    }
  }
}

function trackedFiles() {
  const raw = run("git", ["ls-files", "-z"]);
  return raw.split("\0").filter(Boolean);
}

function walk(dirPath, prefix = "") {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath, relativePath));
      continue;
    }
    files.push(relativePath);
  }
  return files;
}

function scanFiles(scope, files, baseDir = root) {
  checkPathList(scope, files);
  for (const filePath of files) {
    scanContentFile(scope, filePath, path.join(baseDir, filePath));
  }
}

function checkTrackedFiles() {
  const files = trackedFiles();
  stats.trackedFiles = files.length;
  scanFiles("tracked", files);
}

function checkNpmPack() {
  const raw = run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]);
  const pack = JSON.parse(raw)[0];
  const files = pack?.files?.map((file) => file.path) ?? [];
  stats.packFiles = files.length;
  checkPathList("npm-pack", files);
  for (const filePath of files) {
    scanContentFile("npm-pack", filePath, path.join(root, filePath));
  }
}

function checkGitArchive() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-source-hygiene-"));
  const tarPath = path.join(tmpDir, "source.tar");
  run("git", ["archive", "--format=tar", "--worktree-attributes", "-o", tarPath, "HEAD"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const listRaw = execFileSync("tar", ["-tf", tarPath], { encoding: "utf8" });
  const files = listRaw.split(/\r?\n/).filter(Boolean).map((file) => file.replace(/\/$/, ""));
  stats.archiveFiles = files.length;

  for (const filePath of files) {
    for (const pattern of ARCHIVE_EXCLUDED_PATTERNS) {
      if (pattern.test(filePath)) {
        addFinding("git-archive-list", filePath, "export-ignore did not exclude expected internal file");
      }
    }
  }
  checkPathList("git-archive-list", files);

  const extractDir = path.join(tmpDir, "extract");
  fs.mkdirSync(extractDir);
  execFileSync("tar", ["-xf", tarPath, "-C", extractDir], { stdio: ["ignore", "ignore", "pipe"] });
  scanFiles("git-archive-content", walk(extractDir), extractDir);
}

function checkExternalPath() {
  if (!fs.existsSync(root)) {
    console.error(`Path does not exist: ${root}`);
    process.exit(1);
  }
  const files = walk(root);
  scanFiles("path", files, root);
}

if (repoMode) {
  checkTrackedFiles();
  checkNpmPack();
  checkGitArchive();
} else {
  checkExternalPath();
}

if (findings.length > 0) {
  console.error("Public source hygiene check failed:");
  for (const finding of findings.slice(0, 120)) {
    const detail = finding.detail ? `\n    ${finding.detail}` : "";
    console.error(`- [${finding.scope}] ${finding.path}: ${finding.message}${detail}`);
  }
  if (findings.length > 120) {
    console.error(`... and ${findings.length - 120} more finding(s)`);
  }
  process.exit(1);
}

console.log("Public source hygiene check passed.");
console.log(JSON.stringify(stats, null, 2));
