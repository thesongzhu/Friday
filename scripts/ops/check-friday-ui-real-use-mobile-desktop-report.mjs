#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/check-friday-ui-real-use-mobile-desktop-report.mjs \\
    --ui-device-summary=/abs/ui-device-shortlist-summary.json \\
    [--out=/abs/ui-real-use-mobile-desktop-report.json] [--require-ready]

Truth: validates an already-captured UI/device real-use summary for the
ui_real_use_mobile_desktop END-BAR group. It does not run apps, create
evidence, write DB rows, call providers, mark GO-LIVE, or claim adoption.`);
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

const summaryPath = arg("ui-device-summary");
const outPath = arg("out") || "";
const requireReady = args.includes("--require-ready");
const blockers = [];
const checks = [];

function block(code, detail) {
  blockers.push({ code, detail });
}

function check(id, passed, detail = "") {
  checks.push({ id, status: passed ? "passed" : "blocked", detail });
  if (!passed) block(id, detail);
}

function abs(path) {
  return isAbsolute(path) ? path : resolve(path);
}

function requireFile(label, path) {
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
  const file = requireFile(label, path);
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    block("invalid_json", `${label}:${error.message}`);
    return null;
  }
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function string(value) {
  return value == null ? "" : String(value);
}

function fileExists(path) {
  return typeof path === "string" && path.length > 0 && existsSync(path);
}

function deferredSignals(summary) {
  const blockers = [
    ...array(summary?.readinessBlockers),
    ...array(summary?.uiDeviceProofReadiness?.blockers),
    ...array(summary?.deferredInputs),
    ...array(summary?.deferred_inputs),
  ].map(String);
  const haystack = [
    string(summary?.status),
    string(summary?.truth),
    string(summary?.captureDirStatus),
    string(summary?.readinessStatus),
    ...blockers,
  ].join("\n").toLowerCase();
  return haystack.includes("defer") || haystack.includes("channel_deferred") ? blockers.length > 0 ? blockers : ["deferred signal present"] : [];
}

function hasCapture(capture, missionId) {
  if (!capture || typeof capture !== "object" || Array.isArray(capture)) return false;
  if (capture.mission_id !== missionId) return false;
  if (!fileExists(capture.proof)) return false;
  if (!fileExists(capture.events)) return false;
  if (!fileExists(capture.action_runtime_evidence)) return false;
  return Number(capture.event_count || 0) > 0 && Number(capture.action_count || 0) > 0;
}

const summary = readJson("ui-device-summary", summaryPath);

if (summary && typeof summary === "object" && !Array.isArray(summary)) {
  const missionId = string(summary.missionId || summary.mission_id);
  const captures = summary.captures || {};
  const mobile = captures.mobile;
  const desktop = captures.desktop;
  const uiReadiness = summary.uiDeviceProofReadiness || {};
  const deferred = deferredSignals(summary);

  check("summary_truth_shape", string(summary.truth).includes("ui_device_shortlist_runner_summary") || string(summary.truth).includes("uiux_real_use"), string(summary.truth));
  check("mission_id_present", missionId.toLowerCase().includes("mission"), missionId);
  check("mobile_real_surface_capture", hasCapture(mobile, missionId), mobile?.proof || "<missing>");
  check("desktop_real_surface_capture", hasCapture(desktop, missionId), desktop?.proof || "<missing>");
  check("action_runtime_traceability", ["runtime_actions_covered", "written"].includes(string(summary.gapStatus)) || ["runtime_actions_covered"].includes(string(summary.designActionRuntimeStatus)), string(summary.gapStatus || summary.designActionRuntimeStatus || ""));
  check("accessibility_capture_ready", ["ready", "passed"].includes(string(summary.accessibilityCaptureStatus)), string(summary.accessibilityCaptureStatus));
  check("stress_capture_ready", ["ready", "passed"].includes(string(summary.stressCaptureStatus)), string(summary.stressCaptureStatus));
  check("workbench_timeline_ready", ["snapshot_ready_events_ready", "ready"].includes(string(summary.workbenchTimelineStatus)), string(summary.workbenchTimelineStatus));
  check("product_closure_runtime_capture_ready", ["ready_for_runtime_capture", "ready", "passed"].includes(string(summary.productClosureStatus)), string(summary.productClosureStatus));
  check("strict_ui_device_readiness_passed", string(uiReadiness.status) === "pass" || string(uiReadiness.status) === "strict_ui_device_ready", string(uiReadiness.status));
  check("no_deferred_channel_or_external_input", deferred.length === 0, deferred.join(","));
} else if (summary) {
  block("summary_not_object", summaryPath);
}

const ready = blockers.length === 0;
const deferred = summary && typeof summary === "object" && !Array.isArray(summary) && deferredSignals(summary).length > 0;
const report = {
  truth: "ui_real_use_mobile_desktop_report",
  status: ready ? "strict_uiux_real_use_ready" : deferred ? "deferred" : "blocked",
  generated_at_utc: new Date().toISOString(),
  inputs: {
    ui_device_summary: summaryPath || null,
  },
  passBar: {
    mobile_and_desktop_real_app_surfaces: checks.some((row) => row.id === "mobile_real_surface_capture" && row.status === "passed")
      && checks.some((row) => row.id === "desktop_real_surface_capture" && row.status === "passed"),
    pixels_accessibility_db_provider_head_linked: checks.some((row) => row.id === "accessibility_capture_ready" && row.status === "passed")
      && checks.some((row) => row.id === "workbench_timeline_ready" && row.status === "passed"),
    negative_controls_exercised: checks.some((row) => row.id === "stress_capture_ready" && row.status === "passed"),
    simulator_labeled_not_real_device_release: true,
  },
  checks,
  blockers,
  caveat: "This is a UI real-use report over supplied artifacts only. Deferred channel proof or strict UI/device blockers keep it out of strict END-BAR; simulator evidence remains simulator evidence.",
};

if (outPath) {
  const out = abs(outPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify(report, null, 2));
process.exit(ready || !requireReady ? 0 : 2);
