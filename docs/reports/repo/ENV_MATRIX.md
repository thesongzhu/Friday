> Status: Historical report. This file is retained for audit and evidence; if it conflicts with current behavior, prefer [`docs/current-source-of-truth.md`](../../current-source-of-truth.md).

# Environment Matrix

Date: 2026-03-04 (America/Los_Angeles)

## Detection Evidence

```bash
cd .
node -v
npm -v
docker --version
docker compose version
```

Observed:

- Node: `v22.22.0`
- npm: `10.9.4`
- Docker CLI: `not installed (command not found)`

## Matrix

| Environment | Status | Dependencies | Key Env Vars | Run Mode | Validation Scope |
|---|---|---|---|---|---|
| `local-dev` | Available | Node 22+, npm, sqlite (better-sqlite3), Playwright package, shell tools | `FRIDAY_STATE_DIR`, `FRIDAY_TOKEN_SECRET`, optional `FRIDAY_DESKTOP_ENABLED`, `FRIDAY_MCP_SERVERS`, channel vars | source-mode (`npm test`, `vitest`, local CLI/hub) | Full smoke + core routes + failure + concurrency + reliability + observability |
| `server-profile` | Available | same as local + built `dist/*` artifacts | `NODE_ENV=production`, `FRIDAY_PORT`, `FRIDAY_STATE_DIR`, `FRIDAY_SKILLS_DIR`, `FRIDAY_TOKEN_SECRET` | production-like runtime (`node dist/cli/friday-cli.js start`) | Smoke + HTTP route closure + auth/error envelopes + log evidence |
| `docker` | Host-blocked / CI-enabled | Docker engine + docker compose + image build toolchain | `FRIDAY_TOKEN_SECRET`, `FRIDAY_DOCKER_*` (CI smoke script), compose vars | `docker run` (CI), `docker compose up` (ops) | Local host cannot execute; CI lane `docker-e2e-verify` executes runtime closure (`scripts/ci/docker-e2e-smoke.sh`) |

## Desktop/Permission Dependencies

Desktop runtime check command:

```bash
npm run -s check:desktop-runtime
```

Expected platform dependencies from `scripts/ops/check-desktop-runtime.sh`:

- macOS: `osascript`, `screencapture`, `base64`, plus TCC grants (Accessibility, Screen Recording, Input Monitoring, Automation)
- Linux: `xdotool` (recommended), screenshot backend (`import`/`gnome-screenshot`/`scrot`), `base64`
- Windows: `powershell`, UIAutomation-related permissions

## Container Definition Presence

- `Dockerfile` present
- `docker-compose.yml` present
- Container environment exists in repo definition; local host lacks Docker runtime, but CI now includes `docker-e2e-verify` for runtime closure evidence on docker-capable runner.
