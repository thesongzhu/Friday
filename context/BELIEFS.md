# Engineering Principles

1. **Task-first surfaces** — /home, /chat, /packs, /assistant each have one job
2. **Skills-first capability acquisition** — public capabilities go through skills lifecycle
3. **Truthful release status** — no claim without working code
4. **Deny-precedence in all policy evaluation** — denylist always wins
5. **No silent security drops** — all authorization decisions must produce audit events
6. **Server-shaped UI models** — frontend consumes server DTOs, never assembles multi-source state
7. **Additive evolution** — existing public APIs keep their signatures
8. **Mechanical enforcement over manual review** — linters, CI gates, pre-commit hooks
9. **YAGNI** — solve the present problem with minimum necessary complexity
10. **Repository as authoritative source** — design decisions live in docs/, not in chat threads
