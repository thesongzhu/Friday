# Security Policy

## Supported Versions

Friday is pre-1.0 software. Security fixes are applied to the latest release line.

| Version | Supported |
| --- | --- |
| latest (`0.x`) | Yes |
| older releases | No |

## Reporting a Vulnerability

Please do not open public issues for security reports.

**Preferred:** Use GitHub Security Advisories for private disclosure:

1. Open the repository on GitHub.
2. Go to `Security` -> `Advisories`.
3. Click `Report a vulnerability`.
4. Include reproduction steps, impact, and affected version/tag.

**Alternative:** Email security reports to `security@friday-ai.dev`.

## Response Targets

- Initial triage response: within 3 business days.
- Fix or mitigation plan: within 7 business days after triage.
- Coordinated disclosure: after a patch is available.

## Disclosure Guidelines

- Share minimal proof-of-concept details until a patch is released.
- If credentials/secrets are involved, rotate them immediately after patching.
- Use the patched version tag and re-run `npm run release:verify` before rollout.
