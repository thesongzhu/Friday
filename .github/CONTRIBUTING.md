# Contributing to Friday

Thanks for helping improve Friday.

Friday is a local-first personal AI and automation runtime. Contributions are welcome, but changes that affect credentials, tools, desktop control, channels, skills, workflow execution, or provider routing need extra care because they can change what Friday is allowed to do on a user's machine.

## Ways To Contribute

- **Bug reports:** include repro steps, logs, provider/channel setup state, and what you expected Friday to do.
- **User experience fixes:** improve setup, onboarding, capability diagnostics, progress updates, or failure wording.
- **Skills and workflows:** add reusable capability with manifest, permissions, tests, and examples.
- **Provider integrations:** add or improve model/search/OCR/TTS/provider setup paths, doctor checks, and routing health.
- **Channel integrations:** connect or harden chat/control channels such as Discord, Telegram, Feishu/Lark, Signal, WhatsApp, QQ, or webhook-style systems.
- **Runtime and safety work:** improve approval gates, audit evidence, rollback, self-healing, policy, and secret handling.
- **Docs:** keep README, setup, capability, troubleshooting, and security docs truthful to the current runtime.

## Prerequisites

- Node.js 22+
- npm 10+
- Git

```bash
git clone https://github.com/thesongzhu/Friday.git
cd Friday
npm ci
npm run build
```

Optional browser E2E setup:

```bash
npx playwright install chromium
```

## Local Development

```bash
npm run typecheck
npm run lint
npm run build
npm test
```

`npm run typecheck` covers the source tree, operator client, UI, and type-level contract tests. It is not a substitute for the normal `.test.ts` Vitest suite; run `npm test` for that coverage.

For focused work, run targeted Vitest suites first, then run the broader gates before opening a PR.

Useful checks:

```bash
npm run ops:doctor:runtime
npm run check:security-doctor
npm run check:audit-integrity
npm run check:provider-reliability
```

## Contribution Rules

1. Keep changes focused and reviewable.
2. Prefer existing patterns over new abstractions.
3. Add tests for behavior changes and regressions.
4. Update docs when setup, provider, channel, capability, security, or user-facing behavior changes.
5. Do not weaken approval gates, policy checks, audit trails, sandboxing, rollback, or secret handling.
6. Do not present unverified provider or external-account behavior as working.
7. Never commit secrets, API keys, local tokens, personal logs, or screenshots containing credentials.

## Skills, Workflows, And Plugins

Use [docs/EXTENDING.md](../docs/EXTENDING.md) for the detailed extension guide.

Every new executable capability should include:

- a manifest with stable ID, description, inputs, outputs, permissions, and runtime requirements
- a dry-run or test path
- clear trust and review guidance
- rollback or uninstall behavior where relevant
- docs or examples showing how a user verifies it

Untrusted code should not become an automatically available capability until it passes validation, sandbox checks, and any required human approval.

## Provider And Channel Changes

Provider and channel changes must answer the same setup questions the product asks users:

- Does Friday have this capability?
- What credential or account is missing?
- Where does the user configure it?
- Can Friday verify it with a real doctor check or representative task?

For provider work, include routing health and failure states. For channel work, include inbound/outbound behavior, wake/control semantics, credential posture, and high-risk action confirmation.

## Security-Sensitive Areas

These areas require extra review and regression tests:

- auth, sessions, local bootstrap, tokens, passkeys
- secret storage, provider keys, channel credentials
- desktop, browser, shell, file, and network tools
- skill installation, package download, MCP registration
- approval gates, autonomy policy, rollback, audit evidence
- production or external-account actions

Security fixes must include a regression test proving the bug is fixed.

## Pull Request Checklist

- [ ] Typecheck/lint/build/tests pass locally or the PR explains why a gate could not run.
- [ ] New behavior is covered by unit, integration, or regression tests.
- [ ] Docs are updated for user-visible behavior, setup, configuration, or safety changes.
- [ ] PR description explains the problem, the change, risk, and verification.
- [ ] Provider/channel/skill changes include doctor or representative verification.
- [ ] Security-sensitive changes include regression tests.
- [ ] No secrets or personal credentials are committed.

## Release Process

See [docs/RELEASING.md](../docs/RELEASING.md) for tagged-release workflow, version rules, release notes, verification, and rollback.

## Vulnerabilities

Do not open public issues for security vulnerabilities. Use GitHub Security Advisories or the reporting path in [SECURITY.md](SECURITY.md).
