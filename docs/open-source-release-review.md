# Open Source Release Review

Last reviewed: 2026-05-19

## Verdict

Friday can be presented as a **public v1 local candidate** from the tracked source
tree when public docs, repository metadata, and package metadata stay aligned
with the current source of truth.

This is not a release-complete-all verdict. It does not claim channel live proof,
cloud live certification, external OTEL/Grafana export, default-on multi-tenant
or package release proof, or full native desktop parity.

## Current Public Positioning

Friday is the trusted application layer for AI agents to do real work with
approval, memory, evidence, and rollback.

The public wording should emphasize:

- local-first runtime
- BYOK provider setup
- approval-gated sensitive actions
- auditable memory and learned facts
- evidence-backed workflow and repair surfaces
- explicit blockers for missing credentials, accounts, CAPTCHA, payment, or
  external environments

Avoid wording that implies universal automation, AGI, unrestricted autonomy, or
automatic access to systems the user has not configured.

## License And Package Truth

- Repository license: MIT.
- npm package: `@thesongzhu/friday`.
- Current published npm version: `1.0.0`. Repo `package.json` version: `1.0.1` (next release in progress; publish blocked until R5 same-SHA provider + Discord/Telegram/Lark+Feishu channel proof passes).
- The unscoped `friday` npm package is unrelated.

README, package metadata, GitHub metadata, and release docs should all use the
MIT license story. Any older GPL wording is stale and must not be reused.

## Public V1 Local Boundary

The public v1 local track covers:

- local UI and local runtime
- provider setup and capability truth
- supervised operator workflows
- memory, user constitution, and learned fact surfaces
- approval-gated tool use
- evidence and rollback summaries

The public v1 local track does not cover:

- Discord/Lark/Telegram/channel control live proof
- PR #244 channel closure
- Alibaba/Tencent/Volcengine cloud live certification
- external OTEL/Grafana export
- release-complete-all
- `blocked_by_env` scenarios

## Repository Metadata Recommendation

Do not update GitHub metadata until the repo docs pass local checks. When ready,
the recommended repository description is:

```text
Trusted local-first AI agent application layer for supervised automation, skills, workflows, memory, and approval-gated tool use.
```

Recommended topics:

```text
ai-agent, automation, local-first, self-hosted, byok, workflow-automation, skills, mcp, llm, typescript, nodejs, privacy, human-in-the-loop
```

Remove `agi` from topics unless the product direction changes and has matching
evidence.

## Public Snapshot Rule

Keep public:

- `src/`, `ui/`, `packages/`, `skills/`, stable product docs, packaging scripts,
  tests, and public templates
- `README.md`, `README.zh-CN.md`, `LICENSE`, `NOTICE`, `CHANGELOG.md`,
  `PRIVACY.md`, `RESPONSIBLE_USE.md`, `TRUST.md`, `.github/SECURITY.md`, and
  `.github/CONTRIBUTING.md`

Avoid committing or publishing as ordinary product docs:

- generated local runtime evidence
- authenticated local run dumps
- screenshots with private state
- local IDE or agent configuration
- raw branch/preflight dumps
- stale audit snapshots that conflict with the current source of truth

Historical reports, audit snapshots, comparison matrices, and operator handoffs
must stay out of the public source tree. Current public docs must point users to
`docs/current-source-of-truth.md`, `docs/release-evidence-policy.md`, and
`docs/public-v1-local-candidate.md`.

## Public Download Hygiene

The npm package is the installable runtime artifact. The GitHub source archive
is the public source download. Both surfaces must stay free of private local
paths, local state, internal operator control folders, and real secrets.

The development repository may retain tests and public maintainer docs. Internal
audit reports, benchmark comparisons, handoffs, release-control packages, local
evidence, and operator-only maps do not belong in the public source tree.
Development tests are excluded from GitHub source archives with `.gitattributes
export-ignore` so source downloads stay install-oriented.

Internal release truth-map folders, dogfood reports, release-closure control
packages, local evidence, and operator handoffs are not release artifacts. Channel
features remain bounded by identity, permission, approval, evidence, and
rollback gates; the public v1 local candidate does not claim unrestricted
channel control or all capabilities live.

## Final Checks

Before presenting the repository as a public v1 local candidate, run:

```bash
npm run check:public-source-hygiene
npm run check:secret-patterns
npm run audit:release-truth
npm run release:check
git diff --check
```

For a full release decision, use the current release evidence policy. Mock-only
tests, workflow success alone, stale artifacts, wrong-SHA artifacts, and
`blocked_by_env` are not release proof.
