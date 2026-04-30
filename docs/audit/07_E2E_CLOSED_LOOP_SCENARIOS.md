# Phase 7 and 8 - E2E Closed-Loop Scenarios

| Scenario | Flow | Required Test Data | Expected Result | Current Status |
| --- | --- | --- | --- | --- |
| Local first-run auth | start server -> bootstrap/passphrase or local login -> `/v1/auth/me` -> logout | temp state dir, loopback client | Auth session created, scoped token issued, logout revokes token | PARTIAL: auth tests pass, but bypass default blocks production readiness. |
| Protected dashboard | UI loads -> auth provider obtains token -> dashboard queries health/status/session data | built UI, temp server | Protected routes reject unauthenticated and render authenticated data | PARTIAL: UI browser coverage mostly skipped; API auth tests pass. |
| Chat with durable session | UI/HTTP run agent -> session/message rows persist -> reload -> messages from API | mock LLM and real SQLite | User and assistant messages durable and tenant/user scoped | PARTIAL: mock E2E passes; real-world smoke passed several DeepSeek scenarios but failed multi-turn memory and file-tool roundtrip. |
| Provider setup to first chat | setup provider -> encrypted secret stored -> routing configured -> agent call uses provider | test provider or staging LLM key | No key in client/logs; successful response stored | PARTIAL: default DeepSeek lane was detected and healthy in real-world smoke; fallback lane missing; local closure provider lifecycle failed on invalid OpenAI test key. |
| Workflow lifecycle | create workflow -> version -> publish -> trigger run -> approval -> completion -> artifact/evidence | workflow graph and skill stub | Run transitions and artifacts persisted | PARTIAL/GREEN locally: integration tests pass; UI/browser path skipped. |
| Workflow public webhook | register webhook trigger -> send invalid/valid/replayed request | path token/secret | Invalid/replay rejected; valid creates exactly one run | PARTIAL: trigger tests cover unknown and event matching; external webhook smoke missing. |
| Paid marketplace purchase | listing/pricing -> checkout -> provider webhook -> entitlement -> paid feature access | paid listing, signed provider event | Entitlement only after verified provider success | RED: current `/complete` route can grant entitlement directly; provider webhook route absent. |
| Plugin install/run | marketplace/local plugin -> signature/fingerprint verify -> load -> activate -> route/tool visible | signed plugin package | Untrusted packages rejected; trusted plugin can run and unload | PARTIAL: unit/integration pass; UI can be stub mode and browser E2E skipped. |
| Channel message roundtrip | configure sandbox channel -> receive signed webhook/message -> session -> agent response -> outbound send | sandbox Discord/Slack/etc credentials | Signature verified; inbound creates session; outbound message ID from provider | RED/GRAY: many services stubbed; live channel tests skipped. |
| Memory lifecycle | create memory -> query FTS/semantic -> delete/prune -> access from wrong namespace denied | temp user/tenant | Correct namespace isolation and deletion | PARTIAL/GREEN locally: memory tests pass; semantic live provider not verified. |
| Desktop/system remote | pair device/passkey -> execute allowed action -> audit -> non-admin denied | macOS companion and temp socket | Authenticated unix socket RPC works and audits | RED: native companion tests failed/time out. |
| Production build/start | build API/UI -> start production server -> health -> auth login -> UI served | temp install/state | Health green, no dev bypass unless explicit | PARTIAL: builds, CLI start, release package check, and install smoke pass; Docker smoke blocked because Docker is unavailable. |

## Minimal New Tests Recommended

1. Marketplace paid entitlement denial test: authenticated buyer cannot call `/v1/marketplace/purchases/:id/complete` for paid plan unless request principal is server billing actor.
2. Billing webhook E2E: raw signed provider payload -> route -> webhook row -> billing event -> purchase/entitlement state.
3. UI smoke: browser navigates setup -> auth -> home -> chat/session reload using mock hub, with skipped tests enabled in CI.
4. Native companion smoke: clean temp app bundle, no stale release lock, unix-socket readiness probe.
