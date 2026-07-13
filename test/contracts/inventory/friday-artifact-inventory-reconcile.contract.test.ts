import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Contract test for INV-ARTIFACT-001 (P0): a deterministic artifact-inventory
// reconciliation gate. Modeled on the proven Suite-13 coverage-oracle CLI test
// (test/unit/qa/friday-suite13-coverage-oracle-cli.test.ts): execFileSync the
// .mjs, feed fixture JSON written under mkdtempSync, assert status + blocker
// codes. Both negative-control directions are covered — a ghost element
// (OBSERVED - REGISTRY) and a required element omitted from OBSERVED — plus a
// balanced passed case, a sha_mismatch case, a duplicate_id case, and a
// malformed fail-closed case.

const script = "tools/inventory/reconcile.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function writeJson(dir: string, name: string, value: unknown) {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

// Declared/expected universe. `required` marks elements that MUST be observed.
function registryElements() {
  return [
    { elementType: "binary", id: "Friday.app/Contents/MacOS/Friday", sha256: SHA_A, required: true },
    { elementType: "entitlement", id: "com.apple.security.network.client", required: true },
    { elementType: "config", id: "hub.config.json", sha256: SHA_B, required: true },
    { elementType: "route", id: "POST /v1/agent/runs", required: false },
  ];
}

// Authoritative/enumerated universe that exactly satisfies the registry:
// every required element present, shas aligned, no ghosts, no dups.
function observedElementsBalanced() {
  return [
    { elementType: "binary", id: "Friday.app/Contents/MacOS/Friday", sha256: SHA_A },
    { elementType: "entitlement", id: "com.apple.security.network.client" },
    { elementType: "config", id: "hub.config.json", sha256: SHA_B },
  ];
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

function reconcile(dir: string, registry: unknown, observed: unknown, expectFailure = false) {
  const registryPath = writeJson(dir, "registry.json", registry);
  const observedPath = writeJson(dir, "observed.json", observed);
  return run(
    [`--registry=${registryPath}`, `--observed=${observedPath}`, "--require-passed"],
    expectFailure,
  );
}

describe("INV-ARTIFACT-001 artifact-inventory reconcile gate", () => {
  it("passes when OBSERVED exactly satisfies REGISTRY (positive control)", () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-artifact-"));
    const report = reconcile(
      dir,
      { elements: registryElements() },
      { elements: observedElementsBalanced() },
    );

    expect(report.truth).toBe("artifact_inventory_reconcile");
    expect(report.status).toBe("passed");
    expect(report.blockers).toEqual([]);
    expect(report.summary.ghostElementCount).toBe(0);
    expect(report.summary.requiredUnobservedCount).toBe(0);
    expect(report.summary.shaMismatchCount).toBe(0);
    expect(report.summary.duplicateIdCount).toBe(0);
  });

  it("blocks on a ghost element: OBSERVED contains an element not in REGISTRY", () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-artifact-"));
    const report = reconcile(
      dir,
      { elements: registryElements() },
      {
        elements: [
          ...observedElementsBalanced(),
          { elementType: "flag", id: "experimental_backdoor" },
        ],
      },
      true,
    );

    expect(report.status).toBe("blocked");
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ghost_element", detail: "flag:experimental_backdoor" }),
      ]),
    );
  });

  it("blocks on required_unobserved: a required REGISTRY element is omitted from OBSERVED", () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-artifact-"));
    const report = reconcile(
      dir,
      { elements: registryElements() },
      {
        // entitlement (required) dropped from the observed universe
        elements: observedElementsBalanced().filter(
          (e) => e.elementType !== "entitlement",
        ),
      },
      true,
    );

    expect(report.status).toBe("blocked");
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "required_unobserved",
          detail: "entitlement:com.apple.security.network.client",
        }),
      ]),
    );
  });

  it("blocks on sha_mismatch: an element present in both universes has differing sha256", () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-artifact-"));
    const observed = observedElementsBalanced().map((e) =>
      e.elementType === "binary" ? { ...e, sha256: SHA_C } : e,
    );
    const report = reconcile(dir, { elements: registryElements() }, { elements: observed }, true);

    expect(report.status).toBe("blocked");
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "sha_mismatch",
          detail: "binary:Friday.app/Contents/MacOS/Friday",
        }),
      ]),
    );
  });

  it("blocks on duplicate_id: the same elementId appears twice in one universe", () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-artifact-"));
    const report = reconcile(
      dir,
      { elements: registryElements() },
      {
        elements: [
          ...observedElementsBalanced(),
          { elementType: "config", id: "hub.config.json", sha256: SHA_B },
        ],
      },
      true,
    );

    expect(report.status).toBe("blocked");
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate_id",
          detail: expect.stringContaining("config:hub.config.json"),
        }),
      ]),
    );
  });

  it("fails closed on malformed input: REGISTRY.elements is not an array (typed error, non-zero exit)", () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-artifact-"));
    const report = reconcile(
      dir,
      { elements: "nope" },
      { elements: observedElementsBalanced() },
      true,
    );

    expect(report.status).toBe("error");
    expect(report.error.code).toBe("elements_not_array");
  });
});
