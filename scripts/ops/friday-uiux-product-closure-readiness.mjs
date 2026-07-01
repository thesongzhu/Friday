#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/friday-uiux-product-closure-readiness.mjs \\
    [--repo-root=/abs/repo] \\
    [--design-root=/abs/friday-design-handoff-20260602] \\
    [--evidence-dir=/abs/ui-device-evidence ...] \\
    [--selected-visual-evidence-dir=/abs/served-or-visual-evidence ...] \\
    [--evidence-set=/abs/uiux-closure-evidence-set.json ...] \\
    [--runtime-evidence=/abs/action-runtime-evidence.json ...] \\
    [--runtime-evidence-dir=/abs/evidence-dir ...] \\
    [--out=/abs/uiux-product-closure-readiness.json] \\
    [--require-runtime-actions] [--require-ui-device-proof] [--defer-channel-proof]

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
const deferChannelProof = args.includes("--defer-channel-proof") || process.env.FRIDAY_UI_DEVICE_DEFER_CHANNEL_PROOF === "1";
const repoRoot = resolve(arg("repo-root") || process.env.FRIDAY_REPO_ROOT || new URL("../..", import.meta.url).pathname);
const designRoot = resolve(arg("design-root") || process.env.FRIDAY_DESIGN_HANDOFF_ROOT || `${process.env.HOME || process.env.USERPROFILE || "."}/Desktop/friday-design-handoff-20260602`);
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
    if (!parsed && !options.suppressBlocks) block(`${label}_invalid_json`, "stdout did not contain a parseable JSON object");
  } else {
    if (!options.suppressBlocks) block(`${label}_empty_stdout`, commandArgs.join(" "));
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

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((candidate) => typeof candidate === "string" && candidate.trim());
}

function evidenceSetList(value, names) {
  for (const name of names) {
    const list = stringArray(value?.[name]);
    if (list.length > 0) return list;
  }
  return [];
}

function evidenceSetsFromFiles(paths) {
  const sets = [];
  for (const path of paths) {
    const resolved = abs(path);
    const value = readJson(resolved, "evidence-set");
    if (!value || typeof value !== "object") continue;
    sets.push({
      path: resolved,
      evidenceDirs: evidenceSetList(value, ["evidenceDirs", "evidence_dirs", "uiDeviceEvidenceDirs", "ui_device_evidence_dirs"]),
      runtimeEvidence: evidenceSetList(value, ["runtimeEvidence", "runtime_evidence", "runtimeEvidencePaths", "runtime_evidence_paths"]),
      runtimeEvidenceDirs: evidenceSetList(value, ["runtimeEvidenceDirs", "runtime_evidence_dirs", "actionRuntimeEvidenceDirs", "action_runtime_evidence_dirs"]),
      caveat: value.caveat || "evidence set only lists inputs; each referenced artifact is still revalidated by the normal gates",
    });
  }
  return sets;
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
    ...recursiveRuntimeEvidenceFromDir(resolved),
  ].filter((candidate, index, values) => existsSync(candidate) && values.indexOf(candidate) === index);
}

function recursiveRuntimeEvidenceFromDir(root) {
  if (!root || !existsSync(root)) return [];
  const found = [];
  const stack = [{ dir: root, depth: 0 }];
  const seen = new Set();
  const ignored = new Set([".git", "node_modules", "target", ".build", "DerivedData"]);
  const maxDepth = 8;
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item || seen.has(item.dir) || item.depth > maxDepth) continue;
    seen.add(item.dir);
    let entries = [];
    try {
      entries = readdirSync(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = resolve(item.dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) stack.push({ dir: candidate, depth: item.depth + 1 });
      } else if (entry.isFile() && ["action-runtime-evidence.json", "design-action-runtime-evidence.json"].includes(entry.name)) {
        found.push(candidate);
      }
    }
  }
  return found;
}

function unique(values) {
  return [...new Set(values)];
}

const evidenceSetPaths = [
  ...argsAll("evidence-set"),
  ...(process.env.FRIDAY_UIUX_PRODUCT_CLOSURE_EVIDENCE_SET
    ? process.env.FRIDAY_UIUX_PRODUCT_CLOSURE_EVIDENCE_SET.split(/[:\n]/).filter(Boolean)
    : []),
];
const evidenceSets = evidenceSetsFromFiles(evidenceSetPaths);
const evidenceDirs = unique([
  ...argsAll("evidence-dir"),
  ...evidenceSets.flatMap((set) => set.evidenceDirs),
  ...(process.env.FRIDAY_UI_DEVICE_PROOF_EVIDENCE_DIR
    ? [process.env.FRIDAY_UI_DEVICE_PROOF_EVIDENCE_DIR]
    : []),
  ...(process.env.FRIDAY_UI_DEVICE_PROOF_EVIDENCE_DIRS
    ? process.env.FRIDAY_UI_DEVICE_PROOF_EVIDENCE_DIRS.split(/[:\n]/).filter(Boolean)
    : []),
]);
const selectedVisualEvidenceDirs = unique([
  ...argsAll("selected-visual-evidence-dir"),
  ...(process.env.FRIDAY_UIUX_SELECTED_VISUAL_EVIDENCE_DIRS
    ? process.env.FRIDAY_UIUX_SELECTED_VISUAL_EVIDENCE_DIRS.split(/[:\n]/).filter(Boolean)
    : []),
]);
const runtimeEvidence = unique([
  ...argsAll("runtime-evidence"),
  ...evidenceSets.flatMap((set) => set.runtimeEvidence),
  ...(process.env.FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE
    ? process.env.FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE.split(/[:\n]/).filter(Boolean)
    : []),
]);
const runtimeEvidenceDirs = unique([
  ...argsAll("runtime-evidence-dir"),
  ...evidenceSets.flatMap((set) => set.runtimeEvidenceDirs),
  ...(process.env.FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE_DIRS
    ? process.env.FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE_DIRS.split(/[:\n]/).filter(Boolean)
    : []),
]);

function uiDeviceEvidenceDirCandidates(dirs) {
  const candidates = [];
  for (const dir of dirs) {
    const resolved = abs(dir);
    if (!existsSync(resolved)) continue;
    const nestedEvidence = resolve(resolved, "evidence");
    if (existsSync(nestedEvidence)) candidates.push(nestedEvidence);
    candidates.push(resolved);
  }
  return unique(candidates);
}

function readinessScore(run) {
  const report = run?.parsed || {};
  const blockers = Array.isArray(report.blockers) ? report.blockers : [];
  const notes = Array.isArray(report.notes) ? report.notes : [];
  if (report.status === "pass") return 100;
  if (blockers.includes("ui_device_proof_evidence:channel_deferred_strict_assembly_blocked")) return 80;
  if (notes.some((note) => String(note).startsWith("resolved_MOBILE_EVIDENCE:")) &&
      notes.some((note) => String(note).startsWith("resolved_DESKTOP_EVIDENCE:")) &&
      notes.some((note) => String(note).startsWith("resolved_TIMELINE_EVIDENCE:"))) {
    return 60;
  }
  if (blockers.includes("ui_device_proof_evidence:missing_required_real_evidence_env")) return 20;
  return run?.status === "passed" ? 10 : 0;
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
function addSelectedVisualEvidenceArg(path) {
  const resolved = abs(path);
  const name = basename(resolved);
  if (name.includes("served-ui-design-fidelity") && name.endsWith(".json")) {
    selectedVisualProofArgs.push(`--served-ui-report=${resolved}`);
    return;
  }
  switch (name) {
    case "ios-design-destination-capture-manifest.json":
      selectedVisualProofArgs.push(`--ios-manifest=${resolved}`);
      break;
    case "desktop-ax-accessibility-capture.json":
      selectedVisualProofArgs.push(`--desktop-capture=${resolved}`);
      break;
    default:
      selectedVisualProofArgs.push(`--evidence-dir=${resolved}`);
      break;
  }
}
for (const dir of evidenceDirs) {
  addSelectedVisualEvidenceArg(dir);
}
for (const dir of selectedVisualEvidenceDirs) {
  addSelectedVisualEvidenceArg(dir);
}
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
for (const dir of evidenceDirs) {
  if (existsSync(abs(dir))) traceabilityArgs.push(`--evidence-dir=${abs(dir)}`);
}
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
for (const dir of evidenceDirs) {
  const resolved = abs(dir);
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
const uiDeviceReadinessCandidates = [];
if (existsSync(`${repoRoot}/scripts/ops/friday-ui-device-proof-readiness.sh`)) {
  const candidateDirs = uiDeviceEvidenceDirCandidates(evidenceDirs);
  const runReadiness = (candidateDir = "") => {
    const readinessArgs = [`${repoRoot}/scripts/ops/friday-ui-device-proof-readiness.sh`];
    if (candidateDir) readinessArgs.push("--evidence-dir", candidateDir);
    if (designContractPath) readinessArgs.push("--design-action-contract", designContractPath);
    for (const evidence of runtimeEvidence) {
      if (existsSync(abs(evidence))) readinessArgs.push("--design-action-runtime-evidence", abs(evidence));
    }
    for (const dir of runtimeEvidenceDirs) {
      if (existsSync(abs(dir))) readinessArgs.push("--design-action-runtime-evidence-dir", abs(dir));
    }
    for (const dir of evidenceDirs) {
      if (existsSync(abs(dir))) readinessArgs.push("--design-action-runtime-evidence-dir", abs(dir));
    }
    if (deferChannelProof) readinessArgs.push("--defer-channel-proof");
    if (requireUiDeviceProof) readinessArgs.push("--require-proof");
    const run = runJson("ui_device_proof_readiness", "bash", readinessArgs, { suppressBlocks: candidateDirs.length > 1 });
    run.evidenceDir = candidateDir || null;
    run.score = readinessScore(run);
    return run;
  };
  if (candidateDirs.length === 0) {
    uiDeviceReadiness = runReadiness();
  } else {
    for (const candidateDir of candidateDirs) uiDeviceReadinessCandidates.push(runReadiness(candidateDir));
    uiDeviceReadiness = [...uiDeviceReadinessCandidates].sort((left, right) => right.score - left.score)[0] || null;
  }
} else {
  block("ui_device_readiness_script_missing", "scripts/ops/friday-ui-device-proof-readiness.sh");
}

const runtimeReport = designRuntime.parsed || {};
const readinessReport = uiDeviceReadiness?.parsed || {};
const traceabilityReport = uiuxTraceability.parsed || {};
const residualEndBarBlockers = Array.isArray(traceabilityReport.gaps?.residualEndBarBlockers)
  ? traceabilityReport.gaps.residualEndBarBlockers
  : Array.isArray(traceabilityReport.gaps?.destinationsStillBlocked)
    ? traceabilityReport.gaps.destinationsStillBlocked
    : [];
const residualEndBarEvidence = traceabilityReport.residualEndBarEvidence || {
  truth: "runtime_action_evidence_overlay_not_available_not_endbar",
  destinationsWithResidualBlockers: residualEndBarBlockers.length,
  caveat: "No residual evidence overlay was emitted by the traceability report; residual blockers remain product maturity/user-proof requirements.",
};
const clientPassed = clientDesign.status === "passed" && clientDesign.parsed?.status === "passed";
const nativeLinkagePassed = nativeLinkage.status === "passed" && nativeLinkage.parsed?.status === "linked";
const selectedVisualProofReady = selectedVisualProof.status === "passed" && selectedVisualProof.parsed?.status === "selected_visual_proof_ready";
const nativePassed = nativeAction.status === "passed" && nativeAction.parsed?.status === "passed";
const traceabilityPassed = uiuxTraceability.status === "passed" && ["product_runtime_actions_traceable", "traceability_gaps_present"].includes(traceabilityReport.status);
const runtimeCovered = runtimeReport.status === "runtime_actions_covered";
const uiDeviceProofAssembled = readinessReport.status === "pass";
const readinessBlockers = Array.isArray(readinessReport.blockers) ? readinessReport.blockers : [];
const readinessBlockerDetail = readinessBlockers.length > 0
  ? readinessBlockers.join(",")
  : readinessReport.status || "unknown";
const channelDeferredStrictAssembly = readinessBlockers.includes("ui_device_proof_evidence:channel_deferred_strict_assembly_blocked");
const readinessNotes = Array.isArray(readinessReport.notes) ? readinessReport.notes : [];
const nonChannelInputsResolved = [
  "resolved_MOBILE_EVIDENCE:",
  "resolved_DESKTOP_EVIDENCE:",
  "resolved_TIMELINE_EVIDENCE:",
  "resolved_OBSERVATIONS_MANIFEST:",
  "resolved_SAME_RUN_EVENTS:",
].every((prefix) => readinessNotes.some((note) => String(note).startsWith(prefix)));
const nonChannelUiDeviceClosureReady = !uiDeviceProofAssembled
  && channelDeferredStrictAssembly
  && readinessReport.status === "blocked"
  && nonChannelInputsResolved;
const nonChannelProductClosureReady = blockers.length === 0
  && clientPassed
  && nativeLinkagePassed
  && selectedVisualProofReady
  && nativePassed
  && traceabilityPassed
  && runtimeCovered
  && nonChannelUiDeviceClosureReady;

if (!clientPassed) block("client_design_contract_failed", String(clientDesign.exitCode));
if (!nativeLinkagePassed) block("uiux_native_linkage_failed", nativeLinkage.parsed?.status || String(nativeLinkage.exitCode));
if (requireUiDeviceProof && !selectedVisualProofReady) block("selected_visual_proof_not_ready", selectedVisualProof.parsed?.status || String(selectedVisualProof.exitCode));
if (!nativePassed) block("native_action_closure_failed", String(nativeAction.exitCode));
if (!traceabilityPassed) block("uiux_action_traceability_failed", traceabilityReport.status || String(uiuxTraceability.exitCode));
if (requireRuntimeActions && !runtimeCovered) block("runtime_actions_not_covered", runtimeReport.status || "unknown");
if (requireUiDeviceProof && !uiDeviceProofAssembled) block("ui_device_proof_not_assembled", readinessBlockerDetail);

if (!runtimeCovered) {
  notes.push("runtime_action_evidence_gap_present");
}
if (!uiDeviceProofAssembled) {
  notes.push("ui_device_full_proof_not_assembled");
}
if (!selectedVisualProofReady) {
  notes.push("selected_visual_proof_gap_present");
}
if (nonChannelProductClosureReady) {
  notes.push("non_channel_uiux_closure_ready_channel_deferred");
}

const report = {
  truth: "uiux_product_closure_readiness_not_endbar_not_adoption",
  status: blockers.length === 0
    ? runtimeCovered && uiDeviceProofAssembled
      ? "uiux_product_closure_evidence_ready"
      : nonChannelProductClosureReady
        ? "non_channel_closure_ready_channel_deferred"
        : "runtime_capture_required"
    : "blocked",
  repoRoot,
  designRoot,
  evidenceSets,
  selectedVisualEvidenceDirs,
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
      residualEndBarBlockers,
      residualEndBarEvidence,
      caveat: "Residual END-BAR blockers are product maturity/user-proof requirements, not missing runtimeActionId traceability when product_runtime_actions_traceable is reported.",
    },
    designActionRuntime: {
      status: runtimeReport.status || designRuntime.status,
      counts: runtimeReport.counts || null,
      capturePlan: runtimeReport.capturePlan || [],
      runtimeEvidenceInputs: runtimeReport.runtimeEvidenceInputs || [],
    },
    uiDeviceProofReadiness: {
      status: readinessReport.status || uiDeviceReadiness?.status || "not_run",
      selectedEvidenceDir: uiDeviceReadiness?.evidenceDir || null,
      selectedScore: uiDeviceReadiness?.score ?? null,
      candidateRuns: uiDeviceReadinessCandidates.map((candidate) => ({
        evidenceDir: candidate.evidenceDir,
        score: candidate.score,
        status: candidate.parsed?.status || candidate.status,
        blockers: candidate.parsed?.blockers || [],
      })),
      notes: readinessReport.notes || [],
      blockers: readinessReport.blockers || [],
    },
    nonChannelClosure: {
      status: nonChannelProductClosureReady
        ? "non_channel_uiux_closure_ready_channel_deferred"
        : uiDeviceProofAssembled
          ? "superseded_by_full_ui_device_proof"
          : "not_ready",
      channelDeferredStrictAssembly,
      nonChannelInputsResolved,
      blockers: nonChannelProductClosureReady ? [
        "ui_device_proof_evidence:channel_deferred_strict_assembly_blocked",
      ] : [
        ...(!clientPassed ? ["client_design_contract_failed"] : []),
        ...(!nativeLinkagePassed ? ["uiux_native_linkage_failed"] : []),
        ...(!selectedVisualProofReady ? ["selected_visual_proof_not_ready"] : []),
        ...(!nativePassed ? ["native_action_closure_failed"] : []),
        ...(!traceabilityPassed ? ["uiux_action_traceability_failed"] : []),
        ...(!runtimeCovered ? ["runtime_actions_not_covered"] : []),
        ...(!nonChannelUiDeviceClosureReady ? ["non_channel_ui_device_inputs_not_ready"] : []),
      ],
      caveat: "Non-channel closure is not END-BAR, not GO-LIVE, not adoption, and never satisfies strict UI/device proof while channel proof is deferred.",
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
    ...(residualEndBarBlockers.length === 0 ? [] : [{
      target: "endbar-residual-product-proof",
      action: "close the remaining real-user/product-maturity proofs listed by residualEndBarBlockers; residualEndBarEvidence may show attached runtime evidence, but that evidence does not clear product blockers or satisfy END-BAR by itself",
      blockers: residualEndBarBlockers,
      evidence: residualEndBarEvidence,
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
