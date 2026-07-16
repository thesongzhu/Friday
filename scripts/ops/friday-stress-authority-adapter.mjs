#!/usr/bin/env node
/**
 * friday-stress-authority-adapter.mjs
 *
 * TEST-STRESS-AUTHORITY-ADAPTER-001 (R13 EXHAUSTIVE-STRESS).
 *
 * A PROVISIONAL-ONLY adapter. AGENT-SIDE IT CAN NEVER SELF-SEAL: there is no
 * trusted GitHub-Actions OIDC identity and no operator signature available to a
 * local caller, so every authority is authority=NONE and `seal_status` is always
 * `PROVISIONAL_UNSEALED`. It emits an HONEST subject inventory whose provisional
 * state is stated explicitly; it NEVER fake-passes and NEVER launders a
 * caller-supplied identity into a PASS.
 *
 * ROOT FIXES for the round-2 recurrences:
 *  - P0-3 (open-world / route identity): HTTP subjects carry METHOD+PATH
 *    (+operationId) identity via a per-route-object lens — GET vs POST on the
 *    same path are DISTINCT subjects (not the round-1 path-only collapse). That
 *    lens is reconciled against a GENUINELY INDEPENDENT second lens — the
 *    CI-enforced API route CONTRACT SNAPSHOT (built by the real runtime
 *    registry). Definition-vs-contract drift populates `unknown_ids`/`ghost_ids`
 *    (so the INDEPENDENT R13 validator's own reconciliation grades it), not a
 *    regrouping of the generated list. Classes with no independent second lens
 *    are marked provisional.
 *  - P0-1 (no self-issued authority): there is NO caller-controllable sealed
 *    path. `--review-statements`/`--reviewer-allowlist`/`--obligation-ledger` and
 *    the local reviewer are REMOVED. Authority verdict is always `UNREVIEWED`;
 *    the R13 validator therefore correctly REDs (`DISCOVERY_AUTHORITY_INVALID`).
 *    Real sealing would require independently-verified OIDC token claims or an
 *    operator signature — absent agent-side, so it never seals.
 *  - P0-2 / F-A (CLOSED-DENOMINATOR seal truth): `computeSealStatus` validates the
 *    component map against the FIXED closed key set `SEAL_COMPONENT_KEYS` and the
 *    gate map against `SEAL_GATE_KEYS` via `exactAllTrue` — an empty, partial,
 *    unknown-extra-key, or non-boolean map can NEVER seal. SEALED requires the
 *    EXACT 5-component tuple all `true`, the EXACT gate set all `true`, AND a
 *    trusted authority; any deviation forces PROVISIONAL_UNSEALED with a specific
 *    reason. Agent-side this is always PROVISIONAL for several independent reasons.
 *  - F-B (EXACT-candidate source provenance): `source_sha` seals ONLY for a real
 *    git repo whose HEAD equals the FULL 40-char lowercase-hex `--expected-sha`
 *    EXACTLY (an abbreviated/prefix value is rejected — a typed EXPECTED_SHA_INVALID
 *    at the boundary and `source_expected_sha_not_full_40hex` in the library), a
 *    clean worktree (`git status --porcelain` empty — no dirty, no untracked), and
 *    no symlink/special file; a mutation between snapshot and write is caught by
 *    `assertSourceUnchanged` (=> RED). Non-git / dirty / untracked / abbreviated /
 *    HEAD≠expected / special => unsealed.
 *
 * `source_sha` (git-tracked content at HEAD, via `git ls-tree -r HEAD`; immune to
 * gitignored/untracked bytes) seals ONLY under the F-B conditions above; the consumed
 * `verification_policy_set_sha256` is PROVISIONAL — declared content read via
 * `fs.readFileSync` over `--sources-root` (no git, no clean-worktree, no expected-sha
 * pin, not covered by `assertSourceUnchanged`), exactly like its runtime/artifact
 * siblings (declared-content / schema-byte provisional); obligation is an explicit
 * unsealed two-pass sentinel. A `FRIDAY_STRESS_SUBJECT_INVENTORY.SEAL_STATUS.json`
 * sidecar (NOT a validator-graded artifact) names every unsealed reason.
 *
 * Exit: 0 = an honest bundle was produced (exit 0 does NOT mean sealed/PASS). On a
 * non-SEALED exit-0 a loud PROVISIONAL_UNSEALED banner is ALWAYS printed to stderr —
 * but that banner only protects HUMAN / LOG review: a `... && GATE_PASS` shell wrapper
 * branches on the EXIT CODE ALONE and never reads stderr, so the banner by itself does
 * NOT stop it. `--strict` (exit 4, below) is the ONLY mechanism that fails such an
 * automated `&&`-style exit-code wrapper closed. 3 = RED (missing/invalid source,
 * drift, empty enumerator); 4 = `--strict` was given and `seal_status !== SEALED`
 * (fail-closed one-liner for gate callers; agent-side this is ALWAYS the case, so
 * `--strict` always exits non-zero here).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  sha,
  digestOf,
  OVERLAY_REL,
  LIFECYCLE_STATES,
  CLASS_SPEC,
  implementedCoverageClasses,
  implementedAuthorityKinds,
  sourceProvenance,
  runtimeProfileValue,
  artifactSchemaValue,
  unique,
} from "./lib/friday-stress-static-enumerators.mjs";
import { buildVerificationPolicyManifest } from "./friday-stress-verification-policy-manifest.mjs";

const SCHEMA_VERSION = "friday.endbar.stress-subject-inventory.r13.v1";
const SEAL_STATUS_SCHEMA = "friday.stress.subject-inventory-seal-status.r13.v1";
const GENERATOR_ID = "scripts/ops/friday-stress-authority-adapter.mjs";
const ENUMERATORS_URL = new URL("./lib/friday-stress-static-enumerators.mjs", import.meta.url);
const DEFAULT_PRODUCER_ID = "friday-stress-authority-adapter-agent";
const AUTHORITY_NONE_REVIEWER = "NONE_NO_TRUSTED_OIDC_OR_OPERATOR_SIGNATURE";
const SEAL_STATUS_FILE = "FRIDAY_STRESS_SUBJECT_INVENTORY.SEAL_STATUS.json";

class Red extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

function setEqual(a, b) {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

function readOverlayRef(sourcesRoot) {
  const abs = path.join(sourcesRoot, OVERLAY_REL);
  let bytes;
  try {
    bytes = fs.readFileSync(abs);
  } catch (error) {
    throw new Red("DECLARED_SOURCE_MISSING", { path: OVERLAY_REL, detail: error.code || String(error) });
  }
  let overlay;
  try {
    overlay = JSON.parse(bytes);
  } catch (error) {
    throw new Red("OVERLAY_INVALID_JSON", { detail: String(error) });
  }
  return { overlay, overlayRef: { path: `sources/${OVERLAY_REL}`, sha256: sha(bytes), bytes: bytes.length } };
}

function requireArray(value, code, detail) {
  if (!Array.isArray(value) || value.length === 0) throw new Red(code, detail);
  return value;
}

// F-A CLOSED-DENOMINATOR SEAL TRUTH. The seal maps are validated against a FIXED,
// CLOSED key set — an empty, partial, extra-key, or non-boolean map can NEVER seal.
// A generic `Object.values(map).every(Boolean)` is unsafe: `{}` passes it, and an
// unknown extra `true` cannot be distinguished from a real component.
//
// EXTERNALLY GROUNDED: this list is the exact final-release-candidate tuple the
// INDEPENDENT R13 validator enumerates as `componentsKeys` (same members, same
// order) in verify-endbar-stress-evidence-r13.mjs. It is drift-locked to the
// vendored validator fixture by an automated test (see the "(f) drift-lock" case
// in the adapter unit suite), so a silent divergence between the seal denominator
// and the authoritative validator goes RED instead of quietly mis-sealing.
export const SEAL_COMPONENT_KEYS = Object.freeze([
  "source_sha",
  "cross_platform_artifact_set_sha256",
  "runtime_profile_digest",
  "obligation_set_sha256",
  "verification_policy_set_sha256",
]);
// ADAPTER-INTERNAL, NO EXTERNAL VALIDATOR CONTRACT: gates are additional necessary
// seal conditions authored here; the R13 validator has no concept of "gates" and
// does NOT read or grade the `...SEAL_STATUS.json` sidecar, so there is no external
// source to reconcile this set against. It is therefore design-authored and PINNED
// here (frozen + exactness-locked by the "(g) gate-set" test) purely to prevent
// silent drift. Sealing requires ALL declared gates `true` AND all components
// `true` AND authorityPresent — this set only ever adds conditions, never relaxes.
export const SEAL_GATE_KEYS = Object.freeze([
  "http_independent_reconciliation",
  "all_class_reconciliation",
  "discovery_ast_registration",
]);

// Returns { ok, reason }. `ok` is true ONLY when `map` is a plain object whose key
// set is EXACTLY `expectedKeys` (no missing, no unknown-extra) and every value is
// the boolean literal `true`. Anything else yields a specific machine reason.
export function exactAllTrue(map, expectedKeys) {
  if (map === null || typeof map !== "object" || Array.isArray(map)) return { ok: false, reason: "not_a_plain_object" };
  const expected = new Set(expectedKeys);
  const actual = Object.keys(map);
  const actualSet = new Set(actual);
  const missing = expectedKeys.filter((k) => !actualSet.has(k));
  if (missing.length) return { ok: false, reason: `missing_keys:${missing.sort().join(",")}` };
  const extra = actual.filter((k) => !expected.has(k));
  if (extra.length) return { ok: false, reason: `unknown_keys:${extra.sort().join(",")}` };
  const notTrue = expectedKeys.filter((k) => map[k] !== true);
  if (notTrue.length) return { ok: false, reason: `keys_not_strictly_true:${notTrue.sort().join(",")}` };
  return { ok: true, reason: null };
}

// P0-2 GLOBAL SEAL TRUTH: SEALED only when the component map is EXACTLY the closed
// 5-key tuple all `true`, the gate map is EXACTLY the closed gate set all `true`,
// AND a trusted authority is present. Returns { status, reasons } with a specific
// reason per failing dimension. Any deviation => PROVISIONAL_UNSEALED.
//
// SEAL-TRUTH MODEL (honest disclosure of what each denominator is grounded on):
//  - components (SEAL_COMPONENT_KEYS) are EXTERNALLY GROUNDED against the R13
//    validator's own `componentsKeys` and drift-locked by an automated test;
//  - gates (SEAL_GATE_KEYS) are ADAPTER-INTERNAL necessary conditions with no
//    external validator contract, exactness-locked by an automated test;
//  - `authorityPresent` is the HARD gate. Agent-side it is hardcoded `false` (no
//    trusted OIDC/operator identity exists to a local caller), so `SEALED` is
//    STRUCTURALLY UNREACHABLE agent-side regardless of the component/gate sets —
//    the closed denominators exist so the FUTURE trusted path (real OIDC/operator
//    authority) cannot be quietly mis-sealed by a drifted key list.
export function computeSealStatus({ componentSeal, gatesSealed, authorityPresent }) {
  const reasons = [];
  const comp = exactAllTrue(componentSeal, SEAL_COMPONENT_KEYS);
  if (!comp.ok) reasons.push(`component_seal_${comp.reason}`);
  const gate = exactAllTrue(gatesSealed, SEAL_GATE_KEYS);
  if (!gate.ok) reasons.push(`gate_seal_${gate.reason}`);
  if (authorityPresent !== true) reasons.push("authority_not_present");
  return { status: reasons.length === 0 ? "SEALED" : "PROVISIONAL_UNSEALED", reasons };
}

// Internal coverage invariant (subject set == authority-partition union). This is
// structural, NOT the independent reconciliation (that is HTTP def-vs-contract).
export function reconcileCoverage(subjectIds, authorityUnion) {
  const subjects = new Set(subjectIds);
  const declared = new Set(authorityUnion);
  const missing = [...subjects].filter((id) => !declared.has(id)).sort();
  const extra = [...declared].filter((id) => !subjects.has(id)).sort();
  if (missing.length || extra.length) throw new Red("COVERAGE_INVARIANT_BROKEN", { missing, extra });
  return true;
}

export function recomputeSubjectSetSha(subjects) {
  return digestOf([...subjects].sort((a, b) => a.subject_id.localeCompare(b.subject_id)));
}
export function recomputeFinalTupleSha(components) {
  return digestOf(components);
}

export function buildSubjectInventory({ sourcesRoot, repoRoot, producerId = DEFAULT_PRODUCER_ID, expectedSha = null }) {
  if (typeof sourcesRoot !== "string" || !path.isAbsolute(sourcesRoot)) throw new Red("SOURCES_ROOT_MUST_BE_ABSOLUTE", { sourcesRoot });
  if (typeof repoRoot !== "string" || !path.isAbsolute(repoRoot)) throw new Red("REPO_ROOT_MUST_BE_ABSOLUTE", { repoRoot });
  if (typeof producerId !== "string" || !producerId) throw new Red("PRODUCER_ID_INVALID");
  // EXACT full 40-char lowercase hex only: reject abbreviated (7/39-char), 41-char,
  // uppercase, or non-hex — a prefix is NOT the reviewed candidate commit.
  if (expectedSha !== null && !(typeof expectedSha === "string" && /^[0-9a-f]{40}$/.test(expectedSha))) throw new Red("EXPECTED_SHA_INVALID", { expectedSha });

  const { overlay, overlayRef } = readOverlayRef(sourcesRoot);
  const contract_revision = overlay.contract_revision;
  if (typeof contract_revision !== "string" || !contract_revision) throw new Red("OVERLAY_CONTRACT_REVISION_MISSING");
  const bundleContract = overlay.runtime_evidence_bundle_contract;
  if (!bundleContract || typeof bundleContract !== "object") throw new Red("RUNTIME_EVIDENCE_BUNDLE_CONTRACT_MISSING");
  const declaredClasses = requireArray(bundleContract.minimum_coverage_classes, "MINIMUM_COVERAGE_CLASSES_MISSING");
  const declaredKinds = requireArray(bundleContract.authority_sources, "AUTHORITY_SOURCES_MISSING");
  const declaredDimensions = requireArray(overlay.stress_dimensions, "STRESS_DIMENSIONS_MISSING");
  if (!setEqual(implementedCoverageClasses(), declaredClasses)) {
    throw new Red("COVERAGE_CLASS_DENOMINATOR_DRIFT", { implemented: implementedCoverageClasses(), declared: [...declaredClasses].sort() });
  }
  if (!setEqual(implementedAuthorityKinds(), declaredKinds)) {
    throw new Red("AUTHORITY_DENOMINATOR_DRIFT", { implemented: implementedAuthorityKinds(), declared: [...declaredKinds].sort() });
  }

  const requirementIds = unique([overlay?.additive_requirement?.requirement_id, "TEST-STRESS-AUTHORITY-ADAPTER-001"]);
  if (requirementIds.length === 0) throw new Red("REQUIREMENT_IDS_EMPTY");
  const runtime = runtimeProfileValue(overlay);
  const artifact = artifactSchemaValue(overlay, sourcesRoot);
  if (artifact.error) throw new Red("ARTIFACT_SET_" + artifact.error, artifact);
  const profileIds = unique(Object.keys(overlay?.platform_scope ?? {}).map((k) => `runtime:${k}`));
  const artifactRoleIds = unique((overlay?.required_runtime_artifacts ?? []).map((a) => `artifact:${a}`));
  if (profileIds.length === 0) throw new Red("RUNTIME_PROFILES_EMPTY");
  if (artifactRoleIds.length === 0) throw new Red("ARTIFACT_ROLES_EMPTY");

  // P0-3 OPEN-WORLD: one subject per discovered member (route×method identity).
  const ctx = { repoRoot, overlay, overlayRef };
  const rawFiles = [];
  const subjects = [];
  const subjectIdsByAuthority = new Map();
  const provisionalClasses = [];
  const provisionalReconClasses = [];
  let httpReconciliation = { available: false, clean: false, definition_only: [], contract_only: [], confirmed: 0, reason: "not_run" };

  for (const coverageClass of implementedCoverageClasses()) {
    const spec = CLASS_SPEC[coverageClass];
    const resolved = spec.discover(ctx);
    if (!Array.isArray(resolved.members) || resolved.members.length === 0) {
      throw new Red("ENUMERATOR_EMPTY", { coverage_class: coverageClass, authority: spec.authority });
    }
    if (resolved.resolution_basis.startsWith("overlay_declared")) provisionalClasses.push(coverageClass);
    if (!resolved.reconciliation || resolved.reconciliation.available !== true) provisionalReconClasses.push(coverageClass);
    if (coverageClass === "http") httpReconciliation = resolved.reconciliation;

    const seenMembers = new Set();
    for (const member of resolved.members) {
      if (seenMembers.has(member.member_id)) continue;
      seenMembers.add(member.member_id);
      const observation = {
        coverage_class: coverageClass,
        authority: spec.authority,
        member_id: member.member_id,
        operation_id: member.operation_id ?? null,
        discovery_sealed: false,
        resolution_basis: resolved.resolution_basis,
        independent_lens: member.independent_lens ?? null,
        independent_lens_confirmed: member.independent_lens_confirmed === true,
        source_refs: [...(resolved.source_refs ?? [])].sort((a, b) => a.path.localeCompare(b.path)),
      };
      const content = `${JSON.stringify(observation, null, 2)}\n`;
      const contentSha = sha(Buffer.from(content));
      const rawPath = `raw/subject-observation-${contentSha}.json`;
      rawFiles.push({ path: rawPath, content });
      const subjectId = `${coverageClass}::${member.member_id}`;
      subjects.push({
        subject_id: subjectId,
        subject_kind: spec.subject_kind,
        coverage_class: coverageClass,
        requirement_ids: requirementIds,
        mechanism_ids: unique(spec.mechanism_ids ?? []),
        control_ids: unique(spec.control_ids ?? []),
        platform_ids: unique(spec.platform_ids),
        profile_ids: profileIds,
        artifact_role_ids: artifactRoleIds,
        reachable_state_ids: [...LIFECYCLE_STATES],
        applicable_dimensions: [...declaredDimensions],
        risk: spec.risk,
        release_required: true,
        applicability_rule_id: `applicability:${coverageClass}`,
        discovery_refs: [{ path: rawPath, sha256: contentSha, bytes: Buffer.byteLength(content), kind: "static_subject_observation" }],
      });
      if (!subjectIdsByAuthority.has(spec.authority)) subjectIdsByAuthority.set(spec.authority, []);
      subjectIdsByAuthority.get(spec.authority).push(subjectId);
    }
  }
  if (new Set(subjects.map((s) => s.subject_id)).size !== subjects.length) throw new Red("DUPLICATE_SUBJECT_ID");

  const sortedSubjects = [...subjects].sort((a, b) => a.subject_id.localeCompare(b.subject_id));
  const subject_set_sha256 = digestOf(sortedSubjects);
  const subjectIdSet = new Set(sortedSubjects.map((s) => s.subject_id));

  // F2 denominators. F-B: source_sha is sealed ONLY for a real git repo at the
  // EXACT expected HEAD with a clean worktree and no symlink/special entry.
  const source = sourceProvenance(repoRoot, expectedSha);
  if (source.file_count === 0) {
    // Propagate the library's unsealed reasons so a real ls-tree TRUNCATION is DIAGNOSABLE
    // from the CLI. Previously this threw a detail-less SOURCE_TREE_EMPTY — indistinguishable
    // from a genuinely empty repo — silently dropping the `source_ls_tree_failed_or_truncated`
    // diagnostic the library set. A truncation gets a DISTINCT code; still fail-closed (exit 3).
    const truncated = source.unsealed_reasons.includes("source_ls_tree_failed_or_truncated");
    throw new Red(truncated ? "SOURCE_LS_TREE_TRUNCATED" : "SOURCE_TREE_EMPTY", { unsealed_reasons: source.unsealed_reasons });
  }
  // obligation is ALWAYS an explicit unsealed two-pass sentinel (no caller ledger).
  const obligationSentinel = digestOf({ unsealed: "OBLIGATION_LEDGER_TWO_PASS_NOT_YET_AUTHORED", subject_set_sha256 });
  // buildVerificationPolicyManifest throws its OWN local `class Red` (a DISTINCT class
  // object from this module's Red), so main()'s `error instanceof Red` check would be false
  // for its errors and collapse them to `{code:UNEXPECTED}` — losing the machine-readable
  // code/detail for exactly the verification_policy_set_sha256 component. Re-wrap as THIS
  // module's Red, preserving `.code`/`.detail`. Still fail-closed (exit 3), now diagnosable.
  let verification_policy_set_sha256;
  try {
    ({ verification_policy_set_sha256 } = buildVerificationPolicyManifest({ sourcesRoot }));
  } catch (error) {
    if (error && typeof error.code === "string") throw new Red(error.code, error.detail ?? {});
    throw new Red("VERIFICATION_POLICY_MANIFEST_ERROR", { detail: String(error) });
  }
  const components = {
    source_sha: source.digest,
    cross_platform_artifact_set_sha256: digestOf(artifact.value),
    runtime_profile_digest: digestOf(runtime),
    obligation_set_sha256: obligationSentinel,
    verification_policy_set_sha256,
  };
  const tuple = digestOf(components);

  // P0-1 authority = NONE: every attestation is UNREVIEWED (never self-issued PASS).
  const generatorSha = sha(fs.readFileSync(ENUMERATORS_URL));
  const authorityUnion = [];
  const authority_inputs = [];
  const authoritySeal = {};
  for (const kind of [...declaredKinds].sort()) {
    const owned = unique(subjectIdsByAuthority.get(kind) ?? []);
    if (owned.length === 0) throw new Red("AUTHORITY_WITHOUT_SUBJECTS", { kind });
    authorityUnion.push(...owned);
    authoritySeal[kind] = { reviewed: false, basis: "authority_none_no_trusted_oidc_or_operator_signature" };
    const attestation = {
      source_kind: kind,
      final_release_candidate_tuple_sha256: tuple,
      subject_ids: owned,
      generator_sha256: generatorSha,
      reviewer_id: AUTHORITY_NONE_REVIEWER,
      producer_id: producerId,
      verdict: "UNREVIEWED",
    };
    const content = `${JSON.stringify(attestation, null, 2)}\n`;
    const contentSha = sha(Buffer.from(content));
    const rawPath = `raw/discovery-authority-${kind}-${contentSha}.json`;
    rawFiles.push({ path: rawPath, content });
    authority_inputs.push({ path: rawPath, sha256: contentSha, bytes: Buffer.byteLength(content), kind: "discovery_authority" });
  }
  reconcileCoverage(sortedSubjects.map((s) => s.subject_id), authorityUnion);

  // P0-3 INDEPENDENT reconciliation -> the validator-graded unknown/ghost.
  // unknown = HTTP subjects not confirmed by the independent contract lens;
  // ghost   = contract routes with no matching subject.
  const unknown_ids = httpReconciliation.available ? httpReconciliation.definition_only.map((k) => `http::${k}`).filter((id) => subjectIdSet.has(id)).sort() : [];
  const ghost_ids = httpReconciliation.available ? httpReconciliation.contract_only.map((k) => `contract-route::${k}`).sort() : [];

  const inventory = {
    schema_version: SCHEMA_VERSION,
    contract_revision,
    producer_id: producerId,
    final_release_candidate_components: components,
    final_release_candidate_tuple_sha256: tuple,
    subject_set_sha256,
    authority_inputs,
    subjects: sortedSubjects,
    unknown_ids,
    ghost_ids,
  };

  // P0-2 global seal truth. componentSeal keys MUST be exactly SEAL_COMPONENT_KEYS.
  const componentSeal = {
    source_sha: source.sealed === true, // F-B: git-verified exact candidate, clean, no special file
    cross_platform_artifact_set_sha256: false, // schema bytes, not built binaries
    runtime_profile_digest: false, // declared, not runtime-observed
    obligation_set_sha256: false, // two-pass, not authored
    verification_policy_set_sha256: false, // declared content read via fs over --sources-root, NOT git-verified (provisional, like its 3 siblings)
  };
  const gatesSealed = {
    http_independent_reconciliation: httpReconciliation.available === true && httpReconciliation.clean === true,
    all_class_reconciliation: provisionalReconClasses.length === 0,
    discovery_ast_registration: false, // static proxy discovery, not AST/registration
  };
  const authorityPresent = false; // no trusted OIDC / operator signature agent-side
  const { status: seal_status, reasons: sealReasons } = computeSealStatus({ componentSeal, gatesSealed, authorityPresent });

  const unsealed_reasons = ["authority_absent_no_trusted_oidc_or_operator_signature", "obligation_ledger_two_pass_not_authored",
    "artifact_set_declared_schema_bytes_not_built_binaries", "runtime_profile_declared_not_runtime_observed",
    "discovery_static_proxy_not_ast_or_runtime_registration"];
  unsealed_reasons.push(...source.unsealed_reasons);
  if (!(httpReconciliation.available && httpReconciliation.clean)) {
    unsealed_reasons.push(`http_definition_vs_contract_reconciliation_not_clean:${httpReconciliation.definition_only.length}_def_only/${httpReconciliation.contract_only.length}_contract_only`);
  }
  if (provisionalReconClasses.length) unsealed_reasons.push(`reconciliation_provisional_no_independent_lens:${provisionalReconClasses.sort().join(",")}`);
  unsealed_reasons.push(...sealReasons);
  const dedupedUnsealedReasons = [...new Set(unsealed_reasons)];

  const sealStatus = {
    schema_version: SEAL_STATUS_SCHEMA,
    contract_revision,
    producer_id: producerId,
    generator_id: GENERATOR_ID,
    final_release_candidate_tuple_sha256: tuple,
    subject_set_sha256,
    subjects: sortedSubjects.length,
    seal_status,
    can_ever_self_seal_agent_side: false,
    component_binding: {
      source_sha: {
        basis: source.basis,
        sealed: source.sealed,
        git_tree_oid: source.git_tree_oid,
        head_sha: source.head_sha,
        clean_worktree: source.clean_worktree,
        expected_sha: source.expected_sha,
        expected_match: source.expected_match,
        file_count: source.file_count,
      },
      verification_policy_set_sha256: { basis: "consumed_from_TEST-STRESS-POLICY-BINDING-001", sealed: false, reason: "declared_content_not_git_verified" }, // pragma: allowlist secret
      cross_platform_artifact_set_sha256: { basis: "declared_required_artifact_schema_bytes", sealed: false },
      runtime_profile_digest: { basis: "declared_full_content", sealed: false },
      obligation_set_sha256: { basis: "unsealed_two_pass_sentinel", sealed: false },
    },
    independent_reconciliation: {
      http: {
        basis: "api_route_contract_snapshot",
        available: httpReconciliation.available,
        clean: httpReconciliation.clean,
        confirmed: httpReconciliation.confirmed,
        definition_only_count: httpReconciliation.definition_only.length,
        contract_only_count: httpReconciliation.contract_only.length,
        definition_only_sample: httpReconciliation.definition_only.slice(0, 10),
      },
      internal_coverage_invariant: { unknown: 0, ghost: 0, note: "subject==authority-partition union; structural, NOT the independent check" },
      provisional_classes_no_independent_lens: provisionalReconClasses.sort(),
    },
    authority_seal: authoritySeal,
    provisional_placeholder_classes: provisionalClasses.sort(),
    unsealed_reasons: dedupedUnsealedReasons,
    does_not_prove:
      "does not close #45 / TEST-STRESS-AUTHORITY-ADAPTER-001 / R13 authority; agent-side the adapter is ALWAYS provisional (no trusted OIDC/operator authority). Not R13 GO, not final authority, not exhaustive completeness, not real runtime/artifact/ledger reality, not independent trust, not closure of any product, soak, device, execution or external leaf.",
  };

  return { inventory, sealStatus, rawFiles, components, tuple, subjectSetSha: subject_set_sha256, seal_status, sourceSignature: source.signature };
}

// F-B mutation guard: re-observe the source AFTER the bundle is written and confirm
// the exact-candidate signature is byte-identical. A mutation between snapshot and
// write invalidates the binding => RED (never a silent stale seal).
export function assertSourceUnchanged(repoRoot, expectedSha, priorSignature) {
  const now = sourceProvenance(repoRoot, expectedSha);
  if (now.signature !== priorSignature) {
    throw new Red("SOURCE_MUTATED_DURING_BUILD", { prior: priorSignature, now: now.signature });
  }
  return true;
}

export function writeBundle(outDir, { inventory, sealStatus, rawFiles }) {
  fs.mkdirSync(path.join(outDir, "raw"), { recursive: true });
  for (const file of rawFiles) {
    const abs = path.join(outDir, file.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, file.content);
  }
  fs.writeFileSync(path.join(outDir, "FRIDAY_STRESS_SUBJECT_INVENTORY.json"), `${JSON.stringify(inventory, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, SEAL_STATUS_FILE), `${JSON.stringify(sealStatus, null, 2)}\n`);
  const allRefs = [...inventory.subjects.flatMap((s) => s.discovery_refs), ...inventory.authority_inputs];
  for (const ref of allRefs) {
    const bytes = fs.readFileSync(path.join(outDir, ref.path));
    if (sha(bytes) !== ref.sha256 || bytes.length !== ref.bytes) throw new Red("SELF_VERIFY_DRIFT", { path: ref.path });
  }
  return { rawCount: rawFiles.length };
}

function isInsideOrEqual(child, parent) {
  return child === parent || child.startsWith(parent + path.sep);
}

// TRANSACTIONAL, FAIL-CLOSED PUBLICATION. The pre-fix path wrote the COMPLETE final bundle
// into `--out-dir` and only AFTERWARD re-checked the bound source: on a source mutation
// during the (possibly slow) evidence write it correctly exited 3 SOURCE_MUTATED_DURING_BUILD
// but LEFT the already-written final files — a retained seal sidecar still claiming
// source_sha.sealed=true/clean_worktree=true/expected_match=true for the PRE-mutation
// observation, which a downstream consumer could pick up as if valid (a fail-closed hole).
//
// Now the whole bundle is written into a request-unique STAGING sibling of the final out-dir
// (same filesystem => the publish is a single atomic `fs.renameSync`). ONLY AFTER the bundle
// is fully staged do we RE-OBSERVE every bound-source integrity check — the SAME signature
// equality assertSourceUnchanged enforces (=> SOURCE_MUTATED_DURING_BUILD) PLUS a re-verify
// of every seal-gating source field (digest/source_sha, sealed, clean_worktree, expected_match,
// head_sha) — closing the TOCTOU where a source mutates during evidence writing. The atomic
// publish happens ONLY if every check passes. On ANY error after staging begins the staging
// dir is recursively removed and NO consumable bundle is left in the final out-dir. A
// destination that overlaps the source/repo tree, or a planted destination symlink, is refused.
function publishBundleTransactionally({ finalOutDir, repoRoot, sourcesRoot, expectedSha, built }) {
  const parentDir = path.dirname(finalOutDir);
  fs.mkdirSync(parentDir, { recursive: true }); // preserve the prior mkdir -p of the out-dir path
  const realParent = fs.realpathSync(parentDir); // collapse ancestor symlinks (e.g. /tmp) ONCE, consistently
  const target = path.join(realParent, path.basename(finalOutDir));

  // OVERLAP GUARD (realpath-based): never publish evidence INTO / over the attested trees.
  const repoRootReal = fs.realpathSync(repoRoot);
  const sourcesRootReal = fs.realpathSync(sourcesRoot);
  for (const [name, root] of [["repo_root", repoRootReal], ["sources_root", sourcesRootReal]]) {
    if (isInsideOrEqual(target, root) || isInsideOrEqual(root, target)) {
      throw new Red("OUT_DIR_OVERLAPS_SOURCE", { out_dir: target, overlaps: name, root });
    }
  }

  // SYMLINK GUARD: a planted symlink AT the destination must not redirect the atomic publish.
  const lstatOrNull = (p) => {
    try { return fs.lstatSync(p); } catch { return null; }
  };
  const existing = lstatOrNull(target);
  if (existing && existing.isSymbolicLink()) throw new Red("OUT_DIR_IS_SYMLINK", { out_dir: target });
  if (existing && !existing.isDirectory()) throw new Red("OUT_DIR_NOT_A_DIRECTORY", { out_dir: target });
  if (existing && existing.isDirectory()) {
    // OUT_DIR_EXISTS: prefer fail-closed on a NON-empty pre-existing bundle dir (the prior
    // in-place overwrite left stale files); an EMPTY dir is replaced atomically below.
    const entries = fs.readdirSync(target);
    if (entries.length > 0) throw new Red("OUT_DIR_EXISTS", { out_dir: target, entry_sample: entries.slice(0, 10).sort() });
  }

  const staging = path.join(realParent, `.friday-stress-staging-${crypto.randomBytes(12).toString("hex")}`);
  try {
    writeBundle(staging, built);

    // TEST-ONLY deterministic injection of a source mutation DURING the evidence-writing
    // phase, so the transactional guard can be exercised end-to-end through the real CLI.
    // Inert unless the env var is set; NEVER exercised in production; can ONLY ADD fail-closed
    // mutation detection (it appends to a caller-named path) — it can never launder a seal.
    if (process.env.FRIDAY_STRESS_TEST_MUTATE_AFTER_STAGE) {
      fs.appendFileSync(process.env.FRIDAY_STRESS_TEST_MUTATE_AFTER_STAGE, "\n// test-injected source mutation during build\n");
    }

    // RE-OBSERVE the bound source ONCE, AFTER staging is complete — closes the TOCTOU. This is
    // the SAME check assertSourceUnchanged performs (signature equality => SOURCE_MUTATED_DURING_BUILD)
    // plus a re-verify of every seal-gating source field still equalling what was sealed.
    const reobs = sourceProvenance(repoRoot, expectedSha);
    if (reobs.signature !== built.sourceSignature) {
      throw new Red("SOURCE_MUTATED_DURING_BUILD", { prior: built.sourceSignature, now: reobs.signature });
    }
    const bound = built.sealStatus.component_binding.source_sha;
    if (
      reobs.digest !== built.components.source_sha ||
      reobs.sealed !== bound.sealed ||
      reobs.clean_worktree !== bound.clean_worktree ||
      reobs.expected_match !== bound.expected_match ||
      reobs.head_sha !== bound.head_sha
    ) {
      throw new Red("SOURCE_SEAL_REVERIFY_MISMATCH", {
        expected: { source_sha: built.components.source_sha, sealed: bound.sealed, clean_worktree: bound.clean_worktree, expected_match: bound.expected_match, head_sha: bound.head_sha },
        reobserved: { source_sha: reobs.digest, sealed: reobs.sealed, clean_worktree: reobs.clean_worktree, expected_match: reobs.expected_match, head_sha: reobs.head_sha },
      });
    }

    // ATOMIC PUBLISH: replace an EMPTY pre-existing target (re-checked at the last moment to
    // catch a race), else create it. A non-empty / symlink / non-dir target was refused above.
    const now = lstatOrNull(target);
    if (now) {
      if (now.isSymbolicLink() || !now.isDirectory()) throw new Red("OUT_DIR_IS_SYMLINK", { out_dir: target });
      if (fs.readdirSync(target).length > 0) throw new Red("OUT_DIR_EXISTS", { out_dir: target });
      fs.rmdirSync(target); // empty dir -> remove so the rename target does not exist (portable atomic create)
    }
    fs.renameSync(staging, target);
    return target;
  } catch (error) {
    // FAIL-CLOSED cleanup: remove the staged bundle; leave NO consumable bundle in the out-dir.
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function parseArgs(argv) {
  const args = { sourcesRoot: null, repoRoot: null, outDir: null, producerId: DEFAULT_PRODUCER_ID, expectedSha: null, strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--sources-root") args.sourcesRoot = argv[(i += 1)];
    else if (argv[i] === "--repo-root") args.repoRoot = argv[(i += 1)];
    else if (argv[i] === "--out-dir") args.outDir = argv[(i += 1)];
    else if (argv[i] === "--producer-id") args.producerId = argv[(i += 1)];
    else if (argv[i] === "--expected-sha") args.expectedSha = argv[(i += 1)];
    else if (argv[i] === "--strict") args.strict = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const fail = (code, detail = {}) => {
    console.error(JSON.stringify({ result: "RED", code, detail }));
    process.exit(3);
  };
  if (!args.sourcesRoot) return fail("MISSING_SOURCES_ROOT", { usage: "--sources-root <dir> --repo-root <dir> [--out-dir <dir>]" });
  if (!args.repoRoot) return fail("MISSING_REPO_ROOT");
  try {
    const repoRoot = path.resolve(args.repoRoot);
    const built = buildSubjectInventory({ sourcesRoot: path.resolve(args.sourcesRoot), repoRoot, producerId: args.producerId, expectedSha: args.expectedSha });
    if (recomputeSubjectSetSha(built.inventory.subjects) !== built.inventory.subject_set_sha256) return fail("SUBJECT_SET_SELF_RECOMPUTE_MISMATCH");
    if (recomputeFinalTupleSha(built.components) !== built.tuple) return fail("TUPLE_SELF_RECOMPUTE_MISMATCH");
    let outDir = null;
    if (args.outDir) {
      // TRANSACTIONAL publish: stage the whole bundle, RE-OBSERVE the bound source AFTER
      // staging, and atomically rename into place ONLY if every integrity check passes;
      // fail-closed cleanup on any error leaves no partial/stale bundle in the out-dir.
      outDir = publishBundleTransactionally({
        finalOutDir: path.resolve(args.outDir),
        repoRoot,
        sourcesRoot: path.resolve(args.sourcesRoot),
        expectedSha: args.expectedSha,
        built,
      });
    } else {
      // No out-dir (nothing published): still re-observe the bound source — RED if it
      // mutated during the build.
      assertSourceUnchanged(repoRoot, args.expectedSha, built.sourceSignature);
    }
    console.log(
      JSON.stringify({
        result: "OK",
        seal_status: built.seal_status,
        can_ever_self_seal_agent_side: false,
        contract_revision: built.inventory.contract_revision,
        final_release_candidate_tuple_sha256: built.tuple,
        subject_set_sha256: built.inventory.subject_set_sha256,
        subjects: built.inventory.subjects.length,
        http_reconciliation: {
          available: built.sealStatus.independent_reconciliation.http.available,
          clean: built.sealStatus.independent_reconciliation.http.clean,
          definition_only: built.sealStatus.independent_reconciliation.http.definition_only_count,
          contract_only: built.sealStatus.independent_reconciliation.http.contract_only_count,
        },
        unknown_ids: built.inventory.unknown_ids.length,
        ghost_ids: built.inventory.ghost_ids.length,
        unsealed_reasons: built.sealStatus.unsealed_reasons,
        out_dir: outDir,
        does_not_prove: built.sealStatus.does_not_prove,
      }),
    );
    // Exit-code laundering guard: a non-SEALED bundle must NEVER be mistaken for a
    // PASS. ALWAYS emit a loud stderr banner on a non-SEALED exit-0 (a `&& GATE_PASS`
    // wrapper reads the code, not the JSON), and under --strict fail closed with a
    // distinct non-zero code so a gate caller can branch on it directly.
    const sealed = built.seal_status === "SEALED";
    if (!sealed) {
      console.error(
        `PROVISIONAL_UNSEALED — exit 0 does NOT mean sealed/PASS (seal_status=${built.seal_status}). ` +
          "Agent-side this bundle can NEVER self-seal (no trusted OIDC/operator authority); " +
          "do NOT treat generation success as a gate PASS. Use --strict to fail closed (exit 4).",
      );
      if (args.strict) process.exit(4);
    }
    process.exit(0);
  } catch (error) {
    if (error instanceof Red) return fail(error.code, error.detail);
    return fail("UNEXPECTED", { detail: String(error) });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
