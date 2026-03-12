# Releasing Friday

This document defines the release process for Friday.

## Prerequisites

- Maintainer access to `main`
- GitHub Actions enabled
- Optional repository variable: `RELEASE_PUBLISH_NPM` (`true`, `false`, or unset for auto)
- Clean working tree

## Release Quality Gate

Run this from the repository root before tagging:

```bash
npm run release:verify
```

This verifies:

- typecheck
- lint
- build (API + UI)
- full test suite
- migration/adversarial/SSD quality checks
- install smoke test (`npm pack` + isolated install/run)
- release artifact validation (`release:check`)

## Release Artifacts (Must Be Present)

Before tagging, confirm these release surfaces are complete:

- `package.json` version equals target tag
- `CHANGELOG.md` contains the target version section
- release notes are prepared (use `docs/RELEASE_NOTES_TEMPLATE.md`)
- `LICENSE` is present (MIT)
- `SECURITY.md` is current
- latest `CI` workflow run for `main` is green

## Standard Release (npm + GitHub Release)

1. Update `CHANGELOG.md` with release notes under the target version.
2. Bump version:

```bash
npm version <patch|minor|major> --no-git-tag-version
```

3. Run `npm run release:verify` again.
4. Commit release metadata:

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore(release): vX.Y.Z"
```

5. Create and push a tag:

```bash
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

6. `release.yml` runs on the tag:
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
- Security incidents: follow `SECURITY.md`, patch forward, and publish advisory notes in release changelog.
