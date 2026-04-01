# Friday Self-Evolution P0/P1/P2 Implementation Status (2026-04-01)

## Confirmed Completed

- `actual_execution_json` now persists route truth for terminal and waiting states, including:
  - `completed`
  - `failed`
  - `awaiting_clarification`
  - `awaiting_plan_approval`
- Agent runtime now emits stable route events:
  - `agent.run.route_selected`
  - `agent.run.route_fallback`
  - `agent.run.route_mismatch`
- Model selection priority is now enforced as:
  1. explicit `providerId + model`
  2. explicit `model`
  3. `taskProfile.model`
  4. route default
- Subagent runs now record whether model choice was:
  - explicit
  - profile-selected
  - inherited
- Text-only CLI backends are excluded from native-tool-required tasks through `routingContext.requiresNativeTools`.
- Low-risk self-healing has real hub-side execution support for:
  - `retry_node`
  - `switch_model_fallback`
  - `trim_payload`
  - `pause_workflow`
  - existing `disable_skill`
- Manual incident resolution now:
  - resolves the incident
  - rejects pending planned actions
  - upserts a lesson
  - emits `manual_resolved`
  - exposes matched lesson IDs through HTTP summaries
- Rejected auto-fix actions now emit structured negative learning signals via `autofix_rejected`.
- Pattern extraction now includes repeated preference/policy patterns rather than only basic episode/snapshot/entity persistence.
- Adaptive utility inputs are now wired into risk assessment:
  - historical success rate
  - route failure rate
  - lesson match count
  - pattern strength
  - rollback frequency
  - human rejection rate
  - policy budget state
- Auto-apply decisions now respect learned budget state and repeated rejection cooldowns.
- Dispatcher re-checks risk before auto-applying queued actions instead of blindly replaying a stale plan.
- Operator-facing learning controls now exist through API/service methods for:
  - routing explain
  - route pin
  - route penalty clear
  - learning overview
  - lesson enable/disable
  - pattern demotion

## Confirmed Validation

- `npm run build` passed on **2026-04-01**.
- `npm test` passed on **2026-04-01**.
  - Result: `695 passed | 5 skipped` files
  - Result: `9636 passed | 217 skipped` tests
- `npm run test:adversarial` had already passed earlier on **2026-04-01**.
- `test/e2e/api/friday-api-self-healing-routes.test.ts` passed on **2026-04-01** and now proves:
  - manual incident resolution works over the real API stack
  - a lesson is written in the in-memory test DB
  - matched lesson IDs are surfaced via HTTP
- `test/contracts/api/friday-api-route-contract.snapshot.test.ts` was refreshed and passed on **2026-04-01** after the new provider/learning routes were added.
- `test/e2e/mock/friday-mock-journeys.e2e.test.ts` failover scenario now deterministically exercises:
  - primary provider hit
  - `429` cooldown
  - fallback success

## Confirmed Runtime Boundaries

- Friday is now beyond “record only” for P0 and part of P1.
- Friday is **not yet** a fully self-evolving autonomous system.
- The implemented behavior today is:
  - route truth is recorded
  - incidents/diagnoses/actions are recorded
  - lessons can be produced from supervised/manual closure
  - patterns can be produced in repeated execution paths
  - learned signals can affect routing/risk scoring
- The current behavior is still intentionally bounded by:
  - approval gates
  - risk gates
  - supervised automation policy
  - operator override

## Confirmed Main DB Status

Querying the real local state DB at:

- `/Users/jarvis/Library/Application Support/Friday/state/friday.db`

on **2026-04-01** still shows:

- `learned_lessons = 0`
- `friday_learned_patterns = 0`
- `friday_episodes = 5`
- `friday_world_state_snapshots = 5`
- `friday_world_entities = 5`

This means:

- the code path is now implemented and test-verified
- the user’s current main runtime history has **not yet naturally accumulated**
  enough real incidents/repetitions to change those live counts

## Confirmed Non-Blockers

- The API route contract count increased from `250` to `257` because the new provider and learning control routes are now part of the real public contract.
- The mock failover scenario needed explicit route pinning to remain deterministic because routing is now allowed to reorder candidates for cost/learning reasons.
- These are not regressions in the product path; they are expected test-contract updates caused by the new routing model.

## Remaining Work

The following are still not implemented as a complete product surface:

- learned utility feedback exposed as a dedicated operator UX
- retry/self-healing/rollback budget dashboards
- operator-facing route/lesson/pattern management UI
- proof that the user’s main live runtime has accumulated:
  - `learned_lessons > 0`
  - `friday_learned_patterns > 0`

## Recommended Next Step

To prove the live main runtime has crossed from “implemented” to “naturally learning”:

1. Run one real supervised incident to completion:
   - incident
   - diagnosis
   - manual resolve or low-risk auto-fix
   - verification
   - lesson write
2. Repeat a similar task fingerprint at least twice.
3. Re-check the main DB counts for:
   - `learned_lessons`
   - `friday_learned_patterns`

Only after that should Friday be described as having demonstrated live learning in the user’s primary state DB.
