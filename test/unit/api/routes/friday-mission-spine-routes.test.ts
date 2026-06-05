import { describe, expect, it, vi } from "vitest";

import { FridayDomainError } from "../../../../src/errors/friday-domain-error.js";
import {
  createFridayMissionSpineRoutes,
  type FridayMissionSpineRoutesDeps,
} from "../../../../src/api/http/routes/friday-mission-spine-routes.js";
import type { FridayMissionSpineWorkbenchSnapshot } from "../../../../src/api/model/friday-api-mission-spine.types.js";

const snapshot: FridayMissionSpineWorkbenchSnapshot = {
  missionId: "mission_live_projection_test",
  fridayConversationId: "conversation_live_projection_test",
  runtimeFeedStatus: "live_rust_hub_projection",
  statusLabels: ["stale", "offline", "error"],
  duplicatePreflight: {
    status: "opens_existing_mission",
    duplicateMissionId: "mission_live_projection_test",
    duplicateWorkItemId: "work_live_projection_test",
  },
  routeDecision: {
    advisorSummary: "Rust Hub route decision projection.",
    selectedRoute: "route_decision_ref",
    alternatives: ["alternate_ref"],
    truthLabel: "friday_owned",
  },
  providerReceiptRefs: ["proof://provider/receipt/redacted"],
  channelReceiptRefs: ["proof://channel/receipt/redacted"],
  workItems: [
    {
      id: "work_live_projection_test",
      title: "Mission-bound provider action",
      state: "provider_ack",
      owner: "friday_owned",
      proofRef: "proof://provider/ack/not-completion",
      done: false,
    },
    {
      id: "work_timeline_projection_test",
      title: "Bounded timeline read",
      state: "timeline_read",
      owner: "friday_owned",
      proofRef: "proof://timeline/page-2/cursor",
      done: false,
    },
    {
      id: "work_completed_projection_test",
      title: "Completed only after proof receipt",
      state: "completed_with_proof",
      owner: "friday_owned",
      proofRef: "proof://provider/receipt/redacted",
      done: true,
    },
  ],
  timelinePages: [
    { page: 1, cursor: "cursor_1", nextCursor: "cursor_2", eventRefs: ["event_1", "event_mobile_intake"] },
    {
      page: 2,
      cursor: "cursor_2",
      eventRefs: [
        "event_channel_receipt",
        "event_timeline_read",
        "event_memory_candidate",
        "event_completed_with_proof",
      ],
    },
  ],
  memoryCandidates: [
    {
      id: "memory_candidate_review_only",
      preview: "Review-only candidate.",
      state: "candidate_review_only",
      grantsMemoryAuthority: false,
      evidenceRef: "proof://memory/review-only",
    },
  ],
  capabilityStates: [
    {
      id: "capability_mission_advisor",
      label: "Mission advisor",
      kind: "advisor",
      truthLabel: "friday_owned",
      approvalState: "not_required",
      dispatchAllowed: false,
      summary: "Advisor state is a Rust Hub projection.",
      proofRef: "proof://advisor/route-decision/redacted",
    },
    {
      id: "skill_observed_only",
      label: "Observed skill",
      kind: "skill",
      truthLabel: "observed_only",
      approvalState: "required",
      dispatchAllowed: false,
      summary: "Observed skill availability cannot dispatch before approval.",
      proofRef: "proof://skill/observed-only/no-dispatch",
    },
  ],
  transcriptSections: [
    {
      id: "section_live_projection_test",
      title: "Mission projection",
      groupKind: "mission",
      missionId: "mission_live_projection_test",
      truthLabel: "friday_owned",
      status: "waiting",
      events: [
        {
          id: "event_1",
          missionId: "mission_live_projection_test",
          surface: "desktop",
          status: "waiting",
          truthLabel: "friday_owned",
          summary: "Redacted event row.",
          proofRef: "proof://timeline/event-1",
          evidenceRefs: {
            surfaceThreadRef: "surface://desktop/thread/redacted",
            timelineRef: "timeline://mission/page-1/event-1",
          },
          capturedAt: "2026-06-05T00:00:00Z",
        },
        {
          id: "event_mobile_intake",
          missionId: "mission_live_projection_test",
          workItemId: "work_live_projection_test",
          surface: "mobile",
          status: "ready",
          truthLabel: "friday_owned",
          summary: "Mobile Mission intake is attached to the same Mission.",
          proofRef: "proof://surface/mobile/intake",
          evidenceRefs: {
            surfaceThreadRef: "surface://mobile/thread/redacted",
            workflowRef: "workflow://mission/intake",
            timelineRef: "timeline://mission/page-1/event-mobile-intake",
          },
          capturedAt: "2026-06-05T00:01:00Z",
        },
        {
          id: "event_channel_receipt",
          missionId: "mission_live_projection_test",
          surface: "telegram",
          status: "queued",
          truthLabel: "observed_only",
          summary: "Telegram receipt is redacted and evidence-only.",
          proofRef: "proof://channel/receipt/redacted",
          evidenceRefs: {
            channelRef: "channel://telegram/redacted-wrapper",
            proofReceiptRef: "proof://channel/receipt/redacted",
            timelineRef: "timeline://mission/page-2/event-channel-receipt",
          },
          capturedAt: "2026-06-05T00:02:00Z",
        },
        {
          id: "event_timeline_read",
          missionId: "mission_live_projection_test",
          workItemId: "work_timeline_projection_test",
          surface: "timeline",
          status: "timeline_read",
          truthLabel: "friday_owned",
          summary: "Timeline read is bounded and not completion.",
          proofRef: "proof://timeline/page-2/cursor",
          evidenceRefs: {
            workflowRef: "workflow://mission/bounded-timeline-read",
            timelineRef: "timeline://mission/page-2/cursor",
          },
          capturedAt: "2026-06-05T00:03:00Z",
        },
        {
          id: "event_memory_candidate",
          missionId: "mission_live_projection_test",
          surface: "timeline",
          status: "waiting",
          truthLabel: "friday_adopted",
          summary: "Memory remains a review-only candidate.",
          proofRef: "proof://memory/review-only",
          evidenceRefs: {
            skillRunRef: "skill://candidate/review-only-no-dispatch",
            workflowRef: "workflow://memory/review-candidate",
            timelineRef: "timeline://mission/page-2/event-memory-candidate",
          },
          capturedAt: "2026-06-05T00:04:00Z",
        },
        {
          id: "event_completed_with_proof",
          missionId: "mission_live_projection_test",
          workItemId: "work_completed_projection_test",
          surface: "desktop",
          status: "completed_with_proof",
          truthLabel: "friday_owned",
          summary: "Completion is visible only with a proof receipt.",
          proofRef: "proof://provider/receipt/redacted",
          evidenceRefs: {
            providerRef: "provider://session/redacted-receipt",
            proofReceiptRef: "proof://provider/receipt/redacted",
            surfaceThreadRef: "surface://desktop/thread/redacted",
            timelineRef: "timeline://mission/page-2/event-completed-with-proof",
          },
          capturedAt: "2026-06-05T00:05:00Z",
        },
      ],
    },
  ],
};

function cloneSnapshot(overrides: Partial<FridayMissionSpineWorkbenchSnapshot> = {}): FridayMissionSpineWorkbenchSnapshot {
  return {
    ...structuredClone(snapshot),
    ...overrides,
  };
}

function makeCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "req-mission-spine-workbench",
    receivedAt: "2026-06-05T00:00:00Z",
    params: {},
    query: {},
    body: null,
    headers: {},
    principal: {
      principalId: "principal-1",
      userId: "user-1",
      principalType: "user",
      role: "admin",
      scopes: ["hub.admin"],
    },
    ...overrides,
  };
}

function findRoute(routes: ReturnType<typeof createFridayMissionSpineRoutes>) {
  const route = routes.find((candidate) => candidate.operationId === "mission.spine.workbench.get");
  if (!route) throw new Error("mission.spine.workbench.get route missing");
  return route;
}

describe("createFridayMissionSpineRoutes", () => {
  it("registers the workbench projection route", () => {
    const routes = createFridayMissionSpineRoutes({
      workbench: { getSnapshot: vi.fn(async () => snapshot) },
      disabledReason: null,
    });
    const route = findRoute(routes);
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/v1/mission-spine/workbench");
    expect(route.auth).toEqual({ public: true });
  });

  it("fails closed when the Rust Hub projection service is absent", async () => {
    const routes = createFridayMissionSpineRoutes({
      workbench: null,
      disabledReason: "mission spine workbench projection deps not provided",
    });
    const route = findRoute(routes);
    let thrown: unknown = null;
    try {
      await route.handler(makeCtx() as never);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FridayDomainError);
    const error = thrown as FridayDomainError;
    expect(error.code).toBe("MISSION_SPINE_WORKBENCH_UNAVAILABLE");
    expect(error.httpStatus).toBe(503);
    expect(error.message).toMatch(/projection deps not provided/);
  });

  it("returns the supplied live Rust Hub snapshot without inventing fallback data", async () => {
    const getSnapshot = vi.fn(async () => snapshot);
    const routes = createFridayMissionSpineRoutes({
      workbench: { getSnapshot },
      disabledReason: null,
    });
    const route = findRoute(routes);
    const response = await route.handler(makeCtx({
      query: { missionId: "mission_live_projection_test" },
    }) as never);

    expect(response).toEqual({ snapshot });
    expect(getSnapshot).toHaveBeenCalledWith({
      missionId: "mission_live_projection_test",
      principalId: "principal-1",
      userId: "user-1",
      surface: "api:/v1/mission-spine/workbench",
    });
    expect(JSON.stringify(response)).not.toContain("mission_pending_runtime_projection");
    expect(JSON.stringify(response)).not.toContain("prep fallback");
  });

  it("fails closed when the live snapshot does not match the requested Mission id", async () => {
    const mismatchedSnapshot = cloneSnapshot({
      missionId: "mission_different_live_projection",
      duplicatePreflight: {
        ...snapshot.duplicatePreflight,
        duplicateMissionId: "mission_different_live_projection",
      },
      transcriptSections: snapshot.transcriptSections.map((section) => ({
        ...section,
        missionId: "mission_different_live_projection",
        events: section.events.map((event) => ({
          ...event,
          missionId: "mission_different_live_projection",
        })),
      })),
    });
    const routes = createFridayMissionSpineRoutes({
      workbench: { getSnapshot: vi.fn(async () => mismatchedSnapshot) },
      disabledReason: null,
    });
    const route = findRoute(routes);

    let thrown: unknown = null;
    try {
      await route.handler(makeCtx({
        query: { missionId: "mission_live_projection_test" },
      }) as never);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(FridayDomainError);
    const error = thrown as FridayDomainError;
    expect(error.code).toBe("MISSION_SPINE_WORKBENCH_SNAPSHOT_INVALID");
    expect(error.httpStatus).toBe(503);
    expect(JSON.stringify(error.details)).toContain("requested_mission_id_mismatch");
  });

  it("fails closed when a supplied snapshot is still pending runtime projection", async () => {
    const pendingSnapshot = cloneSnapshot({
      missionId: "mission_pending_runtime_projection",
      runtimeFeedStatus: "pending_rust_hub_projection",
    });
    const routes = createFridayMissionSpineRoutes({
      workbench: { getSnapshot: vi.fn(async () => pendingSnapshot) },
      disabledReason: null,
    });
    const route = findRoute(routes);

    let thrown: unknown = null;
    try {
      await route.handler(makeCtx() as never);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(FridayDomainError);
    const error = thrown as FridayDomainError;
    expect(error.code).toBe("MISSION_SPINE_WORKBENCH_SNAPSHOT_INVALID");
    expect(error.httpStatus).toBe(503);
    expect(JSON.stringify(error.details)).toContain("runtime_feed_not_live");
    expect(JSON.stringify(error.details)).toContain("placeholder:mission_pending_runtime_projection");
  });

  it("fails closed when provider ack or timeline read is marked done", async () => {
    const invalidSnapshot = cloneSnapshot({
      workItems: snapshot.workItems.map((item) => (
        item.state === "provider_ack" || item.state === "timeline_read"
          ? { ...item, done: true }
          : item
      )),
    });
    const routes = createFridayMissionSpineRoutes({
      workbench: { getSnapshot: vi.fn(async () => invalidSnapshot) },
      disabledReason: null,
    });
    const route = findRoute(routes);

    let thrown: unknown = null;
    try {
      await route.handler(makeCtx() as never);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(FridayDomainError);
    const error = thrown as FridayDomainError;
    expect(error.code).toBe("MISSION_SPINE_WORKBENCH_SNAPSHOT_INVALID");
    expect(JSON.stringify(error.details)).toContain("non_completion_state_marked_done");
  });

  it("fails closed when observed or approval-gated capability state can dispatch", async () => {
    const invalidSnapshot = cloneSnapshot({
      capabilityStates: snapshot.capabilityStates.map((capability) => (
        capability.id === "skill_observed_only"
          ? { ...capability, dispatchAllowed: true }
          : capability
      )),
    });
    const routes = createFridayMissionSpineRoutes({
      workbench: { getSnapshot: vi.fn(async () => invalidSnapshot) },
      disabledReason: null,
    });
    const route = findRoute(routes);

    let thrown: unknown = null;
    try {
      await route.handler(makeCtx() as never);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(FridayDomainError);
    const error = thrown as FridayDomainError;
    expect(error.code).toBe("MISSION_SPINE_WORKBENCH_SNAPSHOT_INVALID");
    expect(JSON.stringify(error.details)).toContain("capability_state_dispatch_truth_invalid");
    expect(JSON.stringify(error.details)).toContain("capability_state_dispatch_approval_invalid");
  });

  it("fails closed when transcript rows lack safe evidence facets", async () => {
    const invalidSnapshot = cloneSnapshot({
      transcriptSections: snapshot.transcriptSections.map((section) => ({
        ...section,
        events: section.events.map((event) => ({
          ...event,
          evidenceRefs: {},
        })),
      })),
    });
    const routes = createFridayMissionSpineRoutes({
      workbench: { getSnapshot: vi.fn(async () => invalidSnapshot) },
      disabledReason: null,
    });
    const route = findRoute(routes);

    let thrown: unknown = null;
    try {
      await route.handler(makeCtx() as never);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(FridayDomainError);
    const error = thrown as FridayDomainError;
    expect(error.code).toBe("MISSION_SPINE_WORKBENCH_SNAPSHOT_INVALID");
    expect(JSON.stringify(error.details)).toContain("transcript_event_evidence_refs_empty");
    expect(JSON.stringify(error.details)).toContain("transcript_timeline_refs_missing");
  });

  it("fails closed when timeline pages and transcript events are not linked", async () => {
    const invalidSnapshot = cloneSnapshot({
      timelinePages: [
        { page: 1, cursor: "cursor_1", nextCursor: "cursor_2", eventRefs: ["event_1", "event_missing_from_transcript"] },
        { page: 2, cursor: "cursor_2", eventRefs: ["event_channel_receipt"] },
      ],
    });
    const routes = createFridayMissionSpineRoutes({
      workbench: { getSnapshot: vi.fn(async () => invalidSnapshot) },
      disabledReason: null,
    });
    const route = findRoute(routes);

    let thrown: unknown = null;
    try {
      await route.handler(makeCtx() as never);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(FridayDomainError);
    const error = thrown as FridayDomainError;
    expect(error.code).toBe("MISSION_SPINE_WORKBENCH_SNAPSHOT_INVALID");
    expect(JSON.stringify(error.details)).toContain("timeline_event_ref_missing_from_transcript:event_missing_from_transcript");
    expect(JSON.stringify(error.details)).toContain("transcript_event_missing_from_timeline:event_mobile_intake");
  });

  it("fails closed when live Workbench rows expose private filesystem paths", async () => {
    const invalidSnapshot = cloneSnapshot({
      transcriptSections: snapshot.transcriptSections.map((section) => ({
        ...section,
        events: section.events.map((event, index) => (
          index === 0
            ? {
              ...event,
              summary: "Leaked local path /Users/jarvis/private/session.log",
              proofRef: "/private/tmp/provider-proof.json",
            }
            : event
        )),
      })),
    });
    const routes = createFridayMissionSpineRoutes({
      workbench: { getSnapshot: vi.fn(async () => invalidSnapshot) },
      disabledReason: null,
    });
    const route = findRoute(routes);

    let thrown: unknown = null;
    try {
      await route.handler(makeCtx() as never);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(FridayDomainError);
    const error = thrown as FridayDomainError;
    expect(error.code).toBe("MISSION_SPINE_WORKBENCH_SNAPSHOT_INVALID");
    expect(JSON.stringify(error.details)).toContain("forbidden:/Users/");
    expect(JSON.stringify(error.details)).toContain("forbidden:/private/");
  });

  it("fails closed when live Workbench rows carry invalid contract enums", async () => {
    const invalidSnapshot = cloneSnapshot({
      workItems: snapshot.workItems.map((item, index) => (
        index === 0
          ? { ...item, owner: "provider_owned", state: "provider_done_ack" }
          : item
      )) as never,
      transcriptSections: snapshot.transcriptSections.map((section) => ({
        ...section,
        truthLabel: "provider_owned",
        status: "provider_done_ack",
        events: section.events.map((event, index) => (
          index === 0
            ? {
              ...event,
              surface: "slack_raw",
              status: "provider_done_ack",
              truthLabel: "provider_owned",
            }
            : event
        )),
      })) as never,
    });
    const routes = createFridayMissionSpineRoutes({
      workbench: { getSnapshot: vi.fn(async () => invalidSnapshot) },
      disabledReason: null,
    });
    const route = findRoute(routes);

    let thrown: unknown = null;
    try {
      await route.handler(makeCtx() as never);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(FridayDomainError);
    const error = thrown as FridayDomainError;
    expect(error.code).toBe("MISSION_SPINE_WORKBENCH_SNAPSHOT_INVALID");
    expect(error.httpStatus).toBe(503);
    expect(JSON.stringify(error.details)).toContain("work_item_truth_label_invalid");
    expect(JSON.stringify(error.details)).toContain("work_item_state_invalid");
    expect(JSON.stringify(error.details)).toContain("transcript_section_truth_label_invalid");
    expect(JSON.stringify(error.details)).toContain("transcript_section_status_invalid");
    expect(JSON.stringify(error.details)).toContain("transcript_event_surface_invalid");
    expect(JSON.stringify(error.details)).toContain("transcript_event_status_invalid");
    expect(JSON.stringify(error.details)).toContain("transcript_event_truth_label_invalid");
  });
});
