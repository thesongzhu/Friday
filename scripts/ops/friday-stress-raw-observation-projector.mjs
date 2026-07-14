#!/usr/bin/env node
/**
 * friday-stress-raw-observation-projector.mjs
 *
 * TEST-STRESS-TYPED-RAW-001 (R13 EXHAUSTIVE-STRESS) — a raw-observation projector
 * for the SEVEN scratch-doable stress observation kinds:
 *   framework_census, test_execution, specialized_test, coverage, mutation,
 *   fuzz, performance_profile.
 * (The other nine kinds — performance_metric / a11y_* / device_identity /
 * physical_scenario / soak / human_* — require live, physical or operator
 * authority and are intentionally OUT of this additive scratch slice.)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HONEST NON-AUTHORITY MACHINERY. This is an ADDITIVE, scratch, agent-doable
 * fixture generator. Every artifact it emits is truth-labeled:
 *     evidence_mode:"contract_test_fixture", source_kind:"fixture_generator",
 *     final_authority:false, implementation_status:"structural_scratch_non_authority".
 * It PROVES NOTHING beyond the internal self-consistency of its own projection.
 * It is NOT the R13 final authority, NOT the fixture validator, and running it
 * does NOT close TEST-STRESS-TYPED-RAW-001 or any R13 requirement, product,
 * soak, device, performance, human or external leaf. It NEVER touches production
 * ports/DB/services/keychain and writes only under the directory given by --out.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two hash domains over one projection (kept strictly separate, per the R13
 * evidence-hardening contract):
 *   • SEMANTIC digests (raw_id, claim_id, facts_sha256): sha256 of `stableJson`
 *     (UTF-8, byte-sorted keys) — mirrored BYTE-FOR-BYTE from the exported
 *     `semanticDigest`/`stableJson` of the R13 evidence-hardening-validator.
 *   • CONTENT digests (source/output/executable/observation bytes): plain
 *     crypto.sha256 of the exact on-disk bytes (`sha256Bytes`).
 * The stress `canonical()` (tuple/subject/obligation digests) is NEVER used here.
 *
 * Non-circular raw_id: the two independent parsers emit the DOMAIN facts
 * projection (the sha'd artifact that feeds raw_id); the schema-shaped envelope
 * (which carries raw_id) is assembled separately and content-addressed for the
 * census ref. This sidesteps the raw_id fixed-point that a literal reading of a
 * "parser output == full envelope containing raw_id" model would impose while
 * honoring every cited derivation formula (raw_id, claim_id, payload, facts).
 *
 * Reuse note: the R13 evidence-hardening validator/parser/schemas live OUTSIDE
 * this repo (the separate Friday-Handoff-Log tree), so a committed CI artifact
 * must not import them. The small `stableJson`/`semanticDigest`/`sha256Bytes`
 * helpers are mirrored here byte-for-byte; the optional `--sources-root` flag
 * lets a run cross-verify the mirror against the real exported helpers.
 *
 * Modes:
 *   (default)          build the projection tree under --out.
 *   --verify <outDir>  re-derive every binding from the on-disk projection and
 *                      exit non-zero (65) with {result:"RED",code} on any drift.
 *
 * Exit codes: 0 = OK; 3 = usage/build RED; 65 = --verify detected a violation.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// ── Mirrored, byte-faithful semantic canonicalization ────────────────────────
// evidence-hardening-validator.mjs:78 (compareUtf8), :88-92 (stableJson),
// :94-95 (sha256Bytes, semanticDigest).
const sha256Bytes = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const compareUtf8 = (a, b) => Buffer.compare(Buffer.from(String(a), "utf8"), Buffer.from(String(b), "utf8"));
function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort(compareUtf8)
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}
const semanticDigest = (value) => sha256Bytes(Buffer.from(stableJson(value), "utf8"));
const scratchDigest = (label) => sha256Bytes(Buffer.from(`friday.stress.raw-observation.scratch::${label}`, "utf8"));

const REV = "ENDBAR-20260713-R13-EXHAUSTIVE-STRESS";
const ATTESTATION_REVISION = "ENDBAR-20260709-R1";
const PROJECTION_SCHEMA_VERSION = "friday.stress.raw-observation-projection.r13.v1";
const GENERATOR_ID = "scripts/ops/friday-stress-raw-observation-projector.mjs";
const PRODUCER_ID = "friday.stress.raw-projector.scratch.r13";
const SOURCE_PRODUCER_ID = "friday.stress.source-fixture.scratch.r13";
const REVIEWER_ID = "friday.stress.structural-reviewer.scratch.r13";
const CAMPAIGN_ID = "friday.stress.raw-observation.scratch.r13";
const MAX_INPUT_BYTES = 1_000_000;
const DOES_NOT_PROVE =
  "Only the internal self-consistency of this scratch raw-observation projection for seven scratch-doable stress kinds; " +
  "NOT R13 GO, NOT final authority, NOT physical/performance/soak/human reality, NOT trusted independent review, " +
  "NOT closure of TEST-STRESS-TYPED-RAW-001 or any requirement, product, device or external leaf.";

// The seven scratch-doable observation kinds (subset of the 16-kind enum).
export const SCRATCH_OBSERVATION_KINDS = Object.freeze([
  "framework_census",
  "test_execution",
  "specialized_test",
  "coverage",
  "mutation",
  "fuzz",
  "performance_profile",
]);
const REQUIRED_FRAMEWORKS = ["cargo", "custom", "github_actions", "gradle", "shell", "swift_testing", "vitest", "xctest"];

class Red extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

// ── Deterministic synthetic sources (seeded only by kind; no wall-clock, no rng) ─
// Each returns a plain object written verbatim to source/<kind>.source.json. The
// numbers are fixed fixtures; they are not measurements of any real campaign.
function syntheticSource(kind) {
  switch (kind) {
    case "framework_census":
      return {
        frameworks: REQUIRED_FRAMEWORKS.map((name, i) => ({
          name,
          present: true,
          test_count: 12 + i * 7,
        })),
      };
    case "test_execution":
      return {
        suites: [
          { suite: "hub_unit", total: 420, passed: 420, failed: 0, skipped: 0 },
          { suite: "adapter_integration", total: 96, passed: 96, failed: 0, skipped: 0 },
          { suite: "contract_routes", total: 51, passed: 51, failed: 0, skipped: 0 },
        ],
      };
    case "specialized_test":
      return {
        campaigns: [
          { campaign_kind: "property", cases: 5000, falsified: 0 },
          { campaign_kind: "diff", cases: 1200, falsified: 0 },
          { campaign_kind: "adversarial", cases: 340, falsified: 0 },
        ],
      };
    case "coverage":
      return {
        units: [
          { unit: "friday-core", covered_lines: 8123, total_lines: 8600 },
          { unit: "friday-hub", covered_lines: 15044, total_lines: 16210 },
        ],
      };
    case "mutation":
      return {
        modules: [
          { module: "session-memory", mutants: 640, killed: 611 },
          { module: "pii-redactor", mutants: 288, killed: 279 },
        ],
      };
    case "fuzz":
      return {
        targets: [
          { target: "strict-json-parser", iterations: 2_500_000, crashes: 0, corpus_size: 1840 },
          { target: "ws-frame-decoder", iterations: 1_100_000, crashes: 0, corpus_size: 970 },
        ],
      };
    case "performance_profile":
      return {
        profiles: [
          { profile: "desktop_home_interactive", samples_ms: [180, 191, 205, 188, 199, 210, 176, 220, 231, 198] },
          { profile: "input_response", samples_ms: [22, 24, 19, 27, 31, 20, 25, 29, 23, 26] },
        ],
      };
    default:
      throw new Red("UNKNOWN_OBSERVATION_KIND", { kind });
  }
}

// ── Two GENUINELY-DISTINCT parser executable sources (spawned as subprocesses) ─
// Both deterministically project source→domain-facts and agree (post-canonical);
// they share NO code, import NO production code, and differ in implementation,
// key insertion order, and on-disk formatting → distinct executable AND output
// content digests. Neither computes ids/payload digests — that canonical
// bookkeeping is done once by the projector, keeping raw_id non-circular.
//
// Written using string concatenation (no backticks / no "${") so the sources can
// live inside this module's template literals without interpolation hazards.
const PRIMARY_PARSER_SOURCE = [
  "#!/usr/bin/env node",
  "// friday-stress-raw PRIMARY parser (scratch fixture, non-authority). Functional style.",
  'import fs from "node:fs";',
  "function arg(name){ const i=process.argv.indexOf(name); return i>=0?process.argv[i+1]:null; }",
  "const kind=arg('--kind'), src=arg('--source'), out=arg('--out');",
  "if(!kind||!src||!out){ console.error(JSON.stringify({result:'RED',code:'PRIMARY_ARGS'})); process.exit(3); }",
  "const s=JSON.parse(fs.readFileSync(src,'utf8'));",
  "function p95(list){ const a=[...list].sort((x,y)=>x-y); const idx=Math.ceil(0.95*a.length)-1; return a[idx]; }",
  "function claimsFor(k){",
  "  if(k==='framework_census') return s.frameworks.map(f=>({claim_kind:'framework_presence', payload:{framework:f.name, present:f.present, test_count:f.test_count}}));",
  "  if(k==='test_execution') return s.suites.map(x=>({claim_kind:'suite_execution', payload:{suite:x.suite, total:x.total, passed:x.passed, failed:x.failed, skipped:x.skipped}}));",
  "  if(k==='specialized_test') return s.campaigns.map(c=>({claim_kind:'specialized_campaign', payload:{campaign_kind:c.campaign_kind, cases:c.cases, falsified:c.falsified}}));",
  "  if(k==='coverage') return s.units.map(u=>({claim_kind:'coverage_ratio', payload:{unit:u.unit, covered_lines:u.covered_lines, total_lines:u.total_lines, coverage_permille:Math.floor(u.covered_lines*1000/u.total_lines)}}));",
  "  if(k==='mutation') return s.modules.map(m=>({claim_kind:'mutation_score', payload:{module:m.module, mutants:m.mutants, killed:m.killed, score_permille:Math.floor(m.killed*1000/m.mutants)}}));",
  "  if(k==='fuzz') return s.targets.map(t=>({claim_kind:'fuzz_campaign', payload:{target:t.target, iterations:t.iterations, crashes:t.crashes, corpus_size:t.corpus_size}}));",
  "  if(k==='performance_profile') return s.profiles.map(pr=>{ const a=[...pr.samples_ms].sort((x,y)=>x-y); return {claim_kind:'latency_profile', payload:{profile:pr.profile, sample_count:pr.samples_ms.length, p95_ms:p95(pr.samples_ms), max_ms:a[a.length-1]}}; });",
  "  throw new Error('unknown kind '+k);",
  "}",
  "const facts={observation_kind:kind, claims:claimsFor(kind)};",
  "fs.writeFileSync(out, JSON.stringify(facts));", // compact
  "process.exit(0);",
  "",
].join("\n");

const INDEPENDENT_PARSER_SOURCE = [
  "#!/usr/bin/env node",
  "// friday-stress-raw INDEPENDENT oracle (scratch fixture, non-authority). Imperative style, independent code path.",
  'import fs from "node:fs";',
  "function getArg(flag){ for(let i=0;i<process.argv.length;i++){ if(process.argv[i]===flag) return process.argv[i+1]; } return null; }",
  "const kind=getArg('--kind'); const source=getArg('--source'); const outPath=getArg('--out');",
  "if(kind===null||source===null||outPath===null){ console.error(JSON.stringify({result:'RED',code:'ORACLE_ARGS'})); process.exit(3); }",
  "const doc=JSON.parse(fs.readFileSync(source,'utf8'));",
  "function percentile95(values){ const sortedAsc=values.slice().sort(function(a,b){return a-b;}); const position=Math.ceil(0.95*sortedAsc.length)-1; return sortedAsc[position]; }",
  "function maxOf(values){ let m=values[0]; for(const v of values){ if(v>m) m=v; } return m; }",
  "const claims=[];",
  "if(kind==='framework_census'){ for(const f of doc.frameworks){ claims.push({payload:{framework:f.name, present:f.present, test_count:f.test_count}, claim_kind:'framework_presence'}); } }",
  "else if(kind==='test_execution'){ for(const x of doc.suites){ claims.push({payload:{suite:x.suite, total:x.total, passed:x.passed, failed:x.failed, skipped:x.skipped}, claim_kind:'suite_execution'}); } }",
  "else if(kind==='specialized_test'){ for(const c of doc.campaigns){ claims.push({payload:{campaign_kind:c.campaign_kind, cases:c.cases, falsified:c.falsified}, claim_kind:'specialized_campaign'}); } }",
  "else if(kind==='coverage'){ for(const u of doc.units){ const permille=Math.floor((u.covered_lines*1000)/u.total_lines); claims.push({payload:{unit:u.unit, covered_lines:u.covered_lines, total_lines:u.total_lines, coverage_permille:permille}, claim_kind:'coverage_ratio'}); } }",
  "else if(kind==='mutation'){ for(const m of doc.modules){ const permille=Math.floor((m.killed*1000)/m.mutants); claims.push({payload:{module:m.module, mutants:m.mutants, killed:m.killed, score_permille:permille}, claim_kind:'mutation_score'}); } }",
  "else if(kind==='fuzz'){ for(const t of doc.targets){ claims.push({payload:{target:t.target, iterations:t.iterations, crashes:t.crashes, corpus_size:t.corpus_size}, claim_kind:'fuzz_campaign'}); } }",
  "else if(kind==='performance_profile'){ for(const pr of doc.profiles){ claims.push({payload:{profile:pr.profile, sample_count:pr.samples_ms.length, p95_ms:percentile95(pr.samples_ms), max_ms:maxOf(pr.samples_ms)}, claim_kind:'latency_profile'}); } }",
  "else { console.error(JSON.stringify({result:'RED',code:'ORACLE_UNKNOWN_KIND',kind:kind})); process.exit(3); }",
  "const output={claims:claims, observation_kind:kind};",
  "fs.writeFileSync(outPath, JSON.stringify(output, null, 2)+'\\n');", // pretty + trailing newline
  "process.exit(0);",
  "",
].join("\n");

function relFrom(root, abs) {
  return path.relative(root, abs).split(path.sep).join("/");
}

function readJsonFile(abs, code) {
  let bytes;
  try {
    bytes = fs.readFileSync(abs);
  } catch (error) {
    throw new Red(code, { path: abs, detail: error.code || String(error) });
  }
  try {
    return { value: JSON.parse(bytes), bytes };
  } catch (error) {
    throw new Red(code, { path: abs, detail: String(error) });
  }
}

function scratchIdentity() {
  return {
    candidate_sha: scratchDigest("candidate_sha"),
    source_tree_oid: scratchDigest("source_tree_oid"),
    artifact_set_sha256: scratchDigest("artifact_set_sha256"),
    runtime_profile_digest: scratchDigest("runtime_profile_digest"),
    currentness_epoch_sha256: scratchDigest("currentness_epoch_sha256"),
    campaign_id: CAMPAIGN_ID,
  };
}

function isoAt(baseMs, offsetMs) {
  return new Date(baseMs + offsetMs).toISOString();
}

// Assemble the schema-shaped facts (with canonical claim ids/payload digests)
// from the agreed domain facts emitted by both parsers.
function assembleFacts(observationKind, domainClaims) {
  const claims = domainClaims.map((domainClaim) => {
    const payloadBytes = Buffer.from(stableJson(domainClaim.payload), "utf8");
    const payloadSha = sha256Bytes(payloadBytes);
    return {
      claim_id: `claim:${semanticDigest({
        observation_kind: observationKind,
        claim_kind: domainClaim.claim_kind,
        payload_sha256: payloadSha,
      })}`,
      claim_kind: domainClaim.claim_kind,
      payload_canonical_json_base64: payloadBytes.toString("base64"),
      payload_bytes: payloadBytes.length,
      payload_sha256: payloadSha,
    };
  });
  return { claims };
}

function buildAttestation({ role, parserId, parser, identity, kind, kindIndex, baseMs, sourceRel, sourceBytes, sourceSha, outputRel, outputBytes, outputSha, factsSha }) {
  const roleIndex = role === "primary_parser" ? 0 : 1;
  const startOffset = 1000 + (kindIndex * 2 + roleIndex) * 1000;
  return {
    schema_version: 1,
    contract_revision: ATTESTATION_REVISION,
    manifest_kind: "evidence_parser_run_attestation",
    run_id: `run:${kind}:${role}`,
    parser_id: parserId,
    parser_role: role,
    candidate_sha: identity.candidate_sha,
    source_tree_oid: identity.source_tree_oid,
    artifact_set_sha256: identity.artifact_set_sha256,
    runtime_profile_digest: identity.runtime_profile_digest,
    currentness_epoch_sha256: identity.currentness_epoch_sha256,
    campaign_id: identity.campaign_id,
    source_path: sourceRel,
    source_bytes: sourceBytes,
    source_sha256: sourceSha,
    output_path: outputRel,
    output_bytes: outputBytes,
    output_sha256: outputSha,
    parser_executable_path: parser.executable_path,
    parser_executable_bytes: parser.executable_bytes,
    parser_executable_sha256: parser.executable_sha256,
    build_provenance_sha256: parser.build_provenance_sha256,
    runtime_identity_sha256: parser.runtime_identity_sha256,
    source_parser_contract_sha256: parser.source_parser_contract_sha256,
    sandbox_profile_sha256: scratchDigest("sandbox_profile"),
    environment_allowlist_sha256: scratchDigest("environment_allowlist"),
    network_allowed: false,
    production_code_imported: false,
    started_at: isoAt(baseMs, startOffset),
    completed_at: isoAt(baseMs, startOffset + 500),
    exit_code: 0,
    deterministic_output: true,
    payload_sha256: factsSha,
    result: "PASS",
  };
}

function writeParserExecutable(outRoot, fileName, source, roleLabel) {
  const abs = path.join(outRoot, "tools", fileName);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const bytes = Buffer.from(source, "utf8");
  fs.writeFileSync(abs, bytes);
  return {
    abs,
    executable_path: `tools/${fileName}`,
    executable_bytes: bytes.length,
    executable_sha256: sha256Bytes(bytes),
    // Distinct, deterministic provenance per parser (grounded in role + exec sha).
    build_provenance_sha256: scratchDigest(`build_provenance::${roleLabel}::${sha256Bytes(bytes)}`),
    runtime_identity_sha256: scratchDigest(`runtime_identity::${roleLabel}::node`),
    source_parser_contract_sha256: scratchDigest(`source_parser_contract::${roleLabel}`),
  };
}

function runParser(execAbs, kind, sourceAbs, outAbs) {
  const result = spawnSync(process.execPath, [execAbs, "--kind", kind, "--source", sourceAbs, "--out", outAbs], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Red("PARSER_RUN_FAILED", { kind, exec: execAbs, status: result.status, stderr: (result.stderr || "").slice(0, 400) });
  }
  return result;
}

export function buildRawObservationProjection({ outRoot, kinds = SCRATCH_OBSERVATION_KINDS, now = null } = {}) {
  if (typeof outRoot !== "string" || !path.isAbsolute(outRoot)) throw new Red("OUT_ROOT_MUST_BE_ABSOLUTE", { outRoot });
  if (!Array.isArray(kinds) || kinds.length === 0) throw new Red("KINDS_EMPTY");
  for (const kind of kinds) {
    if (!SCRATCH_OBSERVATION_KINDS.includes(kind)) throw new Red("KIND_OUT_OF_SCOPE", { kind });
  }
  if (new Set(kinds).size !== kinds.length) throw new Red("KINDS_NOT_UNIQUE");

  const baseMs = now === null ? Date.parse("2026-07-13T00:00:00.000Z") : Date.parse(now);
  if (!Number.isFinite(baseMs)) throw new Red("NOW_INVALID", { now });

  fs.mkdirSync(outRoot, { recursive: true });
  for (const sub of ["source", "parsed", "raw", "tools"]) fs.mkdirSync(path.join(outRoot, sub), { recursive: true });

  const identity = scratchIdentity();
  const primaryParser = writeParserExecutable(outRoot, "friday-stress-raw-primary-parser.mjs", PRIMARY_PARSER_SOURCE, "primary_parser");
  const independentParser = writeParserExecutable(outRoot, "friday-stress-raw-independent-oracle.mjs", INDEPENDENT_PARSER_SOURCE, "independent_oracle");
  const PRIMARY_PARSER_ID = "friday.stress.raw.primary-parser.scratch.r13";
  const INDEPENDENT_PARSER_ID = "friday.stress.raw.independent-oracle.scratch.r13";

  const parserRegistry = [
    {
      parser_id: PRIMARY_PARSER_ID,
      parser_role: "primary_parser",
      executable_path: primaryParser.executable_path,
      executable_bytes: primaryParser.executable_bytes,
      executable_sha256: primaryParser.executable_sha256,
      build_provenance_sha256: primaryParser.build_provenance_sha256,
      runtime_identity_sha256: primaryParser.runtime_identity_sha256,
      source_parser_contract_sha256: primaryParser.source_parser_contract_sha256,
      deterministic: true,
      independent_from_production: true,
      production_code_imports: false,
      output_observation_kinds: [...SCRATCH_OBSERVATION_KINDS],
      max_input_bytes: MAX_INPUT_BYTES,
    },
    {
      parser_id: INDEPENDENT_PARSER_ID,
      parser_role: "independent_oracle",
      executable_path: independentParser.executable_path,
      executable_bytes: independentParser.executable_bytes,
      executable_sha256: independentParser.executable_sha256,
      build_provenance_sha256: independentParser.build_provenance_sha256,
      runtime_identity_sha256: independentParser.runtime_identity_sha256,
      source_parser_contract_sha256: independentParser.source_parser_contract_sha256,
      deterministic: true,
      independent_from_production: true,
      production_code_imports: false,
      output_observation_kinds: [...SCRATCH_OBSERVATION_KINDS],
      max_input_bytes: MAX_INPUT_BYTES,
    },
  ];
  // Structural independence self-assertion (the four provenance domains differ).
  for (const field of ["executable_sha256", "build_provenance_sha256", "runtime_identity_sha256", "source_parser_contract_sha256"]) {
    if (parserRegistry[0][field] === parserRegistry[1][field]) throw new Red("PARSER_PAIR_NOT_INDEPENDENT", { field });
  }

  const capturedAt = isoAt(baseMs, 20_000);
  const candidateFrozenAt = isoAt(baseMs, -3_600_000);
  const generatedAt = isoAt(baseMs, 30_000);

  const catalog = [];
  const attestations = [];
  const censusRefs = [];

  kinds.forEach((kind, kindIndex) => {
    // 1. synthetic source.
    const source = syntheticSource(kind);
    const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`, "utf8");
    const sourceAbs = path.join(outRoot, "source", `${kind}.source.json`);
    fs.writeFileSync(sourceAbs, sourceBytes);
    const sourceSha = sha256Bytes(sourceBytes);

    // 2. two independent spawned parser runs → domain facts.
    const primaryOutAbs = path.join(outRoot, "parsed", `${kind}.primary.facts.json`);
    const independentOutAbs = path.join(outRoot, "parsed", `${kind}.independent.facts.json`);
    runParser(primaryParser.abs, kind, sourceAbs, primaryOutAbs);
    runParser(independentParser.abs, kind, sourceAbs, independentOutAbs);
    const primaryOutBytes = fs.readFileSync(primaryOutAbs);
    const independentOutBytes = fs.readFileSync(independentOutAbs);
    const primaryOutSha = sha256Bytes(primaryOutBytes);
    const independentOutSha = sha256Bytes(independentOutBytes);
    if (primaryOutSha === independentOutSha) throw new Red("PARSER_OUTPUTS_NOT_DISTINCT", { kind });

    // 3. agreement: both independent projections must be semantically identical.
    const primaryFacts = JSON.parse(primaryOutBytes);
    const independentFacts = JSON.parse(independentOutBytes);
    if (stableJson(primaryFacts) !== stableJson(independentFacts)) throw new Red("PARSER_DISAGREEMENT", { kind });
    if (primaryFacts.observation_kind !== kind) throw new Red("PARSER_KIND_MISMATCH", { kind });
    if (!Array.isArray(primaryFacts.claims) || primaryFacts.claims.length === 0) throw new Red("EMPTY_CLAIMS", { kind });

    // 4. non-circular raw_id from source + two independent output digests.
    const rawId = `raw:${semanticDigest({
      observation_kind: kind,
      source_sha256: sourceSha,
      primary_parser_id: PRIMARY_PARSER_ID,
      primary_output_sha256: primaryOutSha,
      independent_parser_id: INDEPENDENT_PARSER_ID,
      independent_output_sha256: independentOutSha,
    })}`;

    // 5. schema-shaped facts + envelope.
    const facts = assembleFacts(kind, primaryFacts.claims);
    const factsSha = semanticDigest(facts);
    const claimIds = facts.claims.map((claim) => claim.claim_id);
    if (new Set(claimIds).size !== claimIds.length) throw new Red("DUPLICATE_CLAIM_ID", { kind });
    const claimSetSha = semanticDigest([...claimIds].sort(compareUtf8));

    const envelope = {
      schema_version: 1,
      observation_kind: kind,
      raw_id: rawId,
      captured_at: capturedAt,
      producer_id: PRODUCER_ID,
      identity,
      facts,
      facts_sha256: factsSha,
    };
    const envelopeBytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    const observationAbs = path.join(outRoot, "raw", `${kind}.observation.json`);
    fs.writeFileSync(observationAbs, envelopeBytes);
    const observationSha = sha256Bytes(envelopeBytes);

    // 6. census ref (content digest of the on-disk envelope; path startsWith "raw/").
    const observationRel = relFrom(outRoot, observationAbs);
    censusRefs.push({ path: observationRel, sha256: observationSha, bytes: envelopeBytes.length, kind: "raw_observation" });

    // 7. catalog entry.
    catalog.push({
      observation_kind: kind,
      raw_id: rawId,
      source_path: relFrom(outRoot, sourceAbs),
      source_bytes: sourceBytes.length,
      source_sha256: sourceSha,
      source_producer_id: SOURCE_PRODUCER_ID,
      producer_id: PRODUCER_ID,
      captured_at: capturedAt,
      parser_id: PRIMARY_PARSER_ID,
      path: relFrom(outRoot, primaryOutAbs),
      bytes: primaryOutBytes.length,
      sha256: primaryOutSha,
      independent_parser_id: INDEPENDENT_PARSER_ID,
      independent_path: relFrom(outRoot, independentOutAbs),
      independent_bytes: independentOutBytes.length,
      independent_sha256: independentOutSha,
      claim_ids: claimIds,
      claim_set_sha256: claimSetSha,
      parsed_facts_sha256: factsSha,
      observation_path: observationRel,
      observation_sha256: observationSha,
    });

    // 8. two parser-run attestations (35 fields each).
    for (const [role, parserId, parserProv, outRel, outBytesLen, outSha] of [
      ["primary_parser", PRIMARY_PARSER_ID, primaryParser, relFrom(outRoot, primaryOutAbs), primaryOutBytes.length, primaryOutSha],
      ["independent_oracle", INDEPENDENT_PARSER_ID, independentParser, relFrom(outRoot, independentOutAbs), independentOutBytes.length, independentOutSha],
    ]) {
      attestations.push(
        buildAttestation({
          role,
          parserId,
          parser: parserProv,
          identity,
          kind,
          kindIndex,
          baseMs,
          sourceRel: relFrom(outRoot, sourceAbs),
          sourceBytes: sourceBytes.length,
          sourceSha,
          outputRel: outRel,
          outputBytes: outBytesLen,
          outputSha: outSha,
          factsSha,
        }),
      );
    }
  });

  // Structural (non-authority) independent-review attestation.
  const scratchTupleSha = semanticDigest(identity);
  const review = {
    schema_version: 1,
    manifest_kind: "structural_independent_review",
    kind: "independent_review",
    verdict: "PASS",
    final_release_candidate_tuple_sha256: scratchTupleSha,
    reviewer_id: REVIEWER_ID,
    producer_id: PRODUCER_ID,
    implementation_status: "structural_scratch_non_authority",
    authority_mechanism_out_of_scope:
      "The real authority is an OIDC-signed github_actions_oidc independent_requirement_review on protected main; this scratch review is structural only.",
    does_not_prove: DOES_NOT_PROVE,
  };
  const reviewBytes = Buffer.from(`${JSON.stringify(review, null, 2)}\n`, "utf8");
  const reviewAbs = path.join(outRoot, "raw", "review-attestation.json");
  fs.writeFileSync(reviewAbs, reviewBytes);
  const reviewRel = relFrom(outRoot, reviewAbs);
  const reviewRef = { path: reviewRel, sha256: sha256Bytes(reviewBytes), bytes: reviewBytes.length, kind: "independent_review" };

  const projection = {
    schema_version: PROJECTION_SCHEMA_VERSION,
    contract_revision: REV,
    manifest_kind: "raw_observation_projection",
    evidence_mode: "contract_test_fixture",
    source_kind: "fixture_generator",
    final_authority: false,
    implementation_status: "structural_scratch_non_authority",
    generator_id: GENERATOR_ID,
    does_not_prove: DOES_NOT_PROVE,
    identity,
    identity_sha256: semanticDigest(identity),
    scratch_tuple_sha256: scratchTupleSha,
    candidate_frozen_at: candidateFrozenAt,
    captured_at: capturedAt,
    generated_at: generatedAt,
    observation_kinds: [...kinds],
    parser_registry: parserRegistry,
    raw_evidence_catalog: catalog,
    parser_run_attestations: attestations,
    census_refs: censusRefs,
    review_attestation_ref: reviewRef,
  };
  const projectionAbs = path.join(outRoot, "FRIDAY_STRESS_RAW_OBSERVATION_PROJECTION.json");
  fs.writeFileSync(projectionAbs, `${JSON.stringify(projection, null, 2)}\n`);

  return { projection, projectionPath: projectionAbs };
}

// ── Re-derivation verifier (the tamper detector used by --verify) ────────────
export function verifyRawObservationProjection(outRoot) {
  if (typeof outRoot !== "string" || !path.isAbsolute(outRoot)) throw new Red("OUT_ROOT_MUST_BE_ABSOLUTE", { outRoot });
  const { value: projection } = readJsonFile(path.join(outRoot, "FRIDAY_STRESS_RAW_OBSERVATION_PROJECTION.json"), "PROJECTION_MISSING");

  if (projection.evidence_mode !== "contract_test_fixture") throw new Red("EVIDENCE_MODE_DRIFT", { got: projection.evidence_mode });
  if (projection.source_kind !== "fixture_generator") throw new Red("SOURCE_KIND_DRIFT", { got: projection.source_kind });
  if (projection.final_authority !== false) throw new Red("FINAL_AUTHORITY_MUST_BE_FALSE");
  if (projection.contract_revision !== REV) throw new Red("CONTRACT_REVISION_DRIFT");
  if (semanticDigest(projection.identity) !== projection.identity_sha256) throw new Red("IDENTITY_DIGEST_DRIFT");

  const registryById = new Map(projection.parser_registry.map((row) => [row.parser_id, row]));
  const readContent = (rel, code) => {
    const abs = path.join(outRoot, rel);
    if (!abs.startsWith(`${outRoot}${path.sep}`)) throw new Red("UNSAFE_REF_PATH", { path: rel });
    try {
      return fs.readFileSync(abs);
    } catch (error) {
      throw new Red(code, { path: rel, detail: error.code || String(error) });
    }
  };

  for (const entry of projection.raw_evidence_catalog) {
    const kind = entry.observation_kind;
    if (!SCRATCH_OBSERVATION_KINDS.includes(kind)) throw new Red("CATALOG_KIND_OUT_OF_SCOPE", { kind });

    const sourceBytes = readContent(entry.source_path, "SOURCE_MISSING");
    if (sourceBytes.length !== entry.source_bytes || sha256Bytes(sourceBytes) !== entry.source_sha256) throw new Red("SOURCE_CONTENT_DRIFT", { kind });

    const primaryBytes = readContent(entry.path, "PRIMARY_OUTPUT_MISSING");
    const independentBytes = readContent(entry.independent_path, "INDEPENDENT_OUTPUT_MISSING");
    if (sha256Bytes(primaryBytes) !== entry.sha256) throw new Red("PRIMARY_OUTPUT_DRIFT", { kind });
    if (sha256Bytes(independentBytes) !== entry.independent_sha256) throw new Red("INDEPENDENT_OUTPUT_DRIFT", { kind });
    if (entry.sha256 === entry.independent_sha256) throw new Red("OUTPUTS_NOT_DISTINCT", { kind });

    const primaryFacts = JSON.parse(primaryBytes);
    const independentFacts = JSON.parse(independentBytes);
    if (stableJson(primaryFacts) !== stableJson(independentFacts)) throw new Red("PARSER_DISAGREEMENT", { kind });

    const expectedRawId = `raw:${semanticDigest({
      observation_kind: kind,
      source_sha256: entry.source_sha256,
      primary_parser_id: entry.parser_id,
      primary_output_sha256: entry.sha256,
      independent_parser_id: entry.independent_parser_id,
      independent_output_sha256: entry.independent_sha256,
    })}`;
    if (expectedRawId !== entry.raw_id) throw new Red("RAW_ID_DRIFT", { kind });

    // Parser provenance independence (mirrors the R13 pair-independence contract).
    const primaryReg = registryById.get(entry.parser_id);
    const independentReg = registryById.get(entry.independent_parser_id);
    if (!primaryReg || !independentReg) throw new Red("UNKNOWN_PARSER_IN_CATALOG", { kind });
    if (primaryReg.parser_role !== "primary_parser" || independentReg.parser_role !== "independent_oracle") throw new Red("PARSER_ROLE_DRIFT", { kind });
    for (const field of ["executable_sha256", "build_provenance_sha256", "runtime_identity_sha256", "source_parser_contract_sha256"]) {
      if (primaryReg[field] === independentReg[field]) throw new Red("PARSER_PAIR_NOT_INDEPENDENT", { kind, field });
    }

    // Envelope + fact/claim bindings.
    const envelopeBytes = readContent(entry.observation_path, "OBSERVATION_MISSING");
    if (sha256Bytes(envelopeBytes) !== entry.observation_sha256) throw new Red("OBSERVATION_CONTENT_DRIFT", { kind });
    const envelope = JSON.parse(envelopeBytes);
    if (envelope.schema_version !== 1 || envelope.raw_id !== entry.raw_id || envelope.observation_kind !== kind) throw new Red("ENVELOPE_IDENTITY_DRIFT", { kind });
    if (semanticDigest(envelope.identity) !== projection.identity_sha256) throw new Red("ENVELOPE_IDENTITY_TUPLE_DRIFT", { kind });
    if (semanticDigest(envelope.facts) !== envelope.facts_sha256 || envelope.facts_sha256 !== entry.parsed_facts_sha256) throw new Red("FACTS_DIGEST_DRIFT", { kind });

    const claimIds = [];
    for (const claim of envelope.facts.claims) {
      const payloadBytes = Buffer.from(claim.payload_canonical_json_base64, "base64");
      if (payloadBytes.length !== claim.payload_bytes || payloadBytes.toString("base64") !== claim.payload_canonical_json_base64) throw new Red("PAYLOAD_BASE64_DRIFT", { kind });
      if (sha256Bytes(payloadBytes) !== claim.payload_sha256) throw new Red("PAYLOAD_HASH_DRIFT", { kind });
      const payload = JSON.parse(payloadBytes);
      if (!Buffer.from(stableJson(payload), "utf8").equals(payloadBytes)) throw new Red("PAYLOAD_NOT_CANONICAL", { kind });
      const expectedClaimId = `claim:${semanticDigest({ observation_kind: kind, claim_kind: claim.claim_kind, payload_sha256: claim.payload_sha256 })}`;
      if (expectedClaimId !== claim.claim_id) throw new Red("CLAIM_ID_DRIFT", { kind });
      claimIds.push(claim.claim_id);
    }
    if (stableJson([...claimIds].sort(compareUtf8)) !== stableJson([...entry.claim_ids].sort(compareUtf8))) throw new Red("CLAIM_SET_DRIFT", { kind });
    if (semanticDigest([...claimIds].sort(compareUtf8)) !== entry.claim_set_sha256) throw new Red("CLAIM_SET_DIGEST_DRIFT", { kind });
  }

  // Census refs: shape + content digest + path discipline.
  for (const ref of projection.census_refs) {
    if (!ref || typeof ref !== "object") throw new Red("CENSUS_REF_SHAPE");
    if (JSON.stringify(Object.keys(ref).sort()) !== JSON.stringify(["bytes", "kind", "path", "sha256"])) throw new Red("CENSUS_REF_KEYS", { ref });
    if (typeof ref.path !== "string" || !ref.path.startsWith("raw/")) throw new Red("CENSUS_REF_PATH", { path: ref.path });
    if (!/^[0-9a-f]{64}$/.test(ref.sha256) || !Number.isInteger(ref.bytes) || ref.bytes < 1 || typeof ref.kind !== "string" || ref.kind.length === 0) throw new Red("CENSUS_REF_FIELDS", { ref });
    const bytes = readContent(ref.path, "CENSUS_REF_TARGET_MISSING");
    if (sha256Bytes(bytes) !== ref.sha256 || bytes.length !== ref.bytes) throw new Red("CENSUS_REF_DRIFT", { path: ref.path });
  }

  // Review attestation: honest non-authority, structural PASS shape.
  const reviewRef = projection.review_attestation_ref;
  if (!reviewRef || reviewRef.kind !== "independent_review" || !reviewRef.path.startsWith("raw/")) throw new Red("REVIEW_REF_SHAPE");
  const reviewBytes = readContent(reviewRef.path, "REVIEW_MISSING");
  if (sha256Bytes(reviewBytes) !== reviewRef.sha256 || reviewBytes.length !== reviewRef.bytes) throw new Red("REVIEW_REF_DRIFT");
  const review = JSON.parse(reviewBytes);
  if (review.kind !== "independent_review") throw new Red("REVIEW_KIND_NOT_INDEPENDENT_REVIEW", { got: review.kind });
  if (review.kind === "github_actions_oidc") throw new Red("REVIEW_CLAIMS_OIDC_AUTHORITY");
  if (review.verdict !== "PASS") throw new Red("REVIEW_VERDICT");
  if (review.final_release_candidate_tuple_sha256 !== projection.scratch_tuple_sha256) throw new Red("REVIEW_TUPLE_DRIFT");
  if (review.reviewer_id === review.producer_id) throw new Red("REVIEW_REVIEWER_NOT_INDEPENDENT");
  if (review.implementation_status !== "structural_scratch_non_authority") throw new Red("REVIEW_CLAIMS_AUTHORITY");

  return {
    result: "OK",
    contract_revision: projection.contract_revision,
    final_authority: false,
    observation_kinds: projection.observation_kinds,
    raw_count: projection.raw_evidence_catalog.length,
    claim_count: projection.raw_evidence_catalog.reduce((total, entry) => total + entry.claim_ids.length, 0),
    attestation_count: projection.parser_run_attestations.length,
    census_ref_count: projection.census_refs.length,
    does_not_prove: projection.does_not_prove,
  };
}

// Optional: cross-verify the mirrored helpers against the REAL exported helpers
// in a Friday-Handoff-Log sources root (never required; skipped when absent).
export async function crossVerifyMirror(sourcesRoot) {
  const validatorUrl = pathToFileURL(path.join(sourcesRoot, "tools/endbar-evidence-hardening/evidence-hardening-validator.mjs")).href;
  const real = await import(validatorUrl);
  const probes = [
    { a: 1, b: "x", c: [3, 2, 1], d: { z: true, a: null } },
    { claims: [{ claim_kind: "framework_presence", payload: { framework: "vitest", present: true, test_count: 19 } }] },
  ];
  for (const probe of probes) {
    if (real.stableJson(probe) !== stableJson(probe)) throw new Red("MIRROR_STABLEJSON_DIVERGENCE");
    if (real.semanticDigest(probe) !== semanticDigest(probe)) throw new Red("MIRROR_SEMANTICDIGEST_DIVERGENCE");
  }
  return { result: "OK", mirror_matches_real_helpers: true };
}

function parseArgs(argv) {
  const args = { out: null, verify: null, now: null, sourcesRoot: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") args.out = argv[(i += 1)];
    else if (argv[i] === "--verify") args.verify = argv[(i += 1)];
    else if (argv[i] === "--now") args.now = argv[(i += 1)];
    else if (argv[i] === "--sources-root") args.sourcesRoot = argv[(i += 1)];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (args.verify) {
      const summary = verifyRawObservationProjection(path.resolve(args.verify));
      console.log(JSON.stringify(summary));
      process.exit(0);
    }
    if (!args.out) {
      console.error(JSON.stringify({ result: "RED", code: "MISSING_OUT", usage: "--out <dir> [--now <iso>] [--sources-root <dir>] | --verify <dir>" }));
      process.exit(3);
    }
    const outRoot = path.resolve(args.out);
    const { projection, projectionPath } = buildRawObservationProjection({ outRoot, now: args.now });
    const verifySummary = verifyRawObservationProjection(outRoot);
    let mirror = null;
    if (args.sourcesRoot) mirror = await crossVerifyMirror(path.resolve(args.sourcesRoot));
    console.log(
      JSON.stringify({
        result: "OK",
        contract_revision: projection.contract_revision,
        evidence_mode: projection.evidence_mode,
        source_kind: projection.source_kind,
        final_authority: projection.final_authority,
        observation_kinds: projection.observation_kinds,
        raw_count: projection.raw_evidence_catalog.length,
        attestation_count: projection.parser_run_attestations.length,
        projection_path: projectionPath,
        self_verify: verifySummary.result,
        mirror_cross_verify: mirror ? mirror.result : "skipped",
        does_not_prove: projection.does_not_prove,
      }),
    );
    process.exit(0);
  } catch (error) {
    if (error instanceof Red) {
      const isVerify = Boolean(args.verify);
      console.error(JSON.stringify({ result: "RED", code: error.code, detail: error.detail }));
      process.exit(isVerify ? 65 : 3);
    }
    console.error(JSON.stringify({ result: "RED", code: "UNEXPECTED", detail: String(error && error.stack ? error.stack : error) }));
    process.exit(args.verify ? 65 : 3);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
