#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);

function arg(name) {
  const prefix = `--${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith(prefix)) return value.slice(prefix.length);
    if (value === `--${name}` && args[index + 1]) return args[index + 1];
  }
  return "";
}

function argsAll(name) {
  const prefix = `--${name}=`;
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith(prefix)) {
      values.push(value.slice(prefix.length));
    } else if (value === `--${name}` && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

function usage() {
  console.error(`usage:
  node scripts/ops/build-friday-uiux-product-blocker-satisfaction.mjs \\
    --head=<current-main-sha> --satisfaction-report=/abs/report.json [...] \\
    [--out=/abs/product-blocker-satisfaction.json] [--require-ready]

Truth: merges already-produced product blocker satisfaction manifests only when
they are ready, same-head, live-connected, current-head, and backed by allowed
evidence classes. This builder does not create product proof from partial
write/read artifacts, screenshots, offline evidence, fixtures, or stale reports.`);
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const currentHead = arg("head") || process.env.FRIDAY_UIUX_PRODUCT_SATISFACTION_HEAD || "";
const outPath = arg("out") || process.env.FRIDAY_UIUX_PRODUCT_SATISFACTION_OUT || "";
const requireReady = args.includes("--require-ready");
const inputReports = [
  ...argsAll("satisfaction-report"),
  ...(process.env.FRIDAY_UIUX_PRODUCT_SATISFACTION_REPORTS
    ? process.env.FRIDAY_UIUX_PRODUCT_SATISFACTION_REPORTS.split(/[:\n]/).filter(Boolean)
    : []),
];

const blockers = [];
const notes = [];

function abs(path) {
  return isAbsolute(path) ? path : resolve(path);
}

function block(code, detail) {
  blockers.push({ code, detail });
}

function note(code, detail) {
  notes.push({ code, detail });
}

function readJson(path) {
  const resolved = abs(path);
  try {
    return JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    block("input_unreadable", `${resolved}:${error.message}`);
    return null;
  }
}

function rowKey(row) {
  return [
    String(row?.surface || ""),
    String(row?.id || row?.destination || ""),
    String(row?.kind || row?.blockerKind || row?.blocker_kind || ""),
    String(row?.label || row?.blockerLabel || row?.blocker_label || ""),
  ].join("\u001f");
}

const allowedEvidenceClasses = new Set([
  "same_run_ui_device_product_proof",
  "operator_signed_approval_proof",
  "provider_credential_live_proof",
  "device_pairing_live_proof",
  "live_write_read_projection_proof",
  "memory_behavior_delta_proof",
  "channel_live_product_proof",
  "human_release_acceptance",
]);

const forbiddenTruth = /(partial|not[-_ ]?(?:endbar|proof|full[-_ ]?proof|product[-_ ]?proof|ui[-_ ]?device[-_ ]?proof)|design[-_ ]?proof|screenshot|mock|fixture|sample|dry[-_ ]?run|offline|unavailable|placeholder)/i;

function validateReport(report, source) {
  if (!report) return [];
  const rows = Array.isArray(report.satisfactions) ? report.satisfactions : [];
  const truth = String(report.truth || report.truth_label || report.truthLabel || "");
  if (!/blocker.*satisfaction/i.test(truth)) {
    block("input_truth_unexpected", `${source}:${truth || "missing"}`);
    return [];
  }
  if (report.status !== "ready") {
    block("input_not_ready", `${source}:${String(report.status || "missing")}`);
    return [];
  }
  if (!currentHead) {
    block("current_head_missing", source);
    return [];
  }
  if (String(report.head || "") !== currentHead) {
    block("input_head_mismatch", `${source}:${String(report.head || "missing")}`);
    return [];
  }
  if (rows.length === 0) {
    note("input_has_no_satisfactions", source);
  }
  return rows;
}

function validateRow(row, source, index) {
  const label = `${source}:satisfactions[${index}]`;
  const invalid = [];
  const evidenceClass = String(row?.evidenceClass || row?.evidence_class || "");
  const evidenceRefs = Array.isArray(row?.evidenceRefs)
    ? row.evidenceRefs
    : Array.isArray(row?.evidence_refs)
      ? row.evidence_refs
      : [];
  const truthLabels = Array.isArray(row?.evidenceTruthLabels)
    ? row.evidenceTruthLabels
    : Array.isArray(row?.evidence_truth_labels)
      ? row.evidence_truth_labels
      : [];
  if (row?.status !== "satisfied") invalid.push(`status=${String(row?.status || "missing")}`);
  if (!row?.surface) invalid.push("surface=missing");
  if (!row?.id && !row?.destination) invalid.push("id=missing");
  if (!row?.kind && !row?.blockerKind && !row?.blocker_kind) invalid.push("kind=missing");
  if (!row?.label && !row?.blockerLabel && !row?.blocker_label) invalid.push("label=missing");
  if (!allowedEvidenceClasses.has(evidenceClass)) invalid.push(`evidenceClass=${evidenceClass || "missing"}`);
  if (evidenceRefs.length === 0) invalid.push("evidenceRefs=missing");
  if (truthLabels.length === 0) invalid.push("evidenceTruthLabels=missing");
  for (const truthLabel of truthLabels) {
    if (forbiddenTruth.test(String(truthLabel || ""))) invalid.push(`forbiddenTruth=${truthLabel}`);
  }
  if (row?.sameRun !== true && row?.same_run !== true) invalid.push("sameRun=false");
  if (row?.liveConnected !== true && row?.live_connected !== true) invalid.push("liveConnected=false");
  if (row?.currentHead !== true && row?.current_head !== true) invalid.push("currentHead=false");
  if (invalid.length > 0) {
    block("row_invalid", `${label}:${invalid.join(",")}`);
    return null;
  }
  return row;
}

if (inputReports.length === 0) {
  block("input_reports_missing", "provide at least one --satisfaction-report");
}

const byKey = new Map();
const sources = [];
for (const input of inputReports) {
  const source = abs(input);
  sources.push(source);
  const report = readJson(source);
  const rows = validateReport(report, source);
  rows.forEach((row, index) => {
    const valid = validateRow(row, source, index);
    if (!valid) return;
    const key = rowKey(valid);
    if (!byKey.has(key)) byKey.set(key, valid);
  });
}

if (byKey.size === 0) {
  block("no_valid_satisfactions", "no rows survived validation");
}

const output = {
  truth: "uiux_product_blocker_satisfaction_manifest",
  status: blockers.length === 0 ? "ready" : "not_ready",
  head: currentHead,
  sources,
  counts: {
    inputReports: sources.length,
    satisfactions: byKey.size,
  },
  satisfactions: [...byKey.values()],
  blockers,
  notes,
  caveat:
    "Builder output only merges same-head, ready blocker-satisfaction rows. It does not weaken END-BAR, mint proof, or convert partial evidence into product UI/device proof.",
};

if (outPath) {
  const out = abs(outPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(output, null, 2)}\n`);
}

console.log(JSON.stringify(output, null, 2));
process.exit(requireReady && blockers.length > 0 ? 1 : 0);
