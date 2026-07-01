#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/check-friday-integrated-end-to-end-tape-report.mjs \\
    --ui-device-summary=/abs/ui-device-shortlist-summary.json \\
    [--out=/abs/integrated-end-to-end-tape-report.json] [--require-ready]

Truth: validates an already-captured same-mission mobile+desktop UI/device
summary as an END-BAR integrated_end_to_end_tape group report. It does not run
apps, providers, channels, write DB rows, create evidence, mark GO-LIVE, or
claim adoption.`);
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

function hasDeferredSignal(summary) {
  const haystack = [
    string(summary?.status),
    string(summary?.truth),
    string(summary?.captureDirStatus),
    string(summary?.readinessStatus),
    JSON.stringify(summary?.readinessBlockers || []),
    JSON.stringify(summary?.uiDeviceProofReadiness?.blockers || []),
  ].join("\n").toLowerCase();
  return haystack.includes("defer") || haystack.includes("channel_deferred");
}

function hasCapture(capture, missionId) {
  if (!capture || typeof capture !== "object" || Array.isArray(capture)) return false;
  if (capture.mission_id !== missionId) return false;
  if (!fileExists(capture.proof)) return false;
  if (!fileExists(capture.events)) return false;
  if (!fileExists(capture.action_runtime_evidence)) return false;
  if (Number(capture.event_count || 0) <= 0) return false;
  if (Number(capture.action_count || 0) <= 0) return false;
  return true;
}

const summary = readJson("ui-device-summary", summaryPath);

if (summary && typeof summary === "object" && !Array.isArray(summary)) {
  const missionId = string(summary.missionId || summary.mission_id);
  const captures = summary.captures || {};
  const mobile = captures.mobile;
  const desktop = captures.desktop;
  const uiReadiness = summary.uiDeviceProofReadiness || {};
  const fullProofGaps = array(summary.fullProofGaps);

  check("summary_truth_shape", string(summary.truth).includes("ui_device_shortlist_runner_summary") || string(summary.truth).includes("uiux_real_use"), string(summary.truth));
  check("mission_id_present", missionId.toLowerCase().includes("mission"), missionId);
  check("mobile_capture_same_mission", hasCapture(mobile, missionId), mobile?.proof || "<missing>");
  check("desktop_capture_same_mission", hasCapture(desktop, missionId), desktop?.proof || "<missing>");
  check("workbench_timeline_ready", ["snapshot_ready_events_ready", "ready"].includes(string(summary.workbenchTimelineStatus)), string(summary.workbenchTimelineStatus));
  check("stress_capture_ready", ["ready", "passed"].includes(string(summary.stressCaptureStatus)), string(summary.stressCaptureStatus));
  check("accessibility_capture_ready", ["ready", "passed"].includes(string(summary.accessibilityCaptureStatus)), string(summary.accessibilityCaptureStatus));
  check("product_closure_evidence_ready", ["uiux_product_closure_evidence_ready", "ready", "passed"].includes(string(summary.productClosureStatus)), string(summary.productClosureStatus));
  check("readiness_report_present", uiReadiness && typeof uiReadiness === "object" && !Array.isArray(uiReadiness), "uiDeviceProofReadiness object");
  check("no_channel_deferred_signal", !hasDeferredSignal(summary), array(summary.readinessBlockers).join(",") || string(summary.readinessStatus));
  check("strict_ui_device_readiness_passed", string(uiReadiness.status) === "pass" || string(uiReadiness.status) === "strict_ui_device_ready", string(uiReadiness.status));
  check("no_full_proof_gaps", fullProofGaps.length === 0, fullProofGaps.join(","));
} else if (summary) {
  block("summary_not_object", summaryPath);
}

const ready = blockers.length === 0;
const report = {
  truth: "integrated_end_to_end_tape_report",
  status: ready ? "integrated_end_to_end_tape_ready" : "blocked",
  generated_at_utc: new Date().toISOString(),
  inputs: {
    ui_device_summary: summaryPath || null,
  },
  passBar: {
    goal_to_governed_execution_to_readback_to_memory_or_candidate: checks.some((row) => row.id === "workbench_timeline_ready" && row.status === "passed"),
    mobile_and_desktop_same_mission_truth: checks.some((row) => row.id === "mobile_capture_same_mission" && row.status === "passed")
      && checks.some((row) => row.id === "desktop_capture_same_mission" && row.status === "passed"),
    negative_controls_present: checks.some((row) => row.id === "stress_capture_ready" && row.status === "passed")
      && checks.some((row) => row.id === "accessibility_capture_ready" && row.status === "passed"),
    channel_current_and_linked: checks.some((row) => row.id === "no_channel_deferred_signal" && row.status === "passed"),
  },
  checks,
  blockers,
  caveat: "This is an integrated tape report over supplied artifacts only. Deferred channel proof or UI/device blockers keep it blocked; it is not release, GO-LIVE, or adoption.",
};

if (outPath) {
  const out = abs(outPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify(report, null, 2));
process.exit(ready || !requireReady ? 0 : 2);
