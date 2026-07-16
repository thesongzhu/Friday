/**
 * TEST-STRESS-AUTHORITY-ADAPTER-001 — subject-inventory authority adapter.
 *
 * HONEST, PROVISIONAL adapter. These tests prove the generator does NOT fake
 * completeness / exact-binding / independent-attestation, and that its output is
 * graded by the INDEPENDENT vendored R13 validator (byte-identical to the live
 * Handoff tool). The redesign closes the advisor's three proof-theater findings:
 *  F1 open-world per-member subjects (not one-per-class); reconciliation fails closed.
 *  F2 source_sha = COMPLETE candidate tree; runtime/artifact = full content;
 *     obligation = recomputed-from-ledger or explicitly UNSEALED (never arbitrary).
 *  F3 the generator emits UNREVIEWED observations; PASS requires a SEPARATELY
 *     EXECUTED, content-bound review statement from an allowlisted distinct identity.
 *
 * The DEFAULT bundle is PROVISIONAL_UNSEALED and the validator correctly REDs on
 * it (no fake-pass). A fully-sealed bundle (ledger + independent review) passes
 * the validator's subject section — proving the machinery.
 *
 * The 5 advisor counterexamples are red-first regressions:
 *  #1 new-route-addition -> a new subject appears; #2 path-before-method route is
 *  discovered; #3 uncovered src/jobs file flips source_sha; #4 arbitrary/mismatched
 *  ledger digest never seals; #5 fake / self-issued reviewer never yields PASS.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const GEN = path.join(REPO_ROOT, "scripts", "ops", "friday-stress-authority-adapter.mjs");
const REVIEWER = path.join(REPO_ROOT, "scripts", "ops", "friday-stress-authority-review.mjs");
const VENDORED_VALIDATOR = path.join(__dirname, "fixtures", "verify-endbar-stress-evidence-r13.vendored.mjs");
const VENDORED_VALIDATOR_SHA = "4287ef02e4cae753f457fa8ef61e8436fe6e8e291ad62f2750cd69d81dbbb323"; // pragma: allowlist secret
const LIVE_VALIDATOR = path.join(os.homedir(), "Desktop", "Friday-Handoff-Log", "tools", "verify-endbar-stress-evidence-r13.mjs");

const REV = "ENDBAR-20260713-R13-EXHAUSTIVE-STRESS";
const PRODUCER = "friday-stress-authority-adapter-agent";
const REVIEWER_ID = "friday-stress-independent-reviewer-agent";

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
const ORACLE_FIELDS = ["authoritative_oracles", "backpressure_oracle", "recovery_oracle", "cleanup_oracle", "security_invariants", "zero_effect_invariants"];
const HARNESS_FILES = ["cases.mjs", "contract-error.mjs", "detectors.mjs", "positive-worlds.mjs", "validator-result-adapter.mjs", "world-schema.json"];
const VALIDATOR_REL = "tools/verify-endbar-stress-evidence-r13.mjs";
const RUNNER_REL = "tools/run-endbar-stress-evidence-r13-negatives.mjs";
const VALIDATOR_STUB = `#!/usr/bin/env node
const locked = { fault_schedule_id: "before-during-after", network_profile_id: "partition-reconnect", fault_phases: ["before_effect", "during_effect", "after_effect"] };
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

function writeSourcesRoot(): string {
  const root = mkRealDir("saa-sources-");
  const overlay = {
    contract_revision: REV,
    additive_requirement: { requirement_id: "TEST-STRESS-ALL-001" },
    candidate_policy: { verification_policy_covers: [...COVERS] },
    applicability_policy: { allowed_terminal_states: ["passed", "failed", "not_applicable"], not_applicable_requires: ["closed rule", "absence proof"] },
    subject_model: { sources: ["S_static_discovery", "S_ui", "R_ui", "C_ui"], unknown_formula: "SUBJECTS - DECLARED_STRESS = empty", ghost_formula: "DECLARED_STRESS - (SUBJECTS + approved_tombstones) = empty" },
    stress_dimensions: [...DIMENSIONS],
    platform_scope: {
      desktop: ["exact final Friday.app", "six primary slots"],
      ios: ["iOS 17+ physical", "Share, Voice, approval"],
      android: ["API 24 minimum", "Share, Voice, approval"],
      ipad: ["resize", "Stage Manager"],
      web: ["setup, recovery, diagnostics only"],
    },
    performance_preservation: { locked_metric_instances: 96, warmups: 5, raw_samples: 50, max_relative_ci_width_percent: 15 },
    host_safety: { preflight_required: true, forbidden: ["bind prod ports"] },
    interaction_minimums: { ordinary_control_repetitions: 100, desktop_primary_route_cycles: 1000 },
    external_policy: { soak: "Hub 72h isolated; iOS and Android physical 24h uninterrupted" },
    obligation_required_fields: ["stress_obligation_id", ...ORACLE_FIELDS, "disposition"],
    required_runtime_artifacts: [...ARTIFACTS],
    runtime_evidence_verification: { validator: VALIDATOR_REL, negative_runner: RUNNER_REL, required_negative_classes: ["unknown", "ghost", "tuple_drift", "zero_work"] },
    runtime_evidence_bundle_contract: {
      authority_sources: [...AUTHORITY_KINDS],
      minimum_coverage_classes: [...COVERAGE_CLASSES],
      tuple_components: ["source_sha", "cross_platform_artifact_set_sha256", "runtime_profile_digest", "obligation_set_sha256", "verification_policy_set_sha256"],
    },
  };
  fs.writeFileSync(path.join(root, "FRIDAY_ENDBAR_R13_STRESS_OVERLAY.json"), `${JSON.stringify(overlay, null, 2)}\n`);
  fs.mkdirSync(path.join(root, "tools", "endbar-detector-harness"), { recursive: true });
  fs.writeFileSync(path.join(root, VALIDATOR_REL), VALIDATOR_STUB);
  fs.writeFileSync(path.join(root, RUNNER_REL), "#!/usr/bin/env node\n// stub\n");
  for (const f of HARNESS_FILES) fs.writeFileSync(path.join(root, "tools", "endbar-detector-harness", f), `// ${f} stub\n`);
  fs.mkdirSync(path.join(root, "schemas"), { recursive: true });
  for (const a of ARTIFACTS) fs.writeFileSync(path.join(root, schemaFileFor(a)), `{"$id":"${a}"}\n`);
  return root;
}

function writeRepoRoot(): string {
  const root = mkRealDir("saa-repo-");
  const write = (rel: string, content: string) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  write("src/api/http/routes/friday-sample-routes.ts", `export const routes = [\n  { method: "GET", path: "/v1/health" },\n  { method: "POST", path: "/v1/missions" },\n];\n`);
  write("src/api/http/routes/friday-channel-routes.ts", `export const routes = [{ method: "POST", path: "/v1/channels/telegram/webhook" }];\n`);
  write("src/api/http/routes/friday-auth-routes.ts", `export const routes = [{ method: "POST", path: "/v1/auth/owner/grant" }];\n`);
  write("rust-core/crates/friday-protocol/src/lib.rs", `pub enum Message {\n    Hello,\n    Ping { id: u64 },\n    Bye,\n}\n`);
  for (const crate of ["friday-ffi", "friday-storage", "friday-system-remote", "friday-core", "friday-providers", "friday-tts"]) {
    write(`rust-core/crates/${crate}/src/lib.rs`, `// ${crate}\npub fn probe() -> u8 { 0 }\n`);
  }
  write("ui/src/router.tsx", `export const router = [\n  { path: "/dashboard" },\n  { path: "/settings" },\n  { index: true },\n];\n`);
  write("apps/friday-ios/HomeScreen.swift", `import SwiftUI\nstruct HomeScreen: View { var body: some View { Text("h") } }\n`);
  write("apps/friday-ios/SettingsScreen.swift", `import SwiftUI\nstruct SettingsScreen: View { var body: some View { Text("s") } }\n`);
  write("apps/friday-android/HomeScreen.kt", `class HomeScreen {}\n`);
  return root;
}

interface Roots { sourcesRoot: string; repoRoot: string }
function writeFixture(): Roots { return { sourcesRoot: writeSourcesRoot(), repoRoot: writeRepoRoot() }; }

/** A synthetic obligation ledger whose obligation_set_sha256 recomputes correctly. */
function writeLedger(dir: string, obligations = [{ stress_obligation_id: "OBL-1", note: "x" }, { stress_obligation_id: "OBL-2", note: "y" }]): string {
  const sorted = [...obligations].sort((a, b) => a.stress_obligation_id.localeCompare(b.stress_obligation_id));
  const ledger = { schema_version: "friday.endbar.stress-obligation-ledger.r13.v1", obligation_set_sha256: digestOf(sorted), obligations };
  const p = path.join(dir, "ledger.json");
  fs.writeFileSync(p, `${JSON.stringify(ledger, null, 2)}\n`);
  return p;
}

interface GenResult { status: number | null; stdout: string; stderr: string; json: () => any; err: () => any }
function runGen(roots: Partial<Roots>, opts: { outDir?: string; ledger?: string; reviews?: string; allowlist?: string; producerId?: string } = {}): GenResult {
  const args: string[] = [];
  if (roots.sourcesRoot !== undefined) args.push("--sources-root", roots.sourcesRoot);
  if (roots.repoRoot !== undefined) args.push("--repo-root", roots.repoRoot);
  if (opts.outDir) args.push("--out-dir", opts.outDir);
  if (opts.ledger) args.push("--obligation-ledger", opts.ledger);
  if (opts.reviews) args.push("--review-statements", opts.reviews);
  if (opts.allowlist) args.push("--reviewer-allowlist", opts.allowlist);
  if (opts.producerId) args.push("--producer-id", opts.producerId);
  const r = spawnSync(process.execPath, [GEN, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout), err: () => JSON.parse(r.stderr) };
}
function runReviewer(bundleDir: string, reviewerId: string, outDir?: string): { status: number | null; stdout: string; stderr: string } {
  const args = ["--bundle-dir", bundleDir, "--reviewer-id", reviewerId];
  if (outDir) args.push("--out-dir", outDir);
  const r = spawnSync(process.execPath, [REVIEWER, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
function readInventory(outDir: string): any {
  return JSON.parse(fs.readFileSync(path.join(outDir, "FRIDAY_STRESS_SUBJECT_INVENTORY.json"), "utf8"));
}
function generateBundle(roots: Roots, opts: { ledger?: string; reviews?: string; allowlist?: string } = {}): { outDir: string; inventory: any; out: any } {
  const outDir = mkRealDir("saa-bundle-");
  const r = runGen(roots, { outDir, ...opts });
  expect(r.status, r.stderr).toBe(0);
  return { outDir, inventory: readInventory(outDir), out: r.json() };
}
function runValidator(bundleDir: string): { status: number | null; err: any } {
  const r = spawnSync(process.execPath, [VENDORED_VALIDATOR, bundleDir, "--fixture"], { encoding: "utf8", env: { ...process.env, FRIDAY_R13_NEGATIVE_FIXTURE: "1" } });
  let err: any = null;
  try { err = JSON.parse(r.stderr); } catch { err = null; }
  return { status: r.status, err };
}
function addSiblingStubs(bundleDir: string): void {
  for (const name of SIBLING_STUBS) fs.writeFileSync(path.join(bundleDir, name), "{}\n");
}
/** Full seal: gen(ledger) -> independent review -> gen(ledger+reviews). Returns the SEALED bundle. */
function sealedBundle(roots: Roots): { outDir: string; inventory: any; out: any } {
  const ledgerDir = mkRealDir("saa-ledger-");
  const ledger = writeLedger(ledgerDir);
  const first = generateBundle(roots, { ledger });
  const reviewDir = mkRealDir("saa-reviews-");
  const rev = runReviewer(first.outDir, REVIEWER_ID, reviewDir);
  expect(rev.status, rev.stderr).toBe(0);
  return generateBundle(roots, { ledger, reviews: reviewDir, allowlist: REVIEWER_ID });
}

describe("friday-stress-authority-adapter (TEST-STRESS-AUTHORITY-ADAPTER-001)", () => {
  it("vendored independent validator is byte-identical to the live Handoff tool", () => {
    expect.hasAssertions();
    const vendoredSha = sha(fs.readFileSync(VENDORED_VALIDATOR));
    expect(vendoredSha).toBe(VENDORED_VALIDATOR_SHA);
    if (fs.existsSync(LIVE_VALIDATOR)) expect(sha(fs.readFileSync(LIVE_VALIDATOR))).toBe(vendoredSha);
  });

  // Executed-assertion floor + F1 open-world positive control.
  it("emits OPEN-WORLD per-member subjects (more than one per class) covering all 21 classes and 7 authorities", () => {
    expect.hasAssertions();
    const { inventory, out } = generateBundle(writeFixture());
    expect(inventory.subjects.length).toBeGreaterThan(COVERAGE_CLASSES.length); // per-member, not 21
    expect(new Set(inventory.subjects.map((s: any) => s.coverage_class))).toEqual(new Set(COVERAGE_CLASSES));
    expect(inventory.authority_inputs).toHaveLength(7);
    // multiple http members => multiple http subjects (open-world, not collapsed).
    expect(inventory.subjects.filter((s: any) => s.coverage_class === "http").length).toBeGreaterThan(1);
    expect(out.seal_status).toBe("PROVISIONAL_UNSEALED");
    for (const s of inventory.subjects) {
      expect(new Set(s.applicable_dimensions)).toEqual(new Set(DIMENSIONS));
      expect(s.release_required).toBe(true);
    }
  }, 30000);

  // F3 no-fake-pass: the DEFAULT bundle is unreviewed -> the INDEPENDENT validator REDs.
  it("DEFAULT bundle is PROVISIONAL_UNSEALED and the independent validator REDs (DISCOVERY_AUTHORITY_INVALID)", () => {
    expect.hasAssertions();
    const { outDir, out } = generateBundle(writeFixture());
    expect(out.seal_status).toBe("PROVISIONAL_UNSEALED");
    addSiblingStubs(outDir);
    const v = runValidator(outDir);
    expect(v.status).toBe(65);
    expect(v.err?.code).toBe("DISCOVERY_AUTHORITY_INVALID"); // verdict = UNREVIEWED, never self-issued PASS
  }, 30000);

  // Machinery: a fully SEALED bundle (ledger + SEPARATE independent review) passes the
  // validator's whole subject section (dies only at the stub ledger).
  it("SEALED bundle (ledger + independent review) passes the independent validator's subject section", () => {
    expect.hasAssertions();
    const { outDir, out } = sealedBundle(writeFixture());
    expect(out.seal_status).toBe("SEALED");
    expect(out.authorities_reviewed).toBe(7);
    addSiblingStubs(outDir);
    const v = runValidator(outDir);
    expect(v.status).toBe(65);
    expect(v.err?.code).toBe("LEDGER_SHAPE_OR_BINDING"); // subject section fully passed
  }, 40000);

  // F1 #1 — new-route-addition: adding a real route yields a NEW subject (open-world)
  // and flips source_sha (F2 complete tree).
  it("counterexample #1: adding an HTTP route creates a new subject and flips source_sha", () => {
    expect.hasAssertions();
    const roots = writeFixture();
    const before = generateBundle(roots);
    const beforeIds = new Set(before.inventory.subjects.map((s: any) => s.subject_id));
    fs.appendFileSync(path.join(roots.repoRoot, "src/api/http/routes/friday-sample-routes.ts"), `export const more = [{ method: "DELETE", path: "/v1/newly-added-route" }];\n`);
    const after = generateBundle(roots);
    expect(after.inventory.subjects.length).toBe(before.inventory.subjects.length + 1);
    expect(after.inventory.subjects.some((s: any) => s.subject_id === "http::/v1/newly-added-route")).toBe(true);
    expect(beforeIds.has("http::/v1/newly-added-route")).toBe(false);
    expect(after.inventory.final_release_candidate_components.source_sha).not.toBe(before.inventory.final_release_candidate_components.source_sha);
    expect(after.inventory.final_release_candidate_tuple_sha256).not.toBe(before.inventory.final_release_candidate_tuple_sha256);
  }, 30000);

  // F1 #2 — extraction-order: a route written path-BEFORE-method is still discovered.
  it("counterexample #2: a path-before-method route is discovered as a subject", () => {
    expect.hasAssertions();
    const roots = writeFixture();
    fs.appendFileSync(path.join(roots.repoRoot, "src/api/http/routes/friday-sample-routes.ts"), `export const odd = [{ path: "/v1/path-before-method", method: "GET" }];\n`);
    const { inventory } = generateBundle(roots);
    expect(inventory.subjects.some((s: any) => s.subject_id === "http::/v1/path-before-method")).toBe(true);
  }, 30000);

  // F2 #3 — uncovered src/jobs source: NOT under any class locus, yet flips source_sha.
  it("counterexample #3: an uncovered src/jobs source file flips source_sha and the tuple", () => {
    expect.hasAssertions();
    const roots = writeFixture();
    const before = generateBundle(roots).inventory.final_release_candidate_components;
    fs.mkdirSync(path.join(roots.repoRoot, "src/jobs"), { recursive: true });
    fs.writeFileSync(path.join(roots.repoRoot, "src/jobs/nightly-timer.ts"), `export const job = () => 1;\n`);
    const after = generateBundle(roots).inventory.final_release_candidate_components;
    expect(after.source_sha).not.toBe(before.source_sha);
    expect(digestOf(after)).not.toBe(digestOf(before));
    // clean attribution: nothing else changed.
    for (const k of ["runtime_profile_digest", "cross_platform_artifact_set_sha256", "obligation_set_sha256", "verification_policy_set_sha256"]) {
      expect(after[k]).toBe(before[k]);
    }
  }, 30000);

  // F2 — remaining denominators bind real content.
  it("F2: runtime (full content), obligation (ledger recompute), artifact/policy (schema bytes) each bind and flip", () => {
    expect.hasAssertions();
    const roots = writeFixture();
    const base = generateBundle(roots).inventory.final_release_candidate_components;

    // runtime_profile_digest binds FULL declared content (a VALUE change flips it).
    const overlayPath = path.join(roots.sourcesRoot, "FRIDAY_ENDBAR_R13_STRESS_OVERLAY.json");
    const ov = JSON.parse(fs.readFileSync(overlayPath, "utf8"));
    ov.platform_scope.web = ["setup, recovery, diagnostics only", "added emergency scope"]; // value change, keys unchanged
    fs.writeFileSync(overlayPath, `${JSON.stringify(ov, null, 2)}\n`);
    const rt = generateBundle(roots).inventory.final_release_candidate_components;
    expect(rt.runtime_profile_digest).not.toBe(base.runtime_profile_digest);
    expect(rt.source_sha).toBe(base.source_sha);

    // obligation recomputed from ledger content (different ledger => different digest).
    const roots2 = writeFixture();
    const dir2 = mkRealDir("saa-ledgerA-");
    const l1 = writeLedger(dir2, [{ stress_obligation_id: "A", note: "1" }]);
    const c1 = generateBundle(roots2, { ledger: l1 }).inventory.final_release_candidate_components;
    const dir3 = mkRealDir("saa-ledgerB-");
    const l2 = writeLedger(dir3, [{ stress_obligation_id: "A", note: "2" }]);
    const c2 = generateBundle(roots2, { ledger: l2 }).inventory.final_release_candidate_components;
    expect(c1.obligation_set_sha256).not.toBe(c2.obligation_set_sha256);
    for (const k of ["source_sha", "runtime_profile_digest", "cross_platform_artifact_set_sha256", "verification_policy_set_sha256"]) expect(c1[k]).toBe(c2[k]);

    // artifact + policy bind real schema BYTES.
    const roots3 = writeFixture();
    const b3 = generateBundle(roots3).inventory.final_release_candidate_components;
    fs.appendFileSync(path.join(roots3.sourcesRoot, schemaFileFor(ARTIFACTS[0])), "// drift\n");
    const a3 = generateBundle(roots3).inventory.final_release_candidate_components;
    expect(a3.cross_platform_artifact_set_sha256).not.toBe(b3.cross_platform_artifact_set_sha256);
    expect(a3.verification_policy_set_sha256).not.toBe(b3.verification_policy_set_sha256);
  }, 60000);

  // F2 #4 — arbitrary / mismatched ledger digest never seals.
  it("counterexample #4: a tampered ledger digest is REJECTED; no ledger stays UNSEALED (no arbitrary digest)", () => {
    expect.hasAssertions();
    const roots = writeFixture();
    // no ledger => obligation unsealed, bundle provisional.
    const prov = generateBundle(roots).out;
    expect(prov.seal_status).toBe("PROVISIONAL_UNSEALED");
    expect(prov.unsealed_reasons).toContain("obligation_ledger_two_pass_not_authored");
    // tampered ledger digest => hard RED (recompute mismatch).
    const dir = mkRealDir("saa-badledger-");
    const p = writeLedger(dir);
    const bad = JSON.parse(fs.readFileSync(p, "utf8"));
    bad.obligation_set_sha256 = "f".repeat(64);
    fs.writeFileSync(p, `${JSON.stringify(bad, null, 2)}\n`);
    const r = runGen(roots, { ledger: p });
    expect(r.status).toBe(3);
    expect(r.err().code).toBe("OBLIGATION_LEDGER_DIGEST_MISMATCH");
  }, 30000);

  // F3 #5 — fake / self-issued reviewer never yields PASS.
  it("counterexample #5: self-issued or non-allowlisted review never seals; the validator still REDs", () => {
    expect.hasAssertions();
    const roots = writeFixture();
    const ledgerDir = mkRealDir("saa-ledgerR-");
    const ledger = writeLedger(ledgerDir);
    const base = generateBundle(roots, { ledger });

    // (a) reviewer == producer is refused by the SEPARATE reviewer (role separation).
    const selfReview = runReviewer(base.outDir, PRODUCER, mkRealDir("saa-selfrev-"));
    expect(selfReview.status).toBe(4);
    expect(JSON.parse(selfReview.stderr).code).toBe("REVIEWER_EQUALS_PRODUCER");

    // (b) a genuine external review exists, but the reviewer is NOT allowlisted => not sealed.
    const reviewDir = mkRealDir("saa-revR-");
    expect(runReviewer(base.outDir, REVIEWER_ID, reviewDir).status).toBe(0);
    const notAllow = generateBundle(roots, { ledger, reviews: reviewDir, allowlist: "some-other-identity" });
    expect(notAllow.out.seal_status).toBe("PROVISIONAL_UNSEALED");
    addSiblingStubs(notAllow.outDir);
    expect(runValidator(notAllow.outDir).err?.code).toBe("DISCOVERY_AUTHORITY_INVALID");

    // (c) a hand-forged review statement with reviewer_id == producer_id is rejected on seal.
    const forgedDir = mkRealDir("saa-forged-");
    const realStmt = JSON.parse(fs.readFileSync(path.join(reviewDir, fs.readdirSync(reviewDir)[0]), "utf8"));
    for (const kind of AUTHORITY_KINDS) {
      const forged = { ...realStmt, source_kind: kind, reviewer_id: PRODUCER };
      fs.writeFileSync(path.join(forgedDir, `f-${kind}.json`), `${JSON.stringify(forged, null, 2)}\n`);
    }
    const forgedGen = generateBundle(roots, { ledger, reviews: forgedDir, allowlist: PRODUCER });
    expect(forgedGen.out.seal_status).toBe("PROVISIONAL_UNSEALED");
  }, 40000);

  // Determinism + self-consistency.
  it("is deterministic and self-consistent (subject_set + tuple recompute)", () => {
    expect.hasAssertions();
    const rootsA = writeFixture();
    const a1 = generateBundle(rootsA).inventory;
    const a2 = generateBundle(rootsA).inventory;
    expect(a2.subject_set_sha256).toBe(a1.subject_set_sha256);
    expect(a2.final_release_candidate_tuple_sha256).toBe(a1.final_release_candidate_tuple_sha256);
    const b1 = generateBundle(writeFixture()).inventory;
    expect(b1.subject_set_sha256).toBe(a1.subject_set_sha256);
    const sorted = [...a1.subjects].sort((x: any, y: any) => x.subject_id.localeCompare(y.subject_id));
    expect(digestOf(sorted)).toBe(a1.subject_set_sha256);
    expect(digestOf(a1.final_release_candidate_components)).toBe(a1.final_release_candidate_tuple_sha256);
  }, 40000);

  // Reconciliation fails closed (F1).
  it("reconcile() fails closed on a ghost and on an unknown", async () => {
    expect.hasAssertions();
    const mod = await import(path.join(REPO_ROOT, "scripts/ops/friday-stress-authority-adapter.mjs"));
    expect(() => mod.reconcile(["a", "b"], ["a", "b", "ghost"])).toThrow(/SUBJECT_RECONCILIATION_NONZERO/);
    expect(() => mod.reconcile(["a", "b", "orphan"], ["a", "b"])).toThrow(/SUBJECT_RECONCILIATION_NONZERO/);
    expect(mod.reconcile(["a", "b"], ["a", "b"])).toEqual({ unknown_ids: [], ghost_ids: [] });
  });

  it("emits a SEAL_STATUS sidecar that names the unsealed reasons and is not a validator-graded artifact", () => {
    expect.hasAssertions();
    const { outDir } = generateBundle(writeFixture());
    const sidecar = JSON.parse(fs.readFileSync(path.join(outDir, "FRIDAY_STRESS_SUBJECT_INVENTORY.SEAL_STATUS.json"), "utf8"));
    expect(sidecar.seal_status).toBe("PROVISIONAL_UNSEALED");
    expect(sidecar.component_binding.source_sha.sealed).toBe(true);
    expect(sidecar.component_binding.obligation_set_sha256.sealed).toBe(false);
    expect(sidecar.unsealed_reasons.some((r: string) => r.startsWith("independent_review_absent"))).toBe(true);
    expect(ARTIFACTS).not.toContain("FRIDAY_STRESS_SUBJECT_INVENTORY.SEAL_STATUS.json");
  }, 30000);

  // Forged evidence-ref + born-current drift (retained anti-theater gates).
  it("independent validator REDs (EVIDENCE_REF_DRIFT) when a raw observation is tampered", () => {
    expect.hasAssertions();
    const { outDir, inventory } = sealedBundle(writeFixture());
    addSiblingStubs(outDir);
    fs.appendFileSync(path.join(outDir, inventory.subjects[0].discovery_refs[0].path), "tamper");
    const v = runValidator(outDir);
    expect(v.status).toBe(65);
    expect(v.err?.code).toBe("EVIDENCE_REF_DRIFT");
  }, 40000);

  it("turns RED on born-current authority and coverage denominator drift", () => {
    expect.hasAssertions();
    const rootsA = writeFixture();
    const ovA = path.join(rootsA.sourcesRoot, "FRIDAY_ENDBAR_R13_STRESS_OVERLAY.json");
    const a = JSON.parse(fs.readFileSync(ovA, "utf8"));
    a.runtime_evidence_bundle_contract.authority_sources = AUTHORITY_KINDS.slice(0, 6);
    fs.writeFileSync(ovA, `${JSON.stringify(a, null, 2)}\n`);
    expect(runGen(rootsA).err().code).toBe("AUTHORITY_DENOMINATOR_DRIFT");

    const rootsB = writeFixture();
    const ovB = path.join(rootsB.sourcesRoot, "FRIDAY_ENDBAR_R13_STRESS_OVERLAY.json");
    const b = JSON.parse(fs.readFileSync(ovB, "utf8"));
    b.runtime_evidence_bundle_contract.minimum_coverage_classes = COVERAGE_CLASSES.concat("some_new_class");
    fs.writeFileSync(ovB, `${JSON.stringify(b, null, 2)}\n`);
    expect(runGen(rootsB).err().code).toBe("COVERAGE_CLASS_DENOMINATOR_DRIFT");
  }, 30000);

  it("turns RED when an enumerator discovers zero members and when required inputs are missing", () => {
    expect.hasAssertions();
    const roots = writeFixture();
    fs.rmSync(path.join(roots.repoRoot, "src/api/http/routes"), { recursive: true, force: true });
    expect(runGen(roots).err().code).toBe("ENUMERATOR_EMPTY");
    const ok = writeFixture();
    expect(runGen({ repoRoot: ok.repoRoot }).err().code).toBe("MISSING_SOURCES_ROOT");
    expect(runGen({ sourcesRoot: ok.sourcesRoot }).err().code).toBe("MISSING_REPO_ROOT");
  }, 30000);
});
