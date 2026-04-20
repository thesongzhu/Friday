# Workflows

Target users:
- builders
- managers of repeatable work

Page tasks:
- browse workflow library
- open builder
- inspect runs and evidence
- retry or recover failed executions

Module order:
1. Workflow summary and filters
2. Workflow library list
3. Selected workflow detail
4. Builder entry and builder shortcuts
5. Run history
6. Evidence and retry panel

Desktop layout:
- list-detail core layout
- builder entry pinned in the detail region
- run history below selected workflow detail

Mobile mapping:
- workflow list first
- selected workflow drill-in
- builder and runs as sub-tabs

Right-rail chat linkage:
- inject `workflowId`, `latestRuns`, `builderContext`, `retryableFailures`
- quick actions: build variant, rerun, explain failure

States:
- loading: list and detail skeleton
- empty: explain how to create or import the first workflow
- error: keep library filters and create actions available
- partial: list visible even when run history lags
- success: workflow, builder entry, runs, and evidence align

Forbidden:
- no builder hidden behind a tertiary settings menu
- no failed run without retry or evidence path
- no workflow detail page that loses chat context
