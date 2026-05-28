#!/usr/bin/env node

/**
 * CLI validator for the Real Green Gate result artifact.
 *
 * Usage:
 *   node scripts/ops/validate-real-green-gate-result.mjs \
 *     --path <real-green-gate-result.json> \
 *     [--expected-sha <40-char-hex>]
 *
 * Exits 0 only when the artifact validates as a clean release-proof pass.
 * Exits 1 otherwise. Stdout always carries a JSON object describing the
 * decision; rejection reasons are stable token strings (no validator
 * free-text).
 *
 * P4-G1.1: this CLI is intentionally NOT yet invoked from any workflow.
 * `.github/workflows/release.yml` is left untouched in this subphase. The
 * downstream P4-G1.2 subphase will wire this CLI into a release-time gate.
 */

import { readFileSync } from "node:fs";
import {
  REAL_GREEN_GATE_RESULT_FILENAME,
  validateRealGreenGateResult,
} from "./lib/real-green-gate-result.mjs";

function parseArgs(argv) {
  const args = { path: null, expectedSha: null, requiredEvidenceKinds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === "--path" && typeof next === "string") {
      args.path = next;
      index += 1;
    } else if (token === "--expected-sha" && typeof next === "string") {
      args.expectedSha = next;
      index += 1;
    } else if (token === "--required-evidence-kind" && typeof next === "string") {
      args.requiredEvidenceKinds.push(next);
      index += 1;
    }
  }
  return args;
}

function emit(decision) {
  process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.path) {
    emit({
      valid: false,
      reasons: ["cli_argument_missing:path"],
      hint: `Pass --path <path-to-${REAL_GREEN_GATE_RESULT_FILENAME}>`,
    });
    process.exit(1);
  }

  let raw;
  try {
    raw = readFileSync(args.path, "utf8");
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "unknown";
    emit({
      valid: false,
      reasons: [`artifact_unreadable:${code}`],
      path: args.path,
    });
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    emit({
      valid: false,
      reasons: ["artifact_invalid_json"],
      path: args.path,
    });
    process.exit(1);
  }

  const decision = validateRealGreenGateResult(parsed, {
    expectedSha: args.expectedSha ?? undefined,
    requiredEvidenceKinds: args.requiredEvidenceKinds,
  });

  emit({
    valid: decision.valid,
    reasons: decision.reasons,
    path: args.path,
    expected_sha: args.expectedSha ?? null,
    required_evidence_kinds: args.requiredEvidenceKinds,
    observed_sha: typeof parsed?.commit_sha === "string" ? parsed.commit_sha : null,
    observed_status: typeof parsed?.status === "string" ? parsed.status : null,
  });

  process.exit(decision.valid ? 0 : 1);
}

main();
