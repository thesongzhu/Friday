I’m treating this as a planning-only review pass. First I’ll load the required workspace context files (`SOUL.md`, `USER.md`, recent memory files, and `MEMORY.md`), then inspect the Friday repo files tied to C1/M1/M3/M4/M5/M6 and the skipped tests to build an exact fix plan.

I’ve loaded the required workspace context; `memory/` and `MEMORY.md` don’t exist yet in this workspace. I’m now inspecting `.` for the exact code locations behind C1/M1/M3/M4/M5/M6 and the skipped-test files so the plan maps to concrete edits.

I found the relevant source/test files and confirmed the API runtime has conditional wiring for skills/plugins and setup wizard routes. Next I’m drilling into the exact line-level code for each open backend issue plus the 14 partially skipped tests so the recommendations are specific (file + concrete edit).

I verified C1-related code: default bind is still `0.0.0.0`, admin seeding still inserts a NULL password, and setup routes currently track completion but do not enforce password setup. I’m now inspecting workflow runtime internals for M1/M3/M4/M5/M6 and each Category C skip block to classify implement/delete/keep accurately.

I’ve confirmed the workflow/webhook code paths and where raw graphs are accepted without strict validation. Next I’m reading the API test harness plus each partially skipped test file to make concrete implement/delete/keep-skip recommendations per skip site.

1. `package.json` open-source metadata
Files: `package.json`  
Change: add  
`"repository": { "type": "git", "url": "https://github.com/thesongzhu/Friday.git" }`  
`"keywords": ["ai","automation","agents","workflows","self-hosted","llm","visual-editor"]`  
Priority: `P0`

2. C1 Admin auth bypass (partial)
Files: `src/cli/friday-cli.ts:328`, `src/cli/friday-cli-run-loop.ts:30`, `src/hub/friday-hub-bootstrap.ts:348`, `src/hub/friday-hub-bootstrap.ts:389`, `src/hub/friday-hub-bootstrap.ts:636`, `src/api/http/routes/friday-setup-routes.ts`, `src/api/auth/friday-auth-service.ts`  
Change:
- Default bind `0.0.0.0` -> `127.0.0.1` in CLI/run-loop/runtime host defaults.
- Enforce first-run password setup before setup completion:
  - Add setup-security endpoint to set local admin password hash.
  - In setup completion route, require admin `password_hash` present.
- Make passwordless login explicit opt-in only (`FRIDAY_ALLOW_PASSWORDLESS_LOCAL_LOGIN=1` for tests/dev), default off.
Priority: `P0`

3. M1 Workflow AI node returns metadata, not model output
Files: `src/skills/executor/friday-skill-executor.ts:33`, `src/workflows/engine/friday-workflow-node-executor.ts:194`  
Change:
- Replace `ai-inference` shortcut behavior from route/credential metadata echo to real provider inference call and return normalized output (`text`, `model`, `providerId`, optional usage/meta).
- Normalize AI node output shape in workflow executor to use completion text payload.
Priority: `P1`

4. M3 Scheduler not wired at startup
Files: `src/hub/friday-hub-bootstrap.ts:672`, `src/jobs/workflows/friday-workflow-timeout-job.ts`, `src/jobs/index.ts` (plus new scheduler file)  
Change:
- Add runtime scheduler loop started in `hub.start()` and stopped in `hub.stop()`:
  - Cron tick: `workflowRuntime.triggers.tickCron(...)`
  - Timeout sweep: `reapExpiredLeases/sweepTimedOutRuns/sweepTimedOutNodes`
- Add single-flight + graceful shutdown for loops.
Priority: `P1`

5. M4 Webhook signature not verified
Files: `src/workflows/services/friday-workflow-trigger-service.ts:344`, `src/workflows/services/friday-workflow-trigger-service.ts:374`, `src/api/runtime/friday-api-runtime.ts:596`, `src/api/http/friday-http-server.ts`  
Change:
- Persist webhook signature config from trigger node (`secretRef`, `signatureHeader`) during trigger sync.
- Pass raw request body bytes into webhook handler (not only parsed JSON).
- Verify HMAC signature before `startRun`; reject missing/invalid signatures with 401/403.
Priority: `P0`

6. M5 Unsafe graph JSON cast
Files: `src/workflows/model/friday-workflow-graph.types.ts:17`, `src/workflows/services/friday-workflow-crud-service.ts:168`, `src/api/model/friday-api-workflow.types.ts`  
Change:
- Remove fallback unsafe cast in `parseGraphJson`.
- Add strict runtime validation/normalization for incoming graphs.
- In CRUD create/createVersion, persist only validated compiled graph JSON (reject invalid/raw malformed graphs with 400).
Priority: `P0`

7. M6 Circular dependency chain (`skills -> hub -> api -> agent -> skills`)
Files: `src/skills/registry/friday-skill-registry.types.ts:7`, `src/skills/registry/friday-skill-discovery.ts:8`, `src/skills/generator/services/friday-skill-generator-service.types.ts:4`, `src/hub/services/friday-hub-config-manager.types.ts`, `src/hub/services/friday-hub-memory-state.types.ts` (plus new neutral contracts file)  
Change:
- Extract shared “ports” interfaces into a neutral module (no `#hub` import from `#skills`).
- Update skills modules to depend on neutral contracts, hub implements those contracts.
- Optionally drop hub re-export of API runtime types to reduce transitive coupling.
Priority: `P2`

**Skipped Tests Recommendations**

Category B (missing wiring):
1. `test/e2e/api/friday-api-plugins-routes.test.ts`  
Action: `Implement`  
Reason: small, high-value route/auth coverage; wire `pluginService` + `pluginManifestLoader` in `test/e2e/api/_helpers/friday-api-test-server.helper.ts`.

2. `test/e2e/api/friday-api-skills-routes.test.ts`  
Action: `Implement` (and adjust one case)  
Reason: converter/generator routes are core. Wire `converterService`, `skillGenerator`, `skillRegistry` in helper. Replace/delete the “list sessions” case (endpoint doesn’t exist; use `GET /v1/skills/generator/sessions/:sessionId` instead).

Category C (partial skips):
1. `test/e2e/api/friday-api-auth-rbac-errors.test.ts:344`  
Action: `Delete`  
Reason: requires test-only failure route; INTERNAL_ERROR mapping is already unit-tested in `test/unit/api/http/friday-http-error-mapper.test.ts`.

2. `test/e2e/setup-wizard.e2e.test.ts` (6 skips via env gates)  
Action: mixed  
- `B14`, `B15`, `C17`: `Keep-skip` (real Ollama/LLM dependency).  
- `C18`, `C19`, `C20`: `Implement` (remove unnecessary live gate; they do not require real LLM).

3. `test/integration/workflows/friday-workflow-approval-chain.test.ts:187`  
Action: `Implement`  
Reason: captures real rejection-path bug; fix runtime/approval race and unskip.

4. `test/e2e/api/friday-api-sessions-memory-routes.test.ts:541`, `test/e2e/api/friday-api-sessions-memory-routes.test.ts:545`  
Action: `Implement`  
Reason: memory routes are production routes; wire `memoryService` in API test env and unskip.

5. `test/integration/memory/guard/friday-memory-guard-pii-namespace.test.ts:14`  
Action: `Implement`  
Reason: make PII mode injectable/configurable in guard service, then run block-mode assertion without compile-time constant hacks.

6. `test/integration/skills/friday-skill-registry-lifecycle.test.ts:117`, `test/integration/skills/friday-skill-registry-lifecycle.test.ts:145`, `test/integration/skills/friday-skill-registry-lifecycle.test.ts:201`  
Action: `Implement`  
Reason: failures are fixture-quality issues, not product behavior; use valid manifest fixture helper (`test/unit/skills/_helpers/make-manifest.helper.ts`) and unskip.
