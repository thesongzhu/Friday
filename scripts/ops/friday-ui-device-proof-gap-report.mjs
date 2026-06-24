#!/usr/bin/env node

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { mkdirSync } from "node:fs";

const args = process.argv.slice(2);

const requiredObservations = [
  ["mobile", "mission_intake_submitted"],
  ["mobile", "mission_intake_ready"],
  ["*", "mission_resolve_or_create_visible"],
  ["*", "duplicate_preflight_visible"],
  ["mobile", "mission_bound_provider_action_visible"],
  ["*", "real_provider_execution_visible"],
  ["mobile", "proof_receipt_visible_before_done"],
  ["desktop", "same_mission_projection_visible"],
  ["desktop", "mission_workbench_visible"],
  ["desktop", "transcript_browser_visible"],
  ["desktop", "duplicate_blocked_opens_existing"],
  ["channel", "same_mission_projection_visible"],
  ["*", "same_mission_mobile_desktop_channel_visible"],
  ["timeline", "bounded_page_1_visible"],
  ["timeline", "bounded_page_2_visible"],
  ["timeline", "memory_candidate_review_only"],
  ["*", "provider_ack_not_done_visible"],
  ["*", "pressure_20_50_consecutive_asks_visible"],
  ["*", "invalid_key_error_visible"],
  ["*", "quota_error_visible"],
  ["*", "network_error_visible"],
  ["*", "channel_replay_blocked_visible"],
  ["*", "reconnect_stale_verified"],
  ["*", "real_provider_execution_receipt_visible"],
  ["*", "stale_label_visible"],
  ["*", "offline_label_visible"],
  ["*", "error_label_visible"],
  ["*", "no_hidden_fallback_verified"],
];

const requiredOrder = [
  "mission_intake_submitted",
  "mission_resolve_or_create",
  "duplicate_preflight",
  "mission_bound_provider_action",
  "real_provider_execution",
  "proof_receipt",
  "timeline_page_1",
  "timeline_page_2",
  "same_mission_mobile_desktop_channel",
  "memory_candidate_review_only",
  "stale_offline_error_labels_verified",
];

const requiredChecks = [
  "same_mission_id_mobile_desktop",
  "same_mission_id_channel",
  "duplicate_blocked_opens_existing",
  "mission_bound_provider_action_visible",
  "proof_receipt_visible_before_done",
  "provider_ack_not_done",
  "pressure_20_50_consecutive_asks",
  "invalid_key_error_visible",
  "quota_error_visible",
  "network_error_visible",
  "channel_replay_blocked",
  "reconnect_stale_verified",
  "memory_candidate_not_confirmed",
  "no_secret_leak",
  "no_hidden_fallback",
];

function usage() {
  console.error(`usage:
  node scripts/ops/friday-ui-device-proof-gap-report.mjs \\
    --mission-id=mission_... \\
    --events=/abs/same-run-events.jsonl \\
    --mobile=/abs/mobile-evidence \\
    --desktop=/abs/desktop-evidence \\
    --channel=/abs/channel-evidence \\
    --timeline=/abs/timeline-evidence \\
    [--manifest=/abs/observations-manifest.json] [--out=/abs/gap-report.json] [--require-complete]

Truth: reports missing real same-run UI/device observations. It does not derive
or write proof, does not synthesize observations, and does not mark END-BAR.`);
}

function arg(name) {
  const prefix = `--${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length) || "";
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const requireComplete = args.includes("--require-complete");
const missionId = arg("mission-id");
const eventsPath = arg("events");
const manifestPath = arg("manifest");
const outPath = arg("out");
const evidenceArgs = {
  mobile: arg("mobile"),
  desktop: arg("desktop"),
  channel: arg("channel"),
  timeline: arg("timeline"),
};
const blockers = [];

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

function parseJsonl(path) {
  if (!path) return [];
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch {
          block("invalid_jsonl", `line_${index + 1}`);
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    block("events_unreadable", path);
    return [];
  }
}

function parseManifest(path) {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(abs(path), "utf8"));
  } catch {
    block("manifest_unreadable_or_invalid_json", abs(path));
    return null;
  }
}

function normalizeEvent(raw, index, knownEvidenceRefs) {
  const label = `event_${index + 1}`;
  const surface = typeof raw.surface === "string" ? raw.surface.trim() : "";
  const event = typeof raw.event === "string" ? raw.event.trim() : "";
  const eventMissionId = typeof raw.mission_id === "string" ? raw.mission_id.trim() : "";
  const evidenceRef = typeof raw.evidence_ref === "string" ? raw.evidence_ref.trim() : "";
  if (!surface) block("event_missing_surface", label);
  if (!event) block("event_missing_name", label);
  if (eventMissionId !== missionId) block("event_mission_mismatch", `${label}:${eventMissionId}`);
  if (!knownEvidenceRefs.has(evidenceRef)) block("event_evidence_ref_unknown", `${label}:${evidenceRef}`);
  return { surface, event, mission_id: eventMissionId, evidence_ref: evidenceRef };
}

function hasObservation(observations, surface, event) {
  return observations.some((observation) => {
    if (observation.event !== event) return false;
    return surface === "*" || observation.surface === surface;
  });
}

function orderEventObserved(observedEvents, event) {
  if (event === "stale_offline_error_labels_verified") {
    return ["stale_label_visible", "offline_label_visible", "error_label_visible"]
      .every((candidate) => observedEvents.has(candidate));
  }
  const aliases = {
    mission_resolve_or_create: ["mission_resolve_or_create_visible"],
    duplicate_preflight: ["duplicate_preflight_visible"],
    mission_bound_provider_action: ["mission_bound_provider_action_visible"],
    real_provider_execution: ["real_provider_execution_visible"],
    proof_receipt: ["proof_receipt_visible_before_done"],
    timeline_page_1: ["bounded_page_1_visible"],
    timeline_page_2: ["bounded_page_2_visible"],
    same_mission_mobile_desktop_channel: ["same_mission_mobile_desktop_channel_visible"],
    memory_candidate_review_only: ["memory_candidate_review_only"],
  };
  const candidates = [event, `${event}_visible`, ...(aliases[event] || [])];
  return candidates.some((candidate) => observedEvents.has(candidate));
}

function preferredSurface(surface, event) {
  if (surface !== "*") return surface;
  if (event.includes("channel")) return "channel";
  if (event.includes("timeline") || event.includes("memory_candidate") || event.includes("hidden_fallback")) return "timeline";
  if (event.includes("stale") || event.includes("offline") || event.includes("error") || event.includes("quota") || event.includes("network")) return "desktop";
  return "desktop";
}

if (!missionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(missionId) || !missionId.toLowerCase().includes("mission")) {
  block("mission_id_unexpected_shape", missionId || "<missing>");
}

const evidence = Object.fromEntries(
  Object.entries(evidenceArgs).map(([role, path]) => [role, requireFile(role, path)]),
);
const knownEvidenceRefs = new Set(Object.values(evidence).filter(Boolean));
const eventFile = requireFile("events", eventsPath);
const observations = parseJsonl(eventFile).map((raw, index) => normalizeEvent(raw, index, knownEvidenceRefs));
const manifest = parseManifest(manifestPath);

const missingObservations = requiredObservations
  .filter(([surface, event]) => !hasObservation(observations, surface, event))
  .map(([surface, event]) => ({
    surface,
    event,
    preferredCapture: preferredSurface(surface, event),
  }));

const observedEvents = new Set(observations.map((observation) => observation.event));
const missingOrderEvents = requiredOrder.filter((event) => !orderEventObserved(observedEvents, event));
const pressureAskCount = observations.filter((observation) => observation.event === "pressure_20_50_consecutive_asks_visible").length;
const duplicateSurfaceCount = observations.filter((observation) => observation.event === "duplicate_preflight_visible").length;
const timelinePageCount = observations.filter((observation) => observation.event.startsWith("bounded_page_")).length;

const missingChecks = manifest?.checks && typeof manifest.checks === "object"
  ? requiredChecks.filter((check) => manifest.checks[check] !== true)
  : requiredChecks;

const gapReport = {
  truth: "ui_device_proof_gap_report_not_proof",
  status: blockers.length === 0 && missingObservations.length === 0 && missingOrderEvents.length === 0 && missingChecks.length === 0
    && pressureAskCount >= 20 && pressureAskCount <= 50 && duplicateSurfaceCount >= 2 && timelinePageCount >= 2
    ? "complete_inputs_observed"
    : "gaps_present",
  missionId: missionId || null,
  inputs: {
    events: eventFile || null,
    manifest: manifestPath ? abs(manifestPath) : null,
    evidence,
  },
  observed: {
    eventRows: observations.length,
    surfaces: [...new Set(observations.map((observation) => observation.surface).filter(Boolean))].sort(),
    pressureAskCount,
    duplicateSurfaceCount,
    timelinePageCount,
  },
  gaps: {
    missingObservations,
    missingOrderEvents,
    missingChecks,
    stress: {
      pressureAskCountOk: pressureAskCount >= 20 && pressureAskCount <= 50,
      duplicateSurfaceCountOk: duplicateSurfaceCount >= 2,
      timelinePageCountOk: timelinePageCount >= 2,
    },
  },
  blockers,
  caveat: "Gap report only. Capture missing observations from a real same-run mobile/desktop/channel/timeline run before assembling proof.",
};

if (outPath) {
  const out = abs(outPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(gapReport, null, 2)}\n`);
}

console.log(JSON.stringify(gapReport, null, 2));
const complete = gapReport.status === "complete_inputs_observed";
process.exit((complete || !requireComplete) && blockers.length === 0 ? 0 : 2);
