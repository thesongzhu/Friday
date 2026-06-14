import { describe, expect, it } from "vitest";

import { buildMissionContextWire } from "../../../../src/api/mission-spine/friday-rust-hub-agent-run-ws-sealed-client.js";

// (NS45-PR1 / M-4) `buildMissionContextWire` maps the TS-side first-class Mission handle onto the
// snake_case `MissionWorkItemContextWire` shape the Rust server decodes — or `undefined` when NO
// handle is given, so the AgentRunRequest envelope OMITS the whole `mission_context` key
// (byte-identity with the pre-NS45 request). Unlike `buildConstraintsWire` there is NO
// tightening/collapse: the Rust struct's three fields are ALL required, so a defined handle ALWAYS
// emits the full three-field object. This is presence-based (mirrors `session_id`).
//
// GOLDEN cross-check against the REAL Rust wire struct
// (rust-core/crates/friday-protocol/src/lib.rs):
//   - `pub struct MissionWorkItemContextWire` (lib.rs:294), `#[serde(... Serialize, Deserialize)]`
//     with NO `#[serde(rename_all)]` ⇒ field names serialize VERBATIM (already snake_case);
//   - `pub friday_conversation_id: String` (lib.rs:295)  — REQUIRED (not Option, no serde default);
//   - `pub mission_id: String`            (lib.rs:296)  — REQUIRED;
//   - `pub work_item_id: String`          (lib.rs:297)  — REQUIRED.
// The seam reads exactly these three off the handle:
//   - hub_server.rs:1696 `handle.friday_conversation_id`
//   - hub_server.rs:1697 `handle.mission_id`
//   - hub_server.rs:1698 `handle.work_item_id`
// The `AgentRunRequest` variant carries it as `mission_context: Option<MissionWorkItemContextWire>`
// (lib.rs:1383) with `#[serde(default, skip_serializing_if = "Option::is_none")]` (lib.rs:1382), so
// `None` ⇒ NO `mission_context` key on the wire (lib.rs round-trip asserts this at lib.rs:2590).
describe("buildMissionContextWire (NS45-PR1, snake_case wire mapping — golden cross-check)", () => {
  it("undefined input ⇒ undefined (no wire block — byte-identical pre-NS45 envelope)", () => {
    // ABSENT case: a handle-free request omits the whole `mission_context` key. The envelope
    // builder spreads `...(missionContextWire !== undefined ? { mission_context } : {})`, so an
    // `undefined` here produces NO key ⇒ the serialized envelope is byte-identical to today's.
    expect(buildMissionContextWire(undefined)).toBeUndefined();
  });

  it("a defined handle ⇒ the EXACT three-field snake_case golden wire object", () => {
    // PRESENT case: the emitted object must deep-equal this hand-written golden fixture, whose
    // keys + required set were cross-checked field-for-field against MissionWorkItemContextWire
    // (lib.rs:294-297) above. No extra keys, no missing keys, snake_case verbatim.
    const golden = {
      friday_conversation_id: "conv-7",
      mission_id: "mission-42",
      work_item_id: "work-item-9",
    };
    const wire = buildMissionContextWire({
      fridayConversationId: "conv-7",
      missionId: "mission-42",
      workItemId: "work-item-9",
    });
    expect(wire).toEqual(golden);
    // EXACT key set — no fabricated/extra fields, none of the three dropped (all are REQUIRED).
    expect(Object.keys(wire ?? {}).sort()).toEqual([
      "friday_conversation_id",
      "mission_id",
      "work_item_id",
    ]);
  });

  it("all three fields are emitted VERBATIM (no normalization the Rust side does not do)", () => {
    // Unlike constraints (trim/de-dup/drop-empty), the Mission handle is passed through verbatim:
    // the Rust struct does no normalization, so neither does TS. Values ride exactly as given.
    const wire = buildMissionContextWire({
      fridayConversationId: "  spaced-conv  ",
      missionId: "Mission-MixedCase",
      workItemId: "wi/with/slashes",
    });
    expect(wire).toEqual({
      friday_conversation_id: "  spaced-conv  ",
      mission_id: "Mission-MixedCase",
      work_item_id: "wi/with/slashes",
    });
  });
});
