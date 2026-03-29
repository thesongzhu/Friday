# Contributing to Friday

Thanks for contributing to Friday.

## Prerequisites
- Node.js 22+
- npm 10+
- Git

## Setup
```bash
git clone https://github.com/thesongzhu/Friday.git
cd Friday
npm ci
npm run build

# Optional: install Playwright browsers for browser E2E tests
npx playwright install chromium
```

## Extending Friday (Skills / Plugins / Workflows)

- Conventions and dev guide: `docs/EXTENDING.md`
- Copy-ready templates: `examples/templates/`
- One-command end-to-end workflow check: `npm run demo`

## Local Quality Gates

Run all of these before opening a PR:

```bash
npm run typecheck
npm run lint
npm run build
npm test
```

## Development Workflow
1. Create a branch from `main`.
2. Make focused changes with tests.
3. Run all local quality gates before opening a PR.

## Branch / Commit Conventions

- Branches: `feat/*`, `fix/*`, `chore/*`, `docs/*`
- Conventional commit prefix required (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, etc.)

## Code Standards
- TypeScript strict mode; avoid `any`.
- Keep public naming conventions (`Friday*`, `createFriday*`).
- Prefer small, reviewable commits.

## Tests
- Add/adjust unit tests for logic changes.
- Add integration tests when wiring runtime components.
- Include regression tests for bug fixes.

## Security-Sensitive Changes

The following areas require extra review and mandatory regression tests:

- **Auth / crypto:** token validation, secret encryption, master key handling
- **Path handling:** file tool sandboxing, artifact path sanitization
- **Channel ingress:** message parsing, sanitization, reconnect logic

Any security bug fix must include a regression test proving the bug is fixed.

## PR Template Requirements

Every PR should include:

- **Risk analysis:** what could break, what's the blast radius
- **Verification commands + output summary:** show that quality gates pass
- **Migration notes:** when schema or config changes, document upgrade steps

## Pull Request Checklist
- [ ] Typecheck/lint/build/tests pass locally.
- [ ] New behavior is covered by tests.
- [ ] Docs are updated when behavior/config changes.
- [ ] PR description explains problem, fix, and verification.
- [ ] Security-sensitive changes have regression tests.

## Release Process

- See `docs/RELEASING.md` for the full tagged-release workflow (quality gates, version/tag rules, publish steps, rollback notes).

## Security
- Never commit secrets.
- Keep `.env.example` sanitized.
- Report vulnerabilities via GitHub Security Advisories as described in `SECURITY.md`.
