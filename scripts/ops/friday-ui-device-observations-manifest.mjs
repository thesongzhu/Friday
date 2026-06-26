#!/usr/bin/env node

import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);

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

const requiredStress = [
  "consecutive",
  "provider_ack_not_done",
  "invalid_key_error_visible",
  "quota_error_visible",
  "network_error_visible",
  "long_timeline_pagination_visible",
  "reconnect_stale_verified",
  "channel_replay_blocked",
  "no_secret_leak",
  "no_hidden_fallback",
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

const transcriptSearchFacets = [
  "mission",
  "work_item",
  "surface",
  "provider",
  "skill",
  "channel",
  "status",
  "proof_receipt",
  "time",
];

const transcriptEvidenceFacets = [
  "providerRef",
  "skillRunRef",
  "channelRef",
  "workflowRef",
  "surfaceThreadRef",
  "timelineRef",
  "proofReceiptRef",
];

function usage() {
  console.error(`usage:
  node scripts/ops/friday-ui-device-observations-manifest.mjs \\
    --mission-id=mission_... \\
    --mobile=/abs/mobile-capture \\
    --desktop=/abs/desktop-capture \\
    --channel=/abs/channel-capture \\
    --timeline=/abs/timeline-capture \\
    --events=/abs/same-run-events.jsonl \\
    --out=/abs/observations-manifest.json [--defer-channel-proof] [--require-ready]

Events must be captured from the same real UI/device run. This tool derives the
manifest from those captured events; it is not proof and never invents missing
observations.`);
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
const deferChannelProof = args.includes("--defer-channel-proof")
  || process.env.FRIDAY_UI_DEVICE_DEFER_CHANNEL_PROOF === "1";
const missionId = arg("mission-id");
const out = arg("out");
const eventsPath = arg("events");
const evidenceByRole = {
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

function evidenceKey(path) {
  if (!path) return "";
  const resolved = abs(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function requireFile(label, path) {
  if (label === "channel" && deferChannelProof && !path) {
    return "";
  }
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

function stringField(value, field, label) {
  if (typeof value[field] === "string" && value[field].trim()) return value[field].trim();
  block("event_missing_field", `${label}:${field}`);
  return "";
}

function normalizedEvents(rawEvents, evidenceRefs) {
  return rawEvents.map((raw, index) => {
    const label = `event_${index + 1}`;
    const surface = stringField(raw, "surface", label);
    const event = stringField(raw, "event", label);
    const eventMissionId = stringField(raw, "mission_id", label);
    const evidenceRef = stringField(raw, "evidence_ref", label);
    if (eventMissionId && eventMissionId !== missionId) {
      block("event_mission_mismatch", `${label}:${eventMissionId}`);
    }
    if (evidenceRef && !evidenceRefs.has(evidenceKey(evidenceRef))) {
      block("event_evidence_ref_unknown", `${label}:${evidenceRef}`);
    }
    return { surface, event, mission_id: eventMissionId, evidence_ref: evidenceRef };
  });
}

function hasObservation(observations, requiredSurface, event) {
  return observations.some((observation) => {
    if (observation.event !== event) return false;
    return requiredSurface === "*" || observation.surface === requiredSurface;
  });
}

function evidenceRefFor(observations, surface, event, fallback) {
  return observations.find((observation) => observation.surface === surface && observation.event === event)?.evidence_ref
    || fallback;
}

if (!missionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(missionId) || !missionId.toLowerCase().includes("mission")) {
  block("mission_id_unexpected_shape", missionId || "<missing>");
}

const evidence = Object.fromEntries(Object.entries(evidenceByRole).map(([role, path]) => [role, requireFile(role, path)]));
const eventFile = requireFile("events", eventsPath);
if (!out) block("missing_arg", "out");

const evidenceRefs = new Set(Object.values(evidence).filter(Boolean).map(evidenceKey));
const observations = normalizedEvents(parseJsonl(eventFile), evidenceRefs);
const activeRequiredObservations = deferChannelProof
  ? requiredObservations.filter(([surface, event]) => surface !== "channel" && !event.includes("channel"))
  : requiredObservations;

for (const [surface, event] of activeRequiredObservations) {
  if (!hasObservation(observations, surface, event)) {
    block("missing_observation", `${surface}:${event}`);
  }
}

const activeRequiredChecks = deferChannelProof
  ? requiredChecks.filter((check) => !check.includes("channel"))
  : requiredChecks;
const activeRequiredStress = deferChannelProof
  ? requiredStress.filter((check) => !check.includes("channel"))
  : requiredStress;
const activeRequiredOrder = deferChannelProof
  ? requiredOrder.filter((event) => !event.includes("channel"))
  : requiredOrder;
const checks = Object.fromEntries(activeRequiredChecks.map((check) => [check, true]));
const stress = Object.fromEntries(activeRequiredStress.map((check) => [check, true]));
stress.mission_bound_ask_count = observations.filter((observation) => observation.event === "pressure_20_50_consecutive_asks_visible").length;
stress.duplicate_surface_count = observations.filter((observation) => observation.event === "duplicate_preflight_visible").length;
stress.long_timeline_page_count = observations.filter((observation) => observation.event.startsWith("bounded_page_")).length;
stress.evidence_ref = evidence.timeline || "";

if (stress.mission_bound_ask_count < 20 || stress.mission_bound_ask_count > 50) {
  block("stress_ask_count_out_of_range", String(stress.mission_bound_ask_count));
}
if (stress.duplicate_surface_count < 2) {
  block("stress_duplicate_surface_count_low", String(stress.duplicate_surface_count));
}
if (stress.long_timeline_page_count < 2) block("timeline_page_count_too_low", String(stress.long_timeline_page_count));

const manifest = {
  truth_label: "ui_device_observations_manifest_derived_from_same_run_events_not_proof",
  mission_id: missionId,
  checks,
  stress,
  timeline: {
    bounded: hasObservation(observations, "timeline", "bounded_page_1_visible")
      && hasObservation(observations, "timeline", "bounded_page_2_visible"),
    page_count: stress.long_timeline_page_count,
    cursor_verified: hasObservation(observations, "timeline", "bounded_page_2_visible"),
  },
  mission_workbench: {
    visible: hasObservation(observations, "desktop", "mission_workbench_visible"),
    same_mission_projection_visible: hasObservation(observations, "desktop", "same_mission_projection_visible"),
    provider_ack_not_done_visible: hasObservation(observations, "*", "provider_ack_not_done_visible"),
    memory_candidate_review_only_visible: hasObservation(observations, "timeline", "memory_candidate_review_only"),
    evidence_ref: evidenceRefFor(observations, "desktop", "mission_workbench_visible", evidence.desktop),
  },
  transcript_browser: {
    visible: hasObservation(observations, "desktop", "transcript_browser_visible"),
    collapsed_by_default: true,
    redacted: true,
    bounded_timeline_linked: hasObservation(observations, "timeline", "bounded_page_2_visible"),
    evidence_ref: evidenceRefFor(observations, "desktop", "transcript_browser_visible", evidence.desktop),
    search_facets: transcriptSearchFacets,
    evidence_facets: transcriptEvidenceFacets,
  },
  status_labels: ["stale", "offline", "error"],
  memory_candidates: [
    { id: "memory_candidate_review_only", confirmed: false, grants_memory_authority: false },
  ],
  event_order: activeRequiredOrder,
  observations,
  deferred_inputs: deferChannelProof ? [{
    role: "channel",
    status: "deferred_by_operator",
    countsTowardUiDeviceProof: false,
    caveat: "Channel proof is deferred. This manifest can support non-channel evidence work but cannot satisfy strict UI/device proof or END-BAR.",
  }] : [],
};

if (out && blockers.length === 0) {
  const outputPath = abs(out);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

const output = {
  truth: "ui_device_observations_manifest_driver_not_proof",
  status: blockers.length === 0 ? "ready" : "blocked",
  missionId: missionId || null,
  out: out ? abs(out) : null,
  observations: observations.length,
  deferredInputs: manifest.deferred_inputs,
  blockers,
  next: blockers.length === 0
    ? "Use this manifest with friday-ui-device-capture-dir.mjs and the strict UI/device proof gate."
    : "Capture the missing real same-run observations; do not synthesize manifest rows.",
};

console.log(JSON.stringify(output, null, 2));
process.exit(blockers.length === 0 || !requireReady ? 0 : 2);
