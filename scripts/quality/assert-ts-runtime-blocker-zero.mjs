#!/usr/bin/env node
/**
 * TS-Runtime-Retirement: blocker==0 assertion.
 *
 * Companion gate to scripts/quality/check-ts-runtime-retirement.mjs.
 *
 * The validator enforces classification COMPLETENESS and WELL-FORMEDNESS: every
 * discovered HTTP route must be classified, and each classification must carry
 * its required metadata. It deliberately exits 0 even when a route is *validly*
 * classified `ts_runtime_blocker` (with owner/blocker/next_action). So
 * "validator green" does NOT by itself prove "ts_runtime_blocker == 0".
 *
 * This assertion closes that gap so a reintroduced / unclassified-then-caught
 * route cannot silently regress `ts_runtime_blocker=0`. It parses the
 * validator's JSON report and fails if ANY route is actually classified as a
 * TS-runtime blocker (summary.blockerFamilies non-empty, or a
 * ts_runtime_blocker bucket present in summary.byClassification).
 *
 * NOTE on why we do NOT grep the manifest for "ts_runtime_blocker": the
 * manifest intentionally declares catch-all `ts_runtime_blocker` route families
 * (e.g. agent_runtime_blockers) that currently match ZERO live routes. Grepping
 * would false-positive against those definitions. The validator's summary
 * reflects only routes that ACTUALLY match a blocker classification, which is
 * the truth we must gate on.
 *
 * Node: builtins only — no dependencies, no `npm ci` required.
 *
 * Usage: node scripts/quality/assert-ts-runtime-blocker-zero.mjs <report.json>
 *   where <report.json> is the stdout of check-ts-runtime-retirement.mjs.
 */

import fs from "node:fs";

function fail(message) {
  console.error(`❌ ts_runtime_blocker assertion FAILED: ${message}`);
  process.exit(1);
}

const reportPath = process.argv[2];
if (!reportPath) {
  fail("usage: assert-ts-runtime-blocker-zero.mjs <validator-report.json>");
}

let report;
try {
  report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
} catch (error) {
  fail(`could not read/parse validator report at ${reportPath}: ${error.message}`);
}

if (report.status !== "passed") {
  fail(`validator status is "${report.status}", expected "passed" (run the validator first)`);
}

const summary = report.summary;
if (!summary || typeof summary !== "object") {
  fail("validator report has no summary object");
}

if (!Array.isArray(summary.blockerFamilies)) {
  fail("summary.blockerFamilies is missing or not an array");
}

const blockerBucket = summary.byClassification?.ts_runtime_blocker ?? 0;

if (summary.blockerFamilies.length !== 0 || blockerBucket !== 0) {
  fail(
    `${summary.blockerFamilies.length} blocker family/families and ${blockerBucket} `
    + `ts_runtime_blocker route(s) present: ${JSON.stringify(summary.blockerFamilies)}. `
    + "A route is classified ts_runtime_blocker — TS runtime is NOT retired for it. "
    + "Resolve it (rust_delegated / fail_closed / etc.) before this gate can pass.",
  );
}

console.log(
  `✅ ts_runtime_blocker == 0 (routeCount=${report.routeCount}, `
  + "blockerFamilies=[], no ts_runtime_blocker routes).",
);
