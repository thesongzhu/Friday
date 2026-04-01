# Friday Self-Evolution P0/P1 Implementation Status (2026-04-01)

## Confirmed

- `actual_execution_json` now persists richer route truth across completed, failed, `awaiting_clarification`, and `awaiting_plan_approval` paths.
- Agent runtime now emits stable route events:
  - `agent.run.route_selected`
  - `agent.run.route_fallback`
  - `agent.run.route_mismatch`
- Model selection now treats `taskProfile.model` as a real routing input when no explicit `model` override is present.
- Subagent spawning now records whether the child model was explicit, profile-selected, or inherited.
- Text-only CLI backends are excluded from native-tool-required tasks through `routingContext.requiresNativeTools`.
- Low-risk self-healing now has real hub-side execution support for:
  - `retry_node`
  - `switch_model_fallback`
  - `trim_payload`
  - `pause_workflow`
- Manual incident resolution now:
  - resolves the incident
  - upserts a lesson
  - emits a learning event
  - surfaces the learned lesson through the HTTP diagnosis summary
- Preference extraction now records negative routing signals from rejected auto-fix actions and positive signals from manual resolutions.
- Provider routing now uses historical route outcome bias and operator rejection penalties to reorder candidates without silently removing them.
- Pattern extraction now includes preference patterns derived from repeated successful episodes.

## Real Validation

- Focused unit coverage for runtime, planning gate, subagents, provider routing, preference extraction, self-healing execution, HTTP routes, and pattern extraction passed on **2026-04-01**.
- `test/e2e/api/friday-api-self-healing-routes.test.ts` passed on **2026-04-01**, including the new manual-resolution API path.
- `npm run build` passed on **2026-04-01**.

## Confirmed Gaps

- The real local state DB still shows:
  - `learned_lessons = 0`
  - `friday_learned_patterns = 0`
- This means the code path is now wired, but the user’s current real runtime history has not yet produced enough live events to prove:
  - successful lesson accumulation in the main state DB
  - positive or negative pattern upserts in the main state DB
- P2 work is still not implemented:
  - learned utility strategy
  - retry/self-healing/rollback budgets for learned policies
  - operator-facing lesson/pattern correction controls

## Recommended Next Step

- Run at least one real supervised incident through:
  - incident
  - diagnosis
  - low-risk action or manual resolution
  - verification
  - lesson extraction
- Then repeat a similar task fingerprint at least twice to confirm pattern upsert in the main state DB.
