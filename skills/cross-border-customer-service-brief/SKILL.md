# Cross-border Customer Service Brief

Cluster refund, return, complaint, and bad-review notes into a daily support brief with response guidance and escalation hints.

## When to use

- The cross-border `daily-customer-service-sweep` workflow is enabled.
- The user pastes daily support/refund/return/bad-review notes and wants a focused triage brief.

## Inputs

- `serviceNotes` (string, required): one observation per line. Mixed Chinese/English notes are supported.

## Outputs

- `serviceBrief`: a multi-line cluster summary suitable for the support brief.
- `summary`: one-line headline.
- `nextStep`: recommended next operator action; defaults to escalation guidance when escalation language appears.
- `details`: structured cluster + escalation data for UI rendering.

## Behavior

- Deterministic keyword bucketing across refund pressure, return pressure, delivery complaints, product quality, bad reviews, and policy disputes.
- Surfaces explicit escalation triggers when notes mention platform appeal, chargeback, or fraud language.
- No external network calls, no filesystem writes, no provider dependency.
- Returns a soft empty bundle when notes are missing instead of inventing findings.
