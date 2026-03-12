#!/usr/bin/env node
/**
 * Scan test files for skipped tests using the shared skip-detection module.
 *
 * Usage:
 *   node scripts/quality/check-skipped-tests.mjs --root test --max 0
 *
 * Options:
 *   --root <dir>    Directory to scan recursively (default: "test")
 *   --max <number>  Maximum allowed skipped tests (default: 0)
 *
 * Exits non-zero when the count exceeds --max.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { detectSkippedTests } from "./skip-detection.mjs";

// ── Parse CLI args ──
const args = process.argv.slice(2);
let root = "test";
let maxRaw;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--root" && args[i + 1]) {
    root = args[++i];
  } else if (args[i] === "--max" && args[i + 1]) {
    maxRaw = args[++i];
  }
}

// Strict --max validation: must be a non-negative integer (digits only)
if (maxRaw === undefined) {
  console.error("❌ Error: --max <number> is required (non-negative integer)");
  process.exit(2);
}
if (!/^\d+$/.test(maxRaw)) {
  console.error(`❌ Error: --max value "${maxRaw}" is not a valid non-negative integer`);
  process.exit(2);
}
const max = Number(maxRaw);
if (!Number.isFinite(max) || max < 0) {
  console.error(`❌ Error: --max value "${maxRaw}" is not a valid non-negative integer`);
  process.exit(2);
}

// ── Recursively collect *.ts files ──
async function collectTsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTsFiles(full)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

// ── Main ──
const files = await collectTsFiles(root);
let total = 0;

for (const file of files) {
  const content = await readFile(file, "utf-8");
  const findings = detectSkippedTests(content);
  for (const { line, label } of findings) {
    console.log(`${file}:${line}  ${label}`);
    total++;
  }
}

console.log(`\nSkipped tests found: ${total} (threshold: ${max})`);

if (total > max) {
  console.error(`❌ Skipped tests (${total}) exceed threshold (${max})`);
  process.exit(1);
} else {
  console.log(`✅ Skipped tests within threshold`);
}
