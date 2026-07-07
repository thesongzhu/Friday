#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readChangedFiles(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function declarationValue(body, label) {
  const prefix = `${label}:`;
  const line = body
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry.toLowerCase().startsWith(prefix.toLowerCase()));
  if (!line) return null;
  return line.slice(prefix.length).trim();
}

function hasConcreteDeclaration(body, label, predicate) {
  const value = declarationValue(body, label);
  if (!value) return false;
  if (/\b(todo|tbd|placeholder|unknown|none|n\/a|not applicable|pending|later|skip|skipped)\b/iu.test(value)) {
    return false;
  }
  return predicate(value);
}

const eventPath = argValue("--event") ?? process.env.GITHUB_EVENT_PATH;
const changedFilesPath = argValue("--changed-files");

if (!eventPath) {
  console.error("Missing GitHub event path. Pass --event or set GITHUB_EVENT_PATH.");
  process.exit(1);
}

if (!changedFilesPath) {
  console.error("Missing changed files path. Pass --changed-files.");
  process.exit(1);
}

const event = readJson(resolve(eventPath));
const pullRequest = event.pull_request;

if (!pullRequest) {
  console.log("prod parity PR body gate skipped: not a pull_request event");
  process.exit(0);
}

const body = typeof pullRequest.body === "string" ? pullRequest.body : "";
const changedFiles = readChangedFiles(resolve(changedFilesPath));

const lockfileChanged = changedFiles.some((file) => (
  file === "pnpm-lock.yaml" || file === "package-lock.json" || file === "rust-core/Cargo.lock"
));

const schemaChanged = changedFiles.some((file) => (
  file === "rust-core/crates/friday-storage/src/schema.rs"
  || file === "rust-core/crates/friday-storage/tests/schema_profile.rs"
  || file === "rust-core/crates/friday-storage/tests/migration.rs"
  || file === "src/state/sqlite/friday-rust-hub-schema-handshake.ts"
  || file.startsWith("src/state/sqlite/migrations/")
  || file.startsWith("rust-core/crates/friday-storage/migrations/")
  || file.startsWith("rust-core/crates/friday-storage/src/migrations/")
));

const missing = [];

const hasNativeModuleBuildProof = hasConcreteDeclaration(
  body,
  "Native module build proof",
  (value) => (
    value.length >= 20
    && /\b(build|built|rebuild|rebuilt|compile|compiled|install|installed|npm ci|pnpm install|pnpm rebuild|better-sqlite3|native modules?|\.node|node-gyp|prebuild)\b/iu.test(value)
  ),
);

const hasRustRestartDeclaration = hasConcreteDeclaration(
  body,
  "Deployment restart required",
  (value) => (
    /\bRust services\b/u.test(value)
    && /\b(restart|restarted|kickstart|kickstarted|redeploy|roll|bounce)\b/iu.test(value)
  ),
);

if (lockfileChanged && !hasNativeModuleBuildProof) {
  missing.push("Native module build proof: <concrete native-module build command/result, not TODO or placeholder>");
}

if (schemaChanged && !hasRustRestartDeclaration) {
  missing.push("Deployment restart required: Rust services; <concrete restart/kickstart sequence>");
}

if (missing.length > 0) {
  console.error("PR body is missing required prod-parity deployment declarations:");
  for (const item of missing) {
    console.error(`- ${item}`);
  }
  console.error(`Changed files: ${changedFiles.join(", ")}`);
  process.exit(1);
}

console.log("prod parity PR body gate ok");
