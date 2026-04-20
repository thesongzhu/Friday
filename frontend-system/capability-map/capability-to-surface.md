# Capability To Surface

Primary ownership by page:
- `Home`: live work, pending approvals, recent outcomes, pinned packs, recommended next actions
- `Chat`: task orchestration, tool activity, action cards, conversation-first control
- `Assistant`: approvals, issues, recovery, evidence receipts
- `Workflows`: workflow library, builder entry, run history, retry/evidence
- `Automations`: schedules, queue, quick run, execution history
- `Memory`: search, learned facts, record provenance, retention controls
- `Integrations`: Packs, Skills, Plugins, MCP, Channels
- `Observability`: health, trace, audit, retry, learning, incidents, diagnosis
- `Fleet`: nodes, satellites, pairing, sync
- `Settings`: providers, routing, security, secrets, grants, tokens, runtime, setup, utilities

Secondary ownership rules:
- if a capability generates blocked work, `Assistant` is the fallback surface
- if a capability generates evidence or diagnosis, `Observability` is the fallback surface
- if a capability is configuration-heavy, `Settings` is the fallback surface
- if a capability requires direct steering, `Chat` is the contextual fallback surface

Visibility rules:
- `primary`: always visible in the owning page
- `secondary`: visible after the primary summary or as a tab/detail section
- `advanced`: visible in progressive disclosure UI, never hidden behind unrelated pages
- `diagnostic`: only for operator or trust context, but still anchored to a page
