#!/usr/bin/env node
/**
 * NAIVE PLACEHOLDER (RED-FIRST) — intentionally incomplete.
 *
 * This is the deliberately-wrong first cut committed to prove the contract
 * test fails BEHAVIORALLY (assertion failure), not structurally (ENOENT):
 * it reads both inventories but performs NO reconciliation and always reports
 * status "passed". The ghost/required_unobserved/sha_mismatch/duplicate_id
 * negative controls therefore see a passing verdict where the contract demands
 * "blocked". Replaced by the real deterministic reconciler in the GREEN commit.
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);

function arg(name) {
  const prefix = `--${name}=`;
  for (let i = 0; i < args.length; i += 1) {
    const v = args[i];
    if (v.startsWith(prefix)) return v.slice(prefix.length);
    if (v === `--${name}` && args[i + 1]) return args[i + 1];
  }
  return "";
}

const registryPath = arg("registry");
const observedPath = arg("observed");

// NAIVE: read (so failures are behavioral, not ENOENT) but do NOT validate or
// reconcile. No shape validation on purpose — malformed input still "passes".
JSON.parse(readFileSync(registryPath, "utf8"));
JSON.parse(readFileSync(observedPath, "utf8"));

const report = {
  truth: "artifact_inventory_reconcile",
  status: "passed",
  generated_at_utc: new Date().toISOString(),
  inputs: { registry: registryPath, observed: observedPath },
  summary: {
    registryElementCount: 0,
    observedElementCount: 0,
    ghostElementCount: 0,
    requiredUnobservedCount: 0,
    shaMismatchCount: 0,
    duplicateIdCount: 0,
  },
  blockers: [],
  caveat: "NAIVE placeholder — no reconciliation performed.",
};

console.log(JSON.stringify(report, null, 2));
process.exit(0);
