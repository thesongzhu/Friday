# Phase 11 - Remediation Roadmap

## 1. P0 Launch Blockers

1. Remove user-facing paid purchase completion or restrict it to a server billing principal.
2. Wire signed billing webhook route and reconciliation path.
3. Make unknown billing events non-success and non-mutating.
4. Add paid marketplace E2E tests proving entitlements cannot be self-granted.

## 2. P1 Serious Risks

1. Harden local auth bootstrap defaults for production and public binds.
2. Fix full `npm test`: missing reflex test reference, native companion timeout/signing/lock failures.
3. Resolve production dependency audit for `axios` via `@larksuiteoapi/node-sdk`.
4. Fix architecture boundary failure and introduce a warning budget for critical lint rules.
5. Fix Docker E2E smoke so it cannot false-pass on occupied ports and uses a production-like auth path from host-published ports.
6. Label or disable stub channel/plugin modes unless explicitly configured.

## 3. Missing Closed-Loop Tests

1. Browser smoke: auth -> home -> chat -> session reload.
2. Workflow UI smoke: create/publish/run/approval path.
3. Billing webhook smoke: signed success, invalid signature, replay, unknown event.
4. Channel sandbox smoke for each claimed production channel.
5. Native companion smoke on clean macOS runner.

## 4. Architecture Cleanup

1. Extract hub bootstrap feature modules with clear start/stop order.
2. Centralize tenant/principal identity resolution.
3. Centralize marketplace purchase state machine.
4. Separate mock proof and live proof in CI artifacts.
5. Add lifecycle drain controls for background jobs and observability.

## 5. Nice-to-Have Cleanup

1. Remove duplicate lockfile or document official package manager.
2. Tune UI bundle/font loading and add budgets.
3. Add dependency/SBOM tooling.
4. Add unused export/dead route detection after suite is stable.
5. Improve operator docs for deployment, env vars, billing, webhooks, and incident response.
