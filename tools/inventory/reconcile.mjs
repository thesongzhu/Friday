#!/usr/bin/env node
/**
 * INV-ARTIFACT-001 (P0) — deterministic artifact-inventory reconciliation gate.
 *
 * Pure keyed set-difference between two element inventories:
 *   REGISTRY (declared/expected) vs OBSERVED (authoritative/enumerated).
 * Emits a typed blocker vocabulary and turns the verdict RED when an artifact
 * element is unregistered (ghost) or a required element is omitted.
 *
 * ── HONEST SCOPING (release-gated boundary) ────────────────────────────────
 * This ships ONLY the deterministic reconciler + a red-first behavioral
 * negative control, exercised on FIXTURES. Producing the REAL OBSERVED
 * universe — unpacking a real signed DMG/AAB and crawling the installed
 * runtime — is RELEASE-GATED and explicitly NOT in scope here. This slice
 * does NOT let anyone claim `release_status: passed`; it is the pure engine
 * that the operator's later real-artifact unpack will feed. GREEN here means
 * "the two supplied inventories reconcile", nothing about a real release.
 *
 * ── DETERMINISM ────────────────────────────────────────────────────────────
 * The verdict body (status, blockers, counts) is a pure function of the two
 * input files: universes are indexed and iterated in canonical sort() order
 * on elementId, and blockers are sorted (code, detail). NO clock or random is
 * ever consulted in the pass/fail path — `generated_at_utc` is metadata only.
 *
 * ── BLOCKER VOCABULARY (contract INV-ARTIFACT-001 proof_scope) ──────────────
 *   ghost_element        OBSERVED − REGISTRY           (unregistered element)
 *   required_unobserved  REGISTRY{required} − OBSERVED  (required element omitted)
 *   sha_mismatch         id in both universes, sha256 present on both and differ
 *   duplicate_id         same elementId appears twice within one universe
 * GREEN iff all four counts == 0 → status "passed"; else "blocked".
 *
 * ── ELEMENT MODEL ──────────────────────────────────────────────────────────
 *   elementType ∈ {binary, entitlement, config, asset, route, flag}
 *   elementId   = "{elementType}:{normalizedKey}"   (normalizedKey = id.trim())
 * See tools/inventory/element-inventory-schema.md for the full schema.
 *
 * ── FAIL-CLOSED ────────────────────────────────────────────────────────────
 * Malformed input is rejected with a typed InventoryValidationError and exits
 * 3 UNCONDITIONALLY (a malformed inventory can never read as passed). A clean
 * "blocked" reconciliation exits 2 only under --require-passed (mirrors
 * scripts/ops/check-friday-suite13-coverage-oracle.mjs).
 *
 * Usage:
 *   node tools/inventory/reconcile.mjs \
 *     --registry=/abs/registry-inventory.json \
 *     --observed=/abs/observed-inventory.json \
 *     [--out=/abs/reconcile-report.json] [--require-passed]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const ELEMENT_TYPES = new Set([
  "binary",
  "entitlement",
  "config",
  "asset",
  "route",
  "flag",
]);

class InventoryValidationError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "InventoryValidationError";
    this.code = code;
    this.detail = detail;
  }
}

const args = process.argv.slice(2);

function arg(name) {
  const prefix = `--${name}=`;
  for (let i = 0; i < args.length; i += 1) {
    const v = args[i];
    if (v.startsWith(prefix)) return v.slice(prefix.length);
    if (v === `--${name}` && args[i + 1]) return args[i + 1];
  }
  return "";
}

function usage() {
  console.error(`usage:
  node tools/inventory/reconcile.mjs \\
    --registry=/abs/registry-inventory.json \\
    --observed=/abs/observed-inventory.json \\
    [--out=/abs/reconcile-report.json] [--require-passed]

Truth: pure deterministic reconciler over two element inventories. It does NOT
unpack a real artifact, enumerate a real installed runtime, or authorize
release_status: passed. Real OBSERVED production is release-gated (out of scope).`);
}

function absolute(path) {
  return isAbsolute(path) ? path : resolve(path);
}

/**
 * Read + parse one inventory file, fail-closed on any structural defect.
 * Returns the raw `elements` array (element-level validation happens in
 * indexUniverse). Throws InventoryValidationError on malformed input.
 */
function readInventory(role, path) {
  if (!path) throw new InventoryValidationError("missing_arg", role);
  if (!isAbsolute(path)) {
    throw new InventoryValidationError("path_not_absolute", `${role}:${path}`);
  }
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new InventoryValidationError("unreadable_file", `${role}:${path}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new InventoryValidationError("invalid_json", `${role}:${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InventoryValidationError("inventory_not_object", role);
  }
  if (!Array.isArray(parsed.elements)) {
    throw new InventoryValidationError("elements_not_array", role);
  }
  return parsed.elements;
}

/**
 * Validate + index one universe into Map<elementId, {sha256, required}>.
 * Duplicate elementIds are recorded (first occurrence wins in the map) so the
 * set-difference stays well-defined while duplicate_id is still reported.
 * Element-shape defects are fail-closed (typed error). Pure over input.
 */
function indexUniverse(role, elements) {
  const map = new Map();
  const duplicates = [];
  for (const [index, element] of elements.entries()) {
    if (!element || typeof element !== "object" || Array.isArray(element)) {
      throw new InventoryValidationError("element_not_object", `${role}[${index}]`);
    }
    const elementType = element.elementType;
    if (typeof elementType !== "string" || !ELEMENT_TYPES.has(elementType)) {
      throw new InventoryValidationError(
        "invalid_element_type",
        `${role}[${index}]:${String(elementType)}`,
      );
    }
    if (typeof element.id !== "string" || element.id.trim().length === 0) {
      throw new InventoryValidationError("invalid_element_id", `${role}[${index}]`);
    }
    if (
      element.sha256 !== undefined &&
      (typeof element.sha256 !== "string" || element.sha256.trim().length === 0)
    ) {
      throw new InventoryValidationError("invalid_sha256", `${role}[${index}]`);
    }
    if (
      role === "registry" &&
      element.required !== undefined &&
      typeof element.required !== "boolean"
    ) {
      throw new InventoryValidationError("invalid_required_flag", `${role}[${index}]`);
    }

    const elementId = `${elementType}:${element.id.trim()}`;
    if (map.has(elementId)) {
      duplicates.push(elementId);
      continue;
    }
    map.set(elementId, {
      sha256: typeof element.sha256 === "string" ? element.sha256.trim() : null,
      required: element.required === true,
    });
  }
  return { map, duplicates };
}

/**
 * Pure reconciler. Deterministic: iterates canonical sort() order on elementId
 * and sorts the final blocker list. No clock/random anywhere in this path.
 */
function reconcile(registryElements, observedElements) {
  const registry = indexUniverse("registry", registryElements);
  const observed = indexUniverse("observed", observedElements);
  const blockers = [];
  const push = (code, detail) => blockers.push({ code, detail });

  // duplicate_id — a dup within EITHER universe
  for (const elementId of [...registry.duplicates].sort()) {
    push("duplicate_id", `registry:${elementId}`);
  }
  for (const elementId of [...observed.duplicates].sort()) {
    push("duplicate_id", `observed:${elementId}`);
  }

  // ── ghost_element block (OBSERVED − REGISTRY) ──
  // NOTE: isolable unit — the REVERT-RED step comments out exactly this loop to
  // re-red the ghost contract test while every other case stays green.
  for (const elementId of [...observed.map.keys()].sort()) {
    if (!registry.map.has(elementId)) push("ghost_element", elementId);
  }
  // ── end ghost_element block ──

  // required_unobserved — REGISTRY{required} − OBSERVED
  for (const elementId of [...registry.map.keys()].sort()) {
    const record = registry.map.get(elementId);
    if (record.required && !observed.map.has(elementId)) {
      push("required_unobserved", elementId);
    }
  }

  // sha_mismatch — present in both, sha256 declared on both, and they differ
  for (const elementId of [...registry.map.keys()].sort()) {
    const observedRecord = observed.map.get(elementId);
    if (!observedRecord) continue;
    const registryRecord = registry.map.get(elementId);
    if (
      registryRecord.sha256 &&
      observedRecord.sha256 &&
      registryRecord.sha256 !== observedRecord.sha256
    ) {
      push("sha_mismatch", elementId);
    }
  }

  const summary = {
    registryElementCount: registry.map.size,
    observedElementCount: observed.map.size,
    ghostElementCount: blockers.filter((b) => b.code === "ghost_element").length,
    requiredUnobservedCount: blockers.filter((b) => b.code === "required_unobserved").length,
    shaMismatchCount: blockers.filter((b) => b.code === "sha_mismatch").length,
    duplicateIdCount: blockers.filter((b) => b.code === "duplicate_id").length,
  };

  // Canonical, detection-order-independent blocker ordering.
  blockers.sort((a, b) =>
    a.code === b.code ? a.detail.localeCompare(b.detail) : a.code.localeCompare(b.code),
  );

  const status = blockers.length === 0 ? "passed" : "blocked";
  return { status, blockers, summary };
}

function main() {
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    process.exit(0);
  }

  const registryPath = arg("registry");
  const observedPath = arg("observed");
  const outPath = arg("out");
  const requirePassed = args.includes("--require-passed");

  const registryElements = readInventory("registry", registryPath);
  const observedElements = readInventory("observed", observedPath);
  const result = reconcile(registryElements, observedElements);

  const report = {
    truth: "artifact_inventory_reconcile",
    status: result.status,
    generated_at_utc: new Date().toISOString(), // metadata only — NEVER in the pass/fail path
    inputs: { registry: registryPath, observed: observedPath },
    summary: result.summary,
    blockers: result.blockers,
    caveat:
      "Fixture-scoped deterministic reconciler only. Real OBSERVED universe (signed DMG/AAB unpack + installed-runtime crawl) is release-gated and out of scope; this does NOT authorize release_status: passed.",
  };

  if (outPath) {
    const out = absolute(outPath);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(result.status === "passed" || !requirePassed ? 0 : 2);
}

try {
  main();
} catch (error) {
  if (error instanceof InventoryValidationError) {
    // Fail-closed: malformed inventory can never read as passed.
    const report = {
      truth: "artifact_inventory_reconcile",
      status: "error",
      error: { code: error.code, detail: error.detail, message: error.message },
      caveat:
        "Malformed inventory input rejected fail-closed; a malformed inventory can never read as passed.",
    };
    console.log(JSON.stringify(report, null, 2));
    process.exit(3);
  }
  throw error;
}
