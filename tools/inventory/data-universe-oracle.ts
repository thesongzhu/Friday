/**
 * INV-DATA-001 (P0) — AUTHORITATIVE data-universe census oracle.
 *
 * This is the LIVE source of truth for the SQLite half of the census. Instead of
 * a regex "DDL replay" (which is structurally blind to dynamic migrations —
 * V069 adds its metadata columns through an imperative `apply(db)` hook, and FTS5
 * virtual tables spawn `*_fts_data` / `*_fts_idx` / `*_fts_docsize` / `*_fts_config`
 * SHADOW tables that exist only once the vtable is really created), this oracle
 * EXECUTES the exact committed migration chain (`FRIDAY_SQLITE_MIGRATIONS` via
 * `runFridayMigrations`) against a fresh `new Database(":memory:")` and then
 * INTROSPECTS the resulting schema (`sqlite_master` + `PRAGMA table_info`). What
 * the running database reports IS the census — no parser can be "false-clean".
 *
 * Because this must import the repo's `.ts` migration sources (and `#state`
 * resolves to a dist alias unavailable to plain node), it runs under the repo's
 * vitest/TS toolchain — the same way every migration test bootstraps a DB. The
 * `.mjs` reconcile CLI stays thin and reads the committed snapshot this oracle
 * regenerates, guarded LIVE by the shared source fingerprint.
 *
 * ── Honest boundaries ──────────────────────────────────────────────────────
 *   - SQLite: AUTHORITATIVE (real migration execution + introspection).
 *   - Rust (`friday-storage/src/schema.rs`): a Node in-memory DB cannot run the
 *     Rust store's rusqlite migrations, so the Rust surface is parsed STATICALLY
 *     from schema.rs (CREATE/ALTER/RENAME/DROP replay). This is a documented gap:
 *     if the Rust store ever adds PROGRAMMATIC / conditional DDL (the Rust analog
 *     of V069's `apply` hook), that construct would be invisible here and must be
 *     resolved by the gated live/operator-sealed crawl — never claimed complete.
 *   - Retention categories: derived from the CANONICAL exported governance
 *     constants (`FRIDAY_RETENTION_CONTENT_CATEGORIES` + the security-lifecycle
 *     fields of `FRIDAY_DEFAULT_RETENTION_POLICY`), never re-declared here.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { FRIDAY_SQLITE_MIGRATIONS, runFridayMigrations } from "#state";
import {
  FRIDAY_DEFAULT_RETENTION_POLICY,
  FRIDAY_RETENTION_CONTENT_CATEGORIES,
} from "../../src/jobs/retention/friday-retention.types.js";
// Shared with the reconcile CLI so both sides compute the SAME source fingerprint.
import { REPO_ROOT, computeSourceFingerprint } from "./data-universe-source-fingerprint.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT_PATH = join(HERE, "data-universe-census.snapshot.json");
const RUST_SCHEMA_FILE = join(
  REPO_ROOT,
  "rust-core",
  "crates",
  "friday-storage",
  "src",
  "schema.rs",
);

export type CensusSource = "sqlite" | "rust" | "retention";
export type CensusKind = "table" | "retention-category";

export interface CensusElement {
  key: string;
  kind: CensusKind;
  source: CensusSource;
  table: string;
  columns: string[];
  columnCount: number;
  derived: { owner: string; encryption: string; retention: string };
}

export class DataOracleError extends Error {
  code: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "DataOracleError";
    this.code = code;
  }
}

// ── Static policy derivation (source-signal heuristics; documented in schema.md) ──
const CIPHER_SIGNAL = /(ciphertext|encrypt|enc_alg|sealed_key)/i;
const HASH_SIGNAL = /hash/i;

function deriveEncryption(columns: string[]): string {
  if (columns.some((c) => CIPHER_SIGNAL.test(c))) return "column-encrypted";
  if (columns.some((c) => HASH_SIGNAL.test(c))) return "hashed";
  return "plaintext";
}

// ── Canonical retention category → physical table mapping ───────────────────
// The physical DELETE target for each governance category is NOT cleanly exported
// (it lives inline in the reaper's SQL + repos), so it is hand-maintained here —
// but BOUND to the canonical category CONSTANTS by a fail-closed cross-check: if
// source adds / removes / renames a retention category, `assertMappingCoversSource`
// throws, so the change can never stay invisible (false-green). Everything not
// listed defaults to `permanent-default` (DATA-RETENTION-001).
const CONTENT_CATEGORY_TABLE: Record<string, string> = {
  learningEvents: "learning_events",
  heartbeats: "satellite_heartbeats",
  skillRunTerminal: "skill_run_snapshots",
  auditLogs: "audit_logs",
  agentRuns: "friday_agent_runs",
  llmUsageRecords: "llm_usage_records",
  errorIncidents: "error_incidents",
};
const SECURITY_LIFECYCLE_TABLE: Record<string, string> = {
  pairingRequestsDays: "satellite_pairing_requests",
  outboxTerminalDays: "outbox_messages",
  bootstrapNoncesConsumedDays: "friday_setup_bootstrap_nonces",
};

/** The security-lifecycle categories = policy fields that are NOT content categories. */
export function securityLifecycleCategories(): string[] {
  const content = new Set<string>(FRIDAY_RETENTION_CONTENT_CATEGORIES);
  return Object.keys(FRIDAY_DEFAULT_RETENTION_POLICY)
    .filter((k) => !content.has(k))
    .sort();
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

/** Fail closed unless the hand-maintained mappings exactly cover the canonical source. */
function assertMappingCoversSource(contentCategories: readonly string[]): void {
  if (!sameSet([...contentCategories], Object.keys(CONTENT_CATEGORY_TABLE))) {
    throw new DataOracleError(
      "retention_content_category_drift",
      `canonical content categories [${[...contentCategories].sort().join(",")}] ` +
        `!= mapped [${Object.keys(CONTENT_CATEGORY_TABLE).sort().join(",")}] — update the category→table mapping`,
    );
  }
  const security = securityLifecycleCategories();
  if (!sameSet(security, Object.keys(SECURITY_LIFECYCLE_TABLE))) {
    throw new DataOracleError(
      "retention_security_category_drift",
      `canonical security-lifecycle categories [${security.join(",")}] ` +
        `!= mapped [${Object.keys(SECURITY_LIFECYCLE_TABLE).sort().join(",")}] — update the category→table mapping`,
    );
  }
}

function deriveRetentionForTable(table: string): string {
  if (new Set(Object.values(CONTENT_CATEGORY_TABLE)).has(table)) return "content-opt-in";
  if (new Set(Object.values(SECURITY_LIFECYCLE_TABLE)).has(table)) return "security-lifecycle-ttl";
  return "permanent-default";
}

// ── SQLite: AUTHORITATIVE (real migration execution + introspection) ────────

function buildTableElement(
  source: CensusSource,
  table: string,
  rawColumns: string[],
  hubOnly: Set<string>,
): CensusElement {
  const columns = [...new Set(rawColumns)].sort();
  let owner: string;
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

export function buildSqliteCensus(): CensusElement[] {
  const db = new Database(":memory:");
  try {
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>
    )
      .map((r) => r.name)
      // SQLite-internal bookkeeping (sqlite_sequence, sqlite_stat*, …) is the
      // engine's own surface, not Friday data. Everything else — real tables, FTS
      // virtual tables, AND their auto-created shadow tables — is in scope.
      .filter((name) => !name.startsWith("sqlite_"));

    const elements: CensusElement[] = [];
    for (const name of tables) {
      const quoted = `"${name.split('"').join('""')}"`;
      const columns = (
        db.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{ name: string }>
      ).map((c) => c.name);
      elements.push(buildTableElement("sqlite", name, columns, new Set()));
    }
    return elements;
  } finally {
    db.close();
  }
}

// ── Rust: STATIC schema.rs parse (documented boundary) ──────────────────────

function stripComments(text: string): string {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, " ");
  return noBlock
    .split("\n")
    .map((line) => line.replace(/--.*$/, "").replace(/\/\/.*$/, ""))
    .join("\n");
}

function extractParenBody(text: string, openIndex: number): string {
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
  throw new DataOracleError("unbalanced_ddl", `open@${openIndex}`);
}

function splitTopLevelCommas(body: string): string[] {
  const parts: string[] = [];
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

const TABLE_CONSTRAINT_KEYWORDS = new Set(["PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "CONSTRAINT"]);

function parseColumnNames(body: string): string[] {
  const columns: string[] = [];
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

function replayDdl(text: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const ensure = (name: string): Set<string> => {
    if (!map.has(name)) map.set(name, new Set());
    return map.get(name) as Set<string>;
  };
  for (let m = STATEMENT_RE.exec(text); m !== null; m = STATEMENT_RE.exec(text)) {
    if (m[1] !== undefined) {
      const body = extractParenBody(text, m.index + m[0].length - 1);
      const cols = ensure(m[1]);
      for (const seg of splitTopLevelCommas(body)) {
        const trimmed = seg.trim();
        if (!trimmed || trimmed.includes("=")) continue;
        const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
        if (match) cols.add(match[1]);
      }
    } else if (m[2] !== undefined) {
      const body = extractParenBody(text, m.index + m[0].length - 1);
      const cols = ensure(m[2]);
      for (const col of parseColumnNames(body)) cols.add(col);
    } else if (m[3] !== undefined) {
      const cols = map.get(m[3]) ?? new Set<string>();
      map.delete(m[3]);
      const target = ensure(m[4]);
      for (const col of cols) target.add(col);
    } else if (m[5] !== undefined) {
      ensure(m[5]).add(m[6]);
    } else if (m[7] !== undefined) {
      map.delete(m[7]);
    }
  }
  return map;
}

function parseHubOnlyTables(rustText: string): Set<string> {
  const decl = rustText.match(/HUB_ONLY_TABLES\s*:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\]/);
  const set = new Set<string>();
  if (!decl) return set;
  for (const q of decl[1].matchAll(/"([a-z_][a-z0-9_]*)"/gi)) set.add(q[1]);
  return set;
}

export function buildRustCensus(): CensusElement[] {
  const rawText = readFileSync(RUST_SCHEMA_FILE, "utf8");
  const rustText = stripComments(rawText);
  const rustMap = replayDdl(rustText);
  const hubOnly = parseHubOnlyTables(rawText);
  const elements: CensusElement[] = [];
  for (const [table, cols] of rustMap) {
    elements.push(buildTableElement("rust", table, [...cols], hubOnly));
  }
  return elements;
}

// ── Retention categories: from the CANONICAL governance constants ───────────

export function buildRetentionCensus(
  contentCategories: readonly string[] = FRIDAY_RETENTION_CONTENT_CATEGORIES,
): CensusElement[] {
  assertMappingCoversSource(contentCategories);
  const elements: CensusElement[] = [];
  for (const category of contentCategories) {
    elements.push({
      key: `retention:${category}`,
      kind: "retention-category",
      source: "retention",
      table: CONTENT_CATEGORY_TABLE[category],
      columns: [],
      columnCount: 0,
      derived: { owner: "friday-retention", encryption: "not-applicable", retention: "content-opt-in" },
    });
  }
  for (const category of securityLifecycleCategories()) {
    elements.push({
      key: `retention:${category}`,
      kind: "retention-category",
      source: "retention",
      table: SECURITY_LIFECYCLE_TABLE[category],
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

// ── Assembly ────────────────────────────────────────────────────────────────

export function buildAuthoritativeCensus(): CensusElement[] {
  const elements = [...buildSqliteCensus(), ...buildRustCensus(), ...buildRetentionCensus()];
  elements.sort((a, b) => a.key.localeCompare(b.key));
  return elements;
}

export function censusCoverage(census: CensusElement[]) {
  const bySource: Record<string, number> = {};
  for (const el of census) bySource[el.source] = (bySource[el.source] ?? 0) + 1;
  return {
    totalElements: census.length,
    bySource,
    tableElements: census.filter((e) => e.kind === "table").length,
    retentionCategoryElements: census.filter((e) => e.kind === "retention-category").length,
    totalColumnsEnumerated: census.reduce((n, e) => n + e.columnCount, 0),
  };
}

/** Derive a DECLARED registry seed from the authoritative census. */
export function deriveRegistrySeed(census: CensusElement[]) {
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

export interface CensusSnapshot {
  truth: "data_universe_census_snapshot";
  note: string;
  sourceFingerprint: string;
  coverage: ReturnType<typeof censusCoverage>;
  elements: CensusElement[];
}

export function buildSnapshot(): CensusSnapshot {
  const elements = buildAuthoritativeCensus();
  return {
    truth: "data_universe_census_snapshot",
    note:
      "AUTHORITATIVE data-universe census. SQLite = real migration execution + introspection " +
      "(captures V069 dynamic columns + FTS shadow tables); Rust = static schema.rs parse " +
      "(documented boundary); retention = canonical governance constants. Regenerate with " +
      "INV_DATA_SNAPSHOT_REGEN=1 vitest run test/contracts/inventory/friday-data-universe-reconcile.contract.test.ts. " +
      "The .mjs reconcile CLI fails closed if sourceFingerprint no longer matches disk.",
    sourceFingerprint: computeSourceFingerprint(),
    coverage: censusCoverage(elements),
    elements,
  };
}

export function writeSnapshot(path: string = SNAPSHOT_PATH): CensusSnapshot {
  const snapshot = buildSnapshot();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshot;
}

/** Stable digest of the element list (used by tests to assert zero drift concisely). */
export function elementsDigest(elements: CensusElement[]): string {
  return createHash("sha256").update(JSON.stringify(elements)).digest("hex");
}
