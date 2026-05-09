# Cross-border Product Scout

Turn detected market signals (or an upstream spike review) into screened follow-up directions and explicit human-review checkpoints.

## When to use

- The cross-border `weekly-hot-product-review` workflow is enabled (this skill is the chained second step).
- The user paste market signals or runs the spike detector and wants a clear scouting next-step list.

## Inputs

- `marketSignals` (string, required): one observation per line, OR a spike-review summary forwarded from `cross-border-spike-detector`.

## Outputs

- `productScout`: a multi-line follow-up direction summary.
- `summary`: one-line headline.
- `nextStep`: recommended next operator action; defaults to a human-approval prompt when procurement / launch language appears.
- `details`: structured cluster + approval-block data for UI rendering.

## Behavior

- Deterministic keyword bucketing across upstream market signals, supplier outreach, creative direction, competitive pressure, demand signal, and reject signals.
- Surfaces explicit approval-block triggers when notes mention sampling, procurement, or auto-listing.
- No external network calls, no filesystem writes, no provider dependency.
- Returns a soft empty bundle when notes are missing instead of inventing findings.
