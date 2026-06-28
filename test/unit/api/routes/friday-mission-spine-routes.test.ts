import { describe, expect, it, vi } from "vitest";

import { FridayDomainError } from "../../../../src/errors/friday-domain-error.js";
import {
  createFridayMissionSpineRoutes,
  type FridayMissionSpineRoutesDeps,
} from "../../../../src/api/http/routes/friday-mission-spine-routes.js";
import { createFridayMissionAutoDispatchDriver } from "../../../../src/api/mission-spine/friday-mission-auto-dispatch-driver.js";
import { createFridayMissionSpineDispatchAdapter } from "../../../../src/api/mission-spine/friday-mission-spine-dispatch-adapter.js";
import type {
  CreateFridayRustHubAgentRunSealedClientOptions,
  FridayRustHubAgentRunSealedClient,
  FridayRustHubMissionIntakeRequest,
  FridayRustHubMissionIntakeResult,
} from "../../../../src/api/mission-spine/friday-rust-hub-agent-run-ws-sealed-client.js";
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
    controlRef: "friday://route-decision-projection/mission_live_projection_test/work_live_projection_test/1700000000000",
    workItemId: "work_live_projection_test",
    alternatives: ["alternate_ref"],
    actionItems: [
      {
        description: "Implement Mission Spine domain types",
        targetKind: "file",
        targetRef: "rust-core/crates/friday-core/src/lib.rs",
        reversibility: "operator_gate_required",
        assignedLane: "codex",
        assignedProviderOrAgent: "codex",
        routeReason: "Rust Hub must own product truth before UI wiring",
      },
    ],
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
      blockingReason: "provider or hub execution is still in flight; cancel is the only exposed recovery action",
      recoveryKind: "in_flight",
      canRetry: false,
      canCancel: true,
    },
    {
      id: "work_timeline_projection_test",
      title: "Bounded timeline read",
      state: "timeline_read",
      owner: "friday_owned",
      proofRef: "proof://timeline/page-2/cursor",
      done: false,
      blockingReason: "bounded timeline read only; no WorkItem recovery action applies",
      recoveryKind: "none",
      canRetry: false,
      canCancel: false,
    },
    {
      id: "work_completed_projection_test",
      title: "Completed only after proof receipt",
      state: "completed_with_proof",
      owner: "friday_owned",
      proofRef: "proof://provider/receipt/redacted",
      done: true,
      blockingReason: "terminal or archived WorkItem; no recovery action applies",
      recoveryKind: "none",
      canRetry: false,
      canCancel: false,
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
  t3ProvisioningStatus: {
    truthLabel: "rust_hub_t3_provisioning_read_only_no_mint",
    paired: true,
    deviceIdentityCount: 1,
    trustedDeviceCount: 1,
    activeTrustedDeviceCount: 1,
    trustGrantCount: 1,
    activeTrustGrantCount: 1,
    contextPassportCount: 1,
    contextPassportItemCount: 2,
    latestDevice: {
      deviceId: "proof://device/paired-ios-1",
      label: "operator phone",
      pairedAt: 1_780_640_000_000,
      revokedAt: null,
      keyRotatedAt: null,
      pubkeyFingerprint: "abcd1234:dcba4321",
    },
  },
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

  it("allows healthy live projections to omit negative status labels", async () => {
    const healthySnapshot = cloneSnapshot({ statusLabels: [] });
    const routes = createFridayMissionSpineRoutes({
      workbench: { getSnapshot: vi.fn(async () => healthySnapshot) },
      disabledReason: null,
    });
    const route = findRoute(routes);

    const response = await route.handler(makeCtx({
      query: { missionId: "mission_live_projection_test" },
    }) as never);

    expect(response).toEqual({ snapshot: healthySnapshot });
  });

  it("fails closed on unknown status labels without requiring negative labels on healthy projections", async () => {
    const invalidSnapshot = cloneSnapshot({
      statusLabels: ["online" as never],
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
    expect(JSON.stringify(error.details)).toContain("status_label_invalid:0:online");
  });

  it("accepts stale WorkItems only when the retry recovery affordance is exposed", async () => {
    const staleSnapshot = cloneSnapshot({
      workItems: snapshot.workItems.map((item, index) => (
        index === 0
          ? {
            ...item,
            state: "stale",
            done: false,
            blockingReason: "failed retryable; operator may retry by returning the WorkItem to ready_to_dispatch",
            recoveryKind: "retryable",
            canRetry: true,
            canCancel: true,
          }
          : item
      )),
    });
    const routes = createFridayMissionSpineRoutes({
      workbench: { getSnapshot: vi.fn(async () => staleSnapshot) },
      disabledReason: null,
    });
    const route = findRoute(routes);

    const response = await route.handler(makeCtx() as never);

    expect(response).toEqual({ snapshot: staleSnapshot });
    expect(response.snapshot.workItems[0]).toMatchObject({
      state: "stale",
      recoveryKind: "retryable",
      canRetry: true,
      canCancel: true,
      done: false,
    });
  });

  it("accepts real Rust producer hyphen mission ids without weakening exact-match checks", async () => {
    const missionId = "mission-autodisp-1781492033";
    const hyphenSnapshot = cloneSnapshot({
      missionId,
      duplicatePreflight: {
        ...snapshot.duplicatePreflight,
        duplicateMissionId: missionId,
      },
      transcriptSections: snapshot.transcriptSections.map((section) => ({
        ...section,
        missionId,
        events: section.events.map((event) => ({
          ...event,
          missionId,
        })),
      })),
    });
    const getSnapshot = vi.fn(async () => hyphenSnapshot);
    const routes = createFridayMissionSpineRoutes({
      workbench: { getSnapshot },
      disabledReason: null,
    });
    const route = findRoute(routes);

    const response = await route.handler(makeCtx({
      query: { missionId },
    }) as never);

    expect(response).toEqual({ snapshot: hyphenSnapshot });
    expect(getSnapshot).toHaveBeenCalledWith({
      missionId,
      principalId: "principal-1",
      userId: "user-1",
      surface: "api:/v1/mission-spine/workbench",
    });
  });

  it("accepts read-only T3 provisioning status but rejects raw device-key leaks", async () => {
    const routes = createFridayMissionSpineRoutes({
      workbench: { getSnapshot: vi.fn(async () => snapshot) },
      disabledReason: null,
    });
    const route = findRoute(routes);
    const response = await route.handler(makeCtx() as never);

    expect(response).toEqual({ snapshot });
    expect(JSON.stringify(response)).toContain("rust_hub_t3_provisioning_read_only_no_mint");
    expect(JSON.stringify(response)).not.toContain("0101010101010101010101010101010101010101010101010101010101010101");

    const leaked = cloneSnapshot({
      t3ProvisioningStatus: {
        ...snapshot.t3ProvisioningStatus!,
        latestDevice: {
          ...snapshot.t3ProvisioningStatus!.latestDevice!,
          pubkeyFingerprint: "0101010101010101010101010101010101010101010101010101010101010101",
        },
      },
    });
    const leakedRoutes = createFridayMissionSpineRoutes({
      workbench: { getSnapshot: vi.fn(async () => leaked) },
      disabledReason: null,
    });
    let thrown: unknown = null;
    try {
      await findRoute(leakedRoutes).handler(makeCtx() as never);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FridayDomainError);
    expect(JSON.stringify((thrown as FridayDomainError).details)).toContain("t3_latest_device_raw_pubkey_leak");
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

  it("fails closed instead of throwing a TypeError when route action items are malformed", async () => {
    const invalidSnapshot = cloneSnapshot({
      routeDecision: {
        ...snapshot.routeDecision,
        actionItems: [null],
      } as never,
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
    expect(JSON.stringify(error.details)).toContain("route_decision_action_not_object:0");
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

  it("fails closed when stale WorkItems omit the retry recovery affordance", async () => {
    const invalidSnapshot = cloneSnapshot({
      workItems: snapshot.workItems.map((item, index) => (
        index === 0
          ? {
            ...item,
            state: "stale",
            recoveryKind: "in_flight",
            canRetry: false,
            canCancel: true,
          }
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
    expect(JSON.stringify(error.details)).toContain("stale_work_item_not_retryable");
    expect(JSON.stringify(error.details)).toContain("stale_work_item_retry_not_exposed");
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
              summary: "Leaked local path /Users/example/private/session.log",
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

// ─── (Lane B) Organic mutation POST routes ──────────────────────────────────

import type { FridayMissionSpineDispatchService } from "../../../../src/api/http/routes/friday-mission-spine-routes.js";

function makeDispatch(overrides: Partial<FridayMissionSpineDispatchService> = {}): {
  dispatch: FridayMissionSpineDispatchService;
  intake: ReturnType<typeof vi.fn>;
  lifecycle: ReturnType<typeof vi.fn>;
  workItem: ReturnType<typeof vi.fn>;
  routeControl: ReturnType<typeof vi.fn>;
} {
  const intake = vi.fn(async () => ({
    truthLabel: "rust_wired" as const,
    fridayConversationId: "conversation_lane_b",
    missionId: "mission_lane_b",
    workItemId: "work_lane_b",
    surfaceThreadId: "surface_lane_b",
    status: "ready",
    blockers: [] as string[],
    createdOrReady: true,
  }));
  const lifecycle = vi.fn(async () => ({
    truthLabel: "rust_wired" as const,
    fridayConversationId: "conversation_lane_b",
    missionId: "mission_lane_b",
    previousStatus: "ready",
    status: "queued",
    actorRef: "actor_lane_b",
    reason: "advance",
    activeMissionIds: ["mission_lane_b"],
    updatedAtMs: 1_700_000_000_000,
  }));
  const workItem = vi.fn(async () => ({
    truthLabel: "rust_wired" as const,
    workItemId: "work_lane_b",
    missionId: "mission_lane_b",
    previousStatus: "ready_to_dispatch",
    status: "completed_with_proof",
    actorRef: "actor_lane_b",
    reason: "done",
    proofReceiptCount: 1,
    updatedAtMs: 1_700_000_000_000,
  }));
  const routeControl = vi.fn(async () => ({
    truthLabel: "rust_wired" as const,
    decisionId: "route_decision_lane_b",
    missionId: "mission_lane_b",
    workItemId: "work_lane_b",
    controlKind: "veto" as const,
    actorRef: "actor_lane_b",
    reason: "operator veto",
    updatedAtMs: 1_700_000_000_000,
  }));
  return {
    dispatch: {
      intakeMission: intake,
      transitionMission: lifecycle,
      transitionWorkItem: workItem,
      controlRouteDecision: routeControl,
      ...overrides,
    } as FridayMissionSpineDispatchService,
    intake,
    lifecycle,
    workItem,
    routeControl,
  };
}

function findPost(routes: ReturnType<typeof createFridayMissionSpineRoutes>, operationId: string) {
  const route = routes.find((candidate) => candidate.operationId === operationId);
  if (!route) throw new Error(`${operationId} route missing`);
  return route;
}

const BOUND_PRINCIPAL = {
  principalId: "principal-1",
  userId: "user-1",
  principalType: "user",
  role: "admin",
  scopes: ["hub.admin"],
};

const VALID_INTAKE_BODY = {
  fridayConversationId: "conversation_lane_b",
  ownerPrincipal: "owner_lane_b",
  surfaceThreadId: "surface_lane_b",
  surfaceKind: "mobile",
  deliveryRoute: "in_app",
  visibilityPolicy: "owner_only",
  missionId: "mission_lane_b",
  workItemId: "work_lane_b",
  title: "Lane B organic intake",
  intent: "create mission",
  lane: "deepseek",
};

const VALID_LIFECYCLE_BODY = {
  fridayConversationId: "conversation_lane_b",
  targetStatus: "queued",
  actorRef: "actor_lane_b",
  reason: "advance",
};

const VALID_WORK_ITEM_BODY = {
  targetStatus: "ready_to_dispatch",
  actorRef: "actor_lane_b",
  reason: "stage",
};

const VALID_ROUTE_CONTROL_BODY = {
  controlKind: "veto",
  actorRef: "actor_lane_b",
  reason: "operator veto",
};

describe("createFridayMissionSpineRoutes — Lane B organic mutation routes", () => {
  it("registers the four POST routes as public, byte-additive to the GET route", () => {
    const { dispatch } = makeDispatch();
    const routes = createFridayMissionSpineRoutes({ workbench: null, disabledReason: null, dispatch });
    const intake = findPost(routes, "mission.spine.intake.create");
    const lifecycle = findPost(routes, "mission.spine.lifecycle.transition");
    const workItem = findPost(routes, "mission.spine.workitem.status.transition");
    const routeControl = findPost(routes, "mission.spine.routedecision.control");
    expect(intake.method).toBe("POST");
    expect(intake.path).toBe("/v1/mission-spine/intake");
    expect(intake.auth).toEqual({ public: true });
    expect(lifecycle.path).toBe("/v1/mission-spine/:missionId/lifecycle");
    expect(workItem.path).toBe("/v1/mission-spine/work-items/:workItemId/status");
    expect(routeControl.path).toBe("/v1/mission-spine/route-decisions/:decisionId/control");
    expect(routeControl.auth).toEqual({ public: true });
    // The GET route is unchanged and still present.
    expect(findRoute(routes).method).toBe("GET");
  });

  describe("flag-OFF (no dispatch service) → honest-unavailable", () => {
    it("intake returns 503 without invoking any client", async () => {
      const { intake } = makeDispatch();
      const routes = createFridayMissionSpineRoutes({ workbench: null, disabledReason: null });
      const route = findPost(routes, "mission.spine.intake.create");
      let thrown: unknown = null;
      try {
        await route.handler(makeCtx({ body: VALID_INTAKE_BODY }) as never);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(FridayDomainError);
      const error = thrown as FridayDomainError;
      expect(error.code).toBe("MISSION_SPINE_DISPATCH_UNAVAILABLE");
      expect(error.httpStatus).toBe(503);
      expect(intake).not.toHaveBeenCalled();
    });

    it("lifecycle, work-item, and route-control also 503 when dispatch is null", async () => {
      const routes = createFridayMissionSpineRoutes({ workbench: null, disabledReason: null, dispatch: null });
      const lifecycle = findPost(routes, "mission.spine.lifecycle.transition");
      const workItem = findPost(routes, "mission.spine.workitem.status.transition");
      const routeControl = findPost(routes, "mission.spine.routedecision.control");
      for (const [route, params, body] of [
        [lifecycle, { missionId: "mission_lane_b" }, VALID_LIFECYCLE_BODY],
        [workItem, { workItemId: "work_lane_b" }, VALID_WORK_ITEM_BODY],
        [routeControl, { decisionId: "route_decision_lane_b" }, VALID_ROUTE_CONTROL_BODY],
      ] as const) {
        let thrown: unknown = null;
        try {
          await route.handler(makeCtx({ params, body }) as never);
        } catch (err) {
          thrown = err;
        }
        expect((thrown as FridayDomainError).code).toBe("MISSION_SPINE_DISPATCH_UNAVAILABLE");
        expect((thrown as FridayDomainError).httpStatus).toBe(503);
      }
    });

    it("503-unavailable fires FIRST — even for a null (unauthenticated) principal", async () => {
      const routes = createFridayMissionSpineRoutes({ workbench: null, disabledReason: null });
      const route = findPost(routes, "mission.spine.intake.create");
      let thrown: unknown = null;
      try {
        await route.handler(makeCtx({ principal: null, body: VALID_INTAKE_BODY }) as never);
      } catch (err) {
        thrown = err;
      }
      // Flag-OFF is a uniform honest-unavailable, NOT a principal refusal.
      expect((thrown as FridayDomainError).code).toBe("MISSION_SPINE_DISPATCH_UNAVAILABLE");
    });
  });

  describe("flag-ON: bound-principal gate", () => {
    it("refuses the synthetic public (null) principal with a bound-principal 401, no dispatch", async () => {
      const { dispatch, intake } = makeDispatch();
      const routes = createFridayMissionSpineRoutes({ workbench: null, disabledReason: null, dispatch });
      const route = findPost(routes, "mission.spine.intake.create");
      let thrown: unknown = null;
      try {
        await route.handler(makeCtx({ principal: null, body: VALID_INTAKE_BODY }) as never);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(FridayDomainError);
      expect((thrown as FridayDomainError).httpStatus).toBe(401);
      expect(intake).not.toHaveBeenCalled();
    });
  });

  describe("flag-ON: builds the correct wire + returns the refs-only result", () => {
    it("intake maps the body to the typed request and passes through the result", async () => {
      const { dispatch, intake } = makeDispatch();
      const routes = createFridayMissionSpineRoutes({ workbench: null, disabledReason: null, dispatch });
      const route = findPost(routes, "mission.spine.intake.create");
      const response = await route.handler(
        makeCtx({
          principal: BOUND_PRINCIPAL,
          body: {
            ...VALID_INTAKE_BODY,
            proofRequirements: [" outcome:AnswerProduced:>=1 "],
            includesSensitiveContext: true,
          },
        }) as never,
      );
      expect(intake).toHaveBeenCalledTimes(1);
      expect(intake).toHaveBeenCalledWith({
        ...VALID_INTAKE_BODY,
        proofRequirements: ["outcome:AnswerProduced:>=1"],
        includesSensitiveContext: true,
      });
      expect((response as { result: { status: string } }).result.status).toBe("ready");
    });

    it("lifecycle takes the missionId from the path, omitting absent optionals", async () => {
      const { dispatch, lifecycle } = makeDispatch();
      const routes = createFridayMissionSpineRoutes({ workbench: null, disabledReason: null, dispatch });
      const route = findPost(routes, "mission.spine.lifecycle.transition");
      await route.handler(
        makeCtx({ principal: BOUND_PRINCIPAL, params: { missionId: "mission_from_path" }, body: VALID_LIFECYCLE_BODY }) as never,
      );
      expect(lifecycle).toHaveBeenCalledWith({
        fridayConversationId: "conversation_lane_b",
        missionId: "mission_from_path",
        targetStatus: "queued",
        actorRef: "actor_lane_b",
        reason: "advance",
      });
    });

    it("work-item takes the workItemId from the path and passes proofReceipt through", async () => {
      const { dispatch, workItem } = makeDispatch();
      const routes = createFridayMissionSpineRoutes({ workbench: null, disabledReason: null, dispatch });
      const route = findPost(routes, "mission.spine.workitem.status.transition");
      const response = await route.handler(
        makeCtx({
          principal: BOUND_PRINCIPAL,
          params: { workItemId: "work_from_path" },
          body: { targetStatus: "completed_with_proof", actorRef: "actor_lane_b", reason: "done", proofReceipt: "proof://receipt/ref" },
        }) as never,
      );
      expect(workItem).toHaveBeenCalledWith({
        workItemId: "work_from_path",
        targetStatus: "completed_with_proof",
        actorRef: "actor_lane_b",
        reason: "done",
        proofReceipt: "proof://receipt/ref",
      });
      expect((response as { result: { proofReceiptCount: number } }).result.proofReceiptCount).toBe(1);
    });

    it("route-control takes the decisionId from the path and delegates veto/override", async () => {
      const { dispatch, routeControl } = makeDispatch();
      const routes = createFridayMissionSpineRoutes({ workbench: null, disabledReason: null, dispatch });
      const route = findPost(routes, "mission.spine.routedecision.control");
      const response = await route.handler(
        makeCtx({
          principal: BOUND_PRINCIPAL,
          params: { decisionId: "route_decision_from_path" },
          body: {
            controlKind: "override",
            overrideLane: "codex",
            overrideProviderOrAgent: "codex",
            actorRef: "actor_lane_b",
            reason: "Codex owns this edit",
          },
        }) as never,
      );
      expect(routeControl).toHaveBeenCalledWith({
        decisionId: "route_decision_from_path",
        controlKind: "override",
        overrideLane: "codex",
        overrideProviderOrAgent: "codex",
        actorRef: "actor_lane_b",
        reason: "Codex owns this edit",
      });
      expect((response as { result: { decisionId: string } }).result.decisionId).toBe("route_decision_lane_b");
    });
  });

  describe("flag-ON: route + adapter + auto-dispatch producer composed", () => {
    function makeRouteWithAutoDispatch(result: FridayRustHubMissionIntakeResult) {
      const startRun = vi.fn(async () => ({ runId: "run-route-auto" }));
      const driver = createFridayMissionAutoDispatchDriver({
        startRun: () => startRun,
        deepseekProviderId: "deepseek",
        deepseekFlashModel: "deepseek-v4-flash",
        codexProviderId: "codex",
        codexModel: "gpt-5.5",
        claudeProviderId: "claude",
        claudeModel: "claude-opus-4-8",
      });
      const intakeCalls: FridayRustHubMissionIntakeRequest[] = [];
      const createClient = vi.fn(
        (_options: CreateFridayRustHubAgentRunSealedClientOptions): FridayRustHubAgentRunSealedClient => ({
          dispatchRun: vi.fn(async () => {
            throw new Error("dispatchRun is owned by the auto-dispatch startRun seam in this test");
          }),
          resumeWithApproval: vi.fn(async () => {
            throw new Error("resumeWithApproval not used by mission-spine intake");
          }),
          intakeMission: vi.fn(async (request: FridayRustHubMissionIntakeRequest) => {
            intakeCalls.push(request);
            return result;
          }),
          transitionMission: vi.fn(async () => {
            throw new Error("transitionMission not used by mission-spine intake");
          }),
          transitionWorkItem: vi.fn(async () => {
            throw new Error("transitionWorkItem not used by mission-spine intake");
          }),
          controlRouteDecision: vi.fn(async () => {
            throw new Error("controlRouteDecision not used by mission-spine intake");
          }),
        }),
      );
      const dispatch = createFridayMissionSpineDispatchAdapter({
        port: 48750,
        secretResolver: () => new Uint8Array(32).fill(9),
        createClient,
        autoDispatchDriver: driver,
      });
      const route = findPost(
        createFridayMissionSpineRoutes({ workbench: null, disabledReason: null, dispatch }),
        "mission.spine.intake.create",
      );
      return { route, startRun, intakeCalls };
    }

    it("fresh Ready intake from the HTTP route produces one RESULT-bound read-only run", async () => {
      const { route, startRun, intakeCalls } = makeRouteWithAutoDispatch({
        truthLabel: "rust_wired",
        fridayConversationId: "conversation_from_rust_result",
        missionId: "mission_from_rust_result",
        workItemId: "work_from_rust_result",
        surfaceThreadId: "surface_lane_b",
        status: "ready",
        blockers: [],
        createdOrReady: true,
      });

      const response = await route.handler(
        makeCtx({
          principal: BOUND_PRINCIPAL,
          body: {
            ...VALID_INTAKE_BODY,
            fridayConversationId: "conversation_from_http_body",
            missionId: "mission_from_http_body",
            workItemId: "work_from_http_body",
            surfaceKind: "desktop",
            deliveryRoute: "desktop://hub-console/operations/route-auto",
            title: "Route auto dispatch",
            intent: "Drive one surface-shaped intake into the mission-bound run producer",
          },
        }) as never,
      );
      await Promise.resolve();
      await Promise.resolve();

      expect((response as { result: { status: string } }).result.status).toBe("ready");
      expect(intakeCalls).toHaveLength(1);
      expect(startRun).toHaveBeenCalledTimes(1);
      const dispatched = startRun.mock.calls[0][0];
      expect(dispatched).toMatchObject({
        task: "Route auto dispatch — Drive one surface-shaped intake into the mission-bound run producer",
        principalId: "owner_lane_b",
        providerId: "deepseek",
        model: "deepseek-v4-flash",
        constraints: { readOnly: true },
        allowedRustRouteTools: ["read_file", "list_dir", "stat_file", "search"],
        missionContext: {
          fridayConversationId: "conversation_from_rust_result",
          missionId: "mission_from_rust_result",
          workItemId: "work_from_rust_result",
        },
      });
      expect(dispatched.missionContext?.missionId).not.toBe("mission_from_http_body");
      expect(dispatched.missionContext?.workItemId).not.toBe("work_from_http_body");
    });

    it("blocked or clarification results return honestly and produce no bound run", async () => {
      for (const result of [
        {
          truthLabel: "rust_wired" as const,
          fridayConversationId: "conversation_lane_b",
          missionId: "mission_lane_b",
          surfaceThreadId: "surface_lane_b",
          status: "blocked",
          blockers: ["duplicate_open_mission"],
          createdOrReady: false,
        },
        {
          truthLabel: "rust_wired" as const,
          fridayConversationId: "conversation_lane_b",
          missionId: "mission_lane_b",
          surfaceThreadId: "surface_lane_b",
          status: "needs_clarification",
          blockers: [],
          createdOrReady: false,
          clarificationQuestions: ["What outcome should this mission optimize for?"],
        },
      ] satisfies FridayRustHubMissionIntakeResult[]) {
        const { route, startRun } = makeRouteWithAutoDispatch(result);
        const response = await route.handler(
          makeCtx({ principal: BOUND_PRINCIPAL, body: VALID_INTAKE_BODY }) as never,
        );
        await Promise.resolve();
        await Promise.resolve();

        expect((response as { result: { status: string } }).result.status).toBe(result.status);
        expect(startRun).not.toHaveBeenCalled();
      }
    });
  });

  describe("flag-ON: invalid body → typed 400, fail-closed (no dispatch)", () => {
    it("intake rejects a missing required field", async () => {
      const { dispatch, intake } = makeDispatch();
      const routes = createFridayMissionSpineRoutes({ workbench: null, disabledReason: null, dispatch });
      const route = findPost(routes, "mission.spine.intake.create");
      const { missionId: _omit, ...withoutMission } = VALID_INTAKE_BODY;
      let thrown: unknown = null;
      try {
        await route.handler(makeCtx({ principal: BOUND_PRINCIPAL, body: withoutMission }) as never);
      } catch (err) {
        thrown = err;
      }
      expect((thrown as FridayDomainError).code).toBe("MISSION_SPINE_DISPATCH_REQUEST_INVALID");
      expect((thrown as FridayDomainError).httpStatus).toBe(400);
      expect(JSON.stringify((thrown as FridayDomainError).details)).toContain("missionId_missing_or_empty");
      expect(intake).not.toHaveBeenCalled();
    });

    it("intake rejects invalid proofRequirements before dispatch", async () => {
      const { dispatch, intake } = makeDispatch();
      const routes = createFridayMissionSpineRoutes({ workbench: null, disabledReason: null, dispatch });
      const route = findPost(routes, "mission.spine.intake.create");
      let thrown: unknown = null;
      try {
        await route.handler(
          makeCtx({
            principal: BOUND_PRINCIPAL,
            body: { ...VALID_INTAKE_BODY, proofRequirements: [""] },
          }) as never,
        );
      } catch (err) {
        thrown = err;
      }
      expect((thrown as FridayDomainError).httpStatus).toBe(400);
      expect(JSON.stringify((thrown as FridayDomainError).details)).toContain("proofRequirements_invalid");
      expect(intake).not.toHaveBeenCalled();
    });

    it("lifecycle rejects a missing path missionId", async () => {
      const { dispatch, lifecycle } = makeDispatch();
      const routes = createFridayMissionSpineRoutes({ workbench: null, disabledReason: null, dispatch });
      const route = findPost(routes, "mission.spine.lifecycle.transition");
      let thrown: unknown = null;
      try {
        await route.handler(makeCtx({ principal: BOUND_PRINCIPAL, params: {}, body: VALID_LIFECYCLE_BODY }) as never);
      } catch (err) {
        thrown = err;
      }
      expect((thrown as FridayDomainError).httpStatus).toBe(400);
      expect(JSON.stringify((thrown as FridayDomainError).details)).toContain("missionId_missing_or_empty");
      expect(lifecycle).not.toHaveBeenCalled();
    });

    it("work-item rejects a proofless completed_with_proof at the edge (mirrors server invariant)", async () => {
      const { dispatch, workItem } = makeDispatch();
      const routes = createFridayMissionSpineRoutes({ workbench: null, disabledReason: null, dispatch });
      const route = findPost(routes, "mission.spine.workitem.status.transition");
      let thrown: unknown = null;
      try {
        await route.handler(
          makeCtx({
            principal: BOUND_PRINCIPAL,
            params: { workItemId: "work_from_path" },
            body: { targetStatus: "completed_with_proof", actorRef: "a", reason: "r" },
          }) as never,
        );
      } catch (err) {
        thrown = err;
      }
      expect((thrown as FridayDomainError).httpStatus).toBe(400);
      expect(JSON.stringify((thrown as FridayDomainError).details)).toContain(
        "proof_receipt_required_for_completion",
      );
      expect(workItem).not.toHaveBeenCalled();
    });

    it("route-control rejects malformed veto/override bodies before dispatch", async () => {
      const { dispatch, routeControl } = makeDispatch();
      const routes = createFridayMissionSpineRoutes({ workbench: null, disabledReason: null, dispatch });
      const route = findPost(routes, "mission.spine.routedecision.control");
      let thrown: unknown = null;
      try {
        await route.handler(
          makeCtx({
            principal: BOUND_PRINCIPAL,
            params: { decisionId: "route_decision_from_path" },
            body: { controlKind: "veto", overrideLane: "codex", actorRef: "a", reason: "r" },
          }) as never,
        );
      } catch (err) {
        thrown = err;
      }
      expect((thrown as FridayDomainError).httpStatus).toBe(400);
      expect(JSON.stringify((thrown as FridayDomainError).details)).toContain(
        "veto_cannot_carry_override_target",
      );
      expect(routeControl).not.toHaveBeenCalled();
    });
  });
});
