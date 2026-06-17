import { describe, expect, it } from "vitest";

import {
  qualifiesForRustReadOnlyRoute,
  RUST_ROUTE_CLAUDE_MODEL,
  RUST_ROUTE_CLAUDE_PROVIDER_ID,
  RUST_ROUTE_CODEX_MODEL,
  RUST_ROUTE_CODEX_PROVIDER_ID,
  RUST_ROUTE_READ_TOOL_ALLOWLIST,
  RUST_ROUTE_MUTATING_TOOL_ALLOWLIST,
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

function codexMissionBoundInput(): RustRouteQualificationInput {
  return {
    ...qualifyingInput(),
    providerId: RUST_ROUTE_CODEX_PROVIDER_ID,
    model: RUST_ROUTE_CODEX_MODEL,
    principalId: "principal:owner-1",
    missionContext: {
      fridayConversationId: "conv-codex",
      missionId: "mission-codex",
      workItemId: "work-codex",
    },
  };
}

function claudeMissionBoundInput(): RustRouteQualificationInput {
  return {
    ...qualifyingInput(),
    providerId: RUST_ROUTE_CLAUDE_PROVIDER_ID,
    model: RUST_ROUTE_CLAUDE_MODEL,
    principalId: "principal:owner-1",
    missionContext: {
      fridayConversationId: "conv-claude",
      missionId: "mission-claude",
      workItemId: "work-claude",
    },
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

  // ── Clause 3: admitted provider/model route shapes, no silent downgrade ──────
  it("disqualifies a non-deepseek provider", () => {
    expect(qualifiesForRustReadOnlyRoute({ ...qualifyingInput(), providerId: "anthropic" })).toBe(false);
    expect(qualifiesForRustReadOnlyRoute({ ...qualifyingInput(), providerId: undefined })).toBe(false);
  });

  it("admits a mission-bound Codex observe-wrapper run with missionContext and owner principal", () => {
    expect(qualifiesForRustReadOnlyRoute(codexMissionBoundInput())).toBe(true);
  });

  it("disqualifies ordinary Codex runs without missionContext or owner principal", () => {
    expect(
      qualifiesForRustReadOnlyRoute({
        ...codexMissionBoundInput(),
        missionContext: undefined,
      }),
    ).toBe(false);
    expect(
      qualifiesForRustReadOnlyRoute({
        ...codexMissionBoundInput(),
        principalId: undefined,
      }),
    ).toBe(false);
    expect(
      qualifiesForRustReadOnlyRoute({
        ...codexMissionBoundInput(),
        principalId: "   ",
      }),
    ).toBe(false);
  });

  it("disqualifies Codex mission-bound runs with the wrong model or taskProfile override", () => {
    expect(
      qualifiesForRustReadOnlyRoute({
        ...codexMissionBoundInput(),
        model: "codex",
      }),
    ).toBe(false);
    expect(
      qualifiesForRustReadOnlyRoute({
        ...codexMissionBoundInput(),
        taskProfile: { model: "deepseek-v4-flash" },
      }),
    ).toBe(false);
    expect(
      qualifiesForRustReadOnlyRoute({
        ...codexMissionBoundInput(),
        taskProfile: { model: RUST_ROUTE_CODEX_MODEL },
      }),
    ).toBe(true);
  });

  it("admits a mission-bound Claude mirror run with missionContext and owner principal", () => {
    expect(qualifiesForRustReadOnlyRoute(claudeMissionBoundInput())).toBe(true);
  });

  it("disqualifies ordinary Claude runs without missionContext or owner principal", () => {
    expect(
      qualifiesForRustReadOnlyRoute({
        ...claudeMissionBoundInput(),
        missionContext: undefined,
      }),
    ).toBe(false);
    expect(
      qualifiesForRustReadOnlyRoute({
        ...claudeMissionBoundInput(),
        principalId: undefined,
      }),
    ).toBe(false);
    expect(
      qualifiesForRustReadOnlyRoute({
        ...claudeMissionBoundInput(),
        principalId: "   ",
      }),
    ).toBe(false);
  });

  it("disqualifies Claude mission-bound runs with the wrong model or taskProfile override", () => {
    expect(
      qualifiesForRustReadOnlyRoute({
        ...claudeMissionBoundInput(),
        model: "claude-3-7",
      }),
    ).toBe(false);
    expect(
      qualifiesForRustReadOnlyRoute({
        ...claudeMissionBoundInput(),
        taskProfile: { model: "deepseek-v4-flash" },
      }),
    ).toBe(false);
    expect(
      qualifiesForRustReadOnlyRoute({
        ...claudeMissionBoundInput(),
        taskProfile: { model: RUST_ROUTE_CLAUDE_MODEL },
      }),
    ).toBe(true);
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

  it("a valid resolved record does NOT bypass the session OWNER requirement (sessioned + no principal)", () => {
    // (A2a Phase 1) a sessioned run with NO owner principal stays disqualified (fail-closed),
    // even with an otherwise fully-qualifying prod-resolved input.
    expect(
      qualifiesForRustReadOnlyRoute({ ...prodResolvedQualifyingInput(), sessionKey: "some-session" }),
    ).toBe(false);
  });

  it("a valid resolved record does NOT bypass the plan-review clause (requireReview)", () => {
    expect(
      qualifiesForRustReadOnlyRoute({ ...prodResolvedQualifyingInput(), requireReview: true }),
    ).toBe(false);
  });

  it("disqualifies deepseek-pro / codex / ordinary claude / a missing model (no downgrade to flash)", () => {
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

  // ── Clause 5 session sub-clause (A2a Phase 1 RELAX, owner-scoped) ────────────
  // A sessioned run is NOW admitted — but ONLY with a non-empty owner principalId. The
  // sessionLESS path is unchanged (the owner requirement is checked only when a sessionKey
  // is present). A blank/whitespace sessionKey is treated as absent (no session).
  it("admits a sessioned run when an owner principalId is present (A2a Phase 1 relax)", () => {
    expect(
      qualifiesForRustReadOnlyRoute({
        ...qualifyingInput(),
        sessionKey: "sess-123",
        principalId: "principal:owner-1",
      }),
    ).toBe(true);
  });

  it("disqualifies a sessioned run with a MISSING owner principalId (fail-closed)", () => {
    expect(qualifiesForRustReadOnlyRoute({ ...qualifyingInput(), sessionKey: "sess-123" })).toBe(false);
  });

  it("disqualifies a sessioned run with a BLANK / whitespace owner principalId (fail-closed)", () => {
    expect(
      qualifiesForRustReadOnlyRoute({ ...qualifyingInput(), sessionKey: "sess-123", principalId: "" }),
    ).toBe(false);
    expect(
      qualifiesForRustReadOnlyRoute({ ...qualifyingInput(), sessionKey: "sess-123", principalId: "   " }),
    ).toBe(false);
  });

  it("admits a sessioned run that ALSO meets every other clause (a real read-only sessioned chat)", () => {
    expect(
      qualifiesForRustReadOnlyRoute({
        ...prodResolvedQualifyingInput(),
        sessionKey: "chat-session-xyz",
        principalId: "principal:owner-1",
        allowedRustRouteTools: ["search", "stat_file", "list_dir", "read_file"],
      }),
    ).toBe(true);
  });

  it("a sessioned run is STILL bound by every other clause (sessioned ∧ readOnly:false ⇒ disqualified)", () => {
    expect(
      qualifiesForRustReadOnlyRoute({
        ...qualifyingInput(),
        sessionKey: "sess-123",
        principalId: "principal:owner-1",
        constraints: { readOnly: false },
      }),
    ).toBe(false);
  });

  it("the session OWNER requirement does NOT affect the SESSIONLESS path (blank principal still qualifies)", () => {
    // A sessionless run with a blank/absent principal qualifies HERE exactly as before
    // (it fail-closes downstream in compose). The owner requirement is session-scoped only —
    // this preserves the byte-identical sessionless behavior.
    expect(qualifiesForRustReadOnlyRoute({ ...qualifyingInput(), principalId: "" })).toBe(true);
    expect(qualifiesForRustReadOnlyRoute({ ...qualifyingInput(), principalId: undefined })).toBe(true);
    // whitespace-only sessionKey is treated as absent (no session ⇒ no owner needed ⇒ qualifies)
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

  // ── Clause 2/4 MUTATION-RELAX (A2b Phase 2, DARK, default-off) ────────────────
  // The security-critical admission boundary. A `readOnly:false` run is admitted ONLY when
  // ALL of: the default-off `agentRunControlViaRust` flag is ON, an EXPLICIT non-empty
  // `mutatingToolGrant` ⊆ the closed mutating allow-list, an EXPLICIT
  // `mutationGate === "operator_signed_ed25519"`, AND a non-empty bound owner principalId.
  // The relaxed clauses are each matched by an added requirement so the ungated-mutation
  // admission surface stays EXACTLY ZERO (INV-2 + INV-7). Flag-off ⇒ byte-identical disqualify.
  describe("clause-2/4 mutation relax (grant-gated, flag-off, dark)", () => {
    /** A fully-qualifying GATED MUTATING run: flag-on + readOnly:false + valid grant + gate + owner. */
    function gatedMutatingInput(): RustRouteQualificationInput {
      return {
        ...qualifyingInput(),
        agentRunControlViaRust: true,
        constraints: { readOnly: false },
        // base read set stays exactly the 4 reads; the mutating half rides mutatingToolGrant
        allowedRustRouteTools: [...RUST_ROUTE_READ_TOOL_ALLOWLIST],
        mutatingToolGrant: ["write_file", "edit_file"],
        mutationGate: "operator_signed_ed25519",
        principalId: "principal:owner-1",
      };
    }

    // (b) readOnly:false + valid grant + gate-marker + flag-on ⇒ QUALIFIES.
    it("(b) admits a gated mutating run: flag-on + readOnly:false + valid grant + gate-marker + bound owner", () => {
      expect(qualifiesForRustReadOnlyRoute(gatedMutatingInput())).toBe(true);
    });

    it("(b') admits a single-tool grant and the FULL closed mutating allow-list (subset of the 6)", () => {
      expect(
        qualifiesForRustReadOnlyRoute({ ...gatedMutatingInput(), mutatingToolGrant: ["run_command"] }),
      ).toBe(true);
      expect(
        qualifiesForRustReadOnlyRoute({
          ...gatedMutatingInput(),
          mutatingToolGrant: [...RUST_ROUTE_MUTATING_TOOL_ALLOWLIST],
        }),
      ).toBe(true);
    });

    // (a) readOnly:false + NO grant ⇒ DISQUALIFIED (never infer mutation from readOnly flipping).
    it("(a) disqualifies readOnly:false with NO mutatingToolGrant (even flag-on, gate-marker present, bound owner)", () => {
      expect(
        qualifiesForRustReadOnlyRoute({ ...gatedMutatingInput(), mutatingToolGrant: undefined }),
      ).toBe(false);
      expect(
        qualifiesForRustReadOnlyRoute({ ...gatedMutatingInput(), mutatingToolGrant: [] }),
      ).toBe(false);
    });

    it("(a') disqualifies readOnly:false with a grant but NO gate-marker (no admission for mutating + no gate)", () => {
      expect(
        qualifiesForRustReadOnlyRoute({ ...gatedMutatingInput(), mutationGate: undefined }),
      ).toBe(false);
      expect(
        qualifiesForRustReadOnlyRoute({ ...gatedMutatingInput(), mutationGate: "some_other_scheme" }),
      ).toBe(false);
    });

    // (c) flag-OFF ⇒ byte-identical disqualify (the mutating OR-arm is dead code).
    it("(c) flag-off ⇒ a fully-formed mutating run stays DISQUALIFIED (byte-identical to today's readOnly fence)", () => {
      // Identical to the qualifying gated input EXCEPT the flag is off → readOnly:false fences it.
      expect(
        qualifiesForRustReadOnlyRoute({ ...gatedMutatingInput(), agentRunControlViaRust: false }),
      ).toBe(false);
      // Flag absent (undefined) is the production default — same disqualify.
      expect(
        qualifiesForRustReadOnlyRoute({ ...gatedMutatingInput(), agentRunControlViaRust: undefined }),
      ).toBe(false);
    });

    it("(c') flag-off mutating fields on a READ-ONLY run change NOTHING (stray grant/gate ignored, still qualifies)", () => {
      // A read-only run with stray mutating fields and the flag off must be byte-identical to a
      // plain read-only run (the mutating fields are never consulted on the read-only path).
      expect(
        qualifiesForRustReadOnlyRoute({
          ...qualifyingInput(),
          agentRunControlViaRust: false,
          mutatingToolGrant: ["write_file"],
          mutationGate: "operator_signed_ed25519",
        }),
      ).toBe(true);
      // Even flag-ON, a read-only run ignores the mutating fields entirely → still qualifies.
      expect(
        qualifiesForRustReadOnlyRoute({
          ...qualifyingInput(),
          agentRunControlViaRust: true,
          mutatingToolGrant: ["write_file"],
          mutationGate: "operator_signed_ed25519",
        }),
      ).toBe(true);
    });

    // (d) clause 1 (route-marker) + clause 3 (provider/model shape) + bound-owner STILL enforced.
    it("(d) a gated mutating run STILL requires clause 1 (route marker)", () => {
      expect(
        qualifiesForRustReadOnlyRoute({ ...gatedMutatingInput(), invokedFromHttpStartRunRoute: false }),
      ).toBe(false);
    });

    it("(d) a gated mutating run STILL requires an admitted clause-3 provider/model shape", () => {
      expect(
        qualifiesForRustReadOnlyRoute({ ...gatedMutatingInput(), providerId: "anthropic", model: "claude-3-7" }),
      ).toBe(false);
      expect(
        qualifiesForRustReadOnlyRoute({ ...gatedMutatingInput(), model: "deepseek-v4-pro" }),
      ).toBe(false);
    });

    it("(d) a gated mutating run STILL requires a NON-EMPTY bound owner principalId (the compensating tightening)", () => {
      // The owner check is in the mutating-admission predicate ITSELF (not session-scoped),
      // so a SESSIONLESS mutating run with a blank/absent owner must also disqualify.
      expect(
        qualifiesForRustReadOnlyRoute({ ...gatedMutatingInput(), principalId: undefined }),
      ).toBe(false);
      expect(
        qualifiesForRustReadOnlyRoute({ ...gatedMutatingInput(), principalId: "" }),
      ).toBe(false);
      expect(
        qualifiesForRustReadOnlyRoute({ ...gatedMutatingInput(), principalId: "   " }),
      ).toBe(false);
    });

    it("(d') a gated mutating run STILL requires the exact 4-read base in allowedRustRouteTools", () => {
      // The mutating grant rides mutatingToolGrant; the read base must still be exactly the 4.
      expect(
        qualifiesForRustReadOnlyRoute({
          ...gatedMutatingInput(),
          allowedRustRouteTools: ["read_file", "list_dir", "stat_file"],
        }),
      ).toBe(false);
      // Mutating tools must NOT be smuggled into the read grant (that grant is reads-exact).
      expect(
        qualifiesForRustReadOnlyRoute({
          ...gatedMutatingInput(),
          allowedRustRouteTools: [...RUST_ROUTE_READ_TOOL_ALLOWLIST, "write_file"],
        }),
      ).toBe(false);
    });

    // (e) granted-but-not-in-allowlist tool ⇒ DISQUALIFIED (closed allow-list).
    it("(e) disqualifies a grant containing a tool NOT in the closed mutating allow-list", () => {
      expect(
        qualifiesForRustReadOnlyRoute({
          ...gatedMutatingInput(),
          mutatingToolGrant: ["write_file", "spawn_subagent"],
        }),
      ).toBe(false);
      expect(
        qualifiesForRustReadOnlyRoute({
          ...gatedMutatingInput(),
          mutatingToolGrant: ["read_file"], // a read tool is not a granted mutating tool
        }),
      ).toBe(false);
      expect(
        qualifiesForRustReadOnlyRoute({
          ...gatedMutatingInput(),
          mutatingToolGrant: ["exec_arbitrary"],
        }),
      ).toBe(false);
    });

    it("the mutating allow-list is exactly the closed 6 (write/append/edit/delete/move/run_command)", () => {
      expect([...RUST_ROUTE_MUTATING_TOOL_ALLOWLIST].sort()).toEqual(
        ["append_file", "delete_file", "edit_file", "move_file", "run_command", "write_file"],
      );
    });

    it("a gated mutating run that is ALSO sessioned still qualifies (bound owner satisfies both)", () => {
      expect(
        qualifiesForRustReadOnlyRoute({
          ...gatedMutatingInput(),
          sessionKey: "chat-session-xyz",
        }),
      ).toBe(true);
    });
  });
});
