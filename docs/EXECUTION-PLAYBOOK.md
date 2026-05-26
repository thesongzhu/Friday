# Friday Execution Playbook — Iron Rules

> This document defines the mandatory execution flow for ALL phases.
> No exceptions. No shortcuts. Violating this = highest priority bug.

---

## Phase Execution Order

```
Phase 1: Foundations        → Spec + Model + API contracts (DONE)
Phase 2: Runtime Hardening  → Core Runtime + UI Controls (IN PROGRESS)
Phase 3: Governance         → Security + Migration
Phase 4: Validation         → Automated Test Matrix
Phase 5: Beta Rollout       → Deployment + Telemetry
Phase 6: Launch Readiness   → Runbook + Pricing + Ecosystem
```

Each phase MUST complete before the next begins.

---

## Universal Rules (All Phases)

### 1. CSV AC is the Single Source of Truth
- Every task has a row in `private operator roadmap evidence`
- AC must be **module-specific checklists** (not generic sentences)
- CX reviews PASS/FAIL against CSV AC with file:line evidence
- 6/6 AC items PASS = APPROVED. No exceptions.

### 2. AC Must Be Specific
**Before ANY implementation begins**, the CSV AC for that task must contain concrete, verifiable checklist items.

❌ Bad: "Core path implemented with deterministic state transitions and rollback safety."
✅ Good:
```
1. All public getters return deep-frozen immutable snapshots
2. State machine: pending → active → completed/failed, with guards
3. Rollback persists audit event with reason + from/to version
4. KPI: install success > 99% validated with test assertions
5. Signature verification covers all package types
```

If AC is generic → refine it FIRST, then implement.

### 3. Serial CX → CC Flow
```
CX design/plan → Wenxin approve → CC implement → CX review → (fix loop) → APPROVED
```
- CX and CC dispatched serially, NEVER parallel
- CC only follows CX's fix plan
- Ultron never authors fix plans
- Loop until APPROVED

### 4. CC Gets Full Context
Every CC prompt MUST include:
- CSV AC (all 6 fields for that task)
- `CC-CODING-STANDARDS.md` checklist
- CX's plan or fix plan
- "Self-check against all items before submitting"

### 5. Coding Standards (CC-CODING-STANDARDS.md)
Mandatory for all code changes. See separate file.

---

## Phase 2: Runtime Hardening (Current)

### Task Types
- **Core Runtime Implementation** (FRI-PLAT-XX4) — engine code + tests
- **UI and Operator Controls** (FRI-PLAT-XX5) — UI layer + operator tooling

### Flow (for existing code — review + fix)
```
1. Extract CSV AC for module (python3 DictReader)
2. CX R1 review: Part A (CSV AC PASS/FAIL) + Part B (issues + fix plan)
3. CC fix: CX fix plan + CSV AC + coding standards
4. CX R2 review → APPROVED or fix loop
```

### Flow (for new code — design + implement)
```
1. Extract CSV AC for module
2. CX: read CSV AC → output implementation plan
3. Wenxin approve plan
4. CC: implement per CX plan + CSV AC + coding standards
5. CX review → APPROVED or fix loop
```

---

## Phase 3: Governance

### Task Types
- **Security and Permission Model** (FRI-PLAT-XX6)
- **Migration, Backfill, and Compatibility** (FRI-PLAT-XX7)

### Prerequisites
- Phase 2 APPROVED for that workstream
- CSV AC refined to specific security/migration checklists

### Flow
```
1. Refine CSV AC → specific checklist per module (BEFORE coding)
2. CX: read CSV AC → output security/migration implementation plan
3. Wenxin approve plan
4. CC: implement per CX plan + CSV AC + coding standards
5. CX review → APPROVED or fix loop
```

### Security AC Template (customize per module)
```
1. RBAC enforcement on all public APIs
2. Tenant isolation — zero cross-tenant data access
3. Secret management — no plaintext secrets in memory/logs
4. Permission-denied paths return audit trail entries
5. Input validation on all external boundaries
6. [Module-specific security requirements]
```

### Migration AC Template (customize per module)
```
1. Schema migration scripts (up + down)
2. Backward compatibility with Phase 2 data format
3. Backfill job for existing data
4. Zero-downtime migration path
5. Rollback tested and documented
6. [Module-specific migration requirements]
```

---

## Phase 4: Validation

### Task Type
- **Automated Test Matrix** (FRI-PLAT-XX8)

### Prerequisites
- Phase 3 APPROVED for that workstream

### Flow
```
1. CX: define test matrix (unit + integration + e2e + perf)
   - Every CSV KPI must have automated validation
   - Coverage targets per module
2. Wenxin approve matrix
3. CC: implement test suite per matrix
4. CX review: verify coverage + all KPI assertions pass
```

### Test Matrix Template
```
1. Unit tests: all engine functions, state machines, error paths
2. Integration tests: cross-module interactions
3. E2E tests: full workflow happy path + failure paths
4. Performance tests: KPI thresholds (p95 latency, throughput)
5. Security tests: permission boundaries, injection, fuzzing
6. Regression tests: all previously found bugs have test coverage
```

---

## Phase 5: Beta Rollout

### Task Type
- **Beta Rollout and Telemetry** (FRI-PLAT-XX9 or XX0)

### Prerequisites
- Phase 4 APPROVED for that workstream

### Flow
```
1. CX: define rollout plan (canary → staged → full)
   - Feature flags per module
   - Telemetry instrumentation points
   - KPI dashboards
   - Rollback triggers
2. Wenxin approve rollout plan
3. CC: implement deployment pipeline + telemetry + dashboards
4. CX review: verify instrumentation coverage
5. Execute rollout: canary (1%) → staged (10%) → full beta
```

---

## Phase 6: Launch Readiness

### Task Types
- **Launch Runbook and Handover** (FRI-PLAT-XX0) × 12 modules
- **Product Positioning & Pricing** × 1
- **Data Governance** × 1
- **Developer Platform** × 1
- **Ecosystem Program** × 1

### Prerequisites
- Phase 5 complete

### Flow (Runbooks)
```
1. CX: define launch checklist per module
   - Pre-launch verification
   - Rollback procedure
   - On-call escalation
   - Monitoring alerts
2. CC: write runbook documents + automation scripts
3. CX review: verify completeness
```

### Flow (Cross-cutting: Pricing/Governance/Platform/Ecosystem)
```
1. Wenxin defines strategy
2. CX: translate to implementation plan
3. CC: implement
4. CX review
```

---

## Status Tracking

After each task APPROVED, update CSV status:
```python
# Task status values
Planned → In Progress → Review → Approved → Done
```

---

## Summary

| Rule | Description |
|------|-------------|
| CSV AC = truth | Every task verified against CSV |
| AC must be specific | No generic sentences |
| Refine AC before coding | AC checklist FIRST, implement SECOND |
| CX → CC serial | Never parallel |
| CC gets full context | CSV AC + standards + plan |
| Loop until APPROVED | 6/6 AC PASS required |
| Phase order strict | 1 → 2 → 3 → 4 → 5 → 6 |

---

_Created: 2026-02-24_
_This is an iron rule document. Changes require Wenxin's explicit approval._
