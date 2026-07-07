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
  file === "pnpm-lock.yaml" || file === "package-lock.json"
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

if (lockfileChanged && !/Native module build proof:\s*\S/i.test(body)) {
  missing.push("Native module build proof: <how this PR proved native modules such as better-sqlite3 can build>");
}

if (schemaChanged && !/Deployment restart required:\s*Rust services\b/i.test(body)) {
  missing.push("Deployment restart required: Rust services");
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
