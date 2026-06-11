import { describe, expect, it } from "vitest";

import { buildConstraintsWire } from "../../../../src/api/mission-spine/friday-rust-hub-agent-run-ws-sealed-client.js";

// (A1 run-controls) `buildConstraintsWire` maps the TS-side per-run constraints onto the
// snake_case `AgentRunConstraintsWire` shape the Rust server decodes — or `undefined` when
// NOTHING tightens, so the caller OMITS the whole `constraints` key (byte-identity with the
// pre-A1 request). The Rust serde discipline is mirrored EXACTLY:
//   - `read_only` emitted ONLY when true (Rust `#[serde(default)]` ⇒ absent deserializes false);
//   - `disabled_tools` emitted ONLY when the normalized set is non-empty (Rust skip-if-empty);
//   - `max_turns` emitted ONLY when a finite positive integer cap is given (Rust skip-if-none).
describe("buildConstraintsWire (A1 run-controls, snake_case wire mapping)", () => {
  it("undefined input ⇒ undefined (no wire block — byte-identical pre-A1)", () => {
    expect(buildConstraintsWire(undefined)).toBeUndefined();
  });

  it("an all-absent / non-tightening object ⇒ undefined (no wire key emitted)", () => {
    expect(buildConstraintsWire({})).toBeUndefined();
    expect(buildConstraintsWire({ readOnly: false })).toBeUndefined();
    expect(buildConstraintsWire({ disabledTools: [] })).toBeUndefined();
    // whitespace/empty entries normalize away to an empty set ⇒ no wire key
    expect(buildConstraintsWire({ disabledTools: ["", "   "] })).toBeUndefined();
    // a non-positive / non-integer cap is not a real tightening ⇒ no wire key
    expect(buildConstraintsWire({ maxTurns: 0 })).toBeUndefined();
    expect(buildConstraintsWire({ maxTurns: -3 })).toBeUndefined();
    expect(buildConstraintsWire({ maxTurns: 1.5 })).toBeUndefined();
  });

  it("readOnly:true ⇒ { read_only: true } only", () => {
    expect(buildConstraintsWire({ readOnly: true })).toEqual({ read_only: true });
  });

  it("readOnly:false is NEVER emitted (kept minimal; matches the Rust default)", () => {
    // false alone ⇒ undefined; false alongside a real tightening ⇒ the false is dropped.
    expect(buildConstraintsWire({ readOnly: false, maxTurns: 2 })).toEqual({ max_turns: 2 });
    expect("read_only" in (buildConstraintsWire({ readOnly: false, maxTurns: 2 }) ?? {})).toBe(
      false,
    );
  });

  it("disabledTools ⇒ trimmed, de-duped, empties dropped (cannot bloat/weaken the set)", () => {
    expect(
      buildConstraintsWire({ disabledTools: [" write_file ", "write_file", "", "delete_file"] }),
    ).toEqual({ disabled_tools: ["write_file", "delete_file"] });
  });

  it("maxTurns positive integer ⇒ { max_turns }", () => {
    expect(buildConstraintsWire({ maxTurns: 3 })).toEqual({ max_turns: 3 });
  });

  it("all three tightenings compose into one snake_case block", () => {
    expect(
      buildConstraintsWire({ readOnly: true, disabledTools: ["delete_file"], maxTurns: 2 }),
    ).toEqual({ read_only: true, disabled_tools: ["delete_file"], max_turns: 2 });
  });
});
