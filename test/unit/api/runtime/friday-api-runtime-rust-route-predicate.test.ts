import { describe, expect, it } from "vitest";

import {
  qualifiesForRustReadOnlyRoute,
  RUST_ROUTE_READ_TOOL_ALLOWLIST,
  type RustRouteQualificationInput,
} from "../../../../src/api/runtime/friday-api-runtime.js";

// execrun-replacement slice 4 (DARK): fail-closed qualifying predicate for the future
// Rust read-only route. These tests pin the EXACT pre-authorized qualifying set: each
// disqualifying clause independently → false; the all-pass case → true; route-not-method
// (a non-route caller missing the internal marker) → false. The predicate must be TOTAL
// (never throws) and side-effect-free; nobody consumes the boolean yet (dark).

/** A minimal input that satisfies EVERY clause → qualifies === true. */
function qualifyingInput(): RustRouteQualificationInput {
  return {
    invokedFromHttpStartRunRoute: true,
    providerId: "deepseek",
    model: "deepseek-v4-flash",
    constraints: { readOnly: true },
    allowedRustRouteTools: [...RUST_ROUTE_READ_TOOL_ALLOWLIST],
    // no sessionKey, no requireReview, no plan-review override, no resume/skip → all-clear
  };
}

describe("qualifiesForRustReadOnlyRoute (execrun slice 4, dark predicate)", () => {
  it("admits a fully-qualifying read-only DeepSeek-flash route run", () => {
    expect(qualifiesForRustReadOnlyRoute(qualifyingInput())).toBe(true);
  });

  // ── Clause 1: route-not-method ──────────────────────────────────────────────
  it("disqualifies when the HTTP startRun route marker is absent (method-level / non-route caller)", () => {
    const input = qualifyingInput();
    delete input.invokedFromHttpStartRunRoute;
    expect(qualifiesForRustReadOnlyRoute(input)).toBe(false);
  });

  it("disqualifies a non-route caller even if every other clause would pass (marker !== true)", () => {
    // Simulates one of the 7 non-route callers (heartbeat/cron/channel-entry/autonomous/
    // planning-gate/subagent/sessions-tool) reaching the method chokepoint without the
    // route wrapper: the marker is never set, so it is never admitted.
    expect(qualifiesForRustReadOnlyRoute({ ...qualifyingInput(), invokedFromHttpStartRunRoute: false })).toBe(false);
  });

  // ── Clause 2: readOnly ──────────────────────────────────────────────────────
  it("disqualifies when constraints.readOnly is not exactly true", () => {
    expect(qualifiesForRustReadOnlyRoute({ ...qualifyingInput(), constraints: { readOnly: false } })).toBe(false);
    expect(qualifiesForRustReadOnlyRoute({ ...qualifyingInput(), constraints: {} })).toBe(false);
    expect(qualifiesForRustReadOnlyRoute({ ...qualifyingInput(), constraints: undefined })).toBe(false);
  });

  // ── Clause 3: DeepSeek-flash only, no silent downgrade ───────────────────────
  it("disqualifies a non-deepseek provider", () => {
    expect(qualifiesForRustReadOnlyRoute({ ...qualifyingInput(), providerId: "anthropic" })).toBe(false);
    expect(qualifiesForRustReadOnlyRoute({ ...qualifyingInput(), providerId: undefined })).toBe(false);
  });

  // ── Clause 3 (prod provider shape): resolved provider RECORD kind ────────────
  // Production provider rows carry UUID ids (kind="deepseek", id="fa15f1fe-…"); only
  // test/RGG envs seed the literal id "deepseek". The route wrapper resolves the record
  // and passes `resolvedProvider`; the predicate must accept BOTH shapes, fail-closed.
  const PROD_UUID_PROVIDER_ID = "fa15f1fe-7e64-4d2c-9a1b-3c5d7e9f0a2b";

  it("admits a prod-shaped UUID provider id whose RESOLVED record is an enabled deepseek", () => {
    expect(
      qualifiesForRustReadOnlyRoute({
        ...qualifyingInput(),
        providerId: PROD_UUID_PROVIDER_ID,
        resolvedProvider: { kind: "deepseek", enabled: true },
      }),
    ).toBe(true);
  });

  it("still admits the literal provider id \"deepseek\" WITHOUT any resolved record (test/RGG envs)", () => {
    // The literal shape never depends on a record resolution (the route wrapper does not
    // even perform the read when the literal matches).
    expect(
      qualifiesForRustReadOnlyRoute({ ...qualifyingInput(), resolvedProvider: undefined }),
    ).toBe(true);
  });

  it("disqualifies a UUID provider id whose resolved record kind is NOT deepseek", () => {
    expect(
      qualifiesForRustReadOnlyRoute({
        ...qualifyingInput(),
        providerId: PROD_UUID_PROVIDER_ID,
        resolvedProvider: { kind: "anthropic", enabled: true },
      }),
    ).toBe(false);
  });

  it("disqualifies a UUID provider id whose resolved deepseek record is DISABLED (or enabled-unknown)", () => {
    expect(
      qualifiesForRustReadOnlyRoute({
        ...qualifyingInput(),
        providerId: PROD_UUID_PROVIDER_ID,
        resolvedProvider: { kind: "deepseek", enabled: false },
      }),
    ).toBe(false);
    // enabled missing → uncertain → fail-closed
    expect(
      qualifiesForRustReadOnlyRoute({
        ...qualifyingInput(),
        providerId: PROD_UUID_PROVIDER_ID,
        resolvedProvider: { kind: "deepseek" },
      }),
    ).toBe(false);
  });

  it("disqualifies an UNRESOLVABLE UUID provider id (no record) — fail-closed, never throws", () => {
    const input: RustRouteQualificationInput = {
      ...qualifyingInput(),
      providerId: PROD_UUID_PROVIDER_ID,
      // resolvedProvider intentionally absent (route wrapper found no record / lookup threw)
    };
    expect(() => qualifiesForRustReadOnlyRoute(input)).not.toThrow();
    expect(qualifiesForRustReadOnlyRoute(input)).toBe(false);
  });

  it("a resolved deepseek record can NOT rescue a missing/blank providerId", () => {
    expect(
      qualifiesForRustReadOnlyRoute({
        ...qualifyingInput(),
        providerId: undefined,
        resolvedProvider: { kind: "deepseek", enabled: true },
      }),
    ).toBe(false);
    expect(
      qualifiesForRustReadOnlyRoute({
        ...qualifyingInput(),
        providerId: "   ",
        resolvedProvider: { kind: "deepseek", enabled: true },
      }),
    ).toBe(false);
  });

  // ── Clause-bypass regression guards (review MED) ─────────────────────────────
  // A VALID resolved deepseek record must NOT short-circuit the LATER clauses: each test
  // takes the fully-qualifying UUID+valid-resolved-record input (proven to qualify above)
  // and flips exactly ONE later clause → still disqualified. Guards against a refactor
  // that early-returns true once the resolved record is valid, skipping model-literal /
  // taskProfile-override / 4-tool-allowlist / plan-review / no-session checks.

  /** UUID providerId + valid resolved deepseek record; every other clause qualifying. */
  function prodResolvedQualifyingInput(): RustRouteQualificationInput {
    return {
      ...qualifyingInput(),
      providerId: PROD_UUID_PROVIDER_ID,
      resolvedProvider: { kind: "deepseek", enabled: true },
    };
  }

  it("a valid resolved record does NOT bypass the model-literal clause (deepseek-v4-pro)", () => {
    expect(
      qualifiesForRustReadOnlyRoute({ ...prodResolvedQualifyingInput(), model: "deepseek-v4-pro" }),
    ).toBe(false);
  });

  it("a valid resolved record does NOT bypass the taskProfile model-override clause", () => {
    expect(
      qualifiesForRustReadOnlyRoute({
        ...prodResolvedQualifyingInput(),
        taskProfile: { model: "deepseek-v4-pro" },
      }),
    ).toBe(false);
  });

  it("a valid resolved record does NOT bypass allowlist exactness — one EXTRA tool", () => {
    expect(
      qualifiesForRustReadOnlyRoute({
        ...prodResolvedQualifyingInput(),
        allowedRustRouteTools: [...RUST_ROUTE_READ_TOOL_ALLOWLIST, "run_command"],
      }),
    ).toBe(false);
  });

  it("a valid resolved record does NOT bypass allowlist exactness — one MISSING tool", () => {
    expect(
      qualifiesForRustReadOnlyRoute({
        ...prodResolvedQualifyingInput(),
        allowedRustRouteTools: ["read_file", "list_dir", "stat_file"],
      }),
    ).toBe(false);
  });

  it("a valid resolved record does NOT bypass the no-session clause", () => {
    expect(
      qualifiesForRustReadOnlyRoute({ ...prodResolvedQualifyingInput(), sessionKey: "some-session" }),
    ).toBe(false);
  });

  it("a valid resolved record does NOT bypass the plan-review clause (requireReview)", () => {
    expect(
      qualifiesForRustReadOnlyRoute({ ...prodResolvedQualifyingInput(), requireReview: true }),
    ).toBe(false);
  });

  it("disqualifies deepseek-pro / codex / claude / a missing model (no downgrade to flash)", () => {
    for (const model of ["deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner", "codex", "claude-3-7", undefined]) {
      expect(qualifiesForRustReadOnlyRoute({ ...qualifyingInput(), model })).toBe(false);
    }
  });

  it("disqualifies when a taskProfile model override is not exactly the flash identifier", () => {
    expect(
      qualifiesForRustReadOnlyRoute({ ...qualifyingInput(), taskProfile: { model: "deepseek-v4-pro" } }),
    ).toBe(false);
    // an override that re-states flash is allowed
    expect(
      qualifiesForRustReadOnlyRoute({ ...qualifyingInput(), taskProfile: { model: "deepseek-v4-flash" } }),
    ).toBe(true);
  });

  // ── Clause 4: exactly the 4 Rust read tools ─────────────────────────────────
  it("disqualifies when the read-tool grant is missing", () => {
    const input = qualifyingInput();
    delete input.allowedRustRouteTools;
    expect(qualifiesForRustReadOnlyRoute(input)).toBe(false);
  });

  it("disqualifies a grant that includes any non-read tool (run_command / write_file / edit_file)", () => {
    for (const extra of ["run_command", "write_file", "edit_file", "append_file", "delete_file", "spawn_subagent"]) {
      expect(
        qualifiesForRustReadOnlyRoute({
          ...qualifyingInput(),
          allowedRustRouteTools: [...RUST_ROUTE_READ_TOOL_ALLOWLIST, extra],
        }),
      ).toBe(false);
    }
  });

  it("disqualifies a grant missing one of the 4 reads, an empty grant, or a duplicate-padded grant", () => {
    expect(
      qualifiesForRustReadOnlyRoute({ ...qualifyingInput(), allowedRustRouteTools: ["read_file", "list_dir", "stat_file"] }),
    ).toBe(false);
    expect(qualifiesForRustReadOnlyRoute({ ...qualifyingInput(), allowedRustRouteTools: [] })).toBe(false);
    // duplicates that pad length to 4 must not sneak past (set-size guard)
    expect(
      qualifiesForRustReadOnlyRoute({
        ...qualifyingInput(),
        allowedRustRouteTools: ["read_file", "read_file", "list_dir", "stat_file"],
      }),
    ).toBe(false);
  });

  it("admits a grant of exactly the 4 reads in any order", () => {
    expect(
      qualifiesForRustReadOnlyRoute({
        ...qualifyingInput(),
        allowedRustRouteTools: ["search", "stat_file", "list_dir", "read_file"],
      }),
    ).toBe(true);
  });

  // ── Clause 5: no plan-review ────────────────────────────────────────────────
  it("disqualifies a plan-review run (requireReview / review profile / resume / skip / override)", () => {
    expect(qualifiesForRustReadOnlyRoute({ ...qualifyingInput(), requireReview: true })).toBe(false);
    expect(qualifiesForRustReadOnlyRoute({ ...qualifyingInput(), taskProfile: { id: "review" } })).toBe(false);
    expect(qualifiesForRustReadOnlyRoute({ ...qualifyingInput(), skipPlanningReview: true })).toBe(false);
    expect(qualifiesForRustReadOnlyRoute({ ...qualifyingInput(), resumeExistingRun: true })).toBe(false);
    // 4th plan-review disqualifier (0h): planReviewOverride is independently sufficient — PRESENCE
    // alone disqualifies, even with skip/resume unset (the lossy-projection over-admit the verify caught).
    expect(qualifiesForRustReadOnlyRoute({ ...qualifyingInput(), planReviewOverride: { mode: "manual" } })).toBe(false);
    expect(qualifiesForRustReadOnlyRoute({ ...qualifyingInput(), planReviewOverride: {} })).toBe(false);
  });

  // ── Clause 5: no session-mirror dependency ──────────────────────────────────
  it("disqualifies a sessioned run (session-mirror dependency)", () => {
    expect(qualifiesForRustReadOnlyRoute({ ...qualifyingInput(), sessionKey: "sess-123" })).toBe(false);
    // whitespace-only sessionKey is treated as absent (still qualifies)
    expect(qualifiesForRustReadOnlyRoute({ ...qualifyingInput(), sessionKey: "   " })).toBe(true);
  });

  // ── Fail-closed / totality invariants ───────────────────────────────────────
  it("is total: never throws on an empty / undefined-field input and returns false", () => {
    expect(() => qualifiesForRustReadOnlyRoute({})).not.toThrow();
    expect(qualifiesForRustReadOnlyRoute({})).toBe(false);
  });

  it("the read-tool allow-list is exactly the 4 Rust read tools", () => {
    expect([...RUST_ROUTE_READ_TOOL_ALLOWLIST].sort()).toEqual(
      ["list_dir", "read_file", "search", "stat_file"],
    );
  });
});
