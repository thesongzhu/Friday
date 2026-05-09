# Cross-border Listing Image Layout Audit

Audit listing image and layout notes — first-impression hero, info hierarchy, lifestyle vs studio, copy density, trust signals, compliance — into a follow-up checklist.

## When to use

- The cross-border `weekly-operating-profile-tune` workflow is enabled (this skill is the chained second step).
- The user pastes listing image / detail-page / layout observations and wants a follow-up audit checklist.

## Inputs

- `listingNotes` (string, required): one observation per line, OR a weekly-review summary forwarded from `cross-border-weekly-growth-review`.

## Outputs

- `listingAudit`: a multi-line audit summary suitable for the listing follow-up checklist.
- `summary`: one-line headline.
- `nextStep`: recommended next operator action; defaults to a human-approval prompt when auto-publish / overwrite language appears.
- `details`: structured listing cluster + human-review signal data for UI rendering.

## Behavior

- Deterministic keyword bucketing across hero, info hierarchy, lifestyle vs studio, copy density, trust signals, and compliance layout.
- Surfaces explicit human-approval triggers when notes mention auto-publish, live overwrite, or compliance edits.
- No external network calls, no filesystem writes, no provider dependency.
- Returns a soft empty bundle when notes are missing instead of inventing findings.
