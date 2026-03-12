> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Friday Productization Plan (CX Design)

*Saved from CX session for CC reference. See full plan in CX transcript.*

## Implementation Order
1. Hub env resolution (`resolveFridayHubConfig`)
2. CLI config + run-loop wiring
3. Health route + API runtime registration
4. Export health route from API barrel
5. CORS handling in HTTP server
6. Request logging in HTTP server
7. Token secret startup warning
8. Unit tests (env, health, CORS, logging)
9. E2E health test
10. Example echo skill
11. Docker artifacts
12. README + getting-started.md
13. Full test suite
