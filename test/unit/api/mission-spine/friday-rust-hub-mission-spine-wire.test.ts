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
// `friday-protocol` wire shapes. CRITICAL (HOLE-1): each `Message::Mission*Request`/`*Result`
// variant is a SINGLE-FIELD WRAPPER (`{ request: …Wire }` / `{ result: …Wire }`) on an
// internally-tagged (`#[serde(tag = "kind")]`) enum, so serde NESTS the inner wire fields under a
// `request`/`result` key — they are NOT flat under `message`. A flat shape fails `Envelope::decode`
// server-side (missing `request`) and `parse*Result` reading `fields.X` instead of `fields.result.X`
// ⇒ undefined ⇒ 503. Option fields use conditional-spread (absent ⇒ key OMITTED, byte-clean). The
// parsers are fail-closed: a missing/ill-typed `result` wrapper OR a missing required ref ⇒
// `undefined`. These carry NO `auth_proof`/`forwarded_principal` — the sealed session is the channel
// auth. The TS↔Rust nesting is PINNED by the golden cross-check at the bottom of this file (the
// EXACT bytes the Rust `Envelope::encode` round-trip test emits for these messages).

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
  it("nests the required fields under `request` + kind, omitting all four optionals when absent", () => {
    const env = buildMissionIntakeEnvelope(FULL_INTAKE);
    expect(env.schema_version).toBe(12);
    expect(env.msg_id).toBe("mission-intake-mission_x");
    expect(env.correlation_id).toBe("mission-intake-mission_x");
    const message = env.message as Record<string, unknown>;
    expect(message.kind).toBe("MissionIntakeRequest");
    // The wrapper key is `request` (NOT flat fields under `message`).
    expect(Object.keys(message).sort()).toEqual(["kind", "request"]);
    const request = message.request as Record<string, unknown>;
    expect(request).toEqual({
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
    expect("target_provider_or_agent" in request).toBe(false);
    expect("capability_id" in request).toBe(false);
    expect("body_ref" in request).toBe(false);
    expect("includes_sensitive_context" in request).toBe(false);
  });

  it("emits the optionals (snake_case, nested under request) when present; bool only when true", () => {
    const message = buildMissionIntakeEnvelope({
      ...FULL_INTAKE,
      targetProviderOrAgent: "deepseek-v4",
      capabilityId: "cap_x",
      bodyRef: "body://ref",
      includesSensitiveContext: true,
    }).message as Record<string, unknown>;
    const request = message.request as Record<string, unknown>;
    expect(request.target_provider_or_agent).toBe("deepseek-v4");
    expect(request.capability_id).toBe("cap_x");
    expect(request.body_ref).toBe("body://ref");
    expect(request.includes_sensitive_context).toBe(true);
  });

  it("never emits includes_sensitive_context when false (matches the Rust serde default)", () => {
    const message = buildMissionIntakeEnvelope({
      ...FULL_INTAKE,
      includesSensitiveContext: false,
    }).message as Record<string, unknown>;
    const request = message.request as Record<string, unknown>;
    expect("includes_sensitive_context" in request).toBe(false);
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
  it("nests the required fields under `request`, omitting proof_ref / merged_into_mission_id when absent", () => {
    const env = buildMissionLifecycleEnvelope(FULL_LIFECYCLE);
    expect(env.msg_id).toBe("mission-lifecycle-mission_x");
    const message = env.message as Record<string, unknown>;
    expect(message.kind).toBe("MissionLifecycleRequest");
    expect(Object.keys(message).sort()).toEqual(["kind", "request"]);
    const request = message.request as Record<string, unknown>;
    expect(request).toEqual({
      friday_conversation_id: "conversation_x",
      mission_id: "mission_x",
      target_status: "queued",
      actor_ref: "actor_x",
      reason: "advance",
    });
    expect("proof_ref" in request).toBe(false);
    expect("merged_into_mission_id" in request).toBe(false);
  });

  it("emits proof_ref + merged_into_mission_id (nested) when present", () => {
    const message = buildMissionLifecycleEnvelope({
      ...FULL_LIFECYCLE,
      proofRef: "proof://ref",
      mergedIntoMissionId: "mission_y",
    }).message as Record<string, unknown>;
    const request = message.request as Record<string, unknown>;
    expect(request.proof_ref).toBe("proof://ref");
    expect(request.merged_into_mission_id).toBe("mission_y");
  });
});

const FULL_WORK_ITEM: FridayRustHubWorkItemStatusRequest = {
  workItemId: "work_x",
  targetStatus: "ready_to_dispatch",
  actorRef: "actor_x",
  reason: "stage",
};

describe("buildWorkItemStatusEnvelope (WorkItemStatusRequestWire wire mapping)", () => {
  it("nests the required fields under `request`, omitting proof_receipt when absent", () => {
    const env = buildWorkItemStatusEnvelope(FULL_WORK_ITEM);
    expect(env.msg_id).toBe("work-item-status-work_x");
    const message = env.message as Record<string, unknown>;
    expect(message.kind).toBe("WorkItemStatusRequest");
    expect(Object.keys(message).sort()).toEqual(["kind", "request"]);
    const request = message.request as Record<string, unknown>;
    expect(request).toEqual({
      work_item_id: "work_x",
      target_status: "ready_to_dispatch",
      actor_ref: "actor_x",
      reason: "stage",
    });
    expect("proof_receipt" in request).toBe(false);
  });

  it("emits proof_receipt (nested) when present (the completion path)", () => {
    const message = buildWorkItemStatusEnvelope({
      ...FULL_WORK_ITEM,
      targetStatus: "completed_with_proof",
      proofReceipt: "proof://receipt",
    }).message as Record<string, unknown>;
    const request = message.request as Record<string, unknown>;
    expect(request.proof_receipt).toBe("proof://receipt");
  });
});

describe("parseMissionIntakeResult (fail-closed refs-only, NESTED result)", () => {
  // The parser is handed the whole `message` object: `{kind, result:{…refs…}}`.
  const valid = {
    result: {
      friday_conversation_id: "conversation_x",
      mission_id: "mission_x",
      surface_thread_id: "surface_x",
      status: "ready",
      blockers: [],
      created_or_ready: true,
    },
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
      result: {
        ...valid.result,
        work_item_id: "work_x",
        duplicate_mission_id: "mission_dup",
        duplicate_work_item_id: "work_dup",
      },
    });
    expect(withOptionals?.workItemId).toBe("work_x");
    expect(withOptionals?.duplicateMissionId).toBe("mission_dup");
    expect(withOptionals?.duplicateWorkItemId).toBe("work_dup");
  });

  it("does NOT surface clarificationQuestions when the field is absent (existing ready/blocked payloads)", () => {
    // Backward-compat: a payload with no clarification_questions parses fine and omits the field.
    expect(parseMissionIntakeResult(valid)).not.toHaveProperty("clarificationQuestions");
    // An empty array is treated as absent (the Rust wire skips it when empty) — still omitted.
    expect(
      parseMissionIntakeResult({ result: { ...valid.result, clarification_questions: [] } }),
    ).not.toHaveProperty("clarificationQuestions");
  });

  it("surfaces clarificationQuestions for a needs_clarification result (the DARK clarification arm)", () => {
    const clarified = parseMissionIntakeResult({
      result: {
        ...valid.result,
        status: "needs_clarification",
        work_item_id: undefined,
        created_or_ready: false,
        clarification_questions: [
          "What exact outcome should this skill deliver for the user?",
          "What inputs, tools, or systems should it use or avoid?",
        ],
      },
    });
    expect(clarified?.status).toBe("needs_clarification");
    expect(clarified?.createdOrReady).toBe(false);
    expect(clarified?.workItemId).toBeUndefined();
    expect(clarified?.clarificationQuestions).toEqual([
      "What exact outcome should this skill deliver for the user?",
      "What inputs, tools, or systems should it use or avoid?",
    ]);
  });

  it("ignores an ill-typed clarification_questions (non-array / non-string entries) without failing the parse", () => {
    // NO-DEGRADE: a malformed clarification_questions must NOT bury the whole result under a 503 —
    // the field is simply omitted (never fabricated), the rest of the refs still parse.
    const nonArray = parseMissionIntakeResult({
      result: { ...valid.result, clarification_questions: "oops" },
    });
    expect(nonArray).toBeDefined();
    expect(nonArray).not.toHaveProperty("clarificationQuestions");
    const nonString = parseMissionIntakeResult({
      result: { ...valid.result, clarification_questions: ["ok", 7] },
    });
    expect(nonString).toBeDefined();
    expect(nonString).not.toHaveProperty("clarificationQuestions");
  });

  it("fails closed (undefined) on a missing required ref or ill-typed fields", () => {
    expect(parseMissionIntakeResult({ result: { ...valid.result, mission_id: "" } })).toBeUndefined();
    expect(parseMissionIntakeResult({ result: { ...valid.result, created_or_ready: "yes" } })).toBeUndefined();
    expect(parseMissionIntakeResult({ result: { ...valid.result, blockers: [1, 2] } })).toBeUndefined();
    expect(parseMissionIntakeResult({ result: {} })).toBeUndefined();
  });

  it("fails closed (no throw) on a missing/ill-typed `result` wrapper — the flat (pre-fix) shape", () => {
    // The flat pre-fix shape (refs directly under message) MUST fail closed, never throw — parse()
    // runs OUTSIDE the inbound try/catch, so a thrown TypeError would not be a clean 503.
    expect(parseMissionIntakeResult(valid.result)).toBeUndefined();
    expect(parseMissionIntakeResult({})).toBeUndefined();
    expect(parseMissionIntakeResult({ result: null as unknown as Record<string, unknown> })).toBeUndefined();
    expect(parseMissionIntakeResult({ result: [] as unknown as Record<string, unknown> })).toBeUndefined();
  });
});

describe("parseMissionLifecycleResult (fail-closed refs-only, NESTED result)", () => {
  const valid = {
    result: {
      friday_conversation_id: "conversation_x",
      mission_id: "mission_x",
      previous_status: "ready",
      status: "queued",
      actor_ref: "actor_x",
      reason: "advance",
      active_mission_ids: ["mission_x"],
      updated_at_ms: 1700000000000,
    },
  };

  it("parses a valid result + present optionals", () => {
    const parsed = parseMissionLifecycleResult({
      result: { ...valid.result, proof_ref: "proof://r", merged_into_mission_id: "mission_y" },
    });
    expect(parsed?.status).toBe("queued");
    expect(parsed?.activeMissionIds).toEqual(["mission_x"]);
    expect(parsed?.updatedAtMs).toBe(1700000000000);
    expect(parsed?.proofRef).toBe("proof://r");
    expect(parsed?.mergedIntoMissionId).toBe("mission_y");
  });

  it("fails closed on a missing required ref or ill-typed updated_at_ms / list", () => {
    expect(parseMissionLifecycleResult({ result: { ...valid.result, status: "" } })).toBeUndefined();
    expect(parseMissionLifecycleResult({ result: { ...valid.result, updated_at_ms: "x" } })).toBeUndefined();
    expect(parseMissionLifecycleResult({ result: { ...valid.result, active_mission_ids: "nope" } })).toBeUndefined();
  });

  it("fails closed (no throw) on a missing `result` wrapper (the flat pre-fix shape)", () => {
    expect(parseMissionLifecycleResult(valid.result)).toBeUndefined();
    expect(parseMissionLifecycleResult({})).toBeUndefined();
  });
});

describe("parseWorkItemStatusResult (fail-closed refs-only, count not raw refs, NESTED result)", () => {
  const valid = {
    result: {
      work_item_id: "work_x",
      mission_id: "mission_x",
      previous_status: "ready_to_dispatch",
      status: "completed_with_proof",
      actor_ref: "actor_x",
      reason: "done",
      proof_receipt_count: 2,
      updated_at_ms: 1700000000000,
    },
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
    expect(parseWorkItemStatusResult({ result: { ...valid.result, work_item_id: "" } })).toBeUndefined();
    expect(parseWorkItemStatusResult({ result: { ...valid.result, reason: "" } })).toBeUndefined();
    expect(parseWorkItemStatusResult({ result: { ...valid.result, proof_receipt_count: "two" } })).toBeUndefined();
    expect(parseWorkItemStatusResult({ result: { ...valid.result, updated_at_ms: undefined } })).toBeUndefined();
  });

  it("fails closed (no throw) on a missing `result` wrapper (the flat pre-fix shape)", () => {
    expect(parseWorkItemStatusResult(valid.result)).toBeUndefined();
    expect(parseWorkItemStatusResult({})).toBeUndefined();
  });
});

// ─── TS↔Rust GOLDEN CROSS-CHECK (the real fix for the mock-green trap) ───────
//
// These are the EXACT bytes the Rust `Envelope::encode` round-trip emits for the three Mission
// `*Request`/`*Result` variants, captured VERBATIM from `friday-protocol`'s round-trip test data
// (`rust-core/crates/friday-protocol/src/lib.rs`, via `Envelope::new("m1", 1000, msg)
// .with_correlation("c1").encode()`). They prove the on-wire NESTING + key names that a pure
// TS-side unit test (mock both halves) cannot — if the Rust enum shape changes, the cross-check
// breaks and forces a re-capture.
//
// What is asserted (and what is NOT):
//  - We `JSON.parse` the Rust JSON and `toEqual` the `message.request`/`message.result` SUB-OBJECT
//    against what the TS builder emits / what the TS parser consumes. SUB-OBJECT (not full-envelope
//    byte) comparison is deliberate: the outer envelope cannot be byte-equal (`sent_at = Date.now()`,
//    `msg_id` is per-entity not "m1", and TS `SCHEMA_VERSION` is 12 vs the current Rust 13 — all
//    orthogonal to the wire-NESTING bug under repair). The sub-object equality is exactly the bug's
//    surface: nesting depth + key names + types.
//  - `includes_sensitive_context`: Rust has `#[serde(default)]` WITHOUT `skip_serializing_if`, so it
//    is ALWAYS emitted (`false` when unset); TS omits-when-false (serde `default` accepts the
//    omission — interop-safe). To keep the BUILD cross-check a clean deep-equal we capture the intake
//    fixture with the bool TRUE, so both sides emit it. (The omit↔false asymmetry for the false case
//    is covered by the dedicated build unit test above.)

const RUST_INTAKE_REQUEST_JSON =
  '{"schema_version":13,"msg_id":"m1","correlation_id":"c1","sent_at":1000,"message":{"kind":"MissionIntakeRequest","request":{"friday_conversation_id":"conversation_x","owner_principal":"owner_x","surface_thread_id":"surface_x","surface_kind":"mobile","delivery_route":"in_app","visibility_policy":"owner_only","mission_id":"mission_x","work_item_id":"work_x","title":"Title","intent":"Intent","lane":"deepseek","target_provider_or_agent":"deepseek-v4","capability_id":"cap_x","body_ref":"body://ref","includes_sensitive_context":true}}}';
const RUST_INTAKE_RESULT_JSON =
  '{"schema_version":13,"msg_id":"m1","correlation_id":"c1","sent_at":1000,"message":{"kind":"MissionIntakeResult","result":{"friday_conversation_id":"conversation_x","mission_id":"mission_x","work_item_id":"work_x","surface_thread_id":"surface_x","status":"ready","blockers":[],"duplicate_mission_id":"mission_dup","duplicate_work_item_id":"work_dup","created_or_ready":true}}}';
const RUST_LIFECYCLE_REQUEST_JSON =
  '{"schema_version":13,"msg_id":"m1","correlation_id":"c1","sent_at":1000,"message":{"kind":"MissionLifecycleRequest","request":{"friday_conversation_id":"conversation_x","mission_id":"mission_x","target_status":"queued","actor_ref":"actor_x","reason":"advance","proof_ref":"proof://ref","merged_into_mission_id":"mission_y"}}}';
const RUST_LIFECYCLE_RESULT_JSON =
  '{"schema_version":13,"msg_id":"m1","correlation_id":"c1","sent_at":1000,"message":{"kind":"MissionLifecycleResult","result":{"friday_conversation_id":"conversation_x","mission_id":"mission_x","previous_status":"ready","status":"queued","actor_ref":"actor_x","reason":"advance","proof_ref":"proof://r","merged_into_mission_id":"mission_y","active_mission_ids":["mission_x"],"updated_at_ms":1700000000000}}}';
const RUST_WORK_ITEM_REQUEST_JSON =
  '{"schema_version":13,"msg_id":"m1","correlation_id":"c1","sent_at":1000,"message":{"kind":"WorkItemStatusRequest","request":{"work_item_id":"work_x","target_status":"completed_with_proof","actor_ref":"actor_x","reason":"stage","proof_receipt":"proof://receipt"}}}';
const RUST_WORK_ITEM_RESULT_JSON =
  '{"schema_version":13,"msg_id":"m1","correlation_id":"c1","sent_at":1000,"message":{"kind":"WorkItemStatusResult","result":{"work_item_id":"work_x","mission_id":"mission_x","previous_status":"ready_to_dispatch","status":"completed_with_proof","actor_ref":"actor_x","reason":"done","proof_receipt_count":2,"updated_at_ms":1700000000000}}}';

/** Pull the inner `message.<key>` sub-object out of a captured Rust envelope JSON string. */
function rustInner(json: string, key: "request" | "result"): Record<string, unknown> {
  const env = JSON.parse(json) as { message: Record<string, unknown> };
  return env.message[key] as Record<string, unknown>;
}

describe("TS↔Rust golden cross-check: build* emits BYTE-COMPATIBLE nesting the Rust server decodes", () => {
  it("MissionIntakeRequest: TS `message.request` deep-equals the Rust-emitted `request`", () => {
    const tsRequest = (
      buildMissionIntakeEnvelope({
        ...FULL_INTAKE,
        targetProviderOrAgent: "deepseek-v4",
        capabilityId: "cap_x",
        bodyRef: "body://ref",
        includesSensitiveContext: true, // emit the bool so both sides carry it (see header note).
      }).message as Record<string, unknown>
    ).request;
    expect(tsRequest).toEqual(rustInner(RUST_INTAKE_REQUEST_JSON, "request"));
  });

  it("MissionLifecycleRequest: TS `message.request` deep-equals the Rust-emitted `request`", () => {
    const tsRequest = (
      buildMissionLifecycleEnvelope({
        ...FULL_LIFECYCLE,
        proofRef: "proof://ref",
        mergedIntoMissionId: "mission_y",
      }).message as Record<string, unknown>
    ).request;
    expect(tsRequest).toEqual(rustInner(RUST_LIFECYCLE_REQUEST_JSON, "request"));
  });

  it("WorkItemStatusRequest: TS `message.request` deep-equals the Rust-emitted `request`", () => {
    const tsRequest = (
      buildWorkItemStatusEnvelope({
        ...FULL_WORK_ITEM,
        targetStatus: "completed_with_proof",
        reason: "stage",
        proofReceipt: "proof://receipt",
      }).message as Record<string, unknown>
    ).request;
    expect(tsRequest).toEqual(rustInner(RUST_WORK_ITEM_REQUEST_JSON, "request"));
  });
});

describe("TS↔Rust golden cross-check: parse*Result CONSUMES the exact Rust-emitted result JSON", () => {
  it("parseMissionIntakeResult consumes the Rust `MissionIntakeResult` envelope's `message`", () => {
    const message = (JSON.parse(RUST_INTAKE_RESULT_JSON) as { message: Record<string, unknown> }).message;
    const parsed = parseMissionIntakeResult(message);
    expect(parsed).toEqual({
      truthLabel: "rust_wired",
      fridayConversationId: "conversation_x",
      missionId: "mission_x",
      workItemId: "work_x",
      surfaceThreadId: "surface_x",
      status: "ready",
      blockers: [],
      duplicateMissionId: "mission_dup",
      duplicateWorkItemId: "work_dup",
      createdOrReady: true,
    });
  });

  it("parseMissionLifecycleResult consumes the Rust `MissionLifecycleResult` envelope's `message`", () => {
    const message = (JSON.parse(RUST_LIFECYCLE_RESULT_JSON) as { message: Record<string, unknown> }).message;
    const parsed = parseMissionLifecycleResult(message);
    expect(parsed).toEqual({
      truthLabel: "rust_wired",
      fridayConversationId: "conversation_x",
      missionId: "mission_x",
      previousStatus: "ready",
      status: "queued",
      actorRef: "actor_x",
      reason: "advance",
      proofRef: "proof://r",
      mergedIntoMissionId: "mission_y",
      activeMissionIds: ["mission_x"],
      updatedAtMs: 1700000000000,
    });
  });

  it("parseWorkItemStatusResult consumes the Rust `WorkItemStatusResult` envelope's `message`", () => {
    const message = (JSON.parse(RUST_WORK_ITEM_RESULT_JSON) as { message: Record<string, unknown> }).message;
    const parsed = parseWorkItemStatusResult(message);
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
});
