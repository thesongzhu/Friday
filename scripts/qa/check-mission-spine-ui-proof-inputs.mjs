#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
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
  "/private/",
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
    return observation.mission_id === missionId && knownEvidenceRefs.has(observation.evidence_ref);
  });
}

function validateKnownEvidenceRef(value, knownEvidenceRefs, failures, code, detail) {
  if (!knownEvidenceRefs.has(value)) {
    recordFailure(failures, code, detail);
  }
}

function expectedEvidenceRefForSurface(surface, evidenceByRole) {
  if (surface === "mobile") return evidenceByRole.mobile?.path || "";
  if (surface === "desktop") return evidenceByRole.desktop?.path || "";
  if (surface === "channel") return evidenceByRole.channel?.path || "";
  if (surface === "timeline") return evidenceByRole.timeline?.path || "";
  return "";
}

function validateEvidenceRoleRef(value, expectedValue, failures, code, detail) {
  if (value !== expectedValue) {
    recordFailure(failures, code, detail);
  }
}

function validateMissionWorkbenchManifest(manifest, evidenceByRole, knownEvidenceRefs, failures) {
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
  if (workbench.provider_ack_not_done_visible !== true) {
    recordFailure(failures, "mission_workbench_provider_ack_not_done_missing", "mission_workbench.provider_ack_not_done_visible");
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
    evidenceByRole.desktop?.path,
    failures,
    "mission_workbench_evidence_ref_not_desktop",
    String(workbench.evidence_ref || ""),
  );
}

function validateTranscriptBrowserManifest(manifest, evidenceByRole, knownEvidenceRefs, failures) {
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
    evidenceByRole.desktop?.path,
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

function validateManifest(manifestPath, missionId, evidenceByRole, knownEvidenceRefs, failures) {
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

  validateMissionWorkbenchManifest(manifest, evidenceByRole, knownEvidenceRefs, failures);
  validateTranscriptBrowserManifest(manifest, evidenceByRole, knownEvidenceRefs, failures);

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
    if (!knownEvidenceRefs.has(manifest.stress.evidence_ref)) {
      recordFailure(failures, "stress_evidence_ref_unknown", String(manifest.stress.evidence_ref || ""));
    }
    validateEvidenceRoleRef(
      manifest.stress.evidence_ref,
      evidenceByRole.timeline?.path,
      failures,
      "stress_evidence_ref_not_timeline",
      String(manifest.stress.evidence_ref || ""),
    );
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
    if (!knownEvidenceRefs.has(observation.evidence_ref)) {
      recordFailure(failures, "observation_evidence_ref_unknown", String(observation.event || "unknown"));
    }
    const expectedEvidenceRef = expectedEvidenceRefForSurface(observation.surface, evidenceByRole);
    if (expectedEvidenceRef) {
      validateEvidenceRoleRef(
        observation.evidence_ref,
        expectedEvidenceRef,
        failures,
        "observation_evidence_ref_role_mismatch",
        `${String(observation.event || "unknown")}:${String(observation.surface || "unknown")}`,
      );
    }
  }
  for (const requirement of requiredObservations) {
    const [surface, eventName] = requirement.split(":");
    if (!observationExists(observations, surface, eventName, missionId, knownEvidenceRefs)) {
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
if (missionId && !missionId.startsWith("mission_")) {
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
const manifestPath = pathFor("manifest", "OBSERVATIONS_MANIFEST");

const evidence = Object.entries(evidenceArgs)
  .map(([role, path]) => validateEvidence(role, path, failures))
  .filter(Boolean);
const evidenceByRole = Object.fromEntries(evidence.map((entry) => [entry.role, entry]));
const knownEvidenceRefs = new Set(evidence.map((entry) => entry.path));
validateManifest(manifestPath, missionId, evidenceByRole, knownEvidenceRefs, failures);

const readyForAssemble = failures.length === 0;
const result = {
  proof: "mission_spine_ui_device_inputs_preflight",
  proof_source: "pre_assemble_readiness_only_not_ui_device_proof",
  readyForAssemble,
  missionId: missionId || null,
  evidence,
  manifestPath: manifestPath || null,
  failures,
};

console.log(JSON.stringify(result, null, 2));

if (expectNotReady) {
  process.exit(readyForAssemble ? 1 : 0);
}

process.exit(readyForAssemble ? 0 : 1);
