# Phase 4 - Security Threat Model and Findings

## Threat Model

Assets:
- User sessions, access/refresh tokens, local passphrase bootstrap state.
- Provider API keys and OAuth credentials stored through secret repositories.
- User conversations, memory, files, workflow outputs, desktop/system permissions.
- Plugin/skill packages and signatures.
- Channel credentials and webhook secrets.

Actors:
- Unauthenticated remote user.
- Authenticated normal user/operator.
- Tenant member in a different tenant.
- Malicious plugin/skill/package publisher.
- External webhook sender.
- Local network attacker or misconfigured reverse proxy.

Trust boundaries:
- Browser to HTTP API.
- Authenticated API caller to server-side business logic.
- Public webhook endpoints to internal workflow/channel state.
- Server to external LLM/channel providers.
- Plugin/skill package boundary.
- Desktop/system companion boundary.

## Findings

| ID | Severity | Category | Finding | Evidence | Current Status | Recommended Fix/Verification |
| --- | --- | --- | --- | --- | --- | --- |
| SEC-001 | P0 resolved | Payment/Authz | Marketplace paid entitlement self-grant route. | Active-scope `rg` now returns no `/v1/marketplace` or marketplace refs in `src ui scripts test package.json .env.example`. | Resolved by retiring marketplace runtime/UI/tests/scripts. | Keep contract/source hygiene checks preventing reintroduction. |
| SEC-002 | P1 resolved | Auth bootstrap | Passwordless local login/default bypass. | Active-scope `rg` returns no `FRIDAY_ALLOW_LOCAL_BYPASS_LOGIN`, `allowPasswordlessLocalLogin`, or `{ local: true }`; auth tests assert localPassphrase. | Resolved; Docker/install/E2E now use localPassphrase bootstrap/login. | Keep auth route tests and setup browser token injection tests. |
| SEC-003 | P1 resolved | Supply chain | Axios advisories through Lark SDK. | `package.json` override pins `axios` to patched `^1.15.2`; `npm audit --audit-level=moderate --omit=dev` PASS. | Resolved for npm production audit. | Monitor override when `@larksuiteoapi/node-sdk` releases patched dependency graph. |
| SEC-004 | P1 | Channel integrity | Live channel delivery not verified. | Live suites remain skipped; no safe sandbox recipient/channel env in process. | Open. | Configure sandbox channel/user IDs and run live channel E2E. |
| SEC-005 | P1 | Secret handling | A Discord bot token was pasted in chat. | Token was not written to repo or echoed in outputs. | Open operational risk. | Rotate the pasted bot token before production; provide future secrets through env/secret store, not chat. |
| SEC-006 | P2 | Privacy | Browser storage retains user/chat/custom pack data. | `ui/src/lib/storage/auth-storage.ts`, chat/session hooks, custom pack storage. | Open. | Add logout storage-clearing and retention tests. |
| SEC-007 | P2 | Rate limiting | Unknown rate-limit policy fallback is permissive by design. | `test/unit/api/auth/friday-rate-limit-service.test.ts` asserts unknown policy is allowed. | Open. | Consider fail-closed policy IDs or a small explicit no-limit allowlist. |
| SEC-008 | P2 | Webhook exposure | Public workflow/channel webhook paths need deployed proof. | Local tests pass; no external staging webhook smoke. | Open. | Add staging valid/invalid/replay webhook smoke. |

## Tooling Status

- Secret pattern scan: PASS earlier; no provider/API key-shaped tracked secrets reported.
- Dependency audit: PASS after axios override.
- Docker passphrase smoke: PASS on unique port with Docker Desktop CLI path.
- Architecture boundary: PASS after local security regex compiler/cache.
- gitleaks/trufflehog/semgrep were not available in this workspace and remain recommended optional checks.
