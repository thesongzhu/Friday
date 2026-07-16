#!/usr/bin/env node
/**
 * friday-stress-authority-adapter.mjs
 *
 * TEST-STRESS-AUTHORITY-ADAPTER-001 (R13 EXHAUSTIVE-STRESS) — the foundational
 * subject-side adapter. It is deliberately a PROVISIONAL adapter: it produces an
 * HONEST subject inventory whose sealed / unsealed status is stated explicitly,
 * and it NEVER fake-passes.
 *
 * The three proof-theater failures this design closes (advisor audit of #1614):
 *  - F1 (open-world): emits one subject per INDEPENDENTLY-DISCOVERED member
 *    (every route / message / screen / crate surface), NOT one collapsed row per
 *    coverage class. Reconciliation fails closed on unknown/ghost.
 *  - F2 (exact denominators): `source_sha` binds the COMPLETE candidate source
 *    tree (git tree identity + full working-tree manifest) — adding ANY source
 *    file flips it. `runtime_profile_digest` / `cross_platform_artifact_set_sha256`
 *    bind FULL declared content bytes (flagged provisional — declared, not
 *    runtime-observed / built binaries). `obligation_set_sha256` is RECOMPUTED
 *    from a supplied ledger or left UNSEALED (two-pass) — an arbitrary caller
 *    digest is NEVER accepted as a final component.
 *  - F3 (no self-issued authority): the generator emits authority OBSERVATIONS
 *    with `verdict:"UNREVIEWED"`. A PASS attestation is produced ONLY when a
 *    SEPARATELY-EXECUTED, content-addressed review statement (distinct reviewer
 *    identity from an allowlist, bound to the exact tuple + generator + subject
 *    set) is supplied and verified. Missing/invalid review => UNSEALED, not PASS.
 *
 * Because a real run has no independent reviewer and no computed ledger, the
 * DEFAULT bundle is PROVISIONAL_UNSEALED and the R13 fixture validator correctly
 * REDs on it (`DISCOVERY_AUTHORITY_INVALID`, verdict != PASS). That is the honest
 * terminal state. A fully-supplied SEALED bundle (ledger + independent reviews)
 * passes the validator's subject section — proving the machinery, isolating the
 * genuinely-missing real inputs. A companion sidecar
 * (`FRIDAY_STRESS_SUBJECT_INVENTORY.SEAL_STATUS.json`) states every unsealed
 * reason. The sidecar is NOT one of the 10 validator-graded artifacts.
 *
 * Exit: 0 = an honest bundle was produced (sealed OR provisional_unsealed;
 * stdout states which); 3 = RED (missing/invalid source, drift, empty
 * enumerator, ledger digest mismatch).
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
const REVIEW_SCHEMA = "friday.stress.authority-review.r13.v1";
const GENERATOR_ID = "scripts/ops/friday-stress-authority-adapter.mjs";
const ENUMERATORS_URL = new URL("./lib/friday-stress-static-enumerators.mjs", import.meta.url);
const DEFAULT_PRODUCER_ID = "friday-stress-authority-adapter-agent";
const UNREVIEWED = "UNREVIEWED";
const SEAL_STATUS_FILE = "FRIDAY_STRESS_SUBJECT_INVENTORY.SEAL_STATUS.json";
const DIGEST_RE = /^[0-9a-f]{64}$/;

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

// F1: fail closed if the subject set and the independently-grouped authority
// (declared) set disagree in either direction.
export function reconcile(subjectIds, declaredIds) {
  const subjects = new Set(subjectIds);
  const declared = new Set(declaredIds);
  const unknown_ids = [...subjects].filter((id) => !declared.has(id)).sort();
  const ghost_ids = [...declared].filter((id) => !subjects.has(id)).sort();
  if (unknown_ids.length || ghost_ids.length) {
    throw new Red("SUBJECT_RECONCILIATION_NONZERO", { unknown_ids, ghost_ids });
  }
  return { unknown_ids, ghost_ids };
}

export function recomputeSubjectSetSha(subjects) {
  return digestOf([...subjects].sort((a, b) => a.subject_id.localeCompare(b.subject_id)));
}

export function recomputeFinalTupleSha(components) {
  return digestOf(components);
}

// F2: bind obligation_set_sha256 by RECOMPUTING it from a supplied ledger, or
// leave it explicitly UNSEALED. An arbitrary caller digest is never a component.
function bindObligationSet({ obligationLedgerPath, subjectSetSha }) {
  if (!obligationLedgerPath) {
    return {
      digest: digestOf({ unsealed: "OBLIGATION_LEDGER_TWO_PASS_NOT_YET_AUTHORED", subject_set_sha256: subjectSetSha }),
      sealed: false,
      basis: "unsealed_two_pass_sentinel",
    };
  }
  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(obligationLedgerPath));
  } catch (error) {
    throw new Red("OBLIGATION_LEDGER_UNREADABLE", { detail: error.code || String(error) });
  }
  if (!ledger || typeof ledger !== "object" || !Array.isArray(ledger.obligations) || !ledger.obligations.length) {
    throw new Red("OBLIGATION_LEDGER_SHAPE");
  }
  const sorted = [...ledger.obligations].sort((a, b) =>
    String(a.stress_obligation_id).localeCompare(String(b.stress_obligation_id)),
  );
  const recomputed = digestOf(sorted);
  if (!DIGEST_RE.test(ledger.obligation_set_sha256) || ledger.obligation_set_sha256 !== recomputed) {
    throw new Red("OBLIGATION_LEDGER_DIGEST_MISMATCH", { declared: ledger.obligation_set_sha256, recomputed });
  }
  return { digest: recomputed, sealed: true, basis: "recomputed_from_supplied_ledger" };
}

// F3: verify a SEPARATELY-EXECUTED review statement binds this exact output.
function loadReviewStatements(dir) {
  if (!dir) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch (error) {
    throw new Red("REVIEW_STATEMENTS_DIR_UNREADABLE", { detail: error.code || String(error) });
  }
  const out = [];
  for (const f of entries.sort()) {
    let stmt;
    try {
      stmt = JSON.parse(fs.readFileSync(path.join(dir, f)));
    } catch (error) {
      throw new Red("REVIEW_STATEMENT_INVALID_JSON", { path: f, detail: String(error) });
    }
    out.push(stmt);
  }
  return out;
}

function sealAuthority({ stmt, kind, tuple, generatorSha, subjectSetSha, subjectIds, producerId, reviewerAllowlist }) {
  if (!stmt) return { reviewed: false, reason: "no_review_statement" };
  const expectSubjectIdsSha = digestOf([...subjectIds].sort());
  if (
    stmt.schema_version !== REVIEW_SCHEMA ||
    typeof stmt.reviewer_id !== "string" ||
    !reviewerAllowlist.includes(stmt.reviewer_id) ||
    stmt.reviewer_id === producerId ||
    stmt.producer_id !== producerId ||
    stmt.source_kind !== kind ||
    stmt.reviewed_generator_sha256 !== generatorSha ||
    stmt.reviewed_final_release_candidate_tuple_sha256 !== tuple ||
    stmt.reviewed_subject_set_sha256 !== subjectSetSha ||
    stmt.reviewed_subject_ids_sha256 !== expectSubjectIdsSha ||
    stmt.verdict !== "PASS"
  ) {
    return { reviewed: false, reason: "review_statement_rejected" };
  }
  return { reviewed: true, reviewer_id: stmt.reviewer_id };
}

/**
 * Pure build (no disk writes). Reads declared/real sources read-only.
 * Returns { inventory, sealStatus, rawFiles, components, tuple, subjectSetSha, seal_status }.
 */
export function buildSubjectInventory({
  sourcesRoot,
  repoRoot,
  obligationLedgerPath = null,
  reviewStatementsDir = null,
  reviewerAllowlist = [],
  producerId = DEFAULT_PRODUCER_ID,
}) {
  if (typeof sourcesRoot !== "string" || !path.isAbsolute(sourcesRoot)) throw new Red("SOURCES_ROOT_MUST_BE_ABSOLUTE", { sourcesRoot });
  if (typeof repoRoot !== "string" || !path.isAbsolute(repoRoot)) throw new Red("REPO_ROOT_MUST_BE_ABSOLUTE", { repoRoot });
  if (typeof producerId !== "string" || !producerId) throw new Red("PRODUCER_ID_INVALID");
  if (!Array.isArray(reviewerAllowlist)) throw new Red("REVIEWER_ALLOWLIST_INVALID");

  const { overlay, overlayRef } = readOverlayRef(sourcesRoot);
  const contract_revision = overlay.contract_revision;
  if (typeof contract_revision !== "string" || !contract_revision) throw new Red("OVERLAY_CONTRACT_REVISION_MISSING");
  const bundleContract = overlay.runtime_evidence_bundle_contract;
  if (!bundleContract || typeof bundleContract !== "object") throw new Red("RUNTIME_EVIDENCE_BUNDLE_CONTRACT_MISSING");
  const declaredClasses = requireArray(bundleContract.minimum_coverage_classes, "MINIMUM_COVERAGE_CLASSES_MISSING");
  const declaredKinds = requireArray(bundleContract.authority_sources, "AUTHORITY_SOURCES_MISSING");
  const declaredDimensions = requireArray(overlay.stress_dimensions, "STRESS_DIMENSIONS_MISSING");

  // F1/SR4 born-current denominator drift.
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

  // F1 OPEN-WORLD: one subject per independently-discovered member.
  const ctx = { repoRoot, overlay, overlayRef };
  const rawFiles = [];
  const subjects = [];
  const subjectIdsByAuthority = new Map();
  const provisionalClasses = [];
  for (const coverageClass of implementedCoverageClasses()) {
    const spec = CLASS_SPEC[coverageClass];
    const resolved = spec.discover(ctx);
    if (!Array.isArray(resolved.members) || resolved.members.length === 0) {
      throw new Red("ENUMERATOR_EMPTY", { coverage_class: coverageClass, authority: spec.authority });
    }
    const isProvisional = resolved.resolution_basis !== "repo_static_regex_proxy";
    if (isProvisional) provisionalClasses.push(coverageClass);
    for (const member of unique(resolved.members)) {
      const observation = {
        coverage_class: coverageClass,
        authority: spec.authority,
        member,
        discovery_sealed: false,
        resolution_basis: resolved.resolution_basis,
        source_refs: [...(resolved.source_refs ?? [])].sort((a, b) => a.path.localeCompare(b.path)),
      };
      const content = `${JSON.stringify(observation, null, 2)}\n`;
      const contentSha = sha(Buffer.from(content));
      const rawPath = `raw/subject-observation-${contentSha}.json`;
      rawFiles.push({ path: rawPath, content });
      const subjectId = `${coverageClass}::${member}`;
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

  // F2 denominators.
  const source = completeSourceManifest(repoRoot);
  if (source.file_count === 0) throw new Red("SOURCE_TREE_EMPTY");
  const obligation = bindObligationSet({ obligationLedgerPath, subjectSetSha: subject_set_sha256 });
  const { verification_policy_set_sha256 } = buildVerificationPolicyManifest({ sourcesRoot });
  const components = {
    source_sha: source.digest,
    cross_platform_artifact_set_sha256: digestOf(artifact.value),
    runtime_profile_digest: digestOf(runtime),
    obligation_set_sha256: obligation.digest,
    verification_policy_set_sha256,
  };
  const tuple = digestOf(components);

  // F3 authority attestations: OBSERVATIONS (UNREVIEWED) unless independently sealed.
  const generatorSha = sha(fs.readFileSync(ENUMERATORS_URL));
  const statements = loadReviewStatements(reviewStatementsDir);
  const declaredUnion = [];
  const authority_inputs = [];
  const authoritySeal = {};
  for (const kind of [...declaredKinds].sort()) {
    const owned = unique(subjectIdsByAuthority.get(kind) ?? []);
    if (owned.length === 0) throw new Red("AUTHORITY_WITHOUT_SUBJECTS", { kind });
    declaredUnion.push(...owned);
    const stmt = statements.find((s) => s && s.source_kind === kind);
    const seal = sealAuthority({ stmt, kind, tuple, generatorSha, subjectSetSha: subject_set_sha256, subjectIds: owned, producerId, reviewerAllowlist });
    const reviewerId = seal.reviewed ? seal.reviewer_id : UNREVIEWED;
    const verdict = seal.reviewed ? "PASS" : "UNREVIEWED";
    authoritySeal[kind] = seal.reviewed ? { reviewed: true, reviewer_id: reviewerId } : { reviewed: false, reason: seal.reason };
    const attestation = {
      source_kind: kind,
      final_release_candidate_tuple_sha256: tuple,
      subject_ids: owned,
      generator_sha256: generatorSha,
      reviewer_id: reviewerId,
      producer_id: producerId,
      verdict,
    };
    const content = `${JSON.stringify(attestation, null, 2)}\n`;
    const contentSha = sha(Buffer.from(content));
    const rawPath = `raw/discovery-authority-${kind}-${contentSha}.json`;
    rawFiles.push({ path: rawPath, content });
    authority_inputs.push({ path: rawPath, sha256: contentSha, bytes: Buffer.byteLength(content), kind: "discovery_authority" });
  }

  const { unknown_ids, ghost_ids } = reconcile(sortedSubjects.map((s) => s.subject_id), declaredUnion);

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

  const allReviewed = Object.values(authoritySeal).every((a) => a.reviewed);
  const seal_status = obligation.sealed && allReviewed ? "SEALED" : "PROVISIONAL_UNSEALED";
  const unsealed_reasons = [];
  if (!obligation.sealed) unsealed_reasons.push("obligation_ledger_two_pass_not_authored");
  const unreviewedKinds = Object.entries(authoritySeal).filter(([, a]) => !a.reviewed).map(([k]) => k).sort();
  if (unreviewedKinds.length) unsealed_reasons.push(`independent_review_absent:${unreviewedKinds.join(",")}`);
  const provisional_caveats = [
    "discovery_static_proxy_regex_or_declared_not_ast_or_registration",
    "runtime_profile_declared_not_runtime_observed",
    "artifact_set_declared_schema_bytes_not_built_binaries",
    `provisional_placeholder_classes:${provisionalClasses.sort().join(",") || "none"}`,
  ];

  const sealStatus = {
    schema_version: SEAL_STATUS_SCHEMA,
    contract_revision,
    producer_id: producerId,
    generator_id: GENERATOR_ID,
    final_release_candidate_tuple_sha256: tuple,
    subject_set_sha256,
    subjects: sortedSubjects.length,
    seal_status,
    component_binding: {
      source_sha: { basis: source.basis, sealed: true, git_tree_oid: source.git_tree_oid, file_count: source.file_count },
      cross_platform_artifact_set_sha256: { basis: "declared_required_artifact_schema_bytes", sealed: false, caveat: "schemas, not built cross-platform binaries" },
      runtime_profile_digest: { basis: "declared_full_content", sealed: false, caveat: "declared runtime profile, not runtime-observed" },
      obligation_set_sha256: { basis: obligation.basis, sealed: obligation.sealed, caveat: obligation.sealed ? null : "two-pass ledger not yet authored" },
      verification_policy_set_sha256: { basis: "consumed_from_TEST-STRESS-POLICY-BINDING-001", sealed: true },
    },
    authority_seal: authoritySeal,
    reconciliation: { unknown_count: unknown_ids.length, ghost_count: ghost_ids.length, independence: "provisional_proxy_pending_ast_registration_signal" },
    provisional_caveats,
    unsealed_reasons,
    does_not_prove:
      "R13 GO, final authority, exhaustive completeness, real runtime/artifact/ledger reality, independent trust, or closure of any requirement, product, soak, device, execution or external leaf",
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
  const args = { sourcesRoot: null, repoRoot: null, obligationLedgerPath: null, reviewStatementsDir: null, reviewerAllowlist: [], outDir: null, producerId: DEFAULT_PRODUCER_ID };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--sources-root") args.sourcesRoot = argv[(i += 1)];
    else if (argv[i] === "--repo-root") args.repoRoot = argv[(i += 1)];
    else if (argv[i] === "--obligation-ledger") args.obligationLedgerPath = argv[(i += 1)];
    else if (argv[i] === "--review-statements") args.reviewStatementsDir = argv[(i += 1)];
    else if (argv[i] === "--reviewer-allowlist") args.reviewerAllowlist = (argv[(i += 1)] || "").split(",").map((s) => s.trim()).filter(Boolean);
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
  if (!args.sourcesRoot) return fail("MISSING_SOURCES_ROOT", { usage: "--sources-root <dir> --repo-root <dir> [--obligation-ledger <file>] [--review-statements <dir> --reviewer-allowlist a,b] [--out-dir <dir>]" });
  if (!args.repoRoot) return fail("MISSING_REPO_ROOT");
  try {
    const built = buildSubjectInventory({
      sourcesRoot: path.resolve(args.sourcesRoot),
      repoRoot: path.resolve(args.repoRoot),
      obligationLedgerPath: args.obligationLedgerPath ? path.resolve(args.obligationLedgerPath) : null,
      reviewStatementsDir: args.reviewStatementsDir ? path.resolve(args.reviewStatementsDir) : null,
      reviewerAllowlist: args.reviewerAllowlist,
      producerId: args.producerId,
    });
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
        contract_revision: built.inventory.contract_revision,
        final_release_candidate_tuple_sha256: built.tuple,
        subject_set_sha256: built.inventory.subject_set_sha256,
        subjects: built.inventory.subjects.length,
        authority_inputs: built.inventory.authority_inputs.length,
        authorities_reviewed: Object.values(built.sealStatus.authority_seal).filter((a) => a.reviewed).length,
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
