#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/friday-ios-live-write-read-proof-events.mjs \\
    --proof=/abs/friday-ios-mobile-roundtrip-proof.json \\
    [--out=/abs/mobile-roundtrip-events.jsonl] \\
    [--action-runtime-out=/abs/action-runtime-evidence.json] [--require-ready]

Truth: converts one real iOS live write-read roundtrip artifact into mobile
same-run events for the UI/device capture pipeline. It is not END-BAR proof,
does not invent desktop/channel/timeline observations, and never reads secrets.
Optional action runtime evidence is exported only when the proof artifact already
contains explicit ui_actions rows from a real UI driver.`);
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
const actionRuntimeOutPath = arg("action-runtime-out");
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

function optionalArrayField(value, field) {
  return value && Array.isArray(value[field]) ? value[field] : [];
}

function explicitActionRows(value) {
  if (!value || value.ui_actions === undefined) return [];
  if (!Array.isArray(value.ui_actions)) {
    block("ui_actions_not_array", "proof.ui_actions");
    return [];
  }

  return value.ui_actions.map((row, index) => {
    const label = `proof.ui_actions[${index}]`;
    if (!row || typeof row !== "object") {
      block("ui_action_not_object", label);
      return null;
    }
    const surface = typeof row.surface === "string" && row.surface.trim() ? row.surface.trim() : "mobile";
    const screen = typeof row.screen === "string" && row.screen.trim() ? row.screen.trim() : "";
    const actionId = typeof row.action_id === "string" && row.action_id.trim() ? row.action_id.trim() : "";
    const capabilityId = typeof row.capability_id === "string" && row.capability_id.trim() ? row.capability_id.trim() : "";
    const status = typeof row.status === "string" && row.status.trim() ? row.status.trim() : "";
    const evidence = typeof row.evidence_ref === "string" && row.evidence_ref.trim() ? row.evidence_ref.trim() : evidenceRef;
    if (surface !== "mobile") block("ui_action_surface_mismatch", `${label}:${surface}`);
    if (!screen) block("ui_action_missing_screen", label);
    if (!actionId && !capabilityId) block("ui_action_missing_action_or_capability", label);
    if (status !== "pass") block("ui_action_status_not_pass", `${label}:${status || "<missing>"}`);
    return {
      surface,
      screen,
      action_id: actionId,
      capability_id: capabilityId,
      status,
      evidence_ref: evidence,
      mission_id: missionId,
      work_item_id: workItemId,
      source: "ios_mobile_live_write_read_roundtrip_explicit_ui_actions",
      truth_label: "explicit_ui_action_runtime_evidence_not_endbar_not_adoption",
    };
  }).filter(Boolean);
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
if (truthLabel && truthLabel !== "ios_mobile_live_write_read_roundtrip_proof_not_ui_device_proof") {
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
if (surfaceKind && surfaceKind !== "mobile") block("surface_kind_not_mobile", surfaceKind);

const write = proof?.write ?? null;
const writeStatus = stringField(write, "status", "proof.write");
const writeBlockers = optionalArrayField(write, "blockers").filter((value) => typeof value === "string");
const duplicateWorkItemId = typeof write?.duplicate_work_item_id === "string" ? write.duplicate_work_item_id : "";
const acceptedExistingWorkItem = write?.accepted_existing_work_item === true;
const duplicateExisting = writeStatus === "blocked"
  && !write?.created_or_ready
  && acceptedExistingWorkItem
  && duplicateWorkItemId === workItemId
  && writeBlockers.includes("duplicate_active_work_item_before_dispatch");
if (writeStatus && writeStatus !== "ready" && !duplicateExisting) block("write_status_not_ready", writeStatus);
if (!booleanField(write, "created_or_ready", "proof.write") && !duplicateExisting) {
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
  ? eventNames.map((event) => event === "mission_intake_ready" && duplicateExisting
    ? "duplicate_preflight_visible"
    : event).map((event) => ({
    surface: "mobile",
    event,
    mission_id: missionId,
    evidence_ref: evidenceRef,
    work_item_id: workItemId,
    source: "ios_mobile_live_write_read_roundtrip_artifact",
    truth_label: "mobile_same_run_event_from_live_write_read_artifact_not_ui_device_proof",
  }))
  : [];
const actionRows = blockers.length === 0 ? explicitActionRows(proof) : [];

if (outPath && blockers.length === 0) {
  const out = abs(outPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}
if (actionRuntimeOutPath && blockers.length === 0) {
  const out = abs(actionRuntimeOutPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({
    truth: "action_runtime_evidence_from_explicit_ios_ui_actions_not_endbar",
    status: actionRows.length > 0 ? "ready" : "no_explicit_ui_actions",
    missionId: missionId || null,
    actions: actionRows,
  }, null, 2)}\n`);
}

const output = {
  truth: "ios_mobile_live_write_read_events_driver_not_ui_device_proof",
  status: blockers.length === 0 ? "ready" : "blocked",
  missionId: missionId || null,
  workItemId: workItemId || null,
  evidenceRef: evidenceRef || null,
  out: outPath ? abs(outPath) : null,
  eventCount: events.length,
  actionRuntimeEvidence: {
    out: actionRuntimeOutPath ? abs(actionRuntimeOutPath) : null,
    count: actionRows.length,
    status: actionRows.length > 0 ? "ready" : "no_explicit_ui_actions",
  },
  blockers,
  caveat: "Mobile same-run events only; combine with real desktop/channel/timeline evidence before strict UI/device proof.",
};

console.log(JSON.stringify(output, null, 2));
if (!outPath && blockers.length === 0) {
  process.stdout.write(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}
process.exit(blockers.length === 0 || !requireReady ? 0 : 2);
