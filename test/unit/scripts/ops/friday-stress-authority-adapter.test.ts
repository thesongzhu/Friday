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
 *  (d) F-A CLOSED-DENOMINATOR seal: empty / partial / extra-key / non-boolean seal
 *      maps can NEVER seal; only the EXACT closed key sets all-true + authority seal;
 *  (e) F-B EXACT-candidate source provenance: source_sha seals ONLY for a real git
 *      repo whose HEAD equals the FULL 40-char --expected-sha with `===` and a clean
 *      worktree; non-git / dirty / untracked / abbreviated-or-prefix / HEAD≠expected
 *      -> unsealed (or typed EXPECTED_SHA_INVALID); a mutation snapshot→write -> RED.
 *  (f) DRIFT-LOCK: SEAL_COMPONENT_KEYS is bound to the vendored validator's own
 *      `componentsKeys` (exact members + order) so a silent divergence goes RED.
 *  (g) GATE-SET LOCK: SEAL_GATE_KEYS is pinned to exactly the 3 adapter-internal
 *      gates (no external validator contract) to prevent silent drift.
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
const ENUM_MOD = path.join(REPO_ROOT, "scripts/ops/lib/friday-stress-static-enumerators.mjs");
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
function runGen(roots: Partial<Roots>, opts: { outDir?: string; producerId?: string; expectedSha?: string } = {}): GenResult {
  const args: string[] = [];
  if (roots.sourcesRoot !== undefined) args.push("--sources-root", roots.sourcesRoot);
  if (roots.repoRoot !== undefined) args.push("--repo-root", roots.repoRoot);
  if (opts.outDir) args.push("--out-dir", opts.outDir);
  if (opts.producerId) args.push("--producer-id", opts.producerId);
  if (opts.expectedSha) args.push("--expected-sha", opts.expectedSha);
  const r = spawnSync(process.execPath, [GEN, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout), err: () => JSON.parse(r.stderr) };
}

// Turn a fixture repo into a real git repo with everything committed; returns HEAD.
function initGitCommitted(root: string): string {
  const git = (...a: string[]) => {
    const r = spawnSync("git", ["-C", root, "-c", "user.email=t@t.test", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  return git("rev-parse", "HEAD");
}
function generateBundle(roots: Roots, producerId?: string, opts: { expectedSha?: string } = {}): { outDir: string; inventory: any; sidecar: any; out: any } {
  const outDir = mkRealDir("saa-bundle-");
  const r = runGen(roots, { outDir, producerId, expectedSha: opts.expectedSha });
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

// Extract the AUTHORITATIVE component tuple from the vendored R13 validator (its own
// `const componentsKeys=[...]`). We READ the fixture text (it does not export the
// symbol) rather than duplicate the list, so the drift-lock is grounded on the real
// validator, not a hand-copy. The vendored file is byte-identity-checked elsewhere.
function vendoredComponentsKeys(): string[] {
  const src = fs.readFileSync(VENDORED_VALIDATOR, "utf8");
  const m = src.match(/const\s+componentsKeys\s*=\s*(\[[^\]]*\])/);
  if (!m) throw new Error("componentsKeys not found in vendored validator fixture");
  return JSON.parse(m[1]);
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

  // F-A (d): CLOSED-DENOMINATOR seal. Only the EXACT closed key sets all-true + authority
  // can SEAL; empty / missing / extra-key / non-boolean maps can NEVER seal. The old
  // `Object.values(map).every(Boolean)` sealed `{}` and could not reject unknown extras.
  it("(d) computeSealStatus is closed-key exact: empty/partial/extra/non-boolean never seal", async () => {
    expect.hasAssertions();
    const mod = await import(ADAPTER_MOD);
    const fullComp = Object.fromEntries(mod.SEAL_COMPONENT_KEYS.map((k: string) => [k, true]));
    const fullGate = Object.fromEntries(mod.SEAL_GATE_KEYS.map((k: string) => [k, true]));
    const base = { componentSeal: fullComp, gatesSealed: fullGate, authorityPresent: true };

    // the ONLY sealing input: exact closed keys all-true + authority present.
    expect(mod.computeSealStatus(base)).toEqual({ status: "SEALED", reasons: [] });

    // empty maps must NEVER seal (the round-3 `.every(Boolean)` defect returned SEALED for {}).
    const empty = mod.computeSealStatus({ componentSeal: {}, gatesSealed: {}, authorityPresent: true });
    expect(empty.status).toBe("PROVISIONAL_UNSEALED");
    expect(empty.reasons.some((r: string) => r.startsWith("component_seal_missing_keys:"))).toBe(true);
    expect(empty.reasons.some((r: string) => r.startsWith("gate_seal_missing_keys:"))).toBe(true);

    // authority absent -> PROVISIONAL with a specific reason.
    const noAuth = mod.computeSealStatus({ ...base, authorityPresent: false });
    expect(noAuth.status).toBe("PROVISIONAL_UNSEALED");
    expect(noAuth.reasons).toContain("authority_not_present");

    // one component missing -> PROVISIONAL.
    const { source_sha: _drop, ...missingOne } = fullComp;
    expect(mod.computeSealStatus({ ...base, componentSeal: missingOne }).status).toBe("PROVISIONAL_UNSEALED");

    // one component false -> PROVISIONAL.
    expect(mod.computeSealStatus({ ...base, componentSeal: { ...fullComp, source_sha: false } }).status).toBe("PROVISIONAL_UNSEALED");

    // unknown extra key -> PROVISIONAL (cannot be distinguished from a real component by .every).
    const extra = mod.computeSealStatus({ ...base, componentSeal: { ...fullComp, invented_component: true } });
    expect(extra.status).toBe("PROVISIONAL_UNSEALED");
    expect(extra.reasons.some((r: string) => r.startsWith("component_seal_unknown_keys:"))).toBe(true);

    // non-boolean truthy value -> PROVISIONAL (strict === true required).
    expect(mod.computeSealStatus({ ...base, gatesSealed: { ...fullGate, [mod.SEAL_GATE_KEYS[0]]: 1 } }).status).toBe("PROVISIONAL_UNSEALED");
    expect(mod.computeSealStatus({ ...base, gatesSealed: { ...fullGate, [mod.SEAL_GATE_KEYS[0]]: "true" } }).status).toBe("PROVISIONAL_UNSEALED");

    // non-object seal map -> PROVISIONAL.
    expect(mod.computeSealStatus({ ...base, componentSeal: null }).status).toBe("PROVISIONAL_UNSEALED");
    expect(mod.exactAllTrue(null, mod.SEAL_COMPONENT_KEYS)).toEqual({ ok: false, reason: "not_a_plain_object" });

    // the closed key sets are exactly the documented 5 components / 3 gates.
    expect(new Set(mod.SEAL_COMPONENT_KEYS)).toEqual(new Set(["source_sha", "cross_platform_artifact_set_sha256", "runtime_profile_digest", "obligation_set_sha256", "verification_policy_set_sha256"]));
    expect(mod.SEAL_COMPONENT_KEYS).toHaveLength(5);
    expect(mod.SEAL_GATE_KEYS).toHaveLength(3);
  });

  // F-B (e): EXACT-candidate source provenance.
  it("(e) source_sha seals ONLY for a real git repo at the expected HEAD with a clean worktree", async () => {
    expect.hasAssertions();

    // non-git default fixture -> source unsealed (round-3 hardcoded `true` is the defect here).
    const nonGit = generateBundle(writeFixture());
    expect(nonGit.sidecar.component_binding.source_sha.sealed).toBe(false);
    expect(nonGit.sidecar.component_binding.source_sha.git_tree_oid).toBeNull();
    expect(nonGit.sidecar.unsealed_reasons).toContain("source_root_not_a_git_repository");
    expect(nonGit.out.seal_status).toBe("PROVISIONAL_UNSEALED");

    // clean git repo at the exact expected HEAD -> source_sha SEALS (but bundle stays
    // PROVISIONAL because authority is absent — an honest partial seal).
    const clean = writeFixture();
    const head = initGitCommitted(clean.repoRoot);
    const ok = generateBundle(clean, undefined, { expectedSha: head });
    expect(ok.sidecar.component_binding.source_sha.sealed).toBe(true);
    expect(ok.sidecar.component_binding.source_sha.clean_worktree).toBe(true);
    expect(ok.sidecar.component_binding.source_sha.expected_match).toBe(true);
    expect(ok.sidecar.component_binding.source_sha.head_sha).toBe(head);
    expect(ok.sidecar.component_binding.source_sha.git_tree_oid).toMatch(/^[0-9a-f]{40}$/);
    expect(ok.out.seal_status).toBe("PROVISIONAL_UNSEALED"); // authority still absent
    expect(ok.sidecar.unsealed_reasons).not.toContain("source_root_not_a_git_repository");

    // dirty tracked file -> unsealed.
    const dirty = writeFixture();
    const dHead = initGitCommitted(dirty.repoRoot);
    fs.appendFileSync(path.join(dirty.repoRoot, "src/api/http/routes/friday-sample-routes.ts"), "\n// dirty edit\n");
    const dRes = generateBundle(dirty, undefined, { expectedSha: dHead });
    expect(dRes.sidecar.component_binding.source_sha.sealed).toBe(false);
    expect(dRes.sidecar.component_binding.source_sha.clean_worktree).toBe(false);
    expect(dRes.sidecar.unsealed_reasons).toContain("source_worktree_dirty_or_untracked_present");

    // untracked file -> unsealed.
    const untracked = writeFixture();
    const uHead = initGitCommitted(untracked.repoRoot);
    fs.writeFileSync(path.join(untracked.repoRoot, "src/newfile.ts"), "export const x = 1;\n");
    const uRes = generateBundle(untracked, undefined, { expectedSha: uHead });
    expect(uRes.sidecar.component_binding.source_sha.sealed).toBe(false);
    expect(uRes.sidecar.unsealed_reasons).toContain("source_worktree_dirty_or_untracked_present");

    // HEAD != expected candidate sha -> unsealed.
    const wrong = writeFixture();
    initGitCommitted(wrong.repoRoot);
    const wRes = generateBundle(wrong, undefined, { expectedSha: "0".repeat(40) });
    expect(wRes.sidecar.component_binding.source_sha.sealed).toBe(false);
    expect(wRes.sidecar.component_binding.source_sha.expected_match).toBe(false);
    expect(wRes.sidecar.unsealed_reasons).toContain("source_head_sha_not_equal_expected");

    // git repo but NO expected sha provided -> unsealed (cannot pin the candidate).
    const noExp = writeFixture();
    initGitCommitted(noExp.repoRoot);
    const nRes = generateBundle(noExp);
    expect(nRes.sidecar.component_binding.source_sha.sealed).toBe(false);
    expect(nRes.sidecar.unsealed_reasons).toContain("source_expected_sha_not_provided");
  }, 60000);

  // (e) FAIL-OPEN FIX: an abbreviated/prefix `--expected-sha` must NEVER seal. On the
  // pre-fix head this sealed because the boundary accepted `{7,40}` hex and the match
  // used `headSha.startsWith(expectedSha)`; now the value must be a FULL 40-char sha
  // and HEAD must equal it with `===`. Red-first: each case seals / expected_match=true
  // on the old code -> RED there; UNSEALED or typed-error after.
  it("(e) an abbreviated/prefix --expected-sha never seals (full 40-hex + strict === required)", async () => {
    expect.hasAssertions();
    const enums = await import(ENUM_MOD);
    const roots = writeFixture();
    const head = initGitCommitted(roots.repoRoot);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    const prefix7 = head.slice(0, 7);
    const prefix39 = head.slice(0, 39);

    // library layer (sourceProvenance): a 7-char matching prefix -> UNSEALED, not matched.
    const p7 = enums.sourceProvenance(roots.repoRoot, prefix7);
    expect(p7.sealed).toBe(false); // OLD: startsWith -> true -> sealed
    expect(p7.expected_match).toBe(false);
    expect(p7.expected_sha).toBeNull(); // not a valid full candidate
    expect(p7.unsealed_reasons).toContain("source_expected_sha_not_full_40hex");

    // a 39-char matching prefix -> UNSEALED too (off-by-one is not the candidate).
    const p39 = enums.sourceProvenance(roots.repoRoot, prefix39);
    expect(p39.sealed).toBe(false);
    expect(p39.expected_match).toBe(false);
    expect(p39.unsealed_reasons).toContain("source_expected_sha_not_full_40hex");

    // uppercase full-length hex is rejected (not lowercase canonical) -> UNSEALED.
    const pUpper = enums.sourceProvenance(roots.repoRoot, head.toUpperCase());
    expect(pUpper.sealed).toBe(false);
    expect(pUpper.unsealed_reasons).toContain("source_expected_sha_not_full_40hex");

    // a valid-format full 40-char but NON-matching sha -> UNSEALED, expected_match=false.
    const pWrong = enums.sourceProvenance(roots.repoRoot, "0".repeat(40));
    expect(pWrong.sealed).toBe(false);
    expect(pWrong.expected_match).toBe(false);
    expect(pWrong.unsealed_reasons).toContain("source_head_sha_not_equal_expected");

    // the exact full 40-char HEAD on a clean checkout -> SEALS (control).
    const pExact = enums.sourceProvenance(roots.repoRoot, head);
    expect(pExact.sealed).toBe(true);
    expect(pExact.expected_match).toBe(true);

    // CLI layer: an abbreviated value is a typed EXPECTED_SHA_INVALID (never a bundle).
    const cli7 = runGen(roots, { expectedSha: prefix7 });
    expect(cli7.status).not.toBe(0); // OLD: {7,40} accepted -> exit 0 with a sealed source
    expect(cli7.err().code).toBe("EXPECTED_SHA_INVALID");
    const cli39 = runGen(roots, { expectedSha: prefix39 });
    expect(cli39.err().code).toBe("EXPECTED_SHA_INVALID");
    const cliUpper = runGen(roots, { expectedSha: head.toUpperCase() });
    expect(cliUpper.err().code).toBe("EXPECTED_SHA_INVALID");
  }, 60000);

  // F-B: a mutation between the source snapshot and the bundle write is RED, never a stale seal.
  it("(e) assertSourceUnchanged REDs on a source mutation between snapshot and write", async () => {
    expect.hasAssertions();
    const enums = await import(ENUM_MOD);
    const adapter = await import(ADAPTER_MOD);
    const roots = writeFixture();
    const head = initGitCommitted(roots.repoRoot);
    const prior = enums.sourceProvenance(roots.repoRoot, head).signature;
    expect(adapter.assertSourceUnchanged(roots.repoRoot, head, prior)).toBe(true); // unchanged -> ok
    fs.appendFileSync(path.join(roots.repoRoot, "src/api/http/routes/friday-sample-routes.ts"), "\n// mutated after snapshot\n");
    let thrown: any = null;
    try { adapter.assertSourceUnchanged(roots.repoRoot, head, prior); } catch (e) { thrown = e; }
    expect(thrown).not.toBeNull();
    expect(thrown.code).toBe("SOURCE_MUTATED_DURING_BUILD");
  }, 30000);

  // (f) DRIFT-LOCK: the closed-denominator is only sound if its component key set
  // matches the AUTHORITATIVE validator. Bind SEAL_COMPONENT_KEYS to the vendored
  // validator's own `componentsKeys` (exact members AND order). Any silent drift on
  // either side -> RED. Red-first proven by mutating SEAL_COMPONENT_KEYS (drop / add
  // / reorder) -> this test RED; restore -> green.
  it("(f) SEAL_COMPONENT_KEYS is drift-locked to the vendored validator's componentsKeys (exact members + order)", async () => {
    expect.hasAssertions();
    const mod = await import(ADAPTER_MOD);
    const vendored = vendoredComponentsKeys();
    // deep-equal INCLUDING order (toEqual on arrays is order-sensitive).
    expect([...mod.SEAL_COMPONENT_KEYS]).toEqual(vendored);
    expect([...mod.SEAL_COMPONENT_KEYS]).toStrictEqual([...vendored]);
    // sanity: the extraction found the authoritative 5-tuple (guards a silent regex miss).
    expect(vendored).toEqual(["source_sha", "cross_platform_artifact_set_sha256", "runtime_profile_digest", "obligation_set_sha256", "verification_policy_set_sha256"]);
    expect(vendored).toHaveLength(5);
  });

  // (g) GATE-SET EXACTNESS LOCK: gates are ADAPTER-INTERNAL (the R13 validator has
  // no gate concept and never reads the ...SEAL_STATUS.json sidecar), so there is no
  // external contract — the set is design-authored and PINNED here to prevent silent
  // drift. Red-first: mutate SEAL_GATE_KEYS -> this test RED; restore -> green.
  it("(g) SEAL_GATE_KEYS is pinned to exactly the 3 adapter-internal gates with no external validator contract", async () => {
    expect.hasAssertions();
    const mod = await import(ADAPTER_MOD);
    expect([...mod.SEAL_GATE_KEYS]).toEqual(["http_independent_reconciliation", "all_class_reconciliation", "discovery_ast_registration"]);
    expect(mod.SEAL_GATE_KEYS).toHaveLength(3);
    // the validator's component contract must NEVER contain a gate key (they are disjoint concepts).
    const vendored = vendoredComponentsKeys();
    for (const g of mod.SEAL_GATE_KEYS) expect(vendored).not.toContain(g);
    // frozen: the runtime set cannot be silently mutated in-process.
    expect(Object.isFrozen(mod.SEAL_GATE_KEYS)).toBe(true);
    expect(Object.isFrozen(mod.SEAL_COMPONENT_KEYS)).toBe(true);
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
    // non-git default fixture: source_sha is honestly UNSEALED (no expected-candidate pin).
    expect(sidecar.component_binding.source_sha.sealed).toBe(false);
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
