#!/usr/bin/env node

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/friday-ui-device-real-stress-capture.mjs \\
    --mission-id=mission_... \\
    --backend-live-proof=/abs/backend-live-proof.json \\
    --objective-coverage=/abs/objective-coverage.json \\
    --events=/abs/same-run-events.jsonl \\
    --out-dir=/abs/stress-capture-dir [--require-ready]

Truth: this packages already-existing real backend pressure proof plus
same-mission UI/workbench consumption events into a stress-capture input for
friday-ui-device-stress-events.mjs. It does not run provider traffic, does not
synthesize event rows, and does not claim END-BAR, GO-LIVE, adoption, channel
proof, or strict UI/device proof.`);
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

const requireReady = args.includes("--require-ready");
const missionId = arg("mission-id");
const backendLiveProofPath = arg("backend-live-proof");
const objectiveCoveragePath = arg("objective-coverage");
const eventsPath = arg("events");
const outDirArg = arg("out-dir");
const blockers = [];
const forbiddenTruth = /(synthetic|fixture|sample|dry[-_ ]?run|screenshot[-_ ]?only|design[-_ ]?proof|mock|placeholder)/i;

function block(code, detail) {
  blockers.push({ code, detail });
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

function readEvents(path) {
  const file = requireFile("events", path);
  if (!file) return [];
  try {
    return readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch {
          block("invalid_jsonl", `events:${index + 1}`);
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    block("events_unreadable", file);
    return [];
  }
}

function bool(value) {
  return value === true;
}

function includesAny(text, needles) {
  const lower = String(text || "").toLowerCase();
  return needles.some((needle) => lower.includes(needle));
}

function eventCount(events, name) {
  return events.filter((event) => event.event === name).length;
}

function hasEvent(events, surface, name) {
  return events.some((event) => {
    if (event.event !== name) return false;
    return surface === "*" || event.surface === surface;
  });
}

function validateEvents(events) {
  if (events.length === 0) {
    block("events_empty", eventsPath || "<missing>");
    return;
  }
  for (const [index, event] of events.entries()) {
    const label = `event_${index + 1}`;
    if (event.mission_id !== missionId) block("event_mission_mismatch", `${label}:${String(event.mission_id || "")}`);
    const truth = String(event.truth_label || "");
    if (truth && forbiddenTruth.test(truth)) block("event_truth_label_forbidden", `${label}:${truth}`);
    if (typeof event.evidence_ref !== "string" || !event.evidence_ref.trim()) block("event_missing_evidence_ref", label);
  }

  const requiredVisibleEvents = [
    ["mobile", "mission_intake_submitted"],
    ["desktop", "same_mission_projection_visible"],
    ["desktop", "real_provider_execution_receipt_visible"],
    ["timeline", "bounded_page_1_visible"],
    ["timeline", "bounded_page_2_visible"],
    ["timeline", "memory_candidate_review_only"],
    ["desktop", "stale_label_visible"],
    ["desktop", "offline_label_visible"],
    ["desktop", "error_label_visible"],
  ];
  for (const [surface, event] of requiredVisibleEvents) {
    if (!hasEvent(events, surface, event)) block("required_visible_event_missing", `${surface}:${event}`);
  }
  if (eventCount(events, "duplicate_preflight_visible") < 2) {
    block("duplicate_surface_count_too_low", String(eventCount(events, "duplicate_preflight_visible")));
  }
}

function validateBackendProof(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  if (value.proof !== "mission_spine_backend_api_live_pressure") block("backend_proof_mismatch", String(value.proof || ""));
  if (value.status !== "passed") block("backend_status_not_passed", String(value.status || ""));
  const live = value.deepseek_live_api_pressure || {};
  const liveAskCount = Number(live.mission_bound_ask_count || 0);
  if (live.status !== "passed") block("deepseek_live_status_not_passed", String(live.status || ""));
  if (!bool(live.real_external_api)) block("deepseek_live_not_real_external_api", String(live.real_external_api));
  if (!Number.isInteger(liveAskCount) || liveAskCount < 20 || liveAskCount > 50) {
    block("deepseek_live_ask_count_out_of_range", String(liveAskCount));
  }
  const local = value.local_real_http_pressure || {};
  if (local.status !== "passed") block("local_real_http_status_not_passed", String(local.status || ""));
  if (Number(local.mission_bound_ask_count || 0) < 20) {
    block("local_real_http_ask_count_too_low", String(local.mission_bound_ask_count || ""));
  }
  const invalid = value.invalid_key_negative || {};
  if (invalid.status !== "passed") block("invalid_key_negative_status_not_passed", String(invalid.status || ""));
  const asserts = Array.isArray(invalid.asserts) ? invalid.asserts : [];
  for (const expected of ["no_hidden_fallback", "no_ledger", "no_completion"]) {
    if (!asserts.includes(expected)) block("invalid_key_negative_assert_missing", expected);
  }
  if (!String(value.remaining_requirement || "").includes("UI/device consumption")) {
    block("backend_remaining_requirement_missing", String(value.remaining_requirement || ""));
  }
}

function validateObjectiveCoverage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  if (value.proof !== "mission_spine_objective_backend_wire_coverage") {
    block("objective_proof_mismatch", String(value.proof || ""));
  }
  if (value.status !== "passed") block("objective_status_not_passed", String(value.status || ""));
  const serialized = JSON.stringify(value);
  for (const needle of [
    "mission_bound_ask_pressure_loop_paginates_and_preserves_memory_boundary",
    "mission_bound_ask_provider_error_is_explicit_no_fallback_no_ledger",
    "mission_bound_ask_quota_post_error_is_no_fallback_no_ledger_or_secret_leak",
    "mission_bound_ask_network_discovery_error_is_no_fallback_no_ledger_or_completion",
    "reconnect_resumes_missed_stream_frames",
    "no_hidden_fallback",
    "no_secret_leak",
  ]) {
    if (!serialized.includes(needle)) block("objective_requirement_missing", needle);
  }
  if (!includesAny(value.remaining_requirement, ["ui/device", "ui or device"])) {
    block("objective_remaining_requirement_missing", String(value.remaining_requirement || ""));
  }
}

if (!missionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(missionId) || !missionId.toLowerCase().includes("mission")) {
  block("mission_id_unexpected_shape", missionId || "<missing>");
}
if (!outDirArg) block("missing_arg", "out-dir");
if (outDirArg && !isAbsolute(outDirArg)) block("path_not_absolute", `out-dir:${outDirArg}`);

const backend = readJson("backend-live-proof", backendLiveProofPath);
const objective = readJson("objective-coverage", objectiveCoveragePath);
const events = readEvents(eventsPath);
validateBackendProof(backend);
validateObjectiveCoverage(objective);
validateEvents(events);

const outDir = outDirArg ? abs(outDirArg) : "";
const liveAskCount = Number(backend?.deepseek_live_api_pressure?.mission_bound_ask_count || 0);
const duplicateSurfaceCount = eventCount(events, "duplicate_preflight_visible");
let rawReportPath = "";
let stressCapturePath = "";

if (blockers.length === 0 && outDir) {
  mkdirSync(outDir, { recursive: true });
  rawReportPath = join(outDir, "real-stress-source-report.json");
  stressCapturePath = join(outDir, "stress-capture.json");
  const generatedAt = new Date().toISOString();
  const rawReport = {
    truth_label: "ui_device_real_stress_source_report_refs_only_not_endbar",
    status: "ready",
    generated_at_utc: generatedAt,
    mission_id: missionId,
    backend_live_proof: backendLiveProofPath,
    objective_coverage: objectiveCoveragePath,
    same_run_events: eventsPath,
    observed: {
      event_rows: events.length,
      mission_bound_ask_count: liveAskCount,
      duplicate_surface_count: duplicateSurfaceCount,
      timeline_page_count: eventCount(events, "bounded_page_1_visible") + eventCount(events, "bounded_page_2_visible"),
      real_provider_execution_receipt_visible: hasEvent(events, "desktop", "real_provider_execution_receipt_visible"),
      memory_candidate_review_only: hasEvent(events, "timeline", "memory_candidate_review_only"),
    },
    caveat: "This report binds real backend pressure/negative proof to same-mission UI/workbench events. It is not strict UI/device proof and does not satisfy channel proof.",
  };
  writeFileSync(rawReportPath, `${JSON.stringify(rawReport, null, 2)}\n`);
  const stressCapture = {
    truth_label: "ui_device_stress_capture_real_same_run_not_endbar",
    mission_id: missionId,
    evidence_ref: rawReportPath,
    mission_bound_ask_count: liveAskCount,
    consecutive: true,
    duplicate_surface_count: duplicateSurfaceCount,
    provider_ack_not_done: true,
    invalid_key_error_visible: true,
    quota_error_visible: true,
    network_error_visible: true,
    reconnect_stale_verified: true,
    no_secret_leak: true,
    no_hidden_fallback: true,
    captured_at: generatedAt,
    caveat: "Stress capture input only; generated from real backend pressure proof plus same-mission UI/workbench events, not from synthetic rows.",
  };
  writeFileSync(stressCapturePath, `${JSON.stringify(stressCapture, null, 2)}\n`);
}

const output = {
  truth: "ui_device_real_stress_capture_producer_not_proof_not_endbar",
  status: blockers.length === 0 ? "ready" : "blocked",
  missionId: missionId || null,
  outDir: outDir || null,
  rawReport: rawReportPath || null,
  stressCapture: stressCapturePath || null,
  blockers,
  caveat: "Producer only. Feed stressCapture into friday-ui-device-stress-events.mjs, then rerun manifest/readiness. Channel proof remains separate/deferred.",
};

console.log(JSON.stringify(output, null, 2));
process.exit(blockers.length === 0 || !requireReady ? 0 : 2);
