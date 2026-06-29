#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/friday-desktop-ax-accessibility-capture.mjs \\
    --mission-id=mission_... --out-dir=/abs/out-dir
    [--repo-root=/abs/repo] [--app-dir=/abs/FridayHubConsole.app]
    [--destinations=operations,chat,...] [--workbench-mission-id=mission_...]
    [--timeout-seconds=20] [--tree-depth=5] [--plan-only] [--require-observed]

Truth:
  Launches or attaches to the real macOS FridayHubConsole app, navigates selected
  desktop destinations via Accessibility, and emits a real accessibility capture
  JSON accepted by friday-ui-device-accessibility-click-capture.mjs. It does not
  fabricate clicks, does not use screenshots as proof, does not click governed or
  destructive actions, and is not END-BAR/adoption proof.`);
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
const appDirArg = arg("app-dir") || process.env.FRIDAY_HUB_CONSOLE_APP_DIR || "";
const destinationsCsv = arg("destinations") || process.env.FRIDAY_DESKTOP_AX_CAPTURE_DESTINATIONS || "";
const workbenchMissionId = arg("workbench-mission-id") || process.env.FRIDAY_DESKTOP_AX_WORKBENCH_MISSION_ID || "";
const timeoutSeconds = Number(arg("timeout-seconds") || process.env.FRIDAY_DESKTOP_AX_CAPTURE_TIMEOUT_SECONDS || "20");
const treeDepth = Number(arg("tree-depth") || process.env.FRIDAY_DESKTOP_AX_TREE_DEPTH || "5");
const axTraversalDepth = Number.isInteger(treeDepth) ? treeDepth : 5;
const overallStartedAtMs = Date.now();
const overallTimeoutMs = Math.max(timeoutSeconds * 1000 * 4, 30_000);
const planOnly = args.includes("--plan-only");
const requireObserved = args.includes("--require-observed");
const liveReadHost = (process.env.FRIDAY_CONSOLE_LIVE_READ_HOST || "").trim();
const liveReadPort = (process.env.FRIDAY_CONSOLE_LIVE_READ_PORT || "").trim();
const declaredCaptureMode = (process.env.FRIDAY_DESKTOP_AX_CAPTURE_MODE || "").trim();
const blockers = [];
const warnings = [];

function block(code, detail) {
  blockers.push({ code, detail });
}

function warn(code, detail) {
  warnings.push({ code, detail });
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

function read(path) {
  return readFileSync(path, "utf8");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function liveConnectionMetadata() {
  const readPortOk = /^[0-9]+$/.test(liveReadPort);
  const missionBound = workbenchMissionId.length > 0;
  const readConfigured = liveReadHost.length > 0 && readPortOk;
  const mock = process.env.FRIDAY_CONSOLE_MOCK === "1";
  const status = readConfigured && missionBound && !mock
    ? "mission_bound_live_read_requested"
    : "live_read_not_mission_bound";
  return {
    read_host: liveReadHost || null,
    read_port: liveReadPort || null,
    workbench_mission_id: workbenchMissionId || null,
    mock,
    status,
  };
}

function captureModeForLiveConnection(liveConnection) {
  if (declaredCaptureMode) return declaredCaptureMode;
  return liveConnection.status === "mission_bound_live_read_requested"
    ? "live-loopback"
    : "unclassified-real-app";
}

function run(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });
}

function parseDesktopDestinations() {
  const contractPath = resolve(repoRoot, "apps/macos/FridayHubConsole/Sources/FridayHubConsoleCore/DesktopProductReadinessContract.swift");
  const source = read(contractPath);
  const rows = [];
  const caseMatches = [...source.matchAll(/case \.([A-Za-z0-9_]+):\s*return contract\(([\s\S]*?)(?=\n\s*case \.|^\s*\}\n\s*private func contract)/gm)];
  for (const match of caseMatches) {
    const destination = match[1];
    const body = match[2];
    const title = body.match(/title:\s*"([^"]+)"/)?.[1] || destination;
    const tier = body.match(/tier:\s*\.([A-Za-z0-9_]+)/)?.[1] || "";
    const actionBlock = body.match(/runtimeActionIds:\s*\[([\s\S]*?)\]/)?.[1] || "";
    const runtimeActionIds = [...actionBlock.matchAll(/"([^"]+)"/g)].map((item) => item[1]);
    rows.push({ destination, title, tier, runtimeActionIds });
  }
  return rows;
}

const defaultActionMap = new Map([
  ["desktop/operations/refresh", { destination: "operations", screen: "operations", accessibility_id: "friday.desktop.refresh", event: "mission_workbench_visible", interaction: "visible" }],
  ["desktop/operations/mission-resolve-or-create", { destination: "operations", screen: "operations", accessibility_id: "friday.desktop.mission-card", event: "mission_resolve_or_create_visible", interaction: "visible" }],
  ["desktop/fridayChat/act", { destination: "chat", screen: "fridayChat", accessibility_id: "friday.desktop.chat.send", event: "mission_bound_provider_action_visible", interaction: "visible" }],
  ["desktop/fridayChat/check", {
    destination: "chat",
    screen: "fridayChat",
    accessibility_id: "friday.desktop.chat.review",
    accessibility_ids: [
      "friday.desktop.chat.review",
      "friday.desktop.chat.continuity",
      "friday.desktop.chat.transcript",
    ],
    event: "mission_bound_provider_action_visible",
    interaction: "visible",
  }],
  ["desktop/session/list", { destination: "session", screen: "session", accessibility_id: "friday.desktop.session-detail", event: "transcript_browser_visible", interaction: "visible" }],
  ["desktop/session/open", { destination: "session", screen: "session", accessibility_id: "friday.desktop.session-detail", event: "transcript_browser_visible", interaction: "visible" }],
  ["desktop/session/link", { destination: "session", screen: "session", accessibility_id: "friday.desktop.session-detail", event: "transcript_browser_visible", interaction: "visible" }],
  ["desktop/pairing/manifest", { destination: "pairingProvisioning", screen: "pairingProvisioning", accessibility_id: "friday.desktop.pairing-provisioning-path", event: "same_mission_projection_visible", interaction: "visible" }],
  ["desktop/workflow/retry", { destination: "workflow", screen: "workflow", accessibility_id: "friday.desktop.workflow.canvas", event: "mission_workbench_visible", interaction: "visible" }],
  ["desktop/workflow/cancel", { destination: "workflow", screen: "workflow", accessibility_id: "friday.desktop.workflow.canvas", event: "mission_workbench_visible", interaction: "visible" }],
  ["desktop/channels/receipts", { destination: "channels", screen: "channels", accessibility_id: "friday.desktop.channels.admin", event: "same_mission_mobile_desktop_channel_visible", interaction: "visible" }],
  ["desktop/channels/surface-events", { destination: "channels", screen: "channels", accessibility_id: "friday.desktop.channels.surface-events", event: "same_mission_mobile_desktop_channel_visible", interaction: "visible" }],
  ["desktop/recovery/retry", { destination: "recovery", screen: "recovery", accessibility_id: "friday.desktop.recovery.retry-available", visible_text: "retry available", event: "reconnect_stale_verified", interaction: "visible" }],
  ["desktop/recovery/cancel", { destination: "recovery", screen: "recovery", accessibility_id: "friday.desktop.recovery.cancel-available", visible_text: "cancel available", event: "reconnect_stale_verified", interaction: "visible" }],
  ["desktop/memory/act", { destination: "memory", screen: "memory", accessibility_id: "friday.desktop.evidence.memory-candidate", visible_text: "Review-only memory candidate attached to this Mission.", event: "same_mission_projection_visible", interaction: "visible" }],
  ["desktop/memory/check", { destination: "memory", screen: "memory", accessibility_id: "friday.desktop.evidence.memory-candidate", visible_text: "Review-only memory candidate attached to this Mission.", event: "same_mission_projection_visible", interaction: "visible" }],
]);

function actionPlan() {
  const destinationFilter = new Set(destinationsCsv.split(",").map((value) => value.trim()).filter(Boolean));
  return parseDesktopDestinations()
    .filter((destination) => destinationFilter.size === 0 || destinationFilter.has(destination.destination))
    .flatMap((destination) =>
    destination.runtimeActionIds.map((runtimeActionId) => ({
      runtimeActionId,
      destination: defaultActionMap.get(runtimeActionId)?.destination || destination.destination,
      title: destination.title,
      tier: destination.tier,
      ...(defaultActionMap.get(runtimeActionId) || {
        screen: destination.destination,
        accessibility_id: `friday.desktop.nav.${destination.destination}`,
        event: "mission_workbench_visible",
        interaction: "visible",
      }),
    })));
}

function jsonOut(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function appleString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function osascript(script) {
  return run("/usr/bin/osascript", ["-e", script], {
    killSignal: "SIGKILL",
    timeout: timeoutSeconds * 1000,
  });
}

function overallDeadlineExceeded() {
  return Date.now() - overallStartedAtMs > overallTimeoutMs;
}

function waitForWindow() {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline && !overallDeadlineExceeded()) {
    const result = osascript(`
tell application "System Events"
  if exists process "FridayHubConsole" then
    tell process "FridayHubConsole"
      set frontmost to true
      if (count of windows) > 0 then return "ready"
    end tell
  end if
end tell
return "not_ready"`);
    if (result.status === 0 && result.stdout.trim() === "ready") return true;
  }
  return false;
}

function captureTreeRaw() {
  const script = `
set outputLines to {}
on cleanText(v)
  set s to v as text
  set AppleScript's text item delimiters to tab
  set parts to text items of s
  set AppleScript's text item delimiters to " "
  set s to parts as text
  set AppleScript's text item delimiters to linefeed
  set parts to text items of s
  set AppleScript's text item delimiters to " "
  return parts as text
end cleanText
on appendElement(e, depth)
  global outputLines
  set roleValue to ""
  set nameValue to ""
  set identifierValue to ""
  try
    set roleValue to my cleanText(role of e)
  end try
  try
    set nameValue to my cleanText(name of e)
  end try
  try
    tell application "System Events"
      set identifierValue to my cleanText(value of attribute "AXIdentifier" of e)
    end tell
  end try
  set end of outputLines to ((depth as text) & tab & roleValue & tab & identifierValue & tab & nameValue & tab & "" & tab & "")
  if depth < ${axTraversalDepth} then
    try
      tell application "System Events"
        set childElements to UI elements of e
      end tell
      repeat with childElement in childElements
        my appendElement(childElement, depth + 1)
      end repeat
    end try
  end if
end appendElement
tell application "System Events"
  tell process "FridayHubConsole"
    if (count of windows) = 0 then return ""
    my appendElement(window 1, 0)
  end tell
end tell
set AppleScript's text item delimiters to linefeed
return outputLines as text`;
  const result = osascript(script);
  if (result.status !== 0) {
    warn("ax_tree_capture_failed", result.error?.message || result.stderr?.trim() || result.stdout?.trim() || String(result.status));
    return "";
  }
  return result.stdout;
}

function clickNav(destination, title) {
  const identifier = `friday.desktop.nav.${destination}`;
  const script = `
set didClick to false
on clickMatchingElement(e, identifierValue, titleValue, depth)
  global didClick
  if didClick is true then return
  try
    tell application "System Events"
      if (value of attribute "AXIdentifier" of e) is identifierValue then
        try
          perform action "AXPress" of e
        on error
          click e
        end try
        set didClick to true
        return
      end if
    end tell
  end try
  try
    tell application "System Events"
      if (name of e) contains titleValue then
        try
          perform action "AXPress" of e
        on error
          click e
        end try
        set didClick to true
        return
      end if
    end tell
  end try
  if depth < ${axTraversalDepth} then
    try
      tell application "System Events"
        set childElements to UI elements of e
      end tell
      repeat with childElement in childElements
        my clickMatchingElement(childElement, identifierValue, titleValue, depth + 1)
        if didClick is true then return
      end repeat
    end try
  end if
end clickMatchingElement
tell application "System Events"
  tell process "FridayHubConsole"
    set frontmost to true
    if (count of windows) = 0 then return "window_missing"
    my clickMatchingElement(window 1, ${appleString(identifier)}, ${appleString(title || destination)}, 0)
    if didClick then return "clicked"
  end tell
end tell
return "not_found"`;
  return osascript(script);
}

function rawTreeHasDestination(raw, destination, title) {
  const haystack = raw || "";
  return haystack.includes(title)
    || haystack.includes(`friday.desktop.${destination}`)
    || haystack.includes(`friday.desktop.destination.${destination}`);
}

function waitForDestination(destination, title) {
  const marker = captureTargetElement({
    runtimeActionId: `desktop/${destination}/destination-marker`,
    accessibility_id: `friday.desktop.destination.${destination}`,
    visible_text: title,
  });
  if (marker) {
    return {
      ready: true,
      raw: [
        `0\t${marker.role}\t${marker.identifier}\t${marker.name}\t${marker.description}\t`,
      ].join("\n"),
    };
  }
  const destinationWaitMs = Math.min(timeoutSeconds * 1000, 8_000);
  const deadline = Date.now() + destinationWaitMs;
  let lastRaw = "";
  while (Date.now() < deadline && !overallDeadlineExceeded()) {
    const raw = captureTreeRaw();
    lastRaw = raw;
    if (rawTreeHasDestination(raw, destination, title)) return { ready: true, raw };
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  return { ready: false, raw: lastRaw };
}

function parseRawTree(raw) {
  return raw.split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [depth = "", role = "", identifier = "", name = "", description = "", enabled = ""] = line.split("\t");
      return { depth: Number(depth) || 0, role, identifier, name, description, enabled };
    });
}

function elementMatches(element, accessibilityId) {
  const haystack = [element.identifier, element.name, element.description].join("\n");
  return haystack.includes(accessibilityId);
}

function targetMatches(element, target) {
  const ids = Array.isArray(target.accessibility_ids) && target.accessibility_ids.length > 0
    ? target.accessibility_ids
    : [target.accessibility_id];
  for (const id of ids) {
    if (id && elementMatches(element, id)) return { ok: true, match: id === target.accessibility_id ? "accessibility_id" : "accessibility_id_fallback" };
  }
  if (target.visible_text) {
    const haystack = [element.name, element.description].join("\n");
    if (haystack.includes(target.visible_text)) return { ok: true, match: "visible_text" };
  }
  return { ok: false, match: "none" };
}

function captureTargetElement(target) {
  const ids = Array.isArray(target.accessibility_ids) && target.accessibility_ids.length > 0
    ? target.accessibility_ids
    : [target.accessibility_id];
  const idList = ids.map((id) => String(id || "").replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")).join("\n");
  const visibleText = target.visible_text || "";
  const script = `
set identifierNeedles to paragraphs of ${appleString(idList)}
set textNeedle to ${appleString(visibleText)}
set foundLine to ""
on cleanText(v)
  set s to v as text
  set AppleScript's text item delimiters to tab
  set parts to text items of s
  set AppleScript's text item delimiters to " "
  set s to parts as text
  set AppleScript's text item delimiters to linefeed
  set parts to text items of s
  set AppleScript's text item delimiters to " "
  return parts as text
end cleanText
on inspectElement(e, identifierNeedles, textNeedle, depth)
  global foundLine
  if foundLine is not "" then return
  set roleValue to ""
  set nameValue to ""
  set identifierValue to ""
  set descriptionValue to ""
  try
    set roleValue to my cleanText(role of e)
  end try
  try
    set nameValue to my cleanText(name of e)
  end try
  try
    set descriptionValue to my cleanText(description of e)
  end try
  try
    tell application "System Events"
      set identifierValue to my cleanText(value of attribute "AXIdentifier" of e)
    end tell
  end try
  repeat with identifierNeedle in identifierNeedles
    set idText to identifierNeedle as text
    if idText is not "" and identifierValue contains idText then
      set foundLine to ("accessibility_id" & tab & roleValue & tab & identifierValue & tab & nameValue & tab & descriptionValue)
      return
    end if
  end repeat
  if textNeedle is not "" then
    if nameValue contains textNeedle or descriptionValue contains textNeedle then
      set foundLine to ("visible_text" & tab & roleValue & tab & identifierValue & tab & nameValue & tab & descriptionValue)
      return
    end if
  end if
  if depth < ${axTraversalDepth} then
    try
      tell application "System Events"
        set childElements to UI elements of e
      end tell
      repeat with childElement in childElements
        my inspectElement(childElement, identifierNeedles, textNeedle, depth + 1)
        if foundLine is not "" then return
      end repeat
    end try
  end if
end inspectElement
tell application "System Events"
  tell process "FridayHubConsole"
    if (count of windows) = 0 then return "not_found"
    my inspectElement(window 1, identifierNeedles, textNeedle, 0)
  end tell
end tell
if foundLine is "" then return "not_found"
return foundLine`;
  const result = osascript(script);
  if (result.status !== 0) {
    warn("ax_target_capture_failed", `${target.runtimeActionId}:${result.error?.message || result.stderr?.trim() || result.stdout?.trim() || String(result.status)}`);
    return null;
  }
  const line = result.stdout.trim();
  if (!line || line === "not_found") return null;
  const [match = "none", role = "", identifier = "", name = "", description = ""] = line.split("\t");
  return { match, role, identifier, name, description, rawLine: line };
}

const targets = actionPlan();
const summaryPath = outDir ? resolve(outDir, "desktop-ax-accessibility-capture-summary.json") : "";
const capturePath = outDir ? resolve(outDir, "desktop-ax-accessibility-capture.json") : "";
const rawPath = outDir ? resolve(outDir, "desktop-ax-tree.raw.txt") : "";

if (!missionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(missionId) || !missionId.toLowerCase().includes("mission")) {
  block("mission_id_unexpected_shape", missionId || "<missing>");
}
const resolvedOutDir = requireAbsoluteDir("out-dir", outDir);
if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 5) block("timeout_invalid", String(timeoutSeconds));
if (!Number.isInteger(treeDepth) || treeDepth < 2 || treeDepth > 9) block("tree_depth_invalid", String(treeDepth));

if (planOnly) {
  const summary = {
    generated_at_utc: new Date().toISOString(),
    truth: "desktop_ax_accessibility_capture_plan_only_not_runtime_proof",
    status: blockers.length === 0 ? "plan_ready" : "blocked",
    targetCount: targets.length,
    treeDepth,
    targets,
    blockers,
    caveat: "Plan-only mode does not launch or inspect the app and is not UI/device proof.",
  };
  if (summaryPath) jsonOut(summaryPath, summary);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(blockers.length > 0 ? 2 : 0);
}

if (process.platform !== "darwin") block("platform_not_darwin", process.platform);
if (blockers.length > 0) {
  const summary = {
    generated_at_utc: new Date().toISOString(),
    truth: "desktop_ax_accessibility_capture_blocked_not_runtime_proof",
    status: "blocked",
    blockers,
  };
  if (summaryPath) jsonOut(summaryPath, summary);
  console.error(JSON.stringify(summary, null, 2));
  process.exit(2);
}

mkdirSync(resolvedOutDir, { recursive: true });
let appDir = appDirArg;
if (!appDir) {
  const build = run("bash", [resolve(repoRoot, "scripts/ops/build-friday-hub-console-app.sh"), repoRoot], { timeout: timeoutSeconds * 1000 * 6 });
  if (build.status !== 0) {
    block("app_build_failed", build.stderr.trim() || build.stdout.trim() || String(build.status));
  } else {
    appDir = build.stdout.trim().split(/\r?\n/).at(-1) || "";
  }
}
if (!isAbsolute(appDir)) block("app_dir_not_absolute", appDir || "<missing>");
const appBinary = appDir ? resolve(appDir, "Contents/MacOS/FridayHubConsole") : "";
if (!appBinary || !existsSync(appBinary)) block("app_binary_missing", appBinary || "<missing>");
if (appBinary && existsSync(appBinary)) {
  try {
    if (!statSync(appBinary).isFile()) block("app_binary_not_file", appBinary);
  } catch {
    block("app_binary_unreadable", appBinary);
  }
}

function quitApp() {
  spawnSync("/usr/bin/osascript", ["-e", "tell application \"FridayHubConsole\" to quit"], { stdio: "ignore", timeout: 1500 });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const probe = spawnSync("/usr/bin/osascript", [
      "-e",
      "tell application \"System Events\" to if exists process \"FridayHubConsole\" then return \"running\" else return \"missing\"",
    ], { encoding: "utf8", timeout: 1500 });
    if (probe.stdout.trim() === "missing") return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
}

function launchApp(destination) {
  quitApp();
  const launchArgs = [`--initial-destination=${destination}`];
  if (workbenchMissionId) launchArgs.push(`--mission-id=${workbenchMissionId}`);
  const appProcess = spawn(appBinary, launchArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      FRIDAY_CONSOLE_MOCK: "0",
      FRIDAY_CONSOLE_INITIAL_DESTINATION: destination,
      ...(workbenchMissionId ? { FRIDAY_CONSOLE_MISSION_ID: workbenchMissionId } : {}),
    },
    detached: true,
    stdio: "ignore",
  });
  appProcess.unref();
  if (!appProcess.pid) {
    block("app_launch_failed", "pid_missing");
    return false;
  }
  return waitForWindow();
}

process.on("exit", () => {
  try {
    quitApp();
  } catch {
    // Best-effort cleanup of the app process this script launched.
  }
});

const observedActions = [];
const rawSnapshots = [];
const missingTargets = [];
const observedStatusEvents = new Set();
if (blockers.length === 0) {
  const byDestination = new Map();
  for (const target of targets) {
    const list = byDestination.get(target.destination) || [];
    list.push(target);
    byDestination.set(target.destination, list);
  }

  for (const [destination, destinationTargets] of byDestination.entries()) {
    if (overallDeadlineExceeded()) {
      block("capture_overall_timeout", `stopped before destination:${destination}`);
      break;
    }
    const ready = launchApp(destination);
    if (!ready) {
      block("app_window_not_ready", `FridayHubConsole:${destination}`);
      continue;
    }
    const destinationTitle = destinationTargets[0]?.title || destination;
    let destinationReady = waitForDestination(destination, destinationTitle);
    const nav = destinationReady.ready
      ? { status: 0, stdout: "initial_destination_ready", stderr: "" }
      : clickNav(destination, destinationTitle);
    const navStatus = `initial_destination;${nav.status === 0 ? nav.stdout.trim() : nav.stderr.trim()}`;
    if (!destinationReady.ready && nav.status === 0 && nav.stdout.trim() === "clicked") {
      destinationReady = waitForDestination(destination, destinationTitle);
    }
    if (nav.status === 0 && nav.stdout.trim() === "clicked") {
      observedActions.push({
        screen: destination,
        runtimeActionId: `desktop/${destination}/destination-visible`,
        action_id: `desktop/${destination}/destination-visible`,
        capability_id: `desktop/${destination}/destination-visible`,
        accessibility_id: `friday.desktop.nav.${destination}`,
        interaction: "visible",
        status: "pass",
        evidence_ref: rawPath,
        captured_at: new Date().toISOString(),
        workbench_mission_id: workbenchMissionId || null,
        matched_role: "nav",
        matched_name: destinationTargets[0]?.title || destination,
        matched_description: navStatus,
        matched_by: "navigation_click",
      });
    } else if (nav.status === 0 && nav.stdout.trim() === "initial_destination_ready") {
      observedActions.push({
        screen: destination,
        runtimeActionId: `desktop/${destination}/destination-visible`,
        action_id: `desktop/${destination}/destination-visible`,
        capability_id: `desktop/${destination}/destination-visible`,
        accessibility_id: `friday.desktop.nav.${destination}`,
        interaction: "visible",
        status: "pass",
        evidence_ref: rawPath,
        captured_at: new Date().toISOString(),
        workbench_mission_id: workbenchMissionId || null,
        matched_role: "nav",
        matched_name: destinationTitle,
        matched_description: navStatus,
        matched_by: "initial_destination",
      });
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 350));
    const raw = destinationReady.ready ? destinationReady.raw : captureTreeRaw();
    rawSnapshots.push(`--- destination=${destination} nav=${navStatus} ---\n${raw}`);
    const elements = parseRawTree(raw);
    for (const [label, event] of [
      ["stale", "stale_label_visible"],
      ["offline", "offline_label_visible"],
      ["error", "error_label_visible"],
    ]) {
      const key = `desktop:${event}`;
      if (observedStatusEvents.has(key)) continue;
      const identifier = `friday.desktop.status-label.${label}`;
      const display = label.toUpperCase();
      const matchedLabel = elements.find((element) =>
        element.identifier.includes(identifier)
        || element.name === display
        || element.description === display);
      if (!matchedLabel) continue;
      observedStatusEvents.add(key);
      observedActions.push({
        screen: destination,
        runtimeActionId: `desktop/status-label/${label}`,
        action_id: `desktop/status-label/${label}`,
        capability_id: `desktop/status-label/${label}`,
        accessibility_id: identifier,
        interaction: "visible",
        status: "pass",
        event,
        evidence_ref: rawPath,
        captured_at: new Date().toISOString(),
        workbench_mission_id: workbenchMissionId || null,
        matched_role: matchedLabel.role,
        matched_name: matchedLabel.name,
        matched_description: matchedLabel.description,
        matched_by: matchedLabel.identifier.includes(identifier) ? "accessibility_id" : "visible_label",
      });
    }
    for (const target of destinationTargets) {
      if (overallDeadlineExceeded()) {
        block("capture_overall_timeout", `stopped before target:${target.runtimeActionId}`);
        break;
      }
      let matchKind = "none";
      const matched = elements.find((element) => {
        const result = targetMatches(element, target);
        if (result.ok) matchKind = result.match;
        return result.ok;
      });
      const targetedMatch = matched ? null : captureTargetElement(target);
      if (targetedMatch) {
        rawSnapshots.push(`--- destination=${destination} target=${target.runtimeActionId} targeted_ax_probe ---\n${targetedMatch.rawLine}`);
      }
      if (!matched && !targetedMatch) {
        missingTargets.push({
          runtimeActionId: target.runtimeActionId,
          destination: target.destination,
          accessibility_id: target.accessibility_id,
          accessibility_ids: target.accessibility_ids || null,
          visible_text: target.visible_text || null,
        });
        continue;
      }
      observedActions.push({
        screen: target.screen,
        runtimeActionId: target.runtimeActionId,
        action_id: target.runtimeActionId,
        capability_id: target.runtimeActionId,
        accessibility_id: target.accessibility_id,
        interaction: target.interaction,
        status: "pass",
        event: target.event,
        evidence_ref: rawPath,
        captured_at: new Date().toISOString(),
        workbench_mission_id: workbenchMissionId || null,
        matched_role: matched?.role || targetedMatch?.role || "",
        matched_name: matched?.name || targetedMatch?.name || "",
        matched_description: matched?.description || targetedMatch?.description || "",
        matched_by: matched ? matchKind : `targeted_${targetedMatch.match}`,
      });
    }
  }
}

writeFileSync(rawPath, `${rawSnapshots.join("\n")}\n`);
const liveConnection = liveConnectionMetadata();
const captureMode = captureModeForLiveConnection(liveConnection);
const capture = {
  truth_label: "ui_device_accessibility_click_capture_real_ui_not_endbar",
  generated_at_utc: new Date().toISOString(),
  status: blockers.length === 0 && observedActions.length > 0 ? "partial_capture_ready" : "blocked_or_empty",
  mission_id: missionId,
  workbench_mission_id: workbenchMissionId || null,
  surface: "desktop",
  capture_method: "macos_accessibility",
  mode: captureMode,
  live_connection: liveConnection,
  evidence_ref: rawPath,
  ui_actions: observedActions,
  caveat:
    "This is real macOS Accessibility inspection of FridayHubConsole with declared live-read metadata when configured; it is not END-BAR, adoption, or proof that runtime actions closed.",
};
jsonOut(capturePath, capture);

if (requireObserved && observedActions.length === 0) block("observed_actions_missing", "no mapped desktop accessibility actions observed");

const summary = {
  generated_at_utc: new Date().toISOString(),
  truth: "desktop_ax_accessibility_capture_real_app_not_endbar_not_adoption",
  status: blockers.length === 0 && observedActions.length > 0 ? "partial_capture_ready" : "blocked_or_empty",
  repo: {
    root: repoRoot,
    head: run("git", ["rev-parse", "HEAD"]).stdout.trim(),
  },
  app: {
    dir: appDir,
    binary: appBinary,
  },
  capture: {
    path: capturePath,
    raw_tree: rawPath,
    mode: captureMode,
    live_connection: liveConnection,
    overall_timeout_ms: overallTimeoutMs,
    observed_count: observedActions.length,
    missing_count: missingTargets.length,
    missing_targets: missingTargets,
  },
  blockers,
  warnings,
  caveats: [
    "This is real macOS Accessibility inspection of FridayHubConsole, not screenshot proof.",
    "Only visible, safe observations are emitted; governed/destructive actions are not auto-clicked.",
    "Passing here is not END-BAR, not adoption, and must still be consumed by the strict UI/device runner.",
  ],
};
jsonOut(summaryPath, summary);
console.log(JSON.stringify(summary, null, 2));
process.exit(blockers.length > 0 || (requireObserved && observedActions.length === 0) ? 2 : 0);
