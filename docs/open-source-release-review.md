# Open Source Release Review

Last reviewed: 2026-04-22

## Verdict

Friday can be open sourced, but the full current working tree should not be published as-is.

The product code, README positioning, npm install path, source install path, Docker source build path, and GPL-3.0-only license story are now aligned. The blocker is generated evidence and audit material that is currently tracked in the repository and exposes local runtime details.

## Fixed In This Pass

- The English and Chinese README files now describe Friday as a bounded, supervised Agent OS instead of an unrestricted autonomous system.
- Download status now distinguishes published npm, source install, Docker source build, packaging scripts, and unpublished native artifacts.
- The public README no longer includes the placeholder Discord badge or invite link.
- The README license text now matches the repository `LICENSE` file: GPL-3.0-only.
- Public CI, npm script, test display, and file naming for the overlap suite now use neutral `agent-parity` language.
- `.claude/launch.json` no longer contains a personal absolute Node path.

## Current Public-Release Blockers

These paths should be removed from the public source snapshot or replaced with redacted summaries before a clean launch:

- `audit-fix/` contains local rerun evidence, login responses, auth-mode metadata, runtime state paths, and issue remediation internals.
- `docs/reports/ops/real-world-validation/` contains local filesystem paths, auth source metadata, provider lane details, screenshots, and runtime environment snapshots.
- `docs/reports/ops/real-green-gate/` contains branch/status dumps and preflight records with local machine and run metadata.
- Some `screenshots/**` JSON artifacts contain form values, local paths, and generated audit payloads.
- `.claude/` is local tooling configuration and should not be part of a public product source release unless fully sanitized.

The targeted scan did not find a raw production API key in README or GitHub workflow files. It did find many references to GitHub Actions secret names, local auth modes, test fixture tokens, local paths, and generated login/evidence JSON. Those are not always credentials, but they reveal enough operational topology to be treated as public-release blockers.

Several internal benchmark/adoption implementation paths still contain historical OpenClaw naming. They were not renamed in this pass because doing so would require source-level path and import changes beyond the requested public `openclaw-overlap` cleanup.

## Reverse-Operation Risk

The main risk is not a single leaked password. The risk is operational reconstruction:

- local usernames and absolute paths reveal development machine layout
- runtime database and token-secret paths reveal where a local deployment stores security state
- auth flow names reveal local bypass and token minting behavior
- generated health and provider evidence reveal enabled lanes, fallback behavior, and validation gaps
- audit reports can teach an attacker which surfaces were historically weak or recently fixed

For a public release, keep high-level proof summaries, but do not ship raw run artifacts unless they are intentionally redacted.

## Recommended Public Snapshot Rule

Keep:

- `src/`, `ui/`, `packages/`, `skills/`, `examples/`, `docs/reference/`, stable product docs, packaging scripts, tests, and public templates
- `README.md`, `README.zh-CN.md`, `LICENSE`, `CHANGELOG.md`, `.github/SECURITY.md`, `.github/CONTRIBUTING.md`

Remove or redact:

- generated audit evidence
- local validation run outputs
- screenshots with captured local state
- local IDE/agent configuration
- raw JSON from authenticated local runs
- branch/preflight dumps that include private paths or internal remediation trails

## Final Checks Before Making The Repository Public

Run these checks after pruning or redaction:

```bash
git ls-files -z | xargs -0 rg -n "(/Users/|tokenSecretSource|stateDbPath|passwordless_local_login|mint_local_admin_token|FRIDAY_ACCESS_TOKEN|FRIDAY_LOCAL_PASSPHRASE|ghp_|sk-[A-Za-z0-9]{20,}|BEGIN (RSA|OPENSSH|PRIVATE) KEY)" -S
npm run release:verify:repo
npm run release:verify
```

If `detect-secrets` is available:

```bash
detect-secrets scan --exclude-files '(^|/)node_modules(/|$)|(^|/)dist(/|$)|(^|/)coverage(/|$)' > .secrets.baseline
detect-secrets audit .secrets.baseline
```

## Agent Ecosystem Research Input

The public README positioning was updated around recurring themes found in current Chinese and English agent discussions:

- Memory and context: current agent-memory discussions emphasize durable, human-readable memory, retrieval, session search, and context snapshots.
- Skills and discoverability: OpenClaw docs describe skill folders, bundled/local skills, watcher refresh, and skill lifecycle concerns.
- Self-healing and self-improvement: community writeups around agent skills focus on reusable skills, generated workflows, and learning loops, but the claims need clear evidence boundaries.
- Stability and boundaries: security discussions repeatedly warn that prompt injection, untrusted skills, and tool permissions are not solved by better prompts alone.
- Approval and blast radius: public incidents around email deletion and context compaction show why long-running agents need durable rules, explicit approvals, and tool-level enforcement.

Sources checked:

- [OpenClaw skills docs](https://docs.openclaw.ai/skills)
- [OpenClaw security docs](https://docs.openclaw.ai/security)
- [TechRadar: OpenClaw security risks](https://www.techradar.com/pro/here-are-the-openclaw-security-risks-you-should-know-about)
- [Tom's Hardware: OpenClaw inbox deletion incident](https://www.tomshardware.com/tech-industry/artificial-intelligence/openclaw-wipes-inbox-of-meta-ai-alignment-director-executive-finds-out-the-hard-way-how-spectacularly-efficient-ai-tool-is-at-maintaining-her-inbox)
