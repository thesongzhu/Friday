import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Contract test for INV-DATA-001 (P0): a deterministic STATIC-SOURCE
// data-universe census + keyed set-difference reconcile gate. Modeled on the
// proven INV-ARTIFACT-001 contract test
// (test/contracts/inventory/friday-artifact-inventory-reconcile.contract.test.ts):
// execFileSync the .mjs, feed fixture JSON written under mkdtempSync, assert
// status + blocker codes. Both set-difference directions are covered — an
// unregistered element (CENSUS − REGISTRY) and a ghost element
// (REGISTRY − CENSUS) — plus a policy_incomplete case (required dim `unknown`),
// a policy_drift case (declared static dim ≠ source-derived), a duplicate_key
// case, and a malformed fail-closed case. A live positive control reconciles the
// REAL committed registry against the REAL source crawl.

const script = "tools/inventory/data-universe-census.mjs";
const realRegistry = resolve(process.cwd(), "tools/inventory/data-universe-registry.json");

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

// Two-element universes that exactly reconcile: every census key registered,
// every declared static dim agrees with the source-derived value, no dups.
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
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (!expectFailure) throw error;
    const stdout = (error as { stdout?: Buffer | string }).stdout?.toString() || "";
    return JSON.parse(stdout);
  }
}

// Reconcile two FIXTURE universes through the real engine.
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

  it("positive control (LIVE): the real committed registry reconciles clean against the real source census", () => {
    // Drives the REAL engine over the REAL migrations + rust schema + retention
    // policy (no --census ⇒ live source crawl). This is the INV-DATA drift gate:
    // if a future migration adds/renames/moves a table without updating
    // data-universe-registry.json, this RED-s until the registry is re-classified.
    const report = run([`reconcile`, `--registry=${realRegistry}`]);
    expect(report.status).toBe("passed");
    expect(report.blockers).toEqual([]);
    // Honest residual is the GATED dimensions (export/delete/backup) + the
    // per-field/runtime universe — documented in data-universe-schema.md, NOT a
    // RED here. There are zero `unknown` static gaps in the current registry.
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
      // beta dropped from the discovered census universe
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
      // registry still declares plaintext…
      balancedRegistry(),
      // …but source now derives an encrypted column for beta
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
