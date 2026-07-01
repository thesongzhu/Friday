#!/usr/bin/env node

import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    [--live-loopback] [--live-device-peer]
    [--interaction-scenarios=missions=missions-dispatch,shareIntake=share-submit]
    [--interaction-text='...'] [--interaction-url='https://...']
    [--normalize] [--require-observed] [--require-all-planned]
    [--require-selected-design]

Truth:
  Runs the checked-in Xcode UI-test bundle against an installed real iOS
  Simulator Friday app, captures XCUIApplication.debugDescription, and converts
  only observed accessibility identifiers into the real observation JSON consumed
  by friday-ios-sim-accessibility-capture.mjs. By default it only observes. When
  --interaction-scenarios is supplied, it performs only the named explicit UI
  interactions and waits for the resulting receipt identifiers. It does not infer
  truth from screenshots or static Swift source, does not click unknown governed
  actions, and is not END-BAR/adoption proof.`);
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
const liveLoopback = args.includes("--live-loopback") || process.env.FRIDAY_IOS_XCUI_LIVE_LOOPBACK === "1";
const liveDevicePeer = args.includes("--live-device-peer") || process.env.FRIDAY_IOS_XCUI_LIVE_DEVICE_PEER === "1";
const interactionScenarioCsv = arg("interaction-scenarios") || process.env.FRIDAY_IOS_XCUI_INTERACTION_SCENARIOS || "";
const interactionText = arg("interaction-text") || process.env.FRIDAY_IOS_XCUI_INTERACTION_TEXT || "Friday UI live interaction proof";
const interactionUrl = arg("interaction-url") || process.env.FRIDAY_IOS_XCUI_INTERACTION_URL || "https://example.com/friday-ui-proof";
const interactionFilePath = arg("interaction-file")
  || process.env.FRIDAY_IOS_AX_INTERACTION_FILE
  || (outDir ? resolve(outDir, "ios-xcui-interaction-request.json") : "/tmp/friday-ios-ax-interaction-current.json");
const attachRunning = args.includes("--attach-running") || process.env.FRIDAY_IOS_XCUI_ATTACH_RUNNING_APP === "1";
const normalize = args.includes("--normalize");
const requireObserved = args.includes("--require-observed");
const requireAllPlanned = args.includes("--require-all-planned");
const requireSelectedDesign = args.includes("--require-selected-design")
  || process.env.FRIDAY_IOS_XCUI_REQUIRE_SELECTED_DESIGN === "1";
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

function parseInteractionScenarios(value) {
  const map = new Map();
  for (const raw of String(value || "").split(",")) {
    const item = raw.trim();
    if (!item) continue;
    const [destination, scenario] = item.split("=").map((part) => part?.trim() || "");
    if (!destination || !scenario) {
      block("interaction_scenario_invalid", item);
      continue;
    }
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(destination)) {
      block("interaction_destination_invalid", destination);
      continue;
    }
    if (!/^[a-z][a-z0-9-]*$/.test(scenario)) {
      block("interaction_scenario_name_invalid", scenario);
      continue;
    }
    map.set(destination, scenario);
  }
  return map;
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

function mobileLaunchEnv() {
  const env = {};
  if (!liveLoopback) return env;
  env.SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_READ = "1";
  env.SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_WRITE = "1";
  env.SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_PAIRING = "1";
  if (!liveDevicePeer) {
    env.SIMCTL_CHILD_FRIDAY_MOBILE_DISABLE_PRODUCT_LIVE_LOOPBACK = "1";
  }
  if (liveDevicePeer) {
    env.SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_DEVICE_KEYPAIR = "1";
    env.SIMCTL_CHILD_FRIDAY_MOBILE_SIMULATOR_FILE_DEVICE_KEYPAIR = "1";
  }
  if (process.env.FRIDAY_MOBILE_LIVE_READ_HOST) env.SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_READ_HOST = process.env.FRIDAY_MOBILE_LIVE_READ_HOST;
  if (process.env.FRIDAY_MOBILE_LIVE_READ_PORT) env.SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_READ_PORT = process.env.FRIDAY_MOBILE_LIVE_READ_PORT;
  if (process.env.FRIDAY_MOBILE_LIVE_WRITE_HOST) env.SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_WRITE_HOST = process.env.FRIDAY_MOBILE_LIVE_WRITE_HOST;
  if (process.env.FRIDAY_MOBILE_LIVE_WRITE_PORT) env.SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_WRITE_PORT = process.env.FRIDAY_MOBILE_LIVE_WRITE_PORT;
  if (process.env.FRIDAY_MASTER_KEY) env.SIMCTL_CHILD_FRIDAY_MASTER_KEY = process.env.FRIDAY_MASTER_KEY;
  if (missionId) env.SIMCTL_CHILD_FRIDAY_MOBILE_MISSION_ID = missionId;
  return env;
}

function appLaunchEnv() {
  const env = {};
  if (!liveLoopback) return env;
  env.FRIDAY_MOBILE_LIVE_READ = "1";
  env.FRIDAY_MOBILE_LIVE_WRITE = "1";
  env.FRIDAY_MOBILE_LIVE_PAIRING = "1";
  if (!liveDevicePeer) {
    env.FRIDAY_MOBILE_DISABLE_PRODUCT_LIVE_LOOPBACK = "1";
  }
  if (liveDevicePeer) {
    env.FRIDAY_MOBILE_LIVE_DEVICE_KEYPAIR = "1";
    env.FRIDAY_MOBILE_SIMULATOR_FILE_DEVICE_KEYPAIR = "1";
  }
  if (process.env.FRIDAY_MOBILE_LIVE_READ_HOST) env.FRIDAY_MOBILE_LIVE_READ_HOST = process.env.FRIDAY_MOBILE_LIVE_READ_HOST;
  if (process.env.FRIDAY_MOBILE_LIVE_READ_PORT) env.FRIDAY_MOBILE_LIVE_READ_PORT = process.env.FRIDAY_MOBILE_LIVE_READ_PORT;
  if (process.env.FRIDAY_MOBILE_LIVE_WRITE_HOST) env.FRIDAY_MOBILE_LIVE_WRITE_HOST = process.env.FRIDAY_MOBILE_LIVE_WRITE_HOST;
  if (process.env.FRIDAY_MOBILE_LIVE_WRITE_PORT) env.FRIDAY_MOBILE_LIVE_WRITE_PORT = process.env.FRIDAY_MOBILE_LIVE_WRITE_PORT;
  if (process.env.FRIDAY_MASTER_KEY) env.FRIDAY_MASTER_KEY = process.env.FRIDAY_MASTER_KEY;
  if (missionId) env.FRIDAY_MOBILE_MISSION_ID = missionId;
  return env;
}

function scenarioAppLaunchEnv(scenario) {
  if (scenario === "pairing-retry") {
    return {
      FRIDAY_MOBILE_SIMULATOR_FILE_DEVICE_KEYPAIR: "1",
      FRIDAY_MOBILE_UITEST_PAIRING_ACK: "denied",
    };
  }
  if (scenario === "pairing-cancel") {
    return {
      FRIDAY_MOBILE_SIMULATOR_FILE_DEVICE_KEYPAIR: "1",
      FRIDAY_MOBILE_UITEST_PAIRING_ACK: "delayed_accepted",
      FRIDAY_MOBILE_UITEST_PAIRING_DELAY_MS: "5000",
    };
  }
  return {};
}

function scenarioRuntimeActionIds(scenario) {
  switch (scenario) {
    case "missions-dispatch":
      return new Set(["mobile/missions/dispatch", "mobile/missions/open-chat-loop"]);
    case "share-submit":
      return new Set(["mobile/share/send", "mobile/share/open-chat-loop"]);
    case "new-session-launch":
      return new Set(["mobile/newSession/play", "mobile/newSession/open-chat-loop"]);
    case "voice-open-chat":
      return new Set(["mobile/voice/open-chat-loop", "mobile/fridayChat/voice-input", "mobile/fridayChat/voice-output"]);
    case "settings-push-permission":
      return new Set(["mobile/settings/push-permission"]);
    case "pairing-retry":
      return new Set(["mobile/firstlaunch/retry"]);
    case "pairing-cancel":
      return new Set(["mobile/firstlaunch/cancel"]);
    case "session-sidecar-open":
      return new Set(["mobile/session/sidecar/open", "mobile/session/sidecar/close"]);
    default:
      return null;
  }
}

function appLaunchEnvForRequestFile(scenario) {
  const env = appLaunchEnv();
  Object.assign(env, scenarioAppLaunchEnv(scenario));
  delete env.FRIDAY_MASTER_KEY;
  return env;
}

function appLaunchArgs(destination) {
  const launchArgs = [];
  if (liveLoopback) {
    launchArgs.push(
      "--live-read",
      "--live-write",
      "--live-pairing",
      `--mission-id=${missionId}`,
    );
    if (!liveDevicePeer) {
      launchArgs.push("--disable-product-live-loopback");
    }
    if (liveDevicePeer) {
      launchArgs.push("--live-device-keypair", "--simulator-file-device-keypair");
    }
    if (process.env.FRIDAY_MOBILE_LIVE_READ_HOST) launchArgs.push("--live-read-host", process.env.FRIDAY_MOBILE_LIVE_READ_HOST);
    if (process.env.FRIDAY_MOBILE_LIVE_READ_PORT) launchArgs.push("--live-read-port", process.env.FRIDAY_MOBILE_LIVE_READ_PORT);
    if (process.env.FRIDAY_MOBILE_LIVE_WRITE_HOST) launchArgs.push("--live-write-host", process.env.FRIDAY_MOBILE_LIVE_WRITE_HOST);
    if (process.env.FRIDAY_MOBILE_LIVE_WRITE_PORT) launchArgs.push("--live-write-port", process.env.FRIDAY_MOBILE_LIVE_WRITE_PORT);
  }
  launchArgs.push(`--initial-destination=${destination}`);
  return launchArgs;
}

function writeMasterKeyFile() {
  const value = process.env.FRIDAY_MASTER_KEY || "";
  if (!liveLoopback || !value.trim() || !outDir) return null;
  const file = resolve(outDir, "ios-xcui-master-key.env");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${value.trim()}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

function launchDestination(simulator, destination) {
  if (!attachRunning) {
    run("xcrun", ["simctl", "terminate", simulator.udid, bundleId]);
    return `xctest-launch:${destination}`;
  }
  const launch = run("xcrun", [
    "simctl",
    "launch",
    "--terminate-running-process",
    simulator.udid,
    bundleId,
    ...appLaunchArgs(destination),
  ], {
    env: {
      ...process.env,
      ...mobileLaunchEnv(),
      SIMCTL_CHILD_FRIDAY_MOBILE_INITIAL_DESTINATION: destination,
    },
  });
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

function writeInteractionFile(destination, scenario) {
  const path = interactionFilePath;
  if (!scenario && !liveLoopback) {
    rmSync(path, { force: true });
    return "";
  }
  const payload = {
    destination,
    scenario: scenario || null,
    text: interactionText,
    url: interactionUrl,
    appLaunchArgs: appLaunchArgs(destination),
    appLaunchEnv: appLaunchEnvForRequestFile(scenario),
    masterKeyFile: writeMasterKeyFile(),
    generated_at_utc: new Date().toISOString(),
    truth: "ios_xcui_explicit_interaction_request_not_proof",
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
  if (path !== "/tmp/friday-ios-ax-interaction-current.json") {
    writeFileSync("/tmp/friday-ios-ax-interaction-current.json", `${JSON.stringify(payload, null, 2)}\n`);
  }
  return path;
}

function runXcui(destination, scenario) {
  const interactionFile = writeInteractionFile(destination, scenario);
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
    env: {
      ...process.env,
      ...(scenario ? {
        FRIDAY_IOS_AX_INTERACTION_SCENARIO: scenario,
        FRIDAY_IOS_AX_INTERACTION_TEXT: interactionText,
        FRIDAY_IOS_AX_INTERACTION_URL: interactionUrl,
        FRIDAY_IOS_AX_INTERACTION_FILE: interactionFile || interactionFilePath,
      } : {}),
      FRIDAY_IOS_AX_APP_LAUNCH_ARGS_JSON: JSON.stringify(appLaunchArgs(destination)),
      FRIDAY_IOS_AX_APP_ENV_JSON: JSON.stringify({
        ...appLaunchEnv(),
        ...scenarioAppLaunchEnv(scenario),
      }),
      FRIDAY_IOS_AX_INTERACTION_FILE: interactionFile || interactionFilePath,
      ...(attachRunning ? { FRIDAY_IOS_AX_ATTACH_RUNNING_APP: "1" } : {}),
    },
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
  return { logPath, treePath, tree, status: result.status, interactionFile };
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

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function treeIncludesIdentifier(tree, id) {
  return new RegExp(`identifier:\\s*['"]${escapedRegExp(id)}['"]`).test(tree);
}

function assertSelectedDesignTree(destination, tree) {
  if (!requireSelectedDesign) return;

  const forbiddenRawProductPatterns = [
    ["provider auth machine code", /\bapi_key_missing\b/i],
    ["route validation machine code", /\broute_validation_not_ok\b/i],
    ["route disabled machine code", /\bfriday_[a-z0-9_]+_route_disabled\b/i],
    ["raw blockers label", /\bblockers:\s/i],
    ["learning candidate machine summary", /\bcandidate_kind=/i],
    ["transport debug copy", /server dark\?/i],
    ["internal diagnostics copy", /\binternal mobile diagnostics\b/i],
    ["honest-unavailable product copy", /\bhonest[-_ ]unavailable\b/i],
  ];
  for (const [name, pattern] of forbiddenRawProductPatterns) {
    if (pattern.test(tree)) {
      block("selected_design_raw_product_copy_visible", `${name}:${destination}`);
    }
  }

  const requiredByDestination = {
    home: [
      "friday.mobile.toolbar.command-sheet",
      "friday.mobile.toolbar.chat",
      "friday.mobile.toolbar.refresh",
      "friday.home.selected-design-intro",
      "friday.home.selected-hero-pet",
    ],
  };
  for (const id of requiredByDestination[destination] || []) {
    if (!treeIncludesIdentifier(tree, id)) {
      block("selected_design_required_id_missing", `${destination}:${id}`);
    }
  }

  if (destination === "home") {
    const forbiddenHomePatterns = [
      ["legacy Friday Home title", /\bFriday Home\b/i],
      ["offline landing state", /\bFriday is offline\b/i],
      ["debug no-cache status copy", /No cached or fabricated status is shown/i],
      ["home pairing setup panel", /\bDevice pairing\b/i],
      ["home provisioning setup panel", /\bHub provisioning\b/i],
      ["disabled setup badge", /\bdisabled\b/i],
      ["not-loaded setup badge", /\bnot loaded\b/i],
      ["read-off setup badge", /\bread off\b/i],
      ["write-off setup badge", /\bwrite off\b/i],
      ["home unavailable identifier", /identifier:\s*['"]friday\.home\.unavailable['"]/i],
    ];
    for (const [name, pattern] of forbiddenHomePatterns) {
      if (pattern.test(tree)) {
        block("selected_design_forbidden_home_state_visible", `${name}:${destination}`);
      }
    }
  }
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
const interactionScenarios = parseInteractionScenarios(interactionScenarioCsv);

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
    const scenario = interactionScenarios.get(destination) || "";
    const scenarioActions = scenarioRuntimeActionIds(scenario);
    const targets = scenarioActions
      ? readPlan(destination).filter((target) => scenarioActions.has(String(target.runtimeActionId || "")))
      : readPlan(destination);
    allTargets.push(...targets.map((target) => ({ ...target, destination })));
    if (blockers.length > 0) break;
    const launchStdout = launchDestination(simulator, destination);
    if (blockers.length > 0) break;
    const runResult = runXcui(destination, scenario);
    assertSelectedDesignTree(destination, runResult.tree);
    xcodeRuns.push({
      destination,
      interaction_scenario: scenario || null,
      interaction_file: runResult.interactionFile || null,
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
  live_loopback_requested: liveLoopback,
  live_device_peer_requested: liveDevicePeer,
  selected_design_required: requireSelectedDesign,
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
    "When interaction_scenario is non-null, the checked-in UI test typed/tapped only that explicit scenario and waited for the resulting receipt identifier.",
    "It only proves identifiers visible on the launched destinations; product END-BAR still needs the broader same-run mobile+desktop proof bundle.",
    "The UI test never provides operator signatures.",
  ],
};
if (outDir && isAbsolute(outDir)) jsonOut(resolve(outDir, "ios-xcui-observation-summary.json"), summary);
console.log(JSON.stringify(summary, null, 2));
process.exit(blockers.length > 0 ? 2 : 0);
