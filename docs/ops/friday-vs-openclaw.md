# Friday vs OpenClaw

This document answers a narrow question: **how close is Friday to OpenClaw on the overlap that the repo explicitly tracks today?**

It does **not** claim that Friday and OpenClaw are identical products in every situation.

## Short Answer

- **Yes:** Friday has closed the explicitly tracked OpenClaw overlap goals in the bridge matrix.
- **No:** that does not mean Friday can do everything OpenClaw can do in every troubleshooting or autonomy scenario.

The authoritative overlap record is:

- [friday-openclaw-bridge-matrix-2026-03-01-en.csv](../reports/ops/friday-openclaw-bridge-matrix-2026-03-01-en.csv)

That matrix currently marks the tracked overlap items as `DONE`.

## What “Parity” Means Here

In this repo, parity means parity on the **tracked overlap scope**, including areas such as:

- model routing and fallback observability
- requested-model pinning
- single source of config truth
- inbound channel handling and typing behavior
- multi-turn context packaging
- tool execution truthfulness
- read-only safety enforcement
- visible browser and desktop control wiring
- gateway connectivity reporting
- token and cost observability
- memory loop closure
- channel security policy
- marketplace asset and pricing guardrails
- channel-to-agent routing
- one-click runtime convergence

If you ask “can Friday do the same thing as OpenClaw?”, the honest answer is:

- **yes on those tracked overlap surfaces**
- **not automatically yes outside those tracked overlap surfaces**
- **not full behavioral identity**

## Where Friday Is Still More Bounded

Friday is intentionally more explicit about supervised boundaries in the current product contract.

The current deferred or bounded areas include:

- unrestricted autonomous loop beyond supervised self-healing
- deeper fleet-triggered remediation beyond the current degradation/offline ingestion and operator-visible recovery flows
- richer discovery, federation, and mesh behavior
- platform rollout work that still sits outside the non-platform closeout

Those boundaries are documented in:

- [VISION.md](../VISION.md)
- [current-source-of-truth.md](../current-source-of-truth.md)
- `docs/current-source-of-truth.md`

## Why Friday Can Still Miss Expectations

If Friday feels “dumb” or fails to solve a problem, the usual reasons are:

1. The request expects broader autonomy than the current supervised product boundary allows.
2. The task needs judgment across ambiguous systems where Friday is designed to stop for approval instead of improvising.
3. The request falls into a deferred area such as richer federation, deeper fleet remediation, or unrestricted long-horizon troubleshooting.
4. The product surface is strong on evidence and bounded repair, but not yet meant to act like a fully unconstrained autonomous engineer.

## What Friday Can Reliably Claim Today

Friday can truthfully claim that it can:

- detect incidents
- diagnose likely causes
- propose fixes
- auto-execute low-risk fixes
- verify or roll back outcomes
- pause after repeated failures
- expose operator-visible evidence, alerts, and audit trails

Friday should **not** currently claim that it can:

- autonomously solve every hard problem OpenClaw or a human operator might solve
- behave as an unrestricted general-purpose autonomous employee
- recover across every cross-system failure mode without policy gates

## Related References

- [Friday Capability Matrix](./friday-capability-matrix.md)
- [Current Source Of Truth](../current-source-of-truth.md)
- [Friday Vision](../VISION.md)
