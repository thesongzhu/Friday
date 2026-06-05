import { FridayDomainError } from "#errors";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayMissionSpineLifecycleState,
  FridayMissionSpineWorkbenchResponse,
  FridayMissionSpineWorkbenchSnapshot,
} from "../../model/friday-api-mission-spine.types.js";

export interface FridayMissionSpineWorkbenchProjectionInput {
  missionId?: string;
  principalId?: string;
  userId?: string;
  surface: "api:/v1/mission-spine/workbench";
}

export interface FridayMissionSpineWorkbenchProjectionService {
  getSnapshot(input: FridayMissionSpineWorkbenchProjectionInput): Promise<FridayMissionSpineWorkbenchSnapshot>;
}

export interface FridayMissionSpineRoutesDeps {
  readonly workbench: FridayMissionSpineWorkbenchProjectionService | null;
  readonly disabledReason: string | null;
}

const DEFAULT_DISABLED_MESSAGE =
  "Mission Spine workbench projection is unavailable in this runtime; the Rust Hub projection service has not been wired.";

const REQUIRED_STATUS_LABELS = ["stale", "offline", "error"] as const;
const REQUIRED_TRANSCRIPT_SURFACES = ["mobile", "desktop", "telegram", "timeline"] as const;
const SURFACE_KINDS = new Set(REQUIRED_TRANSCRIPT_SURFACES);
const TRANSCRIPT_GROUP_KINDS = new Set(["mission", "work_item", "provider_session", "skill_run", "channel_task", "workflow", "surface", "status", "time"]);
const REQUIRED_TRANSCRIPT_EVIDENCE_FACETS = [
  "providerRef",
  "skillRunRef",
  "channelRef",
  "workflowRef",
  "surfaceThreadRef",
  "timelineRef",
  "proofReceiptRef",
] as const;
const CAPABILITY_KINDS = new Set(["skill", "capability", "advisor"]);
const APPROVAL_STATES = new Set(["not_required", "required", "approved", "blocked"]);
const TRUTH_LABELS = new Set(["friday_owned", "friday_adopted", "observed_only", "linked_only", "unknown"]);
const CONTROL_TRUTH_LABELS = new Set(["friday_owned", "friday_adopted"]);
const PLACEHOLDER_MARKERS = [
  "mission_pending_runtime_projection",
  "conversation_pending_runtime_projection",
  "pending-real-capture",
  "prep_contract_fallback",
  "prep fallback",
  "pending_rust_hub_projection",
  "TODO_FILL_AFTER_REAL_CAPTURE",
] as const;
const FORBIDDEN_MARKERS = [
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
] as const;
const NON_COMPLETION_STATES = new Set<FridayMissionSpineLifecycleState>([
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
const LIFECYCLE_STATES = new Set<FridayMissionSpineLifecycleState>([
  ...NON_COMPLETION_STATES,
  "completed_with_proof",
]);

function readMissionId(query: unknown): string | undefined {
  if (!query || typeof query !== "object") return undefined;
  const value = (query as { missionId?: unknown }).missionId;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function hasText(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function pushIfInvalid(failures: string[], condition: boolean, code: string): void {
  if (!condition) failures.push(code);
}

function validateSerializedSnapshot(snapshot: FridayMissionSpineWorkbenchSnapshot, failures: string[]): void {
  const serialized = JSON.stringify(snapshot);

  for (const marker of PLACEHOLDER_MARKERS) {
    if (serialized.includes(marker)) {
      failures.push(`placeholder:${marker}`);
    }
  }
  for (const marker of FORBIDDEN_MARKERS) {
    if (serialized.includes(marker)) {
      failures.push(`forbidden:${marker}`);
    }
  }
}

function validateSnapshotHeader(
  snapshot: FridayMissionSpineWorkbenchSnapshot,
  failures: string[],
  requestedMissionId?: string,
): void {
  pushIfInvalid(failures, hasText(snapshot.missionId) && snapshot.missionId.startsWith("mission_"), "mission_id_missing_or_invalid");
  if (requestedMissionId) {
    pushIfInvalid(
      failures,
      snapshot.missionId === requestedMissionId,
      "requested_mission_id_mismatch",
    );
  }
  pushIfInvalid(failures, hasText(snapshot.fridayConversationId), "conversation_id_missing");
  pushIfInvalid(failures, snapshot.runtimeFeedStatus === "live_rust_hub_projection", "runtime_feed_not_live");

  for (const label of REQUIRED_STATUS_LABELS) {
    pushIfInvalid(failures, snapshot.statusLabels.includes(label), `status_label_missing:${label}`);
  }

  pushIfInvalid(failures, snapshot.duplicatePreflight.status === "opens_existing_mission", "duplicate_preflight_not_open_existing");
  pushIfInvalid(
    failures,
    snapshot.duplicatePreflight.duplicateMissionId === snapshot.missionId,
    "duplicate_preflight_mission_mismatch",
  );
  pushIfInvalid(failures, hasText(snapshot.duplicatePreflight.duplicateWorkItemId), "duplicate_work_item_missing");
  pushIfInvalid(failures, hasText(snapshot.routeDecision.advisorSummary), "route_decision_summary_missing");
  pushIfInvalid(failures, hasText(snapshot.routeDecision.selectedRoute), "route_decision_selected_missing");
  pushIfInvalid(failures, TRUTH_LABELS.has(snapshot.routeDecision.truthLabel), "route_decision_truth_label_invalid");
  pushIfInvalid(failures, Array.isArray(snapshot.providerReceiptRefs), "provider_receipt_refs_not_array");
  pushIfInvalid(failures, Array.isArray(snapshot.channelReceiptRefs), "channel_receipt_refs_not_array");
}

function validateWorkItems(snapshot: FridayMissionSpineWorkbenchSnapshot, failures: string[]): Set<string> {
  const workItemIds = new Set<string>();
  let providerAckNotDone = false;
  let timelineReadNotDone = false;
  let completedWithProof = false;
  pushIfInvalid(failures, snapshot.workItems.length > 0, "work_items_missing");
  for (const item of snapshot.workItems) {
    if (hasText(item.id)) workItemIds.add(item.id);
    pushIfInvalid(failures, hasText(item.title), `work_item_title_missing:${item.id}`);
    pushIfInvalid(failures, TRUTH_LABELS.has(item.owner), `work_item_truth_label_invalid:${item.id}`);
    pushIfInvalid(failures, LIFECYCLE_STATES.has(item.state), `work_item_state_invalid:${item.id}:${item.state}`);
    if (item.state === "provider_ack" && item.done === false) providerAckNotDone = true;
    if (item.state === "timeline_read" && item.done === false) timelineReadNotDone = true;
    if (NON_COMPLETION_STATES.has(item.state) && item.done === true) {
      failures.push(`non_completion_state_marked_done:${item.id}:${item.state}`);
    }
    if (item.state === "completed_with_proof") {
      if (item.done === true && hasText(item.proofRef)) {
        completedWithProof = true;
      } else {
        failures.push(`completed_with_proof_missing_ref:${item.id}`);
      }
    }
  }
  if (snapshot.providerReceiptRefs.length > 0) {
    pushIfInvalid(failures, providerAckNotDone || completedWithProof, "provider_receipt_without_provider_or_proof_state");
  }
  pushIfInvalid(failures, timelineReadNotDone || snapshot.timelinePages.length > 0, "timeline_read_projection_missing");
  return workItemIds;
}

function validateTimeline(snapshot: FridayMissionSpineWorkbenchSnapshot, failures: string[]): Set<string> {
  const timelinePages = new Set(snapshot.timelinePages.map((page) => page.page));
  const timelineEventRefs = new Set<string>();
  pushIfInvalid(failures, timelinePages.has(1) && timelinePages.has(2), "timeline_pages_1_and_2_missing");
  for (const page of snapshot.timelinePages) {
    pushIfInvalid(failures, hasText(page.cursor), `timeline_cursor_missing:${page.page}`);
    pushIfInvalid(failures, page.eventRefs.length > 0, `timeline_event_refs_missing:${page.page}`);
    for (const eventRef of page.eventRefs) {
      if (hasText(eventRef)) timelineEventRefs.add(eventRef);
    }
  }
  return timelineEventRefs;
}

function validateMemoryCandidates(snapshot: FridayMissionSpineWorkbenchSnapshot, failures: string[]): void {
  for (const candidate of snapshot.memoryCandidates) {
    pushIfInvalid(
      failures,
      candidate.state === "candidate_review_only" && candidate.grantsMemoryAuthority === false,
      `memory_candidate_not_review_only:${candidate.id}`,
    );
    pushIfInvalid(failures, hasText(candidate.evidenceRef), `memory_candidate_evidence_missing:${candidate.id}`);
  }
}

function validateCapabilityStates(snapshot: FridayMissionSpineWorkbenchSnapshot, failures: string[]): void {
  const capabilityStates = Array.isArray(snapshot.capabilityStates) ? snapshot.capabilityStates : [];
  pushIfInvalid(failures, capabilityStates.length > 0, "capability_states_missing");
  for (const capability of capabilityStates) {
    pushIfInvalid(failures, hasText(capability.id), "capability_state_id_missing");
    pushIfInvalid(failures, hasText(capability.label), `capability_state_label_missing:${capability.id}`);
    pushIfInvalid(failures, CAPABILITY_KINDS.has(capability.kind), `capability_state_kind_invalid:${capability.id}`);
    pushIfInvalid(failures, TRUTH_LABELS.has(capability.truthLabel), `capability_state_truth_label_invalid:${capability.id}`);
    pushIfInvalid(failures, APPROVAL_STATES.has(capability.approvalState), `capability_state_approval_invalid:${capability.id}`);
    pushIfInvalid(failures, hasText(capability.summary), `capability_state_summary_missing:${capability.id}`);
    pushIfInvalid(failures, hasText(capability.proofRef), `capability_state_proof_ref_missing:${capability.id}`);
    if (capability.dispatchAllowed) {
      pushIfInvalid(
        failures,
        CONTROL_TRUTH_LABELS.has(capability.truthLabel),
        `capability_state_dispatch_truth_invalid:${capability.id}`,
      );
      pushIfInvalid(
        failures,
        capability.approvalState === "approved" || capability.approvalState === "not_required",
        `capability_state_dispatch_approval_invalid:${capability.id}`,
      );
    }
  }
}

function validateTranscript(
  snapshot: FridayMissionSpineWorkbenchSnapshot,
  workItemIds: Set<string>,
  timelineEventRefs: Set<string>,
  failures: string[],
): void {
  const transcriptSurfaces = new Set<string>();
  const transcriptEvidenceFacets = new Set<string>();
  const transcriptEventIds = new Set<string>();
  let transcriptEventCount = 0;
  pushIfInvalid(failures, snapshot.transcriptSections.length > 0, "transcript_sections_missing");
  for (const section of snapshot.transcriptSections) {
    pushIfInvalid(failures, section.missionId === snapshot.missionId, `transcript_section_mission_mismatch:${section.id}`);
    pushIfInvalid(failures, TRUTH_LABELS.has(section.truthLabel), `transcript_section_truth_label_invalid:${section.id}`);
    pushIfInvalid(failures, LIFECYCLE_STATES.has(section.status), `transcript_section_status_invalid:${section.id}:${section.status}`);
    pushIfInvalid(failures, TRANSCRIPT_GROUP_KINDS.has(section.groupKind), `transcript_section_group_kind_invalid:${section.id}`);
    pushIfInvalid(failures, section.events.length > 0, `transcript_section_events_missing:${section.id}`);
    for (const event of section.events) {
      transcriptEventCount += 1;
      if (hasText(event.id)) {
        transcriptEventIds.add(event.id);
        pushIfInvalid(
          failures,
          timelineEventRefs.has(event.id),
          `transcript_event_missing_from_timeline:${event.id}`,
        );
      } else {
        failures.push("transcript_event_id_missing");
      }
      if (SURFACE_KINDS.has(event.surface)) {
        transcriptSurfaces.add(event.surface);
      } else {
        failures.push(`transcript_event_surface_invalid:${event.id}:${event.surface}`);
      }
      pushIfInvalid(failures, LIFECYCLE_STATES.has(event.status), `transcript_event_status_invalid:${event.id}:${event.status}`);
      pushIfInvalid(failures, TRUTH_LABELS.has(event.truthLabel), `transcript_event_truth_label_invalid:${event.id}`);
      const evidenceRefs = event.evidenceRefs && typeof event.evidenceRefs === "object"
        ? (event.evidenceRefs as Record<string, string | undefined>)
        : null;
      if (!evidenceRefs) {
        failures.push(`transcript_event_evidence_refs_missing:${event.id}`);
      } else {
        let eventEvidenceRefCount = 0;
        for (const [facet, ref] of Object.entries(evidenceRefs)) {
          if (hasText(ref)) {
            eventEvidenceRefCount += 1;
            transcriptEvidenceFacets.add(facet);
          }
        }
        pushIfInvalid(failures, eventEvidenceRefCount > 0, `transcript_event_evidence_refs_empty:${event.id}`);
      }
      pushIfInvalid(failures, event.missionId === snapshot.missionId, `transcript_event_mission_mismatch:${event.id}`);
      pushIfInvalid(
        failures,
        !event.workItemId || workItemIds.has(event.workItemId),
        `transcript_event_work_item_unknown:${event.id}`,
      );
      pushIfInvalid(failures, hasText(event.summary), `transcript_event_summary_missing:${event.id}`);
      pushIfInvalid(failures, hasText(event.capturedAt), `transcript_event_capture_missing:${event.id}`);
    }
  }
  pushIfInvalid(failures, transcriptSurfaces.size > 0, "transcript_surfaces_missing");
  pushIfInvalid(failures, transcriptEvidenceFacets.has("timelineRef"), "transcript_timeline_refs_missing");
  for (const facet of REQUIRED_TRANSCRIPT_EVIDENCE_FACETS) {
    if (transcriptEvidenceFacets.has(facet)) {
      pushIfInvalid(failures, facet !== "providerRef" || snapshot.providerReceiptRefs.length > 0, "provider_ref_without_provider_receipt");
      pushIfInvalid(failures, facet !== "channelRef" || snapshot.channelReceiptRefs.length > 0, "channel_ref_without_channel_receipt");
    }
  }
  pushIfInvalid(failures, transcriptEventCount > 0, "transcript_events_missing");
  for (const eventRef of timelineEventRefs) {
    pushIfInvalid(
      failures,
      transcriptEventIds.has(eventRef),
      `timeline_event_ref_missing_from_transcript:${eventRef}`,
    );
  }
}

function validateMissionSpineWorkbenchSnapshot(
  snapshot: FridayMissionSpineWorkbenchSnapshot,
  requestedMissionId?: string,
): string[] {
  const failures: string[] = [];
  validateSerializedSnapshot(snapshot, failures);
  validateSnapshotHeader(snapshot, failures, requestedMissionId);
  const workItemIds = validateWorkItems(snapshot, failures);
  const timelineEventRefs = validateTimeline(snapshot, failures);
  validateMemoryCandidates(snapshot, failures);
  validateCapabilityStates(snapshot, failures);
  validateTranscript(snapshot, workItemIds, timelineEventRefs, failures);

  return failures;
}

function throwInvalidSnapshot(failures: string[]): never {
  throw new FridayDomainError(
    "MISSION_SPINE_WORKBENCH_SNAPSHOT_INVALID",
    "Mission Spine workbench projection did not satisfy the live UI/device proof contract.",
    {
      httpStatus: 503,
      details: {
        surface: "api:/v1/mission-spine/workbench",
        projection: "rust_hub_invalid",
        proofReady: false,
        failures,
      },
    },
  );
}

export function createFridayMissionSpineRoutes(
  deps: FridayMissionSpineRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  function disabledMessage(): string {
    return deps.disabledReason && deps.disabledReason.trim().length > 0
      ? deps.disabledReason
      : DEFAULT_DISABLED_MESSAGE;
  }

  function throwDisabled(): never {
    throw new FridayDomainError(
      "MISSION_SPINE_WORKBENCH_UNAVAILABLE",
      disabledMessage(),
      {
        httpStatus: 503,
        details: {
          surface: "api:/v1/mission-spine/workbench",
          projection: "rust_hub_unavailable",
          proofReady: false,
        },
      },
    );
  }

  return [
    {
      operationId: "mission.spine.workbench.get",
      method: "GET",
      path: "/v1/mission-spine/workbench",
      auth: { public: true },
      async handler(ctx): Promise<FridayMissionSpineWorkbenchResponse> {
        if (!deps.workbench) {
          throwDisabled();
        }
        const missionId = readMissionId(ctx.query);
        const snapshot = await deps.workbench.getSnapshot({
          missionId,
          principalId: ctx.principal?.principalId,
          userId: ctx.principal?.userId,
          surface: "api:/v1/mission-spine/workbench",
        });
        const failures = validateMissionSpineWorkbenchSnapshot(snapshot, missionId);
        if (failures.length > 0) {
          throwInvalidSnapshot(failures);
        }
        return { snapshot };
      },
    },
  ];
}
