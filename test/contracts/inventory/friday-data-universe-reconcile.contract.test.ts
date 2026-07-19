import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { FRIDAY_SQLITE_MIGRATIONS, runFridayMigrations } from "#state";
import { FRIDAY_RETENTION_CONTENT_CATEGORIES } from "../../../src/jobs/retention/friday-retention.types.js";
import {
  SNAPSHOT_PATH,
  buildAuthoritativeCensus,
  buildRetentionCensus,
  securityLifecycleCategories,
  writeSnapshot,
} from "../../../tools/inventory/data-universe-oracle";
// The reconcile CLI is import-safe (its main() only runs on direct invocation),
// so the pure engine + snapshot loader can be exercised in-process here.
// @ts-expect-error — plain-JS ESM module, no type declarations
import { loadSnapshotCensus } from "../../../tools/inventory/data-universe-census.mjs";
// @ts-expect-error — plain-JS ESM module, no type declarations
import { computeSourceFingerprint } from "../../../tools/inventory/data-universe-source-fingerprint.mjs";

// Contract test for INV-DATA-001 (P0): a deterministic data-universe census +
// keyed set-difference reconcile gate. The SQLite census is AUTHORITATIVE — it is
// produced by tools/inventory/data-universe-oracle.ts, which EXECUTES the real
// committed migration chain against an in-memory better-sqlite3 DB and introspects
// the result (so V069's imperative `apply` metadata columns and FTS shadow tables
// are captured, which a regex "DDL replay" is structurally blind to). The reconcile
// CLI reads a committed snapshot the oracle regenerates, fingerprint-guarded LIVE.
//
// Covered: both set-difference directions (unregistered / ghost), policy_incomplete,
// policy_drift, duplicate_key, malformed fail-closed, a LIVE positive control over
// the real registry+snapshot, and the three Advisor RED-first controls —
//   (F1) authoritative oracle recovers the 37 entries regex misses (V069 + FTS),
//   (F2) semantic-identity fail-closed (kind/source ↔ key-prefix ↔ shape), and
//   (F3) retention categories source-derived from the canonical constants —
// plus the snapshot fingerprint liveness guard.

const script = "tools/inventory/data-universe-census.mjs";
const realRegistry = resolve(process.cwd(), "tools/inventory/data-universe-registry.json");

// Snapshot maintenance: regenerate the committed authoritative snapshot from the
// LIVE oracle (real migrations) BEFORE any test reads it, so a regen run is clean.
// Off by default — the normal CI run only ASSERTS the snapshot is in sync (below).
beforeAll(() => {
  if (process.env.INV_DATA_SNAPSHOT_REGEN === "1") writeSnapshot();
});

// A discovered CENSUS element carries the source-DERIVED static dims.
function censusElement(over: Record<string, unknown> = {}) {
  return {
    key: "sqlite:alpha",
    kind: "table",
    source: "sqlite",
    table: "alpha",
    columns: ["id", "value"],
    columnCount: 2,
    derived: { owner: "hub-sqlite", encryption: "plaintext", retention: "permanent-default" },
    ...over,
  };
}

// A declared REGISTRY element carries all six dims (gated ones as "gated").
function registryElement(over: Record<string, unknown> = {}) {
  return {
    key: "sqlite:alpha",
    kind: "table",
    source: "sqlite",
    owner: "hub-sqlite",
    encryption: "plaintext",
    retention: "permanent-default",
    export: "gated",
    delete: "gated",
    backup: "gated",
    ...over,
  };
}

function balancedCensus() {
  return [censusElement(), censusElement({ key: "sqlite:beta", table: "beta" })];
}
function balancedRegistry() {
  return [registryElement(), registryElement({ key: "sqlite:beta" })];
}

function writeJson(dir: string, name: string, value: unknown) {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function run(args: string[], expectFailure = false) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (!expectFailure) throw error;
    const stdout = (error as { stdout?: Buffer | string }).stdout?.toString() || "";
    return JSON.parse(stdout);
  }
}

// Reconcile two FIXTURE universes through the real engine (hermetic — no snapshot).
function reconcileFixtures(
  dir: string,
  registry: unknown,
  census: unknown,
  expectFailure = false,
) {
  const registryPath = writeJson(dir, "registry.json", { elements: registry });
  const censusPath = writeJson(dir, "census.json", { elements: census });
  return run([`reconcile`, `--registry=${registryPath}`, `--census=${censusPath}`], expectFailure);
}

describe("INV-DATA-001 data-universe reconcile gate", () => {
  it("positive control (fixtures): balanced registry ↔ census reconciles clean", () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-data-"));
    const report = reconcileFixtures(dir, balancedRegistry(), balancedCensus());

    expect(report.truth).toBe("data_universe_reconcile");
    expect(report.status).toBe("passed");
    expect(report.blockers).toEqual([]);
    expect(report.summary.unregisteredCount).toBe(0);
    expect(report.summary.ghostCount).toBe(0);
    expect(report.summary.policyIncompleteCount).toBe(0);
    expect(report.summary.policyDriftCount).toBe(0);
    expect(report.summary.duplicateKeyCount).toBe(0);
  });

  it("positive control (LIVE): the real registry reconciles clean against the authoritative snapshot", () => {
    // Drives the REAL engine over the authoritative census snapshot (no --census ⇒
    // fingerprint-guarded snapshot load). This is the INV-DATA drift gate: if a
    // future migration adds/renames/moves a table without regenerating the snapshot
    // + re-classifying data-universe-registry.json, this RED-s.
    const report = run([`reconcile`, `--registry=${realRegistry}`]);
    expect(report.status).toBe("passed");
    expect(report.blockers).toEqual([]);
    expect(report.summary.registryElementCount).toBe(report.summary.censusElementCount);
    expect(report.summary.registryElementCount).toBeGreaterThan(200);
  });

  it("blocks on unregistered: CENSUS contains an element not in REGISTRY (RED-first control a)", () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-data-"));
    const report = reconcileFixtures(
      dir,
      balancedRegistry(),
      [...balancedCensus(), censusElement({ key: "sqlite:ghost_surface", table: "ghost_surface" })],
      true,
    );

    expect(report.status).toBe("blocked");
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unregistered", detail: "sqlite:ghost_surface" }),
      ]),
    );
  });

  it("blocks on ghost: a REGISTRY element is absent from CENSUS (RED-first control b)", () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-data-"));
    const report = reconcileFixtures(
      dir,
      balancedRegistry(),
      balancedCensus().filter((e) => e.key !== "sqlite:beta"),
      true,
    );

    expect(report.status).toBe("blocked");
    expect(report.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "ghost", detail: "sqlite:beta" })]),
    );
  });

  it("blocks on policy_incomplete: a registered element has a required dim = unknown (RED-first control c)", () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-data-"));
    const report = reconcileFixtures(
      dir,
      [registryElement(), registryElement({ key: "sqlite:beta", retention: "unknown" })],
      balancedCensus(),
      true,
    );

    expect(report.status).toBe("blocked");
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "policy_incomplete", detail: "sqlite:beta.retention" }),
      ]),
    );
  });

  it("blocks on policy_drift: a declared static dim no longer matches source (RED-first control d)", () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-data-"));
    const report = reconcileFixtures(
      dir,
      balancedRegistry(),
      [
        censusElement(),
        censusElement({
          key: "sqlite:beta",
          table: "beta",
          columns: ["id", "payload_ciphertext"],
          columnCount: 2,
          derived: {
            owner: "hub-sqlite",
            encryption: "column-encrypted",
            retention: "permanent-default",
          },
        }),
      ],
      true,
    );

    expect(report.status).toBe("blocked");
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "policy_drift",
          detail: "sqlite:beta.encryption:declared=plaintext,source=column-encrypted",
        }),
      ]),
    );
  });

  it("blocks on duplicate_key: the same key appears twice in one universe", () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-data-"));
    const report = reconcileFixtures(
      dir,
      balancedRegistry(),
      [...balancedCensus(), censusElement({ key: "sqlite:beta", table: "beta" })],
      true,
    );

    expect(report.status).toBe("blocked");
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate_key",
          detail: expect.stringContaining("census:sqlite:beta"),
        }),
      ]),
    );
  });

  it("fails closed on malformed input: a required derived dim is an unknown VALUE (typed error, exit 3)", () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-data-"));
    const report = reconcileFixtures(
      dir,
      balancedRegistry(),
      [censusElement({ derived: { owner: "hub-sqlite", encryption: "rot13", retention: "permanent-default" } })],
      true,
    );

    expect(report.status).toBe("error");
    expect(report.error.code).toBe("invalid_derived_value");
  });
});

describe("INV-DATA-001 authoritative oracle (Finding 1 — census is not regex, not false-clean)", () => {
  it("the committed snapshot equals the LIVE authoritative oracle (regen with INV_DATA_SNAPSHOT_REGEN=1)", () => {
    // Liveness guard: every CI run re-executes the real migrations via the oracle
    // and asserts the committed snapshot (which the plain-node CLI reads) still
    // equals the live schema + fingerprint. A migration/schema/retention change
    // without a snapshot regen RED-s here. (Regeneration itself happens in the
    // env-gated beforeAll so a regen run stays green.)
    const committed = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
    expect(committed.elements).toEqual(buildAuthoritativeCensus());
    expect(committed.sourceFingerprint).toEqual(computeSourceFingerprint());
  });

  it("independent re-introspection of a fresh migrated DB matches the census — ZERO missing/extra (F1)", () => {
    const db = new Database(":memory:");
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });
    const real = new Map<string, Set<string>>();
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>) {
      if (name.startsWith("sqlite_")) continue;
      const cols = (db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      real.set(name, new Set(cols));
    }
    db.close();

    const census = buildAuthoritativeCensus();
    const censusSqlite = new Map(
      census.filter((e) => e.source === "sqlite").map((e) => [e.table, new Set(e.columns)]),
    );

    const missingTables = [...real.keys()].filter((t) => !censusSqlite.has(t));
    const extraTables = [...censusSqlite.keys()].filter((t) => !real.has(t));
    expect(missingTables).toEqual([]);
    expect(extraTables).toEqual([]);

    const missingCols: string[] = [];
    const extraCols: string[] = [];
    for (const [t, cols] of real) {
      const cc = censusSqlite.get(t) as Set<string>;
      for (const c of cols) if (!cc.has(c)) missingCols.push(`${t}.${c}`);
      for (const c of cc) if (!cols.has(c)) extraCols.push(`${t}.${c}`);
    }
    expect(missingCols).toEqual([]);
    expect(extraCols).toEqual([]);
  });

  it("recovers the V069 dynamic `apply`-hook columns + FTS shadow tables that regex replay MISSES (F1 RED-first)", () => {
    const census = buildAuthoritativeCensus();
    const byKey = new Map(census.map((e) => [e.key, e]));

    // V069 metadata columns are added by an imperative apply(db) hook → invisible
    // to static DDL text, present in the real schema.
    const v069 = [
      "last_verified_at",
      "last_verified_runtime_version",
      "last_verified_provider_model",
      "compatibility_status",
      "promotion_channel",
      "shadow_version_id",
      "canary_stats_json",
    ];
    for (const table of ["sqlite:skills", "sqlite:workflows", "sqlite:provider_profiles"]) {
      const el = byKey.get(table);
      for (const col of v069) expect(el?.columns).toContain(col);
    }

    // FTS5 shadow tables only exist once the virtual table is really created.
    for (const shadow of [
      "sqlite:memory_items_fts_data",
      "sqlite:memory_items_fts_idx",
      "sqlite:memory_items_fts_config",
      "sqlite:memory_items_fts_docsize",
      "sqlite:session_messages_fts_data",
      "sqlite:session_messages_fts_idx",
    ]) {
      expect(byKey.has(shadow)).toBe(true);
    }
  });
});

describe("INV-DATA-001 semantic identity fail-closed (Finding 2)", () => {
  it("fails closed when a sqlite-prefixed registry key is declared as a retention category (exit 3)", () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-data-"));
    const report = reconcileFixtures(
      dir,
      // key-prefix `sqlite:` but source/kind flipped to retention — an inconsistent
      // semantic identity that USED to pass (only key + dim values were checked).
      [
        registryElement(),
        registryElement({ key: "sqlite:beta", kind: "retention-category", source: "retention" }),
      ],
      balancedCensus(),
      true,
    );
    expect(report.status).toBe("error");
    expect(report.error.code).toBe("semantic_source_mismatch");
  });

  it("fails closed when a census element's columnCount lies about its columns (exit 3)", () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-data-"));
    const report = reconcileFixtures(
      dir,
      balancedRegistry(),
      [censusElement(), censusElement({ key: "sqlite:beta", table: "beta", columns: ["id"], columnCount: 9 })],
      true,
    );
    expect(report.status).toBe("error");
    expect(report.error.code).toBe("column_count_mismatch");
  });

  it("fails closed when a census key does not match its declared source:table (exit 3)", () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-data-"));
    const report = reconcileFixtures(
      dir,
      balancedRegistry(),
      [censusElement(), censusElement({ key: "sqlite:beta", table: "not_beta" })],
      true,
    );
    expect(report.status).toBe("error");
    expect(report.error.code).toBe("key_table_mismatch");
  });
});

describe("INV-DATA-001 retention source-derivation (Finding 3)", () => {
  it("retention categories are DERIVED from the canonical governance constants, not re-declared", () => {
    const census = buildAuthoritativeCensus();
    const retentionKeys = census
      .filter((e) => e.source === "retention")
      .map((e) => e.key)
      .sort();
    const expectedKeys = [...FRIDAY_RETENTION_CONTENT_CATEGORIES, ...securityLifecycleCategories()]
      .map((c) => `retention:${c}`)
      .sort();
    expect(retentionKeys).toEqual(expectedKeys);
  });

  it("fails closed when a real source retention category is renamed or removed (RED-first: previously invisible false-green)", () => {
    const renamed = FRIDAY_RETENTION_CONTENT_CATEGORIES.map((c) =>
      c === "auditLogs" ? "auditRecords" : c,
    );
    expect(() => buildRetentionCensus(renamed)).toThrow(/retention_content_category_drift/);

    const removed = FRIDAY_RETENTION_CONTENT_CATEGORIES.filter((c) => c !== "auditLogs");
    expect(() => buildRetentionCensus(removed)).toThrow(/retention_content_category_drift/);
  });
});

describe("INV-DATA-001 snapshot fingerprint liveness", () => {
  it("loads the real snapshot clean and fails closed on a stale fingerprint (exit 3 in the CLI)", () => {
    const real = loadSnapshotCensus();
    expect(Array.isArray(real)).toBe(true);
    expect(real.length).toBeGreaterThan(200);

    const dir = mkdtempSync(join(tmpdir(), "inv-data-"));
    const good = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
    const badPath = join(dir, "stale-snapshot.json");
    writeFileSync(badPath, JSON.stringify({ ...good, sourceFingerprint: "sha256:deadbeef" }));
    expect(() => loadSnapshotCensus(badPath)).toThrow(/snapshot_stale/);
  });
});
