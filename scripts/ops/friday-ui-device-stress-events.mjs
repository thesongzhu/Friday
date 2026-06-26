#!/usr/bin/env node

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/friday-ui-device-stress-events.mjs \\
    --mission-id=mission_... \\
    --stress-capture=/abs/real-stress-capture.json \\
    --out=/abs/stress-events.jsonl [--require-ready]

Stress capture JSON shape:
  {
    "truth_label": "ui_device_stress_capture_real_same_run_not_endbar",
    "mission_id": "mission_...",
    "evidence_ref": "/abs/raw-stress-log-or-report.json",
    "mission_bound_ask_count": 20,
    "consecutive": true,
    "duplicate_surface_count": 2,
    "provider_ack_not_done": true,
    "invalid_key_error_visible": true,
    "quota_error_visible": true,
    "network_error_visible": true,
    "reconnect_stale_verified": true,
    "no_secret_leak": true,
    "no_hidden_fallback": true
  }

Truth: converts an already-captured real same-run stress report into conservative
UI/device event rows. It does not run stress, does not synthesize failures, does
not assemble proof, and is not END-BAR/adoption proof.`);
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
const stressCapturePath = arg("stress-capture");
const outPath = arg("out");
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

function readJson(path, label) {
  const file = requireFile(label, path);
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    block("invalid_json", `${label}:${error.message}`);
    return null;
  }
}

function bool(value) {
  return value === true;
}

function addRows(rows, count, event, surface, evidenceRef, capturedAt, source) {
  for (let index = 0; index < count; index += 1) {
    rows.push({
      surface,
      event,
      mission_id: missionId,
      evidence_ref: evidenceRef,
      truth_label: "derived_from_real_same_run_stress_capture_not_final_proof",
      source: count > 1 ? `${source}:${index + 1}` : source,
      captured_at: capturedAt,
    });
  }
}

if (!missionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(missionId) || !missionId.toLowerCase().includes("mission")) {
  block("mission_id_unexpected_shape", missionId || "<missing>");
}
if (!outPath) block("missing_arg", "out");
if (outPath && !isAbsolute(outPath)) block("path_not_absolute", `out:${outPath}`);

const capture = readJson(stressCapturePath, "stress-capture");
const rows = [];

if (capture && typeof capture === "object" && !Array.isArray(capture)) {
  const truth = String(capture.truth_label || capture.truthLabel || capture.truth || "");
  const captureMissionId = String(capture.mission_id || capture.missionId || "");
  const evidenceRef = requireFile("evidence_ref", String(capture.evidence_ref || capture.evidenceRef || ""));
  const askCount = Number(capture.mission_bound_ask_count ?? capture.missionBoundAskCount ?? 0);
  const duplicateSurfaceCount = Number(capture.duplicate_surface_count ?? capture.duplicateSurfaceCount ?? 0);
  const capturedAt = String(capture.captured_at || capture.capturedAt || new Date().toISOString());

  if (!truth) block("truth_label_missing", "stress-capture");
  if (truth && !/stress.*real|real.*stress|same[-_ ]?run/i.test(truth)) {
    block("truth_label_not_real_stress", truth);
  }
  if (truth && forbiddenTruth.test(truth)) block("truth_label_forbidden", truth);
  if (captureMissionId !== missionId) block("mission_id_mismatch", captureMissionId || "<missing>");
  if (!Number.isInteger(askCount) || askCount < 20 || askCount > 50) {
    block("mission_bound_ask_count_out_of_range", String(askCount));
  }
  if (!bool(capture.consecutive)) block("consecutive_not_true", String(capture.consecutive));
  if (!Number.isInteger(duplicateSurfaceCount) || duplicateSurfaceCount < 2) {
    block("duplicate_surface_count_too_low", String(duplicateSurfaceCount));
  }

  for (const key of [
    "provider_ack_not_done",
    "invalid_key_error_visible",
    "quota_error_visible",
    "network_error_visible",
    "reconnect_stale_verified",
    "no_secret_leak",
    "no_hidden_fallback",
  ]) {
    if (!bool(capture[key])) block(`${key}_not_true`, String(capture[key]));
  }

  if (blockers.length === 0) {
    addRows(rows, askCount, "pressure_20_50_consecutive_asks_visible", "desktop", evidenceRef, capturedAt, "stress:mission_bound_ask");
    addRows(rows, duplicateSurfaceCount, "duplicate_preflight_visible", "desktop", evidenceRef, capturedAt, "stress:duplicate_surface");
    addRows(rows, 1, "provider_ack_not_done_visible", "desktop", evidenceRef, capturedAt, "stress:provider_ack_not_done");
    addRows(rows, 1, "invalid_key_error_visible", "desktop", evidenceRef, capturedAt, "stress:invalid_key");
    addRows(rows, 1, "quota_error_visible", "desktop", evidenceRef, capturedAt, "stress:quota");
    addRows(rows, 1, "network_error_visible", "desktop", evidenceRef, capturedAt, "stress:network");
    addRows(rows, 1, "reconnect_stale_verified", "desktop", evidenceRef, capturedAt, "stress:reconnect");
    addRows(rows, 1, "no_hidden_fallback_verified", "timeline", evidenceRef, capturedAt, "stress:no_hidden_fallback");
  }
} else if (capture) {
  block("stress_capture_not_object", stressCapturePath || "<missing>");
}

if (blockers.length === 0 && outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

const output = {
  truth: "ui_device_stress_events_bridge_not_proof_not_endbar",
  status: blockers.length === 0 ? "ready" : "blocked",
  missionId: missionId || null,
  stressCapture: stressCapturePath || null,
  out: outPath || null,
  outputRows: rows.length,
  blockers,
  caveat: "Stress event bridge only. These rows are useful input for gap/readiness tooling but do not prove channel, timeline pagination, manifest completeness, END-BAR, GO-LIVE, or adoption.",
};

console.log(JSON.stringify(output, null, 2));
process.exit(blockers.length === 0 || !requireReady ? 0 : 2);
