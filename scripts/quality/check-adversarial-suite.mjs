#!/usr/bin/env node
/**
 * MECHANISM-3: Security Regression Gate (suite integrity check)
 *
 * Validates:
 * 1. Adversarial test files exist in test/adversarial/
 * 2. No tests are skipped — catches all skip variants with precise file:line
 * 3. Expected adversarial categories are covered
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { detectSkippedTests } from "./skip-detection.mjs";

const ADVERSARIAL_DIR = "test/adversarial";

const EXPECTED_CATEGORIES = [
  "auth",
  "ssrf",
  "path-traversal",
  "input-validation",
  "resource-exhaustion",
  "concurrency",
];

let errors = 0;

function fail(msg) {
  console.error(`❌ ${msg}`);
  errors++;
}

function ok(msg) {
  console.log(`✅ ${msg}`);
}

// 1. Scan test files
let testFiles;
try {
  const files = await readdir(ADVERSARIAL_DIR);
  testFiles = files.filter((f) => f.endsWith(".test.ts"));
} catch {
  fail(`Directory ${ADVERSARIAL_DIR} does not exist`);
  process.exit(1);
}

if (testFiles.length === 0) {
  fail("No adversarial test files found");
  process.exit(1);
}

ok(`Found ${testFiles.length} adversarial test files`);

// 2. Check for skipped tests using shared detector (full-content, catches all patterns)
let skippedCount = 0;

for (const f of testFiles) {
  const content = await readFile(join(ADVERSARIAL_DIR, f), "utf-8");
  const findings = detectSkippedTests(content);

  for (const { line, label } of findings) {
    fail(`${f}:${line}: skipped test detected (${label})`);
    skippedCount++;
  }
}

if (skippedCount === 0) {
  ok("No skipped tests detected");
}

// 3. Check expected categories are covered
const fileNames = testFiles.map((f) => f.toLowerCase());
for (const cat of EXPECTED_CATEGORIES) {
  const found = fileNames.some((f) => f.includes(cat));
  if (!found) {
    fail(`Missing adversarial test category: ${cat}`);
  } else {
    ok(`Category covered: ${cat}`);
  }
}

if (errors > 0) {
  console.error(`\n💥 ${errors} adversarial suite error(s) found`);
  process.exit(1);
} else {
  console.log("\n🎉 Adversarial test suite integrity: all checks passed");
}
