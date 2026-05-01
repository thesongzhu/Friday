# Phase 2 - Feature Traceability Matrix

Status values used: VERIFIED_CLOSED_LOOP, PARTIAL, UNWIRED, FAKE_OR_MOCK_ONLY, BROKEN, UNKNOWN, RETIRED.

| Feature | Entrypoints | Backend/Data Trace | Tests/Verification | Status | Evidence/Risk/Next Action |
| --- | --- | --- | --- | --- | --- |
| Health/version/static UI | `/v1/health`, `/v1/version`, `/` | HTTP server routes, static `dist/ui` | build/UI/install/Docker smokes PASS | VERIFIED_CLOSED_LOOP | Install smoke served `/v1/health` and bundled UI; Docker smoke passed health and auth path. |
| Auth/bootstrap/local session | UI auth provider, `/v1/auth/*` | auth service, session/token DB, RBAC, lockout, revocation | auth unit/routes PASS; install/Docker passphrase login PASS; setup browser regression PASS | VERIFIED_CLOSED_LOOP locally | Passwordless fallback removed. Production still needs explicit env profile and non-loopback deployment review. |
| Provider setup/routing | Setup UI, provider routes | provider service, secret repository, routing config | provider tests PASS; real-world smoke PARTIAL | PARTIAL | Latest real-world smoke used DeepSeek lane but still had failures/blocked scenarios; fallback lane absent. |
| Agent chat/sessions | `/chat`, `/agent`, `/v1/agent/runs`, `/v1/sessions/*` | agent runtime, session repositories, memory/world model | mock E2E/session tests PASS; real-world smoke PARTIAL | PARTIAL | Mock/local wiring strong; real LLM/tool-bridge scenarios not clean. |
| Workflows CRUD/run/approval/triggers | workflow UI/routes | workflow runtime, run/checkpoint/approval/trigger tables | workflow unit/integration/E2E API PASS | PARTIAL | Local backend loop is strong; browser workflow authoring and deployed webhook proof still needed. |
| Workflow public webhooks | `/v1/workflow-webhooks/:pathToken` | workflow trigger runtime and secret resolver | trigger tests PASS | PARTIAL | No external staging webhook smoke. |
| Automations/scheduler | automations UI, scheduler jobs | agent automation tables, scheduler | mock journey and scheduler tests PASS | PARTIAL | Needs production delayed-job/double-submit smoke. |
| Memory | memory UI/routes | memory items/embeddings/FTS, guard/quota/PII | memory pipeline/guard tests PASS | PARTIAL | Semantic path depends on provider routing; live semantic provider not fully verified. |
| Channels | channel UI/routes/webhooks | channel services, relay, session bridge | channel unit/mock tests PASS; live channel tests skipped | FAKE_OR_MOCK_ONLY/PARTIAL | Several channel services are stub/sandbox-only; live Discord not run due missing safe recipient/channel env. |
| Plugins | plugins UI, `/v1/plugins/*` | plugin registry/loader/repository | plugin unit/API tests PASS | PARTIAL | Runtime can still be stub/disabled; UI needs capability truth and browser coverage. |
| Skills install/run/generation | skills UI/routes/generator | registry/executor/generator/converter | executor/generator/install tests PASS | PARTIAL | Local install/use tests pass; live external install/generation paths need staging proof. |
| Desktop/system companion | system/desktop UI/routes | Swift companion, remote passkeys/sessions, sockets | native companion and release tests PASS in full `npm test` | PARTIAL | Local macOS tests now pass; clean-machine notarized/release deployment still unverified. |
| Observability/audit | observability UI/routes | trace/metric/audit/SLO/alert tables | unit/service tests PASS | PARTIAL | Expected audit-failure tests pass, but late-write logs show lifecycle drain should stay on roadmap. |
| Multi-tenant security | conditional routes/policies | multi-tenant engines/tables | unit tests PASS; architecture boundary PASS after fix | PARTIAL | Disabled/optional by default; staging tenant isolation still needed. |
| Marketplace | none in active product scope | retired/no runtime access | active-scope `rg` found no marketplace refs | RETIRED | `/v1/marketplace/*`, UI, services, jobs, tests/scripts removed; old local DB tables are inert orphan data if present. |
