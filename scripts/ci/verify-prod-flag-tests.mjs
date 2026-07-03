#!/usr/bin/env node
/**
 * Registry gap #27 — the CI methodology gate:
 *   "Every prod-ON loop flag has a passing loop e2e test."
 *
 * This is the single recurrence-prevention gate behind the L0 silently-inert-loop
 * disaster (loops shipped with their flags ON in prod while NO committed test drove
 * the loop to its outcome). The flag<->test mapping is a committed artifact in
 * docs/ops/prod-flags-manifest.json; THIS script makes that mapping CI-enforced.
 *
 * What it checks (deterministic, fast, no compiler / no test execution):
 *   1. The manifest is well-formed JSON with the required shape.
 *   2. Every flag with prod_state in (on, dark) names an e2e_test of the form
 *      "<relative/file/path>::<test_fn_name>".
 *   3. Any additional_e2e_tests entries use the same form.
 *   4. The named test file EXISTS and contains the named test function
 *      (Rust:  `fn <name>`  ·  vitest/TS:  `it("<name>"...)` or `test("<name>"...)`).
 *   5. Rust mappings are not `#[ignore]` / `cfg_attr(..., ignore)`, because ignored
 *      tests never run in PR CI.
 *   6. No duplicate flag entries; coverage is a known value.
 *
 * It FAILS (exit 1), naming the offending flag, on any missing/unmapped/unresolvable/
 * ignored test. It does NOT verify the live wrapper/plist actually sets these flags — that
 * drift check is deploy-time (see docs/ops/prod-flag-test-gate.md). It does NOT run
 * the tests; "passing" is enforced by the existing test jobs (rust-core.yml + the
 * `test` job) — this gate enforces that the mapping EXISTS and resolves so a flag can
 * never go prod-ON with no committed loop test.
 *
 * Honesty note: a `destination-only` coverage value is a RECORDED gap, not a pass-by-
 * weakening — the named test still must exist + resolve. The gate's job is to surface
 * the mapping, not to launder it.
 */

import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fileDeclaresTest,
  parseTestRef,
  resolveRustTest,
} from "./lib/prod-flag-test-detect.mjs";

const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = process.env.FRIDAY_PROD_FLAGS_REPO_ROOT
  ? resolve(process.env.FRIDAY_PROD_FLAGS_REPO_ROOT)
  : DEFAULT_REPO_ROOT;
const MANIFEST_PATH = process.env.FRIDAY_PROD_FLAGS_MANIFEST_PATH
  ? resolve(process.env.FRIDAY_PROD_FLAGS_MANIFEST_PATH)
  : join(REPO_ROOT, "docs", "ops", "prod-flags-manifest.json");

const ENFORCED_STATES = new Set(["on", "dark"]);
const KNOWN_STATES = new Set(["on", "dark"]);
const KNOWN_PROCESSES = new Set(["rust-ws-wrapper", "ts-plist"]);
const KNOWN_COVERAGE = new Set(["loop-e2e", "destination-only"]);

let errors = 0;

function fail(msg) {
  console.error(`❌ ${msg}`);
  errors++;
}

function ok(msg) {
  console.log(`✅ ${msg}`);
}

// ── 1. Load + parse the manifest ──
let manifest;
try {
  manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf-8"));
} catch (err) {
  console.error(`❌ Could not read/parse ${MANIFEST_PATH}: ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(manifest.flags) || manifest.flags.length === 0) {
  fail("manifest.flags must be a non-empty array");
  process.exit(1);
}

// ── 2. Validate each flag entry + resolve its e2e_test ──
const seenFlags = new Set();
let enforcedCount = 0;
let loopE2eCount = 0;
let destinationOnlyCount = 0;

async function checkTestRef(label, prodState, ref, fieldName) {
  const parsed = parseTestRef(ref);
  if (!parsed) {
    fail(
      `${label} (prod_state=${prodState}): "${fieldName}" is missing or not of the form ` +
        `"<file/path>::<test_fn_name>" (got ${JSON.stringify(ref)}). ` +
        `A prod-${prodState} flag MUST name a loop-closing test — this is the registry-#27 gap.`
    );
    return;
  }

  const absFile = join(REPO_ROOT, parsed.file);
  try {
    await access(absFile, constants.R_OK);
  } catch {
    fail(
      `${label} (prod_state=${prodState}): mapped test FILE does not exist: ${parsed.file} ` +
        `(referenced by ${fieldName} ${JSON.stringify(ref)})`
    );
    return;
  }

  const content = await readFile(absFile, "utf-8");
  if (!fileDeclaresTest(content, parsed.fn)) {
    fail(
      `${label} (prod_state=${prodState}): mapped test FUNCTION "${parsed.fn}" not found in ${parsed.file}. ` +
        `Expected a Rust \`fn ${parsed.fn}(\` or a vitest it/test("${parsed.fn}"). ` +
        `If the test was renamed/removed, update the manifest — a prod-${prodState} flag may not be left without a loop test.`
    );
    return;
  }

  const rustResolution = parsed.file.endsWith(".rs")
    ? resolveRustTest(content, parsed.fn)
    : null;
  if (rustResolution?.ignored) {
    fail(
      `${label} (prod_state=${prodState}): mapped test "${parsed.fn}" in ${parsed.file} is #[ignore]'d. ` +
        `An ignored test never runs in PR CI, so a prod-${prodState} flag mapped to it is silently inert. ` +
        `Un-ignore the test, or map to a committed test that runs in PR CI.`
    );
    return;
  }

  ok(`${label} (${prodState}, ${fieldName}) -> ${parsed.file}::${parsed.fn}`);
}

for (let i = 0; i < manifest.flags.length; i++) {
  const entry = manifest.flags[i];
  const label = entry && entry.flag ? entry.flag : `flags[${i}]`;

  if (!entry || typeof entry.flag !== "string" || entry.flag.length === 0) {
    fail(`flags[${i}]: missing/invalid "flag" name`);
    continue;
  }
  if (seenFlags.has(entry.flag)) {
    fail(`${label}: duplicate flag entry`);
    continue;
  }
  seenFlags.add(entry.flag);

  if (!KNOWN_PROCESSES.has(entry.process)) {
    fail(`${label}: "process" must be one of ${[...KNOWN_PROCESSES].join(" | ")} (got ${JSON.stringify(entry.process)})`);
  }
  if (!KNOWN_STATES.has(entry.prod_state)) {
    fail(`${label}: "prod_state" must be one of ${[...KNOWN_STATES].join(" | ")} (got ${JSON.stringify(entry.prod_state)})`);
    continue;
  }
  if (!KNOWN_COVERAGE.has(entry.coverage)) {
    fail(`${label}: "coverage" must be one of ${[...KNOWN_COVERAGE].join(" | ")} (got ${JSON.stringify(entry.coverage)})`);
  }
  if (typeof entry.closes_loop !== "string" || entry.closes_loop.trim().length === 0) {
    fail(`${label}: "closes_loop" must be a non-empty one-line description`);
  }

  // Only flags that are or will be live (on|dark) MUST carry a resolvable loop test.
  if (!ENFORCED_STATES.has(entry.prod_state)) continue;
  enforcedCount++;
  if (entry.coverage === "loop-e2e") loopE2eCount++;
  if (entry.coverage === "destination-only") destinationOnlyCount++;

  await checkTestRef(label, entry.prod_state, entry.e2e_test, "e2e_test");

  if (entry.additional_e2e_tests !== undefined) {
    if (!Array.isArray(entry.additional_e2e_tests)) {
      fail(`${label}: "additional_e2e_tests" must be an array when present`);
    } else {
      for (const [index, ref] of entry.additional_e2e_tests.entries()) {
        await checkTestRef(
          label,
          entry.prod_state,
          ref,
          `additional_e2e_tests[${index}]`
        );
      }
    }
  }
}

// ── 3. Summary + exit ──
console.log("");
console.log(
  `Summary: ${enforcedCount} enforced flag(s) [on|dark] | ` +
    `${loopE2eCount} loop-e2e | ${destinationOnlyCount} destination-only.`
);
if (destinationOnlyCount > 0) {
  console.log(
    `Note: ${destinationOnlyCount} flag(s) are coverage="destination-only" — the destination loop is ` +
      `tested but the flag's own routing/on-ramp is NOT closed end-to-end in PR CI (recorded, not a fail).`
  );
}

if (errors > 0) {
  console.error(`\n💥 ${errors} prod-flag-test mapping error(s) found`);
  console.error(
    `Registry gap #27: every prod-ON (and dark) loop flag must name an existing loop-closing test in ` +
      `docs/ops/prod-flags-manifest.json. Fix the mapping or add the missing test — do NOT delete the flag entry.`
  );
  process.exit(1);
}

console.log("\n🎉 prod-flag-test gate: every enforced flag maps to an existing loop test");
