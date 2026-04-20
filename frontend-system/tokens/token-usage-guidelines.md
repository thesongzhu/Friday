# Token Usage Guidelines

Color:
- use semantic color roles, not page-specific hex values
- state colors are reserved for status and feedback
- `accent.primary` is for active controls, not full-page backgrounds

Typography:
- display font is for page titles, cards with product narrative, and major empty states
- body font is the default for operational content
- mono is only for ids, paths, logs, and secrets metadata

Spacing:
- `space.4` and `space.6` are the default interior card spacing
- `space.8` or above is for page sections and shell gutters

Radius:
- keep small controls at `radius.sm`
- cards and drawers use `radius.md` or `radius.lg`
- pills and chips use `radius.pill`

Shadow:
- only cards, overlays, and focused regions get shadows
- never stack multiple large shadows in the same viewport

Motion:
- use motion to explain shell transitions, drawer entry, and ordered content reveals
- do not animate purely decorative UI at the expense of clarity
