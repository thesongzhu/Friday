# Friday Vision

> **"Your AI Automation Employee"** remains the long-term vision. The current non-platform product milestone is now: **self-healing + assistant + observability + workflow deploy surfaces as one closed-loop operator product**.

> **Expectation reset:** Friday's current non-platform product is a **supervised, bounded automation system**. It can detect issues, propose fixes, execute low-risk repairs, verify outcomes, and expose evidence, but it is not yet an unrestricted autonomous problem-solver.

## Current Product Truth

Friday now ships a real Agent OS core:

- `/v1/system/*` backend orchestration
- `/v1/diagnosis/*` and `/v1/auto-fix/*` self-healing APIs
- `/v1/uix/*` beginner-friendly assistant APIs
- an Agent OS web Operator Console
- a beginner-first `/assistant` surface inside the same web app
- trusted-device passkey remote access
- launchd-managed macOS startup with a native Swift/AppKit companion
- companion-backed app, window, URL, project, and notification actions
- direct skill generation with explicit test and evidence before save
- a full skills lifecycle surface with `/v1/skills/*`, `/v1/marketplace/sources*`, and an operator-facing `/skills` page
- a marketplace direction whose primary backbone remains the skills lifecycle, with any future public workflow/agent asset story extending that same trust/install/enable path rather than replacing it
- a creator-support model where public marketplace assets remain free-first, users can support creators directly, and the platform does not act as a commission-taking, after-sales marketplace operator
- a wired observability surface with `/v1/observability/*` plus an operator-facing `/observability` page
- one-click workflow deploy and export orchestration backed by workflow drafts, publish, runs, and evidence
- a full operator-facing `/workflows` surface backed by shared workflow state and graph visualization
- a real fleet control plane with `/v1/fleet/*`, `/v1/satellites/*`, distributed workflow placement, and an operator-facing `/fleet` page
- an opt-in expert autonomy mode that can infer bounded context, run safe probes, and guide ambiguous users to an executable plan across `/assistant`, self-healing, workflows, skills, and fleet

This means the current product story is no longer "future workflow platform only". The truthful story is:

1. Friday already has a working Agent OS stack on macOS.
2. Friday can detect failures, propose fixes, require approval when needed, and expose evidence to both operators and beginner users.
3. Friday now has a real skills lifecycle from generation and import through validation, install, update, delete, verification, and source trust management.
4. Friday's marketplace direction remains skills-first: workflow and agent assets may join the same ecosystem, but they do not displace the skills lifecycle as the primary backbone.
5. Creator support and request-style matching now sit above that backbone: users can support creators directly and post personal `skill`, `workflow`, or `agent` requests while Friday remains a connector rather than a guarantor.
5. Public marketplace monetization is support-first and creator-support oriented rather than a traditional commission-based store.
6. Friday now has an operator-facing observability layer for trace, audit, alerts, health, and time-series that explains those flows.
7. Cross-platform distribution remains important, but it is not the current non-platform build target.

## Reality And Expectation Boundary

Friday can already do the following in a stable non-platform product loop:

- operate an Agent OS control plane through `/assistant`, `/workflows`, `/skills`, `/fleet`, and `/observability`
- detect incidents, diagnose likely causes, propose fixes, auto-execute low-risk fixes, verify results, roll back, and pause itself after repeated failures
- generate skills and workflows, explicitly test them, and carry them through install, deploy, evidence, and recovery paths
- use expert mode to infer bounded defaults, ask fewer but more decisive questions, and try safe probes before escalating in complex scenarios
- expose trace, audit, alerts, SLOs, acceptance evidence, retry replay, and rules explanations to operators

Friday still does **not** claim the following today:

- unrestricted long-horizon autonomous troubleshooting
- arbitrary cross-system self-directed recovery without policy gates
- unrestricted expert autonomy that can freely perform destructive or production-sensitive actions without final approval
- richer offline plan generation beyond recovery of already-dispatched work
- full federation, cross-hub placement, or richer mesh discovery beyond the current fleet baseline
- ML-heavy anomaly detection, natural-language rule authoring, or marketplace-style expansion for acceptance/rules

OpenClaw expectation-setting:

- Friday matches OpenClaw on the **explicitly tracked overlap surfaces** in the bridge matrix.
- That does **not** mean Friday is identical to OpenClaw in every troubleshooting situation.
- Friday still differs because unrestricted autonomy and deeper remediation/federation behaviors remain deferred by design.

Supporting references:

- [Capability Matrix](./ops/friday-capability-matrix.md)
- [Friday vs OpenClaw](./ops/friday-vs-openclaw.md)
- [Current Source Of Truth](./current-source-of-truth.md)

## Current Milestone

### Workflow and skills product closeout

The near-term milestone is:

1. keep self-healing incidents, diagnosis, auto-fix, approval, execution, rollback, and lessons on the steady-state product path
2. keep skills direct generation as a first-class flow with explicit test and evidence
3. make `/assistant` a real beginner-first surface instead of an RFC-only direction
4. keep `/v1/observability/*` and `/observability` as the operator-facing truth for trace, audit, alerts, health, and time-series
5. expose one-click workflow deploy and export as a product surface instead of manual API chaining
6. make `/workflows` the operator-facing workflow control plane instead of a deferred or redirected page
7. keep `/v1/skills/*`, `/v1/marketplace/sources*`, and `/skills` as the canonical skill lifecycle path instead of leaving skill generation disconnected from install and verification
8. keep marketplace truth anchored to the skills lifecycle backbone even as workflow and agent assets join the broader public ecosystem
9. keep creator support and request-board features explicitly bounded: `0%` commission, no escrow, no guarantees, and no after-sales promises
10. keep the marketplace creator-ecosystem closeout evidence in sync with the active product story: [reports/closeout/marketplace-creator-ecosystem/latest.md](./docs/reports/closeout/marketplace-creator-ecosystem/latest.md)

## Status Labels

These labels mirror the repo truth rather than an idealized roadmap.

### Validated And Keep

- `system` backend service and `/v1/system/*` routes
- self-healing incident, diagnosis, auto-fix, approval, execution, rollback, and metrics routes
- beginner-first `/assistant` web surface backed by `/v1/uix/*`
- wired observability API surface backed by `/v1/observability/*`
- operator-facing `/observability` web surface
- workflow deploy orchestration routes for deploy, overview, and visualization
- operator-facing `/workflows` web surface aligned with `/assistant` workflow cards
- operator-facing `/skills` web surface aligned with generator and marketplace lifecycle state
- fleet read/control routes plus operator-facing `/fleet` surface
- distributed workflow node placement across `hub`, explicit satellites, and capability-matched satellites
- Agent OS web console in `ui/src`
- Unix domain socket JSON-RPC companion transport
- trusted-device passkey flows
- health, degraded mode, safe mode, and recovery surfacing
- native Swift/AppKit macOS companion in `apps/macos/FridayCompanion`
- macOS release scripts, verification, and release-record generation
- macOS DMG packaging script and release manifest generation
- skill generator draft self-test, evidence, and self-healing handoff
- skill lifecycle APIs for catalog, detail, install, update, delete, verify, and marketplace source management
- source and npm distribution as the current desktop developer fallback
- observability route registration, dashboard overview, time-series, repeated self-healing failure alerts, and release-grade SLO/dispatch defaults
- acceptance sandboxing and acceptance test version history
- provider-level retry circuit breakers, retry replay evidence, and operator-visible retry cost or escalation summaries
- explainable rules simulation and audit-log visibility in the operator surface

### Validated But Temporary

- Node companion daemon fallback for development
- source or npm install as the main Windows operator fallback
- browser access as the temporary iOS and Android operator fallback until dedicated mobile apps ship
- Windows native companion scaffold without a release-complete installer

### Missing

- real Apple-signed and notarized production macOS artifact with release credentials
- Sparkle appcast and Homebrew publication evidence for the macOS beta baseline
- iOS TestFlight remote console beta
- Android Play internal or closed beta remote console
- Windows MSI release path
- clean-machine or device release validation for all intended platforms

## What Is Deferred

These directions remain important, but they are not the next immediate build target:

- unrestricted autonomous agent loop beyond the supervised self-healing surface
- richer offline plan generation and cross-hub remediation/federation beyond the current single-hub fleet baseline
- deeper fleet-triggered remediation beyond the current satellite degradation/offline ingestion, cooldown sweep, and operator loop visibility

## Near-Term Roadmap

1. **Platform rollout resumes after the product-surface closeout**
   - macOS release baseline closeout
   - iOS remote console beta
   - Android remote console beta
   - Windows last-mile desktop shell
2. **Longer-horizon product work after that**
   - broader autonomous agent loop beyond supervised self-healing
