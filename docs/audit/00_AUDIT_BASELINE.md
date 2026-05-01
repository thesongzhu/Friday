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
- Pre-existing untracked duplicate files with names like `docs/audit/* 2.md`, `src/state/sqlite/migrations/* 3.ts`, and duplicate workflow/reflex files were quarantined outside the repo at `/tmp/friday-audit-quarantine-20260501T220523Z/`; manifest: `/tmp/friday-audit-quarantine-20260501T220523Z/untracked-files.txt`. Current Git working tree is clean.

## Immediate Blockers

- No blocker remains for the requested local gates on a clean tracked tree: Docker clean passphrase smoke, npm audit, architecture-boundary check, install smoke, contracts, typecheck, and full `npm test` passed after fixes.
- `npm run check:migrations` now passes in the repo root after quarantining the untracked duplicate files; clean tracked-tree verification also passed.
- Real-world smoke is now green on current code: Fresh state and Current-config copied-state runs both passed 27/27 with `localPassphrase` auth, DeepSeek primary, and OpenAI fallback.
- Live Discord/channel production delivery remains unverified because no safe sandbox recipient/channel env is configured in the process; the token previously pasted in chat should be treated as exposed and rotated.
