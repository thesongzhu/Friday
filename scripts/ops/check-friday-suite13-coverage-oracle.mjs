#!/usr/bin/env node

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);

const CANONICAL_MECHANISMS = [
  "intake_mission",
  "by_strength_routing",
  "execution_agent_run",
  "verification_proof",
  "memory_confirm_recall",
  "approval_gate",
  "trust_grant_dial",
  "context_passport",
  "audit_hash_chain",
  "token_metering",
  "skills",
  "provider_workspace",
  "channels",
  "voice",
  "pairing_device_trust",
  "needs_me_activity",
  "crash_recovery",
  "smart_queue",
  "smart_watch",
];

const NOT_COVERED_REASONS = new Set([
  "structurally-unreachable-503",
  "not-built",
  "operator-gated",
  "offline-only",
  "android-mock",
  "surface-N/A",
]);

const CELL_STATUSES = new Set(["exercised-green", "recorded-gap"]);
const ORPHAN_KINDS = new Set(["orphan-backend", "orphan-interaction"]);

function usage() {
  console.error(`usage:
  node scripts/ops/check-friday-suite13-coverage-oracle.mjs \\
    --census=/abs/suite13-census.json \\
    --coverage-ledger=/abs/suite13-coverage-ledger.json \\
    [--out=/abs/suite13-coverage-oracle-report.json] [--require-passed]

Truth: validates the Suite-13 census/coverage oracle contract. It does not run
the product, produce organic usage, perform operator-gated actions, or claim
END-BAR completion.`);
}

function arg(name) {
  const prefix = `--${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith(prefix)) return value.slice(prefix.length);
    if (value === `--${name}` && args[index + 1]) return args[index + 1];
  }
  return "";
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const censusPath = arg("census");
const ledgerPath = arg("coverage-ledger");
const outPath = arg("out");
const requirePassed = args.includes("--require-passed");
const blockers = [];
const checks = [];

function block(code, detail) {
  blockers.push({ code, detail });
}

function check(id, passed, detail = "") {
  checks.push({ id, status: passed ? "passed" : "blocked", detail });
  if (!passed) block(id, detail);
}

function absolute(path) {
  return isAbsolute(path) ? path : resolve(path);
}

function requireFile(label, path) {
  if (!path) {
    block("missing_arg", label);
    return "";
  }
  if (!isAbsolute(path)) {
    block("path_not_absolute", `${label}:${path}`);
    return "";
  }
  try {
    const stats = statSync(path);
    if (!stats.isFile()) block("not_file", `${label}:${path}`);
    if (stats.size <= 0) block("empty_file", `${label}:${path}`);
  } catch {
    block("unreadable_file", `${label}:${path}`);
  }
  return path;
}

function readJson(label, path) {
  const file = requireFile(label, path);
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    block("invalid_json", `${label}:${error.message}`);
    return null;
  }
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function stringSet(values) {
  return new Set(array(values).filter((value) => typeof value === "string"));
}

function isBooleanEvidence(value) {
  return typeof value === "boolean" || value === "true" || value === "false";
}

function validateCensus(census) {
  if (!census || typeof census !== "object" || Array.isArray(census)) {
    block("census_not_object", censusPath || "");
    return {
      mechanisms: new Set(),
      cells: [],
      cellIds: new Set(),
      orphanCount: 0,
    };
  }

  check("census_truth", census.truth === "suite13_census", String(census.truth || ""));

  const sources = census.sources || {};
  check("source_a_ui_routes_present", nonEmptyArray(sources.A?.uiRoutes), "sources.A.uiRoutes");
  check("source_a_ui_api_calls_present", nonEmptyArray(sources.A?.uiApiCalls), "sources.A.uiApiCalls");
  check("source_b_http_routes_present", nonEmptyArray(sources.B?.httpRoutes), "sources.B.httpRoutes");
  check("source_b_has_ws_or_operator_client", nonEmptyArray(sources.B?.sealedWsMessages) || nonEmptyArray(sources.B?.operatorClientEndpoints), "sources.B.sealedWsMessages/operatorClientEndpoints");

  const mechanisms = stringSet(sources.C?.mechanisms);
  check("mechanism_family_count_19", mechanisms.size === 19, String(mechanisms.size));
  for (const mechanism of CANONICAL_MECHANISMS) {
    check(`mechanism_${mechanism}`, mechanisms.has(mechanism), mechanism);
    if (!mechanisms.has(mechanism)) block("missing_mechanism_family", mechanism);
  }

  const cells = array(census.cells);
  check("census_cells_present", cells.length > 0, String(cells.length));
  const cellIds = new Set();
  for (const [index, cell] of cells.entries()) {
    const id = typeof cell?.cellId === "string" ? cell.cellId : "";
    if (!id) {
      block("missing_cell_id", String(index));
      continue;
    }
    if (cellIds.has(id)) block("duplicate_cell_id", id);
    cellIds.add(id);
    for (const field of ["surface", "mechanism", "control", "lifecycleState"]) {
      if (typeof cell?.[field] !== "string" || cell[field].length === 0) {
        block("incomplete_census_cell", `${id}:${field}`);
      }
    }
    if (typeof cell?.mechanism === "string" && !mechanisms.has(cell.mechanism)) {
      block("cell_unknown_mechanism", `${id}:${cell.mechanism}`);
    }
  }

  const orphans = array(census.orphans);
  for (const [index, orphan] of orphans.entries()) {
    const id = typeof orphan?.id === "string" ? orphan.id : String(index);
    if (!ORPHAN_KINDS.has(orphan?.kind)) block("invalid_orphan_kind", `${id}:${String(orphan?.kind || "")}`);
    if (!NOT_COVERED_REASONS.has(orphan?.reason)) block("invalid_orphan_reason", `${id}:${String(orphan?.reason || "")}`);
    if (typeof orphan?.owningIssue !== "string" || orphan.owningIssue.length === 0) block("missing_orphan_owner", id);
  }

  return { mechanisms, cells, cellIds, orphanCount: orphans.length };
}

function validateLedger(ledger, cellIds) {
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) {
    block("ledger_not_object", ledgerPath || "");
    return { rowCount: 0 };
  }

  check("ledger_truth", ledger.truth === "suite13_coverage_ledger", String(ledger.truth || ""));

  const rows = array(ledger.rows);
  check("ledger_rows_present", rows.length > 0, String(rows.length));
  const rowIds = new Set();

  for (const [index, row] of rows.entries()) {
    const cellId = typeof row?.cellId === "string" ? row.cellId : "";
    if (!cellId) {
      block("missing_ledger_cell_id", String(index));
      continue;
    }
    if (rowIds.has(cellId)) block("duplicate_ledger_cell_id", cellId);
    rowIds.add(cellId);
    if (!cellIds.has(cellId)) block("ledger_unknown_cell", cellId);
    if (!CELL_STATUSES.has(row?.status)) block("invalid_cell_status", `${cellId}:${String(row?.status || "")}`);
    if (isBooleanEvidence(row?.evidenceRef)) block("boolean_evidence_ref", cellId);
    if (typeof row?.evidenceRef !== "string" || row.evidenceRef.length === 0) block("missing_evidence_ref", cellId);

    if (row?.status === "recorded-gap") {
      if (!NOT_COVERED_REASONS.has(row?.notCoveredReason)) {
        block("invalid_not_covered_reason", `${cellId}:${String(row?.notCoveredReason || "")}`);
      }
      if (typeof row?.owningIssue !== "string" || row.owningIssue.length === 0) {
        block("missing_gap_owner", cellId);
      }
    }
    if (row?.status === "exercised-green") {
      const assertions = Number(row?.assertionCount || 0);
      if (!Number.isInteger(assertions) || assertions <= 0) block("green_cell_without_assertions", cellId);
      if (row?.hubPosture === "mock" || row?.testOracle === true) block("green_cell_mock_or_test_oracle", cellId);
    }
  }

  for (const cellId of cellIds) {
    if (!rowIds.has(cellId)) block("missing_ledger_row", cellId);
  }
  for (const rowId of rowIds) {
    if (!cellIds.has(rowId)) block("extra_ledger_row", rowId);
  }

  return { rowCount: rows.length };
}

const census = readJson("census", censusPath);
const ledger = readJson("coverage-ledger", ledgerPath);
const censusStats = validateCensus(census);
const ledgerStats = validateLedger(ledger, censusStats.cellIds);
const status = blockers.length === 0 ? "passed" : "blocked";

const report = {
  truth: "suite13_coverage_oracle",
  status,
  generated_at_utc: new Date().toISOString(),
  inputs: {
    census: censusPath || null,
    coverageLedger: ledgerPath || null,
  },
  summary: {
    mechanismFamilyCount: censusStats.mechanisms.size,
    requiredMechanismFamilies: CANONICAL_MECHANISMS,
    notCoveredReasons: [...NOT_COVERED_REASONS],
    cellCount: censusStats.cells.length,
    ledgerRowCount: ledgerStats.rowCount,
    orphanCount: censusStats.orphanCount,
  },
  checks,
  blockers,
  caveat: "Suite-13 coverage oracle validation only. This is not END-BAR, organic usage, operator attestation, live product execution, or release proof.",
};

if (outPath) {
  const out = absolute(outPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify(report, null, 2));
process.exit(status === "passed" || !requirePassed ? 0 : 2);
