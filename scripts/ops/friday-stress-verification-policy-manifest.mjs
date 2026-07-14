#!/usr/bin/env node
/**
 * friday-stress-verification-policy-manifest.mjs
 *
 * TEST-STRESS-POLICY-BINDING-001 (R13 EXHAUSTIVE-STRESS) — one of the five
 * `final_release_candidate_components`: it derives `verification_policy_set_sha256`.
 *
 * This is an ADDITIVE, scratch, agent-doable tuple-component generator. It
 * enumerates the declared policy inputs from the R13 stress overlay
 * (`candidate_policy.verification_policy_covers`), resolves each to its
 * authoritative DECLARED static source, canonicalizes with the SAME algorithm
 * as the R13 evidence validator (`tools/verify-endbar-stress-evidence-r13.mjs`),
 * emits `FRIDAY_STRESS_VERIFICATION_POLICY_MANIFEST.json`, and prints the
 * resulting `verification_policy_set_sha256` (64 lowercase hex).
 *
 * IT PROVES NOTHING BEYOND ITS OWN TUPLE COMPONENT. It is NOT the R13 final
 * authority, NOT the fixture validator, and passing it does NOT close
 * TEST-STRESS-POLICY-BINDING-001 or any R13 requirement.
 *
 * The generator reads its declared sources from `--sources-root` (the directory
 * that holds the R13 stress overlay, `tools/`, `schemas/`). It NEVER touches
 * production ports/DB/services and writes only to the path given by `--out`.
 *
 * Exit codes: 0 = resolved; 3 = RED (a declared source was missing, drifted, or
 * a locked policy constant was absent). RED is the intended signal when any one
 * of the declared policy inputs is mutated or omitted.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

// --- Canonicalization mirrored BYTE-FOR-BYTE from the R13 evidence validator ---
// tools/verify-endbar-stress-evidence-r13.mjs:8-9 (sha over Buffer) and :9 (canonical).
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
          .join(",")}}`
      : JSON.stringify(value);
const digestOf = (value) => sha(Buffer.from(canonical(value)));

const SCHEMA_VERSION = "friday.stress.verification-policy-manifest.r13.v1";
const GENERATOR_ID = "scripts/ops/friday-stress-verification-policy-manifest.mjs";
const OVERLAY_REL = "FRIDAY_ENDBAR_R13_STRESS_OVERLAY.json";
const HARNESS_DIR_REL = "tools/endbar-detector-harness";
// The detector harness is a real, static R13 verification-toolchain artifact but
// is NOT named "harness" in the overlay's runtime_evidence_verification block, so
// this mapping is by inference (flagged `resolution_basis: interpretive_file_digest`).
const HARNESS_FILES = [
  "cases.mjs",
  "contract-error.mjs",
  "detectors.mjs",
  "positive-worlds.mjs",
  "validator-result-adapter.mjs",
  "world-schema.json",
];
// Locked fault-schedule constants that the R13 validator enforces; grounded by
// asserting their exact literals are present in the validator's declared bytes.
const FAULT_SCHEDULE = {
  fault_schedule_id: "before-during-after",
  network_profile_id: "partition-reconnect",
  fault_phases: ["before_effect", "during_effect", "after_effect"],
};
// Oracle field names that the overlay declares as required per-obligation.
const ORACLE_FIELDS = [
  "authoritative_oracles",
  "backpressure_oracle",
  "recovery_oracle",
  "cleanup_oracle",
  "security_invariants",
  "zero_effect_invariants",
];

class Red extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

function readFileStrict(sourcesRoot, rel) {
  if (typeof rel !== "string" || rel.startsWith("/") || rel.split("/").includes("..")) {
    throw new Red("UNSAFE_RELATIVE_PATH", { path: rel });
  }
  const abs = path.join(sourcesRoot, rel);
  let bytes;
  try {
    bytes = fs.readFileSync(abs);
  } catch (error) {
    throw new Red("DECLARED_SOURCE_MISSING", { path: rel, detail: error.code || String(error) });
  }
  return bytes;
}

function fileRef(sourcesRoot, rel) {
  const bytes = readFileStrict(sourcesRoot, rel);
  return { path: rel, sha256: sha(bytes), bytes: bytes.length };
}

function readOverlay(sourcesRoot) {
  const bytes = readFileStrict(sourcesRoot, OVERLAY_REL);
  let overlay;
  try {
    overlay = JSON.parse(bytes);
  } catch (error) {
    throw new Red("OVERLAY_INVALID_JSON", { detail: String(error) });
  }
  return overlay;
}

function requireObj(value, code, detail) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Red(code, detail);
  return value;
}

// Derive the R13 stress schema filename for a required runtime artifact, e.g.
// FRIDAY_STRESS_SUBJECT_INVENTORY.json -> endbar-stress-subject-inventory-r13.schema.json
function schemaFileForArtifact(artifact) {
  const m = /^FRIDAY_STRESS_([A-Z_]+)\.json$/.exec(artifact);
  if (!m) throw new Red("UNEXPECTED_ARTIFACT_NAME", { artifact });
  const kebab = m[1].toLowerCase().replace(/_/g, "-");
  return `schemas/endbar-stress-${kebab}-r13.schema.json`;
}

// --- Per-input resolvers. Each returns { resolution_basis, sources, value }. ---
const RESOLVERS = {
  "applicability rules": (ctx) => {
    const applicability_policy = requireObj(ctx.overlay.applicability_policy, "APPLICABILITY_POLICY_MISSING");
    const subject_model = requireObj(ctx.overlay.subject_model, "SUBJECT_MODEL_MISSING");
    return {
      resolution_basis: "overlay_declared",
      sources: [{ path: OVERLAY_REL, selector: "$.applicability_policy,$.subject_model" }],
      value: { applicability_policy, subject_model },
    };
  },
  runner: (ctx) => {
    const rel = ctx.rev.negative_runner;
    if (typeof rel !== "string" || !rel) throw new Red("RUNNER_PATH_UNDECLARED");
    const ref = fileRef(ctx.sourcesRoot, rel);
    return {
      resolution_basis: "file_digest",
      sources: [{ path: OVERLAY_REL, selector: "$.runtime_evidence_verification.negative_runner" }, ref],
      value: { declared_role: "negative_runner", ...ref },
    };
  },
  harness: (ctx) => {
    const files = HARNESS_FILES.map((name) => fileRef(ctx.sourcesRoot, `${HARNESS_DIR_REL}/${name}`)).sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    return {
      resolution_basis: "interpretive_file_digest",
      resolution_note:
        "detector harness dir is a real static R13 toolchain artifact but is not named 'harness' in the overlay; mapping is by inference",
      sources: [{ path: HARNESS_DIR_REL, selector: "declared 6-file set" }],
      value: { dir: HARNESS_DIR_REL, files },
    };
  },
  "test binary": (ctx) => {
    const rel = ctx.rev.validator;
    if (typeof rel !== "string" || !rel) throw new Red("TEST_BINARY_PATH_UNDECLARED");
    const ref = fileRef(ctx.sourcesRoot, rel);
    return {
      resolution_basis: "file_digest",
      sources: [{ path: OVERLAY_REL, selector: "$.runtime_evidence_verification.validator" }, ref],
      value: { declared_role: "validator", ...ref },
    };
  },
  "fault schedules": (ctx) => {
    // Ground the locked constants: their exact literals must be present in the
    // validator's declared bytes, else the policy has drifted -> RED.
    const validatorRel = ctx.rev.validator;
    const validatorBytes = readFileStrict(ctx.sourcesRoot, validatorRel).toString("utf8");
    const needles = [
      JSON.stringify(FAULT_SCHEDULE.fault_schedule_id),
      JSON.stringify(FAULT_SCHEDULE.network_profile_id),
      ...FAULT_SCHEDULE.fault_phases.map((p) => JSON.stringify(p)),
    ];
    const missing = needles.filter((n) => !validatorBytes.includes(n));
    if (missing.length) throw new Red("FAULT_SCHEDULE_CONSTANT_ABSENT", { missing });
    return {
      resolution_basis: "validator_constant",
      sources: [{ path: validatorRel, selector: "locked fault_schedule_id/network_profile_id/fault_phases literals" }],
      value: { ...FAULT_SCHEDULE, grounded_in_validator: true },
    };
  },
  "resource and performance budgets": (ctx) => {
    const performance_preservation = requireObj(ctx.overlay.performance_preservation, "PERFORMANCE_PRESERVATION_MISSING");
    const host_safety = requireObj(ctx.overlay.host_safety, "HOST_SAFETY_MISSING");
    const interaction_minimums = requireObj(ctx.overlay.interaction_minimums, "INTERACTION_MINIMUMS_MISSING");
    const external_policy = requireObj(ctx.overlay.external_policy, "EXTERNAL_POLICY_MISSING");
    const soak_policy = external_policy.soak;
    if (typeof soak_policy !== "string" || !soak_policy) throw new Red("SOAK_POLICY_MISSING");
    return {
      resolution_basis: "overlay_declared",
      sources: [
        {
          path: OVERLAY_REL,
          selector: "$.performance_preservation,$.host_safety,$.interaction_minimums,$.external_policy.soak",
        },
      ],
      value: { performance_preservation, host_safety, interaction_minimums, soak_policy },
    };
  },
  oracles: (ctx) => {
    const declared = ctx.overlay.obligation_required_fields;
    if (!Array.isArray(declared)) throw new Red("OBLIGATION_REQUIRED_FIELDS_MISSING");
    const missing = ORACLE_FIELDS.filter((f) => !declared.includes(f));
    if (missing.length) throw new Red("ORACLE_FIELD_UNDECLARED", { missing });
    return {
      resolution_basis: "overlay_declared",
      sources: [{ path: OVERLAY_REL, selector: "$.obligation_required_fields (oracle subset)" }],
      value: { declared_oracle_fields: [...ORACLE_FIELDS].sort() },
    };
  },
  schemas: (ctx) => {
    const artifacts = ctx.overlay.required_runtime_artifacts;
    if (!Array.isArray(artifacts) || !artifacts.length) throw new Red("REQUIRED_RUNTIME_ARTIFACTS_MISSING");
    const files = artifacts
      .map((a) => fileRef(ctx.sourcesRoot, schemaFileForArtifact(a)))
      .sort((a, b) => a.path.localeCompare(b.path));
    return {
      resolution_basis: "file_digest",
      sources: [{ path: OVERLAY_REL, selector: "$.required_runtime_artifacts -> schemas/endbar-stress-*-r13.schema.json" }],
      value: { count: files.length, files },
    };
  },
  "sensitivity detectors": (ctx) => {
    const detectors = ctx.rev.required_negative_classes;
    if (!Array.isArray(detectors) || !detectors.length) throw new Red("SENSITIVITY_DETECTORS_MISSING");
    if (new Set(detectors).size !== detectors.length) throw new Red("SENSITIVITY_DETECTORS_NOT_UNIQUE");
    return {
      resolution_basis: "overlay_declared",
      sources: [{ path: OVERLAY_REL, selector: "$.runtime_evidence_verification.required_negative_classes" }],
      value: { count: detectors.length, required_negative_classes: [...detectors] },
    };
  },
};

export function buildVerificationPolicyManifest({ sourcesRoot }) {
  if (typeof sourcesRoot !== "string" || !path.isAbsolute(sourcesRoot)) {
    throw new Red("SOURCES_ROOT_MUST_BE_ABSOLUTE", { sourcesRoot });
  }
  const overlay = readOverlay(sourcesRoot);
  const contract_revision = overlay.contract_revision;
  if (typeof contract_revision !== "string" || !contract_revision) throw new Red("OVERLAY_CONTRACT_REVISION_MISSING");
  const candidate_policy = requireObj(overlay.candidate_policy, "CANDIDATE_POLICY_MISSING");
  const covers = candidate_policy.verification_policy_covers;
  if (!Array.isArray(covers) || !covers.length) throw new Red("VERIFICATION_POLICY_COVERS_MISSING");
  if (new Set(covers).size !== covers.length) throw new Red("VERIFICATION_POLICY_COVERS_NOT_UNIQUE");

  // Born-current denominator: the declared covers set MUST exactly match the
  // resolvers we implement. A drift (new/removed cover) fails loudly rather than
  // silently dropping or fabricating an input.
  const resolverKeys = Object.keys(RESOLVERS);
  const coversSorted = [...covers].sort();
  if (canonical(coversSorted) !== canonical([...resolverKeys].sort())) {
    throw new Red("VERIFICATION_POLICY_COVERS_DENOMINATOR_DRIFT", {
      declared: coversSorted,
      resolvers: [...resolverKeys].sort(),
    });
  }

  const rev = requireObj(overlay.runtime_evidence_verification, "RUNTIME_EVIDENCE_VERIFICATION_MISSING");
  const ctx = { overlay, rev, sourcesRoot };
  const policy_inputs = {};
  for (const key of covers) {
    const resolver = RESOLVERS[key];
    if (!resolver) throw new Red("UNKNOWN_COVERS_KEY", { key });
    const resolved = resolver(ctx);
    policy_inputs[key] = { ...resolved, value_sha256: digestOf(resolved.value) };
  }

  const core = {
    schema_version: SCHEMA_VERSION,
    contract_revision,
    generator_id: GENERATOR_ID,
    does_not_prove:
      "Only the verification_policy_set_sha256 tuple component; NOT R13 GO, NOT final authority, NOT closure of TEST-STRESS-POLICY-BINDING-001 or any requirement, product, soak, device or external leaf",
    policy_covers_denominator: coversSorted,
    policy_inputs,
  };
  const verification_policy_set_sha256 = digestOf(core);
  const manifest = { ...core, verification_policy_set_sha256 };
  return { manifest, verification_policy_set_sha256 };
}

// Independent recompute helper (used by the manifest's own self-check and by tests).
export function recomputeVerificationPolicySetSha(manifest) {
  const { verification_policy_set_sha256: _drop, ...core } = manifest;
  return digestOf(core);
}

function parseArgs(argv) {
  const args = { sourcesRoot: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--sources-root") args.sourcesRoot = argv[(i += 1)];
    else if (argv[i] === "--out") args.out = argv[(i += 1)];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sourcesRoot) {
    console.error(JSON.stringify({ result: "RED", code: "MISSING_SOURCES_ROOT", usage: "--sources-root <dir> [--out <file>]" }));
    process.exit(3);
  }
  try {
    const sourcesRoot = path.resolve(args.sourcesRoot);
    const { manifest, verification_policy_set_sha256 } = buildVerificationPolicyManifest({ sourcesRoot });
    const selfCheck = recomputeVerificationPolicySetSha(manifest);
    if (selfCheck !== verification_policy_set_sha256) {
      console.error(JSON.stringify({ result: "RED", code: "SELF_RECOMPUTE_MISMATCH" }));
      process.exit(3);
    }
    let out = null;
    if (args.out) {
      out = path.resolve(args.out);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    console.log(
      JSON.stringify({
        result: "OK",
        contract_revision: manifest.contract_revision,
        verification_policy_set_sha256,
        covers_count: manifest.policy_covers_denominator.length,
        out,
        does_not_prove: manifest.does_not_prove,
      }),
    );
    process.exit(0);
  } catch (error) {
    if (error instanceof Red) {
      console.error(JSON.stringify({ result: "RED", code: error.code, detail: error.detail }));
      process.exit(3);
    }
    console.error(JSON.stringify({ result: "RED", code: "UNEXPECTED", detail: String(error) }));
    process.exit(3);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
