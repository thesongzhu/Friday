import { describe, expect, it } from "vitest";

import {
  buildMissionIntakeEnvelope,
  buildMissionLifecycleEnvelope,
  buildWorkItemStatusEnvelope,
  parseMissionIntakeResult,
  parseMissionLifecycleResult,
  parseWorkItemStatusResult,
  type FridayRustHubMissionIntakeRequest,
  type FridayRustHubMissionLifecycleRequest,
  type FridayRustHubWorkItemStatusRequest,
} from "../../../../src/api/mission-spine/friday-rust-hub-agent-run-ws-sealed-client.js";

// (Lane B) The mission-spine wire builders map the TS-side requests onto the EXACT snake_case
// `friday-protocol` wire shapes (`MissionIntakeRequestWire` / `MissionLifecycleRequestWire` /
// `WorkItemStatusRequestWire`). Option fields use conditional-spread (absent ⇒ key OMITTED,
// byte-clean), mirroring `buildConstraintsWire`. The parsers are fail-closed: a missing/ill-typed
// REQUIRED ref ⇒ `undefined` (the round-trip then fails closed). These carry NO `auth_proof` /
// `forwarded_principal` — the sealed session is the channel auth.

const FULL_INTAKE: FridayRustHubMissionIntakeRequest = {
  fridayConversationId: "conversation_x",
  ownerPrincipal: "owner_x",
  surfaceThreadId: "surface_x",
  surfaceKind: "mobile",
  deliveryRoute: "in_app",
  visibilityPolicy: "owner_only",
  missionId: "mission_x",
  workItemId: "work_x",
  title: "Title",
  intent: "Intent",
  lane: "deepseek",
};

describe("buildMissionIntakeEnvelope (MissionIntakeRequestWire wire mapping)", () => {
  it("emits the required fields + kind, omitting all four optionals when absent", () => {
    const env = buildMissionIntakeEnvelope(FULL_INTAKE);
    expect(env.schema_version).toBe(12);
    expect(env.msg_id).toBe("mission-intake-mission_x");
    expect(env.correlation_id).toBe("mission-intake-mission_x");
    const message = env.message as Record<string, unknown>;
    expect(message).toEqual({
      kind: "MissionIntakeRequest",
      friday_conversation_id: "conversation_x",
      owner_principal: "owner_x",
      surface_thread_id: "surface_x",
      surface_kind: "mobile",
      delivery_route: "in_app",
      visibility_policy: "owner_only",
      mission_id: "mission_x",
      work_item_id: "work_x",
      title: "Title",
      intent: "Intent",
      lane: "deepseek",
    });
    // Optionals OMITTED entirely (not null/undefined).
    expect("target_provider_or_agent" in message).toBe(false);
    expect("capability_id" in message).toBe(false);
    expect("body_ref" in message).toBe(false);
    expect("includes_sensitive_context" in message).toBe(false);
  });

  it("emits the optionals (snake_case) when present; bool only when true", () => {
    const message = buildMissionIntakeEnvelope({
      ...FULL_INTAKE,
      targetProviderOrAgent: "deepseek-v4",
      capabilityId: "cap_x",
      bodyRef: "body://ref",
      includesSensitiveContext: true,
    }).message as Record<string, unknown>;
    expect(message.target_provider_or_agent).toBe("deepseek-v4");
    expect(message.capability_id).toBe("cap_x");
    expect(message.body_ref).toBe("body://ref");
    expect(message.includes_sensitive_context).toBe(true);
  });

  it("never emits includes_sensitive_context when false (matches the Rust serde default)", () => {
    const message = buildMissionIntakeEnvelope({
      ...FULL_INTAKE,
      includesSensitiveContext: false,
    }).message as Record<string, unknown>;
    expect("includes_sensitive_context" in message).toBe(false);
  });
});

const FULL_LIFECYCLE: FridayRustHubMissionLifecycleRequest = {
  fridayConversationId: "conversation_x",
  missionId: "mission_x",
  targetStatus: "queued",
  actorRef: "actor_x",
  reason: "advance",
};

describe("buildMissionLifecycleEnvelope (MissionLifecycleRequestWire wire mapping)", () => {
  it("emits the required fields, omitting proof_ref / merged_into_mission_id when absent", () => {
    const env = buildMissionLifecycleEnvelope(FULL_LIFECYCLE);
    expect(env.msg_id).toBe("mission-lifecycle-mission_x");
    const message = env.message as Record<string, unknown>;
    expect(message).toEqual({
      kind: "MissionLifecycleRequest",
      friday_conversation_id: "conversation_x",
      mission_id: "mission_x",
      target_status: "queued",
      actor_ref: "actor_x",
      reason: "advance",
    });
    expect("proof_ref" in message).toBe(false);
    expect("merged_into_mission_id" in message).toBe(false);
  });

  it("emits proof_ref + merged_into_mission_id when present", () => {
    const message = buildMissionLifecycleEnvelope({
      ...FULL_LIFECYCLE,
      proofRef: "proof://ref",
      mergedIntoMissionId: "mission_y",
    }).message as Record<string, unknown>;
    expect(message.proof_ref).toBe("proof://ref");
    expect(message.merged_into_mission_id).toBe("mission_y");
  });
});

const FULL_WORK_ITEM: FridayRustHubWorkItemStatusRequest = {
  workItemId: "work_x",
  targetStatus: "ready_to_dispatch",
  actorRef: "actor_x",
  reason: "stage",
};

describe("buildWorkItemStatusEnvelope (WorkItemStatusRequestWire wire mapping)", () => {
  it("emits the required fields, omitting proof_receipt when absent", () => {
    const env = buildWorkItemStatusEnvelope(FULL_WORK_ITEM);
    expect(env.msg_id).toBe("work-item-status-work_x");
    const message = env.message as Record<string, unknown>;
    expect(message).toEqual({
      kind: "WorkItemStatusRequest",
      work_item_id: "work_x",
      target_status: "ready_to_dispatch",
      actor_ref: "actor_x",
      reason: "stage",
    });
    expect("proof_receipt" in message).toBe(false);
  });

  it("emits proof_receipt when present (the completion path)", () => {
    const message = buildWorkItemStatusEnvelope({
      ...FULL_WORK_ITEM,
      targetStatus: "completed_with_proof",
      proofReceipt: "proof://receipt",
    }).message as Record<string, unknown>;
    expect(message.proof_receipt).toBe("proof://receipt");
  });
});

describe("parseMissionIntakeResult (fail-closed refs-only)", () => {
  const valid = {
    friday_conversation_id: "conversation_x",
    mission_id: "mission_x",
    surface_thread_id: "surface_x",
    status: "ready",
    blockers: [],
    created_or_ready: true,
  };

  it("parses a valid result, surfacing only present optionals", () => {
    expect(parseMissionIntakeResult(valid)).toEqual({
      truthLabel: "rust_wired",
      fridayConversationId: "conversation_x",
      missionId: "mission_x",
      surfaceThreadId: "surface_x",
      status: "ready",
      blockers: [],
      createdOrReady: true,
    });
    const withOptionals = parseMissionIntakeResult({
      ...valid,
      work_item_id: "work_x",
      duplicate_mission_id: "mission_dup",
      duplicate_work_item_id: "work_dup",
    });
    expect(withOptionals?.workItemId).toBe("work_x");
    expect(withOptionals?.duplicateMissionId).toBe("mission_dup");
    expect(withOptionals?.duplicateWorkItemId).toBe("work_dup");
  });

  it("fails closed (undefined) on a missing required ref or ill-typed fields", () => {
    expect(parseMissionIntakeResult({ ...valid, mission_id: "" })).toBeUndefined();
    expect(parseMissionIntakeResult({ ...valid, created_or_ready: "yes" })).toBeUndefined();
    expect(parseMissionIntakeResult({ ...valid, blockers: [1, 2] })).toBeUndefined();
    expect(parseMissionIntakeResult({})).toBeUndefined();
  });
});

describe("parseMissionLifecycleResult (fail-closed refs-only)", () => {
  const valid = {
    friday_conversation_id: "conversation_x",
    mission_id: "mission_x",
    previous_status: "ready",
    status: "queued",
    actor_ref: "actor_x",
    reason: "advance",
    active_mission_ids: ["mission_x"],
    updated_at_ms: 1700000000000,
  };

  it("parses a valid result + present optionals", () => {
    const parsed = parseMissionLifecycleResult({ ...valid, proof_ref: "proof://r", merged_into_mission_id: "mission_y" });
    expect(parsed?.status).toBe("queued");
    expect(parsed?.activeMissionIds).toEqual(["mission_x"]);
    expect(parsed?.updatedAtMs).toBe(1700000000000);
    expect(parsed?.proofRef).toBe("proof://r");
    expect(parsed?.mergedIntoMissionId).toBe("mission_y");
  });

  it("fails closed on a missing required ref or ill-typed updated_at_ms / list", () => {
    expect(parseMissionLifecycleResult({ ...valid, status: "" })).toBeUndefined();
    expect(parseMissionLifecycleResult({ ...valid, updated_at_ms: "x" })).toBeUndefined();
    expect(parseMissionLifecycleResult({ ...valid, active_mission_ids: "nope" })).toBeUndefined();
  });
});

describe("parseWorkItemStatusResult (fail-closed refs-only, count not raw refs)", () => {
  const valid = {
    work_item_id: "work_x",
    mission_id: "mission_x",
    previous_status: "ready_to_dispatch",
    status: "completed_with_proof",
    actor_ref: "actor_x",
    reason: "done",
    proof_receipt_count: 2,
    updated_at_ms: 1700000000000,
  };

  it("parses a valid result, surfacing the proof RECEIPT COUNT (never raw refs)", () => {
    const parsed = parseWorkItemStatusResult(valid);
    expect(parsed).toEqual({
      truthLabel: "rust_wired",
      workItemId: "work_x",
      missionId: "mission_x",
      previousStatus: "ready_to_dispatch",
      status: "completed_with_proof",
      actorRef: "actor_x",
      reason: "done",
      proofReceiptCount: 2,
      updatedAtMs: 1700000000000,
    });
  });

  it("fails closed on a missing required ref or ill-typed count", () => {
    expect(parseWorkItemStatusResult({ ...valid, work_item_id: "" })).toBeUndefined();
    expect(parseWorkItemStatusResult({ ...valid, reason: "" })).toBeUndefined();
    expect(parseWorkItemStatusResult({ ...valid, proof_receipt_count: "two" })).toBeUndefined();
    expect(parseWorkItemStatusResult({ ...valid, updated_at_ms: undefined })).toBeUndefined();
  });
});
