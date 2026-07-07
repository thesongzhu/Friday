#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname, "..");
const packageJsonPath = resolve(repoRoot, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

const requiredNativeBuilds = ["better-sqlite3"];
const configured = packageJson.pnpm?.onlyBuiltDependencies;

if (!Array.isArray(configured)) {
  console.error("package.json must define pnpm.onlyBuiltDependencies for native postinstall builds.");
  process.exit(1);
}

const missing = requiredNativeBuilds.filter((dependencyName) => !configured.includes(dependencyName));
if (missing.length > 0) {
  console.error(`pnpm.onlyBuiltDependencies is missing native build dependencies: ${missing.join(", ")}`);
  process.exit(1);
}

const extra = configured.filter((dependencyName) => !requiredNativeBuilds.includes(dependencyName));
if (extra.length > 0) {
  console.error(`pnpm.onlyBuiltDependencies contains unaudited entries: ${extra.join(", ")}`);
  process.exit(1);
}

console.log(`pnpm native build allowlist ok: ${configured.join(", ")}`);
