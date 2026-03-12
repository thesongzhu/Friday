> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Friday Blueprint Closure DoD + Execution Plan (2026-02-27)

## 1) Decision

Friday is **production-usable for core local/self-host workflows**, but **blueprint is not fully closed**.

Why:
- Main CI is green (latest main run passed): https://github.com/thesongzhu/Friday/actions/runs/22473263584
- Deterministic pipeline is wired into workflow runtime (rules + node runner + acceptance + retry + playbook + evidence).
- Several blueprint workstreams are implemented but **not fully wired into runtime/API surface**.

## 2) Closure Definition (DoD)

Blueprint is considered "closed" only when all conditions below are true.

### 2.1 Stable (rule-constrained, acceptance-gated)
- `FRIDAY_PIPELINE_ENABLE` defaults ON and mode defaults to `enforce`.
- All workflow node execution paths go through the deterministic pipeline (not bypassing rules/acceptance/retry).
- No uncontrolled fail-open behavior except explicitly documented non-blocking telemetry/audit writes.
- Critical test suites pass on Linux/macOS/Windows + cloud live E2E smoke.
- Skipped tests are bounded and justified (target: `0` for critical suites).

### 2.2 Reproducible (playbook reusable)
- Playbook selection/feedback/promotion survives process restart (persistent store, not memory-only).
- Same input + same policy pack in deterministic mode yields deterministic gate outcomes.
- Migration chain upgrades/downgrades preserve playbook/rules/evidence integrity.

### 2.3 Accountable (full traceability)
- Run-level evidence includes event chain across rules/node-runner/acceptance/retry/playbook.
- Evidence export/download works and has owner/tenant authorization boundaries.
- Policy decisions are auditable with reason + matched rule metadata.

## 3) Current Workstream Status (Backend-first)

| Workstream | Status | Evidence | Gap to DoD |
|---|---|---|---|
| RUL Rules Engine Core | **PARTIAL-PASS** | Rules loaded/evaluated in workflow runtime and deterministic API routes. (`./src/workflows/runtime/friday-workflow-runtime.ts:464`, `./src/api/http/routes/friday-deterministic-pipeline-routes.ts:77`) | Global apply is not uniformly wired across every execution entrypoint (agent/session/tool all-path enforcement still incomplete). |
| RUN NodeRunner | **PASS (core path)** | NodeRunner pipeline + adapters + facade wired in workflow runtime. (`./src/workflows/runtime/friday-workflow-runtime.ts:569`) | Needs broader non-workflow adoption and stronger perf/SLO validation. |
| ACC Acceptance Layer | **PASS (core path)** | Acceptance gate and baseline checks wired per artifact. (`./src/workflows/runtime/friday-workflow-runtime.ts:590`) | Baseline checks are generic; domain-specific acceptance packs still need productization. |
| RET Retry Engine | **PASS (core path)** | Unified retry bridge with budget/circuit events wired. (`./src/workflows/runtime/friday-workflow-runtime.ts:715`) | Needs end-to-end parity in agent runtime failure taxonomy and policy governance. |
| PBK Playbook Learning | **PARTIAL** | Playbook intake/feedback/promotion hooks are wired. (`./src/workflows/runtime/friday-workflow-runtime.ts:669`) | Store is in-memory (`Map`) so restart loses learning. (`./src/playbook/engine/playbook-store.ts:79`) |
| PKG Agent Package/Publishing | **BLOCKED (not wired)** | Route module exists. (`./src/api/http/routes/friday-packaging-routes.ts:96`) | Not registered in API runtime route assembly. (`./src/api/runtime/friday-api-runtime.ts:350`) |
| SEC Multi-Tenant Security | **PARTIAL** | Auth/RBAC/token revocation and evidence authz exist. (`./src/api/runtime/friday-api-runtime.ts:146`, `:289`) | Multi-tenant security route surface exists but not wired into runtime. (`./src/api/http/routes/friday-multi-tenant-security-routes.ts:165`) |
| DSK Desktop Control Runtime | **BLOCKED (not wired)** | Desktop route module exists. (`./src/api/http/routes/friday-desktop-routes.ts:131`) | Not registered in runtime route assembly. (`./src/api/runtime/friday-api-runtime.ts:350`) |
| CNV Universal Converter | **PASS (core skill conversion)** | Converter routes wired and tested; converter service in hub bootstrap. (`./src/api/runtime/friday-api-runtime.ts:935`, `./src/hub/friday-hub-bootstrap.ts:568`) | Need deeper quality scoring + converter parity matrix across external ecosystems. |
| MKT Marketplace/Commerce | **PARTIAL** | Plugin marketplace endpoints are wired. (`./src/api/runtime/friday-api-runtime.ts:1016`) | Commerce routes exist but not wired; standalone marketplace availability is forced false. (`./src/hub/friday-hub-bootstrap.ts:945`) |
| UIX Non-Builder UX | **BLOCKED (backend-only phase)** | Core backend APIs exist for chat/workflow/skills. | Non-builder product UI target is not delivered yet (intentional backend-first phase). |
| OBS Observability/Ops | **BLOCKED (not wired)** | Observability route module exists. (`./src/api/http/routes/friday-observability-routes.ts:68`) | Not registered in API runtime route assembly. (`./src/api/runtime/friday-api-runtime.ts:350`) |
| XPR Cross-Program | **BLOCKED (scaffold)** | Module scaffold exists. (`./src/cross-program`) | No runtime/API integration and no production AC yet. |

## 4) Highest-Value Closure Tasks (Execution Order)

### P0 — Make backend closure real (must finish)

1. **PBK-PERSIST-001**: Replace in-memory playbook store with SQLite-backed repository + migrations.
2. **RUL-GLOBAL-001**: Apply rules gate at all execution entrypoints (agent run/session run/skill invoke), not workflow-only.
3. **API-WIRE-001**: Wire route families currently implemented-but-unregistered: multi-tenant, packaging, observability, desktop, marketplace-commerce, discovery, satellite-pairing (behind feature flags where needed).
4. **SEC-TENANT-001**: Enforce tenant-scoped authorization consistently on newly wired APIs (owner/admin/tenant/satellite matrix).
5. **TEST-SKIP-001**: Convert unconditional `it.skip` to implementable tests or explicit env-gated tests with rationale; cap critical-suite skips at zero.
6. **E2E-CLOUD-001**: Add protected cloud E2E gate (OpenAI baseline required, provider matrix optional schedule).

### P1 — Hardening + product-readiness

7. **OBS-EVIDENCE-001**: Add run evidence retention/TTL and artifact lifecycle management.
8. **RET-POLICY-001**: Centralize retry policy definitions (YAML/JSON policy packs) and expose operational controls.
9. **ACC-DOMAIN-001**: Add domain acceptance templates (workflow type specific checks beyond baseline schema/count/quality).
10. **CNV-QUALITY-001**: Add converter confidence score + deterministic repair loop + contract fixtures for top import formats.
11. **MKT-OPS-001**: Decide marketplace mode (stub/real) and wire health capability output from actual runtime state.
12. **DOC-BLUEPRINT-001**: Update blueprint CSV status columns from `Planned` to factual states with evidence links.

### P2 — UX/product layer (after backend closure)

13. **UIX-NONBUILDER-001**: Non-builder chat-first control center with task/skills/workflow side panels.
14. **UIX-COMMAND-001**: Render safe command actions as UX buttons with policy-aware enabled/disabled states.
15. **UIX-RUNBOOK-001**: One-click run diagnostics from evidence traces to guided remediation.

## 5) Exit Gates (Go/No-Go)

Release can be declared "Blueprint Closed (Backend)" only if all are true:

- `P0` tasks completed.
- `main` CI green on required jobs.
- Cloud live E2E baseline green (OpenAI target) for latest main commit.
- No unresolved conflicts in active blueprint PRs.
- Blueprint status file updated with evidence references.

## 6) Immediate next sprint (recommended)

- Sprint-1: `PBK-PERSIST-001`, `RUL-GLOBAL-001`, `API-WIRE-001`
- Sprint-2: `SEC-TENANT-001`, `TEST-SKIP-001`, `E2E-CLOUD-001`
- Sprint-3: `OBS-EVIDENCE-001`, `RET-POLICY-001`, `ACC-DOMAIN-001`, `DOC-BLUEPRINT-001`

