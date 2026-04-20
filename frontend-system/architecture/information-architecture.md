# Information Architecture

The console has 10 first-level surfaces:

1. `Home`
2. `Chat`
3. `Assistant`
4. `Workflows`
5. `Automations`
6. `Memory`
7. `Integrations`
8. `Observability`
9. `Fleet`
10. `Settings`

Shared model:
- the shell persists
- the right conversation rail persists
- context changes by page and current object

Capability grouping:
- Core work: Home, Chat, Assistant
- Orchestration: Workflows, Automations
- Knowledge: Memory
- Connectivity: Integrations
- Runtime health: Observability, Fleet
- Control plane: Settings

Rules:
- any user-meaningful capability must be reachable within two navigation levels
- every capability needs a primary and secondary surface
- page detail views stay inside the first-level page family, not in new top-level destinations
- Marketplace remains out of scope for this delivery
