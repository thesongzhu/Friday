# CC Coding Standards — Mandatory Checklist

> Every CC (Claude Code) session MUST self-check against this list before submitting.
> These patterns are extracted from 6 modules of CX review findings.
> Violating any item = guaranteed NEEDS_FIX from CX.

---

## 1. Immutability

- [ ] **All public getters return deep-frozen immutable snapshots**
  - Use `structuredClone()` + recursive `Object.freeze()`
  - Create a module-local `cloneAndFreeze<T>(value: T): T` helper
  - Applies to: getters, query methods, any method returning internal state
  - **Test**: mutating returned object throws `TypeError`

```typescript
// ✅ Correct
getEntries(): Entry[] {
  return cloneAndFreeze(Array.from(this.entries.values()));
}

// ❌ Wrong — exposes mutable internal state
getEntries(): Entry[] {
  return Array.from(this.entries.values());
}
```

## 2. State Machine

- [ ] **Complete lifecycle transitions with explicit guards**
  - Define all valid states and transitions
  - Guard against invalid transitions (throw or return null)
  - Include `pending` states where applicable
  - **Test**: every transition edge + every invalid transition

- [ ] **No external mutation of state**
  - State changes ONLY through designated transition methods
  - Getters return immutable snapshots (see #1)

## 3. Rollback & Audit

- [ ] **Rollback/deactivation persists audit events**
  - Every destructive operation stores: reason, from/to state, timestamp, actor
  - **Test**: verify audit events are persisted with correct fields

- [ ] **Rollback is tested and safe**
  - Rollback restores previous known-good state
  - Rollback itself cannot leave system in inconsistent state

## 4. KPI Validation Tests

- [ ] **Every CSV KPI has a corresponding test assertion**
  - Read the KPI field from CSV for your module
  - Write test(s) that assert the threshold
  - Use fake timers for time-based KPIs (MTTD, latency)
  - Use batch operations for rate-based KPIs (success rate, hit rate)

```typescript
// Example: KPI "install success > 99%"
it("validates install success rate > 99%", () => {
  const results = Array.from({ length: 200 }, (_, i) =>
    installer.install(makePackage({ id: `pkg-${i}` }))
  );
  const successRate = results.filter(r => r.success).length / results.length;
  expect(successRate).toBeGreaterThan(0.99);
});
```

## 5. CSV Outputs Completeness

- [ ] **Every item in CSV "Outputs" field has a corresponding implementation**
  - Read Outputs field: e.g., "playbook store, promoter job, selector service"
  - Each output must exist as exported module/class/function
  - **Test**: at minimum, smoke test for each output

## 6. No Sentinel Values

- [ ] **Use nullable types instead of sentinel values**
  - No `""`, `0`, `-1`, `"none"` as placeholder values
  - Use `null` or `undefined` with proper types

```typescript
// ✅ Correct
playbookId: string | null;

// ❌ Wrong — sentinel value
playbookId: ""; // empty string as "no playbook"
```

## 7. Index/Cache Consistency

- [ ] **Update operations clean up stale index entries**
  - When an indexed field changes, remove old index → set new index
  - **Test**: update entity, verify old index cleared

## 8. Parallel Operations

- [ ] **Parallel operations have timeout guards**
  - Use `Promise.allSettled()` not `Promise.all()` for bulk operations
  - Each parallel task has individual timeout
  - **Test**: verify timeout handling produces correct error state

## 9. Deterministic Serialization

- [ ] **Fingerprinting/canonicalization sorts keys recursively**
  - `JSON.stringify` replacer array only sorts top-level keys
  - Use recursive stable stringify for any fingerprint/hash input
  - **Test**: different key orders produce same output; different values produce different output

## 10. Scope Isolation

- [ ] **Deduplication uses composite keys where needed**
  - If entities can exist in different scopes (workflow types, tenants, etc.)
  - Dedupe key must include scope identifier
  - **Test**: same fingerprint in different scopes = separate entities

## 11. Type Safety

- [ ] **`npx tsc --noEmit` passes with zero errors**
- [ ] **No `any` types unless explicitly justified**
- [ ] **No type assertions (`as`) unless explicitly justified**

## 12. Test Quality

- [ ] **All tests pass: `npx vitest run test/unit/<module>/engine`**
- [ ] **Test failure paths, not just happy paths**
  - Invalid inputs → appropriate errors
  - State machine invalid transitions → rejection
  - Timeout/cancellation paths
  - Empty/boundary conditions
- [ ] **Tests are deterministic** — no flaky timing dependencies

---

## Self-Check Process

Before submitting, CC MUST:

1. Run `npx vitest run test/unit/<module>/engine` — all pass
2. Run `npx tsc --noEmit` — zero errors
3. Walk through each checklist item above
4. Verify every CSV AC item has file:line evidence
5. Verify every CSV KPI has a test assertion

---

_Extracted from CX review findings across Modules 1-5, 12._
_Updated: 2026-02-24_
