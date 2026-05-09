# Cross-border Spike Detector

Cluster product spike notes from sales, viral creators, paid ads, search trends, and category lifts into a weekly spike review.

## When to use

- The cross-border `weekly-hot-product-review` workflow is enabled (this skill is the first step in that workflow).
- The user pastes weekly spike notes and wants a focused screening of which spikes are worth scouting.

## Inputs

- `spikeSignals` (string, required): one observation per line. Mixed Chinese/English notes are supported.

## Outputs

- `spikeReview`: a multi-line cluster summary of detected spikes; this output is consumed by `cross-border-product-scout` in the chained workflow.
- `summary`: one-line headline.
- `nextStep`: recommended next operator action; defaults to a risk prompt when IP/compliance language appears.
- `details`: structured cluster + risk-signal data for UI rendering.

## Behavior

- Deterministic keyword bucketing across sales spike, viral signal, paid ad lift, search trend, and category-wide lift.
- Surfaces explicit IP/compliance risk flags before recommending any sampling/procurement follow-up.
- No external network calls, no filesystem writes, no provider dependency.
- Returns a soft empty bundle when notes are missing instead of inventing findings.
