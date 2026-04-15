#!/usr/bin/env node

/**
 * Release Check — MECHANISM 3
 *
 * Validates that `npm pack` would produce a correct release artifact:
 *   - Required files are present
 *   - Forbidden files are excluded
 *   - bin target exists in packed files
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

// ── Load package.json ──
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

// ── Required files / directory prefixes ──
const REQUIRED_PATTERNS = [
  // dist output directories
  "dist/cli/",
  "dist/api/",
  "dist/hub/",
  "dist/state/",
  // Root files
  "README.md",
  "LICENSE",
  "package.json",
];

// ── Forbidden patterns (regex) ──
const FORBIDDEN_PATTERNS = [
  /^\.env(?!\.example)/,   // .env, .env.local etc — but allow .env.example
  /^\.friday\//,
  /^data\//,
  /\.db$/,
  /\.sqlite/,
  /^coverage\//,
  /\.test\./,
  /^test\//,
];

function run() {
  console.log("── Release Check ──\n");

  // ── Step 0: Verify package.json "files" field ──
  console.log("0. Checking package.json files field…");
  if (!Array.isArray(pkg.files)) {
    console.error('   ✗ package.json is missing a "files" allowlist');
    process.exit(1);
  }
  if (!pkg.files.some(f => f.startsWith("dist/"))) {
    console.error('   ✗ package.json "files" must include at least one dist/ glob');
    process.exit(1);
  }
  console.log("   ✓ files field present and includes dist/ globs\n");

  // ── Step 1: npm pack --dry-run --json ──
  console.log("1. Running npm pack --dry-run…");
  let packJson;
  try {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const raw = execFileSync(npmCmd, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    packJson = JSON.parse(raw);
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : "";
    console.error("   ✗ npm pack --dry-run failed:", err.message);
    if (stderr) console.error("   stderr:", stderr);
    process.exit(1);
  }

  const files = packJson[0]?.files?.map((f) => f.path) ?? [];
  console.log(`   → ${files.length} files in pack output\n`);

  let passed = true;

  // ── Step 2: Required files ──
  console.log("2. Required files:");
  for (const pattern of REQUIRED_PATTERNS) {
    const found = files.some((f) =>
      pattern.endsWith("/") ? f.startsWith(pattern) : f === pattern,
    );
    const icon = found ? "✓" : "✗";
    console.log(`   ${icon} ${pattern}`);
    if (!found) passed = false;
  }

  // ── Step 3: Forbidden patterns ──
  console.log("\n3. Forbidden patterns:");
  for (const re of FORBIDDEN_PATTERNS) {
    const matches = files.filter((f) => re.test(f));
    if (matches.length > 0) {
      console.log(`   ✗ ${re.toString()} → matched ${matches.length} file(s):`);
      for (const m of matches.slice(0, 5)) {
        console.log(`       ${m}`);
      }
      if (matches.length > 5) console.log(`       … and ${matches.length - 5} more`);
      passed = false;
    } else {
      console.log(`   ✓ ${re.toString()} → no matches`);
    }
  }

  // ── Step 4: Bin target ──
  console.log("\n4. Bin target validation:");
  const binEntries = pkg.bin || {};
  for (const [name, target] of Object.entries(binEntries)) {
    // bin targets are relative to package root; strip leading "./"
    const normalised = target.replace(/^\.\//, "");
    const found = files.includes(normalised);
    const icon = found ? "✓" : "✗";
    console.log(`   ${icon} ${name} → ${normalised}`);
    if (!found) passed = false;
  }

  // ── Summary ──
  console.log(`\n── Summary: ${files.length} files packed ──`);

  if (passed) {
    console.log("✅ Release check passed\n");
    process.exit(0);
  } else {
    console.log("❌ Release check FAILED\n");
    process.exit(1);
  }
}

run();
