#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);

const allowedSurfaces = new Set(["mobile", "desktop"]);
const allowedCaptureMethods = new Set([
  "ios_simulator_accessibility",
  "ios_device_accessibility",
  "macos_accessibility",
]);
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
const forbiddenTruth = /(synthetic|fixture|sample|dry[-_ ]?run|screenshot[-_ ]?only|design[-_ ]?proof|mock|placeholder)/i;

function usage() {
  console.error(`usage:
  node scripts/ops/friday-ui-device-accessibility-click-capture.mjs \\
    --mission-id=mission_... \\
    --out-dir=/abs/out-dir \\
    --capture=/abs/mobile-accessibility-capture.json [--capture=/abs/desktop-accessibility-capture.json ...] \\
    [--require-ready]

Input capture JSON shape:
  {
    "truth_label": "ui_device_accessibility_click_capture_real_ui_not_endbar",
    "mission_id": "mission_...",
    "surface": "mobile|desktop",
    "capture_method": "ios_simulator_accessibility|ios_device_accessibility|macos_accessibility",
    "evidence_ref": "/abs/raw-real-capture-or-log",
    "ui_actions": [{
      "screen": "fridayChat",
      "runtimeActionId": "mobile/home/refresh",
      "action_id": "optional design action id",
      "capability_id": "optional capability id",
      "accessibility_id": "friday.chat.send",
      "interaction": "tap|visible|type|read",
      "status": "pass",
      "event": "mission_intake_submitted",
      "evidence_ref": "/abs/specific-evidence"
    }]
  }

Truth: normalizes already-captured real accessibility click/visible observations
into same-run event rows and action-runtime evidence. It does not drive the UI by
itself, does not accept synthetic/dry-run/screenshot-only evidence, and is not
END-BAR proof.`);
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

const missionId = arg("mission-id");
const outDir = arg("out-dir");
const captureInputs = argsAll("capture");
const requireReady = args.includes("--require-ready");
const blockers = [];

function block(code, detail) {
  blockers.push({ code, detail });
}

function abs(path) {
  return isAbsolute(path) ? path : resolve(path);
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

function truthString(value) {
  return String(value?.truth_label || value?.truthLabel || value?.truth || "");
}

function validateTruth(label, value) {
  const truth = truthString(value);
  if (!truth) {
    block("truth_label_missing", label);
  } else {
    if (!/accessibility.*real|real.*accessibility/i.test(truth)) {
      block("truth_label_not_real_accessibility", `${label}:${truth}`);
    }
    if (forbiddenTruth.test(truth)) block("truth_label_forbidden", `${label}:${truth}`);
  }
  return truth;
}

function validateMission(label, value) {
  const id = String(value?.mission_id || value?.missionId || "");
  if (id !== missionId) block("mission_id_mismatch", `${label}:${id || "<missing>"}`);
}

function evidenceRefFor(capturePath, capture, action, label) {
  const ref = String(action?.evidence_ref || action?.evidenceRef || capture?.evidence_ref || capture?.evidenceRef || capturePath);
  const resolved = requireAbsoluteFile(`${label}:evidence_ref`, ref);
  return resolved || ref;
}

function normalizedEventFor(surface, actionId, event) {
  if (
    surface === "desktop"
    && actionId === "desktop/diagnostics/proof-refs"
    && event === "proof_receipt_visible_before_done"
  ) {
    return "real_provider_execution_receipt_visible";
  }
  return event;
}

function normalizeCapture(capturePath, raw) {
  const captures = Array.isArray(raw?.captures) ? raw.captures : [raw];
  const rows = [];
  const actions = [];
  for (const [captureIndex, capture] of captures.entries()) {
    const label = `${capturePath}:capture_${captureIndex + 1}`;
    if (!capture || typeof capture !== "object" || Array.isArray(capture)) {
      block("capture_not_object", label);
      continue;
    }
    validateTruth(label, capture);
    validateMission(label, capture);
    const surface = String(capture.surface || "").trim();
    const method = String(capture.capture_method || capture.captureMethod || "").trim();
    if (!allowedSurfaces.has(surface)) block("surface_not_supported", `${label}:${surface || "<missing>"}`);
    if (!allowedCaptureMethods.has(method)) block("capture_method_not_supported", `${label}:${method || "<missing>"}`);
    if (forbiddenTruth.test(method)) block("capture_method_forbidden", `${label}:${method}`);

    const uiActions = Array.isArray(capture.ui_actions)
      ? capture.ui_actions
      : Array.isArray(capture.uiActions)
        ? capture.uiActions
        : [];
    if (uiActions.length === 0) block("ui_actions_missing", label);

    for (const [actionIndex, action] of uiActions.entries()) {
      const actionLabel = `${label}:ui_action_${actionIndex + 1}`;
      if (!action || typeof action !== "object" || Array.isArray(action)) {
        block("ui_action_not_object", actionLabel);
        continue;
      }
      const actionSurface = String(action.surface || surface).trim();
      const screen = String(action.screen || "").trim();
      const actionId = String(action.runtimeActionId || action.runtime_action_id || action.action_id || action.actionId || "").trim();
      const capabilityId = String(action.capability_id || action.capabilityId || "").trim();
      const accessibilityId = String(action.accessibility_id || action.accessibilityId || "").trim();
      const interaction = String(action.interaction || action.action || "").trim();
      const status = String(action.status || "").trim();
      const rawEvent = String(action.event || "").trim();
      const event = normalizedEventFor(actionSurface, actionId, rawEvent);
      const evidenceRef = evidenceRefFor(capturePath, capture, action, actionLabel);

      if (actionSurface !== surface) block("ui_action_surface_mismatch", `${actionLabel}:${actionSurface || "<missing>"}`);
      if (!screen) block("screen_missing", actionLabel);
      if (!actionId && !capabilityId) block("action_identity_missing", actionLabel);
      if (!accessibilityId) block("accessibility_id_missing", actionLabel);
      if (!allowedInteractions.has(interaction)) block("interaction_not_supported", `${actionLabel}:${interaction || "<missing>"}`);
      if (status !== "pass") block("status_not_pass", `${actionLabel}:${status || "<missing>"}`);
      if (forbiddenTruth.test(String(action.source || ""))) block("ui_action_source_forbidden", actionLabel);

      if (event) {
        if (!allowedEvents.has(event)) block("event_not_supported", `${actionLabel}:${event}`);
        rows.push({
          surface,
          event,
          mission_id: missionId,
          evidence_ref: evidenceRef,
          truth_label: "ui_device_accessibility_click_observation_real_ui_not_proof",
          source: `${method}:${accessibilityId}`,
          captured_at: String(action.captured_at || action.capturedAt || capture.captured_at || capture.capturedAt || ""),
        });
      }

      actions.push({
        surface,
        screen,
        action_id: actionId,
        ...(capabilityId ? { capability_id: capabilityId } : {}),
        status: "pass",
        evidence_ref: evidenceRef,
        mission_id: missionId,
        source: `${method}:${accessibilityId}:${interaction}`,
        truth_label: "accessibility_click_action_runtime_evidence_real_ui_not_endbar",
      });
    }
  }
  return { rows, actions };
}

if (!missionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(missionId) || !missionId.toLowerCase().includes("mission")) {
  block("mission_id_unexpected_shape", missionId || "<missing>");
}
if (!outDir) block("missing_arg", "out-dir");
if (outDir && !isAbsolute(outDir)) block("path_not_absolute", `out-dir:${outDir}`);
if (captureInputs.length === 0) block("missing_capture", "supply at least one --capture");

const normalized = captureInputs
  .map((path) => {
    const resolved = isAbsolute(path) ? path : path;
    const value = readJson("capture", resolved);
    return value ? normalizeCapture(resolved, value) : { rows: [], actions: [] };
  });

const eventRows = normalized.flatMap((item) => item.rows);
const actionRows = normalized.flatMap((item) => item.actions);
if (eventRows.length === 0) block("no_event_rows", "at least one ui_action must include a supported proof event");
if (actionRows.length === 0) block("no_action_runtime_rows", "at least one passed ui_action is required");

const output = {
  truth: "ui_device_accessibility_click_capture_normalized_not_proof_not_endbar",
  status: blockers.length === 0 ? "ready" : "blocked",
  missionId: missionId || null,
  captures: captureInputs.map((path) => abs(path)),
  counts: {
    eventRows: eventRows.length,
    actionRuntimeRows: actionRows.length,
  },
  outputs: outDir ? {
    events: resolve(outDir, "accessibility-click-events.jsonl"),
    actionRuntimeEvidence: resolve(outDir, "action-runtime-evidence.json"),
    runtimeEvidencePaths: resolve(outDir, "runtime-evidence-paths.txt"),
    index: resolve(outDir, "accessibility-click-capture-index.json"),
  } : null,
  blockers,
  caveat: "Normalizer only. It requires already-captured real accessibility observations and does not prove END-BAR until merged with mobile, desktop, channel, timeline, manifest, stress, and negative-control evidence.",
};

if (blockers.length === 0 && outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(output.outputs.events, `${eventRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  writeFileSync(output.outputs.actionRuntimeEvidence, `${JSON.stringify({
    truth: "accessibility_click_action_runtime_evidence_real_ui_not_endbar",
    status: "ready",
    missionId,
    actions: actionRows,
  }, null, 2)}\n`);
  writeFileSync(output.outputs.runtimeEvidencePaths, `${output.outputs.actionRuntimeEvidence}\n`);
  writeFileSync(output.outputs.index, `${JSON.stringify(output, null, 2)}\n`);
} else if (blockers.length === 0 && outDir && !existsSync(outDir)) {
  block("out_dir_not_created", outDir);
}

console.log(JSON.stringify(output, null, 2));
process.exit(blockers.length === 0 || !requireReady ? 0 : 2);
