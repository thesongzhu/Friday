#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/build-friday-uiux-runtime-blocker-satisfaction.mjs \\
    --head=<current-head> \\
    --action-traceability-report=/abs/action-traceability.json \\
    --ui-device-proof=/abs/strict-ui-device-proof.json \\
    [--ui-device-evidence-dir=/abs/rebuilt-capture-dir] \\
    [--out=/abs/runtime-blocker-satisfaction.json] [--require-ready]

Truth:
  Builds ProductReadinessContract blocker-satisfaction rows only for residual
  needsRuntimeEvidence blockers whose runtime actions are fully covered and
  whose run has a strict same-run UI/device proof. It does not satisfy signature,
  provider-credential, release, adoption, or human-polish blockers, and it does
  not convert partial/screenshot/fixture evidence into END-BAR.`);
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

const head = arg("head") || process.env.FRIDAY_UIUX_RUNTIME_BLOCKER_SATISFACTION_HEAD || "";
const tracePath = arg("action-traceability-report") || process.env.FRIDAY_UIUX_ACTION_TRACEABILITY_REPORT || "";
const uiDeviceProofPath = arg("ui-device-proof") || process.env.FRIDAY_UI_DEVICE_PROOF_REPORT || "";
const uiDeviceEvidenceDir = arg("ui-device-evidence-dir") || process.env.FRIDAY_UI_DEVICE_EVIDENCE_DIR || "";
const outPath = arg("out") || process.env.FRIDAY_UIUX_RUNTIME_BLOCKER_SATISFACTION_OUT || "";
const requireReady = args.includes("--require-ready");
const blockers = [];
const notes = [];
const forbiddenOverlayTruth = /(partial|not[-_ ]?live|not[-_ ]?sim[-_ ]?tap|not[-_ ]?ui[-_ ]?device[-_ ]?proof|design[-_ ]?proof|screenshot|mock|fixture|sample|dry[-_ ]?run|offline|unavailable|placeholder)/i;

function abs(path) {
  return isAbsolute(path) ? path : resolve(path);
}

function block(code, detail) {
  blockers.push({ code, detail });
}

function note(code, detail) {
  notes.push({ code, detail });
}

function requireFile(label, path) {
  if (!path) {
    block("missing_arg", label);
    return "";
  }
  const resolved = abs(path);
  try {
    const stats = statSync(resolved);
    if (!stats.isFile()) block("not_file", `${label}:${resolved}`);
    if (stats.size <= 0) block("empty_file", `${label}:${resolved}`);
  } catch {
    block("unreadable_file", `${label}:${resolved}`);
  }
  return resolved;
}

function readJson(label, path) {
  const file = requireFile(label, path);
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    block("invalid_json", `${label}:${file}:${error.message}`);
    return null;
  }
}

function requireEvidenceDir(path) {
  if (!path) return { dir: "", refs: [] };
  const dir = abs(path);
  try {
    if (!statSync(dir).isDirectory()) {
      block("evidence_dir_not_directory", dir);
      return { dir, refs: [] };
    }
  } catch {
    block("evidence_dir_unreadable", dir);
    return { dir, refs: [] };
  }
  const expected = [
    "gap-report.json",
    "observations-manifest.json",
    "mobile.json",
    "desktop.json",
    "timeline.json",
  ];
  const refs = [];
  for (const relative of expected) {
    const file = resolve(dir, relative);
    if (!existsSync(file)) {
      block("evidence_file_missing", file);
      continue;
    }
    refs.push(file);
  }
  const eventFile = ["same-run-events.with-channel.jsonl", "same-run-events.normalized.jsonl"]
    .map((relative) => resolve(dir, relative))
    .find((file) => existsSync(file));
  if (!eventFile) {
    block("evidence_file_missing", `${resolve(dir, "same-run-events.with-channel.jsonl")} or ${resolve(dir, "same-run-events.normalized.jsonl")}`);
  } else {
    refs.push(eventFile);
  }
  const gapReportPath = resolve(dir, "gap-report.json");
  if (existsSync(gapReportPath)) {
    const gapReport = readJson("ui-device-gap-report", gapReportPath);
    const gapBlockers = Array.isArray(gapReport?.blockers) ? gapReport.blockers : [];
    if (gapBlockers.length > 0) block("ui_device_gap_report_has_blockers", JSON.stringify(gapBlockers.slice(0, 10)));
    if (gapReport?.status && !["pass", "ready", "gaps_present", "complete_inputs_observed"].includes(String(gapReport.status))) {
      block("ui_device_gap_report_status_unexpected", String(gapReport.status));
    }
  }
  return { dir, refs };
}

function hasStrictUiDeviceProof(value) {
  if (value?.truth === "assembled_real_ui_device_proof" && value?.status === "pass") return true;
  if (value?.proof !== "mission_spine_ui_device_consumption") return false;
  if (!String(value?.mission_id || "").toLowerCase().includes("mission")) return false;
  if (!Array.isArray(value?.observations) || value.observations.length < 1) return false;
  if (!Array.isArray(value?.negative_control_segments) || value.negative_control_segments.length < 1) return false;
  return true;
}

function containsHead(value, expectedHead) {
  if (!expectedHead) return false;
  const full = String(expectedHead);
  const short = full.slice(0, 8);
  const stack = [value];
  const seen = new Set();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current == null) continue;
    if (typeof current === "string" || typeof current === "number" || typeof current === "boolean") {
      const text = String(current);
      if (text.includes(full) || (short.length >= 8 && text.includes(short))) return true;
      continue;
    }
    if (typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (/^(head|gitHead|sourceHead|mainHead|commit|commitSha|sha)$/i.test(key)) {
        const text = String(child || "");
        if (text.includes(full) || (short.length >= 8 && text.includes(short))) return true;
      }
      stack.push(child);
    }
  }
  return false;
}

function arrayAt(value, path) {
  let current = value;
  for (const key of path) current = current?.[key];
  return Array.isArray(current) ? current : [];
}

function rowKey(row) {
  return [
    String(row?.surface || ""),
    String(row?.id || row?.destination || ""),
    String(row?.kind || row?.blockerKind || ""),
    String(row?.label || row?.blockerLabel || ""),
  ].join("\u001f");
}

function safePathSegment(value) {
  return String(value || "unknown")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "unknown";
}

function proofArtifactRoot() {
  if (outPath) return dirname(abs(outPath));
  if (traceRef) return dirname(traceRef);
  if (proofRef) return dirname(proofRef);
  return resolve(process.cwd());
}

function refForProofArtifact(path) {
  if (!outPath) return path;
  return relative(dirname(abs(outPath)), path);
}

function writeSatisfactionProofArtifact(item, sourceEvidenceRefs) {
  const proofDir = resolve(proofArtifactRoot(), "runtime-blocker-satisfaction-proofs");
  const file = resolve(proofDir, [
    safePathSegment(item.surface),
    safePathSegment(item.id),
    safePathSegment(item.kind),
  ].join("__") + ".json");
  const proof = {
    truth: "same_run_ui_device_product_proof",
    status: "ready",
    head,
    surface: item.surface,
    id: item.id,
    kind: item.kind,
    label: item.label,
    sameRun: true,
    liveConnected: true,
    currentHead: true,
    evidenceClass: item.evidenceClass,
    evidenceTruthLabels: item.evidenceTruthLabels,
    sourceEvidenceRefs,
    caveat:
      "This artifact is the local, row-scoped proof reference for blocker satisfaction. Source refs are retained here for audit; the satisfaction row points here so downstream gates can validate one same-blocker proof file.",
  };
  try {
    mkdirSync(proofDir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(proof, null, 2)}\n`);
    return refForProofArtifact(file);
  } catch (error) {
    block("satisfaction_proof_artifact_write_failed", `${file}:${error.message}`);
    return "";
  }
}

function residualRows(trace) {
  const rows = [];
  for (const destination of arrayAt(trace, ["gaps", "residualEndBarBlockers"])) {
    const overlay = destination?.evidenceOverlay || {};
    for (const blocker of Array.isArray(destination?.blockers) ? destination.blockers : []) {
      rows.push({
        surface: String(destination?.surface || ""),
        id: String(destination?.id || destination?.destination || ""),
        title: String(destination?.title || ""),
        tier: String(destination?.tier || ""),
        kind: String(blocker?.kind || ""),
        label: String(blocker?.label || ""),
        evidenceOverlay: overlay,
      });
    }
  }
  return rows;
}

function destinationForRow(trace, row) {
  return (Array.isArray(trace?.destinations) ? trace.destinations : [])
    .find((destination) =>
      String(destination?.surface || "") === row.surface
      && String(destination?.id || destination?.destination || "") === row.id);
}

function isCleanRuntimeTruth(truthLabel) {
  const value = String(truthLabel || "");
  return value.length > 0 && !forbiddenOverlayTruth.test(value);
}

function cleanActionCoverage(trace, row) {
  const destination = destinationForRow(trace, row);
  const actionTrace = Array.isArray(destination?.actionTrace) ? destination.actionTrace : [];
  if (actionTrace.length === 0) return null;

  const missing = [];
  const evidenceRefs = [];
  const cleanTruthLabels = [];
  for (const action of actionTrace) {
    const labels = Array.isArray(action?.evidenceTruthLabels) ? action.evidenceTruthLabels : [];
    const cleanLabels = labels.filter(isCleanRuntimeTruth);
    if (action?.runtimeEvidenceMatched !== true || cleanLabels.length === 0) {
      missing.push({
        runtimeActionId: String(action?.runtimeActionId || ""),
        runtimeEvidenceMatched: action?.runtimeEvidenceMatched === true,
        evidenceTruthLabels: labels,
      });
      continue;
    }
    evidenceRefs.push(...(Array.isArray(action?.evidenceRefs) ? action.evidenceRefs.filter(Boolean) : []));
    cleanTruthLabels.push(...cleanLabels);
  }
  return {
    ok: missing.length === 0,
    missing,
    evidenceRefs: [...new Set(evidenceRefs)],
    cleanTruthLabels: [...new Set(cleanTruthLabels)],
  };
}

const trace = readJson("action-traceability-report", tracePath);
const uiDeviceProof = readJson("ui-device-proof", uiDeviceProofPath);
const uiDeviceEvidence = requireEvidenceDir(uiDeviceEvidenceDir);

if (!head) block("head_missing", "provide --head");
if (trace?.status !== "product_runtime_actions_traceable") {
  block("action_traceability_not_product_runtime_traceable", String(trace?.status || "missing"));
}
if ((trace?.counts?.productActionsMissingRuntimeEvidence ?? 0) !== 0) {
  block("product_actions_missing_runtime_evidence", String(trace?.counts?.productActionsMissingRuntimeEvidence));
}
if ((trace?.counts?.runtimeEvidenceInputs ?? 0) <= 0) {
  block("runtime_evidence_inputs_missing", String(trace?.counts?.runtimeEvidenceInputs ?? 0));
}
if (!hasStrictUiDeviceProof(uiDeviceProof)) {
  block("ui_device_proof_not_strict_pass", `${String(uiDeviceProof?.truth || uiDeviceProof?.proof || "missing")}:${String(uiDeviceProof?.status || "missing")}`);
}
if (head && !containsHead(uiDeviceProof, head)) {
  block("ui_device_proof_head_mismatch", `expected current head ${head} in strict UI/device proof`);
}

const proofRef = uiDeviceProofPath ? abs(uiDeviceProofPath) : "";
const traceRef = tracePath ? abs(tracePath) : "";
const evidenceRefs = [
  proofRef,
  traceRef,
  ...uiDeviceEvidence.refs,
].filter(Boolean);

const satisfactions = [];
const skippedRows = [];
const byKey = new Map();
for (const row of residualRows(trace)) {
  const overlay = row.evidenceOverlay || {};
  if (row.kind !== "needsRuntimeEvidence") {
    skippedRows.push({ ...row, reason: "non_runtime_blocker" });
    continue;
  }
  const actionCoverage = cleanActionCoverage(trace, row);
  if (actionCoverage && !actionCoverage.ok) {
    skippedRows.push({
      ...row,
      reason: `runtime_action_clean_coverage_missing:${JSON.stringify(actionCoverage.missing.slice(0, 8))}`,
    });
    continue;
  }
  if (overlay.status !== "runtime_action_evidence_attached_not_endbar") {
    skippedRows.push({ ...row, reason: `runtime_overlay_not_fully_covered:${String(overlay.status || "missing")}` });
    continue;
  }
  if ((overlay.runtimeActionCount ?? 0) <= 0 || overlay.runtimeActionsMissing !== 0) {
    skippedRows.push({ ...row, reason: "runtime_action_counts_not_fully_covered" });
    continue;
  }
  const overlayTruthLabels = Array.isArray(overlay.evidenceTruthLabels) ? overlay.evidenceTruthLabels : [];
  const forbiddenTruthLabel = overlayTruthLabels.find((truthLabel) => forbiddenOverlayTruth.test(String(truthLabel || "")));
  if (!actionCoverage && forbiddenTruthLabel) {
    skippedRows.push({ ...row, reason: `runtime_overlay_truth_forbidden:${String(forbiddenTruthLabel)}` });
    continue;
  }
  const sourceEvidenceRefs = [...new Set([
    ...evidenceRefs,
    ...((actionCoverage?.evidenceRefs || []).filter(Boolean)),
    ...((Array.isArray(overlay.evidenceRefs) ? overlay.evidenceRefs : []).filter(Boolean)),
  ])];
  const item = {
    surface: row.surface,
    id: row.id,
    kind: row.kind,
    label: row.label,
    status: "satisfied",
    evidenceClass: "same_run_ui_device_product_proof",
    evidenceTruthLabels: ["assembled_real_ui_device_proof_same_run_live_connected_current_head"],
    sameRun: true,
    liveConnected: true,
    currentHead: true,
    caveat:
      "This row satisfies a needsRuntimeEvidence ProductReadinessContract residual only when paired with strict same-run UI/device proof and full action-runtime coverage; it does not claim adoption or public release.",
  };
  item.evidenceRefs = [writeSatisfactionProofArtifact(item, sourceEvidenceRefs)].filter(Boolean);
  const key = rowKey(item);
  if (!byKey.has(key)) {
    byKey.set(key, true);
    satisfactions.push(item);
  }
}

if (satisfactions.length === 0) {
  block("no_runtime_blocker_satisfactions", "no residual needsRuntimeEvidence row had full runtime coverage plus strict UI/device proof");
}
if (skippedRows.length > 0) {
  note("skipped_residual_rows", JSON.stringify(skippedRows.map(({ evidenceOverlay, ...row }) => row).slice(0, 20)));
}

const output = {
  truth: "uiux_runtime_blocker_satisfaction_manifest",
  status: blockers.length === 0 ? "ready" : "not_ready",
  head,
  sources: {
    actionTraceabilityReport: traceRef || null,
    uiDeviceProof: proofRef || null,
    uiDeviceEvidenceDir: uiDeviceEvidence.dir || null,
  },
  counts: {
    residualRows: residualRows(trace).length,
    satisfactions: satisfactions.length,
    skippedRows: skippedRows.length,
  },
  satisfactions,
  skippedRows,
  blockers,
  notes,
  caveat:
    "Runtime blocker satisfaction is a strict bridge from current-head action traceability plus assembled real UI/device proof into the product happy-path gate. It does not weaken END-BAR, release, adoption, signature, provider, or semantic non-runtime gates.",
};

if (outPath) {
  const out = abs(outPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(output, null, 2)}\n`);
}

console.log(JSON.stringify(output, null, 2));
process.exit(requireReady && blockers.length > 0 ? 1 : 0);
