# Cross-border Weekly Growth Review

Cluster the week's operating signals into keep / change / stop guidance for the daily cross-border routine.

## When to use

- The cross-border `weekly-operating-profile-tune` workflow is enabled (this skill is the first step in that workflow).
- The user pastes weekly operating signals and wants a tuning board for the next week's daily routine.

## Inputs

- `weeklySignals` (string, required): one observation per line. Mixed Chinese/English notes are supported.

## Outputs

- `weeklyReview`: a multi-line keep / change / stop summary; this output is consumed by `cross-border-listing-image-layout-audit` in the chained workflow.
- `summary`: one-line headline.
- `nextStep`: recommended next operator action; defaults to a human-approval prompt when high-impact tuning language appears.
- `details`: structured weekly cluster + high-impact signal data for UI rendering.

## Behavior

- Deterministic keyword bucketing across keep, change, stop, learning, and operating-friction signals.
- Surfaces explicit high-impact tuning triggers when notes mention disabling workflows, raising automation, or removing approval.
- No external network calls, no filesystem writes, no provider dependency.
- Returns a soft empty bundle when notes are missing instead of inventing findings.
