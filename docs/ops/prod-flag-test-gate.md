# Prod-Flag Loop-Test Gate (registry gap #27)

**The founding promise:** *every prod-ON loop flag has a passing loop e2e test.*

This is the single recurrence-prevention gate behind the **L0 silently-inert-loop
disaster** — three loops shipped with their flags ON in prod while **no committed
test drove the loop to its outcome**. A loop can be hand-proven live once and still
silently rot, because nothing in CI re-asserts that the flag-ON path closes its loop.
The gate makes the **flag ↔ test mapping a committed, CI-enforced artifact** so a flag
can never go prod-ON with no loop test again.

## The two artifacts

| Artifact | Role |
| --- | --- |
| [`docs/ops/prod-flags-manifest.json`](./prod-flags-manifest.json) | Canonical source-of-truth: every loop flag, its `process`, `prod_state`, `closes_loop`, `coverage`, and the exact `e2e_test` (`<file/path>::<test_fn_name>`) that drives the WHOLE loop with the flag ON. The prod launch files (rust-ws-wrapper script + TS plist) are **not committed**, so this manifest IS the authoritative record. |
| [`scripts/ci/verify-prod-flag-tests.mjs`](../../scripts/ci/verify-prod-flag-tests.mjs) | The gate. Parses the manifest and, for every flag with `prod_state ∈ {on, dark}`, asserts the named test **file exists** and **declares the named test function** (Rust `fn <name>` or vitest `it/test("<name>")`). Fails (exit 1), **naming the offending flag**, on any missing/unmapped/unresolvable test. |

## CI wiring

Wired into `.github/workflows/ci.yml` as a dedicated job **`prod-flag-tests`** (MECHANISM-8),
added to the `quality-gate` aggregator's `needs` + result loop (the single required check
for branch protection). It runs on **every PR and push to main**. Pure Node + `fs` — no
compiler, no test execution — so it is **fast and deterministic**.

```bash
node scripts/ci/verify-prod-flag-tests.mjs   # exit 0 = mapping complete; exit 1 = a flag has no resolvable loop test
```

## What the gate does and does NOT do

- **Does:** prove the mapping is COMPLETE and RESOLVES — no prod-ON/dark flag is left
  without a named, on-disk loop-closing test.
- **Does NOT run the tests.** All 13 mapped tests today are **Rust `friday-hub` tests**,
  executed by `cargo test --workspace` in `.github/workflows/rust-core.yml`. None are
  `#[ignore]`'d, so they run with no key/network. This gate enforces that the mapping
  *exists and resolves*; `rust-core.yml` enforces that the tests *pass*.
  - **Caveat (PR coverage gap):** `rust-core.yml` is `pull_request`-triggered but
    **path-filtered to `rust-core/**`** — so the loop tests run on PRs that touch
    `rust-core/`, NOT on every PR. The mapped tests can only *break* when `rust-core/`
    changes (and then `rust-core.yml` runs them), so this is sound, but a PR that does
    not touch `rust-core/` gets the existence check only, not a fresh test run. THIS gate
    (`prod-flag-tests` in `ci.yml`) DOES run on every PR — it just checks the mapping.
  - If a future mapping points at a **vitest** test, it would be run by the `test` job in
    `ci.yml` (no mapped test does today).
- **Does NOT verify the live wrapper/plist.** Whether the running prod process actually
  carries exactly the manifest's `prod_state=on` set is **deploy-time drift**, out of
  CI scope (see follow-up below).

## Coverage honesty (`coverage` field)

The gate does not weaken itself to pass. Each flag declares a `coverage`:

- **`loop-e2e`** — a committed, PR-CI-run test drives the WHOLE loop with the flag's
  behavior ON and asserts the loop OUTCOME. This is the standard the founding promise
  requires.
- **`destination-only`** — the *destination* loop this flag routes into has a real
  loop-e2e test (mapped here, real, runs every PR), but the flag's OWN routing/on-ramp
  decision is **not** closed end-to-end in PR CI. This is a **recorded real gap**, not a
  fabricated mapping. The four TS `*_ROUTES_VIA_RUST` / `FRIDAY_ROUTE_AGENT_RUN_VIA_RUST`
  / `FRIDAY_MISSION_AUTO_DISPATCH` flags are `destination-only`: their loops close
  Rust-side (proven) but the TS→Rust routing is only covered by **mocked unit tests**
  (`*-dispatch-adapter.test.ts`) plus **`#[ignore]`'d live-key-gated** routed parity
  harnesses that never run in PR CI.

## Deploy contract (DEPLOYMENT-CRITICAL)

The manifest's `prod_state` is the contract a deploy MUST honor: **set exactly the flags
marked `prod_state=on`** on the named `process` (no more, no less). These flags are
**deployment-critical** — the rust-ws-wrapper and the TS plist must persist them across
restarts. A flag silently dropped on restart re-creates the inert-loop disaster
(see the `friday-read-seam-enrollment-gap` / wrapper-flag-durability concern).

## Follow-ups (out of this gate's CI scope)

1. **Deploy-time drift check.** Compare the running prod process's env (rust-ws-wrapper +
   TS plist) against the manifest's `prod_state=on` set; alarm on drift. This needs the
   live host and is therefore a deploy/ops check, not a PR-CI check.
2. **Close the `destination-only` gaps.** Add PR-CI tests that drive flag-ON TS routing →
   real Rust → loop-closed (today's coverage is mocked-unit + live-gated). When such a
   test lands, flip the flag's `coverage` to `loop-e2e`.
3. **Closed 2026-06-19: WorkItem-status dispatch arm.** `FRIDAY_MISSION_SPINE_DISPATCH`
   now maps to the Mission-lifecycle loop test plus an enforced
   `additional_e2e_tests` WorkItem-status producer test; the WorkItem-status test
   drives the same `work_item_status_result_for_db` path used by the flag-ON binary
   arm, asserts audit+state write, zero token ledger rows, and MissionTimeline readback.
4. **`deployment_critical.flags` ↔ `prod_state=on` cross-check.** The gate does not yet
   assert the `deployment_critical.flags` list equals the set of `prod_state=on` entries;
   a future editor could desync them. A one-line addition to the gate would harden this.
5. **Optional: make `destination-only` a hard failure.** Today `destination-only` flags
   PASS the gate (their destination loop is real + tested; the gap is recorded in the
   `coverage` field + this doc, not in red CI). If reg #27 should enforce *direct*
   loop coverage and block PRs until the on-ramp gaps close, flip `destination-only` out
   of `KNOWN_COVERAGE`-as-pass in the gate — a one-line change. This is an **operator
   decision**: making CI red on day one for a documented, real-test-backed gap would
   block every PR.
