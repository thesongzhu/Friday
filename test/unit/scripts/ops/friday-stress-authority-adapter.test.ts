/**
 * TEST-STRESS-AUTHORITY-ADAPTER-001 — subject-inventory authority adapter.
 *
 * Red-first, anti-proof-theater structural test for
 * `scripts/ops/friday-stress-authority-adapter.mjs`, which binds the seven REAL
 * S/D/A/L/S_ui/R_ui/C_ui enumerators and the exact source/runtime/artifact/ledger
 * denominators into `FRIDAY_STRESS_SUBJECT_INVENTORY.json`.
 *
 * Self-contained: it builds a SYNTHETIC declared-sources tree (R13 stress overlay
 * + tools + schemas, satisfying the #48 policy manifest it consumes) AND a
 * SYNTHETIC repo tree (real static surfaces: http routes, sealed-WS Message enum,
 * ui router, ios/android screens, rust crates). Committed tests must not depend on
 * the real R13 sources (which live outside the repo) — same rule #48 followed.
 *
 * The output is graded by an INDEPENDENT checker: a byte-for-byte VENDORED copy of
 * the Handoff R13 fixture validator (`verify-endbar-stress-evidence-r13.mjs`,
 * sha256 pinned below; asserted equal to the live tool when present). The
 * generator is NEVER accepted on a boolean self-report.
 *
 * Anti-theater assertions (each RED before the generator existed, GREEN after):
 *  1 empty enumerator -> RED (subjects DERIVED, not baked)
 *  2 drop one of 7 authority_inputs -> validator DISCOVERY_AUTHORITY_DENOMINATOR
 *  3 omit a coverage class -> validator COVERAGE_CLASS_DENOMINATOR
 *  4 a subject missing one of 17 dimensions -> validator STRESS_DIMENSION_DENOMINATOR
 *  5 mutate ANY denominator (source/runtime/artifact/obligation/policy) -> tuple FLIPS
 *  6 reconciliation: ghost/unknown -> RED (unknown/ghost formulas = empty)
 *  7 reviewer_id == producer_id -> RED (anti producer-only oracle)
 *  8 forged/stale discovery_ref -> validator EVIDENCE_REF_DRIFT
 *  9 determinism (same tree + independent identical trees)
 * 10 self-consistency (subject_set + tuple recompute via validator canonical)
 * 11 cross-validation THROUGH the independent validator (grade externally)
 * 12 born-current authority/coverage denominator drift -> RED
 *  + executed-assertion floor (>0 assertions; 21 subjects / 7 authorities)
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const GEN = path.join(REPO_ROOT, "scripts", "ops", "friday-stress-authority-adapter.mjs");
const VENDORED_VALIDATOR = path.join(__dirname, "fixtures", "verify-endbar-stress-evidence-r13.vendored.mjs");
const VENDORED_VALIDATOR_SHA = "4287ef02e4cae753f457fa8ef61e8436fe6e8e291ad62f2750cd69d81dbbb323"; // pragma: allowlist secret
const LIVE_VALIDATOR = path.join(
  os.homedir(),
  "Desktop",
  "Friday-Handoff-Log",
  "tools",
  "verify-endbar-stress-evidence-r13.mjs",
);

const REV = "ENDBAR-20260713-R13-EXHAUSTIVE-STRESS";
const OBLIGATION_SHA_A = "a".repeat(64);
const OBLIGATION_SHA_B = "b".repeat(64);

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

// --- R13 contract constants (must match the validator's hardcoded denominators). ---
const COVERAGE_CLASSES = [
  "http", "websocket_sse", "cli_ipc_ffi", "database_storage", "desktop_ui", "ios_ui", "android_ui",
  "ipad_ui", "share", "voice", "approval", "auth_owner", "data_lifecycle", "install_release", "provider",
  "telegram", "plugin_skill_mcp", "exec_sandbox", "notification_deeplink", "remote_network", "job_timer_os_event",
];
const DIMENSIONS = [
  "steady_sustained", "burst_ramp_to_limit", "concurrency_race_toctou", "duplicate_replay_idempotency",
  "scale_data_volume", "latency_partition_half_open_reconnect", "cancel_timeout_process_death_restart",
  "fault_before_during_after_effect", "resource_pressure_and_bounds", "malformed_oversized_deep_unicode_clock",
  "backpressure_load_shed_retry_ceiling", "recovery_rto_readback_exactly_once", "cleanup_leak_secret_absence",
  "security_owner_tenant_capability_under_load", "ui_interaction_a11y_visual_state_storm",
  "install_update_rollback_backup_restore_export_delete_uninstall", "version_skew_and_migration_compatibility",
];
const AUTHORITY_KINDS = ["S_static", "D_runtime", "A_artifact", "L_ledger", "S_ui", "R_ui", "C_ui"];

// --- #48 policy-manifest fixture inputs (the adapter consumes buildVerificationPolicyManifest). ---
const COVERS = [
  "applicability rules", "runner", "harness", "test binary", "fault schedules",
  "resource and performance budgets", "oracles", "schemas", "sensitivity detectors",
];
const ARTIFACTS = [
  "FRIDAY_STRESS_SUBJECT_INVENTORY.json", "FRIDAY_STRESS_OBLIGATION_LEDGER.json", "FRIDAY_STRESS_MECHANISM_MATRIX.json",
  "FRIDAY_STRESS_UI_CONTROL_MATRIX.json", "FRIDAY_STRESS_DEVICE_MATRIX.json", "FRIDAY_STRESS_EXECUTION_CENSUS.json",
  "FRIDAY_STRESS_RESOURCE_REPORT.json", "FRIDAY_STRESS_FAILURE_RECOVERY_REPORT.json",
  "FRIDAY_STRESS_SENSITIVITY_REPORT.json", "FRIDAY_STRESS_FINAL_RECEIPT.json",
];
const SIBLING_STUBS = ARTIFACTS.filter((a) => a !== "FRIDAY_STRESS_SUBJECT_INVENTORY.json");
const ORACLE_FIELDS = [
  "authoritative_oracles", "backpressure_oracle", "recovery_oracle", "cleanup_oracle",
  "security_invariants", "zero_effect_invariants",
];
const HARNESS_FILES = [
  "cases.mjs", "contract-error.mjs", "detectors.mjs", "positive-worlds.mjs",
  "validator-result-adapter.mjs", "world-schema.json",
];
const VALIDATOR_REL = "tools/verify-endbar-stress-evidence-r13.mjs";
const RUNNER_REL = "tools/run-endbar-stress-evidence-r13-negatives.mjs";
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

function mkRealDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  createdRoots.push(dir);
  return dir;
}

function schemaFileFor(artifact: string): string {
  const kebab = artifact.replace(/^FRIDAY_STRESS_/, "").replace(/\.json$/, "").toLowerCase().replace(/_/g, "-");
  return `schemas/endbar-stress-${kebab}-r13.schema.json`;
}

/** Synthetic declared-sources tree: R13 overlay + tools + schemas (satisfies #48 + the adapter). */
function writeSourcesRoot(): string {
  const root = mkRealDir("saa-sources-");
  const overlay = {
    contract_revision: REV,
    additive_requirement: { requirement_id: "TEST-STRESS-ALL-001" },
    candidate_policy: { verification_policy_covers: [...COVERS] },
    applicability_policy: {
      allowed_terminal_states: ["passed", "failed", "not_applicable"],
      not_applicable_requires: ["closed rule", "absence proof"],
    },
    subject_model: {
      sources: [
        "S_static_discovery", "D_declared_runtime_profiles", "A_exact_artifact_runtime", "L_mechanism_ledger",
        "S_ui", "R_ui", "C_ui", "os_system_entries", "data_lifecycle_release_paths",
      ],
      unknown_formula: "SUBJECTS - DECLARED_STRESS = empty",
      ghost_formula: "DECLARED_STRESS - (SUBJECTS + approved_tombstones) = empty",
      ui_reconciliation: "S_ui = R_ui = C_ui before final UI stress closure",
    },
    stress_dimensions: [...DIMENSIONS],
    platform_scope: {
      desktop: ["exact final Friday.app", "six primary slots", "Settings and one Advanced/Labs"],
      ios: ["iOS 17+ physical", "Share, Voice, approval, IA/search", "24h uninterrupted soak"],
      android: ["API 24 minimum", "Share, Voice, approval, IA/search", "24h uninterrupted soak"],
      ipad: ["resize", "rotation", "Stage Manager", "a11y compatibility"],
      web: ["setup, recovery, diagnostics and emergency scope only"],
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
    runtime_evidence_bundle_contract: {
      authority_sources: [...AUTHORITY_KINDS],
      minimum_coverage_classes: [...COVERAGE_CLASSES],
      tuple_components: [
        "source_sha", "cross_platform_artifact_set_sha256", "runtime_profile_digest",
        "obligation_set_sha256", "verification_policy_set_sha256",
      ],
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

/** Synthetic repo tree exposing the real static surfaces the repo_static loci read. */
function writeRepoRoot(): string {
  const root = mkRealDir("saa-repo-");
  const write = (rel: string, content: string) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  // http routes (http + telegram + auth_owner loci read src/api/http/routes)
  write(
    "src/api/http/routes/friday-sample-routes.ts",
    `export const routes = [\n  { method: "GET", path: "/v1/health" },\n  { method: "POST", path: "/v1/approve" },\n  { method: "GET", path: "/v1/auth/owner" },\n];\n`,
  );
  // sealed-WS Message enum
  write(
    "rust-core/crates/friday-protocol/src/lib.rs",
    `pub enum Message {\n    Hello,\n    Ping { id: u64 },\n    Bye,\n}\n`,
  );
  // rust crates for cli_ipc_ffi / database_storage / remote_network / exec_sandbox / provider / voice
  for (const crate of ["friday-ffi", "friday-storage", "friday-system-remote", "friday-core", "friday-providers", "friday-tts"]) {
    write(`rust-core/crates/${crate}/src/lib.rs`, `// ${crate}\npub fn probe() -> u8 { 0 }\n`);
  }
  // ui router (desktop_ui)
  write(
    "ui/src/router.tsx",
    `export const router = [\n  { path: "/dashboard" },\n  { path: "/settings" },\n  { index: true },\n];\n`,
  );
  // ios + android screens
  write("apps/friday-ios/HomeScreen.swift", `import SwiftUI\nstruct HomeScreen: View { var body: some View { Text("home") } }\n`);
  write("apps/friday-android/HomeScreen.kt", `class HomeScreen {}\n`);
  return root;
}

interface Roots {
  sourcesRoot: string;
  repoRoot: string;
}
function writeFixture(): Roots {
  return { sourcesRoot: writeSourcesRoot(), repoRoot: writeRepoRoot() };
}

interface GenResult {
  status: number | null;
  stdout: string;
  stderr: string;
  json: () => Record<string, unknown>;
  err: () => Record<string, unknown>;
}
function runGen(
  roots: Partial<Roots>,
  opts: { obligation?: string | null; outDir?: string; producerId?: string; reviewerId?: string } = {},
): GenResult {
  const args: string[] = [];
  if (roots.sourcesRoot !== undefined) args.push("--sources-root", roots.sourcesRoot);
  if (roots.repoRoot !== undefined) args.push("--repo-root", roots.repoRoot);
  const obligation = opts.obligation === undefined ? OBLIGATION_SHA_A : opts.obligation;
  if (obligation !== null) args.push("--obligation-set-sha256", obligation);
  if (opts.outDir) args.push("--out-dir", opts.outDir);
  if (opts.producerId) args.push("--producer-id", opts.producerId);
  if (opts.reviewerId) args.push("--reviewer-id", opts.reviewerId);
  const r = spawnSync(process.execPath, [GEN, ...args], { encoding: "utf8" });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    json: () => JSON.parse(r.stdout) as Record<string, unknown>,
    err: () => JSON.parse(r.stderr) as Record<string, unknown>,
  };
}

/** Generate a full bundle into a fresh realpath'd out dir. Returns the paths + parsed inventory. */
function generateBundle(roots: Roots, obligation = OBLIGATION_SHA_A): { outDir: string; inventory: Record<string, any> } {
  const outDir = mkRealDir("saa-bundle-");
  const r = runGen(roots, { obligation, outDir });
  expect(r.status, r.stderr).toBe(0);
  const inventory = JSON.parse(fs.readFileSync(path.join(outDir, "FRIDAY_STRESS_SUBJECT_INVENTORY.json"), "utf8"));
  return { outDir, inventory };
}

/** Run the vendored independent validator over a bundle dir (with sibling stubs). */
function runValidator(bundleDir: string): { status: number | null; err: Record<string, unknown> | null; stdout: string } {
  const r = spawnSync(process.execPath, [VENDORED_VALIDATOR, bundleDir, "--fixture"], {
    encoding: "utf8",
    env: { ...process.env, FRIDAY_R13_NEGATIVE_FIXTURE: "1" },
  });
  let err: Record<string, unknown> | null = null;
  try {
    err = JSON.parse(r.stderr) as Record<string, unknown>;
  } catch {
    err = null;
  }
  return { status: r.status, err, stdout: r.stdout };
}

function addSiblingStubs(bundleDir: string): void {
  for (const name of SIBLING_STUBS) fs.writeFileSync(path.join(bundleDir, name), "{}\n");
}

describe("friday-stress-authority-adapter (TEST-STRESS-AUTHORITY-ADAPTER-001)", () => {
  it("vendored independent validator is byte-identical to the live Handoff tool", () => {
    expect.hasAssertions();
    const vendoredSha = sha(fs.readFileSync(VENDORED_VALIDATOR));
    expect(vendoredSha).toBe(VENDORED_VALIDATOR_SHA);
    if (fs.existsSync(LIVE_VALIDATOR)) {
      expect(sha(fs.readFileSync(LIVE_VALIDATOR)), "vendored validator drifted from live Handoff").toBe(vendoredSha);
    }
  });

  // executed-assertion floor + positive control (no-degrade).
  it("emits exactly 21 subjects across all 21 coverage classes and 7 authority attestations", () => {
    expect.hasAssertions();
    const roots = writeFixture();
    const { inventory } = generateBundle(roots);
    expect(inventory.schema_version).toBe("friday.endbar.stress-subject-inventory.r13.v1");
    expect(inventory.contract_revision).toBe(REV);
    expect(inventory.subjects).toHaveLength(21);
    expect(new Set(inventory.subjects.map((s: any) => s.coverage_class))).toEqual(new Set(COVERAGE_CLASSES));
    expect(inventory.authority_inputs).toHaveLength(7);
    expect(inventory.unknown_ids).toEqual([]);
    expect(inventory.ghost_ids).toEqual([]);
    for (const s of inventory.subjects) {
      expect(new Set(s.applicable_dimensions)).toEqual(new Set(DIMENSIONS));
      expect(s.release_required).toBe(true);
      expect(s.discovery_refs.length).toBeGreaterThanOrEqual(1);
      expect(s.discovery_refs[0].path.startsWith("raw/")).toBe(true);
    }
  }, 30000);

  // (11) cross-validation THROUGH the independent validator: subject section passes,
  // dies only at the stub ledger => every subject-inventory gate graded externally.
  it("passes the INDEPENDENT validator's subject-inventory section (dies at stub ledger)", () => {
    expect.hasAssertions();
    const roots = writeFixture();
    const { outDir } = generateBundle(roots);
    addSiblingStubs(outDir);
    const v = runValidator(outDir);
    expect(v.status).toBe(65);
    // If it died on any subject-inventory die-code the adapter failed the external grader.
    const SUBJECT_DIE_CODES = [
      "SUBJECT_INVENTORY_SHAPE", "FINAL_TUPLE_COMPONENT_MISMATCH", "SUBJECT_RECONCILIATION_NONZERO",
      "SUBJECT_ROW", "SUBJECT_SET", "STRESS_DIMENSION_DENOMINATOR", "COVERAGE_CLASS_DENOMINATOR",
      "SUBJECT_SET_DIGEST_MISMATCH", "INVALID_EVIDENCE_REF", "EVIDENCE_REF_DRIFT", "EVIDENCE_REFS_MISSING",
      "DISCOVERY_AUTHORITY_JSON", "DISCOVERY_AUTHORITY_INVALID", "DISCOVERY_AUTHORITY_GHOST",
      "DISCOVERY_AUTHORITY_DENOMINATOR", "UNSAFE_RELATIVE_PATH", "SECURE_OPEN_FAILED", "UNSAFE_FILE", "READ_RACE",
    ];
    expect(SUBJECT_DIE_CODES).not.toContain(v.err?.code);
    expect(v.err?.code).toBe("LEDGER_SHAPE_OR_BINDING");
  }, 30000);

  // (10) self-consistency: emitted digests recompute via the validator canonicalization.
  it("subject_set_sha256 and tuple recompute from the emitted document", () => {
    expect.hasAssertions();
    const roots = writeFixture();
    const { inventory } = generateBundle(roots);
    const sorted = [...inventory.subjects].sort((a: any, b: any) => a.subject_id.localeCompare(b.subject_id));
    expect(digestOf(sorted)).toBe(inventory.subject_set_sha256);
    expect(digestOf(inventory.final_release_candidate_components)).toBe(inventory.final_release_candidate_tuple_sha256);
  }, 30000);

  // (9) determinism across two runs and independent identical trees.
  it("is deterministic across two runs and across independent identical trees", () => {
    expect.hasAssertions();
    const rootsA = writeFixture();
    const a1 = generateBundle(rootsA).inventory;
    const a2 = generateBundle(rootsA).inventory;
    expect(a2.final_release_candidate_tuple_sha256).toBe(a1.final_release_candidate_tuple_sha256);
    expect(a2.subject_set_sha256).toBe(a1.subject_set_sha256);
    // Independent, content-identical trees yield identical digests (relative refs).
    const rootsB = writeFixture();
    const b1 = generateBundle(rootsB).inventory;
    expect(b1.subject_set_sha256).toBe(a1.subject_set_sha256);
    expect(b1.final_release_candidate_tuple_sha256).toBe(a1.final_release_candidate_tuple_sha256);
  }, 30000);

  // (1) empty enumerator (remove the http route surface) -> RED, subjects are DERIVED.
  it("turns RED when a real enumerator discovers zero members", () => {
    expect.hasAssertions();
    const roots = writeFixture();
    expect(runGen(roots, { outDir: mkRealDir("saa-ok-") }).status).toBe(0);
    fs.rmSync(path.join(roots.repoRoot, "src/api/http/routes"), { recursive: true, force: true });
    const r = runGen(roots);
    expect(r.status).toBe(3);
    expect(r.err().code).toBe("ENUMERATOR_EMPTY");
  }, 30000);

  // (5) mutate ANY denominator -> the tuple FLIPS (binding is real, not hardcoded).
  it("mutating any of the 5 denominators flips the final_release_candidate_tuple_sha256", () => {
    expect.hasAssertions();
    const roots = writeFixture();
    const base = generateBundle(roots).inventory;
    const baseTuple = base.final_release_candidate_tuple_sha256;
    const baseComp = base.final_release_candidate_components;

    // (a) obligation_set_sha256 (declared two-pass input) via the CLI.
    const oblig = generateBundle(roots, OBLIGATION_SHA_B).inventory;
    expect(oblig.final_release_candidate_components.obligation_set_sha256).not.toBe(baseComp.obligation_set_sha256);
    expect(oblig.final_release_candidate_components.source_sha).toBe(baseComp.source_sha);
    expect(oblig.final_release_candidate_tuple_sha256).not.toBe(baseTuple);

    // (b) source_sha: mutate a real repo source file.
    fs.appendFileSync(path.join(roots.repoRoot, "rust-core/crates/friday-protocol/src/lib.rs"), "// drift\n");
    const src = generateBundle(roots).inventory;
    expect(src.final_release_candidate_components.source_sha).not.toBe(baseComp.source_sha);
    expect(src.final_release_candidate_tuple_sha256).not.toBe(baseTuple);

    // (c) verification_policy_set_sha256 (consumed from #48): mutate a declared schema.
    const roots2 = writeFixture();
    const base2 = generateBundle(roots2).inventory.final_release_candidate_components;
    fs.appendFileSync(path.join(roots2.sourcesRoot, schemaFileFor(ARTIFACTS[0])), "// drift\n");
    const pol = generateBundle(roots2).inventory.final_release_candidate_components;
    expect(pol.verification_policy_set_sha256).not.toBe(base2.verification_policy_set_sha256);
    expect(pol.source_sha).toBe(base2.source_sha);

    // (d) cross_platform_artifact_set_sha256: drop a required runtime artifact.
    const roots3 = writeFixture();
    const base3 = generateBundle(roots3).inventory;
    const overlayPath = path.join(roots3.sourcesRoot, "FRIDAY_ENDBAR_R13_STRESS_OVERLAY.json");
    const ov = JSON.parse(fs.readFileSync(overlayPath, "utf8"));
    ov.required_runtime_artifacts = ov.required_runtime_artifacts.slice(0, -1);
    fs.writeFileSync(overlayPath, `${JSON.stringify(ov, null, 2)}\n`);
    const art = generateBundle(roots3).inventory;
    expect(art.final_release_candidate_components.cross_platform_artifact_set_sha256).not.toBe(
      base3.final_release_candidate_components.cross_platform_artifact_set_sha256,
    );
    expect(art.final_release_candidate_tuple_sha256).not.toBe(base3.final_release_candidate_tuple_sha256);

    // (e) runtime_profile_digest: add a platform_scope key.
    const roots4 = writeFixture();
    const base4 = generateBundle(roots4).inventory.final_release_candidate_components;
    const ovPath4 = path.join(roots4.sourcesRoot, "FRIDAY_ENDBAR_R13_STRESS_OVERLAY.json");
    const ov4 = JSON.parse(fs.readFileSync(ovPath4, "utf8"));
    ov4.platform_scope.watch = ["watchOS companion"];
    fs.writeFileSync(ovPath4, `${JSON.stringify(ov4, null, 2)}\n`);
    const rt = generateBundle(roots4).inventory.final_release_candidate_components;
    expect(rt.runtime_profile_digest).not.toBe(base4.runtime_profile_digest);
  }, 60000);

  // (7) reviewer_id == producer_id -> RED (anti producer-only oracle).
  it("turns RED when reviewer_id equals producer_id", () => {
    expect.hasAssertions();
    const roots = writeFixture();
    const r = runGen(roots, { producerId: "same-agent", reviewerId: "same-agent" });
    expect(r.status).toBe(3);
    expect(r.err().code).toBe("REVIEWER_EQUALS_PRODUCER");
  }, 30000);

  // (12) born-current drift: declared denominator != implemented enumerator set -> RED.
  it("turns RED on born-current authority denominator drift", () => {
    expect.hasAssertions();
    const roots = writeFixture();
    const overlayPath = path.join(roots.sourcesRoot, "FRIDAY_ENDBAR_R13_STRESS_OVERLAY.json");
    const ov = JSON.parse(fs.readFileSync(overlayPath, "utf8"));
    ov.runtime_evidence_bundle_contract.authority_sources = AUTHORITY_KINDS.slice(0, 6);
    fs.writeFileSync(overlayPath, `${JSON.stringify(ov, null, 2)}\n`);
    const r = runGen(roots);
    expect(r.status).toBe(3);
    expect(r.err().code).toBe("AUTHORITY_DENOMINATOR_DRIFT");
  }, 30000);

  it("turns RED on born-current coverage-class denominator drift", () => {
    expect.hasAssertions();
    const roots = writeFixture();
    const overlayPath = path.join(roots.sourcesRoot, "FRIDAY_ENDBAR_R13_STRESS_OVERLAY.json");
    const ov = JSON.parse(fs.readFileSync(overlayPath, "utf8"));
    ov.runtime_evidence_bundle_contract.minimum_coverage_classes =
      ov.runtime_evidence_bundle_contract.minimum_coverage_classes.concat("some_new_class");
    fs.writeFileSync(overlayPath, `${JSON.stringify(ov, null, 2)}\n`);
    const r = runGen(roots);
    expect(r.status).toBe(3);
    expect(r.err().code).toBe("COVERAGE_CLASS_DENOMINATOR_DRIFT");
  }, 30000);

  // (6) reconciliation via the exported pure function AND the independent validator.
  it("reconcile() fails closed on a ghost and on an unknown", async () => {
    expect.hasAssertions();
    const mod = await import(path.join(REPO_ROOT, "scripts/ops/friday-stress-authority-adapter.mjs"));
    // ghost: declared (authority) id not in subjects.
    expect(() => mod.reconcile(["a", "b"], ["a", "b", "ghost"])).toThrow(/SUBJECT_RECONCILIATION_NONZERO/);
    // unknown: subject id covered by no authority.
    expect(() => mod.reconcile(["a", "b", "orphan"], ["a", "b"])).toThrow(/SUBJECT_RECONCILIATION_NONZERO/);
    expect(mod.reconcile(["a", "b"], ["a", "b"])).toEqual({ unknown_ids: [], ghost_ids: [] });
  });

  it("independent validator RED (SUBJECT_RECONCILIATION_NONZERO) when ghost_ids is injected", () => {
    expect.hasAssertions();
    const roots = writeFixture();
    const { outDir } = generateBundle(roots);
    addSiblingStubs(outDir);
    const invPath = path.join(outDir, "FRIDAY_STRESS_SUBJECT_INVENTORY.json");
    const inv = JSON.parse(fs.readFileSync(invPath, "utf8"));
    inv.ghost_ids = ["ghost-subject"];
    fs.writeFileSync(invPath, `${JSON.stringify(inv, null, 2)}\n`);
    const v = runValidator(outDir);
    expect(v.status).toBe(65);
    expect(v.err?.code).toBe("SUBJECT_RECONCILIATION_NONZERO");
  }, 30000);

  // (2) drop one of the 7 authority_inputs -> independent validator DISCOVERY_AUTHORITY_DENOMINATOR.
  it("independent validator RED (DISCOVERY_AUTHORITY_DENOMINATOR) when an authority_input is dropped", () => {
    expect.hasAssertions();
    const roots = writeFixture();
    const { outDir } = generateBundle(roots);
    addSiblingStubs(outDir);
    const invPath = path.join(outDir, "FRIDAY_STRESS_SUBJECT_INVENTORY.json");
    const inv = JSON.parse(fs.readFileSync(invPath, "utf8"));
    inv.authority_inputs = inv.authority_inputs.slice(0, -1);
    fs.writeFileSync(invPath, `${JSON.stringify(inv, null, 2)}\n`);
    const v = runValidator(outDir);
    expect(v.status).toBe(65);
    expect(v.err?.code).toBe("DISCOVERY_AUTHORITY_DENOMINATOR");
  }, 30000);

  // (3) omit a coverage class (remove a subject) -> independent validator COVERAGE_CLASS_DENOMINATOR.
  it("independent validator RED (COVERAGE_CLASS_DENOMINATOR) when a coverage class is omitted", () => {
    expect.hasAssertions();
    const roots = writeFixture();
    const { outDir } = generateBundle(roots);
    addSiblingStubs(outDir);
    const invPath = path.join(outDir, "FRIDAY_STRESS_SUBJECT_INVENTORY.json");
    const inv = JSON.parse(fs.readFileSync(invPath, "utf8"));
    inv.subjects = inv.subjects.slice(1); // drop one class' subject
    fs.writeFileSync(invPath, `${JSON.stringify(inv, null, 2)}\n`);
    const v = runValidator(outDir);
    expect(v.status).toBe(65);
    expect(v.err?.code).toBe("COVERAGE_CLASS_DENOMINATOR");
  }, 30000);

  // (4) a subject missing one of 17 dimensions -> independent validator STRESS_DIMENSION_DENOMINATOR.
  it("independent validator RED (STRESS_DIMENSION_DENOMINATOR) when the overlay drops a dimension", () => {
    expect.hasAssertions();
    const roots = writeFixture();
    const overlayPath = path.join(roots.sourcesRoot, "FRIDAY_ENDBAR_R13_STRESS_OVERLAY.json");
    const ov = JSON.parse(fs.readFileSync(overlayPath, "utf8"));
    ov.stress_dimensions = ov.stress_dimensions.slice(0, -1); // 16 dims — generator derives from overlay
    fs.writeFileSync(overlayPath, `${JSON.stringify(ov, null, 2)}\n`);
    const outDir = mkRealDir("saa-16dim-");
    expect(runGen(roots, { outDir }).status).toBe(0);
    addSiblingStubs(outDir);
    const v = runValidator(outDir);
    expect(v.status).toBe(65);
    expect(v.err?.code).toBe("STRESS_DIMENSION_DENOMINATOR");
  }, 30000);

  // (8) forged / stale evidence: corrupt a discovery_ref target -> validator EVIDENCE_REF_DRIFT.
  it("independent validator RED (EVIDENCE_REF_DRIFT) when a raw observation is tampered", () => {
    expect.hasAssertions();
    const roots = writeFixture();
    const { outDir, inventory } = generateBundle(roots);
    addSiblingStubs(outDir);
    const targetRef = inventory.subjects[0].discovery_refs[0].path;
    fs.appendFileSync(path.join(outDir, targetRef), "tamper");
    const v = runValidator(outDir);
    expect(v.status).toBe(65);
    expect(v.err?.code).toBe("EVIDENCE_REF_DRIFT");
  }, 30000);

  // Argument guards.
  it("turns RED when required inputs are missing", () => {
    expect.hasAssertions();
    const roots = writeFixture();
    expect(runGen({ repoRoot: roots.repoRoot }).err().code).toBe("MISSING_SOURCES_ROOT");
    expect(runGen({ sourcesRoot: roots.sourcesRoot }).err().code).toBe("MISSING_REPO_ROOT");
    expect(runGen(roots, { obligation: null }).err().code).toBe("MISSING_OBLIGATION_SET_SHA");
    expect(runGen(roots, { obligation: "not-a-digest" }).err().code).toBe("OBLIGATION_SET_SHA_INVALID");
  }, 30000);
});
