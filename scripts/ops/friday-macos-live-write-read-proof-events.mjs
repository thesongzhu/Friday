#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/friday-macos-live-write-read-proof-events.mjs \\
    --proof=/abs/friday-macos-desktop-roundtrip-proof.json \\
    [--out=/abs/desktop-roundtrip-events.jsonl] [--require-ready]

Truth: converts one real macOS live write-read roundtrip artifact into desktop
same-run events for the UI/device capture pipeline. It is not END-BAR proof,
does not invent mobile/channel/timeline observations, and never reads secrets.`);
}

function arg(name) {
  const prefix = `--${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length) || "";
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const proofPath = arg("proof");
const outPath = arg("out");
const requireReady = args.includes("--require-ready");
const blockers = [];

function block(code, detail) {
  blockers.push({ code, detail });
}

function abs(path) {
  return isAbsolute(path) ? path : resolve(path);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    block("proof_unreadable_or_invalid_json", path || "<missing>");
    return null;
  }
}

function stringField(value, field, label) {
  if (value && typeof value[field] === "string" && value[field].trim()) return value[field].trim();
  block("proof_missing_string", `${label}.${field}`);
  return "";
}

function booleanField(value, field, label) {
  if (value && typeof value[field] === "boolean") return value[field];
  block("proof_missing_boolean", `${label}.${field}`);
  return false;
}

function arrayField(value, field, label) {
  if (value && Array.isArray(value[field])) return value[field];
  block("proof_missing_array", `${label}.${field}`);
  return [];
}

if (!proofPath) block("missing_arg", "proof");
const proof = proofPath ? readJson(abs(proofPath)) : null;
const evidenceRef = proofPath ? abs(proofPath) : "";

if (proof) {
  const serialized = JSON.stringify(proof);
  if (/(bearer|authorization|passphrase|secret|api[_-]?key)/i.test(serialized)) {
    block("proof_contains_sensitive_marker", "roundtrip proof must be redacted");
  }
}

const truthLabel = proof ? stringField(proof, "truth_label", "proof") : "";
if (truthLabel && truthLabel !== "macos_desktop_live_write_read_roundtrip_proof_not_ui_device_proof") {
  block("proof_truth_label_unexpected", truthLabel);
}

const status = proof ? stringField(proof, "status", "proof") : "";
if (status && status !== "pass") block("proof_status_not_pass", status);

const missionId = proof ? stringField(proof, "mission_id", "proof") : "";
const workItemId = proof ? stringField(proof, "work_item_id", "proof") : "";
const surfaceKind = proof ? stringField(proof, "surface_kind", "proof") : "";
if (missionId && !missionId.toLowerCase().includes("mission")) {
  block("mission_id_unexpected_shape", missionId);
}
if (surfaceKind && surfaceKind !== "desktop") block("surface_kind_not_desktop", surfaceKind);

const write = proof?.write ?? null;
const writeStatus = stringField(write, "status", "proof.write");
if (writeStatus && writeStatus !== "ready") block("write_status_not_ready", writeStatus);
if (!booleanField(write, "created_or_ready", "proof.write")) {
  block("write_created_or_ready_false", "proof.write.created_or_ready");
}
if (write && write.mission_id !== missionId) block("write_mission_mismatch", String(write.mission_id ?? ""));
if (write && write.work_item_id !== workItemId) block("write_work_item_mismatch", String(write.work_item_id ?? ""));

const readProjection = proof?.read_projection ?? null;
if (readProjection && readProjection.mission_id !== missionId) {
  block("read_projection_mission_mismatch", String(readProjection.mission_id ?? ""));
}
const projectedWorkItems = arrayField(readProjection, "work_item_ids", "proof.read_projection");
if (!projectedWorkItems.includes(workItemId)) block("read_projection_missing_work_item", workItemId);
if (!booleanField(readProjection, "contains_written_work_item", "proof.read_projection")) {
  block("read_projection_contains_written_work_item_false", workItemId);
}

const eventNames = [
  "mission_intake_submitted",
  "mission_intake_ready",
  "mission_bound_provider_action_visible",
  "proof_receipt_visible_before_done",
  "same_mission_projection_visible",
];
const events = blockers.length === 0
  ? eventNames.map((event) => ({
    surface: "desktop",
    event,
    mission_id: missionId,
    evidence_ref: evidenceRef,
    work_item_id: workItemId,
    source: "macos_desktop_live_write_read_roundtrip_artifact",
    truth_label: "desktop_same_run_event_from_live_write_read_artifact_not_ui_device_proof",
  }))
  : [];

if (outPath && blockers.length === 0) {
  const out = abs(outPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

const output = {
  truth: "macos_desktop_live_write_read_events_driver_not_ui_device_proof",
  status: blockers.length === 0 ? "ready" : "blocked",
  missionId: missionId || null,
  workItemId: workItemId || null,
  evidenceRef: evidenceRef || null,
  out: outPath ? abs(outPath) : null,
  eventCount: events.length,
  blockers,
  caveat: "Desktop same-run events only; combine with real mobile/channel/timeline evidence before strict UI/device proof.",
};

console.log(JSON.stringify(output, null, 2));
if (!outPath && blockers.length === 0) {
  process.stdout.write(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}
process.exit(blockers.length === 0 || !requireReady ? 0 : 2);
