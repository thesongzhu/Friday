#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const forbiddenTruth = /(synthetic|fixture|sample|dry[-_ ]?run|screenshot[-_ ]?only|design[-_ ]?proof|mock|placeholder)/i;
const imageEvidence = /\.(png|jpe?g|heic|gif|webp|tiff?)$/i;
const allowedEvidenceTypes = new Set(["accessibility_tree", "accessibility_observation", "xctest_accessibility"]);
const allowedInteractions = new Set(["tap", "visible", "type", "read"]);
const allowedEvents = new Set([
  "mission_intake_submitted",
  "mission_intake_ready",
  "mission_resolve_or_create_visible",
  "duplicate_preflight_visible",
  "mission_bound_provider_action_visible",
  "real_provider_execution_visible",
  "proof_receipt_visible_before_done",
  "same_mission_projection_visible",
  "mission_workbench_visible",
  "transcript_browser_visible",
  "duplicate_blocked_opens_existing",
  "same_mission_mobile_desktop_channel_visible",
  "provider_ack_not_done_visible",
  "pressure_20_50_consecutive_asks_visible",
  "invalid_key_error_visible",
  "quota_error_visible",
  "network_error_visible",
  "reconnect_stale_verified",
  "real_provider_execution_receipt_visible",
  "stale_label_visible",
  "offline_label_visible",
  "error_label_visible",
  "no_hidden_fallback_verified",
]);

const ACTION_MAP = {
  "mobile/home/refresh": { screen: "home", accessibilityIds: ["friday.mobile.toolbar.refresh"], event: "mission_workbench_visible", interaction: "visible" },
  "mobile/missions/read": { screen: "missions", accessibilityIds: ["friday.missions.read"], event: "mission_workbench_visible", interaction: "visible" },
  "mobile/session/sidecar/open": { screen: "session", accessibilityIds: ["friday.session.sidecar-open"], event: "mission_workbench_visible", interaction: "visible" },
  "mobile/session/sidecar/close": { screen: "session", accessibilityIds: ["friday.session.sidecar-close"], event: "mission_workbench_visible", interaction: "visible" },
  "mobile/workflow/run-control": { screen: "session", accessibilityIds: ["friday.session.control.resume", "friday.session.control.reject"], event: "provider_ack_not_done_visible", interaction: "visible" },
  "mobile/passport/checklist": { screen: "contextPassport", accessibilityIds: ["friday.context-passport.checklist"], event: "same_mission_projection_visible", interaction: "visible" },
  "mobile/passport/send": { screen: "contextPassport", accessibilityIds: ["friday.context-passport.send"], event: "mission_bound_provider_action_visible", interaction: "visible" },
  "mobile/tokenLedger/refresh": { screen: "tokenLedger", accessibilityIds: ["friday.token-ledger.refresh"], event: "same_mission_projection_visible", interaction: "visible" },
  "mobile/tokenLedger/run-readback": { screen: "tokenLedger", accessibilityIds: ["friday.token-ledger.detail"], event: "same_mission_projection_visible", interaction: "read" },
  "mobile/share/send": { screen: "shareIntake", accessibilityIds: ["friday.share.submit"], event: "mission_intake_submitted", interaction: "visible" },
  "mobile/share/open-chat-loop": { screen: "shareIntake", accessibilityIds: ["friday.share.open-chat-loop"], event: "mission_intake_ready", interaction: "visible" },
  "mobile/voice/permission": { screen: "voice", accessibilityIds: ["friday.voice.permission"], event: "mission_workbench_visible", interaction: "visible" },
  "mobile/fridayChat/voice-input": { screen: "fridayChat", accessibilityIds: ["friday.chat.voice-input"], event: "mission_bound_provider_action_visible", interaction: "visible" },
  "mobile/fridayChat/voice-output": { screen: "fridayChat", accessibilityIds: ["friday.chat.voice-output"], event: "real_provider_execution_receipt_visible", interaction: "visible" },
  "mobile/voice/open-chat-loop": { screen: "voice", accessibilityIds: ["friday.voice.open-chat-loop"], event: "mission_intake_ready", interaction: "visible" },
  "mobile/firstlaunch/scan": { screen: "pairing", accessibilityIds: ["friday.home.pairing-scan-button"], event: "mission_workbench_visible", interaction: "visible" },
  "mobile/firstlaunch/pairnow": { screen: "pairing", accessibilityIds: ["friday.home.pair-button"], event: "mission_workbench_visible", interaction: "visible" },
  "mobile/firstlaunch/retry": { screen: "pairing", accessibilityIds: ["friday.home.pairing-retry-button"], event: "reconnect_stale_verified", interaction: "visible" },
  "mobile/firstlaunch/cancel": { screen: "pairing", accessibilityIds: ["friday.home.pairing-cancel-button", "friday.home.pairing-receipt-cancelled"], event: "reconnect_stale_verified", interaction: "visible" },
  "mobile/newSession/play": { screen: "newSession", accessibilityIds: ["friday.new-session.launch-button"], event: "mission_intake_submitted", interaction: "visible" },
  "mobile/newSession/open-chat-loop": { screen: "newSession", accessibilityIds: ["friday.new-session.open-chat-loop"], event: "mission_intake_ready", interaction: "visible" },
  "mobile/missions/dispatch": { screen: "missions", accessibilityIds: ["friday.missions.dispatch-button"], event: "mission_intake_submitted", interaction: "visible" },
  "mobile/missions/open-chat-loop": { screen: "missions", accessibilityIds: ["friday.missions.open-chat-loop"], event: "mission_intake_ready", interaction: "visible" },
  "mobile/approval/check": { screen: "fridayChat", accessibilityIds: ["friday.chat.approval.approve", "friday.session.control.resume"], event: "proof_receipt_visible_before_done", interaction: "visible" },
  "mobile/approval/reject": { screen: "fridayChat", accessibilityIds: ["friday.chat.approval.reject", "friday.session.control.reject"], event: "provider_ack_not_done_visible", interaction: "visible" },
  "mobile/memory/confirm": { screen: "memory", accessibilityIds: ["friday.memory.confirm-candidate", "friday.chat.memory-card.keep"], event: "same_mission_projection_visible", interaction: "visible" },
  "mobile/memory/reject": { screen: "memory", accessibilityIds: ["friday.memory.reject-candidate", "friday.chat.memory-card.reject"], event: "same_mission_projection_visible", interaction: "visible" },
  "mobile/providerAuth/check": { screen: "providerAuth", accessibilityIds: ["friday.provider-auth.check"], event: "mission_bound_provider_action_visible", interaction: "visible" },
  "mobile/providerAuth/provider-workspace": { screen: "providerAuth", accessibilityIds: ["friday.provider-workspace.overview"], event: "real_provider_execution_visible", interaction: "visible" },
  "mobile/activity/mark-done": { screen: "activity", accessibilityIds: ["friday.activity.mark-done"], event: "same_mission_projection_visible", interaction: "visible" },
  "mobile/workflow/retry": { screen: "workflows", accessibilityIds: ["friday.workflow.retry-work-item", "friday.home.retry-work-item"], event: "reconnect_stale_verified", interaction: "visible" },
  "mobile/workflow/cancel": { screen: "workflows", accessibilityIds: ["friday.workflow.cancel-work-item", "friday.home.cancel-work-item"], event: "reconnect_stale_verified", interaction: "visible" },
  "mobile/onboarding/open-device-pairing": { screen: "onboarding", accessibilityIds: ["friday.onboarding.open-device-pairing"], event: "mission_workbench_visible", interaction: "visible" },
  "mobile/platform/capability-matrix": { screen: "platform", accessibilityIds: ["friday.platform.capability-matrix"], event: "same_mission_projection_visible", interaction: "visible" },
  "mobile/settings/push-permission": { screen: "settings", accessibilityIds: ["friday.settings.push-permission"], event: "mission_workbench_visible", interaction: "visible" },
  "mobile/pet/state-mapping": { screen: "petEditor", accessibilityIds: ["friday.pet-editor.readiness"], event: "same_mission_projection_visible", interaction: "visible" },
  "mobile/proof/viewer-open": { screen: "proofViewer", accessibilityIds: ["friday.proof-viewer.receipts"], event: "proof_receipt_visible_before_done", interaction: "visible" },
  "mobile/entrypoints/readiness": { screen: "entrypoints", accessibilityIds: ["friday.entrypoints.readiness"], event: "mission_workbench_visible", interaction: "visible" },
};

function usage() {
  console.error(`usage:
  node scripts/ops/friday-ios-sim-accessibility-capture.mjs \\
    --mission-id=mission_... --out-dir=/abs/out-dir
    [--repo-root=/abs/repo] [--bundle-id=com.friday.shell] [--udid=SIM_UDID]
    [--destinations=home,needsMe,...] [--plan-only]
    [--real --observation=/abs/real-ios-accessibility-observation.json]
    [--normalize] [--normalizer-out-dir=/abs/out-dir] [--require-observed]

Observation input shape for --real:
  {
    "truth_label": "ios_simulator_accessibility_observation_real_ui",
    "mission_id": "mission_...",
    "capture_method": "ios_simulator_accessibility",
    "evidence_type": "accessibility_tree|accessibility_observation|xctest_accessibility",
    "evidence_ref": "/abs/raw-ax-tree-or-xctest-log.txt",
    "observations": [{
      "runtimeActionId": "mobile/home/refresh",
      "accessibility_id": "friday.mobile.toolbar.refresh",
      "interaction": "visible",
      "status": "pass",
      "event": "mission_workbench_visible"
    }]
  }

Truth:
  Default mode is plan-only and does not inspect Simulator/app state. Real mode
  requires Simulator state from simctl, an installed/launched app, and real
  accessibility observations. It refuses screenshot-only, synthetic, mock, or
  placeholder evidence and is not END-BAR/adoption proof.`);
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
const udidArg = arg("udid") || process.env.FRIDAY_IOS_SIM_UDID || "";
const observationPath = arg("observation");
const destinationsCsv = arg("destinations") || process.env.FRIDAY_IOS_SIM_AX_DESTINATIONS || "";
const normalize = args.includes("--normalize");
const normalizerOutDir = arg("normalizer-out-dir") || (outDir ? resolve(outDir, "normalized") : "");
const requireObserved = args.includes("--require-observed");
const realMode = args.includes("--real") || Boolean(observationPath);
const planOnly = args.includes("--plan-only") || !realMode;
const blockers = [];

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

function requireAbsoluteFile(label, path) {
  if (!path) {
    block("missing_arg", label);
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

function readJson(label, path) {
  const file = requireAbsoluteFile(label, path);
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    block("invalid_json", `${label}:${path}:${error.message}`);
    return null;
  }
}

function parseMobileDestinations() {
  const contractPath = resolve(repoRoot, "apps/friday-ios/Sources/FridayMobileShellCore/MobileProductReadinessContract.swift");
  if (!existsSync(contractPath)) {
    block("mobile_contract_missing", contractPath);
    return [];
  }
  const source = readFileSync(contractPath, "utf8");
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

function plannedTargets() {
  const destinationFilter = new Set(destinationsCsv.split(",").map((value) => value.trim()).filter(Boolean));
  return parseMobileDestinations()
    .filter((destination) => destinationFilter.size === 0 || destinationFilter.has(destination.destination))
    .flatMap((destination) =>
      destination.runtimeActionIds.map((runtimeActionId) => {
        const mapped = ACTION_MAP[runtimeActionId];
        return {
          destination: destination.destination,
          title: destination.title,
          tier: destination.tier,
          runtimeActionId,
          screen: mapped?.screen || destination.destination,
          accessibilityIds: mapped?.accessibilityIds || [],
          interaction: mapped?.interaction || "visible",
          event: mapped?.event || "mission_workbench_visible",
          status: mapped ? "planned" : "unmapped",
        };
      }));
}

function validateTruth(label, value) {
  const truth = String(value?.truth_label || value?.truthLabel || value?.truth || "");
  if (!truth) block("truth_label_missing", label);
  if (truth && !/accessibility.*real|real.*accessibility/i.test(truth)) block("truth_label_not_real_accessibility", `${label}:${truth}`);
  if (truth && forbiddenTruth.test(truth)) block("truth_label_forbidden", `${label}:${truth}`);
  return truth;
}

function validateEvidenceRef(label, evidenceRef) {
  const ref = requireAbsoluteFile(`${label}:evidence_ref`, String(evidenceRef || ""));
  if (ref && imageEvidence.test(ref)) block("screenshot_only_evidence_forbidden", `${label}:${ref}`);
  return ref;
}

function resolveSimulator() {
  const list = run("xcrun", ["simctl", "list", "devices", "--json"]);
  if (list.status !== 0) {
    block("simctl_list_failed", list.stderr.trim() || list.stdout.trim() || String(list.status));
    return null;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(list.stdout);
  } catch (error) {
    block("simctl_list_invalid_json", error.message);
    return null;
  }
  const devices = Object.values(parsed.devices || {}).flat();
  const available = devices.filter((device) => device && device.isAvailable !== false);
  const selected = udidArg
    ? available.find((device) => device.udid === udidArg)
    : available.find((device) => device.state === "Booted" && /iPhone|iPad/i.test(String(device.name || "")));
  if (!selected) {
    block("ios_simulator_not_available", udidArg || "booted iPhone/iPad");
    return null;
  }
  if (selected.state !== "Booted") block("ios_simulator_not_booted", `${selected.name || "<unnamed>"}:${selected.udid}`);
  return {
    name: selected.name || "",
    udid: selected.udid,
    state: selected.state || "",
  };
}

function observeAppState(simulator) {
  if (!simulator?.udid) return null;
  const container = run("xcrun", ["simctl", "get_app_container", simulator.udid, bundleId, "data"]);
  if (container.status !== 0) {
    block("app_container_unavailable", container.stderr.trim() || container.stdout.trim() || `${bundleId}:${simulator.udid}`);
    return null;
  }
  const dataContainer = container.stdout.trim().split(/\r?\n/).at(-1) || "";
  if (!isAbsolute(dataContainer)) block("app_container_not_absolute", dataContainer || "<missing>");

  const launch = run("xcrun", ["simctl", "launch", simulator.udid, bundleId]);
  if (launch.status !== 0) {
    block("app_launch_failed", launch.stderr.trim() || launch.stdout.trim() || `${bundleId}:${simulator.udid}`);
  }
  return {
    bundle_id: bundleId,
    data_container: dataContainer,
    launch_stdout: launch.stdout.trim(),
  };
}

function normalizeObservation(raw, targets, captureEvidenceRef) {
  const rawActions = Array.isArray(raw?.observations)
    ? raw.observations
    : Array.isArray(raw?.ui_actions)
      ? raw.ui_actions
      : [];
  if (rawActions.length === 0) block("observations_missing", "observation input must include observations or ui_actions");

  const byRuntimeAction = new Map(targets.map((target) => [target.runtimeActionId, target]));
  const actions = [];
  for (const [index, action] of rawActions.entries()) {
    const label = `observation:ui_action_${index + 1}`;
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      block("ui_action_not_object", label);
      continue;
    }
    const runtimeActionId = String(action.runtimeActionId || action.runtime_action_id || action.action_id || action.actionId || "").trim();
    const target = byRuntimeAction.get(runtimeActionId);
    const accessibilityId = String(action.accessibility_id || action.accessibilityId || target?.accessibilityIds?.[0] || "").trim();
    const interaction = String(action.interaction || action.action || target?.interaction || "").trim();
    const event = String(action.event || target?.event || "").trim();
    const status = String(action.status || "").trim();
    const actionEvidenceType = String(action.evidence_type || action.evidenceType || raw.evidence_type || raw.evidenceType || "").trim();
    const evidenceRef = validateEvidenceRef(label, action.evidence_ref || action.evidenceRef || captureEvidenceRef);

    if (!runtimeActionId) block("runtime_action_id_missing", label);
    if (!target) block("runtime_action_not_planned", `${label}:${runtimeActionId || "<missing>"}`);
    if (!accessibilityId) block("accessibility_id_missing", label);
    if (target && !target.accessibilityIds.includes(accessibilityId)) {
      block("accessibility_id_not_planned", `${label}:${runtimeActionId}:${accessibilityId}`);
    }
    if (!allowedInteractions.has(interaction)) block("interaction_not_supported", `${label}:${interaction || "<missing>"}`);
    if (status !== "pass") block("status_not_pass", `${label}:${status || "<missing>"}`);
    if (!allowedEvents.has(event)) block("event_not_supported", `${label}:${event || "<missing>"}`);
    if (!allowedEvidenceTypes.has(actionEvidenceType)) block("evidence_type_not_accessibility", `${label}:${actionEvidenceType || "<missing>"}`);
    if (forbiddenTruth.test(String(action.source || ""))) block("ui_action_source_forbidden", label);
    if (forbiddenTruth.test(actionEvidenceType)) block("evidence_type_forbidden", `${label}:${actionEvidenceType}`);

    actions.push({
      screen: String(action.screen || target?.screen || "").trim(),
      runtimeActionId,
      action_id: runtimeActionId,
      capability_id: String(action.capability_id || action.capabilityId || runtimeActionId),
      accessibility_id: accessibilityId,
      interaction,
      status: "pass",
      event,
      evidence_ref: evidenceRef,
      captured_at: String(action.captured_at || action.capturedAt || raw.captured_at || raw.capturedAt || new Date().toISOString()),
      matched_by: String(action.matched_by || action.matchedBy || "external_real_accessibility_observation"),
    });
  }
  return actions;
}

const targets = plannedTargets();
const summaryPath = outDir ? resolve(outDir, "ios-sim-accessibility-capture-summary.json") : "";
const capturePath = outDir ? resolve(outDir, "ios-sim-accessibility-capture.json") : "";

if (!missionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(missionId) || !missionId.toLowerCase().includes("mission")) {
  block("mission_id_unexpected_shape", missionId || "<missing>");
}
if (!outDir) block("missing_arg", "out-dir");
if (outDir && !isAbsolute(outDir)) block("path_not_absolute", `out-dir:${outDir}`);
if (targets.some((target) => target.status === "unmapped")) {
  for (const target of targets.filter((item) => item.status === "unmapped")) {
    block("runtime_action_unmapped", target.runtimeActionId);
  }
}

if (planOnly) {
  const summary = {
    generated_at_utc: new Date().toISOString(),
    truth: "ios_sim_accessibility_capture_plan_only_not_runtime_proof",
    status: blockers.length === 0 ? "plan_ready" : "blocked",
    missionId: missionId || null,
    targetCount: targets.length,
    targets,
    outputs: {
      summary: summaryPath || null,
      capture: null,
      normalized: null,
    },
    blockers,
    caveat: "Default plan-only mode reads static iOS action/accessibility targets only. It does not launch Simulator, inspect app state, emit real capture JSON, or claim UI/device proof.",
  };
  if (summaryPath) jsonOut(summaryPath, summary);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(blockers.length > 0 ? 2 : 0);
}

if (!observationPath) block("real_accessibility_observation_required", "supply --observation=/abs/real-ios-accessibility-observation.json");

let simulator = null;
let appState = null;
let capture = null;
let observedActions = [];
if (blockers.length === 0) {
  simulator = resolveSimulator();
}
if (blockers.length === 0) {
  appState = observeAppState(simulator);
}
if (blockers.length === 0) {
  const raw = readJson("observation", observationPath);
  if (raw) {
    validateTruth("observation", raw);
    const rawMissionId = String(raw.mission_id || raw.missionId || "");
    if (rawMissionId !== missionId) block("mission_id_mismatch", rawMissionId || "<missing>");
    const method = String(raw.capture_method || raw.captureMethod || "");
    if (method !== "ios_simulator_accessibility") block("capture_method_not_supported", method || "<missing>");
    if (forbiddenTruth.test(method)) block("capture_method_forbidden", method);
    const evidenceType = String(raw.evidence_type || raw.evidenceType || "");
    if (!allowedEvidenceTypes.has(evidenceType)) block("evidence_type_not_accessibility", evidenceType || "<missing>");
    if (forbiddenTruth.test(evidenceType)) block("evidence_type_forbidden", evidenceType);
    const evidenceRef = validateEvidenceRef("observation", raw.evidence_ref || raw.evidenceRef);
    if (forbiddenTruth.test(String(raw.source || ""))) block("observation_source_forbidden", String(raw.source));
    const rawUdid = String(raw.udid || raw.simulator_udid || raw.simulatorUdid || "");
    if (rawUdid && simulator?.udid && rawUdid !== simulator.udid) block("simulator_udid_mismatch", `${rawUdid}:${simulator.udid}`);
    const rawBundle = String(raw.bundle_id || raw.bundleId || "");
    if (rawBundle && rawBundle !== bundleId) block("bundle_id_mismatch", `${rawBundle}:${bundleId}`);

    observedActions = normalizeObservation(raw, targets, evidenceRef);
    if (requireObserved && observedActions.length === 0) block("observed_actions_missing", "no passed real accessibility observations");

    capture = {
      truth_label: "ui_device_accessibility_click_capture_real_ui_not_endbar",
      mission_id: missionId,
      surface: "mobile",
      capture_method: "ios_simulator_accessibility",
      evidence_ref: evidenceRef,
      bundle_id: bundleId,
      simulator: {
        udid: simulator?.udid || null,
        name: simulator?.name || null,
        state: simulator?.state || null,
      },
      app_state: appState,
      ui_actions: observedActions,
    };
  }
}

let normalizer = null;
if (blockers.length === 0 && capture) {
  mkdirSync(outDir, { recursive: true });
  jsonOut(capturePath, capture);
  if (normalize) {
    if (!isAbsolute(normalizerOutDir)) {
      block("path_not_absolute", `normalizer-out-dir:${normalizerOutDir}`);
    } else {
      const result = run("node", [
        resolve(repoRoot, "scripts/ops/friday-ui-device-accessibility-click-capture.mjs"),
        `--mission-id=${missionId}`,
        `--out-dir=${normalizerOutDir}`,
        `--capture=${capturePath}`,
        "--require-ready",
      ]);
      normalizer = {
        status: result.status,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
      };
      if (result.status !== 0) block("normalizer_failed", result.stderr.trim() || result.stdout.trim() || String(result.status));
    }
  }
}

const summary = {
  generated_at_utc: new Date().toISOString(),
  truth: blockers.length === 0 && observedActions.length > 0
    ? "ios_sim_accessibility_capture_real_simulator_accessibility_not_endbar"
    : "ios_sim_accessibility_capture_blocked_not_runtime_proof",
  status: blockers.length === 0 && observedActions.length > 0 ? "capture_ready" : "blocked",
  missionId: missionId || null,
  simulator,
  app_state: appState,
  capture: blockers.length === 0 && capture ? {
    path: capturePath,
    observed_count: observedActions.length,
  } : null,
  normalized: normalize ? {
    out_dir: normalizerOutDir || null,
    status: normalizer?.status ?? null,
  } : null,
  blockers,
  caveats: [
    "Real mode requires simctl Simulator/app state plus non-screenshot accessibility observations.",
    "The produced capture JSON is a normalizer input, not END-BAR proof by itself.",
    "This script does not infer accessibility truth from screenshots or static Swift declarations.",
  ],
};
if (summaryPath) jsonOut(summaryPath, summary);
console.log(JSON.stringify(summary, null, 2));
process.exit(blockers.length > 0 || (requireObserved && observedActions.length === 0) ? 2 : 0);
