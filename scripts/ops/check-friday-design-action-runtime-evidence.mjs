#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/check-friday-design-action-runtime-evidence.mjs \\
    [--repo-root=/abs/repo] \\
    [--contract=/abs/ACTION-CONTRACT.md] \\
    [--runtime-evidence=/abs/action-runtime-evidence.json ...] \\
    [--evidence-dir=/abs/ui-device-evidence] \\
    [--out=/abs/design-action-runtime-gap.json] \\
    [--require-complete]

Truth: compares the operator-confirmed design action contract with current native
source and optional runtime action evidence. It never treats design-proof rows,
static Swift bindings, or UI/device capture bundles as END-BAR completion.`);
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

function positionalRuntimeEvidenceArgs() {
  const valueFlags = new Set([
    "--contract",
    "--evidence-dir",
    "--out",
    "--repo-root",
    "--runtime-evidence",
  ]);
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith("--")) {
      if (!value.includes("=") && valueFlags.has(value) && args[index + 1]) {
        index += 1;
      }
      continue;
    }
    values.push(value);
  }
  return values;
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const requireComplete = args.includes("--require-complete");
const repoRoot = resolve(arg("repo-root") || process.env.FRIDAY_REPO_ROOT || new URL("../..", import.meta.url).pathname);
const defaultContract = `${process.env.HOME || "/Users/jarvis"}/Desktop/friday-design-handoff-20260602/ACTION-CONTRACT.md`;
const contractPath = resolve(arg("contract") || process.env.FRIDAY_DESIGN_ACTION_CONTRACT || defaultContract);
const evidenceDir = arg("evidence-dir") || process.env.FRIDAY_UI_DEVICE_PROOF_EVIDENCE_DIR || "";
const runtimeEvidenceArgs = [...argsAll("runtime-evidence"), ...positionalRuntimeEvidenceArgs()];
const runtimeEvidenceEnv = process.env.FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE
  ? process.env.FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE.split(/[:\n]/).map((value) => value.trim()).filter(Boolean)
  : [];
const runtimeEvidenceCandidates = runtimeEvidenceArgs.length > 0
  ? runtimeEvidenceArgs
  : runtimeEvidenceEnv.length > 0
    ? runtimeEvidenceEnv
    : evidenceDir
      ? [`${evidenceDir}/action-runtime-evidence.json`]
      : [];
const runtimeEvidencePaths = runtimeEvidenceCandidates.map((value) => resolve(value));
const runtimeEvidencePath = runtimeEvidencePaths[0] || "";
const outPath = arg("out") || process.env.FRIDAY_DESIGN_ACTION_RUNTIME_REPORT || "";
const blockers = [];

function block(code, detail) {
  blockers.push({ code, detail });
}

function readOptional(path) {
  if (!path || !existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

function requireFile(path, label) {
  if (!path) {
    block("missing_file", label);
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

function splitMarkdownRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return [];
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim().replace(/`/g, ""));
}

function parseActionContract(path) {
  const contractFile = requireFile(path, "action-contract");
  if (!contractFile) return [];
  const source = readFileSync(contractFile, "utf8");
  if (!source.includes("design-proof") || !source.includes("wired_registry ≠ runtime PASS")) {
    block("contract_missing_truth_boundary", path);
  }
  const rows = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = splitMarkdownRow(line);
    if (cells.length < 9) continue;
    if (cells[0] === "---" || cells[0] === "Surface") continue;
    const [surface, rawScreen, actionId, label, capabilityId, , regStatus, truthStatus, resultTarget, ownerGateTest] = cells;
    if (!surface || !rawScreen || !actionId) continue;
    const screen = rawScreen.replace(/\s+\[.*\]$/, "");
    rows.push({
      surface,
      screen,
      screenState: rawScreen,
      actionId,
      label,
      capabilityId,
      regStatus,
      truthStatus,
      resultTarget,
      ownerGateTest,
      actionable: isActionable({ surface, actionId, capabilityId, truthStatus, resultTarget }),
    });
  }
  return rows;
}

function isActionable(row) {
  if (!["mobile", "desktop"].includes(row.surface)) return false;
  if (["disabled", "caprow"].includes(row.actionId)) return false;
  if (["action_local", "navigation_local"].includes(row.capabilityId)) return false;
  if (row.truthStatus === "historical" || row.truthStatus === "release_only") return false;
  if (String(row.resultTarget || "").startsWith("result:disabled")) return false;
  return true;
}

function readSources(paths) {
  return paths.map((relative) => readOptional(resolve(repoRoot, relative))).join("\n");
}

const nativeSources = {
  mobile: readSources([
    "apps/friday-ios/Sources/FridayMobileShell/CommandSheet.swift",
    "apps/friday-ios/Sources/FridayMobileShell/FridayApp.swift",
    "apps/friday-ios/Sources/FridayMobileShell/FridayHomeScreen.swift",
    "apps/friday-ios/Sources/FridayMobileShell/FridayChatScreen.swift",
    "apps/friday-ios/Sources/FridayMobileShell/FridaySessionDetailScreen.swift",
    "apps/friday-ios/Sources/FridayMobileShell/FridayContextPassportScreen.swift",
    "apps/friday-ios/Sources/FridayMobileShell/FridayProviderAuthScreen.swift",
    "apps/friday-ios/Sources/FridayMobileShell/FridayShareIntakeScreen.swift",
    "apps/friday-ios/Sources/FridayMobileShell/FridayTokenLedgerScreen.swift",
    "apps/friday-ios/Sources/FridayMobileShell/FridayVoiceScreen.swift",
    "apps/friday-ios/Sources/FridayMobileShell/FridayProjectionScreens.swift",
    "apps/friday-ios/Sources/FridayMobileShellCore/HomeViewModel.swift",
    "apps/friday-ios/Sources/FridayMobileShellCore/FridayChatViewModel.swift",
    "apps/friday-ios/Sources/FridayMobileShellCore/MobileProductReadinessContract.swift",
    "apps/friday-ios/Sources/FridayMobileShellCore/SessionContinuationViewModel.swift",
    "apps/friday-ios/Sources/FridayMobileShellCore/ShareIntakeViewModel.swift",
    "apps/friday-ios/Sources/FridayMobileShellCore/VoiceReadinessViewModel.swift",
  ]),
  desktop: readSources([
    "apps/macos/FridayHubConsole/Sources/FridayHubConsole/Navigation.swift",
    "apps/macos/FridayHubConsole/Sources/FridayHubConsole/OperationsOverviewScreen.swift",
    "apps/macos/FridayHubConsole/Sources/FridayHubConsole/DesktopChatScreen.swift",
    "apps/macos/FridayHubConsole/Sources/FridayHubConsole/DesktopProjectionScreens.swift",
    "apps/macos/FridayHubConsole/Sources/FridayHubConsole/PairingProvisioningScreen.swift",
    "apps/macos/FridayHubConsole/Sources/FridayHubConsoleCore/DesktopProductReadinessContract.swift",
    "apps/macos/FridayHubConsole/Sources/FridayHubConsoleCore/OperationsOverviewViewModel.swift",
  ]),
};

function normalizedWords(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3);
}

function nativeHint(row) {
  const source = nativeSources[row.surface] || "";
  if (!source) return "source_missing";
  const lower = source.toLowerCase();
  const screenWords = normalizedWords(row.screen);
  const labelWords = normalizedWords(row.label);
  const capabilityWords = normalizedWords(row.capabilityId.replace(/_/g, " "));
  const screenHit = screenWords.length === 0 || screenWords.some((word) => lower.includes(word));
  const labelHit = labelWords.length === 0 || labelWords.some((word) => lower.includes(word));
  const capabilityHit = capabilityWords.slice(0, 2).some((word) => lower.includes(word));
  if (screenHit && (labelHit || capabilityHit)) return "native_source_hint_present_not_runtime_proof";
  if (screenHit) return "screen_hint_present_action_unproven";
  return "native_hint_missing";
}

function readRuntimeEvidence(path) {
  if (!path || !existsSync(path)) return [];
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    const rows = Array.isArray(value) ? value : Array.isArray(value.actions) ? value.actions : [];
    return rows
      .filter((row) => row && typeof row === "object")
      .map((row) => ({
        surface: String(row.surface || ""),
        screen: String(row.screen || ""),
        actionId: String(row.action_id || row.actionId || ""),
        capabilityId: String(row.capability_id || row.capabilityId || ""),
        status: String(row.status || ""),
        evidenceRef: String(row.evidence_ref || row.evidenceRef || ""),
      }));
  } catch {
    block("runtime_evidence_invalid_json", path);
    return [];
  }
}

function runtimeEvidenceFor(row, runtimeRows) {
  return runtimeRows.find((candidate) => {
    if (candidate.status !== "pass") return false;
    if (candidate.surface && candidate.surface !== row.surface) return false;
    if (candidate.screen && candidate.screen !== row.screen) return false;
    if (candidate.actionId && row.actionId && candidate.actionId !== row.actionId) return false;
    if (candidate.capabilityId && row.capabilityId) return candidate.capabilityId === row.capabilityId;
    if (candidate.actionId && row.actionId) return true;
    return candidate.capabilityId === row.capabilityId;
  }) || null;
}

function summarizeBy(rows, key) {
  const counts = new Map();
  for (const row of rows) {
    const value = row[key] || "unknown";
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

function actionKey(row) {
  return [
    row.surface,
    row.screen,
    row.actionId,
    row.capabilityId,
  ].join("|");
}

function uniqueRows(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = actionKey(row);
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return [...byKey.values()];
}

const contractRows = parseActionContract(contractPath);
const runtimeRows = runtimeEvidencePaths.flatMap((path) => readRuntimeEvidence(path));
const actionableRows = contractRows.filter((row) => row.actionable);
const evidenceRows = actionableRows.map((row) => {
  const runtime = runtimeEvidenceFor(row, runtimeRows);
  return {
    surface: row.surface,
    screen: row.screen,
    screenState: row.screenState,
    actionId: row.actionId,
    label: row.label,
    capabilityId: row.capabilityId,
    truthStatus: row.truthStatus,
    nativeStatus: nativeHint(row),
    runtimeStatus: runtime ? "runtime_action_evidence_pass" : "runtime_action_evidence_missing",
    evidenceRef: runtime?.evidenceRef || null,
  };
});

const missingRuntime = evidenceRows.filter((row) => row.runtimeStatus !== "runtime_action_evidence_pass");
const missingNative = evidenceRows.filter((row) => row.nativeStatus === "native_hint_missing" || row.nativeStatus === "source_missing");
const uniqueActionableRows = uniqueRows(actionableRows);
const uniqueEvidenceRows = uniqueRows(evidenceRows);
const missingUniqueRuntime = uniqueRows(uniqueEvidenceRows.filter((row) => row.runtimeStatus !== "runtime_action_evidence_pass"));
const topMissing = missingRuntime.slice(0, 40).map((row) => ({
  surface: row.surface,
  screen: row.screen,
  actionId: row.actionId,
  label: row.label,
  capabilityId: row.capabilityId,
  preferredEvidence: `${row.surface}/${row.screen}/${row.actionId}`,
}));

const report = {
  truth: "design_action_runtime_gap_report_not_endbar_not_runtime_adoption",
  status: blockers.length === 0 && missingRuntime.length === 0 ? "runtime_actions_covered" : "gaps_present",
  repoRoot,
  contract: contractPath,
  runtimeEvidence: existsSync(runtimeEvidencePath) ? runtimeEvidencePath : null,
  runtimeEvidenceInputs: runtimeEvidencePaths.filter((path) => existsSync(path)),
  counts: {
    contractRows: contractRows.length,
    actionableRows: actionableRows.length,
    uniqueActionableRows: uniqueActionableRows.length,
    runtimeEvidenceRows: runtimeRows.length,
    missingRuntimeEvidence: missingRuntime.length,
    missingUniqueRuntimeEvidence: missingUniqueRuntime.length,
    missingNativeHints: missingNative.length,
  },
  bySurface: summarizeBy(actionableRows, "surface"),
  byTruthStatus: summarizeBy(actionableRows, "truthStatus"),
  gaps: {
    missingRuntimeEvidence: topMissing,
    missingUniqueRuntimeEvidence: missingUniqueRuntime.slice(0, 40).map((row) => ({
      surface: row.surface,
      screen: row.screen,
      actionId: row.actionId,
      label: row.label,
      capabilityId: row.capabilityId,
      preferredEvidence: `${row.surface}/${row.screen}/${row.actionId}`,
    })),
    missingNativeHints: missingNative.slice(0, 40),
  },
  capturePlan: [
    ...new Set(topMissing.map((row) => `${row.surface}:${row.screen}`)),
  ].slice(0, 24).map((target) => ({
    target,
    required: "capture a real same-run UI action observation with surface, screen, action_id/capability_id, status=pass, and evidence_ref",
    truth: "real_runtime_action_evidence_only_no_design_proof_upgrade",
  })),
  blockers,
  caveat: "Design action rows and native source hints are not runtime proof. Missing runtime evidence means the action cannot be counted toward END-BAR even when design and Swift bindings exist.",
};

if (outPath) {
  const out = isAbsolute(outPath) ? outPath : resolve(outPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify(report, null, 2));
const complete = report.status === "runtime_actions_covered";
process.exit((complete || !requireComplete) && blockers.length === 0 ? 0 : 2);
