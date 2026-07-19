#!/usr/bin/env node
/**
 * INV-DATA-001 (P0) — deterministic STATIC-SOURCE data-universe census +
 * keyed set-difference reconcile gate.
 *
 * Sibling of tools/inventory/reconcile.mjs (INV-ARTIFACT-001): the same pure
 * keyed set-difference discipline, applied to the DATA universe instead of the
 * artifact universe. It enumerates Friday's discoverable data surface FROM
 * SOURCE and reconciles it against a DECLARED policy registry, turning the
 * verdict RED when a data element is unregistered, a registered element has
 * vanished from source (ghost), a required policy dimension is unclassified,
 * or a declared policy has DRIFTED from what source now says.
 *
 * ── HONEST SCOPING (release-gated boundary) ────────────────────────────────
 * This ships ONLY the STATIC-SOURCE census + the deterministic reconciler +
 * a red-first behavioral negative control on fixtures. INV-DATA-001's
 * AUTHORITATIVE acceptance ("every DB / table / column / file / keychain /
 * cache / index / attachment / queue / backup / log / audit / telemetry /
 * payload FIELD has {owner, encryption, retention, export/delete/backup}")
 * requires a LIVE RUNTIME CRAWL of the running Hub, an UNPACKED SIGNED-ARTIFACT
 * scan, a PROD-PATH authoritative readback, and an OPERATOR SEAL. Those are
 * LIVE / SIGNED / OPERATOR-GATED and are explicitly NOT in scope here. A GREEN
 * verdict from this tool means "the declared registry reconciles with the data
 * surface DISCOVERABLE FROM SOURCE"; it authorizes NOTHING about the real
 * runtime universe and does NOT close INV-DATA-001.
 *
 * The static engine can only see what static schema DECLARES. It therefore:
 *   - classifies policy at the TABLE / retention-CATEGORY granularity (the unit
 *     at which Friday's source actually declares governance: retention is per
 *     reaper category, encryption is per column signal, ownership is per store),
 *   - enumerates every column as a per-table manifest (so "tables + columns" is
 *     honored in the census), but does NOT classify per-column or per-payload-
 *     FIELD policy — the policy of fields nested inside JSON blob columns
 *     (payload_json, details_json, context_json, …) is NOT derivable from static
 *     schema and is part of the GATED closure,
 *   - resolves the three statically-determinable dimensions {owner, encryption,
 *     retention} from real source signals, and records the three closure-gated
 *     dimensions {export, delete, backup} as the honest literal value "gated"
 *     (never fabricated) — they are resolved by the live/operator-sealed crawl.
 *
 * ── DETERMINISM ────────────────────────────────────────────────────────────
 * The census and the verdict body are a pure function of the source files on
 * disk (and, for reconcile, the registry file). Files are read in sorted order,
 * elements are keyed and iterated in canonical sort() order, columns are
 * de-duplicated + sorted, and blockers are sorted by (code, detail). NO clock
 * or random is EVER consulted in the pass/fail path — `generated_at_utc` in the
 * emitted report is metadata only and is never read when deciding pass/fail.
 *
 * ── ELEMENT MODEL ──────────────────────────────────────────────────────────
 *   kind ∈ {table, retention-category}
 *   key  = "sqlite:<table>" | "rust:<table>" | "retention:<category>"
 * A census element carries the source-DERIVED static dims; a registry element
 * carries the DECLARED classification for all six dims. See
 * tools/inventory/data-universe-schema.md for the full schema.
 *
 * ── BLOCKER VOCABULARY (contract INV-DATA-001 proof_scope) ──────────────────
 *   unregistered       CENSUS − REGISTRY   (discovered element never classified)
 *   ghost              REGISTRY − CENSUS   (declared element no longer in source)
 *   policy_incomplete  registered element whose required dim is missing/"unknown"
 *   policy_drift       declared static dim ≠ source-derived static dim
 *   duplicate_key      same element key appears twice within one universe
 * GREEN iff all five counts == 0 → status "passed"; else "blocked".
 *
 * ── FAIL-CLOSED ────────────────────────────────────────────────────────────
 * Malformed registry / census input is rejected with a typed
 * DataCensusValidationError and exits 3 UNCONDITIONALLY (a malformed inventory
 * can never read as passed). A clean "blocked" reconcile exits 2 (any RED fails)
 * unless `--allow-blocked` is passed (for report-only runs).
 *
 * Usage:
 *   node tools/inventory/data-universe-census.mjs [census] [--out=/abs/census.json]
 *   node tools/inventory/data-universe-census.mjs emit-registry [--out=/abs/registry.json]
 *   node tools/inventory/data-universe-census.mjs reconcile \
 *     --registry=/abs/data-universe-registry.json \
 *     [--census=/abs/census.json]   # omit to crawl the live source tree \
 *     [--out=/abs/reconcile-report.json] [--allow-blocked]
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SQLITE_MIGRATIONS_DIR = join(REPO_ROOT, "src", "state", "sqlite", "migrations");
const RUST_SCHEMA_FILE = join(
  REPO_ROOT,
  "rust-core",
  "crates",
  "friday-storage",
  "src",
  "schema.rs",
);

// ── Policy-dimension model ─────────────────────────────────────────────────
// Statically-determinable dims are REQUIRED: the registry must classify each
// (a missing value or the literal "unknown" is a RED policy_incomplete). The
// closure-gated dims must be present but carry the honest "gated"/"n-a" value —
// their real policy comes from the out-of-scope live/operator-sealed crawl.
const REQUIRED_STATIC_DIMS = ["owner", "encryption", "retention"];
const GATED_DIMS = ["export", "delete", "backup"];
const ALL_DIMS = [...REQUIRED_STATIC_DIMS, ...GATED_DIMS];

const KINDS = new Set(["table", "retention-category"]);
const SOURCES = new Set(["sqlite", "rust", "retention"]);

// Allowed value sets — a string outside these is MALFORMED (fail-closed exit 3);
// the sentinel "unknown" is structurally valid but REDs a required dim.
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
// export/delete/backup: statically un-derivable → closure-gated. "not-applicable"
// is allowed for policy-governor (retention-category) elements.
const GATED_VALUES = new Set(["gated", "not-applicable", "unknown"]);

const VALUE_SETS = {
  owner: OWNER_VALUES,
  encryption: ENCRYPTION_VALUES,
  retention: RETENTION_VALUES,
  export: GATED_VALUES,
  delete: GATED_VALUES,
  backup: GATED_VALUES,
};

// ── Retention reaper mapping (from src/jobs/retention/*) ────────────────────
// The seven owner-configurable CONTENT categories (default-permanent, opt-in)
// and the three SECURITY-LIFECYCLE terminal TTLs, each mapped to the physical
// table the reaper deletes from. Everything NOT listed here defaults to
// "permanent-default" (DATA-RETENTION-001: local data is default-permanent).
const CONTENT_CATEGORY_TABLE = {
  learningEvents: "learning_events",
  heartbeats: "satellite_heartbeats",
  skillRunTerminal: "skill_run_snapshots",
  auditLogs: "audit_logs",
  agentRuns: "friday_agent_runs",
  llmUsageRecords: "llm_usage_records",
  errorIncidents: "error_incidents",
};
const SECURITY_LIFECYCLE_TABLE = {
  pairingRequestsDays: "satellite_pairing_requests",
  outboxTerminalDays: "outbox_messages",
  bootstrapNoncesConsumedDays: "friday_setup_bootstrap_nonces",
};
const CONTENT_TABLES = new Set(Object.values(CONTENT_CATEGORY_TABLE));
const SECURITY_TABLES = new Set(Object.values(SECURITY_LIFECYCLE_TABLE));

// ── Column signal heuristics (documented in the schema doc) ────────────────
// Purely a NAME-signal classification of at-rest posture visible in static
// schema; the TRUE at-rest posture (whole-DB encryption, keychain sealing) is
// part of the gated closure.
const CIPHER_SIGNAL = /(ciphertext|encrypt|enc_alg|sealed_key)/i;
const HASH_SIGNAL = /hash/i;

class DataCensusValidationError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "DataCensusValidationError";
    this.code = code;
    this.detail = detail;
  }
}

// ── Source parsing ─────────────────────────────────────────────────────────

/** Strip block comments, and `--` / `//` line-comment tails, from source text. */
function stripComments(text) {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, " ");
  return noBlock
    .split("\n")
    .map((line) => line.replace(/--.*$/, "").replace(/\/\/.*$/, ""))
    .join("\n");
}

/**
 * Balance-scan from the index just after an opening "(" to its matching ")",
 * honoring single-quoted string literals (SQLite '' escaping is handled by the
 * plain toggle — an escaped '' simply flips twice and nets to "in string").
 * Returns the inner body (without the outer parens).
 */
function extractParenBody(text, openIndex) {
  let depth = 1;
  let inString = false;
  for (let i = openIndex + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") inString = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  throw new DataCensusValidationError("unbalanced_ddl", `open@${openIndex}`);
}

/** Split a table body on top-level commas (ignoring commas inside ()/'…'). */
function splitTopLevelCommas(body) {
  const parts = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") inString = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

const TABLE_CONSTRAINT_KEYWORDS = new Set([
  "PRIMARY",
  "UNIQUE",
  "FOREIGN",
  "CHECK",
  "CONSTRAINT",
]);

/** Column names declared in a table body (skips table-level constraints). */
function parseColumnNames(body) {
  const columns = [];
  for (const segment of splitTopLevelCommas(body)) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^["'`]?([A-Za-z_][A-Za-z0-9_]*)/);
    if (!match) continue;
    const name = match[1];
    if (TABLE_CONSTRAINT_KEYWORDS.has(name.toUpperCase())) continue;
    columns.push(name);
  }
  return columns;
}

// One combined statement matcher. Alternatives are ordered so CREATE VIRTUAL
// TABLE is tried before plain CREATE TABLE. Capture groups:
//   1: virtual-table name           2: create-table name
//   3/4: rename FROM / TO           5/6: alter-add table / column
//   7: drop-table name
const STATEMENT_RE = new RegExp(
  [
    "CREATE\\s+VIRTUAL\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s+USING\\s+\\w+\\s*\\(",
    "CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s*\\(",
    "ALTER\\s+TABLE\\s+([A-Za-z_][A-Za-z0-9_]*)\\s+RENAME\\s+TO\\s+([A-Za-z_][A-Za-z0-9_]*)",
    "ALTER\\s+TABLE\\s+([A-Za-z_][A-Za-z0-9_]*)\\s+ADD\\s+COLUMN\\s+([A-Za-z_][A-Za-z0-9_]*)",
    "DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?([A-Za-z_][A-Za-z0-9_]*)",
  ].join("|"),
  "gi",
);

/**
 * REPLAY every DDL statement in a chunk of (comment-stripped) source text — in
 * SOURCE ORDER — against a live Map<table, Set<column>>. Replaying CREATE / ADD
 * COLUMN / RENAME TO / DROP TABLE (not just collecting CREATEs) yields the NET
 * schema: transient rebuild scaffolds (`x_new` → drop `x` → rename `x_new`→`x`)
 * net out, while a table renamed to a `_legacy` name and NOT dropped correctly
 * remains a discoverable (lingering) data surface. Column sets are UNIONed, so
 * a rebuilt table keeps its full historical column manifest.
 */
function replayDdl(text, into) {
  const map = into ?? new Map();
  const ensure = (name) => {
    if (!map.has(name)) map.set(name, new Set());
    return map.get(name);
  };

  for (let m = STATEMENT_RE.exec(text); m !== null; m = STATEMENT_RE.exec(text)) {
    if (m[1] !== undefined) {
      // CREATE VIRTUAL TABLE (FTS) — keep bare identifier tokens, drop options.
      const body = extractParenBody(text, m.index + m[0].length - 1);
      const cols = ensure(m[1]);
      for (const seg of splitTopLevelCommas(body)) {
        const trimmed = seg.trim();
        if (!trimmed || trimmed.includes("=")) continue;
        const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
        if (match) cols.add(match[1]);
      }
    } else if (m[2] !== undefined) {
      // CREATE TABLE
      const body = extractParenBody(text, m.index + m[0].length - 1);
      const cols = ensure(m[2]);
      for (const col of parseColumnNames(body)) cols.add(col);
    } else if (m[3] !== undefined) {
      // ALTER TABLE <from> RENAME TO <to>
      const cols = map.get(m[3]) ?? new Set();
      map.delete(m[3]);
      const target = ensure(m[4]);
      for (const col of cols) target.add(col);
    } else if (m[5] !== undefined) {
      // ALTER TABLE <t> ADD COLUMN <c>
      ensure(m[5]).add(m[6]);
    } else if (m[7] !== undefined) {
      // DROP TABLE <t>
      map.delete(m[7]);
    }
  }
  return map;
}

// ── Policy derivation (from real source signals only) ──────────────────────

function deriveEncryption(columns) {
  if (columns.some((c) => CIPHER_SIGNAL.test(c))) return "column-encrypted";
  if (columns.some((c) => HASH_SIGNAL.test(c))) return "hashed";
  return "plaintext";
}

function deriveRetentionForTable(table) {
  if (CONTENT_TABLES.has(table)) return "content-opt-in";
  if (SECURITY_TABLES.has(table)) return "security-lifecycle-ttl";
  return "permanent-default";
}

/** Parse `pub const HUB_ONLY_TABLES: &[&str] = &[ "a", "b", … ];` from schema.rs. */
function parseHubOnlyTables(rustText) {
  const decl = rustText.match(/HUB_ONLY_TABLES\s*:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\]/);
  const set = new Set();
  if (!decl) return set;
  for (const q of decl[1].matchAll(/"([a-z_][a-z0-9_]*)"/gi)) set.add(q[1]);
  return set;
}

// ── Census construction ────────────────────────────────────────────────────

function buildTableElement(source, table, columnSet, hubOnly) {
  const columns = [...columnSet].sort();
  let owner;
  if (source === "sqlite") owner = "hub-sqlite";
  else owner = hubOnly.has(table) ? "hub-rust" : "shared-rust";
  return {
    key: `${source}:${table}`,
    kind: "table",
    source,
    table,
    columns,
    columnCount: columns.length,
    derived: {
      owner,
      encryption: deriveEncryption(columns),
      retention: deriveRetentionForTable(table),
    },
  };
}

function buildRetentionCategoryElements() {
  const elements = [];
  for (const [category, table] of Object.entries(CONTENT_CATEGORY_TABLE)) {
    elements.push({
      key: `retention:${category}`,
      kind: "retention-category",
      source: "retention",
      table,
      columns: [],
      columnCount: 0,
      derived: { owner: "friday-retention", encryption: "not-applicable", retention: "content-opt-in" },
    });
  }
  for (const [category, table] of Object.entries(SECURITY_LIFECYCLE_TABLE)) {
    elements.push({
      key: `retention:${category}`,
      kind: "retention-category",
      source: "retention",
      table,
      columns: [],
      columnCount: 0,
      derived: {
        owner: "friday-retention",
        encryption: "not-applicable",
        retention: "security-lifecycle-ttl",
      },
    });
  }
  return elements;
}

/** Crawl the static source tree into a sorted, deterministic census element list. */
function crawlCensus() {
  // SQLite migrations — read every v*.ts in sorted order, union all DDL.
  const sqliteMap = new Map();
  const files = readdirSync(SQLITE_MIGRATIONS_DIR)
    .filter((f) => /^v\d+.*\.ts$/.test(f))
    .sort();
  for (const file of files) {
    const text = stripComments(readFileSync(join(SQLITE_MIGRATIONS_DIR, file), "utf8"));
    replayDdl(text, sqliteMap);
  }

  // Rust-owned storage schema.
  const rustText = stripComments(readFileSync(RUST_SCHEMA_FILE, "utf8"));
  const rustMap = replayDdl(rustText);
  const hubOnly = parseHubOnlyTables(readFileSync(RUST_SCHEMA_FILE, "utf8"));

  const elements = [];
  for (const [table, cols] of sqliteMap) elements.push(buildTableElement("sqlite", table, cols, hubOnly));
  for (const [table, cols] of rustMap) elements.push(buildTableElement("rust", table, cols, hubOnly));
  elements.push(...buildRetentionCategoryElements());

  elements.sort((a, b) => a.key.localeCompare(b.key));
  return elements;
}

/** Derive a DECLARED registry seed from the census (owner/encryption/retention
 *  copied from source-derived signals; export/delete/backup honestly "gated"). */
function deriveRegistrySeed(census) {
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

// ── Reconcile (pure keyed set-difference) ──────────────────────────────────

/** Validate + index a census universe into Map<key, element>. Fail-closed. */
function indexCensus(elements) {
  const map = new Map();
  const duplicates = [];
  elements.forEach((el, index) => {
    if (!el || typeof el !== "object" || Array.isArray(el)) {
      throw new DataCensusValidationError("element_not_object", `census[${index}]`);
    }
    if (typeof el.key !== "string" || el.key.trim().length === 0) {
      throw new DataCensusValidationError("invalid_key", `census[${index}]`);
    }
    if (typeof el.kind !== "string" || !KINDS.has(el.kind)) {
      throw new DataCensusValidationError("invalid_kind", `census[${index}]:${String(el.kind)}`);
    }
    if (typeof el.source !== "string" || !SOURCES.has(el.source)) {
      throw new DataCensusValidationError("invalid_source", `census[${index}]:${String(el.source)}`);
    }
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
function indexRegistry(elements) {
  const map = new Map();
  const duplicates = [];
  elements.forEach((el, index) => {
    if (!el || typeof el !== "object" || Array.isArray(el)) {
      throw new DataCensusValidationError("element_not_object", `registry[${index}]`);
    }
    if (typeof el.key !== "string" || el.key.trim().length === 0) {
      throw new DataCensusValidationError("invalid_key", `registry[${index}]`);
    }
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
function reconcile(registryElements, censusElements) {
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
  // Required static dims MUST be classified; the gated dims must at least carry
  // the honest "gated"/"not-applicable" sentinel (never left "unknown").
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

// ── Census coverage summary (metadata for the report / registry seeding) ────

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

function writeOut(outPath, payload) {
  const out = isAbsolute(outPath) ? outPath : resolve(outPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
}

function usage() {
  console.error(`usage:
  node tools/inventory/data-universe-census.mjs [census] [--out=/abs/census.json]
  node tools/inventory/data-universe-census.mjs emit-registry [--out=/abs/registry.json]
  node tools/inventory/data-universe-census.mjs reconcile \\
    --registry=/abs/data-universe-registry.json \\
    [--census=/abs/census.json] [--out=/abs/report.json] [--allow-blocked]

Truth: STATIC-SOURCE data-universe census + pure deterministic reconciler. It
does NOT crawl the live runtime, unpack a signed artifact, read prod paths, or
close INV-DATA-001. The gated remainder is out of scope (see the schema doc).`);
}

function runCensus() {
  const census = crawlCensus();
  const report = {
    truth: "data_universe_census",
    generated_at_utc: new Date().toISOString(), // metadata only — NEVER in a verdict path
    coverage: censusCoverage(census),
    elements: census,
    caveat:
      "Static-source census only. Per-column / per-payload-field policy and the real runtime universe are release/operator-gated and out of scope.",
  };
  const outPath = argValue("out");
  if (outPath) writeOut(outPath, report);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

function runEmitRegistry() {
  const census = crawlCensus();
  const registry = {
    truth: "data_universe_registry",
    note: "DECLARED policy registry (seed). owner/encryption/retention are source-derived; export/delete/backup are closure-gated. Hand-owned going forward; drift from source REDs the reconcile.",
    dimensions: { requiredStatic: REQUIRED_STATIC_DIMS, gated: GATED_DIMS },
    elements: deriveRegistrySeed(census),
  };
  const outPath = argValue("out");
  if (outPath) writeOut(outPath, registry);
  console.log(JSON.stringify(registry, null, 2));
  process.exit(0);
}

function runReconcile() {
  const registryPath = argValue("registry");
  if (!registryPath) throw new DataCensusValidationError("missing_arg", "registry");
  const registryElements = readJsonArray("registry", registryPath, "elements");

  const censusPath = argValue("census");
  const censusElements = censusPath
    ? readJsonArray("census", censusPath, "elements")
    : crawlCensus();

  const result = reconcile(registryElements, censusElements);
  const report = {
    truth: "data_universe_reconcile",
    status: result.status,
    generated_at_utc: new Date().toISOString(), // metadata only — NEVER in the pass/fail path
    inputs: { registry: registryPath, census: censusPath || "<live-source-crawl>" },
    summary: result.summary,
    blockers: result.blockers,
    caveat:
      "Static-source reconcile only. GREEN means the declared registry reconciles with the source-discoverable data surface; it does NOT close INV-DATA-001 (live crawl + unpacked signed-artifact scan + prod-path readback + operator seal are out of scope).",
  };
  const outPath = argValue("out");
  if (outPath) writeOut(outPath, report);
  console.log(JSON.stringify(report, null, 2));
  const allowBlocked = rawArgs.includes("--allow-blocked");
  process.exit(result.status === "passed" || allowBlocked ? 0 : 2);
}

function main() {
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    usage();
    process.exit(0);
  }
  const subcommand = rawArgs.find((a) => !a.startsWith("-")) || "census";
  if (subcommand === "census") return runCensus();
  if (subcommand === "emit-registry") return runEmitRegistry();
  if (subcommand === "reconcile") return runReconcile();
  usage();
  process.exit(2);
}

try {
  main();
} catch (error) {
  if (error instanceof DataCensusValidationError) {
    const report = {
      truth: "data_universe_reconcile",
      status: "error",
      error: { code: error.code, detail: error.detail, message: error.message },
      caveat: "Malformed input rejected fail-closed; a malformed inventory can never read as passed.",
    };
    console.log(JSON.stringify(report, null, 2));
    process.exit(3);
  }
  throw error;
}

// Exported for the contract test (pure engine + fixtures).
export { reconcile, crawlCensus, deriveRegistrySeed, censusCoverage, DataCensusValidationError };
