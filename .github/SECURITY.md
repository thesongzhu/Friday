# Security Policy

Friday can connect to local files, browsers, desktops, model providers, web search providers, skills, workflows, MCP servers, and chat channels. Treat security issues seriously: a small bug in capability routing or approval policy can become a real local-machine risk.

## Supported Versions

Security fixes target the latest public release line and the default branch.

| Version | Supported |
| --- | --- |
| latest `1.x` | Yes |
| default branch | Best effort |
| older releases | No |

## Reporting A Vulnerability

Please do not open public issues for security reports.

Preferred private disclosure:

1. Open the repository on GitHub.
2. Go to `Security` -> `Advisories`.
3. Click `Report a vulnerability`.
4. Include reproduction steps, impact, affected version/tag, and whether credentials or local files are involved.

Alternative:

- Email `security@friday-ai.dev`.
- If email is unavailable, use GitHub Security Advisories.

## What To Report

Please report issues involving:

- authentication bypass, token leakage, local bootstrap/session bugs
- API key, provider credential, or channel secret exposure
- unintended shell, file, browser, desktop, or network execution
- approval bypass for high-risk actions
- unsafe skill/package/MCP installation or execution
- path traversal, artifact leakage, or sensitive file reads
- remote access, passkey, CORS, CSRF, websocket, or channel-ingress weaknesses
- audit-log tampering or missing evidence for sensitive actions
- rollback failure that leaves a user in a riskier state

## Severity Guide

| Severity | Examples |
| --- | --- |
| Critical | unauthenticated remote code execution, credential exfiltration, high-risk action without approval |
| High | local file disclosure, approval bypass, persistent malicious skill install, channel command spoofing |
| Medium | scoped information leak, denial of service, missing audit evidence, weak secret handling |
| Low | misleading security UI, incomplete hardening docs, low-impact local-only issue |

## Response Targets

- Initial triage: within 3 business days.
- Fix or mitigation plan: within 7 business days after triage.
- Coordinated disclosure: after a patch or mitigation is available.

These are targets, not guarantees. If a report involves active exploitation or exposed credentials, rotate affected credentials immediately.

## Security Model Summary

- Friday is local-first by default.
- Credentials should live in environment variables, managed secret refs, or OS-backed storage.
- Raw inline secrets are compatibility input and should not be committed.
- High-risk actions require explicit approval.
- Capability grants should include scope, reason, evidence, and expiry.
- Tool calls, workflow runs, self-healing runs, and channel actions should leave audit evidence.
- Missing provider keys, OAuth, payment, CAPTCHA, and sensitive permissions are human blockers, not automatic success states.

## Disclosure Guidelines

- Share minimal proof-of-concept details until a patch is released.
- Do not include real API keys, channel tokens, private documents, or user data in public threads.
- If credentials are involved, rotate them after patching and before public disclosure.
- Re-run relevant checks after a fix, such as:

```bash
npm run typecheck
npm run test
npm run check:security-doctor
npm run check:audit-integrity
npm run release:verify:repo
```
