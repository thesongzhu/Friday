#!/usr/bin/env node

import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
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
    [--manifest=/abs/observations-manifest.json] \\
    [--backend-live-proof=/abs/backend-proof.json] \\
    [--channel-live-proof=/abs/channel-proof.json] [--defer-channel-proof] \\
    [--objective-coverage=/abs/objective-coverage.json] \\
    [--out=/abs/gap-report.json] [--require-complete]

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
const deferChannelProof = args.includes("--defer-channel-proof")
  || process.env.FRIDAY_UI_DEVICE_DEFER_CHANNEL_PROOF === "1";
const missionId = arg("mission-id");
const eventsPath = arg("events");
const manifestPath = arg("manifest");
const outPath = arg("out");
const supportingProofArgs = {
  backendLiveProof: arg("backend-live-proof"),
  channelLiveProof: arg("channel-live-proof"),
  objectiveCoverage: arg("objective-coverage"),
};
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

function parseManifest(path) {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(abs(path), "utf8"));
  } catch {
    block("manifest_unreadable_or_invalid_json", abs(path));
    return null;
  }
}

function parseOptionalJson(label, path) {
  if (!path) return null;
  const resolved = requireFile(label, path);
  if (!resolved) return null;
  try {
    return { path: resolved, value: JSON.parse(readFileSync(resolved, "utf8")) };
  } catch {
    block("supporting_proof_unreadable_or_invalid_json", `${label}:${resolved}`);
    return { path: resolved, value: null };
  }
}

function supportingProof(label, path, validate) {
  const parsed = parseOptionalJson(label, path);
  if (!parsed) return null;
  const failures = parsed.value ? validate(parsed.value) : ["invalid_json"];
  return {
    role: label,
    path: parsed.path,
    status: failures.length === 0 ? "usable_precondition_not_ui_device_evidence" : "invalid_or_incomplete",
    countsTowardUiDeviceProof: false,
    remainingRequirement: parsed.value?.remaining_requirement || "real UI/device observations must still pass the UI/device proof gate",
    failures,
  };
}

function supportingProofs() {
  return [
    supportingProof("backendLiveProof", supportingProofArgs.backendLiveProof, (value) => {
      const failures = [];
      if (value.proof !== "mission_spine_backend_api_live_pressure") failures.push("proof_mismatch");
      if (value.status !== "passed") failures.push("status_not_passed");
      if (!String(value.remaining_requirement || "").includes("UI/device consumption")) failures.push("remaining_requirement_missing");
      return failures;
    }),
    supportingProof("channelLiveProof", supportingProofArgs.channelLiveProof, (value) => {
      const failures = [];
      if (value.proof !== "mission_spine_channel_live_proof") failures.push("proof_mismatch");
      if (value.status !== "passed") failures.push("status_not_passed");
      if (!String(value.remaining_requirement || "").includes("UI/device consumption")) failures.push("remaining_requirement_missing");
      return failures;
    }),
    supportingProof("objectiveCoverage", supportingProofArgs.objectiveCoverage, (value) => {
      const failures = [];
      if (!String(value.remaining_requirement || "").includes("UI or device consumption")) failures.push("remaining_requirement_missing");
      if (Array.isArray(value.requirements)) {
        const uiRequirement = value.requirements.find((requirement) => requirement?.required_gate === "scripts/mission-spine-ui-device-proof-gate.sh");
        if (!uiRequirement) failures.push("ui_device_required_gate_missing");
      }
      return failures;
    }),
  ].filter(Boolean);
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
  if (!knownEvidenceRefs.has(evidenceKey(evidenceRef))) block("event_evidence_ref_unknown", `${label}:${evidenceRef}`);
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

function isChannelObservationRequirement([surface, event]) {
  return surface === "channel" || event.includes("channel");
}

function isChannelOrderEvent(event) {
  return event.includes("channel");
}

function isChannelCheck(check) {
  return check.includes("channel");
}

if (!missionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(missionId) || !missionId.toLowerCase().includes("mission")) {
  block("mission_id_unexpected_shape", missionId || "<missing>");
}

const evidence = Object.fromEntries(
  Object.entries(evidenceArgs).map(([role, path]) => [role, requireFile(role, path)]),
);
const knownEvidenceRefs = new Set(Object.values(evidence).filter(Boolean).map(evidenceKey));
const eventFile = requireFile("events", eventsPath);
const observations = parseJsonl(eventFile).map((raw, index) => normalizeEvent(raw, index, knownEvidenceRefs));
const manifest = parseManifest(manifestPath);
const supportingProofRows = supportingProofs();

const activeRequiredObservations = deferChannelProof
  ? requiredObservations.filter((requirement) => !isChannelObservationRequirement(requirement))
  : requiredObservations;
const deferredObservationRequirements = deferChannelProof
  ? requiredObservations.filter(isChannelObservationRequirement)
  : [];

const missingObservations = activeRequiredObservations
  .filter(([surface, event]) => !hasObservation(observations, surface, event))
  .map(([surface, event]) => ({
    surface,
    event,
    preferredCapture: preferredSurface(surface, event),
  }));
const deferredObservations = deferredObservationRequirements
  .filter(([surface, event]) => !hasObservation(observations, surface, event))
  .map(([surface, event]) => ({
    surface,
    event,
    preferredCapture: preferredSurface(surface, event),
    deferred: true,
  }));

const observedEvents = new Set(observations.map((observation) => observation.event));
const activeRequiredOrder = deferChannelProof
  ? requiredOrder.filter((event) => !isChannelOrderEvent(event))
  : requiredOrder;
const deferredOrderEvents = deferChannelProof
  ? requiredOrder.filter((event) => isChannelOrderEvent(event) && !orderEventObserved(observedEvents, event))
  : [];
const missingOrderEvents = activeRequiredOrder.filter((event) => !orderEventObserved(observedEvents, event));
const pressureAskCount = observations.filter((observation) => observation.event === "pressure_20_50_consecutive_asks_visible").length;
const duplicateSurfaceCount = observations.filter((observation) => observation.event === "duplicate_preflight_visible").length;
const timelinePageCount = observations.filter((observation) => observation.event.startsWith("bounded_page_")).length;

const activeRequiredChecks = deferChannelProof
  ? requiredChecks.filter((check) => !isChannelCheck(check))
  : requiredChecks;
const deferredChecks = deferChannelProof
  ? requiredChecks.filter((check) => {
      if (!isChannelCheck(check)) return false;
      return !(manifest?.checks && typeof manifest.checks === "object" && manifest.checks[check] === true);
    })
  : [];
const missingChecks = manifest?.checks && typeof manifest.checks === "object"
  ? activeRequiredChecks.filter((check) => manifest.checks[check] !== true)
  : activeRequiredChecks;

function capturePlan(missingObservationRows, stressState) {
  const bySurface = new Map();
  const ensure = (surface) => {
    if (!bySurface.has(surface)) {
      bySurface.set(surface, {
        surface,
        events: [],
        stress: [],
      });
    }
    return bySurface.get(surface);
  };

  for (const row of missingObservationRows) {
    ensure(row.preferredCapture).events.push(row.event);
  }

  if (!stressState.pressureAskCountOk) {
    ensure("desktop").stress.push("pressure_20_50_consecutive_asks_visible");
  }
  if (!stressState.duplicateSurfaceCountOk) {
    ensure("desktop").stress.push("duplicate_preflight_visible_on_at_least_two_surfaces");
  }
  if (!stressState.timelinePageCountOk) {
    ensure("timeline").stress.push("bounded_page_1_visible_and_bounded_page_2_visible");
  }

  return [...bySurface.values()]
    .map((entry) => ({
      surface: entry.surface,
      missingEvents: [...new Set(entry.events)].sort(),
      stressRequirements: [...new Set(entry.stress)].sort(),
      evidenceRole: entry.surface,
      deferred: entry.surface === "channel" && deferChannelProof,
      truth: "capture_real_same_run_events_only_no_synthetic_rows",
    }))
    .sort((a, b) => a.surface.localeCompare(b.surface));
}

const stressGaps = {
  pressureAskCountOk: pressureAskCount >= 20 && pressureAskCount <= 50,
  duplicateSurfaceCountOk: duplicateSurfaceCount >= 2,
  timelinePageCountOk: timelinePageCount >= 2,
};

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
    deferredObservations,
    missingOrderEvents,
    deferredOrderEvents,
    missingChecks,
    deferredChecks,
    stress: stressGaps,
  },
  capturePlan: capturePlan(missingObservations, stressGaps),
  supportingProofs: supportingProofRows,
  deferredInputs: deferChannelProof ? [{
    role: "channel",
    status: "deferred_by_operator",
    countsTowardUiDeviceProof: false,
    caveat: "Channel live proof is deferred for this report-only run. This does not satisfy channel observations or END-BAR UI/device proof.",
    missingObservations: deferredObservations,
    missingOrderEvents: deferredOrderEvents,
    missingChecks: deferredChecks,
  }] : [],
  blockers,
  caveat: "Gap report only. Capture missing observations from a real same-run mobile/desktop/channel/timeline run before assembling proof. Deferred inputs are never counted as proof.",
};

if (outPath) {
  const out = abs(outPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(gapReport, null, 2)}\n`);
}

console.log(JSON.stringify(gapReport, null, 2));
const complete = gapReport.status === "complete_inputs_observed";
process.exit((complete || !requireComplete) && blockers.length === 0 ? 0 : 2);
