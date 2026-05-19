# Phase 21 Real-Code Proof Matrix

Baseline: `origin/main` at PR #269 merge commit `b8b9c19` (full SHA stored split in JSON to avoid secret-scanner false positives).

Scope: Phase 21A evidence only. This file records what was proven against real current code before fixing Phase 21B-F. It does not claim any issue is fixed.

## Commands Run

```bash
git status --short --branch
npm exec vitest run test/unit/api/http/routes/friday-auto-fix-routes.test.ts test/unit/api/http/routes/friday-diagnosis-routes.test.ts test/e2e/api/friday-api-self-healing-routes.test.ts test/e2e/api/friday-api-auto-fix-doctor.acceptance.test.ts test/unit/learning/services/friday-system-health-monitor.test.ts test/unit/agent/runtime/friday-agent-preference-injector.test.ts test/unit/learning/services/friday-preference-extraction-service.test.ts test/unit/uix/services/friday-communication-persona.test.ts test/unit/api/http/routes/friday-skill-generator-routes.test.ts test/unit/ui/skill-generator-page.test.ts
FRIDAY_PHASE21A_ASSERT_KNOWN_VULN=1 npm exec vitest run test/e2e/api/friday-api-phase21-cross-user-proof.test.ts
npm exec vitest run test/e2e/api/friday-api-phase21-cross-user-proof.test.ts
npm exec vitest run test/unit/workflows/generator/services/friday-workflow-generator-service.test.ts test/unit/autonomy/friday-workflow-upgrade-lifecycle-service.test.ts test/unit/autonomy/friday-controlled-autonomy-services.test.ts test/unit/skills/generator/services/friday-skill-generator-service.test.ts test/unit/ui/skill-generator-page.test.ts test/unit/agent/tools/friday-agent-skills-list-tool.test.ts test/unit/workflows/builder/friday-workflow-builder-validation-service.test.ts test/unit/api/http/routes/friday-uix-routes.test.ts test/unit/hub/friday-hub-bootstrap.test.ts
npm exec vitest run test/unit/api/http/routes/friday-auto-fix-routes.test.ts test/unit/api/http/routes/friday-diagnosis-routes.test.ts test/unit/learning/services/friday-system-health-monitor.test.ts test/unit/agent/runtime/friday-agent-preference-injector.test.ts test/unit/api/http/routes/friday-skill-generator-routes.test.ts test/unit/workflows/generator/services/friday-workflow-generator-service.test.ts test/unit/autonomy/friday-controlled-autonomy-services.test.ts
npm exec vitest run test/e2e/api/friday-api-auto-fix-doctor.acceptance.test.ts test/unit/ui/home-self-repair.test.ts test/unit/learning/services/friday-auto-fix-rollback-service.test.ts
npm run check:secret-patterns
git diff --check
```

The cross-user proof fixture is committed as `test/e2e/api/friday-api-phase21-cross-user-proof.test.ts`. It is skipped by default and only runs with `FRIDAY_PHASE21A_ASSERT_KNOWN_VULN=1`, so normal CI does not preserve the known-bad assertion after Phase 21B fixes the routes.

## Summary

| Issue | Outcome | Phase | Blocking | Decision | Plain Example |
|---|---|---|---|---|---|
| P21-001 | verified_true | 21B | yes | No, security boundary fix. | User B guesses User A's repair action id and opens or approves it. |
| P21-002 | verified_true | 21B | yes | No, security boundary fix. | User B opens User A's private failure report or marks it resolved. |
| P21-003 | verified_true | 21C | yes | Yes: choose exact cleanup gate shape before 21C implementation. | Friday deletes old memory/checkpoints during health monitoring without a user-visible repair receipt. |
| P21-004 | verified_partial_existing_mitigations | 21D | yes | No, additive truth fix. | '5 auto-fixes' may mean 5 attempts, not 5 issues actually repaired. |
| P21-005 | verified_true | 21D | yes | No, additive evidence fix. | Friday tries to rollback, it fails, then the action detail later looks like rollback was never attempted. |
| P21-006 | verified_nuanced_needs_decision | 21E | maybe | Yes: wire bounded low-risk injector now, or keep non-claim and prove current boundary. | User says 'always challenge me'; Friday may only apply it reliably after Review Center confirmation, not from every inferred learned fact. |
| P21-007 | verified_partial_existing_guards | 21E | maybe | Yes for UX strictness and friction level. | 'I prefer X?' could be treated as a durable preference if it matches a rule strongly enough. |
| P21-008 | verified_true_with_existing_backend_fix | 21F | yes | No, truth/contract fix. | UI says success, but the skill is only staged as a candidate and agent cannot run it yet. |
| P21-009 | verified_truth_boundary | 21F | yes | No, wording/contract truth fix unless API behavior is changed. | Published workflow is usable as a published version, but not equivalent to a canary-promoted upgrade. |
| P21-010 | verified_true_needs_wording_or_state_decision | 21F | yes | Maybe if renaming API status; additive wording is lower risk. | 'Verified' sounds ready like a provider credential worked, but it may only mean a local generated candidate passed sandbox. |

## Detailed Matrix

### P21-001 — 21B

- Severity: `P0`
- Outcome: `verified_true`
- Release blocking if verified: `yes`
- Problem: Auto-fix action routes read/write by actionId without owner binding.
- Impact: Cross-user repair visibility and approval/execution/rollback risk.
- Why it exists: List routes are user-scoped, but item routes require a principal then call service methods with actionId only; service and repository lookups are actionId-only.
- Fix effect: Pass current userId through routes/service/repository checks; return 404/403 for non-owner reads and writes; add cross-user denial tests.
- Decision needed: No, security boundary fix.
- Plain example: User B guesses User A's repair action id and opens or approves it.
- Code evidence: src/api/http/routes/friday-auto-fix-routes.ts get/approve/deny/execute/rollback handlers; src/learning/services/friday-self-healing-api-service.ts getAction/approveAction/executeAction/rollbackAction; src/learning/persistence/friday-auto-fix-action-repository.ts getById.
- Test evidence: Reproducible audit fixture added at test/e2e/api/friday-api-phase21-cross-user-proof.test.ts. It is skipped by default and runs only with FRIDAY_PHASE21A_ASSERT_KNOWN_VULN=1 so it does not lock the bug into normal CI.
- Real runtime/API/UI proof command: `FRIDAY_PHASE21A_ASSERT_KNOWN_VULN=1 npm exec vitest run test/e2e/api/friday-api-phase21-cross-user-proof.test.ts`
- Proof result: PASS: 1 file, 2 tests. Non-owner userB GET /v1/auto-fix/actions/:id returned 200 for userA action on baseline b8b9c19. Default run without env skips 2 tests, proving CI will not preserve the vulnerability assertion after 21B.
- Next action: Implement 21B owner-scoped action access and permanent denial tests.

### P21-002 — 21B

- Severity: `P0`
- Outcome: `verified_true`
- Release blocking if verified: `yes`
- Problem: Diagnosis incident routes read/resolve by incidentId without owner binding.
- Impact: Cross-user incident visibility and manual-resolve control risk.
- Why it exists: Incident list is user-scoped, but get/diagnosis/manual-resolve require only any userId and then call incidentId-only service/repository methods.
- Fix effect: Pass current userId through incident get/diagnosis/manual-resolve; return 404/403 for non-owner; add cross-user denial tests.
- Decision needed: No, security boundary fix.
- Plain example: User B opens User A's private failure report or marks it resolved.
- Code evidence: src/api/http/routes/friday-diagnosis-routes.ts getIncident/getIncidentDiagnosis/manualResolve; src/learning/services/friday-self-healing-api-service.ts getIncident/getIncidentDiagnosis/manualResolveIncident; src/learning/persistence/friday-error-incident-repository.ts getById.
- Test evidence: Reproducible audit fixture added at test/e2e/api/friday-api-phase21-cross-user-proof.test.ts. It is skipped by default and runs only with FRIDAY_PHASE21A_ASSERT_KNOWN_VULN=1 so it does not lock the bug into normal CI.
- Real runtime/API/UI proof command: `FRIDAY_PHASE21A_ASSERT_KNOWN_VULN=1 npm exec vitest run test/e2e/api/friday-api-phase21-cross-user-proof.test.ts`
- Proof result: PASS: 1 file, 2 tests. Non-owner userB GET /v1/diagnosis/incidents/:id and POST /manual-resolve returned 200 for userA incident on baseline b8b9c19. Default run without env skips 2 tests.
- Next action: Implement 21B owner-scoped incident access and permanent denial tests.

### P21-003 — 21C

- Severity: `P0`
- Outcome: `verified_true`
- Release blocking if verified: `yes`
- Problem: System health monitor performs data-changing cleanup outside auto-fix approval/rollback/evidence path.
- Impact: Silent data loss or hidden maintenance writes from default scheduler.
- Why it exists: createFridaySystemHealthMonitor.runAll auto-runs autoFix on unhealthy checks; hub registers system-health-monitor every 5 minutes; job scheduler starts immediate interval jobs.
- Fix effect: Make system health diagnose-only by default; data-changing cleanup must be explicit, gated, auditable, and receipted or moved into supervised auto-fix.
- Decision needed: Yes: choose exact cleanup gate shape before 21C implementation.
- Plain example: Friday deletes old memory/checkpoints during health monitoring without a user-visible repair receipt.
- Code evidence: src/learning/services/friday-system-health-monitor.ts autoFix blocks; src/hub/friday-hub-bootstrap.ts registers system-health-monitor; src/jobs/scheduler/friday-job-scheduler-service.ts immediate interval behavior.
- Test evidence: npm exec vitest run test/unit/learning/services/friday-system-health-monitor.test.ts passed; current tests confirm risky auto-fix behavior instead of deny it.
- Real runtime/API/UI proof command: `Read-only code proof plus focused unit test: npm exec vitest run test/unit/learning/services/friday-system-health-monitor.test.ts`
- Proof result: 6/6 pass; test 'triggers auto-fix when expired memory items exceed threshold' locks current risky behavior.
- Next action: Ask/confirm 21C gate choice, then implement diagnose-only default and cleanup receipt tests.

### P21-004 — 21D

- Severity: `P1`
- Outcome: `verified_partial_existing_mitigations`
- Release blocking if verified: `yes`
- Problem: autoFixActions count is an action count, not a verified repair count.
- Impact: API/product trust risk if action count is read as fixed count.
- Why it exists: Learning overview coverage counts rows in auto_fix_actions; repairOutcome exists per action but overview lacks verified/diagnostic/failed/rolled-back buckets.
- Fix effect: Expose recorded actions and verified repair buckets separately; keep UI wording tied to verified outcomes.
- Decision needed: No, additive truth fix.
- Plain example: '5 auto-fixes' may mean 5 attempts, not 5 issues actually repaired.
- Code evidence: src/learning/services/friday-self-healing-api-service.ts coverage.autoFixActions; deriveAutoFixRepairOutcome; ui/src/components/core/learning-insight-card.tsx wording.
- Test evidence: Existing focused tests pass. Code audit found UI wording mitigation in home/insight surfaces, but this is not treated as closure proof because the API still lacks machine-readable outcome buckets.
- Real runtime/API/UI proof command: `npm exec vitest run test/e2e/api/friday-api-auto-fix-doctor.acceptance.test.ts test/unit/ui/home-self-repair.test.ts test/unit/learning/services/friday-auto-fix-rollback-service.test.ts`
- Proof result: PASS: 3 files, 12 tests. Proves current per-action repairOutcome and UI wording mitigation; does not prove overview autoFixActions is a verified repair count.
- Next action: Implement 21D coverage outcome buckets and tests.

### P21-005 — 21D

- Severity: `P1`
- Outcome: `verified_true`
- Release blocking if verified: `yes`
- Problem: Rollback attempt/failure receipt is incomplete after failed rollback.
- Impact: User cannot later tell whether rollback was attempted and why it failed.
- Why it exists: Rollback response can return attempted=false/true, but action evidence later derives rollbackAttempted from action.status === rolled_back; failed attempts are not persisted.
- Fix effect: Persist rollback attempt/succeeded/error evidence and expose it in GET receipts.
- Decision needed: No, additive evidence fix.
- Plain example: Friday tries to rollback, it fails, then the action detail later looks like rollback was never attempted.
- Code evidence: src/learning/services/friday-self-healing-api-service.ts rollbackResult derivation; src/learning/services/friday-auto-fix-rollback-service.ts failed rollback return paths; src/learning/model/friday-auto-fix.types.ts lacks rollback attempt fields.
- Test evidence: Existing rollback/execution tests pass, but they cover immediate rollback behavior rather than durable GET-after-failed-rollback receipt.
- Real runtime/API/UI proof command: `npm exec vitest run test/e2e/api/friday-api-auto-fix-doctor.acceptance.test.ts test/unit/ui/home-self-repair.test.ts test/unit/learning/services/friday-auto-fix-rollback-service.test.ts`
- Proof result: PASS: 3 files, 12 tests. Confirms existing rollback behaviors still pass; code audit shows failed-attempt receipt is not persisted for later action detail.
- Next action: Implement 21D persistent rollback attempt/error receipt and permanent test.

### P21-006 — 21E

- Severity: `P1`
- Outcome: `verified_nuanced_needs_decision`
- Release blocking if verified: `maybe`
- Problem: Learned preferences do not all enter prompts; some do by communication/reflex paths, raw learned facts do not.
- Impact: Overclaim risk for memory/personalization; possible behavior mismatch for 'always challenge me' if not confirmed through Reflex/User Constitution.
- Why it exists: createFridayPreferenceInjector exists with good gates but is test-only; production runtime uses communicationPromptBuilder and confirmed Reflex/User Constitution fragments instead of raw learned preference injection.
- Fix effect: Either document/test non-claim or wire a bounded low-risk injector; high-impact execution/security/memory/testing preferences must remain review-gated.
- Decision needed: Yes: wire bounded low-risk injector now, or keep non-claim and prove current boundary.
- Plain example: User says 'always challenge me'; Friday may only apply it reliably after Review Center confirmation, not from every inferred learned fact.
- Code evidence: src/agent/runtime/friday-agent-runtime.ts learningContextBuilder/communicationPromptBuilder; src/hub/friday-hub-bootstrap.ts buildMergedPreferenceContext/buildReflexPreferencePromptFragment; src/agent/runtime/friday-agent-preference-injector.ts.
- Test evidence: npm exec vitest run test/unit/agent/runtime/friday-agent-preference-injector.test.ts test/unit/uix/services/friday-communication-persona.test.ts test/unit/hub/friday-hub-bootstrap.test.ts; all passed.
- Real runtime/API/UI proof command: `Focused tests above plus code audit of runtime prompt path.`
- Proof result: Existing code intentionally separates learned facts from confirmed preferences; no false blanket injection found.
- Next action: Use 21E decision gate before implementation.

### P21-007 — 21E

- Severity: `P1`
- Outcome: `verified_partial_existing_guards`
- Release blocking if verified: `maybe`
- Problem: Learned preference extraction is broad enough to infer durable preferences from ordinary messages.
- Impact: Wrong or casual preference can become a learned fact if phrasing matches broad regex rules.
- Why it exists: Preference extraction has broad 'prefer/always use/don't use/call me' rules; mitigated by first inferred confidence cap for sub-0.8 persona rules and Review Center gating for high-impact Reflex preferences.
- Fix effect: Tighten confidence/review rules for inferred preferences, or document boundaries and add proof that high-impact preferences remain gated.
- Decision needed: Yes for UX strictness and friction level.
- Plain example: 'I prefer X?' could be treated as a durable preference if it matches a rule strongly enough.
- Code evidence: src/learning/services/friday-preference-extraction-service.ts; src/learning/services/friday-preference-fact-service.ts; src/reflex/services/friday-reflex-preference-sensitivity.ts; src/api/http/routes/friday-uix-routes.ts learned facts/revoke routes.
- Test evidence: npm exec vitest run test/unit/learning/services/friday-preference-extraction-service.test.ts test/unit/api/http/routes/friday-uix-routes.test.ts; all passed.
- Real runtime/API/UI proof command: `Focused tests above plus code audit of active fact threshold 0.60 and high-impact confirmation set.`
- Proof result: Existing coverage proves extraction and revoke surfaces, but not enough product-level proof of 'no wrong preference influence'.
- Next action: Route to 21E; decide stricter review/default behavior.

### P21-008 — 21F

- Severity: `P1`
- Outcome: `verified_true_with_existing_backend_fix`
- Release blocking if verified: `yes`
- Problem: Skill generator approve stages a candidate, not an installed/promoted/runnable skill; UI/API type drift still exists.
- Impact: User/developer may think a generated skill is immediately runnable; TypeScript client can misrepresent backend state.
- Why it exists: Backend now returns promotionStage candidate_staged and registryRefreshed false, but ui/src/lib/api/types.ts still says promotionStage 'stabilized' and omits candidateId/candidateDir.
- Fix effect: Align UI client types/copy with candidate_staged; show candidate identity; keep generated skill unavailable until lifecycle promotion.
- Decision needed: No, truth/contract fix.
- Plain example: UI says success, but the skill is only staged as a candidate and agent cannot run it yet.
- Code evidence: src/skills/generator/services/friday-skill-generator-service.ts approveAndSave; src/api/model/friday-api-skill-generator.types.ts; ui/src/lib/api/types.ts stale ApproveResponse; ui/src/routes/skill-generator-page.tsx receipt.
- Test evidence: npm exec vitest run test/unit/skills/generator/services/friday-skill-generator-service.test.ts test/unit/api/http/routes/friday-skill-generator-routes.test.ts test/unit/ui/skill-generator-page.test.ts; all passed.
- Real runtime/API/UI proof command: `Focused skill tests above; code audit finds stale UI API type despite backend truth.`
- Proof result: Focused skill tests passed; backend truth is mostly fixed, UI client contract still drifts.
- Next action: Implement 21F UI type/copy/contract reconciliation and tests.

### P21-009 — 21F

- Severity: `P1`
- Outcome: `verified_truth_boundary`
- Release blocking if verified: `yes`
- Problem: Workflow generator publish is not the same as workflow upgrade lifecycle shadow/canary/promote proof.
- Impact: Overclaim self-upgrade if published workflow is described as lifecycle-promoted or canary-proven.
- Why it exists: Workflow generator approveAndSave creates/publishes via CRUD; workflow upgrade lifecycle service exists separately for shadow/canary/promote/rollback and is not invoked by generator publish.
- Fix effect: Keep generator language as publish/save; reserve lifecycle promotion wording for explicit upgrade lifecycle routes and evidence.
- Decision needed: No, wording/contract truth fix unless API behavior is changed.
- Plain example: Published workflow is usable as a published version, but not equivalent to a canary-promoted upgrade.
- Code evidence: src/workflows/generator/services/friday-workflow-generator-service.ts approveAndSave publishVersion path; src/autonomy/services/friday-workflow-upgrade-lifecycle-service.ts separate lifecycle; ui workflow publish copy.
- Test evidence: npm exec vitest run test/unit/workflows/generator/services/friday-workflow-generator-service.test.ts test/unit/autonomy/friday-workflow-upgrade-lifecycle-service.test.ts; all passed.
- Real runtime/API/UI proof command: `Focused workflow tests above; code audit confirms two separate mechanisms.`
- Proof result: Focused workflow tests passed; mechanisms are separate and must remain separately worded.
- Next action: Implement 21F docs/UI/API receipt wording if any copy conflates publish with lifecycle proof.

### P21-010 — 21F

- Severity: `P1`
- Outcome: `verified_true_needs_wording_or_state_decision`
- Release blocking if verified: `yes`
- Problem: Capability acquisition status 'verified' can mean generated/local candidate passed sandbox/dry-run and was registered available, not necessarily installed external/live capability.
- Impact: Overclaim risk: 'verified' sounds fully installed/live when evidence may only be sandbox/local proof.
- Why it exists: approveRun treats skill_generator/workflow_generator/studio_artifact/builtin_catalog as passed without live external matrix confirmation; evidence text says sandbox/doctor dry-run accepted, but status is 'verified'.
- Fix effect: Add clearer state/explanation or additive fields distinguishing live_runtime_verified from local_candidate_registered; avoid breaking API unless explicitly approved.
- Decision needed: Maybe if renaming API status; additive wording is lower risk.
- Plain example: 'Verified' sounds ready like a provider credential worked, but it may only mean a local generated candidate passed sandbox.
- Code evidence: src/autonomy/services/friday-capability-acquisition-service.ts approveRun; src/api/http/routes/friday-autonomy-routes.ts capability routes; test/unit/autonomy/friday-controlled-autonomy-services.test.ts status verified for generated/studio candidates.
- Test evidence: npm exec vitest run test/unit/autonomy/friday-controlled-autonomy-services.test.ts; passed.
- Real runtime/API/UI proof command: `Focused autonomy tests above; code audit confirms status/evidence mismatch risk.`
- Proof result: Focused autonomy tests passed; status wording is the risk, not missing route wiring.
- Next action: Route to 21F; decide additive wording vs API state rename.

## Decisions Needed Before Fixes

1. **21C cleanup gate:** recommended default is diagnose-only. For data-changing cleanup, choose supervised auto-fix approval path or explicit maintenance env/admin gate with non-reversible receipt.
2. **21E preference injection:** choose whether to wire a bounded low-risk injector now, or keep the current boundary and document/test the non-claim. High-impact preferences must remain Review Center confirmed either way.
3. **21F capability state naming:** prefer additive wording/fields first; API status rename needs compatibility approval.

## Notes

- Existing focused tests pass, but several tests currently lock risky behavior rather than prevent it.
- No channel/cloud/Phase 20 claims are included.
- `blocked_by_env`, mock-only proof, green tests, and workflow success alone remain non-release-proof.
