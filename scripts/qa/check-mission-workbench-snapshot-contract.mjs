#!/usr/bin/env node

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const expectNotReady = args.includes("--expect-not-ready");
const helpRequested = args.includes("--help") || args.includes("-h");

const placeholderMarkers = [
  "mission_pending_runtime_projection",
  "conversation_pending_runtime_projection",
  "pending-real-capture",
  "prep_contract_fallback",
  "prep fallback",
  "PREP FALLBACK ONLY",
  "pending_rust_hub_projection",
  "TODO_FILL_AFTER_REAL_CAPTURE",
  "REPLACE_WITH_REAL_CAPTURE",
];

const forbiddenMarkers = [
  "provider_native_synced",
  "raw transcript",
  "raw_provider",
  "raw-channel",
  "raw-chat",
  "Authorization",
  "Bearer",
  "sk-",
  "/Users/",
  "/private/",
];

const truthLabels = new Set([
  "friday_owned",
  "friday_adopted",
  "observed_only",
  "linked_only",
  "unknown",
]);
const surfaceKinds = new Set(["mobile", "desktop", "telegram", "timeline"]);

const nonDoneStates = new Set([
  "ready",
  "queued",
  "provider_ack",
  "waiting",
  "stale",
  "reconnecting",
  "timeline_read",
  "blocked",
  "error",
]);
const lifecycleStates = new Set([...nonDoneStates, "completed_with_proof"]);

const capabilityKinds = new Set(["skill", "capability", "advisor"]);
const approvalStates = new Set(["not_required", "required", "approved", "blocked"]);
const controlTruthLabels = new Set(["friday_owned", "friday_adopted"]);
const routeActionTargetKinds = new Set(["file", "command", "subtask"]);
const routeActionReversibility = new Set([
  "reversible_git_worktree",
  "operator_gate_required",
  "pending_classify",
]);
const transcriptGroupKinds = new Set([
  "mission",
  "work_item",
  "provider_session",
  "skill_run",
  "channel_task",
  "workflow",
  "surface",
  "status",
  "time",
]);
const requiredTranscriptEvidenceFacets = [
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
  node scripts/qa/check-mission-workbench-snapshot-contract.mjs --file=/abs/workbench-response.json
  node scripts/qa/check-mission-workbench-snapshot-contract.mjs --url=http://127.0.0.1:3141/v1/mission-spine/workbench

Options:
  --mission-id=mission_...     Require the live snapshot to use this Mission id.
  --expect-not-ready           Exit 0 only when the snapshot is not final-capture ready.

This is a live snapshot contract preflight only. It does not write a
MISSION_SPINE_UI_DEVICE_PROOF artifact, does not set env, does not capture
screenshots, and does not run the final UI/device proof gate.`);
}

function argValue(name, envName) {
  const prefix = `--${name}=`;
  const arg = args.find((value) => value.startsWith(prefix));
  if (arg) return arg.slice(prefix.length);
  return process.env[envName] || "";
}

function recordFailure(failures, code, detail) {
  failures.push({ code, detail });
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

function collectForbiddenSecretValues() {
  return [
    process.env.FRIDAY_DEEPSEEK_API_KEY,
    process.env.FRIDAY_TELEGRAM_BOT_TOKEN,
    process.env.FRIDAY_TELEGRAM_ALLOWED_USER_ID,
    process.env.FRIDAY_API_BEARER,
  ].filter((value) => typeof value === "string" && value.length >= 8);
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

function unwrapSnapshot(payload, failures) {
  const root = asObject(payload);
  if (!root) {
    recordFailure(failures, "payload_not_object", "root");
    return null;
  }
  if (root.ok === false) {
    recordFailure(failures, "api_envelope_not_ok", stringValue(asObject(root.error)?.code) || "unknown_error");
    return null;
  }
  const data = asObject(root.data);
  if (data?.snapshot) return asObject(data.snapshot);
  if (root.snapshot) return asObject(root.snapshot);
  if (root.missionId) return root;
  recordFailure(failures, "snapshot_missing", "expected snapshot, data.snapshot, or direct snapshot object");
  return null;
}

async function readPayloadFromUrl(url, failures) {
  const headers = {};
  const bearer = process.env.FRIDAY_API_BEARER;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  let response;
  try {
    response = await fetch(url, { headers });
  } catch {
    recordFailure(failures, "url_fetch_failed", url);
    return null;
  }
  const text = await response.text();
  validateNoForbiddenText(text, failures, "url response");
  if (!response.ok) {
    recordFailure(failures, "url_response_not_ok", String(response.status));
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    recordFailure(failures, "url_response_invalid_json", url);
    return null;
  }
}

function readPayloadFromFile(path, failures) {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    recordFailure(failures, "file_unreadable", path);
    return null;
  }
  validateNoForbiddenText(text, failures, "file payload");
  try {
    return JSON.parse(text);
  } catch {
    recordFailure(failures, "file_invalid_json", path);
    return null;
  }
}

function validateStringField(value, failures, code, detail) {
  if (typeof value !== "string" || value.trim().length === 0) {
    recordFailure(failures, code, detail);
    return "";
  }
  return value;
}

function isMissionIdProofEligible(value) {
  if (typeof value !== "string") return false;
  const missionId = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(missionId)
    && missionId.toLowerCase().includes("mission")
    && missionId !== "mission_pending_runtime_projection"
    && !missionId.includes("TODO");
}

function validateSnapshot(snapshot, expectedMissionId, failures) {
  if (!snapshot) return null;
  const text = JSON.stringify(snapshot);
  validateNoForbiddenText(text, failures, "snapshot");

  const missionId = validateStringField(snapshot.missionId, failures, "mission_id_missing", "snapshot.missionId");
  validateStringField(snapshot.fridayConversationId, failures, "conversation_id_missing", "snapshot.fridayConversationId");
  if (missionId && !isMissionIdProofEligible(missionId)) {
    recordFailure(failures, "mission_id_unexpected_shape", missionId);
  }
  if (expectedMissionId && missionId !== expectedMissionId) {
    recordFailure(failures, "mission_id_mismatch", `${missionId} !== ${expectedMissionId}`);
  }
  if (snapshot.runtimeFeedStatus !== "live_rust_hub_projection") {
    recordFailure(failures, "runtime_feed_not_live", String(snapshot.runtimeFeedStatus || ""));
  }

  const statusLabels = Array.isArray(snapshot.statusLabels) ? snapshot.statusLabels : [];
  for (const label of ["stale", "offline", "error"]) {
    if (!statusLabels.includes(label)) {
      recordFailure(failures, "status_label_missing", label);
    }
  }

  const duplicatePreflight = asObject(snapshot.duplicatePreflight);
  if (!duplicatePreflight) {
    recordFailure(failures, "duplicate_preflight_missing", "snapshot.duplicatePreflight");
  } else {
    if (duplicatePreflight.status !== "opens_existing_mission") {
      recordFailure(failures, "duplicate_preflight_not_open_existing", String(duplicatePreflight.status || ""));
    }
    if (missionId && duplicatePreflight.duplicateMissionId !== missionId) {
      recordFailure(failures, "duplicate_mission_mismatch", String(duplicatePreflight.duplicateMissionId || ""));
    }
    validateStringField(duplicatePreflight.duplicateWorkItemId, failures, "duplicate_work_item_missing", "duplicatePreflight.duplicateWorkItemId");
  }

  const routeDecision = asObject(snapshot.routeDecision);
  if (!routeDecision) {
    recordFailure(failures, "route_decision_missing", "snapshot.routeDecision");
  } else {
    validateStringField(routeDecision.advisorSummary, failures, "route_decision_summary_missing", "routeDecision.advisorSummary");
    validateStringField(routeDecision.selectedRoute, failures, "route_decision_selected_missing", "routeDecision.selectedRoute");
    if (!truthLabels.has(routeDecision.truthLabel)) {
      recordFailure(failures, "route_decision_truth_label_invalid", String(routeDecision.truthLabel || ""));
    }
    const actionItems = Array.isArray(routeDecision.actionItems) ? routeDecision.actionItems : [];
    if (!Array.isArray(routeDecision.actionItems)) {
      recordFailure(failures, "route_decision_action_items_not_array", "routeDecision.actionItems");
    }
    for (const [index, item] of actionItems.entries()) {
      const action = asObject(item);
      if (!action) {
        recordFailure(failures, "route_decision_action_not_object", `routeDecision.actionItems[${index}]`);
        continue;
      }
      validateStringField(action.description, failures, "route_decision_action_description_missing", `routeDecision.actionItems[${index}].description`);
      validateStringField(action.targetRef, failures, "route_decision_action_target_ref_missing", `routeDecision.actionItems[${index}].targetRef`);
      validateStringField(action.assignedLane, failures, "route_decision_action_assigned_lane_missing", `routeDecision.actionItems[${index}].assignedLane`);
      validateStringField(action.routeReason, failures, "route_decision_action_route_reason_missing", `routeDecision.actionItems[${index}].routeReason`);
      if (!routeActionTargetKinds.has(action.targetKind)) {
        recordFailure(failures, "route_decision_action_target_kind_invalid", String(action.targetKind || ""));
      }
      if (!routeActionReversibility.has(action.reversibility)) {
        recordFailure(failures, "route_decision_action_reversibility_invalid", String(action.reversibility || ""));
      }
    }
  }

  const providerReceiptRefs = Array.isArray(snapshot.providerReceiptRefs) ? snapshot.providerReceiptRefs : [];
  if (providerReceiptRefs.length < 1) recordFailure(failures, "provider_receipt_refs_missing", "snapshot.providerReceiptRefs");
  const channelReceiptRefs = Array.isArray(snapshot.channelReceiptRefs) ? snapshot.channelReceiptRefs : [];
  if (channelReceiptRefs.length < 1) recordFailure(failures, "channel_receipt_refs_missing", "snapshot.channelReceiptRefs");

  const workItems = Array.isArray(snapshot.workItems) ? snapshot.workItems : [];
  if (workItems.length < 1) recordFailure(failures, "work_items_missing", "snapshot.workItems");
  let hasAckNotDone = false;
  let hasTimelineReadNotDone = false;
  let hasCompletedWithProof = false;
  const workItemIds = new Set();
  for (const item of workItems) {
    const workItem = asObject(item);
    if (!workItem) {
      recordFailure(failures, "work_item_invalid", "non-object item");
      continue;
    }
    const id = validateStringField(workItem.id, failures, "work_item_id_missing", "workItems[].id");
    if (id) workItemIds.add(id);
    if (!truthLabels.has(workItem.owner)) {
      recordFailure(failures, "work_item_truth_label_invalid", `${id}: ${String(workItem.owner || "")}`);
    }
    if (!lifecycleStates.has(workItem.state)) {
      recordFailure(failures, "work_item_state_invalid", `${id}: ${String(workItem.state || "")}`);
    }
    if (workItem.state === "provider_ack" && workItem.done === false) hasAckNotDone = true;
    if (workItem.state === "timeline_read" && workItem.done === false) hasTimelineReadNotDone = true;
    if (workItem.state === "completed_with_proof") {
      if (workItem.done !== true) recordFailure(failures, "completed_with_proof_not_done", id);
      if (!workItem.proofRef) recordFailure(failures, "completed_with_proof_missing_ref", id);
      if (workItem.done === true && workItem.proofRef) hasCompletedWithProof = true;
    }
    if (nonDoneStates.has(workItem.state) && workItem.done === true) {
      recordFailure(failures, "non_completion_state_marked_done", `${id}: ${workItem.state}`);
    }
  }
  if (!hasAckNotDone) recordFailure(failures, "provider_ack_not_done_missing", "workItems");
  if (!hasTimelineReadNotDone) recordFailure(failures, "timeline_read_not_done_missing", "workItems");
  if (!hasCompletedWithProof) recordFailure(failures, "completed_with_proof_ref_missing", "workItems");

  const timelinePages = Array.isArray(snapshot.timelinePages) ? snapshot.timelinePages : [];
  if (timelinePages.length < 2) recordFailure(failures, "timeline_pages_too_few", String(timelinePages.length));
  const pageNumbers = new Set();
  const timelineEventRefs = new Set();
  for (const page of timelinePages) {
    const timelinePage = asObject(page);
    if (!timelinePage) {
      recordFailure(failures, "timeline_page_invalid", "non-object page");
      continue;
    }
    pageNumbers.add(Number(timelinePage.page));
    validateStringField(timelinePage.cursor, failures, "timeline_cursor_missing", `page ${String(timelinePage.page || "")}`);
    const eventRefs = Array.isArray(timelinePage.eventRefs) ? timelinePage.eventRefs : [];
    if (eventRefs.length < 1) recordFailure(failures, "timeline_event_refs_missing", `page ${String(timelinePage.page || "")}`);
    for (const eventRef of eventRefs) {
      if (typeof eventRef === "string" && eventRef.trim().length > 0) {
        timelineEventRefs.add(eventRef);
      }
    }
  }
  if (!pageNumbers.has(1) || !pageNumbers.has(2)) {
    recordFailure(failures, "timeline_required_pages_missing", "pages 1 and 2");
  }

  const memoryCandidates = Array.isArray(snapshot.memoryCandidates) ? snapshot.memoryCandidates : [];
  if (memoryCandidates.length < 1) recordFailure(failures, "memory_candidates_missing", "snapshot.memoryCandidates");
  for (const candidate of memoryCandidates) {
    const memory = asObject(candidate);
    if (!memory) {
      recordFailure(failures, "memory_candidate_invalid", "non-object candidate");
      continue;
    }
    if (memory.state !== "candidate_review_only" || memory.grantsMemoryAuthority !== false) {
      recordFailure(failures, "memory_candidate_not_review_only", String(memory.id || "unknown"));
    }
    validateStringField(memory.evidenceRef, failures, "memory_candidate_evidence_missing", String(memory.id || "unknown"));
  }

  const capabilityStates = Array.isArray(snapshot.capabilityStates) ? snapshot.capabilityStates : [];
  if (capabilityStates.length < 1) recordFailure(failures, "capability_states_missing", "snapshot.capabilityStates");
  for (const state of capabilityStates) {
    const capability = asObject(state);
    if (!capability) {
      recordFailure(failures, "capability_state_invalid", "non-object capability");
      continue;
    }
    const id = validateStringField(capability.id, failures, "capability_state_id_missing", "capabilityStates[].id");
    validateStringField(capability.label, failures, "capability_state_label_missing", id || "unknown");
    validateStringField(capability.summary, failures, "capability_state_summary_missing", id || "unknown");
    validateStringField(capability.proofRef, failures, "capability_state_proof_ref_missing", id || "unknown");
    if (!capabilityKinds.has(capability.kind)) {
      recordFailure(failures, "capability_state_kind_invalid", `${id}: ${String(capability.kind || "")}`);
    }
    if (!truthLabels.has(capability.truthLabel)) {
      recordFailure(failures, "capability_state_truth_label_invalid", `${id}: ${String(capability.truthLabel || "")}`);
    }
    if (!approvalStates.has(capability.approvalState)) {
      recordFailure(failures, "capability_state_approval_invalid", `${id}: ${String(capability.approvalState || "")}`);
    }
    if (capability.dispatchAllowed === true) {
      if (!controlTruthLabels.has(capability.truthLabel)) {
        recordFailure(failures, "capability_state_dispatch_truth_invalid", `${id}: ${String(capability.truthLabel || "")}`);
      }
      if (capability.approvalState !== "approved" && capability.approvalState !== "not_required") {
        recordFailure(failures, "capability_state_dispatch_approval_invalid", `${id}: ${String(capability.approvalState || "")}`);
      }
    }
  }

  const transcriptSections = Array.isArray(snapshot.transcriptSections) ? snapshot.transcriptSections : [];
  if (transcriptSections.length < 1) recordFailure(failures, "transcript_sections_missing", "snapshot.transcriptSections");
  const surfaces = new Set();
  const evidenceFacets = new Set();
  const transcriptEventIds = new Set();
  let transcriptEventCount = 0;
  for (const section of transcriptSections) {
    const transcriptSection = asObject(section);
    if (!transcriptSection) {
      recordFailure(failures, "transcript_section_invalid", "non-object section");
      continue;
    }
    if (missionId && transcriptSection.missionId !== missionId) {
      recordFailure(failures, "transcript_section_mission_mismatch", String(transcriptSection.id || "unknown"));
    }
    if (!truthLabels.has(transcriptSection.truthLabel)) {
      recordFailure(failures, "transcript_section_truth_label_invalid", String(transcriptSection.id || "unknown"));
    }
    if (!lifecycleStates.has(transcriptSection.status)) {
      recordFailure(failures, "transcript_section_status_invalid", `${String(transcriptSection.id || "unknown")}: ${String(transcriptSection.status || "")}`);
    }
    if (!transcriptGroupKinds.has(transcriptSection.groupKind)) {
      recordFailure(failures, "transcript_section_group_kind_invalid", `${String(transcriptSection.id || "unknown")}: ${String(transcriptSection.groupKind || "")}`);
    }
    const events = Array.isArray(transcriptSection.events) ? transcriptSection.events : [];
    if (events.length < 1) recordFailure(failures, "transcript_section_events_missing", String(transcriptSection.id || "unknown"));
    for (const event of events) {
      const transcriptEvent = asObject(event);
      if (!transcriptEvent) {
        recordFailure(failures, "transcript_event_invalid", "non-object event");
        continue;
      }
      transcriptEventCount += 1;
      const eventId = validateStringField(transcriptEvent.id, failures, "transcript_event_id_missing", String(transcriptEvent.summary || "unknown"));
      if (eventId) {
        transcriptEventIds.add(eventId);
        if (!timelineEventRefs.has(eventId)) {
          recordFailure(failures, "transcript_event_missing_from_timeline", eventId);
        }
      }
      if (missionId && transcriptEvent.missionId !== missionId) {
        recordFailure(failures, "transcript_event_mission_mismatch", String(transcriptEvent.id || "unknown"));
      }
      if (transcriptEvent.workItemId && !workItemIds.has(transcriptEvent.workItemId)) {
        recordFailure(failures, "transcript_event_work_item_unknown", `${String(transcriptEvent.id || "unknown")}: ${transcriptEvent.workItemId}`);
      }
      if (!truthLabels.has(transcriptEvent.truthLabel)) {
        recordFailure(failures, "transcript_event_truth_label_invalid", String(transcriptEvent.id || "unknown"));
      }
      if (!surfaceKinds.has(transcriptEvent.surface)) {
        recordFailure(failures, "transcript_event_surface_invalid", `${String(transcriptEvent.id || "unknown")}: ${String(transcriptEvent.surface || "")}`);
      }
      if (!lifecycleStates.has(transcriptEvent.status)) {
        recordFailure(failures, "transcript_event_status_invalid", `${String(transcriptEvent.id || "unknown")}: ${String(transcriptEvent.status || "")}`);
      }
      const evidenceRefs = asObject(transcriptEvent.evidenceRefs);
      if (!evidenceRefs) {
        recordFailure(failures, "transcript_event_evidence_refs_missing", String(transcriptEvent.id || "unknown"));
      } else {
        let eventEvidenceRefCount = 0;
        for (const [facet, value] of Object.entries(evidenceRefs)) {
          if (typeof value === "string" && value.trim().length > 0) {
            eventEvidenceRefCount += 1;
            evidenceFacets.add(facet);
          }
        }
        if (eventEvidenceRefCount < 1) {
          recordFailure(failures, "transcript_event_evidence_refs_empty", String(transcriptEvent.id || "unknown"));
        }
      }
      if (surfaceKinds.has(transcriptEvent.surface)) surfaces.add(transcriptEvent.surface);
      validateStringField(transcriptEvent.summary, failures, "transcript_event_summary_missing", String(transcriptEvent.id || "unknown"));
      validateStringField(transcriptEvent.capturedAt, failures, "transcript_event_capture_missing", String(transcriptEvent.id || "unknown"));
    }
  }
  for (const surface of ["mobile", "desktop", "telegram", "timeline"]) {
    if (!surfaces.has(surface)) {
      recordFailure(failures, "transcript_surface_missing", surface);
    }
  }
  for (const facet of requiredTranscriptEvidenceFacets) {
    if (!evidenceFacets.has(facet)) {
      recordFailure(failures, "transcript_evidence_facet_missing", facet);
    }
  }
  if (transcriptEventCount < 6) {
    recordFailure(failures, "transcript_events_too_few", String(transcriptEventCount));
  }
  for (const eventRef of timelineEventRefs) {
    if (!transcriptEventIds.has(eventRef)) {
      recordFailure(failures, "timeline_event_ref_missing_from_transcript", eventRef);
    }
  }

  return {
    missionId,
    workItemCount: workItems.length,
    timelinePageCount: timelinePages.length,
    memoryCandidateCount: memoryCandidates.length,
    capabilityStateCount: capabilityStates.length,
    transcriptSectionCount: transcriptSections.length,
    transcriptEventCount,
    transcriptSurfaces: Array.from(surfaces).sort(),
    transcriptEvidenceFacets: Array.from(evidenceFacets).sort(),
  };
}

if (helpRequested) {
  usage();
  process.exit(0);
}

const failures = [];
const filePath = argValue("file", "MISSION_WORKBENCH_SNAPSHOT_FILE");
let url = argValue("url", "MISSION_WORKBENCH_SNAPSHOT_URL");
const expectedMissionId = argValue("mission-id", "MISSION_ID");

if (filePath && url) {
  recordFailure(failures, "multiple_sources", "choose --file or --url, not both");
}
if (!filePath && !url) {
  recordFailure(failures, "missing_source", "--file or --url");
}
if (url && expectedMissionId && !url.includes("missionId=")) {
  const separator = url.includes("?") ? "&" : "?";
  url = `${url}${separator}missionId=${encodeURIComponent(expectedMissionId)}`;
}

let payload = null;
if (filePath && !url) {
  payload = readPayloadFromFile(filePath, failures);
} else if (url && !filePath) {
  payload = await readPayloadFromUrl(url, failures);
}

const snapshot = payload ? unwrapSnapshot(payload, failures) : null;
const summary = validateSnapshot(snapshot, expectedMissionId, failures);
const readyForLiveCaptureInput = failures.length === 0;

const result = {
  proof: "mission_workbench_snapshot_contract_preflight",
  proof_source: "live_snapshot_contract_check_only_not_ui_device_proof",
  source: filePath ? { kind: "file", path: filePath } : url ? { kind: "url", url } : null,
  expectedMissionId: expectedMissionId || null,
  readyForLiveCaptureInput,
  summary,
  failures,
};

console.log(JSON.stringify(result, null, 2));

if (expectNotReady) {
  process.exit(readyForLiveCaptureInput ? 1 : 0);
}

process.exit(readyForLiveCaptureInput ? 0 : 1);
