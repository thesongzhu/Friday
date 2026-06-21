#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifestPath = join(repoRoot, "docs", "ops", "ts-runtime-retirement-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

const methodRetiredBehavioralTests = (manifest.methodRetiredSurfaces?.surfaces ?? [])
  .map((surface) => surface.behavioralTest)
  .filter(nonEmptyString);

const routeSurfacesById = new Map((manifest.surfaces ?? []).map((surface) => [surface.id, surface]));
const routeBehaviorSurfaceIds = [
  ...(manifest.discovery?.requiredRouteBehaviorTestSurfaceIds ?? []),
  ...(manifest.discovery?.requiredGovernedRouteBehaviorTestSurfaceIds ?? []),
].filter(nonEmptyString);
const missingRouteBehaviorSurfaces = [];
const routeBehavioralTests = [];
for (const surfaceId of routeBehaviorSurfaceIds) {
  const surface = routeSurfacesById.get(surfaceId);
  if (!nonEmptyString(surface?.routeBehavioralTest)) {
    missingRouteBehaviorSurfaces.push(surfaceId);
    continue;
  }
  routeBehavioralTests.push(surface.routeBehavioralTest);
}

if (missingRouteBehaviorSurfaces.length > 0) {
  console.error("Missing route behavioral test declaration(s):");
  for (const surfaceId of missingRouteBehaviorSurfaces) console.error(`- ${surfaceId}`);
  process.exit(1);
}

const files = [...new Set([...methodRetiredBehavioralTests, ...routeBehavioralTests])].sort();

if (files.length === 0) {
  console.error("No TS-runtime retirement behavioral tests are declared in ts-runtime-retirement-manifest.json");
  process.exit(1);
}

const missing = files.filter((file) => !existsSync(join(repoRoot, file)));
if (missing.length > 0) {
  console.error("Missing TS-runtime retirement behavioral test file(s):");
  for (const file of missing) console.error(`- ${file}`);
  process.exit(1);
}

console.log(
  `Running ${files.length} unique TS-runtime retirement behavioral test file(s) ` +
    `(${new Set(methodRetiredBehavioralTests).size} method-retired, ` +
    `${new Set(routeBehavioralTests).size} route/governed-route) from ts-runtime-retirement-manifest.json`,
);
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
