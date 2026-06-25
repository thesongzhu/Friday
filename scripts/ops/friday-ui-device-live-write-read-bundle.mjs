#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/friday-ui-device-live-write-read-bundle.mjs \\
    --out-dir=/abs/bundle-dir \\
    --mobile-capture-dir=/abs/ios-live-write-read-capture \\
    --desktop-capture-dir=/abs/macos-live-write-read-capture \\
    [--mission-id=mission_...] [--require-ready]

Truth: this indexes existing iOS/macOS live write-read capture artifacts into a
single partial bundle. It does not create channel/timeline/stress observations,
does not derive a strict observations manifest, and never claims END-BAR,
GO-LIVE, adoption, or operator signature completion.`);
}

function arg(name) {
  const prefix = `--${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length) || "";
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const requireReady = args.includes("--require-ready");
const outDirArg = arg("out-dir");
const rawExpectedMissionId = arg("mission-id");
const captureDirs = {
  mobile: arg("mobile-capture-dir"),
  desktop: arg("desktop-capture-dir"),
};
const blockers = [];

function block(code, detail) {
  blockers.push({ code, detail });
}

function abs(path) {
  return isAbsolute(path) ? path : resolve(path);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function canonicalMissionId(value) {
  if (!value) return "";
  return value.startsWith("mission_") ? value : `mission_${value}`;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    block("json_unreadable_or_invalid", `${label}:${path}`);
    return null;
  }
}

function requireFile(path, label) {
  if (!path) {
    block("missing_file", label);
    return "";
  }
  const resolved = abs(path);
  try {
    const stats = statSync(resolved);
    if (!stats.isFile()) block("not_file", `${label}:${resolved}`);
    if (stats.size <= 0) block("empty_file", `${label}:${resolved}`);
  } catch {
    block("unreadable_file", `${label}:${resolved}`);
  }
  return resolved;
}

function optionalFile(path, label) {
  return path ? requireFile(path, label) : "";
}

function requireDir(path, label) {
  if (!path) {
    block("missing_arg", label);
    return "";
  }
  const resolved = abs(path);
  try {
    const stats = statSync(resolved);
    if (!stats.isDirectory()) block("not_directory", `${label}:${resolved}`);
  } catch {
    block("unreadable_directory", `${label}:${resolved}`);
  }
  return resolved;
}

function readEvents(path, surface, missionId) {
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        const event = JSON.parse(line);
        const label = `${surface}_event_${index + 1}`;
        if (event.surface !== surface) block("event_surface_mismatch", `${label}:${String(event.surface ?? "")}`);
        if (event.mission_id !== missionId) block("event_mission_mismatch", `${label}:${String(event.mission_id ?? "")}`);
        if (typeof event.event !== "string" || !event.event.trim()) block("event_missing_name", label);
        return event;
      });
  } catch {
    block("events_unreadable_or_invalid_jsonl", `${surface}:${path}`);
    return [];
  }
}

function readActionEvidence(path, surface, missionId) {
  if (!path) return [];
  const value = readJson(path, `${surface}.action-runtime-evidence`);
  const actions = Array.isArray(value?.actions) ? value.actions : [];
  return actions.map((action, index) => {
    const label = `${surface}_action_${index + 1}`;
    if (action.surface !== surface) block("action_surface_mismatch", `${label}:${String(action.surface ?? "")}`);
    if (action.mission_id !== missionId) block("action_mission_mismatch", `${label}:${String(action.mission_id ?? "")}`);
    if (action.status !== "pass") block("action_status_not_pass", `${label}:${String(action.status ?? "")}`);
    if (typeof action.screen !== "string" || !action.screen.trim()) block("action_missing_screen", label);
    if (!String(action.action_id || "").trim() && !String(action.capability_id || "").trim()) {
      block("action_missing_action_or_capability", label);
    }
    return action;
  });
}

function capturePaths(index, role, dir) {
  const roleIndex = index?.[role] ?? null;
  const proof = requireFile(roleIndex?.proof || "", `${role}.proof`);
  const events = requireFile(roleIndex?.events || "", `${role}.events`);
  const actionRuntimeEvidence = optionalFile(roleIndex?.action_runtime_evidence || "", `${role}.action_runtime_evidence`);
  if (proof && dirname(proof) !== dir) block("capture_file_outside_dir", `${role}.proof:${proof}`);
  if (events && dirname(events) !== dir) block("capture_file_outside_dir", `${role}.events:${events}`);
  if (actionRuntimeEvidence && dirname(actionRuntimeEvidence) !== dir) {
    block("capture_file_outside_dir", `${role}.action_runtime_evidence:${actionRuntimeEvidence}`);
  }
  const eventCount = Number(roleIndex?.event_count ?? 0);
  if (!Number.isInteger(eventCount) || eventCount <= 0) block("event_count_invalid", `${role}:${String(roleIndex?.event_count ?? "")}`);
  return { proof, events, actionRuntimeEvidence, eventCount };
}

if (!outDirArg) block("missing_arg", "out-dir");
if (outDirArg && !isAbsolute(outDirArg)) block("out_dir_not_absolute", outDirArg);
if (rawExpectedMissionId && !rawExpectedMissionId.toLowerCase().includes("mission")) {
  block("mission_id_unexpected_shape", rawExpectedMissionId);
}
const expectedMissionId = canonicalMissionId(rawExpectedMissionId);

const outDir = outDirArg ? abs(outDirArg) : "";
const dirs = Object.fromEntries(Object.entries(captureDirs).map(([role, value]) => [role, requireDir(value, `${role}-capture-dir`)]));
const captures = {};

for (const role of ["mobile", "desktop"]) {
  if (!dirs[role]) continue;
  const indexPath = requireFile(join(dirs[role], "capture-index.json"), `${role}.capture-index`);
  const index = indexPath ? readJson(indexPath, `${role}.capture-index`) : null;
  if (index?.status !== "ready") block("capture_index_not_ready", `${role}:${String(index?.status ?? "")}`);
  const missionId = typeof index?.mission_id === "string" ? index.mission_id : "";
  if (!missionId) block("capture_index_missing_mission_id", role);
  captures[role] = {
    role,
    dir: dirs[role],
    indexPath,
    index,
    missionId,
    workItemId: typeof index?.work_item_id === "string" ? index.work_item_id : "",
    ...capturePaths(index, role, dirs[role]),
  };
}

const missionIds = [...new Set(Object.values(captures).map((capture) => capture.missionId).filter(Boolean))];
const missionId = expectedMissionId || (missionIds.length === 1 ? missionIds[0] : "");
if (missionIds.length > 1) block("mobile_desktop_mission_mismatch", missionIds.join(","));
if (expectedMissionId && missionIds.some((value) => value !== expectedMissionId)) {
  block("expected_mission_mismatch", `${expectedMissionId}:${missionIds.join(",")}`);
}

const eventsByRole = {};
const actionsByRole = {};
for (const [role, capture] of Object.entries(captures)) {
  if (capture.events && capture.missionId) {
    eventsByRole[role] = readEvents(capture.events, role, capture.missionId);
  }
  if (capture.actionRuntimeEvidence && capture.missionId) {
    actionsByRole[role] = readActionEvidence(capture.actionRuntimeEvidence, role, capture.missionId);
  }
}

let written = {};
let combinedEventsPath = null;
let combinedActionEvidencePath = null;
let indexPath = null;
if (outDir && blockers.filter((entry) => entry.code === "missing_arg" || entry.code === "out_dir_not_absolute").length === 0) {
  mkdirSync(outDir, { recursive: true });
  for (const [role, capture] of Object.entries(captures)) {
    const roleDir = join(outDir, role);
    mkdirSync(roleDir, { recursive: true });
    const proofTarget = join(roleDir, basename(capture.proof));
    const eventsTarget = join(roleDir, basename(capture.events));
    copyFileSync(capture.proof, proofTarget);
    copyFileSync(capture.events, eventsTarget);
    let actionRuntimeEvidenceTarget = null;
    if (capture.actionRuntimeEvidence) {
      actionRuntimeEvidenceTarget = join(roleDir, basename(capture.actionRuntimeEvidence));
      copyFileSync(capture.actionRuntimeEvidence, actionRuntimeEvidenceTarget);
    }
    written[role] = {
      proof: proofTarget,
      proof_sha256: sha256(proofTarget),
      events: eventsTarget,
      events_sha256: sha256(eventsTarget),
      action_runtime_evidence: actionRuntimeEvidenceTarget,
      action_runtime_evidence_sha256: actionRuntimeEvidenceTarget ? sha256(actionRuntimeEvidenceTarget) : null,
      event_count: eventsByRole[role]?.length ?? 0,
      action_count: actionsByRole[role]?.length ?? 0,
      mission_id: capture.missionId,
      work_item_id: capture.workItemId,
    };
  }

  if (missionId) {
    combinedEventsPath = join(outDir, "mobile-desktop-live-write-read-events.jsonl");
    const combined = ["mobile", "desktop"]
      .flatMap((role) => (eventsByRole[role] ?? []).map((event) => {
        const copiedProof = written[role]?.proof;
        if (copiedProof && event?.evidence_ref === captures[role]?.proof) {
          return { ...event, evidence_ref: copiedProof };
        }
        return event;
      }))
      .map((event) => JSON.stringify(event));
    writeFileSync(combinedEventsPath, combined.length ? `${combined.join("\n")}\n` : "");

    const combinedActions = ["mobile", "desktop"].flatMap((role) => actionsByRole[role] ?? []);
    combinedActionEvidencePath = join(outDir, "action-runtime-evidence.json");
    writeFileSync(combinedActionEvidencePath, `${JSON.stringify({
      truth: "combined_mobile_desktop_action_runtime_evidence_not_endbar",
      status: combinedActions.length > 0 ? "ready" : "no_explicit_ui_actions",
      missionId,
      actions: combinedActions,
    }, null, 2)}\n`);
  }

  indexPath = join(outDir, "live-write-read-bundle-index.json");
}

const fullProofGaps = [
  "same_mission_mobile_desktop_channel_capture",
  "bounded_timeline_capture",
  "strict_observations_manifest_from_same_run_events",
  "pressure_20_50_consecutive_asks",
  "error_quota_network_replay_reconnect_observations",
  "secret_leak_and_hidden_fallback_negative_controls",
];

const output = {
  truth: "ui_device_live_write_read_bundle_not_full_proof",
  status: blockers.length === 0 ? "partial_bundle_ready" : "blocked",
  missionId: missionId || null,
  outDir: outDir || null,
  captures: written,
  combinedEvents: combinedEventsPath,
  actionRuntimeEvidence: combinedActionEvidencePath,
  actionRuntimeEvidenceCount: ["mobile", "desktop"].reduce((sum, role) => sum + (actionsByRole[role]?.length ?? 0), 0),
  blockers,
  fullProofGaps,
  next: blockers.length === 0
    ? "Use the bundle as partial input only; capture real channel/timeline/stress observations before strict UI/device proof readiness can pass."
    : "Fix blockers with real iOS/macOS same-mission captures; do not synthesize missing observations.",
};

if (indexPath) {
  writeFileSync(indexPath, `${JSON.stringify(output, null, 2)}\n`);
}

console.log(JSON.stringify(output, null, 2));
process.exit(blockers.length === 0 || !requireReady ? 0 : 2);
