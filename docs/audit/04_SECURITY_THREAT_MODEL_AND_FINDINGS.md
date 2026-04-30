# Phase 4 - Security Threat Model and Findings

## Threat Model

Assets:
- User sessions, access/refresh tokens, local auth bootstrap state.
- Provider API keys and OAuth credentials stored via secret repositories.
- User conversations, memory, files, workflow outputs, desktop/system permissions.
- Marketplace purchases, entitlements, subscriptions, payouts, billing events.
- Plugin/skill packages and signatures.

Actors:
- Unauthenticated remote user.
- Authenticated normal user/operator.
- Tenant member in a different tenant.
- Marketplace buyer/publisher.
- Malicious plugin/skill/package publisher.
- External webhook sender.
- Local network attacker or misconfigured reverse proxy.

Trust boundaries:
- Browser to HTTP API.
- Authenticated API caller to server-side business logic.
- Public webhook endpoints to internal workflow/channel/billing state.
- Server to external LLM/channel/billing providers.
- Plugin/skill package boundary.
- Desktop/system companion boundary.

## Findings

| ID | Severity | Category | Finding | Evidence | Exploit Scenario | Recommended Fix | Verification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SEC-001 | P0 | Payment/Authz | Paid entitlements can be self-granted through an authenticated API route. | `src/api/http/routes/friday-marketplace-commerce-routes.ts:868-927`; auth is `marketplace.write`; handler calls `completePurchase` and saves entitlement. | Buyer or compromised token with write scope completes a pending paid purchase without provider-confirmed payment. | Remove public/user route or restrict to server-only billing actor/admin; require verified billing event and idempotency key. | Integration test: paid checkout cannot grant entitlement until signed webhook/reconciliation succeeds. |
| SEC-002 | P0 | Closed-loop billing | Billing webhook handler is not wired to an HTTP route. | Handler exists at `src/marketplace/billing/friday-billing-webhook-handler.ts`; route grep found no registered billing webhook route in API runtime. | Real provider callbacks never update purchases/subscriptions; app relies on manual/user completion. | Add raw-body route, signature verification, adapter lookup, dedupe, event processing, and audit. | Route contract and E2E webhook test with valid/invalid signatures. |
| SEC-003 | P1 | Billing integrity | Unknown billing event types map to `payment.succeeded`. | `src/marketplace/billing/friday-billing-webhook-handler.ts:201-224`. | A new/unknown provider event becomes a success event if handler is wired. | Map unknown events to `"unknown"` or reject/record without processing. | Unit test unknown event is non-success and does not grant entitlements. |
| SEC-004 | P1 | Auth bootstrap | Local bypass login defaults to true. | `src/hub/friday-hub-bootstrap.ts:698-702`; `.env.example:108-109`; startup warning appears repeatedly in tests. | Misconfigured public deployment or proxy client-IP bug exposes passwordless admin path. | Default false in production-like configs; require explicit local-only bind or first-run passphrase before serving non-loopback. | Startup test with `NODE_ENV=production` and no explicit opt-in rejects bypass. |
| SEC-005 | P1 | Supply chain | Production audit fails on axios advisories via Lark SDK. | `npm audit --omit=dev --audit-level=moderate` failed for `axios 1.0.0 - 1.14.0` through `@larksuiteoapi/node-sdk`. | SSRF/header leakage vulnerabilities in dependency reachable through Lark/Feishu integrations. | Upgrade/downgrade dependency to patched graph; pin and re-run audit. | `npm audit --omit=dev --audit-level=moderate` passes. |
| SEC-006 | P1 | Desktop/system | Native companion release/runtime tests fail. | `npm test` failed native Swift companion unix-socket test and release workflow tests. | Desktop control or release package may be unavailable or inconsistently signed. | Fix socket startup readiness, release locks, ad-hoc signing detritus cleanup. | Native companion integration tests pass on clean macOS runner. |
| SEC-007 | P2 | Authorization/tenant | Marketplace tenant identity can collapse to principal ID. | `src/api/http/routes/friday-marketplace-commerce-routes.ts:817-818`. | Tenant-level filters and ownership checks may not align with multi-tenant principal context. | Use `ctx.principal.tenantId ?? ctx.principal.id` consistently. | Tenant isolation tests around checkout/list/purchase access. |
| SEC-008 | P2 | Privacy | Browser local storage stores user and chat-related data. | `ui/src/lib/storage/auth-storage.ts`, `ui/src/hooks/use-chat-session.ts`, `ui/src/lib/packs/pack-registry.ts`. | Shared browser/profile can retain conversation/user metadata after logout. | Minimize persistent browser storage; clear on logout; document retention. | UI test verifies logout clears sensitive local storage. |
| SEC-009 | P2 | Rate limiting | Unknown rate-limit policy fallback allows requests. | `test/unit/api/auth/friday-rate-limit-service.test.ts` asserts unknown policy is permissive. | New route with typo in `rateLimitPolicyId` silently bypasses throttling until coverage catches it. | Fail closed for unknown policy except explicitly public/no-limit policies. | Route policy coverage plus runtime test for typo rejection. |
| SEC-010 | P2 | Webhook exposure | Public workflow/channel webhook paths need deployment proof. | Route families exist and tests pass, but no external staging webhook smoke was run. | Public endpoints can be misconfigured without signature/secret reachability proof. | Add staging webhook smoke with invalid/valid signatures and replay tests. | CI/staging E2E webhook test. |

## Tooling Status

- Secret scan: `npm run check:secret-patterns` PASS; no provider/API key shaped tracked secrets reported.
- Dependency audit: `npm audit --omit=dev --audit-level=moderate` FAIL.
- Docker: initially absent from PATH, later available through Docker Desktop CLI. Clean unique-port retry verified container start/health but Docker auth/bootstrap/plugins smoke failed with 401 `PASSWORDLESS_LOCALHOST_ONLY`. gitleaks/trufflehog/semgrep remained unavailable and are recommended but not executed.
- A user-supplied Discord bot token was provided during the audit conversation. It was not written to repo files or printed in audit outputs, but because it appeared in chat, it should be treated as exposed and rotated before production use.
