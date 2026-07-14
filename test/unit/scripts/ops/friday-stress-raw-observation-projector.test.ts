/**
 * TEST-STRESS-TYPED-RAW-001 — raw-observation projector for scratch-doable kinds.
 *
 * Focused, red-first structural test for
 * `scripts/ops/friday-stress-raw-observation-projector.mjs`, which projects the
 * seven scratch-doable R13 stress observation kinds (framework_census,
 * test_execution, specialized_test, coverage, mutation, fuzz,
 * performance_profile) into truth-labeled, content-addressed raw observations
 * produced by TWO genuinely-distinct, independently-spawned parser executables.
 *
 * Self-contained: the projector generates its own deterministic synthetic
 * sources and writes everything under a temp `--out` dir (the real R13 schemas /
 * hardening validator live OUTSIDE this repo, so a committed CI artifact must not
 * depend on them). This test mirrors the exact `stableJson`/`semanticDigest`
 * canonicalization and validates the emitted envelopes/attestations against
 * embedded, byte-faithful copies of the R13 raw-observation and
 * parser-run-attestation schemas.
 *
 * It asserts the projector is:
 *   (a) deterministic (two independent builds are byte-identical);
 *   (b) a real dual-parser contract (two distinct output digests that AGREE, with
 *       raw_id derived from BOTH plus the source digest — a non-circular content
 *       address);
 *   (c) schema-valid (ajv) and fact-bound (facts_sha256 / claim_id / payload all
 *       re-derive; a test-supplied verifyParserRuns callback re-checks each run);
 *   (d) load-bearing / tamper-evident (flipping any binding turns `--verify` RED,
 *       exit 65);
 *   (e) HONEST non-authority (contract_test_fixture / fixture_generator /
 *       final_authority:false; structural independent_review, NOT github OIDC).
 *
 * An OPTIONAL parity block (skipped unless FRIDAY_R13_SOURCES_ROOT points at a
 * Friday-Handoff-Log tree) additionally re-validates the emitted artifacts with
 * the REAL exported parseStrictJsonObservation and the REAL on-disk schemas.
 *
 * It does NOT invoke or modify the R13 fixture validator / negatives harness, and
 * passing it does NOT close TEST-STRESS-TYPED-RAW-001 or any R13 requirement.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import Ajv from "ajv";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const PROJ = path.join(REPO_ROOT, "scripts", "ops", "friday-stress-raw-observation-projector.mjs");
const KINDS = [
  "framework_census",
  "test_execution",
  "specialized_test",
  "coverage",
  "mutation",
  "fuzz",
  "performance_profile",
];

// ── Mirror of the R13 exported semantic canonicalization (validator :78/:88-95). ─
const sha256Bytes = (bytes: Buffer): string => crypto.createHash("sha256").update(bytes).digest("hex");
const compareUtf8 = (a: string, b: string): number => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort(compareUtf8)
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
};
const semanticDigest = (value: unknown): string => sha256Bytes(Buffer.from(stableJson(value), "utf8"));

// ── Embedded, byte-faithful copies of the two R13 schemas (refs inlined). ────────
const COMMON_DEFS = {
  identifier: { type: "string", minLength: 1, pattern: "^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$" },
  sha256: { type: "string", pattern: "^(?!0{64}$)[a-f0-9]{64}$" },
  gitOid: { type: "string", pattern: "^(?!(?:0{40}|0{64})$)(?:[a-f0-9]{40}|[a-f0-9]{64})$" },
  timestamp: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$" },
  safePath: { type: "string", pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[A-Za-z0-9._/-]+$" },
  identity: {
    type: "object",
    additionalProperties: false,
    required: ["candidate_sha", "source_tree_oid", "artifact_set_sha256", "runtime_profile_digest", "currentness_epoch_sha256", "campaign_id"],
    properties: {
      candidate_sha: { $ref: "#/$defs/gitOid" },
      source_tree_oid: { $ref: "#/$defs/gitOid" },
      artifact_set_sha256: { $ref: "#/$defs/sha256" },
      runtime_profile_digest: { $ref: "#/$defs/sha256" },
      currentness_epoch_sha256: { $ref: "#/$defs/sha256" },
      campaign_id: { $ref: "#/$defs/identifier" },
    },
  },
} as const;

const RAW_OBSERVATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "observation_kind", "raw_id", "captured_at", "producer_id", "identity", "facts", "facts_sha256"],
  properties: {
    schema_version: { const: 1 },
    observation_kind: {
      enum: [
        "framework_census", "test_execution", "specialized_test", "coverage", "mutation", "fuzz", "performance_profile",
        "performance_metric", "a11y_scenario", "a11y_alternative", "a11y_modality", "device_identity", "physical_scenario",
        "soak", "human_baseline", "human_followup",
      ],
    },
    raw_id: { type: "string", pattern: "^raw:[a-f0-9]{64}$" },
    captured_at: { $ref: "#/$defs/timestamp" },
    producer_id: { $ref: "#/$defs/identifier" },
    identity: { $ref: "#/$defs/identity" },
    facts: {
      type: "object",
      additionalProperties: false,
      required: ["claims"],
      properties: {
        claims: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["claim_id", "claim_kind", "payload_canonical_json_base64", "payload_bytes", "payload_sha256"],
            properties: {
              claim_id: { type: "string", pattern: "^claim:[a-f0-9]{64}$" },
              claim_kind: { $ref: "#/$defs/identifier" },
              payload_canonical_json_base64: { type: "string", minLength: 4, pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$" },
              payload_bytes: { type: "integer", minimum: 1, maximum: 100000000 },
              payload_sha256: { $ref: "#/$defs/sha256" },
            },
          },
        },
      },
    },
    facts_sha256: { $ref: "#/$defs/sha256" },
  },
  $defs: COMMON_DEFS,
};

const ATTESTATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version", "contract_revision", "manifest_kind", "run_id", "parser_id", "parser_role", "candidate_sha",
    "source_tree_oid", "artifact_set_sha256", "runtime_profile_digest", "currentness_epoch_sha256", "campaign_id",
    "source_path", "source_bytes", "source_sha256", "output_path", "output_bytes", "output_sha256",
    "parser_executable_path", "parser_executable_bytes", "parser_executable_sha256", "build_provenance_sha256",
    "runtime_identity_sha256", "source_parser_contract_sha256", "sandbox_profile_sha256", "environment_allowlist_sha256",
    "network_allowed", "production_code_imported", "started_at", "completed_at", "exit_code", "deterministic_output",
    "payload_sha256", "result",
  ],
  properties: {
    schema_version: { const: 1 },
    contract_revision: { const: "ENDBAR-20260709-R1" },
    manifest_kind: { const: "evidence_parser_run_attestation" },
    run_id: { $ref: "#/$defs/identifier" },
    parser_id: { $ref: "#/$defs/identifier" },
    parser_role: { enum: ["primary_parser", "independent_oracle"] },
    candidate_sha: { $ref: "#/$defs/gitOid" },
    source_tree_oid: { $ref: "#/$defs/gitOid" },
    artifact_set_sha256: { $ref: "#/$defs/sha256" },
    runtime_profile_digest: { $ref: "#/$defs/sha256" },
    currentness_epoch_sha256: { $ref: "#/$defs/sha256" },
    campaign_id: { $ref: "#/$defs/identifier" },
    source_path: { $ref: "#/$defs/safePath" },
    source_bytes: { type: "integer", minimum: 1, maximum: 5000000000 },
    source_sha256: { $ref: "#/$defs/sha256" },
    output_path: { $ref: "#/$defs/safePath" },
    output_bytes: { type: "integer", minimum: 1, maximum: 100000000 },
    output_sha256: { $ref: "#/$defs/sha256" },
    parser_executable_path: { $ref: "#/$defs/safePath" },
    parser_executable_bytes: { type: "integer", minimum: 1, maximum: 1000000 },
    parser_executable_sha256: { $ref: "#/$defs/sha256" },
    build_provenance_sha256: { $ref: "#/$defs/sha256" },
    runtime_identity_sha256: { $ref: "#/$defs/sha256" },
    source_parser_contract_sha256: { $ref: "#/$defs/sha256" },
    sandbox_profile_sha256: { $ref: "#/$defs/sha256" },
    environment_allowlist_sha256: { $ref: "#/$defs/sha256" },
    network_allowed: { const: false },
    production_code_imported: { const: false },
    started_at: { $ref: "#/$defs/timestamp" },
    completed_at: { $ref: "#/$defs/timestamp" },
    exit_code: { const: 0 },
    deterministic_output: { const: true },
    payload_sha256: { $ref: "#/$defs/sha256" },
    result: { const: "PASS" },
  },
  $defs: COMMON_DEFS,
};

const ajv = new Ajv({ strict: false, allErrors: true });
const validateRawObservation = ajv.compile(RAW_OBSERVATION_SCHEMA);
const validateAttestation = ajv.compile(ATTESTATION_SCHEMA);

// ── Fixture / spawn plumbing ─────────────────────────────────────────────────
interface CensusRef { path: string; sha256: string; bytes: number; kind: string }
interface CatalogEntry {
  observation_kind: string; raw_id: string; source_path: string; source_sha256: string;
  path: string; sha256: string; independent_path: string; independent_sha256: string;
  parser_id: string; independent_parser_id: string; parsed_facts_sha256: string;
  claim_ids: string[]; claim_set_sha256: string; observation_path: string; observation_sha256: string;
}
interface Projection {
  contract_revision: string; evidence_mode: string; source_kind: string; final_authority: boolean;
  implementation_status: string; does_not_prove: string; observation_kinds: string[];
  parser_registry: Array<Record<string, unknown>>; raw_evidence_catalog: CatalogEntry[];
  parser_run_attestations: Array<Record<string, unknown>>; census_refs: CensusRef[];
  review_attestation_ref: CensusRef; scratch_tuple_sha256: string;
}

const createdRoots: string[] = [];
afterAll(() => {
  for (const root of createdRoots) fs.rmSync(root, { recursive: true, force: true });
});

interface RunResult { status: number | null; stdout: string; stderr: string }
function run(args: string[]): RunResult {
  const r = spawnSync(process.execPath, [PROJ, ...args], { encoding: "utf8", timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
function build(): { outDir: string; projection: Projection; stdout: unknown } {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-proj-"));
  createdRoots.push(outDir);
  const r = run(["--out", outDir]);
  expect(r.status, r.stderr).toBe(0);
  const projection = JSON.parse(fs.readFileSync(path.join(outDir, "FRIDAY_STRESS_RAW_OBSERVATION_PROJECTION.json"), "utf8")) as Projection;
  return { outDir, projection, stdout: JSON.parse(r.stdout) };
}
const readIn = (outDir: string, rel: string): Buffer => fs.readFileSync(path.join(outDir, rel));

let shared: { outDir: string; projection: Projection };
beforeAll(() => {
  shared = build();
}, 60_000);

describe("friday-stress-raw-observation-projector (TEST-STRESS-TYPED-RAW-001)", () => {
  it("projects exactly the seven scratch-doable kinds with 14 parser-run attestations", () => {
    const { projection } = shared;
    expect(projection.observation_kinds).toEqual(KINDS);
    expect(projection.raw_evidence_catalog.map((e) => e.observation_kind)).toEqual(KINDS);
    expect(projection.parser_run_attestations).toHaveLength(KINDS.length * 2);
    expect(projection.census_refs).toHaveLength(KINDS.length);
  });

  it("is deterministic: two independent builds are byte-identical", () => {
    const a = build();
    const b = build();
    const canon = (p: Projection): string => JSON.stringify(p);
    expect(canon(a.projection)).toBe(canon(b.projection));
    // and the raw content addresses match across the two trees
    for (let i = 0; i < KINDS.length; i += 1) {
      expect(a.projection.raw_evidence_catalog[i].raw_id).toBe(b.projection.raw_evidence_catalog[i].raw_id);
    }
  }, 60_000);

  it("is a genuine dual-parser contract: two DISTINCT output digests that AGREE, with raw_id derived from BOTH plus the source digest", () => {
    const { outDir, projection } = shared;
    // A test-supplied verifyParserRuns callback (the root-provided contract of validator :375).
    const verifyParserRuns = (input: {
      catalog: CatalogEntry; sourceBytes: Buffer; primaryBytes: Buffer; independentBytes: Buffer;
    }): boolean => {
      const { catalog, sourceBytes, primaryBytes, independentBytes } = input;
      if (sha256Bytes(sourceBytes) !== catalog.source_sha256) return false;
      if (sha256Bytes(primaryBytes) !== catalog.sha256) return false;
      if (sha256Bytes(independentBytes) !== catalog.independent_sha256) return false;
      if (catalog.sha256 === catalog.independent_sha256) return false; // distinct outputs
      if (stableJson(JSON.parse(primaryBytes.toString())) !== stableJson(JSON.parse(independentBytes.toString()))) return false; // agree
      const expected = `raw:${semanticDigest({
        observation_kind: catalog.observation_kind,
        source_sha256: catalog.source_sha256,
        primary_parser_id: catalog.parser_id,
        primary_output_sha256: catalog.sha256,
        independent_parser_id: catalog.independent_parser_id,
        independent_output_sha256: catalog.independent_sha256,
      })}`;
      return expected === catalog.raw_id;
    };

    const [primaryReg, independentReg] = projection.parser_registry;
    expect(primaryReg.parser_role).toBe("primary_parser");
    expect(independentReg.parser_role).toBe("independent_oracle");
    for (const field of ["executable_sha256", "build_provenance_sha256", "runtime_identity_sha256", "source_parser_contract_sha256"]) {
      expect(primaryReg[field], `parsers must differ in ${field}`).not.toBe(independentReg[field]);
    }

    for (const catalog of projection.raw_evidence_catalog) {
      const sourceBytes = readIn(outDir, catalog.source_path);
      const primaryBytes = readIn(outDir, catalog.path);
      const independentBytes = readIn(outDir, catalog.independent_path);
      expect(catalog.sha256).not.toBe(catalog.independent_sha256);
      expect(verifyParserRuns({ catalog, sourceBytes, primaryBytes, independentBytes }), catalog.observation_kind).toBe(true);
    }
  });

  it("emits schema-valid envelopes and 35-field parser-run attestations (ajv), and each parsed output round-trips", () => {
    const { outDir, projection } = shared;
    for (const catalog of projection.raw_evidence_catalog) {
      const envelope = JSON.parse(readIn(outDir, catalog.observation_path).toString());
      expect(validateRawObservation(envelope), JSON.stringify(validateRawObservation.errors)).toBe(true);
      // strict-ish re-parse of each parser output: no BOM, canonical round-trip.
      for (const rel of [catalog.path, catalog.independent_path]) {
        const bytes = readIn(outDir, rel);
        expect(bytes[0]).not.toBe(0xef); // no UTF-8 BOM
        const parsed = JSON.parse(bytes.toString("utf8"));
        // canonicalization is idempotent (the bytes round-trip through stableJson)
        expect(stableJson(JSON.parse(stableJson(parsed)))).toBe(stableJson(parsed));
      }
    }
    for (const att of projection.parser_run_attestations) {
      expect(validateAttestation(att), JSON.stringify(validateAttestation.errors)).toBe(true);
    }
  });

  it("binds facts to content: facts_sha256, claim_id, payload digest and claim-set all re-derive", () => {
    const { outDir, projection } = shared;
    for (const catalog of projection.raw_evidence_catalog) {
      const envelope = JSON.parse(readIn(outDir, catalog.observation_path).toString());
      expect(semanticDigest(envelope.facts)).toBe(envelope.facts_sha256);
      expect(envelope.facts_sha256).toBe(catalog.parsed_facts_sha256);
      const claimIds: string[] = [];
      for (const claim of envelope.facts.claims) {
        const payloadBytes = Buffer.from(claim.payload_canonical_json_base64, "base64");
        expect(payloadBytes.length).toBe(claim.payload_bytes);
        expect(payloadBytes.toString("base64")).toBe(claim.payload_canonical_json_base64);
        expect(sha256Bytes(payloadBytes)).toBe(claim.payload_sha256);
        // payload bytes are canonical stable JSON of the parsed payload
        expect(Buffer.from(stableJson(JSON.parse(payloadBytes.toString())), "utf8").equals(payloadBytes)).toBe(true);
        expect(claim.claim_id).toBe(
          `claim:${semanticDigest({ observation_kind: envelope.observation_kind, claim_kind: claim.claim_kind, payload_sha256: claim.payload_sha256 })}`,
        );
        claimIds.push(claim.claim_id);
      }
      expect([...claimIds].sort(compareUtf8)).toEqual([...catalog.claim_ids].sort(compareUtf8));
      expect(catalog.claim_set_sha256).toBe(semanticDigest([...claimIds].sort(compareUtf8)));
    }
  });

  it("is honest non-authority: fixture-labeled, structural independent_review (NOT github OIDC)", () => {
    const { outDir, projection } = shared;
    expect(projection.evidence_mode).toBe("contract_test_fixture");
    expect(projection.source_kind).toBe("fixture_generator");
    expect(projection.final_authority).toBe(false);
    expect(projection.implementation_status).toBe("structural_scratch_non_authority");
    expect(projection.does_not_prove).toMatch(/NOT final authority/i);
    const ref = projection.review_attestation_ref;
    expect(ref.kind).toBe("independent_review");
    const review = JSON.parse(readIn(outDir, ref.path).toString());
    expect(review.kind).toBe("independent_review");
    expect(review.kind).not.toBe("github_actions_oidc");
    expect(review.verdict).toBe("PASS");
    expect(review.implementation_status).toBe("structural_scratch_non_authority");
    expect(review.reviewer_id).not.toBe(review.producer_id);
    expect(review.final_release_candidate_tuple_sha256).toBe(projection.scratch_tuple_sha256);
  });

  it("clean projection self-verifies (exit 0); missing --out is RED exit 3", () => {
    expect(run(["--verify", shared.outDir]).status).toBe(0);
    const r = run([]);
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stderr).code).toBe("MISSING_OUT");
  });

  it("is tamper-evident: any flipped binding turns --verify RED (exit 65)", () => {
    // Each case is a fresh build tampered in exactly one place.
    const cases: Array<{ name: string; tamper: (outDir: string) => void; code: string }> = [
      {
        name: "flip a byte in a parsed facts file",
        tamper: (o) => {
          const p = path.join(o, "parsed", "coverage.primary.facts.json");
          fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("friday-core", "friday-c0re"));
        },
        code: "PRIMARY_OUTPUT_DRIFT",
      },
      {
        name: "flip a char inside an envelope base64 payload",
        tamper: (o) => {
          const p = path.join(o, "raw", "coverage.observation.json");
          const e = JSON.parse(fs.readFileSync(p, "utf8"));
          const b = e.facts.claims[0].payload_canonical_json_base64 as string;
          e.facts.claims[0].payload_canonical_json_base64 = (b[10] === "A" ? "B" : "A") + b.slice(1);
          fs.writeFileSync(p, `${JSON.stringify(e, null, 2)}\n`);
        },
        code: "OBSERVATION_CONTENT_DRIFT",
      },
      {
        name: "drop a claim from an envelope",
        tamper: (o) => {
          const p = path.join(o, "raw", "framework_census.observation.json");
          const e = JSON.parse(fs.readFileSync(p, "utf8"));
          e.facts.claims.pop();
          fs.writeFileSync(p, `${JSON.stringify(e, null, 2)}\n`);
        },
        code: "OBSERVATION_CONTENT_DRIFT",
      },
      {
        name: "swap the independent parser output with the primary (breaks distinctness/agreement)",
        tamper: (o) => {
          fs.copyFileSync(path.join(o, "parsed", "mutation.primary.facts.json"), path.join(o, "parsed", "mutation.independent.facts.json"));
        },
        code: "INDEPENDENT_OUTPUT_DRIFT",
      },
      {
        name: "mutate a census ref digest in the projection manifest",
        tamper: (o) => {
          const p = path.join(o, "FRIDAY_STRESS_RAW_OBSERVATION_PROJECTION.json");
          const j = JSON.parse(fs.readFileSync(p, "utf8")) as Projection;
          const s = j.census_refs[0].sha256;
          j.census_refs[0].sha256 = (s[0] === "0" ? "1" : "0") + s.slice(1);
          fs.writeFileSync(p, `${JSON.stringify(j, null, 2)}\n`);
        },
        code: "CENSUS_REF_DRIFT",
      },
    ];
    for (const c of cases) {
      const { outDir } = build();
      expect(run(["--verify", outDir]).status, `${c.name}: clean pre-check`).toBe(0);
      c.tamper(outDir);
      const r = run(["--verify", outDir]);
      expect(r.status, `${c.name}: expected RED 65`).toBe(65);
      expect(JSON.parse(r.stderr).code, c.name).toBe(c.code);
    }
  }, 120_000);
});

// ── OPTIONAL parity: validate against the REAL R13 parser + on-disk schemas. ────
const SOURCES_ROOT = process.env.FRIDAY_R13_SOURCES_ROOT ?? "";
const hasSources = SOURCES_ROOT !== "" && fs.existsSync(path.join(SOURCES_ROOT, "tools/endbar-evidence-hardening/strict-json-observation-parser.mjs"));
describe.skipIf(!hasSources)("parity with the REAL R13 evidence-hardening tooling", () => {
  it("real parseStrictJsonObservation + real semanticDigest + real schemas accept the emitted projection", async () => {
    const parserMod = await import(pathToFileURL(path.join(SOURCES_ROOT, "tools/endbar-evidence-hardening/strict-json-observation-parser.mjs")).href);
    const validatorMod = await import(pathToFileURL(path.join(SOURCES_ROOT, "tools/endbar-evidence-hardening/evidence-hardening-validator.mjs")).href);
    const parseStrict = parserMod.parseStrictJsonObservation as (b: Uint8Array) => unknown;
    const realStable = validatorMod.stableJson as (v: unknown) => string;
    const realSemantic = validatorMod.semanticDigest as (v: unknown) => string;
    // The real R13 schemas declare draft 2020-12, so use ajv's 2020 build here.
    const Ajv2020 = (await import("ajv/dist/2020.js")).default as unknown as typeof Ajv;
    const realAjv = new Ajv2020({ strict: false, allErrors: true });
    for (const s of ["endbar-common.schema.json", "endbar-evidence-common.schema.json"]) {
      realAjv.addSchema(JSON.parse(fs.readFileSync(path.join(SOURCES_ROOT, "schemas", s), "utf8")));
    }
    const realRaw = realAjv.compile(JSON.parse(fs.readFileSync(path.join(SOURCES_ROOT, "schemas/endbar-raw-observation.schema.json"), "utf8")));
    const realAtt = realAjv.compile(JSON.parse(fs.readFileSync(path.join(SOURCES_ROOT, "schemas/endbar-evidence-parser-run-attestation.schema.json"), "utf8")));

    const { outDir, projection } = build();
    for (const catalog of projection.raw_evidence_catalog) {
      const primary = parseStrict(new Uint8Array(readIn(outDir, catalog.path)));
      const independent = parseStrict(new Uint8Array(readIn(outDir, catalog.independent_path)));
      expect(realStable(independent)).toBe(realStable(primary));
      expect(
        `raw:${realSemantic({
          observation_kind: catalog.observation_kind, source_sha256: catalog.source_sha256,
          primary_parser_id: catalog.parser_id, primary_output_sha256: catalog.sha256,
          independent_parser_id: catalog.independent_parser_id, independent_output_sha256: catalog.independent_sha256,
        })}`,
      ).toBe(catalog.raw_id);
      const envelope = JSON.parse(readIn(outDir, catalog.observation_path).toString());
      expect(realRaw(envelope), JSON.stringify(realRaw.errors)).toBe(true);
      expect(realSemantic(envelope.facts)).toBe(envelope.facts_sha256);
      for (const claim of envelope.facts.claims) {
        const pb = Buffer.from(claim.payload_canonical_json_base64, "base64");
        const payload = parseStrict(new Uint8Array(pb));
        expect(Buffer.from(realStable(payload), "utf8").equals(pb)).toBe(true);
        expect(claim.claim_id).toBe(`claim:${realSemantic({ observation_kind: envelope.observation_kind, claim_kind: claim.claim_kind, payload_sha256: claim.payload_sha256 })}`);
      }
    }
    for (const att of projection.parser_run_attestations) {
      expect(realAtt(att), JSON.stringify(realAtt.errors)).toBe(true);
    }
  }, 60_000);
});
