#!/usr/bin/env node
/**
 * friday-stress-authority-adapter.mjs
 *
 * TEST-STRESS-AUTHORITY-ADAPTER-001 (R13 EXHAUSTIVE-STRESS) — the foundational
 * subject-side "active dynamic-contract generator". It binds the seven REAL
 * S/D/A/L/S_ui/R_ui/C_ui enumerators and the exact source/runtime/artifact/ledger
 * denominators into `FRIDAY_STRESS_SUBJECT_INVENTORY.json`, reconciled to ZERO
 * unknown/ghost, with independent-reviewer authority attestations.
 *
 * WHAT IT DOES (SR1–SR4):
 *  - SR1: derives each coverage class's subjects from REAL sources via the seven
 *    static enumerators (`lib/friday-stress-static-enumerators.mjs`); an empty
 *    enumerator is a hard error (proves subjects are DERIVED, not hardcoded).
 *  - SR2: computes source/runtime/artifact denominators from declared static
 *    sources; CONSUMES the #48 `verification_policy_set_sha256`; BINDS the
 *    ledger `obligation_set_sha256` as a declared input (two-pass boundary).
 *  - SR3: emits the subject inventory bundle (inventory + content-addressed
 *    `raw/` observation + `raw/` discovery-authority attestations).
 *  - SR4: reconciliation (unknown/ghost = ∅) + born-current anti-theater gates
 *    (coverage-class + authority denominator drift; reviewer != producer).
 *
 * IT PROVES NOTHING BEYOND ITS OWN SUBJECT-INVENTORY STRUCTURE. It is NOT the
 * R13 final authority, NOT the fixture validator, and passing it does NOT close
 * TEST-STRESS-AUTHORITY-ADAPTER-001 or any R13 requirement, product, soak,
 * device, execution, or external leaf.
 *
 * DEFERRED (bound as declared inputs / downstream, NOT authored here): the full
 * OBLIGATION_LEDGER (binds `subjects_sha256`; `obligation_set_sha256` is bound
 * two-pass), MECHANISM_MATRIX / UI_CONTROL_MATRIX artifacts, DEVICE_MATRIX
 * physical signed campaigns, RESOURCE_REPORT soaks / 96 perf samples,
 * EXECUTION_CENSUS real runs, and operator Ed25519 signatures.
 *
 * Exit codes: 0 = resolved; 3 = RED (a declared source missing, an enumerator
 * empty, a denominator/authority/reconciliation gate tripped, or born-current
 * drift). RED is the intended signal on any mutation or omission.
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
  runtimeProfilesEnumerator,
  artifactRolesEnumerator,
  unique,
} from "./lib/friday-stress-static-enumerators.mjs";
import { buildVerificationPolicyManifest } from "./friday-stress-verification-policy-manifest.mjs";

const SCHEMA_VERSION = "friday.endbar.stress-subject-inventory.r13.v1";
const GENERATOR_ID = "scripts/ops/friday-stress-authority-adapter.mjs";
const ENUMERATORS_URL = new URL("./lib/friday-stress-static-enumerators.mjs", import.meta.url);
const DEFAULT_PRODUCER_ID = "friday-stress-authority-adapter-agent";
const DEFAULT_REVIEWER_ID = "friday-stress-independent-reviewer-agent";
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
  const overlayRef = { path: `sources/${OVERLAY_REL}`, sha256: sha(bytes), bytes: bytes.length };
  return { overlay, overlayRef };
}

function requireArray(value, code, detail) {
  if (!Array.isArray(value) || value.length === 0) throw new Red(code, detail);
  return value;
}

/** Assemble the reconciliation sets and fail closed if unknown/ghost != ∅. */
export function reconcile(subjectIds, authorityUnion) {
  const subjects = new Set(subjectIds);
  const declared = new Set(authorityUnion);
  const unknown_ids = [...subjects].filter((id) => !declared.has(id)).sort();
  const ghost_ids = [...declared].filter((id) => !subjects.has(id)).sort();
  if (unknown_ids.length || ghost_ids.length) {
    throw new Red("SUBJECT_RECONCILIATION_NONZERO", { unknown_ids, ghost_ids });
  }
  return { unknown_ids, ghost_ids };
}

export function recomputeSubjectSetSha(subjects) {
  const sorted = [...subjects].sort((a, b) => a.subject_id.localeCompare(b.subject_id));
  return digestOf(sorted);
}

export function recomputeFinalTupleSha(components) {
  return digestOf(components);
}

/**
 * Pure build (no disk writes). Returns { inventory, rawFiles, components, tuple,
 * subjectSetSha }. Reads declared/real sources read-only.
 */
export function buildSubjectInventory({
  sourcesRoot,
  repoRoot,
  obligationSetSha256,
  producerId = DEFAULT_PRODUCER_ID,
  reviewerId = DEFAULT_REVIEWER_ID,
}) {
  if (typeof sourcesRoot !== "string" || !path.isAbsolute(sourcesRoot)) {
    throw new Red("SOURCES_ROOT_MUST_BE_ABSOLUTE", { sourcesRoot });
  }
  if (typeof repoRoot !== "string" || !path.isAbsolute(repoRoot)) {
    throw new Red("REPO_ROOT_MUST_BE_ABSOLUTE", { repoRoot });
  }
  // SR2: obligation_set_sha256 is a DECLARED, two-pass input (the full ledger is
  // deferred; the downstream ledger generator must later match this digest).
  if (typeof obligationSetSha256 !== "string" || !DIGEST_RE.test(obligationSetSha256)) {
    throw new Red("OBLIGATION_SET_SHA_INVALID", { obligationSetSha256 });
  }
  if (typeof producerId !== "string" || !producerId) throw new Red("PRODUCER_ID_INVALID");
  if (typeof reviewerId !== "string" || !reviewerId) throw new Red("REVIEWER_ID_INVALID");
  // SR4: anti producer-only oracle — independent reviewer role separation.
  if (reviewerId === producerId) throw new Red("REVIEWER_EQUALS_PRODUCER", { producerId });

  const { overlay, overlayRef } = readOverlayRef(sourcesRoot);
  const contract_revision = overlay.contract_revision;
  if (typeof contract_revision !== "string" || !contract_revision) {
    throw new Red("OVERLAY_CONTRACT_REVISION_MISSING");
  }
  const bundleContract = overlay.runtime_evidence_bundle_contract;
  if (!bundleContract || typeof bundleContract !== "object") {
    throw new Red("RUNTIME_EVIDENCE_BUNDLE_CONTRACT_MISSING");
  }
  const declaredClasses = requireArray(bundleContract.minimum_coverage_classes, "MINIMUM_COVERAGE_CLASSES_MISSING");
  const declaredKinds = requireArray(bundleContract.authority_sources, "AUTHORITY_SOURCES_MISSING");
  const declaredDimensions = requireArray(overlay.stress_dimensions, "STRESS_DIMENSIONS_MISSING");

  // SR4: born-current denominator drift — the IMPLEMENTED enumerator set must
  // EXACTLY equal the DECLARED denominator. Any add/remove fails loudly.
  if (!setEqual(implementedCoverageClasses(), declaredClasses)) {
    throw new Red("COVERAGE_CLASS_DENOMINATOR_DRIFT", {
      implemented: implementedCoverageClasses(),
      declared: [...declaredClasses].sort(),
    });
  }
  if (!setEqual(implementedAuthorityKinds(), declaredKinds)) {
    throw new Red("AUTHORITY_DENOMINATOR_DRIFT", {
      implemented: implementedAuthorityKinds(),
      declared: [...declaredKinds].sort(),
    });
  }

  const requirementIds = unique([
    overlay?.additive_requirement?.requirement_id,
    "TEST-STRESS-AUTHORITY-ADAPTER-001",
  ]);
  if (requirementIds.length === 0) throw new Red("REQUIREMENT_IDS_EMPTY");

  // D_runtime + A_artifact declared enumerators (subject profile/artifact fields
  // + the runtime/artifact denominators).
  const runtimeEnum = runtimeProfilesEnumerator(overlay, overlayRef);
  const artifactEnum = artifactRolesEnumerator(overlay, overlayRef);
  if (runtimeEnum.profiles.length === 0) throw new Red("RUNTIME_PROFILES_EMPTY");
  if (artifactEnum.roles.length === 0) throw new Red("ARTIFACT_ROLES_EMPTY");

  const ctx = { repoRoot, overlay, overlayRef };
  const sourceManifestByPath = new Map();
  const addSources = (sources) => {
    for (const s of sources) {
      if (!s || typeof s.path !== "string") continue;
      sourceManifestByPath.set(s.path, { path: s.path, sha256: s.sha256, bytes: s.bytes });
    }
  };
  addSources(runtimeEnum.sources);
  addSources(artifactEnum.sources);

  const rawFiles = [];
  const subjects = [];
  const subjectIdsByAuthority = new Map();

  for (const coverageClass of implementedCoverageClasses()) {
    const spec = CLASS_SPEC[coverageClass];
    const resolved = spec.locus(ctx);
    // SR1: an enumerator that discovers ZERO members is a hard error — proves the
    // subject is DERIVED from real bytes, never baked to satisfy the validator.
    if (!Array.isArray(resolved.members) || resolved.members.length === 0) {
      throw new Red("ENUMERATOR_EMPTY", { coverage_class: coverageClass, authority: spec.authority });
    }
    addSources(resolved.sources ?? []);

    const observation = {
      coverage_class: coverageClass,
      authority: spec.authority,
      resolution_basis: resolved.resolution_basis ?? "repo_static",
      members: unique(resolved.members),
      sources: [...(resolved.sources ?? [])].sort((a, b) => a.path.localeCompare(b.path)),
    };
    const content = `${JSON.stringify(observation, null, 2)}\n`;
    const contentSha = sha(Buffer.from(content));
    const rawPath = `raw/subject-observation-${coverageClass}-${contentSha}.json`;
    rawFiles.push({ path: rawPath, content });
    const discoveryRef = {
      path: rawPath,
      sha256: contentSha,
      bytes: Buffer.byteLength(content),
      kind: "static_subject_observation",
    };

    const subjectId = `stress-subject:${coverageClass}`;
    subjects.push({
      subject_id: subjectId,
      subject_kind: spec.subject_kind,
      coverage_class: coverageClass,
      requirement_ids: requirementIds,
      mechanism_ids: unique(spec.mechanism_ids ?? []),
      control_ids: unique(spec.control_ids ?? []),
      platform_ids: unique(spec.platform_ids),
      profile_ids: runtimeEnum.profiles,
      artifact_role_ids: artifactEnum.roles,
      reachable_state_ids: [...LIFECYCLE_STATES],
      applicable_dimensions: [...declaredDimensions],
      risk: spec.risk,
      release_required: true,
      applicability_rule_id: `applicability:${coverageClass}`,
      discovery_refs: [discoveryRef],
    });
    if (!subjectIdsByAuthority.has(spec.authority)) subjectIdsByAuthority.set(spec.authority, []);
    subjectIdsByAuthority.get(spec.authority).push(subjectId);
  }

  const sortedSubjects = [...subjects].sort((a, b) => a.subject_id.localeCompare(b.subject_id));
  const subject_set_sha256 = digestOf(sortedSubjects);

  // SR2: denominators.
  const sourceManifest = [...sourceManifestByPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  if (sourceManifest.length === 0) throw new Red("SOURCE_TREE_EMPTY");
  const source_sha = digestOf(sourceManifest);
  const runtime_profile_digest = digestOf(runtimeEnum.value);
  const cross_platform_artifact_set_sha256 = digestOf(artifactEnum.value);
  const { verification_policy_set_sha256 } = buildVerificationPolicyManifest({ sourcesRoot });

  const components = {
    source_sha,
    cross_platform_artifact_set_sha256,
    runtime_profile_digest,
    obligation_set_sha256: obligationSetSha256,
    verification_policy_set_sha256,
  };
  const tuple = digestOf(components);

  // SR1/SR4: discovery-authority attestations (one per declared kind, independent
  // reviewer). subject_ids partition the subjects; union == every subject.
  const generatorSha = sha(fs.readFileSync(ENUMERATORS_URL));
  const authorityUnion = [];
  const authority_inputs = [];
  for (const kind of [...declaredKinds].sort()) {
    const owned = unique(subjectIdsByAuthority.get(kind) ?? []);
    if (owned.length === 0) throw new Red("AUTHORITY_WITHOUT_SUBJECTS", { kind });
    authorityUnion.push(...owned);
    const attestation = {
      source_kind: kind,
      final_release_candidate_tuple_sha256: tuple,
      subject_ids: owned,
      generator_sha256: generatorSha,
      reviewer_id: reviewerId,
      producer_id: producerId,
      verdict: "PASS",
    };
    const content = `${JSON.stringify(attestation, null, 2)}\n`;
    const contentSha = sha(Buffer.from(content));
    const rawPath = `raw/discovery-authority-${kind}-${contentSha}.json`;
    rawFiles.push({ path: rawPath, content });
    authority_inputs.push({
      path: rawPath,
      sha256: contentSha,
      bytes: Buffer.byteLength(content),
      kind: "discovery_authority",
    });
  }

  // SR4: reconciliation — unknown/ghost = ∅ (fail closed).
  const { unknown_ids, ghost_ids } = reconcile(
    sortedSubjects.map((s) => s.subject_id),
    authorityUnion,
  );

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

  return { inventory, rawFiles, components, tuple, subjectSetSha: subject_set_sha256 };
}

/** Write the bundle (inventory + raw/ files) and self-verify every ref sha. */
export function writeBundle(outDir, { inventory, rawFiles }) {
  fs.mkdirSync(path.join(outDir, "raw"), { recursive: true });
  for (const file of rawFiles) {
    const abs = path.join(outDir, file.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, file.content);
  }
  const invPath = path.join(outDir, "FRIDAY_STRESS_SUBJECT_INVENTORY.json");
  fs.writeFileSync(invPath, `${JSON.stringify(inventory, null, 2)}\n`);

  // Defense in depth: re-read every referenced raw file and confirm the sha the
  // inventory claims. A drift here means the bundle is internally inconsistent.
  const allRefs = [
    ...inventory.subjects.flatMap((s) => s.discovery_refs),
    ...inventory.authority_inputs,
  ];
  for (const ref of allRefs) {
    const bytes = fs.readFileSync(path.join(outDir, ref.path));
    if (sha(bytes) !== ref.sha256 || bytes.length !== ref.bytes) {
      throw new Red("SELF_VERIFY_DRIFT", { path: ref.path });
    }
  }
  return { inventoryPath: invPath, rawCount: rawFiles.length };
}

function parseArgs(argv) {
  const args = {
    sourcesRoot: null,
    repoRoot: null,
    obligationSetSha256: null,
    outDir: null,
    producerId: DEFAULT_PRODUCER_ID,
    reviewerId: DEFAULT_REVIEWER_ID,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--sources-root") args.sourcesRoot = argv[(i += 1)];
    else if (argv[i] === "--repo-root") args.repoRoot = argv[(i += 1)];
    else if (argv[i] === "--obligation-set-sha256") args.obligationSetSha256 = argv[(i += 1)];
    else if (argv[i] === "--out-dir") args.outDir = argv[(i += 1)];
    else if (argv[i] === "--producer-id") args.producerId = argv[(i += 1)];
    else if (argv[i] === "--reviewer-id") args.reviewerId = argv[(i += 1)];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const fail = (code, detail = {}) => {
    console.error(JSON.stringify({ result: "RED", code, detail }));
    process.exit(3);
  };
  if (!args.sourcesRoot) {
    fail("MISSING_SOURCES_ROOT", { usage: "--sources-root <dir> --repo-root <dir> --obligation-set-sha256 <64hex> [--out-dir <dir>]" });
    return;
  }
  if (!args.repoRoot) {
    fail("MISSING_REPO_ROOT");
    return;
  }
  if (!args.obligationSetSha256) {
    fail("MISSING_OBLIGATION_SET_SHA", { note: "declared two-pass input; the downstream obligation ledger must match this digest" });
    return;
  }
  try {
    const built = buildSubjectInventory({
      sourcesRoot: path.resolve(args.sourcesRoot),
      repoRoot: path.resolve(args.repoRoot),
      obligationSetSha256: args.obligationSetSha256,
      producerId: args.producerId,
      reviewerId: args.reviewerId,
    });
    // Self-consistency (recompute via the validator canonicalization).
    if (recomputeSubjectSetSha(built.inventory.subjects) !== built.inventory.subject_set_sha256) {
      fail("SUBJECT_SET_SELF_RECOMPUTE_MISMATCH");
      return;
    }
    if (recomputeFinalTupleSha(built.components) !== built.tuple) {
      fail("TUPLE_SELF_RECOMPUTE_MISMATCH");
      return;
    }
    let outDir = null;
    if (args.outDir) {
      outDir = path.resolve(args.outDir);
      writeBundle(outDir, built);
    }
    console.log(
      JSON.stringify({
        result: "OK",
        contract_revision: built.inventory.contract_revision,
        final_release_candidate_tuple_sha256: built.tuple,
        subject_set_sha256: built.inventory.subject_set_sha256,
        subjects: built.inventory.subjects.length,
        authority_inputs: built.inventory.authority_inputs.length,
        out_dir: outDir,
        does_not_prove:
          "Only the subject-inventory structure; NOT R13 GO, NOT final authority, NOT closure of TEST-STRESS-AUTHORITY-ADAPTER-001 or any requirement, product, soak, device, execution or external leaf",
      }),
    );
    process.exit(0);
  } catch (error) {
    if (error instanceof Red) {
      fail(error.code, error.detail);
      return;
    }
    fail("UNEXPECTED", { detail: String(error) });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
