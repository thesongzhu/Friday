# Phase 0 - Audit Baseline

Date: 2026-04-30
Repository root: `/Users/wenxindou/Desktop/Friday`
Branch: `codex/merge-451555a-into-5177ce2`
Commit: `0afe3dc2`

## Discovery Commands

| Command | Result | Evidence |
| --- | --- | --- |
| `git status --short --branch` | PASS | Branch `codex/merge-451555a-into-5177ce2`; pre-existing modified files: `.secrets.baseline`, `test/unit/ui/agent-os-nav.test.ts`. |
| `find . -maxdepth 2 ...` manifest discovery | PASS | Found `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `.env.example`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.mjs`, `ui/vite.config.ts`, Docker and CI files. |
| `node -v && npm -v` | PASS | Node `v23.11.0`, npm `10.9.2`. |
| `command -v pnpm gitleaks trufflehog semgrep docker` | PARTIAL | No paths printed from the default shell PATH during initial discovery. Docker was later verified via Docker Desktop CLI at `/Applications/Docker.app/Contents/Resources/bin/docker`; gitleaks/trufflehog/semgrep remained unavailable. |

## Detected Stack

- Runtime: Node.js/TypeScript, package engine `>=22`.
- Package manager: npm lockfile present; pnpm lockfile also present, so lockfile policy is duplicated.
- Frontend: React + Vite under `ui/`.
- Backend: Node HTTP server in `src/api/http`, runtime assembly in `src/api/runtime/friday-api-runtime.ts`, CLI entry `dist/cli/friday-cli.js`.
- Database: SQLite via `better-sqlite3`, migrations `src/state/sqlite/migrations/v001...v075`.
- Tests: Vitest projects `default`, `typecheck`, `llm-e2e`, `browser-e2e`.
- Lint/typecheck: ESLint flat config, `tsc --noEmit`, UI typecheck.
- Deployment: `docker/Dockerfile`, `docker/docker-compose.yml`, GitHub Actions workflows.
- Config: `.env.example`, runtime env parsing in `src/hub/friday-hub-bootstrap.ts`.

## Entrypoints

- CLI: `friday` -> `dist/cli/friday-cli.js`.
- API server: `friday start` / `npm start`.
- UI: `ui/src/main.tsx`, route registry `ui/src/router.tsx`.
- HTTP route registration: `src/api/runtime/friday-api-runtime.ts`.
- State bootstrap: `src/state/index.ts`.

## Immediate Blockers

- `npm test` failed: 3 failed files, 5 failed tests, 1 missing test suite.
- `npm audit --omit=dev --audit-level=moderate` failed because `axios` advisories are pulled by `@larksuiteoapi/node-sdk`.
- `npm run check:architecture-boundaries` failed on a security-layer import escape.
- Many browser and live LLM/channel tests are skipped, so closed-loop production behavior is not verified.
- Docker is no longer unavailable after retrying with the Docker Desktop CLI path, but clean Docker E2E is not green: image/container health passed on a unique port while auth/bootstrap smoke failed because host-published requests are rejected by localhost-only passwordless login.
