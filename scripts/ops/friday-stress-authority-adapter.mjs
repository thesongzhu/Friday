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
 *  - P0-2 (global seal truth): `computeSealStatus` returns SEALED only when
 *    EVERY tuple component AND every independently-derived gate is sealed AND a
 *    trusted authority is present. Any unsealed component / provisional gate /
 *    absent authority forces PROVISIONAL_UNSEALED. Agent-side this is always
 *    PROVISIONAL for several independent reasons.
 *
 * Only `source_sha` (COMPLETE candidate tree) and the consumed
 * `verification_policy_set_sha256` are genuinely sealed; runtime/artifact are
 * declared-content / schema-byte provisional; obligation is an explicit unsealed
 * two-pass sentinel. A `FRIDAY_STRESS_SUBJECT_INVENTORY.SEAL_STATUS.json` sidecar
 * (NOT a validator-graded artifact) names every unsealed reason.
 *
 * Exit: 0 = an honest PROVISIONAL bundle was produced; 3 = RED (missing/invalid
 * source, drift, empty enumerator).
 */
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
  completeSourceManifest,
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

// P0-2 GLOBAL SEAL TRUTH: SEALED only when every tuple component AND every gate
// is genuinely sealed AND a trusted authority is present. Any false => PROVISIONAL.
export function computeSealStatus({ componentSeal, gatesSealed, authorityPresent }) {
  const components = Object.values(componentSeal).every(Boolean);
  const gates = Object.values(gatesSealed).every(Boolean);
  return components && gates && authorityPresent === true ? "SEALED" : "PROVISIONAL_UNSEALED";
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

export function buildSubjectInventory({ sourcesRoot, repoRoot, producerId = DEFAULT_PRODUCER_ID }) {
  if (typeof sourcesRoot !== "string" || !path.isAbsolute(sourcesRoot)) throw new Red("SOURCES_ROOT_MUST_BE_ABSOLUTE", { sourcesRoot });
  if (typeof repoRoot !== "string" || !path.isAbsolute(repoRoot)) throw new Red("REPO_ROOT_MUST_BE_ABSOLUTE", { repoRoot });
  if (typeof producerId !== "string" || !producerId) throw new Red("PRODUCER_ID_INVALID");

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

  // F2 denominators.
  const source = completeSourceManifest(repoRoot);
  if (source.file_count === 0) throw new Red("SOURCE_TREE_EMPTY");
  // obligation is ALWAYS an explicit unsealed two-pass sentinel (no caller ledger).
  const obligationSentinel = digestOf({ unsealed: "OBLIGATION_LEDGER_TWO_PASS_NOT_YET_AUTHORED", subject_set_sha256 });
  const { verification_policy_set_sha256 } = buildVerificationPolicyManifest({ sourcesRoot });
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

  // P0-2 global seal truth.
  const componentSeal = {
    source_sha: true,
    verification_policy_set_sha256: true,
    cross_platform_artifact_set_sha256: false, // schema bytes, not built binaries
    runtime_profile_digest: false, // declared, not runtime-observed
    obligation_set_sha256: false, // two-pass, not authored
  };
  const gatesSealed = {
    http_independent_reconciliation: httpReconciliation.available === true && httpReconciliation.clean === true,
    all_class_reconciliation: provisionalReconClasses.length === 0,
    discovery_ast_registration: false, // static proxy discovery, not AST/registration
  };
  const authorityPresent = false; // no trusted OIDC / operator signature agent-side
  const seal_status = computeSealStatus({ componentSeal, gatesSealed, authorityPresent });

  const unsealed_reasons = ["authority_absent_no_trusted_oidc_or_operator_signature", "obligation_ledger_two_pass_not_authored",
    "artifact_set_declared_schema_bytes_not_built_binaries", "runtime_profile_declared_not_runtime_observed",
    "discovery_static_proxy_not_ast_or_runtime_registration"];
  if (!(httpReconciliation.available && httpReconciliation.clean)) {
    unsealed_reasons.push(`http_definition_vs_contract_reconciliation_not_clean:${httpReconciliation.definition_only.length}_def_only/${httpReconciliation.contract_only.length}_contract_only`);
  }
  if (provisionalReconClasses.length) unsealed_reasons.push(`reconciliation_provisional_no_independent_lens:${provisionalReconClasses.sort().join(",")}`);

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
      source_sha: { basis: source.basis, sealed: true, git_tree_oid: source.git_tree_oid, file_count: source.file_count },
      verification_policy_set_sha256: { basis: "consumed_from_TEST-STRESS-POLICY-BINDING-001", sealed: true }, // pragma: allowlist secret
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
    unsealed_reasons,
    does_not_prove:
      "does not close #45 / TEST-STRESS-AUTHORITY-ADAPTER-001 / R13 authority; agent-side the adapter is ALWAYS provisional (no trusted OIDC/operator authority). Not R13 GO, not final authority, not exhaustive completeness, not real runtime/artifact/ledger reality, not independent trust, not closure of any product, soak, device, execution or external leaf.",
  };

  return { inventory, sealStatus, rawFiles, components, tuple, subjectSetSha: subject_set_sha256, seal_status };
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

function parseArgs(argv) {
  const args = { sourcesRoot: null, repoRoot: null, outDir: null, producerId: DEFAULT_PRODUCER_ID };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--sources-root") args.sourcesRoot = argv[(i += 1)];
    else if (argv[i] === "--repo-root") args.repoRoot = argv[(i += 1)];
    else if (argv[i] === "--out-dir") args.outDir = argv[(i += 1)];
    else if (argv[i] === "--producer-id") args.producerId = argv[(i += 1)];
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
    const built = buildSubjectInventory({ sourcesRoot: path.resolve(args.sourcesRoot), repoRoot: path.resolve(args.repoRoot), producerId: args.producerId });
    if (recomputeSubjectSetSha(built.inventory.subjects) !== built.inventory.subject_set_sha256) return fail("SUBJECT_SET_SELF_RECOMPUTE_MISMATCH");
    if (recomputeFinalTupleSha(built.components) !== built.tuple) return fail("TUPLE_SELF_RECOMPUTE_MISMATCH");
    let outDir = null;
    if (args.outDir) {
      outDir = path.resolve(args.outDir);
      writeBundle(outDir, built);
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
    process.exit(0);
  } catch (error) {
    if (error instanceof Red) return fail(error.code, error.detail);
    return fail("UNEXPECTED", { detail: String(error) });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
