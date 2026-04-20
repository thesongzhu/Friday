# Build Order

1. Implement shared contracts from `src/types/`
2. Wire shell and right-rail container from `src/shell/`
3. Implement tokens and primitive components
4. Implement composite cards
5. Build first-level page blueprints in this order:
   `Home`, `Chat`, `Assistant`, `Workflows`, `Automations`, `Memory`, `Integrations`, `Observability`, `Fleet`, `Settings`
6. Add mobile mappings and drawer behavior
7. Connect preview fixtures
8. Replace preview fixtures with real BFF-backed data

Dependency rules:
- do not build page-specific components before primitives and contracts settle
- do not change page ownership decisions during implementation
