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
import { PROMOTED_BENCHMARK_STRONG_REGRESSION_CASE_IDS } from "../benchmark/friday-openclaw-promoted-gap-cases.mjs";

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
const fileContents = new Map();

for (const f of testFiles) {
  const content = await readFile(join(ADVERSARIAL_DIR, f), "utf-8");
  fileContents.set(f, content);
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

const combinedContent = [...fileContents.values()].join("\n");

const STRUCTURAL_MARKERS = [
  {
    label: "artifact-truth / truth-alignment coverage",
    pattern: /STRUCT-ARTIFACT-TRUTH-\d+/,
  },
  {
    label: "approval-boundary structural coverage",
    pattern: /STRUCT-APPROVAL-BOUNDARY-\d+/,
  },
  {
    label: "promoted benchmark-gap coverage",
    pattern: /STRUCT-BENCHMARK-GAP-/,
  },
];

for (const marker of STRUCTURAL_MARKERS) {
  if (!marker.pattern.test(combinedContent)) {
    fail(`Missing ${marker.label} in adversarial suite`);
  } else {
    ok(`Structural marker covered: ${marker.label}`);
  }
}

for (const caseId of PROMOTED_BENCHMARK_STRONG_REGRESSION_CASE_IDS) {
  const promotedMarker = `STRUCT-BENCHMARK-GAP-${caseId}`;
  if (!combinedContent.includes(promotedMarker)) {
    fail(`Missing promoted benchmark regression marker: ${promotedMarker}`);
  } else {
    ok(`Promoted benchmark regression covered: ${caseId}`);
  }
}

if (errors > 0) {
  console.error(`\n💥 ${errors} adversarial suite error(s) found`);
  process.exit(1);
} else {
  console.log("\n🎉 Adversarial test suite integrity: all checks passed");
}
