> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Friday Blueprint E2E Coverage Matrix

Generated: 2026-02-27

## Key Journey Coverage

| Journey | Test Type | Test Location | Status | Evidence |
|---------|-----------|---------------|--------|----------|
| Install from npm pack | Smoke | `scripts/ci/install-smoke.mjs` | PASS | CI `install-smoke` job |
| Start server + health check | Smoke | `scripts/ci/install-smoke.mjs` step 5 | PASS | `/v1/health` returns `status: ok` |
| CLI `friday --help` | Smoke | `scripts/ci/install-smoke.mjs` step 3 | PASS | CLI responds |
| Create workflow | E2E | `scripts/demo/minimal-workflow-demo.mjs` | PASS | `POST /v1/workflows` returns 201 |
| Publish workflow | E2E | `scripts/demo/minimal-workflow-demo.mjs` | PASS | `POST /v1/workflows/:id/publish` |
| Run workflow (manual trigger) | E2E | `scripts/demo/minimal-workflow-demo.mjs` | PASS | Run reaches terminal state |
| Auth login (dev mode) | E2E | `scripts/demo/minimal-workflow-demo.mjs` | PASS | `POST /v1/auth/login` returns token |
| Auth login (prod reject) | Smoke | `scripts/ci/install-smoke.mjs` step 6 | PASS | Returns 401 without token |
| Skill generation | Unit | `test/unit/skills/generator/` | PASS | 8200 tests |
| Skill conversion (n8n, GPT) | Unit | `test/unit/skills/converter/` | PASS | 8200 tests |
| Channel message normalization | Unit | `test/unit/channels/` | PASS | All channel normalizers tested |
| Subagent spawn + lifecycle | Integration | `test/integration/agent/` | PASS | Parent-child lifecycle verified |
| Workflow conflict detection | Unit | `test/unit/api/conflicts/` | PASS | Detect, list, resolve conflicts |
| Fleet dashboard + health | Unit | `test/unit/api/fleet/` | PASS | Health calculator, trust calculator |
| Memory CRUD | Unit | `test/unit/memory/` | PASS | Create, read, update, delete, search |
| Session lifecycle | Unit | `test/unit/sessions/` | PASS | Create, restore, close |
| Provider cost calculation | Unit | `test/unit/providers/` | PASS | Cost, pricing, multi-provider |
| Realtime event bus | Unit | `test/unit/api/realtime/` | PASS | SSE + WebSocket events |
| Plugin lifecycle | Unit | `test/unit/plugins/` | PASS | Init, start, stop, config validation |
| Rate limiting | Unit | `test/unit/api/auth/` | PASS | Lockout thresholds, sliding window |
| RBAC scopes | Unit | `test/unit/api/auth/` | PASS | Role-scope mapping, principal checks |
| Migration chain integrity | Quality | `scripts/quality/check-migrations.mjs` | PASS | v001-v037 contiguous |
| API route contracts | Contract | `test/contracts/api/` | PASS | Route count + shape snapshot |
| Type contracts | Contract | `test/contracts/types/` | PASS | Public API type stability |
| Adversarial security | Security | `test/adversarial/` | PASS | 277 adversarial tests |
| Secret detection | Security | CI `secrets` job | PASS | detect-secrets baseline clean |
| Cross-platform (macOS/Linux/Win) | Platform | CI `platform-matrix` job | PASS | 3-OS matrix |

## Uncovered / Blocked Journeys

| Journey | Reason | Risk | Mitigation |
|---------|--------|------|------------|
| Cloud E2E (remote provider) | Harness exists (`cloud-e2e.yml` + `ci.yml` `cloud-e2e-openai`) but no production cloud target secrets configured; CI auto-skips | Medium | Local provider tests pass; configure `FRIDAY_CLOUD_E2E_BASE_URL` + provider keys to activate |
| Multi-user concurrent editing | No concurrent E2E harness | Low | Conflict detection unit-tested; locking unit-tested |
| Real channel message delivery | 15 unit test files under `test/unit/channels/` cover all 11 platforms; 0 channel-specific E2E files exist under `test/e2e/live/` — only 2 general journey suites (`friday-real-journeys.e2e.test.ts`, `friday-cloud-journeys.e2e.test.ts`) | Low | Real transport services wired in hub bootstrap; live validation requires external API credentials (Discord bot token, Telegram bot token, Slack app, etc.) |
| Browser automation E2E | Requires headless browser + Playwright | Low | DOM parser + screenshot unit-tested |
| WebSocket upgrade E2E | Requires real WS client in test | Low | RFC 6455 handshake + frame parser unit-tested |
