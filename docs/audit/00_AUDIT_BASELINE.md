# Phase 0 - Audit Baseline

Date: 2026-04-30 / post-PR #171 follow-up
Repository root: `/Users/wenxindou/Desktop/Friday`
Branch: `codex/audit-followup-production-verification`
Base commit: `e244899a`

## Detected Stack

- Runtime: Node.js/TypeScript, package engine `>=22`.
- Package manager: npm is the active install path (`package-lock.json`); `pnpm-lock.yaml` also exists and remains a duplicated package-manager signal.
- Frontend: React + Vite under `ui/`.
- Backend: Node HTTP server in `src/api/http`, runtime assembly in `src/api/runtime/friday-api-runtime.ts`, CLI entry `dist/cli/friday-cli.js`.
- Database: SQLite via `better-sqlite3`, migrations `src/state/sqlite/migrations/v001...v075`.
- Tests: Vitest projects `default`, `typecheck`, `llm-e2e`, plus browser/UI E2E scripts.
- Deployment: `docker/Dockerfile`, `docker/docker-compose.yml`, GitHub Actions workflows.

## Post-Merge Baseline Findings

- Marketplace is retired in active product/test/script scope: `rg -n "marketplace|/v1/marketplace|FRIDAY_ALLOW_LOCAL_BYPASS_LOGIN|allowLocalBypassLogin|allowPasswordlessLocalLogin|\{ local: true \}|PASSWORDLESS" src ui scripts test package.json .env.example` returned no matches.
- Passwordless local login is retired from active product/test/script scope; local/test/Docker auth now uses `localPassphrase` bootstrap/login.
- Docker Desktop CLI is available through `/Applications/Docker.app/Contents/Resources/bin`.
- Current working tree contains pre-existing untracked duplicate files with names like `docs/audit/* 2.md`, `src/state/sqlite/migrations/* 3.ts`, and duplicate workflow/reflex files. They are not part of the branch, but they affect filesystem-scanning commands in this dirty workspace.

## Immediate Blockers

- No blocker remains for the requested local gates on a clean tracked tree: Docker clean passphrase smoke, npm audit, architecture-boundary check, install smoke, contracts, typecheck, and full `npm test` passed after fixes.
- `npm run check:migrations` fails in this dirty working tree only because of untracked duplicate migration files with spaces in their names; the same check passed in a temporary copy containing only Git-tracked files.
- Real-world smoke remains partial: 15 passed, 6 failed, 1 partial, 5 blocked in the latest run.
- Live Discord/channel production delivery remains unverified because no safe sandbox recipient/channel env is configured in the process; the token previously pasted in chat should be treated as exposed and rotated.
