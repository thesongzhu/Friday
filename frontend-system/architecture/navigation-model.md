# Navigation Model

## Desktop

Primary rail order:
1. Home
2. Chat
3. Assistant
4. Workflows
5. Automations
6. Memory
7. Integrations
8. Observability
9. Fleet
10. Settings

Navigation behavior:
- the left rail stays stable
- page headers show the current object, not duplicate the rail
- secondary navigation lives inside the page as tabs, segmented controls, or list-detail states

Examples of second-level grouping:
- `Workflows`: Library, Builder, Runs, Evidence
- `Integrations`: Packs, Skills, Plugins, MCP, Channels
- `Observability`: Trace, Audit, Health, Retry, Learning, Incidents, Diagnosis
- `Settings`: Providers, Routing, Security, Secrets, Grants, Tokens, Runtime, Setup, Utilities

## Mobile

Primary navigation model:
- bottom or top segmented nav for the 10 first-level pages
- the right rail becomes a drawer or fullscreen sheet
- advanced subsections remain nested inside the active first-level page

## URL and context rule

- URLs should continue to reflect first-level ownership
- current object context should be injected into the right rail
- chat state should survive page transitions
