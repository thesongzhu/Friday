#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/friday-uiux-product-closure-readiness.mjs \\
    [--repo-root=/abs/repo] \\
    [--design-root=/abs/friday-design-handoff-20260602] \\
    [--evidence-dir=/abs/ui-device-evidence] \\
    [--runtime-evidence=/abs/action-runtime-evidence.json ...] \\
    [--runtime-evidence-dir=/abs/evidence-dir ...] \\
    [--out=/abs/uiux-product-closure-readiness.json] \\
    [--require-runtime-actions] [--require-ui-device-proof]

Truth: this is a product-closure readiness harness. It links the operator-confirmed
UI/UX design handoff to selected native routes, ViewModel action drivers,
runtimeActionIds, optional runtime action evidence, and optional UI/device proof
evidence. It never treats design proof, screenshots, static Swift source, or
partial live write/read bundles as END-BAR completion.`);
}

function arg(name) {
  const prefix = `--${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length) || "";
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

const requireRuntimeActions = args.includes("--require-runtime-actions");
const requireUiDeviceProof = args.includes("--require-ui-device-proof");
const repoRoot = resolve(arg("repo-root") || process.env.FRIDAY_REPO_ROOT || new URL("../..", import.meta.url).pathname);
const designRoot = resolve(arg("design-root") || process.env.FRIDAY_DESIGN_HANDOFF_ROOT || `${process.env.HOME || "/Users/jarvis"}/Desktop/friday-design-handoff-20260602`);
const evidenceDir = arg("evidence-dir") || process.env.FRIDAY_UI_DEVICE_PROOF_EVIDENCE_DIR || "";
const runtimeEvidence = [
  ...argsAll("runtime-evidence"),
  ...(process.env.FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE
    ? process.env.FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE.split(/[:\n]/).filter(Boolean)
    : []),
];
const runtimeEvidenceDirs = [
  ...argsAll("runtime-evidence-dir"),
  ...(process.env.FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE_DIRS
    ? process.env.FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE_DIRS.split(/[:\n]/).filter(Boolean)
    : []),
];
const outPath = arg("out") || process.env.FRIDAY_UIUX_PRODUCT_CLOSURE_REPORT || "";

const blockers = [];
const notes = [];

function block(code, detail) {
  blockers.push({ code, detail });
}

function abs(path) {
  return isAbsolute(path) ? path : resolve(path);
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

function parseJsonFromOutput(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some existing readiness wrappers print diagnostic lines before the final
    // JSON object. Accept that shape, but only if a suffix parses cleanly.
  }
  const starts = [];
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] === "{") starts.push(index);
  }
  for (const start of starts.reverse()) {
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      // Try the next earlier object start.
    }
  }
  return null;
}

function runJson(label, command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...(options.env || {}) },
  });
  let parsed = null;
  const stdout = (result.stdout || "").trim();
  if (stdout) {
    parsed = parseJsonFromOutput(stdout);
    if (!parsed) block(`${label}_invalid_json`, "stdout did not contain a parseable JSON object");
  } else {
    block(`${label}_empty_stdout`, commandArgs.join(" "));
  }
  return {
    label,
    command: [command, ...commandArgs],
    exitCode: result.status ?? 1,
    status: result.status === 0 ? "passed" : "failed",
    parsed,
    stderr: (result.stderr || "").trim(),
  };
}

function designSelection(surface) {
  const selectionPath = `${designRoot}/saved/${surface}-selection.json`;
  if (!existsSync(selectionPath)) {
    block("design_selection_missing", selectionPath);
    return { surface, path: selectionPath, status: "missing" };
  }
  const value = readJson(selectionPath, `${surface}-selection`);
  const confirmed = value?.operatorConfirmed === true;
  if (!confirmed) block("design_selection_not_operator_confirmed", selectionPath);
  return {
    surface,
    path: selectionPath,
    status: confirmed ? "operator_confirmed" : "not_operator_confirmed",
    selectionKind: value?.selectionKind || null,
    truthLabel: value?.state?.truthLabel || null,
    locked: Array.isArray(value?.locked) ? value.locked : [],
    keyState: value?.state ? {
      palette: value.state.palette,
      form: value.state.form,
      petStyle: value.state.petStyle,
      homeLayout: value.state.homeLayout,
      layout: value.state.layout,
    } : null,
  };
}

function validAbsoluteFile(path, label) {
  if (!path) return false;
  const resolved = abs(path);
  if (!isAbsolute(resolved)) {
    block("path_not_absolute", `${label}:${path}`);
    return false;
  }
  if (!existsSync(resolved)) {
    block("path_missing", `${label}:${resolved}`);
    return false;
  }
  return true;
}

function maybeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function runtimeEvidenceFromIndex(indexPath) {
  if (!existsSync(indexPath)) return [];
  const value = maybeReadJson(indexPath);
  if (!value || typeof value !== "object") return [];
  const base = dirname(indexPath);
  return [
    ...(Array.isArray(value.runtime_evidence_paths) ? value.runtime_evidence_paths : []),
    ...(Array.isArray(value.runtimeEvidencePaths) ? value.runtimeEvidencePaths : []),
    ...(Array.isArray(value.evidence_paths) ? value.evidence_paths : []),
    value.action_runtime_evidence,
    value.actionRuntimeEvidence,
    value.combined_action_runtime_evidence,
    value.combinedActionRuntimeEvidence,
  ]
    .filter((candidate) => typeof candidate === "string" && candidate.trim())
    .map((candidate) => isAbsolute(candidate) ? candidate : resolve(base, candidate));
}

function runtimeEvidenceFromList(listPath) {
  if (!existsSync(listPath)) return [];
  return readFileSync(listPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((candidate) => isAbsolute(candidate) ? candidate : resolve(dirname(listPath), candidate));
}

function runtimeEvidenceFromDir(dir) {
  if (!dir || !existsSync(dir)) return [];
  const resolved = abs(dir);
  return [
    `${resolved}/action-runtime-evidence.json`,
    `${resolved}/design-action-runtime-evidence.json`,
    `${resolved}/bundle/action-runtime-evidence.json`,
    `${resolved}/bundle/design-action-runtime-evidence.json`,
    ...runtimeEvidenceFromList(`${resolved}/runtime-evidence-paths.txt`),
    ...runtimeEvidenceFromList(`${resolved}/bundle/runtime-evidence-paths.txt`),
    ...runtimeEvidenceFromIndex(`${resolved}/action-runtime-evidence-bundle-index.json`),
    ...runtimeEvidenceFromIndex(`${resolved}/live-write-read-bundle-index.json`),
    ...runtimeEvidenceFromIndex(`${resolved}/bundle/live-write-read-bundle-index.json`),
    ...runtimeEvidenceFromIndex(`${resolved}/capture-index.json`),
  ].filter((candidate, index, values) => existsSync(candidate) && values.indexOf(candidate) === index);
}

const designContractPath = `${designRoot}/ACTION-CONTRACT.md`;
if (!existsSync(designContractPath)) block("action_contract_missing", designContractPath);

const clientDesign = runJson("client_design_contract", process.execPath, [
  `${repoRoot}/scripts/ops/check-friday-client-design-contract.mjs`,
  repoRoot,
]);
const nativeLinkage = runJson("uiux_native_linkage", process.execPath, [
  `${repoRoot}/scripts/ops/check-friday-uiux-native-linkage.mjs`,
  `--repo-root=${repoRoot}`,
  `--design-root=${designRoot}`,
  "--require-complete",
]);
const selectedVisualProofArgs = [
  `${repoRoot}/scripts/ops/check-friday-uiux-selected-visual-proof.mjs`,
  `--repo-root=${repoRoot}`,
  `--design-root=${designRoot}`,
];
if (evidenceDir) selectedVisualProofArgs.push(`--evidence-dir=${abs(evidenceDir)}`);
if (requireUiDeviceProof) selectedVisualProofArgs.push("--require-complete");
const selectedVisualProof = runJson("selected_visual_proof", process.execPath, selectedVisualProofArgs);
const nativeAction = runJson("native_action_closure", process.execPath, [
  `${repoRoot}/scripts/ops/check-friday-native-action-closure.mjs`,
  repoRoot,
]);

const traceabilityArgs = [
  `${repoRoot}/scripts/ops/check-friday-uiux-action-traceability.mjs`,
  `--repo-root=${repoRoot}`,
  `--design-root=${designRoot}`,
  "--compact",
];
for (const evidence of runtimeEvidence) {
  if (validAbsoluteFile(evidence, "runtime-evidence")) {
    traceabilityArgs.push(`--runtime-evidence=${abs(evidence)}`);
  }
}
for (const dir of runtimeEvidenceDirs) {
  const resolved = abs(dir);
  if (existsSync(resolved)) traceabilityArgs.push(`--evidence-dir=${resolved}`);
}
if (evidenceDir && existsSync(abs(evidenceDir))) traceabilityArgs.push(`--evidence-dir=${abs(evidenceDir)}`);
const uiuxTraceability = runJson("uiux_action_traceability", process.execPath, traceabilityArgs);

const designRuntimeArgs = [
  `${repoRoot}/scripts/ops/check-friday-design-action-runtime-evidence.mjs`,
  `--repo-root=${repoRoot}`,
  `--contract=${designContractPath}`,
];
for (const evidence of runtimeEvidence) {
  if (validAbsoluteFile(evidence, "runtime-evidence")) {
    designRuntimeArgs.push(`--runtime-evidence=${abs(evidence)}`);
  }
}
for (const dir of runtimeEvidenceDirs) {
  const resolved = abs(dir);
  if (!existsSync(resolved)) {
    block("runtime_evidence_dir_missing", resolved);
  } else {
    for (const evidence of runtimeEvidenceFromDir(resolved)) {
      designRuntimeArgs.push(`--runtime-evidence=${evidence}`);
    }
  }
}
if (evidenceDir) {
  const resolved = abs(evidenceDir);
  if (!existsSync(resolved)) {
    block("evidence_dir_missing", resolved);
  } else {
    for (const evidence of runtimeEvidenceFromDir(resolved)) {
      designRuntimeArgs.push(`--runtime-evidence=${evidence}`);
    }
  }
}
if (requireRuntimeActions) designRuntimeArgs.push("--require-complete");
const designRuntime = runJson("design_action_runtime", process.execPath, designRuntimeArgs);

let uiDeviceReadiness = null;
if (existsSync(`${repoRoot}/scripts/ops/friday-ui-device-proof-readiness.sh`)) {
  const readinessArgs = [`${repoRoot}/scripts/ops/friday-ui-device-proof-readiness.sh`];
  if (evidenceDir) readinessArgs.push("--evidence-dir", abs(evidenceDir));
  if (designContractPath) readinessArgs.push("--design-action-contract", designContractPath);
  for (const evidence of runtimeEvidence) {
    if (existsSync(abs(evidence))) readinessArgs.push("--design-action-runtime-evidence", abs(evidence));
  }
  for (const dir of runtimeEvidenceDirs) {
    if (existsSync(abs(dir))) readinessArgs.push("--design-action-runtime-evidence-dir", abs(dir));
  }
  if (requireUiDeviceProof) readinessArgs.push("--require-proof");
  uiDeviceReadiness = runJson("ui_device_proof_readiness", "bash", readinessArgs);
} else {
  block("ui_device_readiness_script_missing", "scripts/ops/friday-ui-device-proof-readiness.sh");
}

const runtimeReport = designRuntime.parsed || {};
const readinessReport = uiDeviceReadiness?.parsed || {};
const traceabilityReport = uiuxTraceability.parsed || {};
const clientPassed = clientDesign.status === "passed" && clientDesign.parsed?.status === "passed";
const nativeLinkagePassed = nativeLinkage.status === "passed" && nativeLinkage.parsed?.status === "linked";
const selectedVisualProofReady = selectedVisualProof.status === "passed" && selectedVisualProof.parsed?.status === "selected_visual_proof_ready";
const nativePassed = nativeAction.status === "passed" && nativeAction.parsed?.status === "passed";
const traceabilityPassed = uiuxTraceability.status === "passed" && ["product_runtime_actions_traceable", "traceability_gaps_present"].includes(traceabilityReport.status);
const runtimeCovered = runtimeReport.status === "runtime_actions_covered";
const uiDeviceProofAssembled = readinessReport.status === "pass";

if (!clientPassed) block("client_design_contract_failed", String(clientDesign.exitCode));
if (!nativeLinkagePassed) block("uiux_native_linkage_failed", nativeLinkage.parsed?.status || String(nativeLinkage.exitCode));
if (requireUiDeviceProof && !selectedVisualProofReady) block("selected_visual_proof_not_ready", selectedVisualProof.parsed?.status || String(selectedVisualProof.exitCode));
if (!nativePassed) block("native_action_closure_failed", String(nativeAction.exitCode));
if (!traceabilityPassed) block("uiux_action_traceability_failed", traceabilityReport.status || String(uiuxTraceability.exitCode));
if (requireRuntimeActions && !runtimeCovered) block("runtime_actions_not_covered", runtimeReport.status || "unknown");
if (requireUiDeviceProof && !uiDeviceProofAssembled) block("ui_device_proof_not_assembled", readinessReport.status || "unknown");

if (!runtimeCovered) {
  notes.push("runtime_action_evidence_gap_present");
}
if (!uiDeviceProofAssembled) {
  notes.push("ui_device_full_proof_not_assembled");
}
if (!selectedVisualProofReady) {
  notes.push("selected_visual_proof_gap_present");
}

const report = {
  truth: "uiux_product_closure_readiness_not_endbar_not_adoption",
  status: blockers.length === 0
    ? runtimeCovered && uiDeviceProofAssembled
      ? "uiux_product_closure_evidence_ready"
      : "ready_for_runtime_capture"
    : "blocked",
  repoRoot,
  designRoot,
  design: {
    contract: designContractPath,
    selections: [
      designSelection("mobile"),
      designSelection("desktop"),
    ],
  },
  stages: {
    clientDesignContract: {
      status: clientDesign.parsed?.status || clientDesign.status,
      truthLabel: clientDesign.parsed?.truthLabel || null,
    },
    uiuxNativeLinkage: {
      status: nativeLinkage.parsed?.status || nativeLinkage.status,
      counts: nativeLinkage.parsed?.counts || null,
      gaps: nativeLinkage.parsed?.gaps || [],
      caveat: nativeLinkage.parsed?.caveat || "Selected-design native linkage only; not screenshot proof, live tap proof, or END-BAR.",
    },
    selectedVisualProof: {
      status: selectedVisualProof.parsed?.status || selectedVisualProof.status,
      blockers: selectedVisualProof.parsed?.blockers || [],
      notes: selectedVisualProof.parsed?.notes || [],
      evidenceInputs: selectedVisualProof.parsed?.evidenceInputs || null,
      caveat: selectedVisualProof.parsed?.caveat || "Selected visual proof only; not live action closure, release, adoption, or END-BAR.",
    },
    nativeActionClosure: {
      status: nativeAction.parsed?.status || nativeAction.status,
      passed: nativeAction.parsed?.summary?.passed ?? null,
      failed: nativeAction.parsed?.summary?.failed ?? null,
      truthLabel: nativeAction.parsed?.truthLabel || null,
    },
    uiuxActionTraceability: {
      status: traceabilityReport.status || uiuxTraceability.status,
      counts: traceabilityReport.counts || null,
      bySurface: traceabilityReport.bySurface || null,
      gaps: traceabilityReport.gaps || null,
    },
    designActionRuntime: {
      status: runtimeReport.status || designRuntime.status,
      counts: runtimeReport.counts || null,
      capturePlan: runtimeReport.capturePlan || [],
      runtimeEvidenceInputs: runtimeReport.runtimeEvidenceInputs || [],
    },
    uiDeviceProofReadiness: {
      status: readinessReport.status || uiDeviceReadiness?.status || "not_run",
      notes: readinessReport.notes || [],
      blockers: readinessReport.blockers || [],
    },
  },
  recommendedNextActions: [
    ...(runtimeCovered ? [] : [{
      target: "runtime-action-evidence",
      action: "capture or attach real action-runtime-evidence for remaining design actions; screenshots alone do not close these rows",
      capturePlan: runtimeReport.capturePlan || [],
    }]),
    ...(uiDeviceProofAssembled ? [] : [{
      target: "ui-device-proof",
      action: "supply same-run mobile, desktop, channel, timeline, observations manifest, and stress/negative-control evidence to friday-ui-device-proof-readiness.sh",
    }]),
    ...(selectedVisualProofReady ? [] : [{
      target: "selected-visual-proof",
      action: "capture fresh current-HEAD native mobile destination screenshots and desktop visual/accessibility capture for the operator-selected baseline; static Swift linkage and old proof PNGs do not close visual parity",
      blockers: selectedVisualProof.parsed?.blockers || [],
    }]),
  ],
  notes,
  blockers,
  caveat: "This report links UI/UX design to current code and evidence. It is not END-BAR unless runtime action coverage and real UI/device proof are both complete, and it never claims adoption or organic load.",
};

if (outPath) {
  const out = abs(outPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify(report, null, 2));
process.exit(blockers.length === 0 ? 0 : 2);
