#!/usr/bin/env node

import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const forbiddenTruth = /(synthetic|fixture|sample|dry[-_ ]?run|screenshot[-_ ]?only|design[-_ ]?proof|mock|placeholder)/i;

function usage() {
  console.error(`usage:
  node scripts/ops/friday-ios-sim-xcui-observation.mjs \\
    --mission-id=mission_... --out-dir=/abs/out-dir
    [--repo-root=/abs/repo] [--bundle-id=com.friday.shell]
    [--xcode-destination='platform=iOS Simulator,name=iPhone 17 Pro']
    [--destinations=home,fridayChat,...] [--timeout-seconds=90]
    [--normalize] [--require-observed] [--require-all-planned]

Truth:
  Runs the checked-in Xcode UI-test bundle against an installed real iOS
  Simulator Friday app, captures XCUIApplication.debugDescription, and converts
  only observed accessibility identifiers into the real observation JSON consumed
  by friday-ios-sim-accessibility-capture.mjs. It does not infer truth from
  screenshots or static Swift source, does not click governed actions, and is
  not END-BAR/adoption proof.`);
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

const repoRoot = resolve(arg("repo-root") || process.env.FRIDAY_REPO_ROOT || new URL("../..", import.meta.url).pathname);
const missionId = arg("mission-id");
const outDir = arg("out-dir");
const bundleId = arg("bundle-id") || process.env.FRIDAY_IOS_SIM_BUNDLE_ID || "com.friday.shell";
const xcodeDestination = arg("xcode-destination") || process.env.FRIDAY_IOS_XCUI_DESTINATION || "platform=iOS Simulator,name=iPhone 17 Pro";
const destinations = (arg("destinations") || process.env.FRIDAY_IOS_XCUI_OBSERVATION_DESTINATIONS || "home")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const timeoutSeconds = Number(arg("timeout-seconds") || process.env.FRIDAY_IOS_XCUI_OBSERVATION_TIMEOUT_SECONDS || "90");
const normalize = args.includes("--normalize");
const requireObserved = args.includes("--require-observed");
const requireAllPlanned = args.includes("--require-all-planned");
const blockers = [];
const warnings = [];

function block(code, detail) {
  blockers.push({ code, detail });
}

function run(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });
}

function jsonOut(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function requireAbsoluteDir(label, value) {
  if (!value) {
    block("missing_arg", label);
    return "";
  }
  if (!isAbsolute(value)) {
    block("path_not_absolute", `${label}:${value}`);
    return "";
  }
  return value;
}

function parseJson(label, text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    block("invalid_json", `${label}:${error.message}`);
    return null;
  }
}

function destinationName() {
  const match = xcodeDestination.match(/(?:^|,)name=([^,]+)/);
  return match?.[1]?.trim() || "";
}

function resolveSimulator() {
  const list = run("xcrun", ["simctl", "list", "devices", "--json"]);
  if (list.status !== 0) {
    block("simctl_list_failed", list.stderr.trim() || list.stdout.trim() || String(list.status));
    return null;
  }
  const parsed = parseJson("simctl_list", list.stdout);
  if (!parsed) return null;
  const wantedName = destinationName();
  const devices = Object.values(parsed.devices || {}).flat().filter((device) => device && device.isAvailable !== false);
  const selected = wantedName
    ? devices.find((device) => String(device.name || "") === wantedName)
    : devices.find((device) => String(device.state || "") === "Booted" && /iPhone|iPad/i.test(String(device.name || "")));
  if (!selected) {
    block("ios_simulator_not_available", wantedName || "booted iPhone/iPad");
    return null;
  }
  if (selected.state !== "Booted") {
    const boot = run("xcrun", ["simctl", "boot", selected.udid]);
    if (boot.status !== 0 && !/Unable to boot device in current state: Booted/i.test(`${boot.stderr}\n${boot.stdout}`)) {
      block("ios_simulator_boot_failed", boot.stderr.trim() || boot.stdout.trim() || String(boot.status));
      return null;
    }
    const bootstatus = run("xcrun", ["simctl", "bootstatus", selected.udid, "-b"], { timeout: 60_000 });
    if (bootstatus.status !== 0) {
      block("ios_simulator_bootstatus_failed", bootstatus.stderr.trim() || bootstatus.stdout.trim() || String(bootstatus.status));
      return null;
    }
  }
  return {
    udid: selected.udid,
    name: String(selected.name || ""),
    destination: xcodeDestination,
  };
}

function ensureInstalled(simulator) {
  const container = run("xcrun", ["simctl", "get_app_container", simulator.udid, bundleId, "data"]);
  if (container.status !== 0) {
    block("app_container_unavailable", container.stderr.trim() || container.stdout.trim() || `${bundleId}:${simulator.udid}`);
    return null;
  }
  const dataContainer = container.stdout.trim().split(/\r?\n/).at(-1) || "";
  if (!isAbsolute(dataContainer)) block("app_container_not_absolute", dataContainer || "<missing>");
  return dataContainer;
}

function readPlan(destination) {
  const planDir = resolve(outDir, "plan", destination);
  rmSync(planDir, { recursive: true, force: true });
  const result = run("node", [
    resolve(repoRoot, "scripts/ops/friday-ios-sim-accessibility-capture.mjs"),
    "--plan-only",
    `--repo-root=${repoRoot}`,
    `--mission-id=${missionId}`,
    `--out-dir=${planDir}`,
    `--destinations=${destination}`,
  ]);
  if (result.status !== 0) {
    block("target_plan_failed", result.stderr.trim() || result.stdout.trim() || `${destination}:${result.status}`);
    return [];
  }
  const summary = parseJson(`target_plan:${destination}`, result.stdout);
  return Array.isArray(summary?.targets) ? summary.targets : [];
}

function launchDestination(simulator, destination) {
  const launch = run("xcrun", [
    "simctl",
    "launch",
    "--terminate-running-process",
    simulator.udid,
    bundleId,
    `--initial-destination=${destination}`,
  ]);
  if (launch.status !== 0) {
    block("app_launch_failed", launch.stderr.trim() || launch.stdout.trim() || `${bundleId}:${destination}`);
    return null;
  }
  return launch.stdout.trim();
}

function extractAxTree(log) {
  const match = log.match(/FRIDAY_AX_DESC_BEGIN\r?\n([\s\S]*?)\r?\nFRIDAY_AX_DESC_END/);
  return match?.[1] || "";
}

function runXcui(destination) {
  const project = resolve(repoRoot, "apps/friday-ios/UITests/FridayIOSAXObserver.xcodeproj");
  const result = run("xcodebuild", [
    "-project",
    project,
    "-scheme",
    "FridayIOSAXObserver",
    "-destination",
    xcodeDestination,
    "-skipPackagePluginValidation",
    "-skipMacroValidation",
    "test",
  ], {
    timeout: Math.max(timeoutSeconds * 1000, 30_000),
  });
  const log = `${result.stdout || ""}${result.stderr || ""}`;
  const logPath = resolve(outDir, `ios-xcui-${destination}.log`);
  const treePath = resolve(outDir, `ios-xcui-${destination}-accessibility-tree.txt`);
  writeFileSync(logPath, log);
  const tree = extractAxTree(log);
  if (result.status !== 0) block("xcodebuild_ui_test_failed", `${destination}:${result.status}:${logPath}`);
  if (!tree.trim()) block("accessibility_tree_missing", `${destination}:${logPath}`);
  if (tree.trim()) writeFileSync(treePath, `${tree}\n`);
  return { logPath, treePath, tree, status: result.status };
}

function observedRows(destination, targets, tree, treePath) {
  const rows = [];
  const missing = [];
  for (const target of targets) {
    const accessibilityIds = Array.isArray(target.accessibilityIds) ? target.accessibilityIds : [];
    const matched = accessibilityIds.find((id) => tree.includes(`identifier: '${id}'`) || tree.includes(`identifier: "${id}"`) || tree.includes(id));
    if (!matched) {
      missing.push(target.runtimeActionId || "<unknown>");
      continue;
    }
    rows.push({
      screen: String(target.screen || target.destination || destination),
      runtimeActionId: String(target.runtimeActionId || ""),
      accessibility_id: matched,
      interaction: String(target.interaction || "visible"),
      status: "pass",
      event: String(target.event || "mission_workbench_visible"),
      evidence_type: "xctest_accessibility",
      evidence_ref: treePath,
      captured_at: new Date().toISOString(),
      matched_by: "xctest_debug_description_accessibility_identifier",
    });
  }
  return { rows, missing };
}

if (!missionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(missionId) || !missionId.toLowerCase().includes("mission")) {
  block("mission_id_unexpected_shape", missionId || "<missing>");
}
requireAbsoluteDir("out-dir", outDir);
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 10) block("timeout_seconds_invalid", String(timeoutSeconds));
if (bundleId !== "com.friday.shell") block("bundle_id_not_supported_by_checked_in_ui_test", bundleId);
if (destinations.length === 0) block("destinations_missing", "<empty>");

let simulator = null;
let dataContainer = null;
const allTargets = [];
const observations = [];
const missingByDestination = {};
const xcodeRuns = [];

if (blockers.length === 0) {
  mkdirSync(outDir, { recursive: true });
  simulator = resolveSimulator();
}
if (blockers.length === 0 && simulator) dataContainer = ensureInstalled(simulator);

if (blockers.length === 0 && simulator) {
  for (const destination of destinations) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(destination)) {
      block("destination_invalid", destination);
      continue;
    }
    const targets = readPlan(destination);
    allTargets.push(...targets.map((target) => ({ ...target, destination })));
    if (blockers.length > 0) break;
    const launchStdout = launchDestination(simulator, destination);
    if (blockers.length > 0) break;
    const runResult = runXcui(destination);
    xcodeRuns.push({
      destination,
      launch_stdout: launchStdout,
      status: runResult.status,
      log_path: runResult.logPath,
      tree_path: runResult.tree.trim() ? runResult.treePath : null,
    });
    const { rows, missing } = observedRows(destination, targets, runResult.tree, runResult.treePath);
    observations.push(...rows);
    missingByDestination[destination] = missing;
  }
}

if (requireObserved && observations.length === 0) block("observed_actions_missing", "no matching real XCUITest accessibility identifiers");
if (requireAllPlanned) {
  for (const [destination, missing] of Object.entries(missingByDestination)) {
    if (missing.length > 0) block("planned_actions_missing", `${destination}:${missing.join(",")}`);
  }
}

const evidenceRef = xcodeRuns.find((runInfo) => runInfo.tree_path)?.tree_path || xcodeRuns[0]?.log_path || "";
let observationPath = null;
let normalizer = null;
if (blockers.length === 0) {
  if (evidenceRef) {
    const stats = statSync(evidenceRef);
    if (!stats.isFile() || stats.size <= 0) block("evidence_ref_invalid", evidenceRef);
  }
}

if (blockers.length === 0) {
  const observation = {
    truth_label: "ios_simulator_accessibility_observation_real_ui",
    mission_id: missionId,
    bundle_id: bundleId,
    udid: simulator?.udid || null,
    capture_method: "ios_simulator_accessibility",
    evidence_type: "xctest_accessibility",
    evidence_ref: evidenceRef,
    source: "xcode_ui_test_xcapplication_debug_description",
    destinations,
    observations,
  };
  if (forbiddenTruth.test(observation.truth_label) || forbiddenTruth.test(observation.source)) {
    block("truth_source_forbidden", observation.source);
  } else {
    observationPath = resolve(outDir, "ios-xcui-accessibility-observation.json");
    jsonOut(observationPath, observation);
  }
}

if (blockers.length === 0 && normalize && observationPath) {
  const normalizedOut = resolve(outDir, "normalized");
  const result = run("node", [
    resolve(repoRoot, "scripts/ops/friday-ios-sim-accessibility-capture.mjs"),
    "--real",
    "--normalize",
    "--require-observed",
    `--repo-root=${repoRoot}`,
    `--mission-id=${missionId}`,
    `--out-dir=${resolve(outDir, "capture")}`,
    `--normalizer-out-dir=${normalizedOut}`,
    `--destinations=${destinations.join(",")}`,
    `--observation=${observationPath}`,
    `--bundle-id=${bundleId}`,
    `--udid=${simulator?.udid || ""}`,
  ]);
  normalizer = {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    out_dir: normalizedOut,
  };
  if (result.status !== 0) block("normalizer_failed", result.stderr.trim() || result.stdout.trim() || String(result.status));
}

const summary = {
  generated_at_utc: new Date().toISOString(),
  truth: blockers.length === 0
    ? "ios_sim_xcui_observation_real_ui_not_endbar"
    : "ios_sim_xcui_observation_blocked_not_runtime_proof",
  status: blockers.length === 0 ? "observation_ready" : "blocked",
  missionId: missionId || null,
  simulator,
  bundle_id: bundleId,
  data_container: dataContainer,
  target_count: allTargets.length,
  observed_count: observations.length,
  destinations,
  xcode_runs: xcodeRuns,
  outputs: {
    observation: observationPath,
    normalized: normalizer?.out_dir || null,
    summary: outDir ? resolve(outDir, "ios-xcui-observation-summary.json") : null,
  },
  missing_by_destination: missingByDestination,
  warnings,
  blockers,
  caveats: [
    "This is real XCUITest accessibility observation against an installed Simulator app, not a screenshot or static source proof.",
    "It only proves identifiers visible on the launched destinations; product END-BAR still needs the broader same-run mobile+desktop proof bundle.",
    "The UI test does not click governed actions or provide operator signatures.",
  ],
};
if (outDir && isAbsolute(outDir)) jsonOut(resolve(outDir, "ios-xcui-observation-summary.json"), summary);
console.log(JSON.stringify(summary, null, 2));
process.exit(blockers.length > 0 ? 2 : 0);
