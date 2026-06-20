#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifestPath = join(repoRoot, "docs", "ops", "ts-runtime-retirement-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const files = [
  ...new Set(
    (manifest.methodRetiredSurfaces?.surfaces ?? [])
      .map((surface) => surface.behavioralTest)
      .filter((value) => typeof value === "string" && value.length > 0),
  ),
].sort();

if (files.length === 0) {
  console.error("No method-retired behavioral tests are declared in ts-runtime-retirement-manifest.json");
  process.exit(1);
}

const missing = files.filter((file) => !existsSync(join(repoRoot, file)));
if (missing.length > 0) {
  console.error("Missing method-retired behavioral test file(s):");
  for (const file of missing) console.error(`- ${file}`);
  process.exit(1);
}

console.log(`Running ${files.length} unique method-retired behavioral test file(s) from ts-runtime-retirement-manifest.json`);
for (const file of files) console.log(`- ${file}`);

const result = spawnSync("npx", ["vitest", "run", ...files], {
  cwd: repoRoot,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
