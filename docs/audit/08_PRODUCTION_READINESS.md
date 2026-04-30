# Phase 9 - Production Readiness

Overall status: RED for launch as a real closed-loop product.

## Build and Startup

- API build: PASS.
- UI production build: PASS.
- CLI server smoke: PASS in `test/e2e/cli/friday-cli-start-runtime.test.ts`.
- Install/package smoke: PASS via `npm run test:install:smoke`; temp install served `/v1/health`, accepted local auth login, served bundled UI, and shut down cleanly.
- Full test suite: FAIL due missing test file and native companion release/runtime failures.
- Docker local smoke: PARTIAL_FAIL after Docker Desktop was available via `/Applications/Docker.app/Contents/Resources/bin/docker`. The first default-port pass was invalidated by an unrelated server already listening on `127.0.0.1:3141`; a clean retry on port 43141 proved the container starts and `/v1/health` works, but failed `POST /v1/auth/login` with 401 `PASSWORDLESS_LOCALHOST_ONLY` because Docker Desktop host traffic reaches the container from `192.168.65.1`.
- Release package check: PASS; `npm pack --dry-run` included 3144 files and excluded forbidden env/data/test patterns.
- Local closure: NO-GO; closure ledger reported 17 pass, 6 fail, 1 blocker before the nested release verifier was stopped.
- Real-world smoke: PARTIAL_FAIL; 15 pass, 7 fail, 5 blocked across 22 scenarios on the default DeepSeek provider lane.

## Deployment

- Dockerfile is present, runs non-root, exposes health check `/v1/health`; container start/health passed locally with Docker Desktop, but Docker E2E auth/bootstrap/plugins did not pass on a clean port.
- Compose binds host `0.0.0.0` and requires `FRIDAY_TOKEN_SECRET`.
- Local production-mode CORS/header smoke passed for configured allowed origins on port 41987: allowed preflight/login/me responses included CORS headers; denied origin preflight returned without CORS headers; bearer/local-bypass auth path did not set cookies; `X-Frame-Options: DENY` and `X-Content-Type-Options: nosniff` were present. Real deployed-domain cookie behavior is still unverified because no external deployment URL or TLS domain exists in this workspace.
- `.env.example` includes HSTS enabled uncommented (`FRIDAY_ENABLE_HSTS=true`) even though comment says only enable behind TLS proxy.
- `check:enablement-gaps` failed in the current environment because `.env` is absent, `FRIDAY_TOKEN_SECRET` is unset, and `FRIDAY_DESKTOP_ENABLED` is not true.
- Production migration rollout/backups were not verified. External webhook/callback-provider verification was removed from this supplemental pass by user request.

## Observability

- Observability routes, SLOs, alerts, traces, audit repository have tests.
- Test logs showed `OBS_AUDIT_APPEND_FAILED` and `database connection is not open` during observability service tests. Some are expected tests, but the repeated late-write pattern is operationally risky.
- No external error tracking/metrics backend verification was performed.

## Reliability

- Scheduler, retry, backoff, retention, workflow timeout, approval expiry tests pass.
- Native companion release lock timed out during tests, indicating cleanup/concurrency fragility.
- Billing provider callback path is absent, so marketplace paid state is not reliable.

## Performance

- UI build includes large CSS/fonts; no bundle budget gate was observed.
- Performance tests exist for provider routing and surface load times.
- Large/complex backend files may hide request-path performance issues.

## CI/CD

- GitHub workflows exist for CI, nightly, weekly audit, release, and Docker smoke.
- Local full `npm test` failed, so CI would block if it runs the same suite.
- Branch protection was not verified.

## Documentation

- README and `.env.example` exist.
- Env surface is large and not all production-safe defaults are enforced.
- Need an operator runbook for auth bootstrap, disabling local bypass, billing webhook configuration, migration backups, and native companion release cleanup.
