/**
 * TEST-STRESS-AUTHORITY-ADAPTER-001 — PROVISIONAL-ONLY subject-inventory adapter.
 *
 * Agent-side the adapter can NEVER self-seal (no trusted OIDC / operator
 * signature), so `seal_status` is always `PROVISIONAL_UNSEALED` and the
 * INDEPENDENT vendored R13 validator correctly REDs the bundle. These tests
 * root-verify the round-2 recurrences:
 *  P0-3 open-world route×METHOD identity + a GENUINELY INDEPENDENT reconciliation
 *       (definition lens vs the CI API route CONTRACT SNAPSHOT).
 *  P0-1 no caller-controllable SEALED path (review/allowlist/ledger removed).
 *  P0-2 global SEALED requires EVERY component + gate + authority sealed.
 *
 * Red-first negatives (RED on the round-2 code, GREEN here):
 *  (a) same-path GET/POST/PUT are DISTINCT subjects;
 *  (b) a route in one lens but not the other -> reconciliation RED (validator
 *      SUBJECT_RECONCILIATION_NONZERO + sidecar clean:false);
 *  (c) arbitrary caller identity can NOT seal (stays PROVISIONAL);
 *  (d) any single unsealed tuple component prevents global SEALED.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const GEN = path.join(REPO_ROOT, "scripts", "ops", "friday-stress-authority-adapter.mjs");
const ADAPTER_MOD = path.join(REPO_ROOT, "scripts/ops/friday-stress-authority-adapter.mjs");
const VENDORED_VALIDATOR = path.join(__dirname, "fixtures", "verify-endbar-stress-evidence-r13.vendored.mjs");
const VENDORED_VALIDATOR_SHA = "4287ef02e4cae753f457fa8ef61e8436fe6e8e291ad62f2750cd69d81dbbb323"; // pragma: allowlist secret
const LIVE_VALIDATOR = path.join(os.homedir(), "Desktop", "Friday-Handoff-Log", "tools", "verify-endbar-stress-evidence-r13.mjs");
const REMOVED_REVIEWER = path.join(REPO_ROOT, "scripts", "ops", "friday-stress-authority-review.mjs");

const REV = "ENDBAR-20260713-R13-EXHAUSTIVE-STRESS";
const ROUTE_SNAPSHOT_REL = "test/contracts/api/__snapshots__/friday-api-route-contract.snapshot.test.ts.snap";

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
const COVERS = ["applicability rules", "runner", "harness", "test binary", "fault schedules", "resource and performance budgets", "oracles", "schemas", "sensitivity detectors"];
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

// The 7 canonical routes present in BOTH lenses (clean reconciliation). Includes
// same-path GET/POST and GET/PUT to prove route×method identity.
const ROUTES = [
  { operationId: "health.check", method: "GET", path: "/v1/health", file: "friday-sample-routes.ts" },
  { operationId: "workflows.list", method: "GET", path: "/v1/workflows", file: "friday-sample-routes.ts" },
  { operationId: "workflows.create", method: "POST", path: "/v1/workflows", file: "friday-sample-routes.ts" },
  { operationId: "uix.retention.get", method: "GET", path: "/v1/uix/retention-policy", file: "friday-sample-routes.ts" },
  { operationId: "uix.retention.update", method: "PUT", path: "/v1/uix/retention-policy", file: "friday-sample-routes.ts" },
  { operationId: "channels.telegram.webhook", method: "POST", path: "/v1/channels/telegram/webhook", file: "friday-channel-routes.ts" },
  { operationId: "auth.owner.grant", method: "POST", path: "/v1/auth/owner/grant", file: "friday-auth-routes.ts" },
];

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
    platform_scope: { desktop: ["Friday.app"], ios: ["iOS 17+"], android: ["API 24"], ipad: ["resize"], web: ["diagnostics only"] },
    performance_preservation: { locked_metric_instances: 96, warmups: 5, raw_samples: 50, max_relative_ci_width_percent: 15 },
    host_safety: { preflight_required: true, forbidden: ["bind prod ports"] },
    interaction_minimums: { ordinary_control_repetitions: 100, desktop_primary_route_cycles: 1000 },
    external_policy: { soak: "Hub 72h isolated" },
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

function routeFileContent(routes: { operationId: string; method: string; path: string }[]): string {
  const objs = routes
    .map((r) => `    {\n      operationId: "${r.operationId}",\n      method: "${r.method}",\n      path: "${r.path}",\n      auth: { public: true },\n      handler: async () => ({}),\n    },`)
    .join("\n");
  return `import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";\nexport function createRoutes(): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {\n  return [\n${objs}\n  ];\n}\n`;
}
function snapshotContent(routes: { operationId: string; method: string; path: string }[]): string {
  const objs = routes
    .map((r, i) => `  {\n    "authKind": "public",\n    "index": ${i},\n    "method": "${r.method}",\n    "operationId": "${r.operationId}",\n    "path": "${r.path}",\n    "rateLimitPolicyId": null,\n    "roles": [],\n    "scopes": [],\n  },`)
    .join("\n");
  return `// Vitest Snapshot v1, https://vitest.dev/guide/snapshot.html\n\nexports[\`MECHANISM-4 — API Route Contract (Snapshot) > captures route count to detect accidental additions/removals 1\`] = \`${routes.length}\`;\n\nexports[\`MECHANISM-4 — API Route Contract (Snapshot) > captures the full route surface as a stable contract 1\`] = \`\n[\n${objs}\n]\n\`;\n`;
}

function writeRepoRoot(opts: { defRoutes?: typeof ROUTES; snapshotRoutes?: typeof ROUTES } = {}): string {
  const root = mkRealDir("saa-repo-");
  const defRoutes = opts.defRoutes ?? ROUTES;
  const snapRoutes = opts.snapshotRoutes ?? ROUTES;
  const write = (rel: string, content: string) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  // route files grouped by file
  const byFile: Record<string, typeof ROUTES> = {};
  for (const r of defRoutes) (byFile[r.file] ||= []).push(r);
  for (const [file, rs] of Object.entries(byFile)) write(`src/api/http/routes/${file}`, routeFileContent(rs));
  // independent contract snapshot lens
  write(ROUTE_SNAPSHOT_REL, snapshotContent(snapRoutes));
  // other real surfaces
  write("rust-core/crates/friday-protocol/src/lib.rs", `pub enum Message {\n    Hello,\n    Ping { id: u64 },\n    Bye,\n}\n`);
  for (const crate of ["friday-ffi", "friday-storage", "friday-system-remote", "friday-core", "friday-providers", "friday-tts"]) {
    write(`rust-core/crates/${crate}/src/lib.rs`, `// ${crate}\npub fn probe() -> u8 { 0 }\n`);
  }
  write("ui/src/router.tsx", `export const router = [\n  { path: "/dashboard" },\n  { path: "/settings" },\n  { index: true },\n];\n`);
  write("apps/friday-ios/HomeScreen.swift", `import SwiftUI\nstruct HomeScreen: View { var body: some View { Text("h") } }\n`);
  write("apps/friday-android/HomeScreen.kt", `class HomeScreen {}\n`);
  return root;
}

interface Roots { sourcesRoot: string; repoRoot: string }
function writeFixture(repoOpts: Parameters<typeof writeRepoRoot>[0] = {}): Roots {
  return { sourcesRoot: writeSourcesRoot(), repoRoot: writeRepoRoot(repoOpts) };
}

interface GenResult { status: number | null; stdout: string; stderr: string; json: () => any; err: () => any }
function runGen(roots: Partial<Roots>, opts: { outDir?: string; producerId?: string } = {}): GenResult {
  const args: string[] = [];
  if (roots.sourcesRoot !== undefined) args.push("--sources-root", roots.sourcesRoot);
  if (roots.repoRoot !== undefined) args.push("--repo-root", roots.repoRoot);
  if (opts.outDir) args.push("--out-dir", opts.outDir);
  if (opts.producerId) args.push("--producer-id", opts.producerId);
  const r = spawnSync(process.execPath, [GEN, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout), err: () => JSON.parse(r.stderr) };
}
function generateBundle(roots: Roots, producerId?: string): { outDir: string; inventory: any; sidecar: any; out: any } {
  const outDir = mkRealDir("saa-bundle-");
  const r = runGen(roots, { outDir, producerId });
  expect(r.status, r.stderr).toBe(0);
  return {
    outDir,
    inventory: JSON.parse(fs.readFileSync(path.join(outDir, "FRIDAY_STRESS_SUBJECT_INVENTORY.json"), "utf8")),
    sidecar: JSON.parse(fs.readFileSync(path.join(outDir, "FRIDAY_STRESS_SUBJECT_INVENTORY.SEAL_STATUS.json"), "utf8")),
    out: r.json(),
  };
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

describe("friday-stress-authority-adapter (TEST-STRESS-AUTHORITY-ADAPTER-001)", () => {
  it("vendored independent validator is byte-identical to the live Handoff tool", () => {
    expect.hasAssertions();
    const vendoredSha = sha(fs.readFileSync(VENDORED_VALIDATOR));
    expect(vendoredSha).toBe(VENDORED_VALIDATOR_SHA);
    if (fs.existsSync(LIVE_VALIDATOR)) expect(sha(fs.readFileSync(LIVE_VALIDATOR))).toBe(vendoredSha);
  });

  // P0-3 (a): route×METHOD identity — same-path GET/POST and GET/PUT are DISTINCT subjects.
  it("(a) same-path GET/POST/PUT are distinct open-world subjects (not path-collapsed)", () => {
    expect.hasAssertions();
    const { inventory, out } = generateBundle(writeFixture());
    const ids = new Set(inventory.subjects.map((s: any) => s.subject_id));
    expect(ids.has("http::GET /v1/workflows")).toBe(true);
    expect(ids.has("http::POST /v1/workflows")).toBe(true);
    expect(ids.has("http::GET /v1/uix/retention-policy")).toBe(true);
    expect(ids.has("http::PUT /v1/uix/retention-policy")).toBe(true);
    const httpSubjects = inventory.subjects.filter((s: any) => s.coverage_class === "http");
    const httpPaths = new Set(httpSubjects.map((s: any) => s.subject_id.replace(/^http::(GET|POST|PUT|PATCH|DELETE) /, "")));
    expect(httpSubjects.length).toBeGreaterThan(httpPaths.size); // method-distinct > path-unique
    expect(new Set(inventory.subjects.map((s: any) => s.coverage_class))).toEqual(new Set(COVERAGE_CLASSES));
    expect(out.seal_status).toBe("PROVISIONAL_UNSEALED");
  }, 30000);

  // P0-1 no-fake-pass: clean fixture reaches authority, which is UNREVIEWED -> validator REDs.
  it("DEFAULT bundle is PROVISIONAL_UNSEALED; the independent validator REDs (DISCOVERY_AUTHORITY_INVALID)", () => {
    expect.hasAssertions();
    const { outDir, out } = generateBundle(writeFixture());
    expect(out.seal_status).toBe("PROVISIONAL_UNSEALED");
    expect(out.can_ever_self_seal_agent_side).toBe(false);
    addSiblingStubs(outDir);
    const v = runValidator(outDir);
    expect(v.status).toBe(65);
    expect(v.err?.code).toBe("DISCOVERY_AUTHORITY_INVALID");
  }, 30000);

  // P0-3 (b): a route in the definition lens but not the contract lens -> reconciliation RED.
  it("(b) a route present in one lens but omitted by the other -> reconciliation RED", () => {
    expect.hasAssertions();
    // definition has an extra route the contract snapshot does NOT.
    const extra = { operationId: "workflows.secret", method: "DELETE", path: "/v1/workflows/secret", file: "friday-sample-routes.ts" };
    const roots = writeFixture({ defRoutes: [...ROUTES, extra], snapshotRoutes: ROUTES });
    const { outDir, inventory, sidecar } = generateBundle(roots);
    expect(sidecar.independent_reconciliation.http.clean).toBe(false);
    expect(sidecar.independent_reconciliation.http.definition_only_count).toBeGreaterThan(0);
    expect(inventory.unknown_ids.length).toBeGreaterThan(0);
    expect(inventory.unknown_ids).toContain("http::DELETE /v1/workflows/secret");
    addSiblingStubs(outDir);
    const v = runValidator(outDir);
    expect(v.status).toBe(65);
    expect(v.err?.code).toBe("SUBJECT_RECONCILIATION_NONZERO");
  }, 30000);

  // P0-1 (c): NO caller-controllable path can seal. Arbitrary identity stays PROVISIONAL.
  it("(c) arbitrary caller identity can NOT seal; no review/allowlist/ledger surface exists", () => {
    expect.hasAssertions();
    const roots = writeFixture();
    const untrusted = generateBundle(roots, "untrusted-attacker-producer");
    expect(untrusted.out.seal_status).toBe("PROVISIONAL_UNSEALED");
    expect(untrusted.sidecar.authority_seal.S_static.reviewed).toBe(false);
    for (const kind of AUTHORITY_KINDS) expect(untrusted.sidecar.authority_seal[kind].reviewed).toBe(false);
    // the authority-laundering reviewer script is removed; no seal CLI surface exists.
    expect(fs.existsSync(REMOVED_REVIEWER)).toBe(false);
    const usage = JSON.parse(runGen({ repoRoot: roots.repoRoot }).stderr).detail.usage as string;
    expect(usage).not.toMatch(/review|allowlist|ledger/i);
    expect(untrusted.sidecar.unsealed_reasons).toContain("authority_absent_no_trusted_oidc_or_operator_signature");
  }, 30000);

  // P0-2 (d): global SEALED requires EVERY component + gate + authority; any false -> PROVISIONAL.
  it("(d) computeSealStatus: any single unsealed component/gate/authority prevents global SEALED", async () => {
    expect.hasAssertions();
    const mod = await import(ADAPTER_MOD);
    const allSealed = { componentSeal: { a: true, b: true }, gatesSealed: { g1: true, g2: true }, authorityPresent: true };
    expect(mod.computeSealStatus(allSealed)).toBe("SEALED");
    expect(mod.computeSealStatus({ ...allSealed, authorityPresent: false })).toBe("PROVISIONAL_UNSEALED");
    expect(mod.computeSealStatus({ ...allSealed, componentSeal: { a: true, b: false } })).toBe("PROVISIONAL_UNSEALED");
    expect(mod.computeSealStatus({ ...allSealed, gatesSealed: { g1: true, g2: false } })).toBe("PROVISIONAL_UNSEALED");
  });

  // F2 / P0-2: source_sha binds the COMPLETE tree; an uncovered src/jobs file flips it.
  it("F2: an uncovered src/jobs source flips source_sha+tuple; other bindings flip on their real content", () => {
    expect.hasAssertions();
    const roots = writeFixture();
    const before = generateBundle(roots).inventory.final_release_candidate_components;
    fs.mkdirSync(path.join(roots.repoRoot, "src/jobs"), { recursive: true });
    fs.writeFileSync(path.join(roots.repoRoot, "src/jobs/nightly.ts"), `export const j = () => 1;\n`);
    const after = generateBundle(roots).inventory.final_release_candidate_components;
    expect(after.source_sha).not.toBe(before.source_sha);
    for (const k of ["runtime_profile_digest", "cross_platform_artifact_set_sha256", "verification_policy_set_sha256"]) expect(after[k]).toBe(before[k]);

    // runtime full-content value change flips runtime_profile_digest only.
    const r2 = writeFixture();
    const b2 = generateBundle(r2).inventory.final_release_candidate_components;
    const ovp = path.join(r2.sourcesRoot, "FRIDAY_ENDBAR_R13_STRESS_OVERLAY.json");
    const ov = JSON.parse(fs.readFileSync(ovp, "utf8"));
    ov.platform_scope.web = ["diagnostics only", "added scope"];
    fs.writeFileSync(ovp, `${JSON.stringify(ov, null, 2)}\n`);
    const a2 = generateBundle(r2).inventory.final_release_candidate_components;
    expect(a2.runtime_profile_digest).not.toBe(b2.runtime_profile_digest);
    expect(a2.source_sha).toBe(b2.source_sha);

    // artifact + policy bind real schema bytes.
    const r3 = writeFixture();
    const b3 = generateBundle(r3).inventory.final_release_candidate_components;
    fs.appendFileSync(path.join(r3.sourcesRoot, schemaFileFor(ARTIFACTS[0])), "// drift\n");
    const a3 = generateBundle(r3).inventory.final_release_candidate_components;
    expect(a3.cross_platform_artifact_set_sha256).not.toBe(b3.cross_platform_artifact_set_sha256);
    expect(a3.verification_policy_set_sha256).not.toBe(b3.verification_policy_set_sha256);
  }, 60000);

  it("seal-status sidecar names unsealed reasons incl authority-absent, marks obligation unsealed, is not a validator artifact", () => {
    expect.hasAssertions();
    const { sidecar } = generateBundle(writeFixture());
    expect(sidecar.seal_status).toBe("PROVISIONAL_UNSEALED");
    expect(sidecar.can_ever_self_seal_agent_side).toBe(false);
    expect(sidecar.component_binding.source_sha.sealed).toBe(true);
    expect(sidecar.component_binding.obligation_set_sha256.sealed).toBe(false);
    expect(sidecar.component_binding.runtime_profile_digest.sealed).toBe(false);
    expect(sidecar.component_binding.cross_platform_artifact_set_sha256.sealed).toBe(false);
    expect(sidecar.unsealed_reasons).toContain("authority_absent_no_trusted_oidc_or_operator_signature");
    expect(sidecar.independent_reconciliation.http.available).toBe(true);
    expect(sidecar.independent_reconciliation.http.clean).toBe(true);
    expect(ARTIFACTS).not.toContain("FRIDAY_STRESS_SUBJECT_INVENTORY.SEAL_STATUS.json");
  }, 30000);

  it("is deterministic and self-consistent (subject_set + tuple recompute)", () => {
    expect.hasAssertions();
    const roots = writeFixture();
    const a1 = generateBundle(roots).inventory;
    const a2 = generateBundle(roots).inventory;
    expect(a2.subject_set_sha256).toBe(a1.subject_set_sha256);
    expect(a2.final_release_candidate_tuple_sha256).toBe(a1.final_release_candidate_tuple_sha256);
    const b1 = generateBundle(writeFixture()).inventory;
    expect(b1.subject_set_sha256).toBe(a1.subject_set_sha256);
    const sorted = [...a1.subjects].sort((x: any, y: any) => x.subject_id.localeCompare(y.subject_id));
    expect(digestOf(sorted)).toBe(a1.subject_set_sha256);
    expect(digestOf(a1.final_release_candidate_components)).toBe(a1.final_release_candidate_tuple_sha256);
  }, 40000);

  it("independent validator REDs (EVIDENCE_REF_DRIFT) when a raw observation is tampered (structure otherwise valid)", () => {
    expect.hasAssertions();
    const { outDir, inventory } = generateBundle(writeFixture());
    addSiblingStubs(outDir);
    fs.appendFileSync(path.join(outDir, inventory.subjects[0].discovery_refs[0].path), "tamper");
    const v = runValidator(outDir);
    expect(v.status).toBe(65);
    expect(v.err?.code).toBe("EVIDENCE_REF_DRIFT");
  }, 30000);

  it("turns RED on born-current authority and coverage denominator drift, empty enumerator, and missing inputs", () => {
    expect.hasAssertions();
    const a = writeFixture();
    const ovA = path.join(a.sourcesRoot, "FRIDAY_ENDBAR_R13_STRESS_OVERLAY.json");
    const oa = JSON.parse(fs.readFileSync(ovA, "utf8"));
    oa.runtime_evidence_bundle_contract.authority_sources = AUTHORITY_KINDS.slice(0, 6);
    fs.writeFileSync(ovA, `${JSON.stringify(oa, null, 2)}\n`);
    expect(runGen(a).err().code).toBe("AUTHORITY_DENOMINATOR_DRIFT");

    const b = writeFixture();
    const ovB = path.join(b.sourcesRoot, "FRIDAY_ENDBAR_R13_STRESS_OVERLAY.json");
    const ob = JSON.parse(fs.readFileSync(ovB, "utf8"));
    ob.runtime_evidence_bundle_contract.minimum_coverage_classes = COVERAGE_CLASSES.concat("new_class");
    fs.writeFileSync(ovB, `${JSON.stringify(ob, null, 2)}\n`);
    expect(runGen(b).err().code).toBe("COVERAGE_CLASS_DENOMINATOR_DRIFT");

    const c = writeFixture();
    fs.rmSync(path.join(c.repoRoot, "src/api/http/routes"), { recursive: true, force: true });
    expect(runGen(c).err().code).toBe("ENUMERATOR_EMPTY");

    const d = writeFixture();
    expect(runGen({ repoRoot: d.repoRoot }).err().code).toBe("MISSING_SOURCES_ROOT");
    expect(runGen({ sourcesRoot: d.sourcesRoot }).err().code).toBe("MISSING_REPO_ROOT");
  }, 40000);
});
