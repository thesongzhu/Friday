#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/check-friday-uiux-product-happy-path.mjs \\
    [--repo-root=/abs/repo] [--design-root=/abs/friday-design-handoff-20260602] \\
    [--selected-visual-report=/abs/selected-visual-proof.json] \\
    [--action-traceability-report=/abs/uiux-action-traceability.json] \\
    [--blocker-satisfaction-report=/abs/product-blocker-satisfaction.json] \\
    [--evidence-dir=/abs/evidence ...] [--runtime-evidence-dir=/abs/runtime-evidence ...] \\
    [--runtime-evidence=/abs/action-runtime-evidence.json ...] [--out=/abs/report.json] \\
    [--require-complete]

Truth: verifies whether current evidence is strong enough to call the selected
mobile+desktop UI a normal connected product happy path. It is intentionally
stricter than selected visual proof or action traceability. Design-only samples,
offline negative controls, AX-only visibility, missing runtime evidence, and
residual ProductReadinessContract blockers cannot satisfy this gate.`);
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

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const repoRoot = resolve(arg("repo-root") || process.env.FRIDAY_REPO_ROOT || new URL("../..", import.meta.url).pathname);
const designRoot = resolve(
  arg("design-root") ||
  process.env.FRIDAY_DESIGN_HANDOFF_ROOT ||
  `${process.env.HOME || process.env.USERPROFILE || "."}/Desktop/friday-design-handoff-20260602`,
);
const outPath = arg("out") || process.env.FRIDAY_UIUX_PRODUCT_HAPPY_PATH_REPORT || "";
const requireComplete = args.includes("--require-complete");
const selectedVisualReportPath = arg("selected-visual-report") || process.env.FRIDAY_UIUX_SELECTED_VISUAL_PROOF_REPORT || "";
const actionTraceabilityReportPath = arg("action-traceability-report") || process.env.FRIDAY_UIUX_ACTION_TRACEABILITY_REPORT || "";
const blockerSatisfactionReportPath = arg("blocker-satisfaction-report") || process.env.FRIDAY_UIUX_BLOCKER_SATISFACTION_REPORT || "";
const evidenceDirs = [
  ...argsAll("evidence-dir"),
  ...(process.env.FRIDAY_UIUX_HAPPY_PATH_EVIDENCE_DIRS
    ? process.env.FRIDAY_UIUX_HAPPY_PATH_EVIDENCE_DIRS.split(/[:\n]/).filter(Boolean)
    : []),
];
const runtimeEvidenceDirs = [
  ...argsAll("runtime-evidence-dir"),
  ...(process.env.FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE_DIRS
    ? process.env.FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE_DIRS.split(/[:\n]/).filter(Boolean)
    : []),
];
const runtimeEvidence = [
  ...argsAll("runtime-evidence"),
  ...(process.env.FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE
    ? process.env.FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE.split(/[:\n]/).filter(Boolean)
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

function readJson(path, label) {
  const resolved = abs(path);
  try {
    return JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    block("json_unreadable", `${label}:${resolved}:${error.message}`);
    return null;
  }
}

function parseJsonFromOutput(text, label) {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    block(`${label}_invalid_json`, "stdout did not contain a parseable JSON object");
    return null;
  }
}

function runJson(label, commandArgs) {
  const result = spawnSync(process.execPath, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const parsed = parseJsonFromOutput(result.stdout, label);
  if ((result.status ?? 1) !== 0) {
    block(`${label}_failed`, String(result.status ?? 1));
  }
  return {
    label,
    exitCode: result.status ?? 1,
    parsed,
    stderr: (result.stderr || "").trim(),
  };
}

function selectedVisualReport() {
  if (selectedVisualReportPath) {
    return {
      source: abs(selectedVisualReportPath),
      parsed: readJson(selectedVisualReportPath, "selected-visual-report"),
      exitCode: 0,
    };
  }
  const commandArgs = [
    resolve(repoRoot, "scripts/ops/check-friday-uiux-selected-visual-proof.mjs"),
    `--repo-root=${repoRoot}`,
    `--design-root=${designRoot}`,
  ];
  for (const dir of evidenceDirs) commandArgs.push(`--evidence-dir=${abs(dir)}`);
  return { source: "generated", ...runJson("selected_visual_proof", commandArgs) };
}

function actionTraceabilityReport() {
  if (actionTraceabilityReportPath) {
    return {
      source: abs(actionTraceabilityReportPath),
      parsed: readJson(actionTraceabilityReportPath, "action-traceability-report"),
      exitCode: 0,
    };
  }
  const commandArgs = [
    resolve(repoRoot, "scripts/ops/check-friday-uiux-action-traceability.mjs"),
    `--repo-root=${repoRoot}`,
    `--design-root=${designRoot}`,
    "--compact",
  ];
  for (const dir of evidenceDirs) commandArgs.push(`--evidence-dir=${abs(dir)}`);
  for (const dir of runtimeEvidenceDirs) commandArgs.push(`--runtime-evidence-dir=${abs(dir)}`);
  for (const evidence of runtimeEvidence) commandArgs.push(`--runtime-evidence=${abs(evidence)}`);
  return { source: "generated", ...runJson("action_traceability", commandArgs) };
}

function numberAt(value, path, fallback = 0) {
  let current = value;
  for (const key of path) current = current?.[key];
  return typeof current === "number" ? current : fallback;
}

function arrayAt(value, path) {
  let current = value;
  for (const key of path) current = current?.[key];
  return Array.isArray(current) ? current : [];
}

const liveConnectedVisualModes = new Set([
  "live-loopback",
  "real-device-live",
  "product-live",
  "same-run-live",
  "served-ui-current-head",
]);

function servedUiDesktopVisualEntries(report) {
  return arrayAt(report, ["evidence", "servedUi"])
    .filter((item) =>
      item?.status === "ready"
      && item?.sourceStatus === "served_desktop_dist_ui_and_ios_source"
      && item?.checks?.renderedDesktop === true
      && item?.checks?.builtCss === true)
    .map((item) => ({
      ...item,
      mode: "served-ui-current-head",
    }));
}

function visualEvidenceEntriesForSurface(report, surface) {
  const entries = arrayAt(report, ["evidence", surface]);
  if (surface !== "desktop") return entries;
  return [
    ...entries,
    ...arrayAt(report, ["evidence", "desktopAggregates"]),
    ...servedUiDesktopVisualEntries(report),
  ];
}

function liveEvidenceForSurface(report, surface) {
  const entries = visualEvidenceEntriesForSurface(report, surface);
  return entries.filter((item) => item?.status === "ready" && liveConnectedVisualModes.has(String(item?.mode || "")));
}

function visualModesForSurface(report, surface) {
  return visualEvidenceEntriesForSurface(report, surface)
    .map((item) => String(item?.mode || ""))
    .filter(Boolean);
}

const negativeLabelValues = new Set(["offline", "stale", "error", "unavailable", "disabled"]);
const labelKeys = new Set([
  "statusLabels",
  "status_labels",
  "visibleLabels",
  "visible_labels",
  "labels",
  "badges",
  "chips",
]);

function collectNegativeLabels(value, path = []) {
  const found = [];
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      found.push(...collectNegativeLabels(value[index], [...path, String(index)]));
    }
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (labelKeys.has(key) && Array.isArray(child)) {
      for (const label of child) {
        const normalized = String(label || "").toLowerCase();
        if (negativeLabelValues.has(normalized)) {
          found.push({ path: nextPath.join("."), label: normalized });
        }
      }
    }
    found.push(...collectNegativeLabels(child, nextPath));
  }
  return found;
}

function summarizeTrace(report) {
  const missingRuntime = numberAt(report, ["counts", "productActionsMissingRuntimeEvidence"]);
  const residualBlockers = numberAt(report, ["counts", "destinationsWithResidualEndBarBlockers"],
    numberAt(report, ["counts", "destinationsStillBlocked"]));
  const runtimeEvidenceInputs = numberAt(report, ["counts", "runtimeEvidenceInputs"]);
  const status = String(report?.status || "missing");
  return {
    status,
    runtimeEvidenceInputs,
    productActionsMissingRuntimeEvidence: missingRuntime,
    destinationsWithResidualEndBarBlockers: residualBlockers,
    bySurface: report?.bySurface || null,
  };
}

function residualBlockers(report) {
  return arrayAt(report, ["gaps", "residualEndBarBlockers"]);
}

function residualBlockerRows(report) {
  const rows = [];
  for (const destination of residualBlockers(report)) {
    for (const blocker of arrayAt(destination, ["blockers"])) {
      const row = {
        surface: String(destination.surface || ""),
        id: String(destination.id || destination.destination || ""),
        title: String(destination.title || ""),
        kind: String(blocker.kind || ""),
        label: String(blocker.label || ""),
      };
      rows.push({
        ...row,
        key: blockerKey(row),
      });
    }
  }
  return rows;
}

function blockerKey(blocker) {
  return [
    String(blocker?.surface || ""),
    String(blocker?.id || blocker?.destination || ""),
    String(blocker?.kind || blocker?.blockerKind || ""),
    String(blocker?.label || blocker?.blockerLabel || ""),
  ].join("\u001f");
}

function residualBlockerKeys(report) {
  return residualBlockerRows(report).map((row) => row.key);
}

const allowedSatisfactionClasses = new Set([
  "same_run_ui_device_product_proof",
  "operator_signed_approval_proof",
  "provider_credential_live_proof",
  "device_pairing_live_proof",
  "live_write_read_projection_proof",
  "memory_behavior_delta_proof",
  "channel_live_product_proof",
  "human_release_acceptance",
]);
const forbiddenSatisfactionTruth = /(partial|not[-_ ]?(?:endbar|proof|full[-_ ]?proof|product[-_ ]?proof|ui[-_ ]?device[-_ ]?proof)|design[-_ ]?proof|screenshot|mock|fixture|sample|dry[-_ ]?run|offline|unavailable|placeholder)/i;

function satisfactionRows(report) {
  if (!report) return [];
  if (Array.isArray(report.satisfactions)) return report.satisfactions;
  if (Array.isArray(report.blockers)) return report.blockers;
  return [];
}

function blockerEvidenceValue(value, names) {
  for (const name of names) {
    if (typeof value?.[name] === "string") return value[name];
  }
  return "";
}

function boolValue(value, names) {
  for (const name of names) {
    if (typeof value?.[name] === "boolean") return value[name];
  }
  return false;
}

function proofTruthLabels(proof) {
  return [
    proof?.truth,
    proof?.truthLabel,
    proof?.truth_label,
    ...(Array.isArray(proof?.evidenceTruthLabels) ? proof.evidenceTruthLabels : []),
    ...(Array.isArray(proof?.evidence_truth_labels) ? proof.evidence_truth_labels : []),
  ]
    .map((value) => String(value || ""))
    .filter(Boolean);
}

function readProofJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function validateSatisfactionEvidenceRefs(evidenceRefs, row, label, baseDir) {
  const invalid = [];
  for (const [refIndex, ref] of evidenceRefs.entries()) {
    const refLabel = `${label}.evidenceRefs[${refIndex}]`;
    const raw = String(ref || "");
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      invalid.push({ code: "satisfaction_evidence_ref_not_file", detail: `${refLabel}:${raw || "missing"}` });
      continue;
    }
    const resolved = isAbsolute(raw) ? raw : resolve(baseDir, raw);
    if (!existsSync(resolved)) {
      invalid.push({ code: "satisfaction_evidence_ref_missing", detail: `${refLabel}:${resolved}` });
      continue;
    }
    const proof = readProofJson(resolved);
    if (!proof || typeof proof !== "object") {
      invalid.push({ code: "satisfaction_evidence_ref_invalid_json", detail: `${refLabel}:${resolved}` });
      continue;
    }
    const status = String(proof.status || "");
    if (!["ready", "pass", "passed", "satisfied"].includes(status)) {
      invalid.push({ code: "satisfaction_evidence_ref_not_ready", detail: `${refLabel}:${status || "missing"}` });
    }
    const truthLabels = proofTruthLabels(proof);
    if (truthLabels.length === 0) {
      invalid.push({ code: "satisfaction_evidence_ref_truth_missing", detail: refLabel });
    }
    for (const truthLabel of truthLabels) {
      if (forbiddenSatisfactionTruth.test(truthLabel)) {
        invalid.push({ code: "satisfaction_evidence_ref_truth_forbidden", detail: `${refLabel}:${truthLabel}` });
      }
    }
    if (boolValue(proof, ["sameRun", "same_run"]) !== true) invalid.push({ code: "satisfaction_evidence_ref_not_same_run", detail: refLabel });
    if (boolValue(proof, ["liveConnected", "live_connected"]) !== true) invalid.push({ code: "satisfaction_evidence_ref_not_live_connected", detail: refLabel });
    if (boolValue(proof, ["currentHead", "current_head"]) !== true) invalid.push({ code: "satisfaction_evidence_ref_not_current_head", detail: refLabel });
    const proofKey = blockerKey({
      surface: blockerEvidenceValue(proof, ["surface"]),
      id: blockerEvidenceValue(proof, ["id", "destination"]),
      kind: blockerEvidenceValue(proof, ["kind", "blockerKind", "blocker_kind"]),
      label: blockerEvidenceValue(proof, ["label", "blockerLabel", "blocker_label"]),
    });
    if (proofKey !== blockerKey(row)) {
      invalid.push({ code: "satisfaction_evidence_ref_scope_mismatch", detail: refLabel });
    }
  }
  return invalid;
}

function blockerSatisfactionReport() {
  if (!blockerSatisfactionReportPath) {
    return {
      source: null,
      parsed: null,
      status: "not_supplied",
      satisfiedKeys: new Set(),
      invalid: [],
    };
  }
  const parsed = readJson(blockerSatisfactionReportPath, "blocker-satisfaction-report");
  const invalid = [];
  const satisfiedKeys = new Set();
  const baseDir = dirname(abs(blockerSatisfactionReportPath));
  const truth = String(parsed?.truth || parsed?.truth_label || parsed?.truthLabel || "");
  if (parsed?.status !== "ready") invalid.push({ code: "satisfaction_report_not_ready", detail: String(parsed?.status || "missing") });
  if (!/blocker.*satisfaction/i.test(truth)) invalid.push({ code: "satisfaction_truth_unexpected", detail: truth || "missing" });

  for (const [index, row] of satisfactionRows(parsed).entries()) {
    const label = `satisfactions[${index}]`;
    const status = String(row?.status || "");
    const evidenceClass = String(row?.evidenceClass || row?.evidence_class || "");
    const evidenceRefs = Array.isArray(row?.evidenceRefs)
      ? row.evidenceRefs
      : Array.isArray(row?.evidence_refs)
        ? row.evidence_refs
        : [];
    const evidenceTruthLabels = Array.isArray(row?.evidenceTruthLabels)
      ? row.evidenceTruthLabels
      : Array.isArray(row?.evidence_truth_labels)
        ? row.evidence_truth_labels
        : [];
    if (status !== "satisfied") invalid.push({ code: "satisfaction_row_not_satisfied", detail: `${label}:${status || "missing"}` });
    if (!allowedSatisfactionClasses.has(evidenceClass)) invalid.push({ code: "satisfaction_evidence_class_not_allowed", detail: `${label}:${evidenceClass || "missing"}` });
    if (evidenceRefs.length === 0) invalid.push({ code: "satisfaction_evidence_refs_missing", detail: label });
    for (const truthLabel of evidenceTruthLabels) {
      if (forbiddenSatisfactionTruth.test(String(truthLabel || ""))) {
        invalid.push({ code: "satisfaction_evidence_truth_forbidden", detail: `${label}:${truthLabel}` });
      }
    }
    if (row?.sameRun !== true && row?.same_run !== true) invalid.push({ code: "satisfaction_not_same_run", detail: label });
    if (row?.liveConnected !== true && row?.live_connected !== true) invalid.push({ code: "satisfaction_not_live_connected", detail: label });
    if (row?.currentHead !== true && row?.current_head !== true) invalid.push({ code: "satisfaction_not_current_head", detail: label });
    invalid.push(...validateSatisfactionEvidenceRefs(evidenceRefs, row, label, baseDir));
    if (invalid.length === 0 || invalid.every((item) => !String(item.detail || "").startsWith(label))) {
      satisfiedKeys.add(blockerKey({
        surface: row?.surface,
        id: row?.id || row?.destination,
        kind: row?.kind || row?.blockerKind || row?.blocker_kind,
        label: row?.label || row?.blockerLabel || row?.blocker_label,
      }));
    }
  }

  return {
    source: abs(blockerSatisfactionReportPath),
    parsed,
    status: invalid.length === 0 ? "ready" : "invalid",
    satisfiedKeys,
    invalid,
  };
}

const selected = selectedVisualReport();
const trace = actionTraceabilityReport();
const satisfaction = blockerSatisfactionReport();
const selectedReport = selected.parsed || {};
const traceReport = trace.parsed || {};
const traceSummary = summarizeTrace(traceReport);
const residualRows = residualBlockerRows(traceReport);
const residualKeys = residualBlockerKeys(traceReport);
const unsatisfiedResidualKeys = residualKeys.filter((key) => !satisfaction.satisfiedKeys.has(key));
const unsatisfiedResidualRows = residualRows.filter((row) => !satisfaction.satisfiedKeys.has(row.key));
const residualBlockerCount = Math.max(traceSummary.destinationsWithResidualEndBarBlockers, residualKeys.length);
const unsatisfiedResidualBlockerCount = residualKeys.length > 0
  ? unsatisfiedResidualKeys.length
  : traceSummary.destinationsWithResidualEndBarBlockers;
const liveIos = liveEvidenceForSurface(selectedReport, "ios");
const liveDesktop = liveEvidenceForSurface(selectedReport, "desktop");
const mobileModes = visualModesForSurface(selectedReport, "ios");
const desktopModes = visualModesForSurface(selectedReport, "desktop");
const negativeLabels = collectNegativeLabels({
  selectedVisualEvidence: selectedReport?.evidence,
  actionTraceabilityEvidence: traceReport?.residualEndBarEvidence,
});

if (selectedReport.status !== "selected_visual_proof_ready") {
  block("selected_visual_proof_not_ready", selectedReport.status || "missing");
}
if (liveIos.length === 0) {
  block("mobile_visual_not_live_connected", mobileModes.length > 0
    ? `modes=${mobileModes.join(",")}`
    : "no iOS visual evidence modes found");
}
if (liveDesktop.length === 0) {
  block("desktop_visual_not_live_connected", desktopModes.length > 0
    ? `modes=${desktopModes.join(",")}`
    : "no desktop visual evidence modes found");
}
if (mobileModes.includes("offline-truth")) {
  block("offline_truth_negative_control_present", "offline-truth is valid negative control but cannot count toward product happy path");
}
if (mobileModes.length > 0 && mobileModes.every((mode) => mode === "design-proof-sample")) {
  block("design_proof_sample_only", "design-proof-sample is selected visual comparison only, not live connected product proof");
}
if (traceSummary.status !== "product_runtime_actions_traceable") {
  block("product_runtime_actions_not_traceable", traceSummary.status);
}
if (traceSummary.runtimeEvidenceInputs === 0) {
  block("runtime_evidence_inputs_missing", "same-run action runtime evidence is required for product happy path");
}
if (traceSummary.productActionsMissingRuntimeEvidence > 0) {
  block("product_runtime_actions_missing_evidence", String(traceSummary.productActionsMissingRuntimeEvidence));
}
if (satisfaction.invalid.length > 0) {
  block("blocker_satisfaction_report_invalid", JSON.stringify(satisfaction.invalid.slice(0, 20)));
}
if (unsatisfiedResidualBlockerCount > 0) {
  block("residual_endbar_blockers_present", String(unsatisfiedResidualBlockerCount));
}
if (negativeLabels.length > 0) {
  block("negative_happy_path_labels_present", JSON.stringify(negativeLabels.slice(0, 20)));
}

if (selectedReport.status === "selected_visual_proof_ready" && (liveIos.length === 0 || liveDesktop.length === 0)) {
  note("selected_visual_ready_but_not_product_live", "visual proof is ready, but live connected mobile+desktop evidence was not supplied");
}
if (traceSummary.status === "traceability_gaps_present") {
  note("traceability_gaps_are_product_gaps", "do not report selected UI/product maturity as done until runtime evidence and residual blockers are closed");
}

const report = {
  truth: "uiux_product_happy_path_gate_not_design_only_not_offline_not_endbar_until_runtime_closure",
  status: blockers.length === 0 ? "product_happy_path_ready" : "product_happy_path_not_ready",
  repoRoot,
  designRoot,
  inputs: {
    selectedVisualReport: selected.source,
    actionTraceabilityReport: trace.source,
    evidenceDirs: evidenceDirs.map(abs),
    runtimeEvidenceDirs: runtimeEvidenceDirs.map(abs),
    runtimeEvidence: runtimeEvidence.map(abs),
    blockerSatisfactionReport: satisfaction.source,
  },
  selectedVisual: {
    status: selectedReport.status || "missing",
    mobileModes,
    desktopModes,
    liveConnectedMobileEvidenceCount: liveIos.length,
    liveConnectedDesktopEvidenceCount: liveDesktop.length,
    caveat: "Selected visual proof is necessary but insufficient; product happy path requires live connected mobile+desktop evidence, not design-proof-sample, offline-truth, or static AX-only proof.",
  },
  actionTraceability: traceSummary,
  blockerSatisfaction: {
    status: satisfaction.status,
    source: satisfaction.source,
    residualBlockerCount,
    satisfiedResidualBlockerCount: residualBlockerCount - unsatisfiedResidualBlockerCount,
    unsatisfiedResidualBlockerCount,
    unsatisfiedResidualBlockers: unsatisfiedResidualRows.map(({ key, ...row }) => row),
    invalid: satisfaction.invalid,
    caveat:
      "Blocker satisfaction does not weaken the native ProductReadinessContract. It only lets this gate distinguish residual blockers that have explicit same-run/current-head/live-connected satisfaction evidence from blockers still lacking proof.",
  },
  negativeHappyPathLabels: negativeLabels,
  blockers,
  notes,
  caveat:
    "This gate intentionally fails current design-only/offline/partial-runtime states. Passing it still does not prove adoption or public release; it only proves the supplied evidence is strong enough to call the selected UI a normal connected product happy path.",
};

if (outPath) {
  const out = abs(outPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify(report, null, 2));
process.exit(requireComplete && blockers.length > 0 ? 1 : 0);
