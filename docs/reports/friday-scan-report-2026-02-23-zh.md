> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Friday Wiring, Permission, and Product-Consistency Convergence Plan

- Workspace: `.`
- Plan date: February 23, 2026
- Authoring intent: Senior-engineering execution blueprint
- Constraint: **Planning only**. No source code changes are included in this deliverable.

## 1) Objective

Deliver a controlled convergence program that closes runtime wiring gaps and aligns permission and product contracts, while minimizing severe bug risk through staged rollout, compatibility windows, and strict release gates.

## 2) What success means

This program is considered successful only when all of the following are true:

1. Runtime-exposed features are fully wired end-to-end (no “UI visible but backend stubbed” behavior).
2. Route authorization follows least-privilege scopes, not broad admin fallbacks.
3. UI capability display reflects real server capability and mode.
4. API and UI contracts use one source of truth for supported feature kinds.
5. Critical path tests are active (no silent skip debt on key route families).
6. New installs, upgrades, and rollback paths are deterministic and documented.

## 3) Scope

### In scope

1. Wiring closure for auth bootstrap, plugin mode, automations scheduling, setup channels, skills listing/fallback, and discoverability.
2. RBAC scope convergence (agent/provider/memory/security granularity).
3. API/UI contract consistency for capabilities and visible controls.
4. Test infrastructure upgrades to activate previously skipped critical suites.
5. Migration and rollout safety rules.

### Out of scope

1. New major product modules unrelated to current mismatch set.
2. Visual redesign beyond capability signaling and discoverability correctness.
3. Replacing core architecture (this is convergence, not rewrite).

## 4) Architecture context (as scanned)

The plan is aligned to existing architecture and file boundaries.

1. Composition root and lifecycle orchestration:
   - `./src/hub/friday-hub-bootstrap.ts`
2. API runtime and route registration:
   - `./src/api/runtime/friday-api-runtime.ts`
3. HTTP server/middleware/static hosting:
   - `./src/api/http/friday-http-server.ts`
4. Auth + RBAC model:
   - `./src/api/auth/friday-auth-service.ts`
   - `./src/api/model/friday-api-auth.types.ts`
   - `./src/api/auth/friday-rbac-policy.ts`
5. Workflow runtime:
   - `./src/workflows/runtime/friday-workflow-runtime.ts`
6. Agent runtime + routes:
   - `./src/agent/runtime/friday-agent-runtime.ts`
   - `./src/api/http/routes/friday-agent-routes.ts`
7. Setup wizard contracts:
   - `./src/api/http/routes/friday-setup-routes.ts`
   - `./ui/src/hooks/use-setup.ts`
   - `./ui/src/lib/api/setup.ts`
8. Channels configuration source:
   - `./src/channels/friday-channel-config.ts`
9. Plugin full stack and current stub behavior:
   - `./src/plugins/services/friday-plugin-service.ts`
   - `./src/hub/friday-hub-bootstrap.ts`
10. Scheduler infra:
   - `./src/jobs/scheduler/friday-job-scheduler-service.ts`
11. Frontend capability routing/nav:
   - `./ui/src/router.tsx`
   - `./ui/src/components/layout/sidebar.tsx`
12. Persistence migration chain:
   - `./src/state/sqlite/migrations`

## 5) Convergence principles (to minimize severe bugs)

1. **Additive-first data changes**: only additive schema changes in first release; destructive cleanup deferred.
2. **Explicit capability/mode signaling**: UI actions are enabled only if server advertises capability.
3. **Dual-scope compatibility window**: old and new scopes accepted during one controlled transition release.
4. **Feature-flagged rollout**: high-impact behavior is shielded by runtime flags with defaults documented.
5. **Fail-closed auth, fail-open UX messaging**: auth blocks unsafe operations; UI explains unavailable operations clearly.
6. **Deterministic IDs and idempotency**: scheduler and automation triggers use deterministic keys to avoid duplicate execution.
7. **No hidden skips on critical test paths**: release blocked if critical route suites are skipped.
8. **Canary before broad rollout**: staged enablement with measurable pass/fail criteria.

## 6) Program workstreams

## WS-1: Runtime wiring closure

### WS-1A: Production bootstrap auth reliability (P0)

#### Problem
Fresh production instances can lock out local admin login due to null hash + passwordless restriction mismatch.

#### Primary files
- `./src/hub/friday-hub-bootstrap.ts`
- `./src/api/auth/friday-auth-service.ts`
- `./src/api/http/routes/friday-auth-routes.ts`
- `./ui/src/routes/login-page.tsx`
- `./ui/src/lib/api/auth.ts`

#### Implementation plan
1. Introduce one-time local bootstrap passphrase flow via dedicated auth endpoint.
2. Hard-gate endpoint to localhost and one-time only precondition (`password_hash` is null).
3. Use existing password hashing path for consistency.
4. Add explicit auth error codes for bootstrap disallowed/already-done.
5. Update login UI to render initialization passphrase path when server indicates bootstrap required.
6. Hide local passwordless shortcut when policy disallows it.

#### Safety controls
1. Localhost-only check + rate limit.
2. Return 409 on second attempt; no overwrite behavior.
3. Audit log on bootstrap completion.

#### Validation
1. Fresh production-mode login completes without manual DB edits.
2. Remote access cannot call bootstrap endpoint.

---

### WS-1B: Plugin mode consistency (P1)

#### Problem
Hub currently wires stub plugin service by default while plugin routes exist, causing actionable UI paths to fail with 501.

#### Primary files
- `./src/hub/friday-hub-bootstrap.ts`
- `./src/plugins/services/friday-plugin-service.ts`
- `./src/api/runtime/friday-api-runtime.ts`
- `./src/api/http/routes/friday-plugin-routes.ts`
- `./ui/src/routes/settings-page.tsx`

#### Implementation plan
1. Add explicit plugin runtime mode (`stub`, `full`) in hub config resolution.
2. Build full service stack in `full` mode using existing plugin components.
3. Keep stub mode as a deliberate, visible mode only.
4. Expose mode in capability endpoint (or plugin list metadata).
5. UI must disable install/enable controls when mode is stub.

#### Safety controls
1. Default mode documented and explicit.
2. Runtime fallback toggle to force stub if full mode fails.
3. Mode displayed in UI and API for operator clarity.

#### Validation
1. No UI action leads to known 501 without prior “unavailable” state indication.
2. Full-mode happy path: install/enable/disable/uninstall passes in integration tests.

---

### WS-1C: Automation scheduling closure (P2)

#### Problem
Automation objects can be created/run manually, but scheduling loop is not fully closed at automation domain level.

#### Primary files
- `./src/agent/services/friday-agent-automation-service.ts`
- `./src/agent/persistence/friday-agent-automation-repository.ts`
- `./src/api/http/routes/friday-agent-routes.ts`
- `./src/jobs/scheduler/friday-job-scheduler-service.ts`
- `./src/hub/friday-hub-bootstrap.ts`
- `./ui/src/routes/automation-detail-page.tsx`

#### Implementation plan
1. Add schedule fields to automation create/update contract (`cronExpr`, `tz`, enabled).
2. Add migration for schedule metadata in automation persistence.
3. Define deterministic scheduler job ID convention: `agent-automation:<automationId>`.
4. On create/update: upsert scheduler record and register/update runtime job.
5. On disable/delete: disable scheduler job and clear next run metadata.
6. Return `nextRunAt/lastRunAt` in list/detail responses.
7. UI adds schedule editor + read-only run metadata.

#### Safety controls
1. Idempotent upsert per automation ID.
2. Duplicate-run prevention using deterministic job IDs.
3. Manual run endpoint remains available as fallback.

#### Validation
1. Scheduled run triggers without manual API call.
2. Disabled automation never triggers again.
3. Next/last run metadata remains accurate after updates.

---

### WS-1D: Setup channels parity (P2)

#### Problem
Setup route accepts fewer channel kinds than channel config schema supports.

#### Primary files
- `./src/api/http/routes/friday-setup-routes.ts`
- `./src/channels/friday-channel-config.ts`
- `./ui/src/components/setup/types.ts`
- `./ui/src/hooks/use-setup.ts`
- `./ui/src/lib/api/setup.ts`

#### Implementation plan
1. Replace hand-written channel kind list with a shared source derived from channel config schema.
2. Expand setup input/output contracts to include implemented channel kinds.
3. Update setup UI channel cards for each enabled kind.
4. Ensure mapping of UI config keys to backend parser keys is exact.
5. Add contract test preventing drift between setup and channel schema.

#### Safety controls
1. Feature flags for newly exposed channels if adapter maturity differs.
2. Strict validation errors with actionable field-level messages.

#### Validation
1. Every channel kind shown in setup is accepted and persisted by backend.
2. No backend rejection for UI-exposed channel kinds.

---

### WS-1E: Skills detail and list wiring (P1/P2)

#### Problem
Skills page can depend on local metadata; detail page can dead-end if `skill.ui.json` missing.

#### Primary files
- `./ui/src/routes/skills-page.tsx`
- `./ui/src/hooks/use-skills-catalog.ts`
- `./ui/src/lib/storage/skills-catalog-storage.ts`
- `./ui/src/lib/api/skills.ts`
- `./src/api/http/routes/friday-skill-routes.ts`
- `./ui/src/routes/skill-detail-page.tsx`

#### Implementation plan
1. Make `/v1/skills` backend list the primary source for Skills page.
2. Keep local storage only as optional metadata overlay (e.g., last used timestamp).
3. Handle `SKILL_UI_NOT_FOUND` with fallback runner UI, not terminal error.
4. Keep dynamic schema form path unchanged for skills with UI schema.

#### Safety controls
1. Explicit empty states: “no server skills” vs “server skills exist, no local metadata”.
2. Fallback runner input validation and safe defaults.

#### Validation
1. Skills remain visible after localStorage clear.
2. Skill detail remains runnable when schema is absent.

---

### WS-1F: Build feature discoverability alignment (P2)

#### Problem
Build routes exist but are hidden by default in sidebar power mode.

#### Primary files
- `./ui/src/components/layout/sidebar.tsx`
- `./ui/src/router.tsx`

#### Implementation plan
1. Move Workflows/Sessions/Memory into default navigation.
2. Reserve power mode for advanced/experimental controls only.
3. Add onboarding hint once after first login.

#### Safety controls
1. Feature flag for staged nav exposure.
2. Router remains unchanged to avoid breaking deep links.

#### Validation
1. New users can discover build features without hidden toggles.

## WS-2: Permission model convergence

### WS-2A: Agent scope separation (P2)

#### Problem
Agent routes currently depend on `workflow.run`, causing permission coupling.

#### Primary files
- `./src/api/model/friday-api-auth.types.ts`
- `./src/api/auth/friday-rbac-policy.ts`
- `./src/api/http/routes/friday-agent-routes.ts`

#### Implementation plan
1. Add dedicated scopes: `agent.read`, `agent.run`, `agent.write`.
2. Remap route protection:
   - list/get/events -> `agent.read`
   - start/run -> `agent.run`
   - cancel/automation create-update-delete -> `agent.write`
3. Transition window: accept legacy `workflow.run` + new scopes for one release.
4. Deprecation logs for legacy scope usage.

#### Safety controls
1. Compatibility toggle and telemetry counters.
2. Explicit migration note for token issuers.

#### Validation
1. Least-privilege tokens can call intended routes only.
2. No privilege expansion vs prior baseline.

---

### WS-2B: Provider/memory/security route granularity (P2)

#### Problem
Operational routes are over-coupled to `hub.admin`.

#### Primary files
- `./src/api/http/routes/friday-provider-routes.ts`
- `./src/api/http/routes/friday-provider-usage-routes.ts`
- `./src/api/http/routes/friday-memory-routes.ts`
- `./src/api/http/routes/friday-security-routes.ts`
- `./src/api/model/friday-api-auth.types.ts`
- `./src/api/auth/friday-rbac-policy.ts`

#### Implementation plan
1. Introduce narrow scopes:
   - `provider.read`, `provider.write`, `provider.validate`, `provider.usage.read`
   - `memory.read`, `memory.write`, `memory.prune`
   - keep/split security scopes based on route risk.
2. Route-by-route remap to least privilege.
3. Update default role matrix (owner/admin/operator/viewer).
4. One-release compatibility: allow `hub.admin` where needed while new scopes propagate.

#### Safety controls
1. Strict route-level scope tests before enabling hard enforcement.
2. Migration checklist for existing long-lived API tokens.

#### Validation
1. Operator workflows no longer require full admin.
2. Unauthorized calls remain 403 with clear error code.

---

### WS-2C: Session key usability improvements (P2)

#### Problem
Strict input format can block integrations and create avoidable 400s.

#### Primary files
- `./src/sessions/services/friday-session-key.ts`
- `./src/api/http/routes/friday-session-routes.ts`
- `./ui/src/lib/api/sessions.ts`

#### Implementation plan
1. Keep canonical strict internal format.
2. Add input canonicalization layer for common shorthand keys.
3. Upgrade validation errors with explicit accepted examples.
4. Document canonicalization rules and ambiguity rejection behavior.

#### Safety controls
1. Canonicalization guarded by deterministic rules only.
2. Config toggle to disable canonicalization if ambiguity appears.

#### Validation
1. Most common malformed inputs become actionable or auto-corrected safely.

## WS-3: API/UI product-contract consistency

### WS-3A: Capability handshake

#### Primary files
- `./src/api/http/routes/friday-health-routes.ts`
- `./src/api/runtime/friday-api-runtime.ts`
- `./ui/src/providers/auth-provider.tsx`
- `./ui/src/routes/*`

#### Implementation plan
1. Expose server capability payload (auth mode, plugin mode, enabled modules, channel kinds).
2. UI consumes capabilities early and gates actions accordingly.
3. Eliminate optimistic UI controls for unavailable server operations.

#### Safety controls
1. Unknown capability values default to safest UI behavior (disable action).
2. Capability response versioning for forward compatibility.

#### Validation
1. UI never presents actions that backend cannot execute in current mode.

---

### WS-3B: Single source of truth for “supported” claims

#### Implementation plan
1. Define canonical source for supported features in backend.
2. Generate or validate docs/UI enums against canonical source in CI.
3. Add drift-check script that fails CI on mismatch.

#### Validation
1. README, setup UI, and route validators remain consistent by construction.

## WS-4: Test and quality hardening

### WS-4A: Remove critical skip debt (P3)

#### Primary files
- `./test/e2e/api/_helpers/friday-api-test-server.helper.ts`
- `./test/e2e/api/friday-api-skills-routes.test.ts`
- `./test/e2e/api/friday-api-plugins-routes.test.ts`
- `./test/e2e/api/friday-api-sessions-memory-routes.test.ts`

#### Implementation plan
1. Extend test env helper to optionally wire memory/skills/plugin services.
2. Unskip route suites once dependencies are available.
3. Keep test builder modular so lightweight suites stay fast.

#### Safety controls
1. Time-budget guardrails for test runtime.
2. Nightly full matrix for slow end-to-end slices.

#### Validation
1. Critical API route suites run in CI (no silent skipped coverage).

---

### WS-4B: Regression guard matrix (must-pass)

1. Fresh install bootstrap auth journey.
2. Workflow approve/reject deterministic behavior.
3. Agent route scopes and compatibility behavior.
4. Plugin mode stub/full capability signaling.
5. Setup channels save/load across all exposed kinds.
6. Automation schedule trigger/disable semantics.
7. Skills list/detail fallback behavior.

## 7) Migration strategy

1. Additive migrations only in first convergence release.
2. Scope changes do not require schema migration, but require token compatibility handling.
3. Data migration tickets must include rollback SQL or safe no-op fallback path.
4. Every migration includes checksum + chain validation.

## 8) Rollout strategy

### Phase 0: Design lock (2–3 days)
1. Finalize scope taxonomy and route mapping table.
2. Finalize capability payload contract.
3. Finalize migration specs and feature flags.

### Phase 1: P0/P1 wiring fixes (week 1)
1. Auth bootstrap reliability.
2. Plugin mode consistency.
3. Skills list/detail wiring.

### Phase 2: Permission convergence (week 2)
1. Agent scope separation with compatibility window.
2. Provider/memory/security granularity.
3. Session key usability improvements.

### Phase 3: Product contract convergence (week 3)
1. Setup channel parity.
2. Capability handshake in UI.
3. Discoverability alignment.

### Phase 4: Hardening and release (week 4)
1. Unskip critical suites.
2. Full regression matrix.
3. Canary rollout and promotion.

## 9) PR slicing plan (recommended)

1. PR-01: Auth bootstrap route + backend tests.
2. PR-02: Login bootstrap UX + auth mode signaling.
3. PR-03: Plugin mode config and capability payload.
4. PR-04: Plugin UI gating in stub mode.
5. PR-05: Skills list backend-first + metadata overlay.
6. PR-06: Skill detail fallback runner.
7. PR-07: Agent scopes + route remap + compatibility.
8. PR-08: Provider/memory/security scope granularity.
9. PR-09: Session key canonicalization + error messages.
10. PR-10: Automation schedule schema + scheduler wiring.
11. PR-11: Setup channel parity + contract drift tests.
12. PR-12: Sidebar discoverability changes.
13. PR-13: Test env wiring + unskip critical route suites.
14. PR-14: Documentation and release runbook alignment.

## 10) Required deliverables per PR

1. Scope statement and file touch list.
2. Risk assessment and rollback method.
3. Unit/integration/e2e test additions.
4. Compatibility notes (if auth/scopes changed).
5. Screenshot/log evidence for affected UX/runtime path.

## 11) Release gates (strict)

1. Gate G1: All P0/P1 tasks merged and green.
2. Gate G2: No critical route suite skipped.
3. Gate G3: Capability mismatch count = 0 (UI action vs backend support).
4. Gate G4: Scope matrix sign-off from security reviewer.
5. Gate G5: Canary run for 48 hours with no P0/P1 incident.

## 12) Incident-prevention checklist

1. Feature flags exist for all high-impact behavior changes.
2. Default behavior remains backward-compatible during transition.
3. Metrics and logs added for deprecated scope usage and unsupported action attempts.
4. Rollback path tested in staging before production.
5. Documentation updated before rollout, not after.

## 13) Test plan details

### Unit tests
1. Auth bootstrap policy guards and one-time semantics.
2. Scope validator and role mapping coverage.
3. Session key canonicalization and error payload formatting.
4. Automation schedule translation and deterministic job ID behavior.

### Integration tests
1. API route authorization matrix for old/new scope compatibility.
2. Plugin route behavior in both modes.
3. Setup channel save/load against parser.
4. Skills detail fallback behavior with missing UI schema.

### E2E tests
1. Fresh install login bootstrap to authenticated shell.
2. Skills list visibility after local storage reset.
3. Scheduled automation trigger and disable stop behavior.
4. Discoverability flow for workflows/sessions/memory navigation.

### Nightly tests
1. Expanded full-stack matrix with plugin + memory + skills routes enabled.
2. Long-run scheduler behavior for duplicate-trigger protection.

## 14) Ownership model

For each work item, assign:

1. Owner engineer
2. Reviewer engineer
3. Security reviewer (for auth/scope items)
4. QA owner
5. Release manager

Template fields for each ticket:

1. Task ID
2. Goal
3. Files expected to touch
4. Acceptance tests
5. Risk level
6. Flag name
7. Rollback command/process
8. Evidence links

## 15) Risk register

1. Risk: bootstrap endpoint misuse.
   - Mitigation: localhost-only, one-time, rate-limited, audited.
2. Risk: scope migration lockouts.
   - Mitigation: dual-scope transition, telemetry for old scope usage, staged enforcement.
3. Risk: duplicate scheduled runs.
   - Mitigation: deterministic scheduler IDs + idempotency checks.
4. Risk: plugin full mode unstable in some envs.
   - Mitigation: runtime mode fallback to stub + capability signaling.
5. Risk: setup-channel drift reappears.
   - Mitigation: CI drift-check against shared source-of-truth schema.

## 16) Final execution order (recommended)

1. WS-1A Auth bootstrap reliability.
2. WS-1B Plugin mode consistency.
3. WS-1E Skills list/detail wiring.
4. WS-2A Agent scope separation.
5. WS-2B Provider/memory/security scope granularity.
6. WS-1C Automation scheduling closure.
7. WS-1D Setup channels parity.
8. WS-3A Capability handshake.
9. WS-1F Discoverability alignment.
10. WS-2C Session key usability.
11. WS-4A Unskip critical tests.
12. Full regression, canary, release promotion.

## 17) Practical guarantee statement

This plan is designed to **materially reduce the probability of severe bugs** by combining additive changes, compatibility windows, hard test gates, and staged rollout. In software engineering, zero-bug guarantees are not realistic; this program instead enforces controls that prevent high-severity regressions from reaching release.


## 18) Jira/Linear execution backlog (implementation-level)

This section translates the convergence plan into a ticket-level execution backlog with dependencies, acceptance criteria, and quality gates.

## 18.1 Board setup (required before sprinting)

1. Project key: `FRI-CONV`
2. Team board groups:
   - Group A: Runtime Wiring
   - Group B: RBAC and Security
   - Group C: Frontend Contract and UX
   - Group D: Test Infrastructure and Release
3. Status workflow:
   - `Backlog`
   - `Ready`
   - `In Progress`
   - `In Review`
   - `QA`
   - `Canary`
   - `Done`
   - `Blocked`
4. Priority policy:
   - `P0`: release blocker
   - `P1`: high impact, no release if unresolved unless exception approved
   - `P2`: medium impact, can release behind flags
   - `P3`: quality debt or optimization
5. Required custom fields:
   - `Risk Level` (`Low`, `Medium`, `High`)
   - `Rollback Plan` (text)
   - `Feature Flag` (text, nullable)
   - `Migration Impact` (`None`, `Additive`, `Breaking`)
   - `Compatibility Window` (text)
   - `Primary File Touchpoints` (text)
6. Definition of Ready:
   - Problem statement is concrete and reproducible.
   - Scope boundary is explicit.
   - Dependencies are identified.
   - Acceptance criteria and tests are listed.
7. Definition of Done:
   - All acceptance criteria met.
   - Tests added and green at required levels.
   - Docs updated.
   - Rollback verified in staging.
   - Metrics/logging hooks validated.

## 18.2 Milestones

1. Milestone M0: Design lock and task readiness.
2. Milestone M1: P0/P1 wiring closure.
3. Milestone M2: RBAC convergence and compatibility window.
4. Milestone M3: Product-contract convergence and discoverability.
5. Milestone M4: Test debt closure, canary, and production promotion.

## 18.3 EPIC map

1. `FRI-CONV-EPIC-1`: Auth bootstrap reliability and first-login safety.
2. `FRI-CONV-EPIC-2`: Plugin mode wiring and capability signaling.
3. `FRI-CONV-EPIC-3`: Skills source-of-truth and schema-missing fallback.
4. `FRI-CONV-EPIC-4`: Automation scheduling end-to-end closure.
5. `FRI-CONV-EPIC-5`: Setup channel parity with implemented adapters.
6. `FRI-CONV-EPIC-6`: Agent RBAC scope separation.
7. `FRI-CONV-EPIC-7`: Provider/memory/security RBAC granularity.
8. `FRI-CONV-EPIC-8`: Session key usability and canonicalization.
9. `FRI-CONV-EPIC-9`: Capability handshake and frontend contract gating.
10. `FRI-CONV-EPIC-10`: Build feature discoverability alignment.
11. `FRI-CONV-EPIC-11`: Critical-path test unskip and infra wiring.
12. `FRI-CONV-EPIC-12`: Release hardening, canary, and rollback readiness.

## 19) Detailed issue backlog

## 19.1 EPIC-1 Auth bootstrap reliability and first-login safety

### FRI-CONV-101 — Design auth bootstrap contract

1. Type: Story
2. Priority: P0
3. Estimate: 3 SP
4. Depends on: none
5. Feature flag: `auth.bootstrap_local_passphrase`
6. Migration impact: None
7. Primary touchpoints:
   - `./src/api/http/routes/friday-auth-routes.ts`
   - `./src/api/auth/friday-auth-service.ts`
8. Implementation checklist:
   - Define endpoint path and request/response schema.
   - Define localhost-only criteria and one-time semantics.
   - Define error code catalog for disallowed/already-complete states.
   - Define audit event payload and log fields.
9. Acceptance criteria:
   - Contract doc includes schemas and exact preconditions.
   - Security reviewer signs off localhost and one-time policy.
10. Required tests:
   - Contract test for payload schema.
11. Rollback plan:
   - Disable via feature flag.

### FRI-CONV-102 — Implement auth bootstrap backend flow

1. Type: Story
2. Priority: P0
3. Estimate: 8 SP
4. Depends on: FRI-CONV-101
5. Feature flag: `auth.bootstrap_local_passphrase`
6. Migration impact: None
7. Primary touchpoints:
   - `./src/api/http/routes/friday-auth-routes.ts`
   - `./src/api/auth/friday-auth-service.ts`
8. Implementation checklist:
   - Add bootstrap endpoint and route guards.
   - Reuse scrypt password hash utility.
   - Add domain errors `AUTH_BOOTSTRAP_NOT_ALLOWED`, `AUTH_BOOTSTRAP_ALREADY_DONE`.
   - Emit audit log event on success.
   - Enforce idempotent second call behavior.
9. Acceptance criteria:
   - Fresh production instance can initialize local passphrase exactly once.
   - Non-localhost request gets blocked.
   - Existing hashed local account cannot be overwritten.
10. Required tests:
   - Unit test for localhost check.
   - Unit test for one-time behavior.
   - Integration test for fresh-state bootstrap and login.

### FRI-CONV-103 — Login UI bootstrap-required state

1. Type: Story
2. Priority: P0
3. Estimate: 5 SP
4. Depends on: FRI-CONV-102
5. Feature flag: `auth.bootstrap_local_passphrase`
6. Migration impact: None
7. Primary touchpoints:
   - `./ui/src/routes/login-page.tsx`
   - `./ui/src/lib/api/auth.ts`
8. Implementation checklist:
   - Parse bootstrap-specific API error codes.
   - Render initialization form when bootstrap required.
   - Hide passwordless local login button when disallowed by server policy.
   - Add user guidance copy for first-login setup.
9. Acceptance criteria:
   - No dead-end login state on fresh production startup.
   - UI messaging is deterministic for all bootstrap outcomes.
10. Required tests:
   - UI component test for bootstrap-required rendering.
   - UI integration test for successful bootstrap then login.

### FRI-CONV-104 — Auth bootstrap documentation and runbook

1. Type: Task
2. Priority: P1
3. Estimate: 2 SP
4. Depends on: FRI-CONV-102
5. Feature flag: N/A
6. Migration impact: None
7. Primary touchpoints:
   - `./README.md`
   - `./docs`
8. Implementation checklist:
   - Add first-login bootstrap section.
   - Add security notes on localhost-only behavior.
   - Add operator troubleshooting section.
9. Acceptance criteria:
   - New operator can complete first login from docs without DB intervention.

## 19.2 EPIC-2 Plugin mode wiring and capability signaling

### FRI-CONV-201 — Define plugin mode config and capability schema

1. Type: Story
2. Priority: P1
3. Estimate: 3 SP
4. Depends on: none
5. Feature flag: `plugins.runtime_mode`
6. Migration impact: None
7. Primary touchpoints:
   - `./src/hub/friday-hub-bootstrap.ts`
   - `./src/api/runtime/friday-api-runtime.ts`
8. Implementation checklist:
   - Define mode enum: `stub` and `full`.
   - Define API capability field for plugin mode.
   - Define default mode and override path.
9. Acceptance criteria:
   - Mode contract is documented and versioned.

### FRI-CONV-202 — Wire full plugin stack in hub bootstrap

1. Type: Story
2. Priority: P1
3. Estimate: 8 SP
4. Depends on: FRI-CONV-201
5. Feature flag: `plugins.runtime_mode`
6. Migration impact: None
7. Primary touchpoints:
   - `./src/hub/friday-hub-bootstrap.ts`
   - `./src/plugins/services/friday-plugin-service.ts`
8. Implementation checklist:
   - Build full plugin service components and inject when mode is `full`.
   - Keep existing stub mode path explicit.
   - Add startup diagnostics log with selected mode.
9. Acceptance criteria:
   - Full mode supports install/enable/disable/uninstall route behavior.
   - Stub mode remains functional and explicit.
10. Required tests:
   - Integration test for mode selection.
   - Integration test for plugin lifecycle in full mode.

### FRI-CONV-203 — Frontend plugin action gating by capability

1. Type: Story
2. Priority: P1
3. Estimate: 5 SP
4. Depends on: FRI-CONV-201
5. Feature flag: `plugins.runtime_mode`
6. Migration impact: None
7. Primary touchpoints:
   - `./ui/src/routes/settings-page.tsx`
   - `./ui/src/lib/api/client.ts`
8. Implementation checklist:
   - Read capability payload on app load.
   - Disable/hide mutating plugin actions in stub mode.
   - Display non-blocking explanation in UI.
9. Acceptance criteria:
   - No actionable button leads to expected 501 in normal flow.
10. Required tests:
   - UI test for stub mode action disabling.

## 19.3 EPIC-3 Skills source-of-truth and fallback execution

### FRI-CONV-301 — Skills list backend-first contract

1. Type: Story
2. Priority: P1
3. Estimate: 3 SP
4. Depends on: none
5. Feature flag: `skills.backend_list_primary`
6. Migration impact: None
7. Primary touchpoints:
   - `./ui/src/lib/api/skills.ts`
   - `./src/api/http/routes/friday-skill-routes.ts`
8. Implementation checklist:
   - Ensure list endpoint response is stable and typed.
   - Add API client method for skills listing.
9. Acceptance criteria:
   - Typed list contract consumed in UI without localStorage dependency.

### FRI-CONV-302 — Skills page backend-first rendering

1. Type: Story
2. Priority: P1
3. Estimate: 5 SP
4. Depends on: FRI-CONV-301
5. Feature flag: `skills.backend_list_primary`
6. Migration impact: None
7. Primary touchpoints:
   - `./ui/src/routes/skills-page.tsx`
   - `./ui/src/hooks/use-skills-catalog.ts`
8. Implementation checklist:
   - Refactor data source to backend primary.
   - Overlay local metadata by `skillId` only.
   - Add empty-state differentiation.
9. Acceptance criteria:
   - Clearing localStorage does not hide server skills.
10. Required tests:
   - UI tests for backend-first and empty states.

### FRI-CONV-303 — Skill detail fallback runner for missing UI schema

1. Type: Story
2. Priority: P2
3. Estimate: 5 SP
4. Depends on: none
5. Feature flag: `skills.schema_fallback_runner`
6. Migration impact: None
7. Primary touchpoints:
   - `./ui/src/routes/skill-detail-page.tsx`
   - `./ui/src/lib/api/types.ts`
8. Implementation checklist:
   - Catch `SKILL_UI_NOT_FOUND` and render fallback form.
   - Support JSON input and run action via existing agent API flow.
   - Provide validation hints and safe defaults.
9. Acceptance criteria:
   - Missing `skill.ui.json` no longer blocks skill execution.
10. Required tests:
   - UI tests for fallback rendering and successful run.

## 19.4 EPIC-4 Automation scheduling end-to-end closure

### FRI-CONV-401 — Automation schedule contract and migration design

1. Type: Story
2. Priority: P2
3. Estimate: 5 SP
4. Depends on: none
5. Feature flag: `automation.scheduler_link`
6. Migration impact: Additive
7. Primary touchpoints:
   - `./src/agent/services/friday-agent-automation-service.types.ts`
   - `./src/state/sqlite/migrations`
8. Implementation checklist:
   - Define schedule schema in API and persistence.
   - Define migration fields for cron/tz/enabled metadata.
   - Define deterministic scheduler job ID convention.
9. Acceptance criteria:
   - Schema and migration RFC approved.

### FRI-CONV-402 — Repository and service schedule persistence wiring

1. Type: Story
2. Priority: P2
3. Estimate: 8 SP
4. Depends on: FRI-CONV-401
5. Feature flag: `automation.scheduler_link`
6. Migration impact: Additive
7. Primary touchpoints:
   - `./src/agent/persistence/friday-agent-automation-repository.ts`
   - `./src/agent/services/friday-agent-automation-service.ts`
8. Implementation checklist:
   - Persist schedule metadata.
   - Expose next/last run metadata in read models.
   - Ensure delete/disable semantics include schedule cleanup.
9. Acceptance criteria:
   - Automation record remains source-of-truth for schedule state.

### FRI-CONV-403 — Scheduler upsert/disable linkage for automations

1. Type: Story
2. Priority: P2
3. Estimate: 8 SP
4. Depends on: FRI-CONV-402
5. Feature flag: `automation.scheduler_link`
6. Migration impact: None
7. Primary touchpoints:
   - `./src/hub/friday-hub-bootstrap.ts`
   - `./src/jobs/scheduler/friday-job-scheduler-service.ts`
8. Implementation checklist:
   - On automation create/update, upsert scheduler job and schedule.
   - On delete/disable, disable scheduler job.
   - Ensure job executes `automationService.run(automationId)` safely.
9. Acceptance criteria:
   - Automation runs trigger at schedule with no duplicate trigger under normal conditions.
10. Required tests:
   - Integration tests for schedule trigger and disable behavior.

### FRI-CONV-404 — Automation API route updates

1. Type: Story
2. Priority: P2
3. Estimate: 5 SP
4. Depends on: FRI-CONV-403
5. Feature flag: `automation.scheduler_link`
6. Migration impact: None
7. Primary touchpoints:
   - `./src/api/http/routes/friday-agent-routes.ts`
8. Implementation checklist:
   - Add schedule fields to create/update payload.
   - Return schedule and run metadata in list/get.
   - Preserve manual run endpoint behavior.
9. Acceptance criteria:
   - API clients can manage scheduled and manual automations coherently.

### FRI-CONV-405 — Automation UI schedule controls

1. Type: Story
2. Priority: P2
3. Estimate: 5 SP
4. Depends on: FRI-CONV-404
5. Feature flag: `automation.scheduler_link`
6. Migration impact: None
7. Primary touchpoints:
   - `./ui/src/routes/automation-detail-page.tsx`
   - `./ui/src/lib/api/automations.ts`
8. Implementation checklist:
   - Add schedule form and validations.
   - Show next run and last run metadata.
   - Distinguish manual run from scheduled state.
9. Acceptance criteria:
   - Operator can configure schedule without direct API calls.

## 19.5 EPIC-5 Setup channel parity with adapters

### FRI-CONV-501 — Shared channel-kind source of truth

1. Type: Story
2. Priority: P2
3. Estimate: 5 SP
4. Depends on: none
5. Feature flag: `setup.channels_unified_kinds`
6. Migration impact: None
7. Primary touchpoints:
   - `./src/channels/friday-channel-config.ts`
   - `./src/api/http/routes/friday-setup-routes.ts`
8. Implementation checklist:
   - Define reusable supported-kind export.
   - Replace hardcoded setup route kind list.
   - Add CI drift test to enforce parity.
9. Acceptance criteria:
   - Setup backend accepted kinds are derived from shared source.

### FRI-CONV-502 — Setup API validation expansion and contract tests

1. Type: Story
2. Priority: P2
3. Estimate: 5 SP
4. Depends on: FRI-CONV-501
5. Feature flag: `setup.channels_unified_kinds`
6. Migration impact: None
7. Primary touchpoints:
   - `./src/api/http/routes/friday-setup-routes.ts`
   - `./test/contracts/api`
8. Implementation checklist:
   - Expand channel payload validation to all supported kinds.
   - Add contract snapshots for each kind.
9. Acceptance criteria:
   - Every UI-exposed kind is valid in setup API.

### FRI-CONV-503 — Setup UI channel cards and payload mapping

1. Type: Story
2. Priority: P2
3. Estimate: 8 SP
4. Depends on: FRI-CONV-502
5. Feature flag: `setup.channels_unified_kinds`
6. Migration impact: None
7. Primary touchpoints:
   - `./ui/src/components/setup/types.ts`
   - `./ui/src/hooks/use-setup.ts`
   - `./ui/src/lib/api/setup.ts`
8. Implementation checklist:
   - Extend channel kind union in frontend.
   - Add card forms for newly exposed kinds.
   - Map UI fields to backend config keys exactly.
9. Acceptance criteria:
   - Setup wizard can configure all exposed channel kinds and persist successfully.

## 19.6 EPIC-6 Agent RBAC scope separation

### FRI-CONV-601 — Add agent scope taxonomy

1. Type: Story
2. Priority: P2
3. Estimate: 3 SP
4. Depends on: none
5. Feature flag: `rbac.agent_scopes_v2`
6. Migration impact: None
7. Primary touchpoints:
   - `./src/api/model/friday-api-auth.types.ts`
   - `./src/api/auth/friday-rbac-policy.ts`
8. Implementation checklist:
   - Add `agent.read`, `agent.run`, `agent.write`.
   - Update role default scopes.
9. Acceptance criteria:
   - Scope model compiles and role matrix approved.

### FRI-CONV-602 — Remap agent route auth requirements

1. Type: Story
2. Priority: P2
3. Estimate: 5 SP
4. Depends on: FRI-CONV-601
5. Feature flag: `rbac.agent_scopes_v2`
6. Migration impact: None
7. Primary touchpoints:
   - `./src/api/http/routes/friday-agent-routes.ts`
8. Implementation checklist:
   - Map read/run/write operations to dedicated scopes.
   - Keep temporary compatibility with `workflow.run`.
9. Acceptance criteria:
   - Least privilege is enforceable per agent route class.

### FRI-CONV-603 — Compatibility window telemetry and deprecation

1. Type: Task
2. Priority: P2
3. Estimate: 3 SP
4. Depends on: FRI-CONV-602
5. Feature flag: `rbac.agent_scopes_v2`
6. Migration impact: None
7. Primary touchpoints:
   - `./src/api/auth`
8. Implementation checklist:
   - Log legacy scope usage counts.
   - Add deprecation warning to operational docs.
   - Define removal date of legacy acceptance.
9. Acceptance criteria:
   - Compatibility window has measurable usage telemetry.

### FRI-CONV-604 — Agent RBAC test matrix

1. Type: Story
2. Priority: P2
3. Estimate: 5 SP
4. Depends on: FRI-CONV-602
5. Feature flag: `rbac.agent_scopes_v2`
6. Migration impact: None
7. Primary touchpoints:
   - `./test/e2e/api/friday-api-auth-rbac-errors.test.ts`
8. Implementation checklist:
   - Add tests for each agent route with allow/deny cases.
   - Add tests for legacy compatibility scope behavior.
9. Acceptance criteria:
   - Full route-level scope enforcement proven by automated tests.

## 19.7 EPIC-7 Provider/memory/security RBAC granularity

### FRI-CONV-701 — Define granular operational scope taxonomy

1. Type: Story
2. Priority: P2
3. Estimate: 3 SP
4. Depends on: none
5. Feature flag: `rbac.operational_scopes_v2`
6. Migration impact: None
7. Primary touchpoints:
   - `./src/api/model/friday-api-auth.types.ts`
   - `./src/api/auth/friday-rbac-policy.ts`
8. Implementation checklist:
   - Add provider and memory granular scopes.
   - Confirm security scope strategy with security reviewer.
9. Acceptance criteria:
   - Scope list is minimal and non-overlapping.

### FRI-CONV-702 — Provider route remap to least privilege

1. Type: Story
2. Priority: P2
3. Estimate: 5 SP
4. Depends on: FRI-CONV-701
5. Feature flag: `rbac.operational_scopes_v2`
6. Migration impact: None
7. Primary touchpoints:
   - `./src/api/http/routes/friday-provider-routes.ts`
   - `./src/api/http/routes/friday-provider-usage-routes.ts`
8. Implementation checklist:
   - Map read/write/validate/usage endpoints to dedicated scopes.
   - Preserve compatibility with `hub.admin` during transition.
9. Acceptance criteria:
   - Provider operations no longer require broad admin by default.

### FRI-CONV-703 — Memory route remap to least privilege

1. Type: Story
2. Priority: P2
3. Estimate: 5 SP
4. Depends on: FRI-CONV-701
5. Feature flag: `rbac.operational_scopes_v2`
6. Migration impact: None
7. Primary touchpoints:
   - `./src/api/http/routes/friday-memory-routes.ts`
8. Implementation checklist:
   - Map read/write/prune endpoints to dedicated scopes.
   - Verify memory guard behavior unchanged.
9. Acceptance criteria:
   - Memory operators can function with least privilege roles.

### FRI-CONV-704 — Security route review and scope decision

1. Type: Story
2. Priority: P2
3. Estimate: 3 SP
4. Depends on: FRI-CONV-701
5. Feature flag: `rbac.operational_scopes_v2`
6. Migration impact: None
7. Primary touchpoints:
   - `./src/api/http/routes/friday-security-routes.ts`
8. Implementation checklist:
   - Evaluate route risk and split or retain scope mapping.
   - Document rationale for each security route scope.
9. Acceptance criteria:
   - Security reviewer signs off route-level scope mapping.

### FRI-CONV-705 — Operational RBAC regression tests

1. Type: Story
2. Priority: P2
3. Estimate: 5 SP
4. Depends on: FRI-CONV-702, FRI-CONV-703, FRI-CONV-704
5. Feature flag: `rbac.operational_scopes_v2`
6. Migration impact: None
7. Primary touchpoints:
   - `./test/e2e/api`
8. Implementation checklist:
   - Add role matrix tests for provider/memory/security routes.
   - Add transition compatibility tests.
9. Acceptance criteria:
   - No unauthorized access regression across operational APIs.

## 19.8 EPIC-8 Session key usability and canonicalization

### FRI-CONV-801 — Session key canonicalization spec

1. Type: Story
2. Priority: P2
3. Estimate: 2 SP
4. Depends on: none
5. Feature flag: `sessions.input_canonicalization`
6. Migration impact: None
7. Primary touchpoints:
   - `./src/sessions/services/friday-session-key.ts`
8. Implementation checklist:
   - Document accepted shorthand forms.
   - Define deterministic mapping and ambiguity rejection rules.
9. Acceptance criteria:
   - Canonicalization behavior is deterministic and testable.

### FRI-CONV-802 — Implement canonicalization and actionable errors

1. Type: Story
2. Priority: P2
3. Estimate: 5 SP
4. Depends on: FRI-CONV-801
5. Feature flag: `sessions.input_canonicalization`
6. Migration impact: None
7. Primary touchpoints:
   - `./src/sessions/services/friday-session-key.ts`
   - `./src/api/http/routes/friday-session-routes.ts`
8. Implementation checklist:
   - Add input layer canonicalization.
   - Upgrade error payloads with concrete examples.
   - Keep strict internal canonical parser untouched.
9. Acceptance criteria:
   - Common malformed inputs now return actionable guidance or safe normalization.

### FRI-CONV-803 — Session API and client tests

1. Type: Task
2. Priority: P2
3. Estimate: 3 SP
4. Depends on: FRI-CONV-802
5. Feature flag: `sessions.input_canonicalization`
6. Migration impact: None
7. Primary touchpoints:
   - `./test/unit/sessions`
   - `./test/e2e/api`
8. Implementation checklist:
   - Add canonicalization unit tests.
   - Add API tests for error message quality.
9. Acceptance criteria:
   - Validation quality remains stable under regression.

## 19.9 EPIC-9 Capability handshake and frontend contract gating

### FRI-CONV-901 — Define capability payload and versioning

1. Type: Story
2. Priority: P1
3. Estimate: 3 SP
4. Depends on: none
5. Feature flag: `capabilities.handshake_v1`
6. Migration impact: None
7. Primary touchpoints:
   - `./src/api/http/routes/friday-health-routes.ts`
   - `./src/api/runtime/friday-api-runtime.ts`
8. Implementation checklist:
   - Define payload fields: module availability, plugin mode, channel kinds, auth policy.
   - Add payload version field.
9. Acceptance criteria:
   - Capability payload schema approved and documented.

### FRI-CONV-902 — Backend capability endpoint implementation

1. Type: Story
2. Priority: P1
3. Estimate: 5 SP
4. Depends on: FRI-CONV-901
5. Feature flag: `capabilities.handshake_v1`
6. Migration impact: None
7. Primary touchpoints:
   - `./src/api/http/routes/friday-health-routes.ts`
9. Implementation checklist:
   - Return runtime mode and enabled feature surface.
   - Add conservative defaults for unknown fields.
10. Acceptance criteria:
   - Endpoint returns deterministic capability payload on startup and steady-state.

### FRI-CONV-903 — Frontend capability bootstrap and action gating

1. Type: Story
2. Priority: P1
3. Estimate: 8 SP
4. Depends on: FRI-CONV-902
5. Feature flag: `capabilities.handshake_v1`
6. Migration impact: None
7. Primary touchpoints:
   - `./ui/src/providers/auth-provider.tsx`
   - `./ui/src/router.tsx`
   - `./ui/src/routes`
8. Implementation checklist:
   - Load capabilities at app bootstrap.
   - Gate unsupported controls across plugin/setup/skills/automations views.
   - Add fallback text for unavailable capabilities.
9. Acceptance criteria:
   - UI does not expose unsupported operations.
10. Required tests:
   - UI integration tests with mocked capability variants.

## 19.10 EPIC-10 Build discoverability alignment

### FRI-CONV-1001 — Navigation exposure adjustment

1. Type: Story
2. Priority: P2
3. Estimate: 3 SP
4. Depends on: none
5. Feature flag: `ui.build_nav_default_visible`
6. Migration impact: None
7. Primary touchpoints:
   - `./ui/src/components/layout/sidebar.tsx`
8. Implementation checklist:
   - Move workflows/sessions/memory into default nav.
   - Keep power mode for advanced/experimental controls only.
9. Acceptance criteria:
   - Build features are discoverable without hidden toggle.

### FRI-CONV-1002 — First-login onboarding hint

1. Type: Task
2. Priority: P3
3. Estimate: 2 SP
4. Depends on: FRI-CONV-1001
5. Feature flag: `ui.build_nav_default_visible`
6. Migration impact: None
7. Primary touchpoints:
   - `./ui/src/routes`
8. Implementation checklist:
   - Show one-time guidance callout for build features.
9. Acceptance criteria:
   - New users see discoverability hint once.

## 19.11 EPIC-11 Critical-path test unskip and infra wiring

### FRI-CONV-1101 — Extend API test server helper for optional services

1. Type: Story
2. Priority: P3
3. Estimate: 8 SP
4. Depends on: none
5. Feature flag: N/A
6. Migration impact: None
7. Primary touchpoints:
   - `./test/e2e/api/_helpers/friday-api-test-server.helper.ts`
8. Implementation checklist:
   - Add optional wiring for memory/skills/plugins runtime dependencies.
   - Keep fast default profile.
9. Acceptance criteria:
   - Helper can boot required service combinations for skipped suites.

### FRI-CONV-1102 — Unskip skills route E2E suite

1. Type: Story
2. Priority: P3
3. Estimate: 3 SP
4. Depends on: FRI-CONV-1101
5. Feature flag: N/A
6. Migration impact: None
7. Primary touchpoints:
   - `./test/e2e/api/friday-api-skills-routes.test.ts`
8. Acceptance criteria:
   - Suite runs green in CI.

### FRI-CONV-1103 — Unskip plugins route E2E suite

1. Type: Story
2. Priority: P3
3. Estimate: 3 SP
4. Depends on: FRI-CONV-1101
5. Feature flag: N/A
6. Migration impact: None
7. Primary touchpoints:
   - `./test/e2e/api/friday-api-plugins-routes.test.ts`
8. Acceptance criteria:
   - Suite runs green in CI.

### FRI-CONV-1104 — Unskip sessions-memory route E2E suite

1. Type: Story
2. Priority: P3
3. Estimate: 3 SP
4. Depends on: FRI-CONV-1101
5. Feature flag: N/A
6. Migration impact: None
7. Primary touchpoints:
   - `./test/e2e/api/friday-api-sessions-memory-routes.test.ts`
8. Acceptance criteria:
   - Suite runs green in CI.

### FRI-CONV-1105 — Nightly full matrix pipeline

1. Type: Task
2. Priority: P3
3. Estimate: 3 SP
4. Depends on: FRI-CONV-1102, FRI-CONV-1103, FRI-CONV-1104
5. Feature flag: N/A
6. Migration impact: None
7. Primary touchpoints:
   - CI workflow config files
8. Acceptance criteria:
   - Nightly job runs expanded route matrix and reports failures.

## 19.12 EPIC-12 Release hardening, canary, and rollback readiness

### FRI-CONV-1201 — Migration and rollback runbook

1. Type: Task
2. Priority: P1
3. Estimate: 3 SP
4. Depends on: all additive migration stories
5. Feature flag: N/A
6. Migration impact: Additive
7. Primary touchpoints:
   - `./docs`
8. Implementation checklist:
   - Provide step-by-step rollout and rollback procedures.
   - Include feature flag toggles and emergency fallback matrix.
9. Acceptance criteria:
   - On-call can execute rollback without developer intervention.

### FRI-CONV-1202 — Canary checklist and production gate script

1. Type: Task
2. Priority: P1
3. Estimate: 3 SP
4. Depends on: all P0/P1 stories done
5. Feature flag: N/A
6. Migration impact: None
7. Primary touchpoints:
   - CI/CD pipeline config
8. Implementation checklist:
   - Encode gate checks for critical suites, capability mismatch, scope regression.
   - Define promotion criteria after 48h canary.
9. Acceptance criteria:
   - Promotion blocked automatically if any gate fails.

### FRI-CONV-1203 — Post-release verification and deprecation switch plan

1. Type: Task
2. Priority: P2
3. Estimate: 2 SP
4. Depends on: FRI-CONV-1202
5. Feature flag: N/A
6. Migration impact: None
7. Primary touchpoints:
   - Release notes and operation docs
8. Implementation checklist:
   - Define timeline to remove compatibility windows.
   - Define telemetry threshold to retire legacy scope acceptance.
9. Acceptance criteria:
   - Clear date-based and metric-based deprecation criteria published.

## 20) Dependency chain (execution order)

1. FRI-CONV-101 -> 102 -> 103 -> 104
2. FRI-CONV-201 -> 202 -> 203
3. FRI-CONV-301 -> 302 and 303
4. FRI-CONV-401 -> 402 -> 403 -> 404 -> 405
5. FRI-CONV-501 -> 502 -> 503
6. FRI-CONV-601 -> 602 -> 603 and 604
7. FRI-CONV-701 -> 702 and 703 and 704 -> 705
8. FRI-CONV-801 -> 802 -> 803
9. FRI-CONV-901 -> 902 -> 903
10. FRI-CONV-1001 -> 1002
11. FRI-CONV-1101 -> 1102 and 1103 and 1104 -> 1105
12. FRI-CONV-1201 and 1202 -> 1203

## 21) Sprint cut proposal

### Sprint 1 (blockers and high-risk)

1. FRI-CONV-101
2. FRI-CONV-102
3. FRI-CONV-103
4. FRI-CONV-201
5. FRI-CONV-202
6. FRI-CONV-301
7. FRI-CONV-302
8. FRI-CONV-901
9. FRI-CONV-902

### Sprint 2 (permission convergence)

1. FRI-CONV-601
2. FRI-CONV-602
3. FRI-CONV-603
4. FRI-CONV-604
5. FRI-CONV-701
6. FRI-CONV-702
7. FRI-CONV-703
8. FRI-CONV-704
9. FRI-CONV-705

### Sprint 3 (feature closure and UX consistency)

1. FRI-CONV-401
2. FRI-CONV-402
3. FRI-CONV-403
4. FRI-CONV-404
5. FRI-CONV-405
6. FRI-CONV-501
7. FRI-CONV-502
8. FRI-CONV-503
9. FRI-CONV-303
10. FRI-CONV-1001
11. FRI-CONV-1002

### Sprint 4 (test debt and release)

1. FRI-CONV-801
2. FRI-CONV-802
3. FRI-CONV-803
4. FRI-CONV-1101
5. FRI-CONV-1102
6. FRI-CONV-1103
7. FRI-CONV-1104
8. FRI-CONV-1105
9. FRI-CONV-1201
10. FRI-CONV-1202
11. FRI-CONV-1203
12. FRI-CONV-203
13. FRI-CONV-903

## 22) Ticket template (copy/paste)

Use this exact structure for each Jira/Linear item:

1. Title
2. Problem
3. Scope
4. Out of scope
5. Primary file touchpoints
6. Implementation checklist
7. Acceptance criteria
8. Test plan
9. Rollout plan
10. Rollback plan
11. Risks and mitigations
12. Dependencies
13. Evidence required for closure

## 23) Severity prevention checklist per merged ticket

1. Auth changes include fail-closed checks and explicit audit logs.
2. Scope changes include compatibility and telemetry.
3. UI exposure changes include capability-gating tests.
4. Scheduler changes include idempotency and duplicate-run tests.
5. Setup changes include drift tests against canonical channel kinds.
6. Plugin changes include mode visibility and action disable behavior.

## 24) Management dashboard metrics

Track weekly:

1. P0 open count
2. P1 open count
3. Critical suite skip count
4. Capability mismatch defects discovered in QA
5. Auth/RBAC 403 false-positive rate
6. Scheduled automation duplicate-run incident count
7. Rollback drill pass rate

## 25) Go-live criteria summary

Release promotion is allowed only if all are true:

1. All P0 and P1 issues are Done.
2. Critical path skip count is zero.
3. Canary 48h has no unresolved P0/P1 incident.
4. Capability mismatch bugs in canary are zero.
5. Security reviewer approves RBAC scope matrix.
6. Rollback drill has passed on target release build.
