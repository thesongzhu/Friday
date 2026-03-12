# Friday Capability Matrix

This document is the user-facing capability contract for **today's Friday**. It is intentionally narrower than long-horizon architecture and roadmap docs.

If this file conflicts with older design material, use this file together with [current-source-of-truth.md](../current-source-of-truth.md) as the active boundary.

## Status Vocabulary

- `Validated and keep`: active, tested, and part of the steady-state product contract
- `Validated but temporary`: works today, but is intentionally transitional or bounded
- `Deferred`: intentionally outside today's delivery boundary

## What Friday Can Do Today

| Area | What Friday can do now | Supervision / boundary | Status |
| --- | --- | --- | --- |
| Agent OS system control | Operate the Agent OS control plane through `/v1/system/*`, the Operator Console, `/assistant`, `/workflows`, `/skills`, `/fleet`, and `/observability` | High-risk actions remain policy-gated; platform rollout is still separate | `Validated and keep` |
| Beginner assistant | Accept plain-language goals, show issue inbox, resolve intents, run guided wizards, deploy workflows, and surface fix approvals through `/assistant` | It is beginner-first, not a replacement for unrestricted autonomous reasoning | `Validated and keep` |
| Expert autonomy mode | Use opt-in bounded autonomy to infer context, ask minimal decisive questions, run safe probes, and carry richer troubleshooting evidence across `/assistant`, self-healing, workflows, skills, fleet, and observability | Destructive or sensitive operations still stop at final approval, and all probes must stay observable | `Validated and keep` |
| Self-healing | Detect incidents, produce diagnoses, propose fixes, auto-execute low-risk repairs, verify, roll back, and pause after repeated failures | Supervised autonomy only; high-risk actions require approval | `Validated and keep` |
| Workflows | Generate, deploy, export, run, visualize, and recover workflows across `/assistant` and `/workflows` | Does not promise unconstrained builderless orchestration for every edge case | `Validated and keep` |
| Skills lifecycle | Generate, validate, self-test, install, update, delete, verify, and manage marketplace sources through `/v1/skills/*`, `/v1/marketplace/sources*`, and `/skills` | This is the primary marketplace backbone; future workflow and agent assets should extend the same trust/install/enable path rather than replace it | `Validated and keep` |
| Marketplace assets catalog | Browse unified public marketplace asset catalog and detail views for declarative `skill`, `workflow`, and `agent` assets through `/v1/marketplace/assets*` | Discovery is unified, skills remain the canonical install/verify/enable backbone, and legacy executable packages are hidden from the ordinary public catalog by default | `Validated but temporary` |
| Creator support and request board | Support creators directly through asset support events, creator profiles, and multi-signal reputation summaries, then route unmet needs into the personal request board | Free-first and 0%-commission by design; ratings alone do not determine trust or ranking | `Validated and keep` |
| Request board | Post and respond to personal `skill`, `workflow`, and `agent` requests through `/v1/marketplace/requests*` | Connector-only surface: no guarantees, no escrow, no arbitration, and no after-sales support | `Validated but temporary` |
| Plugin distribution | Browse, inspect, install, enable, disable, uninstall, and version plugins through `/v1/plugins*` and `/v1/marketplace/plugins*` | Distinct from the skills lifecycle and not the primary beginner story | `Validated and keep` |
| Plugin marketplace and commerce | Support publisher, listing, pricing, entitlement, purchase, install, refund, and payout flows when the marketplace runtime is configured | Bounded operator/admin capability; distinct from the skills-first marketplace backbone and not the primary public ecosystem story. Legacy executable assets remain in this bounded surface, not the default public marketplace, and public creator support remains the primary user-facing reward path | `Validated but temporary` |

Marketplace creator-ecosystem closeout evidence: [latest.md](./docs/reports/closeout/marketplace-creator-ecosystem/latest.md)
| Observability and alerts | Show traces, audit logs, alerts, SLOs, alert destinations, health summaries, and time-series through `/v1/observability/*` and `/observability` | Operator-facing surface; beginner views only get summarized issue state | `Validated and keep` |
| Fleet and satellites | Register satellites, pair them, sync them, place workflow nodes on hub or satellites, surface offline blocking, and operate them from `/fleet` | Discovery is intentionally bounded; no full mesh or federation today | `Validated and keep` |
| Acceptance / retry / rules | Run sandboxed acceptance checks, keep version history, enforce provider circuit breakers, replay retries, and explain rules decisions | Advanced ML-style anomaly systems and natural-language rule authoring are deferred | `Validated and keep` |

## What Friday Usually Does Only Under Supervision

- Friday can propose and sometimes auto-apply **low-risk** fixes.
- Friday must stop for approval on **higher-risk** actions.
- Friday should not auto-execute a fix when any of these are missing:
  - rollback plan
  - acceptance verification
  - evidence sink
- Friday can pause itself after repeated failures instead of retrying forever.
- Friday can use expert mode to infer bounded defaults and try safe probes before asking, but it must still surface assumptions and stop at final approval for destructive or sensitive actions.

## Why Friday Can Still Feel Limited

Friday is not supposed to behave like an unrestricted autonomous employee in every situation. It is intentionally bounded by:

- supervised autonomy defaults
- approval gates for higher-risk actions
- bounded fleet and distributed execution scope
- bounded plugin marketplace/commerce scope
- explicit deferral of richer federation, mesh discovery, and unrestricted autonomy

That means the current product is good at:

- structured issue detection
- bounded remediation
- operator-visible evidence and recovery

## What Friday does **not** reliably claim today

Friday is not yet meant to guarantee:

- long-horizon autonomous troubleshooting without policy gates
- arbitrary cross-system self-directed recovery
- full human-level adaptive judgment in ambiguous environments

## Deferred By Design

These are intentionally outside the current non-platform closure boundary:

- unrestricted autonomous loop beyond supervised self-healing
- richer offline plan generation beyond recovery of already-dispatched work
- richer discovery such as mDNS, relay mesh, and Tailscale-native discovery
- full multi-hub federation and cross-hub placement
- ML-heavy anomaly detection
- natural-language rule authoring
- marketplace-style expansion for acceptance or rules

## Related References

- [Current Source Of Truth](../current-source-of-truth.md)
- [Friday Vision](../VISION.md)
- [Friday vs OpenClaw](./friday-vs-openclaw.md)
- [Non-Platform Final Closeout Evidence](../reports/closeout/final-non-platform/latest.md)
