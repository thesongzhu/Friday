# Summarize Shop Performance

Cluster cross-border store-health, refund, fulfillment, ad-spend, and listing-quality notes into a daily action board.

## When to use

- The cross-border `daily-store-health-check` workflow is enabled.
- The user pastes daily store-performance notes from TikTok Shop or Amazon and wants a focused triage list.

## Inputs

- `performanceNotes` (string, required): one observation per line. Mixed Chinese/English notes are supported.

## Outputs

- `issueClusters`: a multi-line cluster summary suitable for the daily action board.
- `summary`: one-line headline.
- `nextStep`: recommended next operator action.
- `details`: structured cluster + language + highlight data for UI rendering.

## Behavior

- Deterministic keyword bucketing across fulfillment, cancellation, refund, ad spend, listing quality, shop score, and inventory risk.
- No external network calls, no filesystem writes, no provider dependency.
- Returns a soft empty bundle when notes are missing instead of inventing findings.
