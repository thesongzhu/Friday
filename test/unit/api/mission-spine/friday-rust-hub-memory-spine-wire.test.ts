import { describe, expect, it } from "vitest";

import {
  buildMemoryDecisionEnvelope,
  parseMemoryDecisionResult,
  type FridayRustHubMemoryDecisionRequest,
} from "../../../../src/api/mission-spine/friday-rust-hub-agent-run-ws-sealed-client.js";

// (Lane M) The memory-decision wire builder maps the TS request onto the EXACT snake_case
// `friday-protocol` `MemoryDecisionRequestWire` shape. CRITICAL: `Message::MemoryDecisionRequest`
// is a SINGLE-FIELD WRAPPER (`{ request: MemoryDecisionRequestWire }`) on an internally-tagged
// (`#[serde(tag = "kind")]`) `Message`, so serde NESTS the inner wire fields under a `request`
// key — they are NOT flat under `message`. A prior surface shipped a FLAT shape that failed
// `Envelope::decode` server-side (missing `request`) ⇒ 503 EVERY call. The GOLDEN cross-check
// below pins the byte-exact `{kind,request}` nesting against the EXACT shape the merged Rust
// round-trip test emits (friday-protocol/src/lib.rs:2126-2141 + 2158-2172, #753).

const REQUEST: FridayRustHubMemoryDecisionRequest = {
  memoryId: "mem-1",
  ownerPrincipal: "owner-1",
  decision: "confirm",
};

// GOLDEN fixture — cross-checked field-by-field against the Rust struct + round-trip test:
//   MemoryDecisionRequestWire { memory_id, owner_principal, decision }  (lib.rs:301-310)
//   Message::MemoryDecisionRequest { request: MemoryDecisionRequestWire }  (lib.rs:1295, tag="kind")
//   round-trip emits: {"kind":"MemoryDecisionRequest","request":{"memory_id":...,"owner_principal":...,"decision":...}}
//   (lib.rs:2158-2172 asserts "\"kind\":\"MemoryDecisionRequest\"" + "\"request\":{" + the snake_case fields)
const GOLDEN_MESSAGE = {
  kind: "MemoryDecisionRequest",
  request: {
    memory_id: "mem-1",
    owner_principal: "owner-1",
    decision: "confirm",
  },
} as const;

describe("buildMemoryDecisionEnvelope (MemoryDecisionRequestWire wire mapping)", () => {
  it("emits EXACTLY the golden {kind, request:{memory_id, owner_principal, decision}} envelope", () => {
    const env = buildMemoryDecisionEnvelope(REQUEST);
    // schema_version rides the SHARED `buildMissionEnvelope` constant (the same value every
    // mission-spine builder emits). NOTE: this is a TS-const, NOT a Rust cross-check — the Rust
    // `CURRENT_SCHEMA_VERSION` is 13 (lib.rs:53) while this TS constant is 12; the server's
    // `Envelope::decode` is a pure serde deser that does NOT enforce the field (no version check in
    // hub_agent_run_server), so a 12-tagged envelope is accepted — identical to the live mission-spine
    // path. The LOAD-BEARING golden is the {kind,request} body below, not this informational field.
    expect(env.schema_version).toBe(12);
    expect(env.msg_id).toBe("memory-decision-mem-1");
    expect(env.correlation_id).toBe("memory-decision-mem-1");

    const message = env.message as Record<string, unknown>;
    // DEEP-EQUAL the whole message to the golden fixture — the anti-mock-green core.
    expect(message).toEqual(GOLDEN_MESSAGE);
    // The wrapper key is `request` (NOT flat fields under `message`) — flat-shape 503 regression guard.
    expect(Object.keys(message).sort()).toEqual(["kind", "request"]);
    const request = message.request as Record<string, unknown>;
    // NO camelCase leak, NO extra/missing key.
    expect(Object.keys(request).sort()).toEqual(["decision", "memory_id", "owner_principal"]);
    expect("memoryId" in request).toBe(false);
    expect("ownerPrincipal" in request).toBe(false);
  });

  it("carries the reject decision verbatim (the second valid token)", () => {
    const message = buildMemoryDecisionEnvelope({ ...REQUEST, decision: "reject" }).message as Record<
      string,
      unknown
    >;
    const request = message.request as Record<string, unknown>;
    expect(request.decision).toBe("reject");
  });
});

describe("parseMemoryDecisionResult (MemoryDecisionResultWire wire mapping)", () => {
  it("unwraps the nested `result` and surfaces the refs-only result with the rust_wired label", () => {
    const parsed = parseMemoryDecisionResult({
      kind: "MemoryDecisionResult",
      result: {
        memory_id: "mem-1",
        state: "confirmed",
        status: "confirmed",
        recallable: true,
      },
    });
    expect(parsed).toEqual({
      truthLabel: "rust_wired",
      memoryId: "mem-1",
      state: "confirmed",
      status: "confirmed",
      recallable: true,
    });
  });

  it("surfaces a `blocked` outcome WITH the coarse blocker (recallable=false is a VALID value)", () => {
    const parsed = parseMemoryDecisionResult({
      kind: "MemoryDecisionResult",
      result: {
        memory_id: "mem-1",
        state: "rejected",
        status: "blocked",
        blocker: "owner_scope_mismatch",
        recallable: false,
      },
    });
    expect(parsed).toEqual({
      truthLabel: "rust_wired",
      memoryId: "mem-1",
      state: "rejected",
      status: "blocked",
      blocker: "owner_scope_mismatch",
      recallable: false,
    });
  });

  it("omits `blocker` when absent (skip_serializing_if Option::is_none) — never fabricated", () => {
    const parsed = parseMemoryDecisionResult({
      kind: "MemoryDecisionResult",
      result: { memory_id: "mem-1", state: "confirmed", status: "confirmed", recallable: true },
    });
    expect(parsed && "blocker" in parsed).toBe(false);
  });

  it("fails closed (undefined) on a missing/ill-typed result wrapper or required ref", () => {
    // No `result` wrapper at all.
    expect(parseMemoryDecisionResult({ kind: "MemoryDecisionResult" })).toBeUndefined();
    // Missing memory_id.
    expect(
      parseMemoryDecisionResult({ result: { state: "confirmed", status: "confirmed", recallable: true } }),
    ).toBeUndefined();
    // recallable absent → not a boolean → fail closed (NEVER coerced to false).
    expect(
      parseMemoryDecisionResult({ result: { memory_id: "m", state: "confirmed", status: "confirmed" } }),
    ).toBeUndefined();
    // recallable present but ill-typed (string) → fail closed.
    expect(
      parseMemoryDecisionResult({
        result: { memory_id: "m", state: "confirmed", status: "confirmed", recallable: "true" },
      }),
    ).toBeUndefined();
  });
});
