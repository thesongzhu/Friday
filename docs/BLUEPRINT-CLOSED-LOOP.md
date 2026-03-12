# Friday Blueprint: Closed-Loop Usability

This blueprint makes Friday usable end-to-end with no missing operator step.

## Closed Loop Definition

A new user should be able to complete this loop:

1. Install Friday
2. Run one command demo
3. Diagnose and self-recover from common failures
4. Extend with skill/plugin/workflow templates
5. Ship a release with traceable notes and rollback path

## Loop 1: Install -> Run

Commands:

```bash
npm install
npm run build
npm run demo
```

Exit criteria:

- demo prints `✅ Friday one-command demo completed`
- output includes valid `workflowId` and `runId`

## Loop 2: Fail -> Recover

Use:

- `docs/TROUBLESHOOTING.md`

Exit criteria:

- operator can locate `stateDir`, `friday.db`, and `audit.jsonl`
- operator can re-run with `FRIDAY_LOG_REQUESTS=true` and reproduce

## Loop 3: Extend -> Verify

Use:

- `docs/EXTENDING.md`
- `examples/templates/*`

Exit criteria:

- custom skill/plugin/workflow can be scaffolded from templates
- `friday list` and local run paths validate basic loading/execution

## Loop 4: Release -> Rollback

Use:

- `docs/RELEASING.md`
- `docs/RELEASE_NOTES_TEMPLATE.md`
- `CHANGELOG.md`
- `SECURITY.md`

Exit criteria:

- `npm run release:verify` passes
- release tag matches package version
- release notes generated from template
- rollback path documented (patch-forward)

## Definition of Done (Project-Level)

Friday is "release-usable" when all are true:

- one-command demo exists and passes locally
- troubleshooting guide covers common startup/auth/run failures
- extension conventions + templates are available in-repo
- release process includes version/changelog/release notes/CI/license/security

## Ownership and Cadence

- Owner: Release Manager
- Trigger: every release cut and every UX-breaking change
- Artifact refresh required: `README.md`, `CHANGELOG.md`, release docs, templates
