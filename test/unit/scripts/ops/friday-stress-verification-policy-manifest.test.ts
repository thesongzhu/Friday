/**
 * TEST-STRESS-POLICY-BINDING-001 — verification-policy-manifest generator.
 *
 * Focused, red-first structural test for
 * `scripts/ops/friday-stress-verification-policy-manifest.mjs`, which derives the
 * `verification_policy_set_sha256` tuple component from the 9 declared policy
 * inputs of the R13 stress overlay's `candidate_policy.verification_policy_covers`.
 *
 * Self-contained: it builds a SYNTHETIC minimal declared-sources tree in a temp
 * dir (the real R13 sources live outside the repo, so a committed test must not
 * depend on them). It asserts the generator is:
 *   (a) deterministic across two runs on the same input tree (and across
 *       independent identical trees, since manifest refs are relative);
 *   (b) self-consistent: the emitted sha recomputes from the emitted manifest
 *       using the validator's exact canonicalization;
 *   (c) load-bearing: mutating or omitting ANY ONE of the 9 inputs flips the sha
 *       or turns the generator RED (non-zero exit).
 *
 * It does NOT invoke or modify the R13 fixture validator / negatives harness.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const GEN = path.join(REPO_ROOT, "scripts", "ops", "friday-stress-verification-policy-manifest.mjs");

// --- Independent mirror of the R13 validator canonicalization (for recompute). ---
const sha = (bytes: Buffer | string): string => crypto.createHash("sha256").update(bytes).digest("hex");
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value as object)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(value);
const digestOf = (value: unknown): string => sha(Buffer.from(canonical(value)));

const COVERS = [
  "applicability rules",
  "runner",
  "harness",
  "test binary",
  "fault schedules",
  "resource and performance budgets",
  "oracles",
  "schemas",
  "sensitivity detectors",
];
const ARTIFACTS = [
  "FRIDAY_STRESS_SUBJECT_INVENTORY.json",
  "FRIDAY_STRESS_OBLIGATION_LEDGER.json",
  "FRIDAY_STRESS_MECHANISM_MATRIX.json",
  "FRIDAY_STRESS_UI_CONTROL_MATRIX.json",
  "FRIDAY_STRESS_DEVICE_MATRIX.json",
  "FRIDAY_STRESS_EXECUTION_CENSUS.json",
  "FRIDAY_STRESS_RESOURCE_REPORT.json",
  "FRIDAY_STRESS_FAILURE_RECOVERY_REPORT.json",
  "FRIDAY_STRESS_SENSITIVITY_REPORT.json",
  "FRIDAY_STRESS_FINAL_RECEIPT.json",
];
const ORACLE_FIELDS = [
  "authoritative_oracles",
  "backpressure_oracle",
  "recovery_oracle",
  "cleanup_oracle",
  "security_invariants",
  "zero_effect_invariants",
];
const HARNESS_FILES = [
  "cases.mjs",
  "contract-error.mjs",
  "detectors.mjs",
  "positive-worlds.mjs",
  "validator-result-adapter.mjs",
  "world-schema.json",
];
const VALIDATOR_REL = "tools/verify-endbar-stress-evidence-r13.mjs";
const RUNNER_REL = "tools/run-endbar-stress-evidence-r13-negatives.mjs";
// The fault-schedule literals the generator asserts are present in the validator.
const VALIDATOR_STUB = `#!/usr/bin/env node
// synthetic R13 validator stub carrying the locked fault-schedule literals
const locked = {
  fault_schedule_id: "before-during-after",
  network_profile_id: "partition-reconnect",
  fault_phases: ["before_effect", "during_effect", "after_effect"],
};
export default locked;
`;

const createdRoots: string[] = [];
afterAll(() => {
  for (const root of createdRoots) fs.rmSync(root, { recursive: true, force: true });
});

function schemaFileFor(artifact: string): string {
  const kebab = artifact.replace(/^FRIDAY_STRESS_/, "").replace(/\.json$/, "").toLowerCase().replace(/_/g, "-");
  return `schemas/endbar-stress-${kebab}-r13.schema.json`;
}

/** Build a synthetic minimal declared-sources tree that resolves all 9 inputs. */
function writeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vpm-fixture-"));
  createdRoots.push(root);
  const overlay = {
    contract_revision: "ENDBAR-20260713-R13-EXHAUSTIVE-STRESS",
    candidate_policy: { verification_policy_covers: [...COVERS] },
    applicability_policy: {
      allowed_terminal_states: ["passed", "failed", "not_applicable"],
      not_applicable_requires: ["closed rule", "absence proof"],
    },
    subject_model: {
      unknown_formula: "SUBJECTS - DECLARED_STRESS = empty",
      ui_reconciliation: "S_ui = R_ui = C_ui before final UI stress closure",
    },
    performance_preservation: { locked_metric_instances: 96, warmups: 5, raw_samples: 50, max_relative_ci_width_percent: 15 },
    host_safety: { preflight_required: true, forbidden: ["bind prod ports"] },
    interaction_minimums: { ordinary_control_repetitions: 100, desktop_primary_route_cycles: 1000 },
    external_policy: { soak: "Hub 72h isolated; iOS and Android physical 24h uninterrupted on unchanged exact tuple" },
    obligation_required_fields: ["stress_obligation_id", ...ORACLE_FIELDS, "disposition"],
    required_runtime_artifacts: [...ARTIFACTS],
    runtime_evidence_verification: {
      validator: VALIDATOR_REL,
      negative_runner: RUNNER_REL,
      required_negative_classes: ["unknown", "ghost", "tuple_drift", "zero_work"],
    },
  };
  fs.writeFileSync(path.join(root, "FRIDAY_ENDBAR_R13_STRESS_OVERLAY.json"), `${JSON.stringify(overlay, null, 2)}\n`);
  fs.mkdirSync(path.join(root, "tools", "endbar-detector-harness"), { recursive: true });
  fs.writeFileSync(path.join(root, VALIDATOR_REL), VALIDATOR_STUB);
  fs.writeFileSync(path.join(root, RUNNER_REL), "#!/usr/bin/env node\n// synthetic R13 negatives runner stub\n");
  for (const f of HARNESS_FILES) fs.writeFileSync(path.join(root, "tools", "endbar-detector-harness", f), `// ${f} stub\n`);
  fs.mkdirSync(path.join(root, "schemas"), { recursive: true });
  for (const a of ARTIFACTS) fs.writeFileSync(path.join(root, schemaFileFor(a)), `{"$id":"${a}"}\n`);
  return root;
}

interface GenResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
function runGen(root: string | null, out?: string): GenResult {
  const args = root === null ? [] : ["--sources-root", root];
  if (out) args.push("--out", out);
  const r = spawnSync(process.execPath, [GEN, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
function shaOf(root: string): string {
  const r = runGen(root);
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout).verification_policy_set_sha256 as string;
}

describe("friday-stress-verification-policy-manifest (TEST-STRESS-POLICY-BINDING-001)", () => {
  it("emits a deterministic 64-hex sha, stable across two runs and independent identical trees", () => {
    const root = writeFixture();
    const first = shaOf(root);
    const second = shaOf(root);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    // A separate, content-identical tree yields the same sha (refs are relative).
    expect(shaOf(writeFixture())).toBe(first);
  });

  it("emitted sha recomputes from the emitted manifest via the validator canonicalization", () => {
    const root = writeFixture();
    const out = path.join(root, "out.json");
    const r = runGen(root, out);
    expect(r.status, r.stderr).toBe(0);
    const emitted = JSON.parse(r.stdout).verification_policy_set_sha256 as string;
    const manifest = JSON.parse(fs.readFileSync(out, "utf8")) as Record<string, unknown>;
    expect(manifest.verification_policy_set_sha256).toBe(emitted);
    expect(Object.keys((manifest.policy_inputs as object) ?? {})).toHaveLength(9);
    expect(manifest.policy_covers_denominator).toEqual([...COVERS].sort());
    const { verification_policy_set_sha256: _drop, ...core } = manifest;
    expect(digestOf(core)).toBe(emitted);
  });

  it("is load-bearing on ALL 9 inputs: dropping any single policy input flips the recomputed sha", () => {
    const root = writeFixture();
    const out = path.join(root, "out.json");
    expect(runGen(root, out).status).toBe(0);
    const manifest = JSON.parse(fs.readFileSync(out, "utf8")) as Record<string, unknown>;
    const emitted = manifest.verification_policy_set_sha256 as string;
    const inputs = manifest.policy_inputs as Record<string, unknown>;
    expect(Object.keys(inputs).sort()).toEqual([...COVERS].sort());
    for (const key of Object.keys(inputs)) {
      const { verification_policy_set_sha256: _d, ...core } = structuredClone(manifest);
      delete (core.policy_inputs as Record<string, unknown>)[key];
      expect(digestOf(core), `dropping "${key}" must flip the set sha`).not.toBe(emitted);
    }
  });

  it("mutating an overlay-declared input (applicability_policy) flips the sha", () => {
    const root = writeFixture();
    const before = shaOf(root);
    const overlayPath = path.join(root, "FRIDAY_ENDBAR_R13_STRESS_OVERLAY.json");
    const overlay = JSON.parse(fs.readFileSync(overlayPath, "utf8"));
    overlay.applicability_policy.allowed_terminal_states.push("operator_gated");
    fs.writeFileSync(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`);
    expect(shaOf(root)).not.toBe(before);
  });

  it("mutating a file-digest input (one schema file) flips the sha", () => {
    const root = writeFixture();
    const before = shaOf(root);
    fs.appendFileSync(path.join(root, schemaFileFor(ARTIFACTS[0])), "// drift\n");
    expect(shaOf(root)).not.toBe(before);
  });

  it("mutating the declared runner bytes flips the sha", () => {
    const root = writeFixture();
    const before = shaOf(root);
    fs.appendFileSync(path.join(root, RUNNER_REL), "// drift\n");
    expect(shaOf(root)).not.toBe(before);
  });

  it("turns RED (exit 3) when a declared source is omitted", () => {
    const root = writeFixture();
    expect(shaOf(root)).toMatch(/^[0-9a-f]{64}$/);
    fs.rmSync(path.join(root, RUNNER_REL));
    const r = runGen(root);
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stderr).code).toBe("DECLARED_SOURCE_MISSING");
  });

  it("turns RED when a locked fault-schedule constant is removed from the validator", () => {
    const root = writeFixture();
    expect(shaOf(root)).toMatch(/^[0-9a-f]{64}$/);
    fs.writeFileSync(path.join(root, VALIDATOR_REL), VALIDATOR_STUB.replace('"before-during-after"', '"weakened"'));
    const r = runGen(root);
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stderr).code).toBe("FAULT_SCHEDULE_CONSTANT_ABSENT");
  });

  it("turns RED on covers-denominator drift (a 10th undeclared-resolver cover)", () => {
    const root = writeFixture();
    const overlayPath = path.join(root, "FRIDAY_ENDBAR_R13_STRESS_OVERLAY.json");
    const overlay = JSON.parse(fs.readFileSync(overlayPath, "utf8"));
    overlay.candidate_policy.verification_policy_covers.push("some new policy dimension");
    fs.writeFileSync(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`);
    const r = runGen(root);
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stderr).code).toBe("VERIFICATION_POLICY_COVERS_DENOMINATOR_DRIFT");
  });

  it("turns RED when --sources-root is missing", () => {
    const r = runGen(null);
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stderr).code).toBe("MISSING_SOURCES_ROOT");
  });
});
