# Phase 9 - Production Readiness

Overall status: YELLOW for local closed-loop readiness and GRAY for external production readiness. Real-world local smoke is now green; live channels and deployed-domain checks still need staging/sandbox proof.

## Build and Startup

- API/UI/package/build gates passed through `npm test`, `npm run build:ui` as part of UI E2E, install smoke, and release check.
- Full `npm test` is now PASS: 775 files passed, 10301 tests passed, 251 skipped, type errors 0.
- Install/package smoke PASS: temp install served `/v1/health`, accepted passphrase login, served bundled UI, and shut down cleanly.
- Docker local smoke PASS on unique port with passphrase bootstrap/login.
- Route contracts PASS; contracts update PASS.
- UI bundle health PASS.

## Deployment

- Dockerfile is present, non-root, and passed local Docker smoke.
- `check:enablement-gaps` fails in a bare process env because `.env`, `FRIDAY_TOKEN_SECRET`, and `FRIDAY_DESKTOP_ENABLED=true` are absent; it passes with safe temporary env. This means production/staging env provisioning is still required, not that the code gate is broken.
- External deployed URL, TLS, cookie domain, CORS with real domains, OAuth/provider callback URLs, and reverse-proxy behavior were not verified.
- Current dirty workspace has untracked duplicate files that can break filesystem-scanning gates; clean branch/tracked-tree checks pass.

## Observability

- Observability routes, SLOs, alerts, traces, and audit repository tests pass.
- Expected failure tests still log audit append errors when DB connections are closed; lifecycle drain hardening remains recommended.
- No external error tracking/metrics backend verification was performed.

## Reliability

- Scheduler, retry, backoff, retention, workflow timeout, approval expiry, native companion release/runtime, install smoke, and Docker smoke passed locally.
- Avoid running release/package/install smokes concurrently because they share `dist/` and package outputs.
- Real-world local smoke is green on current code: Fresh and Current-config copied-state runs both passed 27/27 with real provider lanes.

## Performance

- UI bundle budget gate passed.
- Performance tests exist for provider routing and surface load times.
- Large backend runtime files remain a maintainability/performance-review risk.

## CI/CD

- Local gates that should be merge-relevant pass on tracked files.
- Branch protection/external CI settings were not verified.
- Recommended CI addition: run migration checks from a clean checkout/worktree to avoid local untracked duplicate artifacts.

## Documentation

- Audit docs now reflect marketplace retirement, passwordless retirement, Docker passphrase pass, npm audit pass, architecture-boundary pass, full test pass, and green Fresh/Current-config real-world smoke.
- Need operator docs for staging/prod env profiles, live channel sandbox setup, secret rotation, and external deployment smoke.
