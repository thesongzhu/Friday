# Phase 7 and 8 - E2E Closed-Loop Scenarios

| Scenario | Flow | Required Test Data | Expected Result | Current Status |
| --- | --- | --- | --- | --- |
| Local first-run auth | start server -> bootstrap passphrase -> login -> `/v1/auth/me` -> logout | temp state dir, local passphrase | Scoped tokens issued; no passwordless bypass | VERIFIED_CLOSED_LOOP locally. |
| Docker clean auth smoke | build/start container -> health -> bootstrap passphrase -> login -> runtime assertions | unique host port, temp token secret/passphrase | Container proves auth/bootstrap/plugins through published port | VERIFIED_CLOSED_LOOP locally. |
| Protected dashboard | browser has real token -> home/dashboard queries API | built UI, temp server, passphrase token | Protected routes reject unauthenticated and render authenticated home | PARTIAL: setup/home browser regression passes; broader browser coverage still limited. |
| Chat with durable session | UI/HTTP run agent -> session/message rows persist -> reload -> messages from API | mock LLM and real SQLite | User and assistant messages durable and scoped | VERIFIED_CLOSED_LOOP locally through Fresh and Current-config real-world smoke; broader browser reload coverage still useful. |
| Provider setup to first chat | setup provider -> encrypted secret stored -> routing configured -> agent call uses provider | staging LLM key | No key leak; successful response stored | VERIFIED_CLOSED_LOOP locally: DeepSeek primary and OpenAI fallback lanes passed real-world smoke. External deployment/provider callback domains still GRAY. |
| Workflow lifecycle | create workflow -> publish/version -> run -> approval -> artifact/evidence | workflow graph and skill stub | Run transitions and artifacts persisted | PARTIAL/GREEN locally: backend/API tests pass; browser workflow authoring still needs full smoke. |
| Workflow public webhook | register webhook trigger -> send invalid/valid/replayed request | path token/secret | Invalid/replay rejected; valid creates exactly one run | PARTIAL/GREEN locally: E2E test covers create→publish→trigger→invoke→run-completion polling. L2 RGG webhook contract and L3 browser authoring scenarios wired. External deployed webhook smoke still missing. |
| Channel message roundtrip | configure sandbox channel -> receive signed webhook/message -> session -> outbound send | sandbox channel credentials and safe recipient | Signature verified; outbound ID from provider | VERIFIED_CLOSED_LOOP: supervisor health API E2E tested locally; RGG l6-discord-channel-roundtrip passed with real Discord send/readback evidence at same SHA. |
| Memory lifecycle | create memory -> query FTS/semantic -> delete/prune -> wrong namespace denied | temp user/tenant | Correct namespace isolation and deletion | PARTIAL/GREEN locally; semantic live provider not fully verified. |
| Desktop/system remote | companion build/run -> socket RPC -> audit -> deny unauthorized | macOS companion and temp socket | Authenticated unix socket RPC works and audits | PARTIAL/GREEN locally: native companion/release tests pass; notarized clean-machine release not verified. |
| Marketplace | none | none | No active UI/API/runtime surface | RETIRED: active-scope grep found no marketplace mechanism. |
| Production build/start | build API/UI -> start packaged server -> health -> passphrase login -> UI served | temp install/state | Health green; login works; UI served | VERIFIED_CLOSED_LOOP locally through install smoke; external deployment still GRAY. |

## Minimal Next E2E Tests

1. Browser smoke: setup/passphrase auth -> home -> chat -> session reload from API.
2. Workflow UI smoke: create/publish/run/approval path from the browser.
3. Live Discord/channel sandbox smoke after rotating the pasted token and configuring safe recipient IDs.
4. External deployment smoke once a staging URL/domain/callback provider config exists.
5. Validation/report regression test for artifact `result` versus summary status shape.
