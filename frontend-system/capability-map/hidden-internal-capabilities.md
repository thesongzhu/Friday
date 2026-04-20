# Hidden Internal Capabilities

These internal mechanisms matter to system behavior but should not become standalone products or top-level pages.

Keep them visible only through diagnostics, evidence, or operator explanations:
- route idempotency mechanics
- middleware chains
- mappers and internal transport layers
- policy chains and guard internals
- storage plumbing
- queue persistence internals
- audit event serialization internals
- retry scheduling internals
- internal cache invalidation machinery
- provider adapter normalization layers

Allowed ways to expose them:
- `Settings`: diagnostics notes, runtime explanations, admin utilities
- `Observability`: evidence fields, trace metadata, incident diagnosis
- `Assistant`: approval rationale and recovery evidence

Disallowed:
- top-level nav items for internal plumbing
- user-facing labels that mirror backend implementation names
- actions that require understanding middleware or transport internals
