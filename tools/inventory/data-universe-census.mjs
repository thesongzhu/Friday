#!/usr/bin/env node
/**
 * INV-DATA-001 (P0) — deterministic data-universe reconcile gate (thin CLI).
 *
 * Sibling of tools/inventory/reconcile.mjs (INV-ARTIFACT-001): the same pure
 * keyed set-difference discipline, applied to the DATA universe. It reconciles
 * Friday's discoverable data surface against a DECLARED policy registry, turning
 * the verdict RED when a data element is unregistered, a registered element has
 * vanished from source (ghost), a required policy dimension is unclassified, a
 * declared policy has DRIFTED from source, a key is duplicated, or an element's
 * SEMANTIC IDENTITY (kind/source ↔ key-prefix ↔ shape) is inconsistent.
 *
 * ── WHERE THE CENSUS COMES FROM (authoritative, not regex) ──────────────────
 * The SQLite half of the census is AUTHORITATIVE: tools/inventory/data-universe-
 * oracle.ts EXECUTES the exact committed migration chain against a fresh
 * in-memory better-sqlite3 DB and INTROSPECTS the result, so it captures dynamic
 * migrations (V069's imperative `apply` metadata columns) and FTS shadow tables
 * that a static regex is structurally blind to. Because that oracle must import
 * the repo's `.ts` migration sources (unavailable to plain node), it runs under
 * vitest and REGENERATES a committed snapshot (data-universe-census.snapshot.json)
 * that this CLI reads. The snapshot carries a `sourceFingerprint`; this CLI
 * RECOMPUTES it from disk and FAILS CLOSED if it drifts — so a migration / schema
 * / retention / oracle change that is not followed by a snapshot regeneration
 * turns the gate RED instead of serving a stale (possibly false-clean) census.
 * The authoritative liveness is proven every CI run by the contract test, which
 * re-executes the migrations and asserts the snapshot equals the live schema.
 *
 * ── HONEST SCOPING (release-gated boundary) ────────────────────────────────
 * This ships ONLY the census + the deterministic reconciler + red-first
 * behavioral controls. INV-DATA-001's AUTHORITATIVE acceptance (every DB / table
 * / column / file / keychain / cache / index / attachment / queue / backup / log
 * / audit / telemetry / payload FIELD has {owner, encryption, retention,
 * export/delete/backup}) additionally requires a LIVE RUNTIME CRAWL, an UNPACKED
 * SIGNED-ARTIFACT scan, a PROD-PATH readback, and an OPERATOR SEAL — LIVE / SIGNED
 * / OPERATOR-GATED and explicitly NOT in scope. A GREEN verdict here means "the
 * declared registry reconciles with the data surface DISCOVERABLE FROM SOURCE";
 * it authorizes NOTHING about the real runtime universe and does NOT close
 * INV-DATA-001. Per-column/per-payload-FIELD policy and the export/delete/backup
 * dimensions remain in the gated closure. The Rust surface is a STATIC schema.rs
 * parse (documented gap: programmatic Rust DDL would be invisible here).
 *
 * ── FAIL-CLOSED ────────────────────────────────────────────────────────────
 * Malformed / semantically-inconsistent registry or census input, or a stale
 * snapshot, is rejected with a typed DataCensusValidationError and exits 3
 * UNCONDITIONALLY. A clean "blocked" reconcile exits 2 unless --allow-blocked.
 *
 * Usage:
 *   node tools/inventory/data-universe-census.mjs [census] [--out=/abs/census.json]
 *   node tools/inventory/data-universe-census.mjs emit-registry [--out=/abs/registry.json]
 *   node tools/inventory/data-universe-census.mjs reconcile \
 *     --registry=/abs/data-universe-registry.json \
 *     [--census=/abs/census.json]   # omit to use the authoritative snapshot \
 *     [--out=/abs/reconcile-report.json] [--allow-blocked]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { computeSourceFingerprint } from "./data-universe-source-fingerprint.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = join(HERE, "data-universe-census.snapshot.json");

// ── Policy-dimension model ─────────────────────────────────────────────────
const REQUIRED_STATIC_DIMS = ["owner", "encryption", "retention"];
const GATED_DIMS = ["export", "delete", "backup"];
const ALL_DIMS = [...REQUIRED_STATIC_DIMS, ...GATED_DIMS];

const KINDS = new Set(["table", "retention-category"]);
const SOURCES = new Set(["sqlite", "rust", "retention"]);

// key-prefix ↔ (source, kind) consistency: the semantic identity contract.
const KEY_PREFIX = {
  sqlite: { source: "sqlite", kind: "table" },
  rust: { source: "rust", kind: "table" },
  retention: { source: "retention", kind: "retention-category" },
};

const OWNER_VALUES = new Set(["hub-sqlite", "hub-rust", "shared-rust", "friday-retention", "unknown"]);
const ENCRYPTION_VALUES = new Set([
  "plaintext",
  "hashed",
  "column-encrypted",
  "not-applicable",
  "unknown",
]);
const RETENTION_VALUES = new Set([
  "permanent-default",
  "content-opt-in",
  "security-lifecycle-ttl",
  "unknown",
]);
const GATED_VALUES = new Set(["gated", "not-applicable", "unknown"]);

const VALUE_SETS = {
  owner: OWNER_VALUES,
  encryption: ENCRYPTION_VALUES,
  retention: RETENTION_VALUES,
  export: GATED_VALUES,
  delete: GATED_VALUES,
  backup: GATED_VALUES,
};

export class DataCensusValidationError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "DataCensusValidationError";
    this.code = code;
    this.detail = detail;
  }
}

// ── Semantic identity (fail-closed) ─────────────────────────────────────────
// Every element — registry OR census — must have a `kind` and `source` from the
// allowed sets, and its key PREFIX must agree with both. Census elements are
// additionally shape-checked (table/columns/columnCount + key↔table). A malformed
// semantic identity can NEVER read as passed (a `sqlite:` key masquerading as a
// retention category, a column-count that lies, etc. exits 3).
function validateSemanticIdentity(el, role, index) {
  const at = `${role}[${index}]`;
  if (typeof el.kind !== "string" || !KINDS.has(el.kind)) {
    throw new DataCensusValidationError("invalid_kind", `${at}:${String(el.kind)}`);
  }
  if (typeof el.source !== "string" || !SOURCES.has(el.source)) {
    throw new DataCensusValidationError("invalid_source", `${at}:${String(el.source)}`);
  }
  const colon = el.key.indexOf(":");
  const prefix = colon > 0 ? el.key.slice(0, colon) : "";
  const expected = Object.prototype.hasOwnProperty.call(KEY_PREFIX, prefix)
    ? KEY_PREFIX[prefix]
    : undefined;
  if (!expected) {
    throw new DataCensusValidationError("invalid_key_prefix", `${at}:${el.key}`);
  }
  if (el.source !== expected.source) {
    throw new DataCensusValidationError(
      "semantic_source_mismatch",
      `${at}:${el.key} prefix '${prefix}:' ⇒ source=${expected.source}, got source=${el.source}`,
    );
  }
  if (el.kind !== expected.kind) {
    throw new DataCensusValidationError(
      "semantic_kind_mismatch",
      `${at}:${el.key} prefix '${prefix}:' ⇒ kind=${expected.kind}, got kind=${el.kind}`,
    );
  }
  if (role !== "census") return; // registry carries no table/column shape
  if (typeof el.table !== "string" || el.table.trim().length === 0) {
    throw new DataCensusValidationError("invalid_table", `${at}:${el.key}`);
  }
  if (!Array.isArray(el.columns) || el.columns.some((c) => typeof c !== "string")) {
    throw new DataCensusValidationError("invalid_columns", `${at}:${el.key}`);
  }
  if (typeof el.columnCount !== "number" || el.columnCount !== el.columns.length) {
    throw new DataCensusValidationError(
      "column_count_mismatch",
      `${at}:${el.key} columnCount=${String(el.columnCount)}, columns.length=${el.columns.length}`,
    );
  }
  if (el.kind === "table" && el.key !== `${el.source}:${el.table}`) {
    throw new DataCensusValidationError(
      "key_table_mismatch",
      `${at}: key=${el.key} != ${el.source}:${el.table}`,
    );
  }
  if (el.kind === "retention-category" && el.columns.length !== 0) {
    throw new DataCensusValidationError(
      "retention_columns_nonempty",
      `${at}:${el.key} carries ${el.columns.length} columns`,
    );
  }
}

// ── Reconcile (pure keyed set-difference) ──────────────────────────────────

/** Validate + index a census universe into Map<key, element>. Fail-closed. */
export function indexCensus(elements) {
  const map = new Map();
  const duplicates = [];
  elements.forEach((el, index) => {
    if (!el || typeof el !== "object" || Array.isArray(el)) {
      throw new DataCensusValidationError("element_not_object", `census[${index}]`);
    }
    if (typeof el.key !== "string" || el.key.trim().length === 0) {
      throw new DataCensusValidationError("invalid_key", `census[${index}]`);
    }
    validateSemanticIdentity(el, "census", index);
    if (!el.derived || typeof el.derived !== "object") {
      throw new DataCensusValidationError("missing_derived", `census[${index}]`);
    }
    for (const dim of REQUIRED_STATIC_DIMS) {
      const v = el.derived[dim];
      if (typeof v !== "string" || !VALUE_SETS[dim].has(v)) {
        throw new DataCensusValidationError("invalid_derived_value", `census[${index}].${dim}:${String(v)}`);
      }
    }
    const key = el.key.trim();
    if (map.has(key)) {
      duplicates.push(key);
      return;
    }
    map.set(key, el);
  });
  return { map, duplicates };
}

/** Validate + index a registry universe into Map<key, element>. Fail-closed. */
export function indexRegistry(elements) {
  const map = new Map();
  const duplicates = [];
  elements.forEach((el, index) => {
    if (!el || typeof el !== "object" || Array.isArray(el)) {
      throw new DataCensusValidationError("element_not_object", `registry[${index}]`);
    }
    if (typeof el.key !== "string" || el.key.trim().length === 0) {
      throw new DataCensusValidationError("invalid_key", `registry[${index}]`);
    }
    validateSemanticIdentity(el, "registry", index);
    for (const dim of ALL_DIMS) {
      const v = el[dim];
      if (v === undefined) continue; // absence is surfaced as policy_incomplete, not fail-closed
      if (typeof v !== "string" || !VALUE_SETS[dim].has(v)) {
        throw new DataCensusValidationError("invalid_policy_value", `registry[${index}].${dim}:${String(v)}`);
      }
    }
    const key = el.key.trim();
    if (map.has(key)) {
      duplicates.push(key);
      return;
    }
    map.set(key, el);
  });
  return { map, duplicates };
}

/**
 * Pure reconciler. Deterministic: iterates canonical sort() order on key and
 * sorts the final blocker list. No clock/random anywhere in this path.
 */
export function reconcile(registryElements, censusElements) {
  const registry = indexRegistry(registryElements);
  const census = indexCensus(censusElements);
  const blockers = [];
  const push = (code, detail) => blockers.push({ code, detail });

  for (const key of [...registry.duplicates].sort()) push("duplicate_key", `registry:${key}`);
  for (const key of [...census.duplicates].sort()) push("duplicate_key", `census:${key}`);

  // unregistered — CENSUS − REGISTRY (discovered but never classified)
  for (const key of [...census.map.keys()].sort()) {
    if (!registry.map.has(key)) push("unregistered", key);
  }

  // ghost — REGISTRY − CENSUS (declared but no longer in source)
  for (const key of [...registry.map.keys()].sort()) {
    if (!census.map.has(key)) push("ghost", key);
  }

  // policy_incomplete — a registered element with a missing / "unknown" dim.
  for (const key of [...registry.map.keys()].sort()) {
    const el = registry.map.get(key);
    for (const dim of ALL_DIMS) {
      const v = el[dim];
      if (v === undefined || v === "unknown") push("policy_incomplete", `${key}.${dim}`);
    }
  }

  // policy_drift — for a key present in BOTH universes, a DECLARED static dim
  // that no longer matches what source now DERIVES (the analog of sha_mismatch).
  for (const key of [...registry.map.keys()].sort()) {
    const censusEl = census.map.get(key);
    if (!censusEl) continue;
    const registryEl = registry.map.get(key);
    for (const dim of REQUIRED_STATIC_DIMS) {
      const declared = registryEl[dim];
      const derived = censusEl.derived[dim];
      if (declared !== undefined && declared !== "unknown" && declared !== derived) {
        push("policy_drift", `${key}.${dim}:declared=${declared},source=${derived}`);
      }
    }
  }

  const count = (code) => blockers.filter((b) => b.code === code).length;
  const summary = {
    registryElementCount: registry.map.size,
    censusElementCount: census.map.size,
    unregisteredCount: count("unregistered"),
    ghostCount: count("ghost"),
    policyIncompleteCount: count("policy_incomplete"),
    policyDriftCount: count("policy_drift"),
    duplicateKeyCount: count("duplicate_key"),
  };

  blockers.sort((a, b) =>
    a.code === b.code ? a.detail.localeCompare(b.detail) : a.code.localeCompare(b.code),
  );

  return { status: blockers.length === 0 ? "passed" : "blocked", blockers, summary };
}

// ── Authoritative snapshot loading (fingerprint-guarded, fail-closed) ───────

/**
 * Load the committed authoritative census snapshot and PROVE it is not stale:
 * recompute the source fingerprint from disk and fail closed if it differs. This
 * is what makes the plain-node CLI honest without a TypeScript runtime — a source
 * change without a snapshot regeneration REDs the gate rather than serving a
 * stale census.
 */
export function loadSnapshotCensus(snapshotPath = SNAPSHOT_PATH) {
  let raw;
  try {
    raw = readFileSync(snapshotPath, "utf8");
  } catch {
    throw new DataCensusValidationError("snapshot_unreadable", snapshotPath);
  }
  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch (error) {
    throw new DataCensusValidationError("invalid_snapshot_json", error.message);
  }
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.elements)) {
    throw new DataCensusValidationError("invalid_snapshot", snapshotPath);
  }
  if (typeof snapshot.sourceFingerprint !== "string") {
    throw new DataCensusValidationError("snapshot_missing_fingerprint", snapshotPath);
  }
  const onDisk = computeSourceFingerprint();
  if (snapshot.sourceFingerprint !== onDisk) {
    throw new DataCensusValidationError(
      "snapshot_stale",
      `recorded=${snapshot.sourceFingerprint} disk=${onDisk} — regenerate the census snapshot ` +
        `(INV_DATA_SNAPSHOT_REGEN=1 npx vitest run test/contracts/inventory/friday-data-universe-reconcile.contract.test.ts)`,
    );
  }
  return snapshot.elements;
}

/** Derive a DECLARED registry seed from a census (source-derived dims copied;
 *  export/delete/backup honestly "gated"/"not-applicable"). */
export function deriveRegistrySeed(census) {
  return census.map((el) => {
    const gatedValue = el.kind === "retention-category" ? "not-applicable" : "gated";
    return {
      key: el.key,
      kind: el.kind,
      source: el.source,
      owner: el.derived.owner,
      encryption: el.derived.encryption,
      retention: el.derived.retention,
      export: gatedValue,
      delete: gatedValue,
      backup: gatedValue,
    };
  });
}

function censusCoverage(census) {
  const bySource = {};
  for (const el of census) bySource[el.source] = (bySource[el.source] ?? 0) + 1;
  return {
    totalElements: census.length,
    bySource,
    tableElements: census.filter((e) => e.kind === "table").length,
    retentionCategoryElements: census.filter((e) => e.kind === "retention-category").length,
    totalColumnsEnumerated: census.reduce((n, e) => n + e.columnCount, 0),
  };
}

// ── CLI plumbing ───────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);

function argValue(name) {
  const prefix = `--${name}=`;
  for (let i = 0; i < rawArgs.length; i += 1) {
    const v = rawArgs[i];
    if (v.startsWith(prefix)) return v.slice(prefix.length);
    if (v === `--${name}` && rawArgs[i + 1]) return rawArgs[i + 1];
  }
  return "";
}

function readJsonArray(role, path, field) {
  if (!isAbsolute(path)) throw new DataCensusValidationError("path_not_absolute", `${role}:${path}`);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new DataCensusValidationError("unreadable_file", `${role}:${path}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DataCensusValidationError("invalid_json", `${role}:${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DataCensusValidationError("not_object", role);
  }
  if (!Array.isArray(parsed[field])) {
    throw new DataCensusValidationError("field_not_array", `${role}.${field}`);
  }
  return parsed[field];
}

/** Write JSON to stdout WITHOUT process.exit() so large payloads never truncate. */
function emit(payload, outPath, exitCode) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  if (outPath) {
    const out = isAbsolute(outPath) ? outPath : resolve(outPath);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, body);
  }
  process.stdout.write(body);
  process.exitCode = exitCode;
}

function usage() {
  console.error(`usage:
  node tools/inventory/data-universe-census.mjs [census] [--out=/abs/census.json]
  node tools/inventory/data-universe-census.mjs emit-registry [--out=/abs/registry.json]
  node tools/inventory/data-universe-census.mjs reconcile \\
    --registry=/abs/data-universe-registry.json \\
    [--census=/abs/census.json] [--out=/abs/report.json] [--allow-blocked]

Truth: data-universe reconcile gate over the AUTHORITATIVE census snapshot
(SQLite = real migration execution + introspection; Rust = static schema.rs parse;
retention = canonical governance constants). It does NOT crawl the live runtime,
unpack a signed artifact, read prod paths, or close INV-DATA-001. The gated
remainder is out of scope (see the schema doc).`);
}

function runCensus() {
  const census = loadSnapshotCensus();
  const report = {
    truth: "data_universe_census",
    generated_at_utc: new Date().toISOString(), // metadata only — NEVER in a verdict path
    coverage: censusCoverage(census),
    elements: census,
    caveat:
      "Authoritative census snapshot (fingerprint-guarded). Per-column / per-payload-field policy and the real runtime universe are release/operator-gated and out of scope.",
  };
  emit(report, argValue("out"), 0);
}

function runEmitRegistry() {
  const census = loadSnapshotCensus();
  const registry = {
    truth: "data_universe_registry",
    note: "DECLARED policy registry (seed). owner/encryption/retention are source-derived; export/delete/backup are closure-gated. Hand-owned going forward; drift from source REDs the reconcile.",
    dimensions: { requiredStatic: REQUIRED_STATIC_DIMS, gated: GATED_DIMS },
    elements: deriveRegistrySeed(census),
  };
  emit(registry, argValue("out"), 0);
}

function runReconcile() {
  const registryPath = argValue("registry");
  if (!registryPath) throw new DataCensusValidationError("missing_arg", "registry");
  const registryElements = readJsonArray("registry", registryPath, "elements");

  const censusPath = argValue("census");
  const censusElements = censusPath
    ? readJsonArray("census", censusPath, "elements")
    : loadSnapshotCensus();

  const result = reconcile(registryElements, censusElements);
  const report = {
    truth: "data_universe_reconcile",
    status: result.status,
    generated_at_utc: new Date().toISOString(), // metadata only — NEVER in the pass/fail path
    inputs: { registry: registryPath, census: censusPath || "<authoritative-snapshot>" },
    summary: result.summary,
    blockers: result.blockers,
    caveat:
      "Reconcile over the authoritative census snapshot. GREEN means the declared registry reconciles with the source-discoverable data surface; it does NOT close INV-DATA-001 (live crawl + unpacked signed-artifact scan + prod-path readback + operator seal are out of scope).",
  };
  const allowBlocked = rawArgs.includes("--allow-blocked");
  emit(report, argValue("out"), result.status === "passed" || allowBlocked ? 0 : 2);
}

function main() {
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    usage();
    process.exitCode = 0;
    return;
  }
  const subcommand = rawArgs.find((a) => !a.startsWith("-")) || "census";
  if (subcommand === "census") return runCensus();
  if (subcommand === "emit-registry") return runEmitRegistry();
  if (subcommand === "reconcile") return runReconcile();
  usage();
  process.exitCode = 2;
}

/** Only run the CLI when invoked directly — importing this module (tests) is side-effect free. */
function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === new URL(`file://${entry}`).href || fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  try {
    main();
  } catch (error) {
    if (error instanceof DataCensusValidationError) {
      const report = {
        truth: "data_universe_reconcile",
        status: "error",
        error: { code: error.code, detail: error.detail, message: error.message },
        caveat: "Malformed/stale input rejected fail-closed; a malformed inventory can never read as passed.",
      };
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = 3;
    } else {
      throw error;
    }
  }
}
