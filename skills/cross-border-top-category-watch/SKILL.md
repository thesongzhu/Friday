# Cross-border Top Category Watch

Cluster category Top 10 movement, seller shifts, pricing changes, and creative updates into a daily watch board.

## When to use

- The cross-border `daily-category-top10-watch` workflow is enabled.
- The user pastes daily category watch notes for the chosen L1/L2 lane and wants a focused movement summary.

## Inputs

- `categoryWatchNotes` (string, required): one observation per line. Mixed Chinese/English notes are supported.

## Outputs

- `watchBoard`: a multi-line cluster summary suitable for the daily watch board.
- `summary`: one-line headline.
- `nextStep`: recommended next operator action.
- `details`: structured cluster + language + highlight data for UI rendering.

## Behavior

- Deterministic keyword bucketing across new entrants, rank climbers, rank drops, price actions, creative updates, seller shifts, and compliance signals.
- No external network calls, no filesystem writes, no provider dependency.
- Returns a soft empty bundle when notes are missing instead of inventing findings.
