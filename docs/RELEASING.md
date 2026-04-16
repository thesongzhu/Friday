# Releasing Friday

This document defines the release process for Friday.

## Prerequisites

- Maintainer access to `main`
- GitHub Actions enabled
- Optional repository variable: `RELEASE_PUBLISH_NPM` (`true`, `false`, or unset for auto)
- Clean working tree

## Release Quality Gate

Run both of these from the repository root before tagging:

```bash
npm run release:verify:repo
npm run release:verify
```

`release:verify:repo` verifies deterministic repo health:

- typecheck
- lint
- build (API + UI)
- full test suite
- migration/adversarial/SSD quality checks
- install smoke test (`npm pack` + isolated install/run)
- release artifact validation (`release:check`)

`release:verify` verifies live proof only:

- real green gate against a live Friday runtime
- no-mock leak scan over proof inputs
- current truth-audit artifacts

Do not tag a release if `release:verify` is green but the truth artifacts still conclude `shipable with explicit de-scope` or `not shipable` and the release notes do not carry that boundary forward.

## Release Artifacts (Must Be Present)

Before tagging, confirm these release surfaces are complete:

- `package.json` version equals target tag
- `CHANGELOG.md` contains the target version section
- release notes are prepared (use `docs/RELEASE_NOTES_TEMPLATE.md`)
- `LICENSE` is present (MIT)
- `.github/SECURITY.md` is current
- latest `CI` workflow run for `main` is green
- current runtime snapshot is captured
- current claim matrix is present
- current defect ledger is present
- current isolated review result is present
- no-mock contamination check for the proof inputs passes
- release verdict is explicitly recorded as `shipable as-is`, `shipable with explicit de-scope`, or `not shipable`

## Standard Release (npm + GitHub Release)

1. Update `CHANGELOG.md` with release notes under the target version.
2. Bump version:

```bash
npm version <patch|minor|major> --no-git-tag-version
```

3. Run `npm run release:verify:repo` again.
4. Run `npm run release:verify` again.
5. Link the current runtime snapshot, claim matrix, defect ledger, isolated review result, and ship verdict in the release notes.
6. Commit release metadata:

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore(release): vX.Y.Z"
```

7. Create and push a tag:

```bash
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

8. `release.yml` runs on the tag:
   - re-runs release verification
   - verifies `tag == package.json version`
   - publishes to npm when mode allows and credentials are available
   - creates GitHub Release

## Fallback Release (GitHub-only)

If `NPM_TOKEN` is not configured, `release.yml` automatically skips npm publish and still creates the GitHub Release.

You can force behavior with repository variable `RELEASE_PUBLISH_NPM`:

- `true`: always attempt npm publish
- `false`: never publish to npm (GitHub-only release)
- unset: auto (publish only when `NPM_TOKEN` exists)

1. Follow steps 1-5 above.
2. Confirm workflow log includes "npm publish: skipped (NPM_TOKEN missing)".
3. Mark release notes as GitHub source-only (no npm package).

## Rollback / Remediation

- npm package issues: publish a patch version and deprecate the broken version.
- GitHub tag issues: create a follow-up patch tag; do not force-move existing release tags.
- Security incidents: follow `.github/SECURITY.md`, patch forward, and publish advisory notes in release changelog.
