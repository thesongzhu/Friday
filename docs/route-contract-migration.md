# Route Contract Migration

This document is the release note and tooling migration reference for the
public `operationId` normalization introduced in the March 2026 cleanup batch.

## Summary

- HTTP paths are unchanged.
- Runtime route registration now accepts only canonical lowercase dot-segment
  `operationId` values.
- The machine-readable source of truth remains
  `FRIDAY_ROUTE_OPERATION_ID_RENAMES` in
  `src/api/http/friday-http-route-contract.ts`.
- SDKs, generated clients, route snapshots, and any internal tooling that keys
  off `operationId` must migrate to the canonical names below.

## Contract changelog

- Removed acceptance of non-canonical legacy `operationId` spellings at
  runtime registration time.
- Standardized route naming to lowercase dot-segment form.
- Preserved network compatibility by keeping HTTP paths and methods unchanged.
- Preserved route uniqueness and snapshot stability through contract tests.

## SDK and tooling migration note

If your integration stores, matches, or generates code from `operationId`
values:

1. Replace every legacy identifier with its canonical target.
2. Do not depend on runtime aliases; only canonical names are registered.
3. Regenerate route snapshots and any SDK artifacts after applying the rename
   map.
4. Treat this as a contract migration for tooling only, not a network-path
   migration.

## Rename map

The list below mirrors the machine-readable source in
`src/api/http/friday-http-route-contract.ts`.

| Legacy `operationId` | Canonical `operationId` |
| --- | --- |
| `auth.bootstrap.localPassphrase` | `auth.bootstrap.local.passphrase` |
| `cancelAgentRun` | `agent.runs.cancel` |
| `desktop.permissions.listDecisions` | `desktop.permissions.decisions.list` |
| `desktop.policies.addRule` | `desktop.policies.rules.create` |
| `desktop.policies.removeRule` | `desktop.policies.rules.delete` |
| `desktop.recordings.listSteps` | `desktop.recordings.steps.list` |
| `discovery.getCatalog` | `discovery.catalog.get` |
| `discovery.getPolicy` | `discovery.policy.get` |
| `discovery.listPrograms` | `discovery.programs.list` |
| `discovery.updatePolicy` | `discovery.policy.update` |
| `marketplace.listings.submitForReview` | `marketplace.listings.review.submit` |
| `marketplace.publishers.reviewVerification` | `marketplace.publishers.verification.review` |
| `marketplace.publishers.submitVerification` | `marketplace.publishers.verification.submit` |
| `marketplace.skills.syncStatus` | `marketplace.skills.status.sync` |
| `nodeRunner.execute` | `node.runner.execute` |
| `nodeRunner.executions.get` | `node.runner.executions.get` |
| `nodeRunner.executions.list` | `node.runner.executions.list` |
| `observability.alertRules.create` | `observability.alert.rules.create` |
| `observability.alertRules.delete` | `observability.alert.rules.delete` |
| `observability.alertRules.get` | `observability.alert.rules.get` |
| `observability.alertRules.list` | `observability.alert.rules.list` |
| `observability.alertRules.update` | `observability.alert.rules.update` |
| `packaging.packages.checkDependencies` | `packaging.packages.dependencies.check` |
| `packaging.packages.listVersions` | `packaging.packages.versions.list` |
| `security.secrets.accessLog` | `security.secrets.access.log` |
| `workflows.importBundle` | `workflows.bundles.import` |
