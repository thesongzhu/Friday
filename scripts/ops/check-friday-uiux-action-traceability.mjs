#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/check-friday-uiux-action-traceability.mjs \\
    [--repo-root=/abs/repo] \\
    [--design-root=/abs/friday-design-handoff-20260602] \\
    [--evidence-dir=/abs/runtime-evidence-bundle ...] \\
    [--runtime-evidence-dir=/abs/runtime-evidence-bundle ...] \\
    [--runtime-evidence=/abs/action-runtime-evidence.json ...] \\
    [--contract-annex=/abs/friday-uiux-product-runtime-action-annex.md ...] \\
    [--out=/abs/uiux-action-traceability.json] \\
    [--require-runtime-evidence]

Truth: links operator-selected UI/UX design, native product destination contracts,
and action-runtime evidence. It is a traceability report only: design contract
rows, Swift route coverage, and ViewModel evidence do not prove END-BAR, GUI tap
coverage, channel proof, adoption, or organic load.`);
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

const requireRuntimeEvidence = args.includes("--require-runtime-evidence");
const compact = args.includes("--compact");
const repoRoot = resolve(arg("repo-root") || process.env.FRIDAY_REPO_ROOT || new URL("../..", import.meta.url).pathname);
const designRoot = resolve(arg("design-root") || process.env.FRIDAY_DESIGN_HANDOFF_ROOT || `${process.env.HOME || "/Users/jarvis"}/Desktop/friday-design-handoff-20260602`);
const defaultContractAnnex = resolve(repoRoot, "docs/friday-uiux-product-runtime-action-annex.md");
const contractAnnexPaths = [
  ...(existingFile(defaultContractAnnex) ? [defaultContractAnnex] : []),
  ...argsAll("contract-annex"),
  ...(process.env.FRIDAY_DESIGN_ACTION_CONTRACT_ANNEX
    ? process.env.FRIDAY_DESIGN_ACTION_CONTRACT_ANNEX.split(/[:\n]/).filter(Boolean)
    : []),
].map((value) => resolve(value));
const evidenceDirs = [
  ...argsAll("evidence-dir"),
  ...argsAll("runtime-evidence-dir"),
  ...(process.env.FRIDAY_UIUX_ACTION_TRACEABILITY_EVIDENCE_DIR
    ? process.env.FRIDAY_UIUX_ACTION_TRACEABILITY_EVIDENCE_DIR.split(/[:\n]/).filter(Boolean)
    : []),
  ...(process.env.FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE_DIRS
    ? process.env.FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE_DIRS.split(/[:\n]/).filter(Boolean)
    : []),
];
const runtimeEvidenceArgs = [
  ...argsAll("runtime-evidence"),
  ...(process.env.FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE
    ? process.env.FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE.split(/[:\n]/).filter(Boolean)
    : []),
];
const outPath = arg("out") || process.env.FRIDAY_UIUX_ACTION_TRACEABILITY_REPORT || "";

const blockers = [];
function block(code, detail) {
  blockers.push({ code, detail });
}

function existingFile(path) {
  try {
    const stats = statSync(path);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

function read(path, label) {
  if (!existingFile(path)) {
    block("file_missing", `${label}:${path}`);
    return "";
  }
  return readFileSync(path, "utf8");
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    block("json_unreadable", `${label}:${path}:${error.message}`);
    return null;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function splitMarkdownRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return [];
  return trimmed.slice(1, -1).split("|").map((cell) => cell.trim().replace(/`/g, ""));
}

function isActionable(row) {
  if (!["mobile", "desktop"].includes(row.surface)) return false;
  if (["disabled", "caprow"].includes(row.actionId)) return false;
  if (["action_local", "navigation_local"].includes(row.capabilityId)) return false;
  if (["historical", "release_only"].includes(row.truthStatus)) return false;
  if (String(row.resultTarget || "").startsWith("result:disabled")) return false;
  return true;
}

function parseActionContract(path) {
  const source = read(path, "action-contract");
  if (!source) return [];
  if (!source.includes("wired_registry ≠ runtime PASS")) {
    block("action_contract_truth_boundary_missing", path);
  }
  const rows = [];
  for (const line of source.split(/\r?\n/)) {
    const cells = splitMarkdownRow(line);
    if (cells.length < 9 || cells[0] === "Surface" || cells[0] === "---") continue;
    const [surface, rawScreen, actionId, label, capabilityId, , regStatus, truthStatus, resultTarget] = cells;
    if (!surface || !rawScreen || !actionId) continue;
    const screen = rawScreen.replace(/\s+\[.*\]$/, "");
    const row = {
      surface,
      screen,
      screenState: rawScreen,
      actionId,
      label,
      capabilityId,
      regStatus,
      truthStatus,
      resultTarget,
    };
    row.actionable = isActionable(row);
    row.identity = actionIdentity(row.surface, row.screen, row.actionId);
    rows.push(row);
  }
  return rows;
}

function stringArrayFromBlock(blockSource, key) {
  const match = blockSource.match(new RegExp(`${key}:\\s*\\[([\\s\\S]*?)\\]`, "m"));
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

function stringValueFromBlock(blockSource, key) {
  const match = blockSource.match(new RegExp(`${key}:\\s*"([^"]+)"`, "m"));
  return match?.[1] || "";
}

function tierFromBlock(blockSource) {
  return blockSource.match(/tier:\s*\.(\w+)/m)?.[1] || "";
}

function blockersFromBlock(blockSource) {
  return [...blockSource.matchAll(/\.init\(\.(\w+),[\s\S]*?label:\s*"([^"]+)"/g)]
    .map((match) => ({ kind: match[1], label: match[2] }));
}

function parseProductContract(path, surface) {
  const source = read(path, `${surface}-product-contract`);
  if (!source) return [];
  const destinations = [];
  const caseRegex = /case \.(\w+):\s*return contract\(([\s\S]*?)(?=\n\s*case \.|\n\s*}\n\s*}\n)/g;
  for (const match of source.matchAll(caseRegex)) {
    const id = match[1];
    const body = match[2];
    destinations.push({
      surface,
      id,
      title: stringValueFromBlock(body, "title"),
      tier: tierFromBlock(body),
      routeBuilt: true,
      selectedDesignLocked: true,
      runtimeActionIds: stringArrayFromBlock(body, "runtimeActionIds"),
      blockers: blockersFromBlock(body),
      isEndBarReady: false,
    });
  }
  return destinations;
}

function pathsFromList(listPath) {
  if (!existingFile(listPath)) return [];
  const base = dirname(listPath);
  return readFileSync(listPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((candidate) => isAbsolute(candidate) ? candidate : resolve(base, candidate));
}

function pathsFromIndex(indexPath) {
  if (!existingFile(indexPath)) return [];
  const value = readJson(indexPath, "runtime-index");
  if (!value || typeof value !== "object") return [];
  const base = dirname(indexPath);
  const candidates = [
    ...(Array.isArray(value.runtime_evidence_paths) ? value.runtime_evidence_paths : []),
    ...(Array.isArray(value.runtimeEvidencePaths) ? value.runtimeEvidencePaths : []),
    ...(Array.isArray(value.evidence_paths) ? value.evidence_paths : []),
    value.action_runtime_evidence,
    value.actionRuntimeEvidence,
    value.combined_action_runtime_evidence,
    value.combinedActionRuntimeEvidence,
  ].filter((candidate) => typeof candidate === "string" && candidate.trim());
  return candidates.map((candidate) => isAbsolute(candidate) ? candidate : resolve(base, candidate));
}

function runtimeEvidenceFromDir(dir) {
  if (!dir) return [];
  const root = resolve(dir);
  return unique([
    resolve(root, "action-runtime-evidence.json"),
    resolve(root, "design-action-runtime-evidence.json"),
    resolve(root, "bundle/action-runtime-evidence.json"),
    resolve(root, "bundle/design-action-runtime-evidence.json"),
    ...pathsFromList(resolve(root, "runtime-evidence-paths.txt")),
    ...pathsFromList(resolve(root, "bundle/runtime-evidence-paths.txt")),
    ...pathsFromIndex(resolve(root, "action-runtime-evidence-bundle-index.json")),
    ...pathsFromIndex(resolve(root, "bundle/action-runtime-evidence-bundle-index.json")),
    ...pathsFromIndex(resolve(root, "live-write-read-bundle-index.json")),
    ...pathsFromIndex(resolve(root, "bundle/live-write-read-bundle-index.json")),
    ...pathsFromIndex(resolve(root, "capture-index.json")),
    ...runtimeEvidenceFilesUnder(root, 3),
  ]).filter(existingFile);
}

function runtimeEvidenceFilesUnder(root, maxDepth) {
  const found = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = resolve(dir, entry.name);
      if (entry.isFile() && ["action-runtime-evidence.json", "design-action-runtime-evidence.json"].includes(entry.name)) {
        found.push(child);
      } else if (entry.isDirectory()) {
        walk(child, depth + 1);
      }
    }
  }
  walk(root, 0);
  return found;
}

function runtimeActions(paths) {
  const actions = [];
  for (const path of paths) {
    const value = readJson(path, "runtime-evidence");
    const rows = Array.isArray(value?.actions) ? value.actions : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      actions.push({
        path,
        surface: String(row.surface || ""),
        screen: String(row.screen || ""),
        actionId: String(row.action_id || row.actionId || ""),
        capabilityId: String(row.capability_id || row.capabilityId || ""),
        status: String(row.status || ""),
        evidenceRef: String(row.evidence_ref || row.evidenceRef || ""),
        truthLabel: String(row.truth_label || row.truthLabel || value?.truth || ""),
      });
    }
  }
  return actions;
}

function normalizedToken(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function canonicalScreen(screen) {
  return normalizedToken(screen).replace(/^firstlaunch$/, "firstlaunch");
}

function canonicalAction(screen, action) {
  const screenToken = canonicalScreen(screen);
  let token = normalizedToken(action);
  if (screenToken && token.startsWith(screenToken)) token = token.slice(screenToken.length);
  const synonyms = new Map([
    ["reject", "act"],
    ["approve", "check"],
    ["confirm", "check"],
    ["keep", "check"],
    ["pairnow", "pairnow"],
    ["runcontrol", "workflowruncontrol"],
    ["open", "sidecaropen"],
    ["close", "sidecarclose"],
    ["send", "check"],
    ["checklist", "check"],
  ]);
  return synonyms.get(token) || token;
}

function actionIdentity(surface, screen, action) {
  if (/^(mobile|desktop)\//i.test(String(action || ""))) return productActionIdentity(action);
  return `${normalizedToken(surface)}/${canonicalScreen(screen)}/${canonicalAction(screen, action)}`;
}

function productActionIdentity(actionId) {
  const parts = String(actionId || "").split("/");
  const [surface = "", screen = "", ...rest] = parts;
  return actionIdentity(surface, screen, rest.join("/"));
}

function actionMatches(productActionId, runtimeOrContractAction) {
  const product = productActionIdentity(productActionId);
  const candidate = actionIdentity(
    runtimeOrContractAction.surface,
    runtimeOrContractAction.screen,
    runtimeOrContractAction.actionId,
  );
  if (product === candidate) return true;
  const [ps, pc, pa] = product.split("/");
  const [cs, cc, ca] = candidate.split("/");
  return ps === cs && pc === cc && (pa === ca || pa.includes(ca) || ca.includes(pa));
}

function runJson(label, commandArgs) {
  const result = spawnSync(process.execPath, commandArgs, { cwd: repoRoot, encoding: "utf8" });
  let parsed = null;
  if (result.stdout) {
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      block(`${label}_invalid_json`, commandArgs.join(" "));
    }
  }
  if ((result.status ?? 1) !== 0) block(`${label}_failed`, String(result.status ?? 1));
  return parsed;
}

const actionContractPath = resolve(designRoot, "ACTION-CONTRACT.md");
const contractRows = [
  ...parseActionContract(actionContractPath),
  ...contractAnnexPaths.flatMap((path) => parseActionContract(path)),
];
const actionableContractRows = contractRows.filter((row) => row.actionable);
const uniqueActionableIdentities = unique(actionableContractRows.map((row) => row.identity));
const mobileDestinations = parseProductContract(
  resolve(repoRoot, "apps/friday-ios/Sources/FridayMobileShellCore/MobileProductReadinessContract.swift"),
  "mobile",
);
const desktopDestinations = parseProductContract(
  resolve(repoRoot, "apps/macos/FridayHubConsole/Sources/FridayHubConsoleCore/DesktopProductReadinessContract.swift"),
  "desktop",
);
const productDestinations = [...mobileDestinations, ...desktopDestinations];
const runtimeEvidencePaths = unique([
  ...runtimeEvidenceArgs.map((value) => resolve(value)),
  ...evidenceDirs.flatMap((dir) => runtimeEvidenceFromDir(dir)),
]).filter(existingFile);
const evidenceActions = runtimeActions(runtimeEvidencePaths);
const passedEvidenceActions = evidenceActions.filter((action) => action.status === "pass");

const designRuntimeArgs = [
  new URL("./check-friday-design-action-runtime-evidence.mjs", import.meta.url).pathname,
  `--repo-root=${repoRoot}`,
  `--contract=${actionContractPath}`,
  ...runtimeEvidencePaths.map((path) => `--runtime-evidence=${path}`),
];
const designActionRuntimeReport = runJson("design_action_runtime", designRuntimeArgs);

const tracedDestinations = productDestinations.map((destination) => {
  const actions = destination.runtimeActionIds.map((runtimeActionId) => {
    const contractMatches = actionableContractRows.filter((row) => actionMatches(runtimeActionId, row));
    const evidenceMatches = passedEvidenceActions.filter((row) => actionMatches(runtimeActionId, row));
    return {
      runtimeActionId,
      designContractMatched: contractMatches.length > 0,
      runtimeEvidenceMatched: evidenceMatches.length > 0,
      contractRows: contractMatches.map((row) => ({
        surface: row.surface,
        screen: row.screen,
        actionId: row.actionId,
        capabilityId: row.capabilityId,
        truthStatus: row.truthStatus,
      })),
      evidenceRefs: unique(evidenceMatches.map((row) => row.evidenceRef)),
      evidenceTruthLabels: unique(evidenceMatches.map((row) => row.truthLabel)),
    };
  });
  return {
    ...destination,
    actionTrace: actions,
    traceStatus: actions.length === 0
      ? "no_runtime_actions_declared"
      : actions.every((action) => action.designContractMatched && action.runtimeEvidenceMatched)
        ? "runtime_action_evidence_covered"
        : "trace_gaps_present",
  };
});

const productActions = tracedDestinations.flatMap((destination) => destination.actionTrace.map((action) => ({
  surface: destination.surface,
  destination: destination.id,
  tier: destination.tier,
  blockerKinds: destination.blockers.map((blocker) => blocker.kind),
  ...action,
})));
const productActionsMissingDesign = productActions.filter((action) => !action.designContractMatched);
const productActionsMissingRuntime = productActions.filter((action) => !action.runtimeEvidenceMatched);
const productActionsMissingDesignRuntimeCovered = productActionsMissingDesign
  .filter((action) => action.runtimeEvidenceMatched);
const productActionsMissingDesignRuntimeMissing = productActionsMissingDesign
  .filter((action) => !action.runtimeEvidenceMatched);
const destinationsWithoutRuntimeActions = tracedDestinations.filter((destination) => destination.runtimeActionIds.length === 0);
const destinationsWithBlockers = tracedDestinations.filter((destination) => destination.blockers.length > 0);

if (requireRuntimeEvidence && productActionsMissingRuntime.length > 0) {
  block("product_runtime_actions_missing_evidence", String(productActionsMissingRuntime.length));
}

const report = {
  truth: "uiux_action_traceability_not_endbar_not_adoption_not_gui_proof",
  status: blockers.length === 0
    ? productActionsMissingDesign.length === 0 && productActionsMissingRuntime.length === 0
      ? "product_runtime_actions_traceable"
      : "traceability_gaps_present"
    : "blocked",
  repoRoot,
  designRoot,
  actionContract: actionContractPath,
  counts: {
    contractRows: contractRows.length,
    actionableContractRows: actionableContractRows.length,
    uniqueActionableContractRows: uniqueActionableIdentities.length,
    productDestinations: tracedDestinations.length,
    productRuntimeActionIds: productActions.length,
    runtimeEvidenceInputs: runtimeEvidencePaths.length,
    runtimeEvidenceActionRows: evidenceActions.length,
    productActionsMissingDesign: productActionsMissingDesign.length,
    productActionsMissingDesignRuntimeCovered: productActionsMissingDesignRuntimeCovered.length,
    productActionsMissingDesignRuntimeMissing: productActionsMissingDesignRuntimeMissing.length,
    productActionsMissingRuntimeEvidence: productActionsMissingRuntime.length,
    destinationsWithoutRuntimeActions: destinationsWithoutRuntimeActions.length,
    destinationsStillBlocked: destinationsWithBlockers.length,
  },
  designActionRuntime: {
    status: designActionRuntimeReport?.status || "not_run",
    counts: designActionRuntimeReport?.counts || null,
    runtimeEvidenceInputs: designActionRuntimeReport?.runtimeEvidenceInputs || runtimeEvidencePaths,
  },
  bySurface: Object.fromEntries(["mobile", "desktop"].map((surface) => {
    const destinations = tracedDestinations.filter((destination) => destination.surface === surface);
    return [surface, {
      destinations: destinations.length,
      runtimeActionIds: destinations.reduce((sum, destination) => sum + destination.runtimeActionIds.length, 0),
      traceGaps: destinations.filter((destination) => destination.traceStatus === "trace_gaps_present").length,
      blockedDestinations: destinations.filter((destination) => destination.blockers.length > 0).length,
    }];
  })),
  gaps: {
    productActionsMissingDesign: productActionsMissingDesign.map(({
      surface,
      destination,
      runtimeActionId,
      tier,
      runtimeEvidenceMatched,
      evidenceRefs,
    }) => ({
      surface,
      destination,
      runtimeActionId,
      tier,
      runtimeEvidenceMatched,
      evidenceRefs,
      recommendedNext: runtimeEvidenceMatched
        ? "add or reconcile a design contract annex row; runtime action evidence is already present"
        : "capture runtime action evidence and reconcile the design contract row",
    })).slice(0, compact ? 40 : undefined),
    productActionsMissingRuntimeEvidence: productActionsMissingRuntime.map(({ surface, destination, runtimeActionId, tier, designContractMatched }) => ({
      surface,
      destination,
      runtimeActionId,
      tier,
      designContractMatched,
    })).slice(0, compact ? 40 : undefined),
    destinationsWithoutRuntimeActions: destinationsWithoutRuntimeActions.map(({ surface, id, title, tier, blockers }) => ({
      surface,
      id,
      title,
      tier,
      blockers,
    })).slice(0, compact ? 40 : undefined),
    destinationsStillBlocked: destinationsWithBlockers.map(({ surface, id, title, tier, blockers }) => ({
      surface,
      id,
      title,
      tier,
      blockers,
    })).slice(0, compact ? 40 : undefined),
  },
  destinations: compact ? undefined : tracedDestinations,
  blockers,
  caveat: "This checker proves traceability only. A green product action trace means the selected UI destination has a declared native route/action and at least one action-runtime evidence row. END-BAR still requires real user app use on mobile+desktop, same-run UI/device proof, channel/timeline/observations/stress/negative controls, and no fake or screenshot-only evidence.",
};

if (outPath) {
  const out = resolve(outPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify(report, null, compact ? 0 : 2));
process.exit(blockers.length === 0 ? 0 : 2);
