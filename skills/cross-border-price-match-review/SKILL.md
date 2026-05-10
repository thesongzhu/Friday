# Cross-border Price Match Review

Cluster competitor price, coupon, shipping, and bundle observations into a price-gap review with explicit human-approval guidance.

## When to use

- The cross-border `daily-price-gap-watch` workflow is enabled.
- The user pastes daily competitor price/coupon/shipping notes and wants to know whether to match, hold, or wait for human review.

## Inputs

- `priceSignals` (string, required): one observation per line. Mixed Chinese/English notes are supported.

## Outputs

- `priceReview`: a multi-line cluster summary suitable for the price-gap review.
- `summary`: one-line headline.
- `nextStep`: recommended next operator action; defaults to a human-review prompt when match-style language appears.
- `details`: structured cluster + language + human-review signal data for UI rendering.

## Behavior

- Deterministic keyword bucketing across price drop, price increase, coupon stack, shipping promise, bundle framing, and listing-quality gap.
- Surfaces explicit human-approval triggers when notes mention price-match, subsidy, or budget moves.
- No external network calls, no filesystem writes, no provider dependency.
- Returns a soft empty bundle when notes are missing instead of inventing findings.
