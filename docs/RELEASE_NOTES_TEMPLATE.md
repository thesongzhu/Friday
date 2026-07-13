# Release Notes Template

Use this template when preparing a release tag `vX.Y.Z`.

## Release Summary

- Version: `vX.Y.Z`
- Date: `YYYY-MM-DD`
- Release type: `patch | minor | major`

## Highlights

- 
- 
- 

## Breaking Changes

- None.

(or list each breaking change with migration action)

## Added

- 

## Changed

- 

## Fixed

- 

## Security

- 

## Upgrade Notes

1. `npm install -g @thesongzhu/friday@X.Y.Z` (or source rebuild) — developer/build/tooling surface, not a consumer install path
2. Verify config/env changes
3. Run `npm run release:verify:repo` for repo-ready verification
4. Run `npm run release:verify` for live proof plus truth-audit artifacts

## Verification Evidence

- Repo-ready verification: `pass/fail`
- Runtime snapshot: `<path or url>`
- Live proof lane(s): `real-provider / real-browser / real-runtime / cloud-live / manual-external`
- Claim matrix: `<path or url>`
- Defect ledger: `<path or url>`
- Isolated review result: `<path or url>`
- Truth audit artifact: `<path or url>`
- No-mock contamination check: `pass/fail`
- Ship verdict: `shipable as-is | shipable with explicit de-scope | not shipable`
- Known de-scopes / blocked-by-env lanes: `none` / list

## Rollback

- Rollback strategy: publish forward patch (`vX.Y.(Z+1)`) and document remediation.
