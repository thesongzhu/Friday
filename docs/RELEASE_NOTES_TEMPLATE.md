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

1. `npm install -g friday@X.Y.Z` (or source rebuild)
2. Verify config/env changes
3. Run `npm run release:verify` in source deployments

## Verification Evidence

- CI workflow run: `<url>`
- Release workflow run: `<url>`
- Install smoke test result: `pass/fail`
- Known issues: `none` / list

## Rollback

- Rollback strategy: publish forward patch (`vX.Y.(Z+1)`) and document remediation.
