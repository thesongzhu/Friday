> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Friday Agent Parity Acceptance Plan (Scope-Locked)

**Date:** 2026-03-01  
**Owner:** Platform  
**Mode:** Scope-locked execution (avoid feature drift)

---

## 1. Goal and Non-Goal Lock

### Goal (must match)

1. Friday must match the reference agent surface on overlapping runtime behavior:
   - multi-turn context truly reaches the model;
   - tool execution claims require execution evidence;
   - failed tool calls do not count as successful execution;
   - channel/API/session entrypoints are consistent.

2. Friday marketplace MVP must stay scope-locked:
   - asset types: `skill|workflow|agent`;
   - pricing types: `free|one_time`;
   - install-before-run guard remains enforceable.

### Non-goal (must not sneak in)

1. No subscription/usage-metering/rental lifecycle changes in MVP.
2. No silent API-surface expansion that bypasses review.
3. No cross-tenant data-plane access path.

---

## 2. Plan (Execution Sequence)

1. **Contract lock**
   - Keep MVP pricing and asset-type constants unchanged.
   - Keep runtime flags documented and wired (`commerce`, `install required`, `agent asset`).

2. **Linkage lock**
   - Ensure context history is injected in all critical executeRun entrypoints:
     - API runtime
     - Hub channel path
     - sessions tool
     - heartbeat runner

3. **Execution truth lock**
   - Keep completion-claim verification in runtime:
     - requires successful tool evidence for external-action completion claims.

4. **Automated guard in CI/quality pipeline**
   - Add a dedicated quality script to fail fast when any of the above invariants drift.

5. **Verification gate**
   - Run targeted unit tests + build + alignment guard before merge/release.

---

## 3. Implementation Done in This Change

1. Added alignment guard script:
   - `scripts/quality/check-openclaw-alignment-guard.mjs`
   - validates scope constants, critical runtime guards, context injection hooks, and runbook flag coverage.

2. Wired guard into local quality flow:
   - `npm run check:alignment`
   - included in `npm run check:all`

3. Wired guard into CI:
   - new `alignment-guard` job in `.github/workflows/ci.yml`
   - included in final `quality-gate` aggregator.

---

## 4. Release Acceptance Checklist

1. `npm run -s check:alignment`
2. `npm run -s check:all`
3. `npm run -s test:integration:agent-parity`
4. `npm run -s test -- test/unit/agent/runtime/friday-agent-runtime.test.ts test/unit/agent/tools/friday-agent-sessions-tool.test.ts test/unit/api/http/routes/friday-session-routes.test.ts test/unit/api/runtime/friday-api-runtime-session-registration.test.ts test/unit/heartbeat/friday-heartbeat-runner.test.ts`
5. `npm run -s build:api`

All must pass before merge/release.

---

## 5. Change-Control Rule

If someone intentionally expands beyond this scope, they must update all of:

1. this plan document;
2. the guard script invariants;
3. runtime runbook docs;
4. contracts/tests proving intended behavior.

No silent scope expansion is allowed.
