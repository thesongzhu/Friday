#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);
const expectNotReady = args.includes("--expect-not-ready");
const helpRequested = args.includes("--help") || args.includes("-h");

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

const requiredStressTrueChecks = [
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

const requiredEventOrder = [
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
  "mobile:mission_intake_submitted",
  "mobile:mission_intake_ready",
  "*:mission_resolve_or_create_visible",
  "*:duplicate_preflight_visible",
  "mobile:mission_bound_provider_action_visible",
  "*:real_provider_execution_visible",
  "mobile:proof_receipt_visible_before_done",
  "desktop:same_mission_projection_visible",
  "desktop:mission_workbench_visible",
  "desktop:transcript_browser_visible",
  "desktop:duplicate_blocked_opens_existing",
  "channel:same_mission_projection_visible",
  "*:same_mission_mobile_desktop_channel_visible",
  "timeline:bounded_page_1_visible",
  "timeline:bounded_page_2_visible",
  "timeline:memory_candidate_review_only",
  "*:provider_ack_not_done_visible",
  "*:pressure_20_50_consecutive_asks_visible",
  "*:invalid_key_error_visible",
  "*:quota_error_visible",
  "*:network_error_visible",
  "*:channel_replay_blocked_visible",
  "*:reconnect_stale_verified",
  "*:real_provider_execution_receipt_visible",
  "*:stale_label_visible",
  "*:offline_label_visible",
  "*:error_label_visible",
  "*:no_hidden_fallback_verified",
];

const negativeControlObservationEvents = new Set([
  "provider_ack_not_done_visible",
  "pressure_20_50_consecutive_asks_visible",
  "invalid_key_error_visible",
  "quota_error_visible",
  "network_error_visible",
  "channel_replay_blocked_visible",
  "reconnect_stale_verified",
  "stale_label_visible",
  "offline_label_visible",
  "error_label_visible",
  "no_hidden_fallback_verified",
]);

const requiredTranscriptSearchFacets = [
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

const requiredTranscriptEvidenceFacets = [
  "providerRef",
  "skillRunRef",
  "channelRef",
  "workflowRef",
  "surfaceThreadRef",
  "timelineRef",
  "proofReceiptRef",
];

const forbiddenMarkers = [
  "sk-",
  "Authorization",
  "Bearer",
  "provider-token",
  "raw-chat",
  "raw transcript",
  "/Users/",
];

const placeholderMarkers = [
  "TODO_FILL_AFTER_REAL_CAPTURE",
  "REPLACE_WITH_REAL_CAPTURE",
  "__MISSION_ID__",
  "\"template\": true",
  "\"not_real_proof\": true",
  "pending-real-capture",
  "mission_pending_runtime_projection",
];

function usage() {
  console.error(`usage:
  node scripts/qa/check-mission-spine-ui-proof-inputs.mjs \\
    --mission-id=mission_... \\
    --mobile=/abs/mobile-evidence \\
    --desktop=/abs/desktop-evidence \\
    --channel=/abs/channel-evidence \\
    --timeline=/abs/timeline-evidence \\
    [--mobile-extra-evidence=/abs/file ...] [--desktop-extra-evidence=/abs/file ...] \\
    [--channel-extra-evidence=/abs/file ...] [--timeline-extra-evidence=/abs/file ...] \\
    [--shared-extra-evidence=/abs/file ...] \\
    [--negative-control-evidence=/abs/file ...] \\
    --manifest=/abs/observations-manifest.json

This is a pre-assemble readiness check only. It does not write a
MISSION_SPINE_UI_DEVICE_PROOF artifact, does not set env, and does not run the
final UI/device proof gate.`);
}

function argValue(name, envName) {
  const prefix = `--${name}=`;
  const arg = args.find((value) => value.startsWith(prefix));
  if (arg) return arg.slice(prefix.length);
  return process.env[envName] || "";
}

function argValues(name, envName) {
  const prefix = `--${name}=`;
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith(prefix)) {
      values.push(value.slice(prefix.length));
    } else if (value === `--${name}` && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  const envValue = process.env[envName] || "";
  if (envValue) values.push(...envValue.split(":").map((value) => value.trim()).filter(Boolean));
  return values;
}

function sha256(textOrBuffer) {
  return createHash("sha256").update(textOrBuffer).digest("hex");
}

function collectForbiddenSecretValues() {
  return [
    process.env.FRIDAY_DEEPSEEK_API_KEY,
    process.env.FRIDAY_TELEGRAM_BOT_TOKEN,
    process.env.FRIDAY_TELEGRAM_ALLOWED_USER_ID,
  ].filter((value) => typeof value === "string" && value.length >= 8);
}

function pathFor(name, envName) {
  const value = argValue(name, envName);
  if (!value) return "";
  return isAbsolute(value) ? value : resolve(value);
}

function pathsFor(name, envName) {
  return argValues(name, envName).map((value) => (isAbsolute(value) ? value : resolve(value)));
}

function evidenceKey(path) {
  if (!path) return "";
  const resolved = isAbsolute(path) ? path : resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function recordFailure(failures, code, detail) {
  failures.push({ code, detail });
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function readTextFile(path, failures, label) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    recordFailure(failures, "file_unreadable", `${label}: ${path}`);
    return "";
  }
}

function validateNoForbiddenText(text, failures, label) {
  for (const marker of placeholderMarkers) {
    if (text.includes(marker)) {
      recordFailure(failures, "placeholder_marker_present", `${label}: ${marker}`);
    }
  }

  for (const marker of forbiddenMarkers) {
    if (text.includes(marker)) {
      recordFailure(failures, "forbidden_marker_present", `${label}: ${marker}`);
    }
  }

  for (const secretValue of collectForbiddenSecretValues()) {
    if (text.includes(secretValue)) {
      recordFailure(failures, "live_secret_value_present", label);
    }
  }
}

function validateEvidence(role, path, failures) {
  if (!path) {
    recordFailure(failures, "missing_evidence_arg", role);
    return null;
  }
  if (!isAbsolute(path)) {
    recordFailure(failures, "evidence_path_not_absolute", `${role}: ${path}`);
  }

  let stats = null;
  try {
    stats = statSync(path);
  } catch {
    recordFailure(failures, "evidence_missing", `${role}: ${path}`);
    return null;
  }

  if (!stats.isFile()) {
    recordFailure(failures, "evidence_not_file", `${role}: ${path}`);
    return null;
  }
  if (stats.size <= 0) {
    recordFailure(failures, "evidence_empty", `${role}: ${path}`);
  }

  const bytes = readFileSync(path);
  validateNoForbiddenText(bytes.toString("utf8"), failures, `${role} evidence`);

  return {
    role,
    path,
    bytes: stats.size,
    sha256: sha256(bytes),
  };
}

function observationExists(observations, requiredSurface, eventName, missionId, knownEvidenceRefs) {
  return observations.some((observation) => {
    if (observation.event !== eventName) return false;
    if (requiredSurface !== "*" && observation.surface !== requiredSurface) return false;
    return observation.mission_id === missionId && knownEvidenceRefs.has(evidenceKey(observation.evidence_ref));
  });
}

function validateNegativeControlSegments(manifest, missionId, knownEvidenceRefs, failures) {
  const segments = Array.isArray(manifest.negative_control_segments) ? manifest.negative_control_segments : [];
  for (const [index, segment] of segments.entries()) {
    const label = `negative_control_segments[${index}]`;
    const segmentId = typeof segment.segment_id === "string" ? segment.segment_id.trim() : "";
    const segmentMissionId = typeof segment.mission_id === "string" ? segment.mission_id.trim() : "";
    const truthLabel = typeof segment.truth_label === "string" ? segment.truth_label.trim() : "";
    const evidenceRefs = Array.isArray(segment.evidence_refs) ? segment.evidence_refs : [];
    const observations = Array.isArray(segment.observations) ? segment.observations : [];

    if (!segmentId) recordFailure(failures, "negative_segment_missing_id", label);
    if (!isMissionIdProofEligible(segmentMissionId)) recordFailure(failures, "negative_segment_mission_id_invalid", `${label}:${segmentMissionId}`);
    if (segmentMissionId === missionId) recordFailure(failures, "negative_segment_reuses_happy_path_mission", label);
    if (segment.happy_path !== false) recordFailure(failures, "negative_segment_happy_path_not_false", label);
    if (!/negative_control/i.test(truthLabel)) recordFailure(failures, "negative_segment_truth_label_not_negative_control", label);
    if (evidenceRefs.length < 1) recordFailure(failures, "negative_segment_missing_evidence_refs", label);
    for (const ref of evidenceRefs) {
      validateKnownEvidenceRef(
        ref,
        knownEvidenceRefs,
        failures,
        "negative_segment_evidence_ref_unknown",
        `${label}:${String(ref || "")}`,
      );
    }
    if (observations.length < 1) recordFailure(failures, "negative_segment_missing_observations", label);
    for (const observation of observations) {
      if (!negativeControlObservationEvents.has(String(observation.event || ""))) {
        recordFailure(failures, "negative_segment_event_not_allowed", `${label}:${String(observation.event || "")}`);
      }
      if (observation.mission_id !== segmentMissionId) {
        recordFailure(failures, "negative_segment_observation_mission_mismatch", `${label}:${String(observation.event || "")}`);
      }
      if (!evidenceRefs.map(evidenceKey).includes(evidenceKey(String(observation.evidence_ref || "")))) {
        recordFailure(failures, "negative_segment_observation_evidence_not_listed", `${label}:${String(observation.event || "")}`);
      }
      validateKnownEvidenceRef(
        observation.evidence_ref,
        knownEvidenceRefs,
        failures,
        "negative_segment_observation_evidence_ref_unknown",
        `${label}:${String(observation.event || "")}`,
      );
    }
  }
  return segments;
}

function negativeObservationExists(segments, requiredSurface, eventName) {
  if (!negativeControlObservationEvents.has(eventName)) return false;
  return segments.some((segment) => {
    const observations = Array.isArray(segment.observations) ? segment.observations : [];
    return observations.some((observation) => {
      if (observation.event !== eventName) return false;
      return requiredSurface === "*" || observation.surface === requiredSurface;
    });
  });
}

function isMissionIdProofEligible(value) {
  if (typeof value !== "string") return false;
  const missionId = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(missionId)
    && missionId.toLowerCase().includes("mission")
    && missionId !== "mission_pending_runtime_projection"
    && !missionId.includes("TODO");
}

function validateKnownEvidenceRef(value, knownEvidenceRefs, failures, code, detail) {
  if (!knownEvidenceRefs.has(evidenceKey(value))) {
    recordFailure(failures, code, detail);
  }
}

function evidenceRefsForRole(role, evidenceByRole, extraEvidenceByRole) {
  return [
    evidenceByRole[role]?.path,
    ...(extraEvidenceByRole.shared || []).map((entry) => entry.path),
    ...(extraEvidenceByRole[role] || []).map((entry) => entry.path),
  ].filter(Boolean);
}

function expectedEvidenceRefsForSurface(surface, evidenceByRole, extraEvidenceByRole) {
  if (surface === "mobile") return evidenceRefsForRole("mobile", evidenceByRole, extraEvidenceByRole);
  if (surface === "desktop") return evidenceRefsForRole("desktop", evidenceByRole, extraEvidenceByRole);
  if (surface === "channel") return evidenceRefsForRole("channel", evidenceByRole, extraEvidenceByRole);
  if (surface === "timeline") return evidenceRefsForRole("timeline", evidenceByRole, extraEvidenceByRole);
  return [];
}

const desktopEventsAllowedToUseTimelineEvidence = new Set([
  "duplicate_preflight_visible",
  "provider_ack_not_done_visible",
  "pressure_20_50_consecutive_asks_visible",
  "invalid_key_error_visible",
  "quota_error_visible",
  "network_error_visible",
  "reconnect_stale_verified",
]);

function expectedEvidenceRefsForObservation(observation, evidenceByRole, extraEvidenceByRole) {
  const expected = expectedEvidenceRefsForSurface(observation.surface, evidenceByRole, extraEvidenceByRole);
  if (
    observation.surface === "desktop"
    && desktopEventsAllowedToUseTimelineEvidence.has(String(observation.event || ""))
  ) {
    return [...expected, ...evidenceRefsForRole("timeline", evidenceByRole, extraEvidenceByRole)];
  }
  return expected;
}

function validateEvidenceRoleRef(value, expectedValue, failures, code, detail) {
  const expectedValues = Array.isArray(expectedValue) ? expectedValue : [expectedValue].filter(Boolean);
  if (expectedValues.length > 0 && !expectedValues.map(evidenceKey).includes(evidenceKey(value))) {
    recordFailure(failures, code, detail);
  }
}

function validateMissionWorkbenchManifest(manifest, evidenceByRole, extraEvidenceByRole, knownEvidenceRefs, failures) {
  const workbench = asObject(manifest.mission_workbench);
  if (!workbench) {
    recordFailure(failures, "manifest_missing_mission_workbench", "mission_workbench");
    return;
  }

  if (workbench.visible !== true) {
    recordFailure(failures, "mission_workbench_not_visible", "mission_workbench.visible");
  }
  if (workbench.same_mission_projection_visible !== true) {
    recordFailure(failures, "mission_workbench_same_mission_missing", "mission_workbench.same_mission_projection_visible");
  }
  if (workbench.memory_candidate_review_only_visible !== true) {
    recordFailure(failures, "mission_workbench_memory_candidate_missing", "mission_workbench.memory_candidate_review_only_visible");
  }
  validateKnownEvidenceRef(
    workbench.evidence_ref,
    knownEvidenceRefs,
    failures,
    "mission_workbench_evidence_ref_unknown",
    String(workbench.evidence_ref || ""),
  );
  validateEvidenceRoleRef(
    workbench.evidence_ref,
    evidenceRefsForRole("desktop", evidenceByRole, extraEvidenceByRole),
    failures,
    "mission_workbench_evidence_ref_not_desktop",
    String(workbench.evidence_ref || ""),
  );
}

function validateTranscriptBrowserManifest(manifest, evidenceByRole, extraEvidenceByRole, knownEvidenceRefs, failures) {
  const browser = asObject(manifest.transcript_browser);
  if (!browser) {
    recordFailure(failures, "manifest_missing_transcript_browser", "transcript_browser");
    return;
  }

  if (browser.visible !== true) {
    recordFailure(failures, "transcript_browser_not_visible", "transcript_browser.visible");
  }
  if (browser.collapsed_by_default !== true) {
    recordFailure(failures, "transcript_browser_not_collapsed_by_default", "transcript_browser.collapsed_by_default");
  }
  if (browser.redacted !== true) {
    recordFailure(failures, "transcript_browser_not_redacted", "transcript_browser.redacted");
  }
  if (browser.bounded_timeline_linked !== true) {
    recordFailure(failures, "transcript_browser_not_bounded", "transcript_browser.bounded_timeline_linked");
  }
  validateKnownEvidenceRef(
    browser.evidence_ref,
    knownEvidenceRefs,
    failures,
    "transcript_browser_evidence_ref_unknown",
    String(browser.evidence_ref || ""),
  );
  validateEvidenceRoleRef(
    browser.evidence_ref,
    evidenceRefsForRole("desktop", evidenceByRole, extraEvidenceByRole),
    failures,
    "transcript_browser_evidence_ref_not_desktop",
    String(browser.evidence_ref || ""),
  );

  const searchFacets = Array.isArray(browser.search_facets) ? browser.search_facets : [];
  for (const facet of requiredTranscriptSearchFacets) {
    if (!searchFacets.includes(facet)) {
      recordFailure(failures, "transcript_browser_search_facet_missing", facet);
    }
  }

  const evidenceFacets = Array.isArray(browser.evidence_facets) ? browser.evidence_facets : [];
  for (const facet of requiredTranscriptEvidenceFacets) {
    if (!evidenceFacets.includes(facet)) {
      recordFailure(failures, "transcript_browser_evidence_facet_missing", facet);
    }
  }
}

function validateManifest(manifestPath, missionId, evidenceByRole, extraEvidenceByRole, knownEvidenceRefs, failures) {
  if (!manifestPath) {
    recordFailure(failures, "missing_manifest_arg", "manifest");
    return null;
  }
  if (!isAbsolute(manifestPath)) {
    recordFailure(failures, "manifest_path_not_absolute", manifestPath);
  }

  const text = readTextFile(manifestPath, failures, "observations manifest");
  if (!text) return null;
  validateNoForbiddenText(text, failures, "observations manifest");

  let manifest = null;
  try {
    manifest = JSON.parse(text);
  } catch {
    recordFailure(failures, "manifest_invalid_json", manifestPath);
    return null;
  }

  if (manifest.template === true || manifest.not_real_proof === true) {
    recordFailure(failures, "manifest_marked_non_real", manifestPath);
  }

  validateMissionWorkbenchManifest(manifest, evidenceByRole, extraEvidenceByRole, knownEvidenceRefs, failures);
  validateTranscriptBrowserManifest(manifest, evidenceByRole, extraEvidenceByRole, knownEvidenceRefs, failures);
  const negativeControlSegments = validateNegativeControlSegments(manifest, missionId, knownEvidenceRefs, failures);

  if (!manifest.checks || typeof manifest.checks !== "object") {
    recordFailure(failures, "manifest_missing_checks", manifestPath);
  } else {
    for (const check of requiredChecks) {
      if (manifest.checks[check] !== true) {
        recordFailure(failures, "required_check_not_true", check);
      }
    }
  }

  if (!manifest.stress || typeof manifest.stress !== "object") {
    recordFailure(failures, "manifest_missing_stress", manifestPath);
  } else {
    const askCount = Number(manifest.stress.mission_bound_ask_count || 0);
    if (askCount < 20 || askCount > 50) {
      recordFailure(failures, "stress_ask_count_out_of_range", String(askCount));
    }
    const duplicateSurfaceCount = Number(manifest.stress.duplicate_surface_count || 0);
    if (duplicateSurfaceCount < 2) {
      recordFailure(failures, "stress_duplicate_surface_count_low", String(duplicateSurfaceCount));
    }
    const pageCount = Number(manifest.stress.long_timeline_page_count || 0);
    if (pageCount < 2) {
      recordFailure(failures, "stress_timeline_page_count_low", String(pageCount));
    }
    if (!knownEvidenceRefs.has(evidenceKey(manifest.stress.evidence_ref))) {
      recordFailure(failures, "stress_evidence_ref_unknown", String(manifest.stress.evidence_ref || ""));
    }
    const stressRefInNegativeSegment = negativeControlSegments.some((segment) => (
      Array.isArray(segment.evidence_refs) && segment.evidence_refs.map(evidenceKey).includes(evidenceKey(String(manifest.stress.evidence_ref || "")))
    ));
    if (!stressRefInNegativeSegment) {
      validateEvidenceRoleRef(
        manifest.stress.evidence_ref,
        evidenceRefsForRole("timeline", evidenceByRole, extraEvidenceByRole),
        failures,
        "stress_evidence_ref_not_timeline",
        String(manifest.stress.evidence_ref || ""),
      );
    }
    for (const check of requiredStressTrueChecks) {
      if (manifest.stress[check] !== true) {
        recordFailure(failures, "required_stress_check_not_true", check);
      }
    }
  }

  if (!manifest.timeline || typeof manifest.timeline !== "object") {
    recordFailure(failures, "manifest_missing_timeline", manifestPath);
  } else {
    if (manifest.timeline.bounded !== true) recordFailure(failures, "timeline_not_bounded", manifestPath);
    if (Number(manifest.timeline.page_count || 0) < 2) recordFailure(failures, "timeline_page_count_low", String(manifest.timeline.page_count || 0));
    if (manifest.timeline.cursor_verified !== true) recordFailure(failures, "timeline_cursor_not_verified", manifestPath);
  }

  const statusLabels = Array.isArray(manifest.status_labels) ? manifest.status_labels : [];
  for (const label of ["stale", "offline", "error"]) {
    if (!statusLabels.includes(label)) {
      recordFailure(failures, "status_label_missing", label);
    }
  }

  const memoryCandidates = Array.isArray(manifest.memory_candidates) ? manifest.memory_candidates : [];
  if (memoryCandidates.length < 1) {
    recordFailure(failures, "memory_candidate_missing", manifestPath);
  }
  for (const candidate of memoryCandidates) {
    if (candidate.confirmed !== false || candidate.grants_memory_authority !== false) {
      recordFailure(failures, "memory_candidate_not_review_only", String(candidate.id || "unknown"));
    }
  }

  const eventOrder = Array.isArray(manifest.event_order) ? manifest.event_order : [];
  let previousIndex = -1;
  for (const event of requiredEventOrder) {
    if (event === "stale_offline_error_labels_verified"
      && ["stale_label_visible", "offline_label_visible", "error_label_visible"].every((name) => negativeObservationExists(negativeControlSegments, "*", name))) {
      continue;
    }
    const index = eventOrder.indexOf(event);
    if (index === -1) {
      recordFailure(failures, "event_order_missing", event);
    } else if (index <= previousIndex) {
      recordFailure(failures, "event_order_not_monotonic", event);
    }
    previousIndex = index;
  }

  const observations = Array.isArray(manifest.observations) ? manifest.observations : [];
  if (observations.length < 18) {
    recordFailure(failures, "observations_too_few", String(observations.length));
  }
  for (const observation of observations) {
    if (observation.mission_id !== missionId) {
      recordFailure(failures, "observation_mission_mismatch", String(observation.event || "unknown"));
    }
    if (!knownEvidenceRefs.has(evidenceKey(observation.evidence_ref))) {
      recordFailure(failures, "observation_evidence_ref_unknown", String(observation.event || "unknown"));
    }
    const expectedEvidenceRefs = expectedEvidenceRefsForObservation(observation, evidenceByRole, extraEvidenceByRole);
    if (expectedEvidenceRefs.length > 0) {
      validateEvidenceRoleRef(
        observation.evidence_ref,
        expectedEvidenceRefs,
        failures,
        "observation_evidence_ref_role_mismatch",
        `${String(observation.event || "unknown")}:${String(observation.surface || "unknown")}`,
      );
    }
  }
  for (const requirement of requiredObservations) {
    const [surface, eventName] = requirement.split(":");
    if (!observationExists(observations, surface, eventName, missionId, knownEvidenceRefs)
      && !negativeObservationExists(negativeControlSegments, surface, eventName)) {
      recordFailure(failures, "required_observation_missing", requirement);
    }
  }

  return manifest;
}

if (helpRequested) {
  usage();
  process.exit(0);
}

const failures = [];
const missionId = argValue("mission-id", "MISSION_ID");
if (!missionId) recordFailure(failures, "missing_mission_id", "mission-id");
if (missionId && !isMissionIdProofEligible(missionId)) {
  recordFailure(failures, "mission_id_unexpected_shape", missionId);
}
if (missionId === "mission_pending_runtime_projection" || missionId.includes("TODO")) {
  recordFailure(failures, "mission_id_placeholder", missionId);
}

const evidenceArgs = {
  mobile: pathFor("mobile", "MOBILE_EVIDENCE"),
  desktop: pathFor("desktop", "DESKTOP_EVIDENCE"),
  channel: pathFor("channel", "CHANNEL_EVIDENCE"),
  timeline: pathFor("timeline", "TIMELINE_EVIDENCE"),
};
const extraEvidenceArgs = {
  mobile: pathsFor("mobile-extra-evidence", "MOBILE_EXTRA_EVIDENCE"),
  desktop: pathsFor("desktop-extra-evidence", "DESKTOP_EXTRA_EVIDENCE"),
  channel: pathsFor("channel-extra-evidence", "CHANNEL_EXTRA_EVIDENCE"),
  timeline: pathsFor("timeline-extra-evidence", "TIMELINE_EXTRA_EVIDENCE"),
  shared: pathsFor("shared-extra-evidence", "SHARED_EXTRA_EVIDENCE"),
};
const negativeControlEvidenceArgs = pathsFor("negative-control-evidence", "NEGATIVE_CONTROL_EVIDENCE_FILES");
const manifestPath = pathFor("manifest", "OBSERVATIONS_MANIFEST");

const evidence = Object.entries(evidenceArgs)
  .map(([role, path]) => validateEvidence(role, path, failures))
  .filter(Boolean);
const evidenceByRole = Object.fromEntries(evidence.map((entry) => [entry.role, entry]));
const extraEvidence = Object.entries(extraEvidenceArgs)
  .flatMap(([role, paths]) => paths.map((path, index) => validateEvidence(`${role}-extra-${index + 1}`, path, failures)))
  .filter(Boolean);
const extraEvidenceByRole = Object.fromEntries(Object.keys(extraEvidenceArgs).map((role) => [
  role,
  extraEvidence.filter((entry) => entry.role.startsWith(`${role}-extra-`) || entry.role.startsWith(`${role}-shared-extra-`)),
]));
const negativeControlEvidence = negativeControlEvidenceArgs
  .map((path, index) => validateEvidence(`negative-control-${index + 1}`, path, failures))
  .filter(Boolean);
const knownEvidenceRefs = new Set([...evidence, ...extraEvidence, ...negativeControlEvidence].map((entry) => evidenceKey(entry.path)));
validateManifest(manifestPath, missionId, evidenceByRole, extraEvidenceByRole, knownEvidenceRefs, failures);

const readyForAssemble = failures.length === 0;
const result = {
  proof: "mission_spine_ui_device_inputs_preflight",
  proof_source: "pre_assemble_readiness_only_not_ui_device_proof",
  readyForAssemble,
  missionId: missionId || null,
  evidence: [...evidence, ...extraEvidence, ...negativeControlEvidence],
  manifestPath: manifestPath || null,
  failures,
};

console.log(JSON.stringify(result, null, 2));

if (expectNotReady) {
  process.exit(readyForAssemble ? 1 : 0);
}

process.exit(readyForAssemble ? 0 : 1);
