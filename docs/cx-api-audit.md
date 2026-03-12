> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# CX API Audit (2026-02-18)

## Batch 1: Auth + Provider + Security + Health
**VERDICT: FAIL (1 P0 + 3 P1 + 3 P2)**

### P0
- **API-ROUTE-001**: Static GET endpoints shadowed by `:providerId` — `/v1/providers/usage` captured by `/v1/providers/:providerId`

### P1
- **API-VALID-001**: ~~`auth.refresh` body unvalidated~~ ✅ Fixed R1
- **API-VALID-002**: ~~`security.revoke.token` returns false success~~ ✅ Fixed R1
- **API-RATE-001**: ~~Provider/security endpoints lack rate limiting~~ ✅ Fixed R3

### P2
- **API-HTTP-001**: Server always returns 200 (no 201/204 support) — **skipped** (too invasive)
- **API-ERR-001**: ~~Structured `details` dropped from domain errors~~ ✅ Fixed R3
- **API-HTTP-002**: ~~Malformed URL-encoded path params → 500~~ ✅ Fixed R2

---

## Batch 2: Workflow + Session + Realtime
**VERDICT: FAIL (0 P0 + 4 P1 + 3 P2)**

### P1
- **RT-ERR-001**: ~~Realtime 4xx branches thrown as plain Error~~ ✅ Fixed R1
- **RT-VAL-002**: ~~Realtime bodies cast without validation~~ ✅ Fixed R1
- **WF-VAL-003**: ~~Workflow mutation handlers trust unvalidated bodies~~ ✅ Fixed R1
- **GEN-RATE-004**: ~~Workflow generator endpoints not rate-limited~~ ✅ Fixed R3

### P2
- **PAG-005**: ~~Pagination handling inconsistent, missing max caps~~ ✅ Fixed R3
- **SCOPE-006**: ~~Realtime scopes narrower than topic model~~ ✅ Fixed R3
- **SES-VAL-007**: ~~`memory/remember` doesn't validate `mode` enum~~ ✅ Fixed R3

---

## Batch 3: Memory + Plugin + Skill + Fleet
**VERDICT: FAIL (0 P0 + 5 P1 + 2 P2)**

### P1
- **MEM-001**: ~~`olderThan` prune filter not date-validated~~ ✅ Fixed R3
- **FLT-001**: ~~Fleet list query blindly type-cast~~ ✅ Fixed R3
- **FLT-002**: ~~Satellite detail returns `200` with `null`~~ ✅ Fixed R3
- **SGEN-001**: ~~Skill generator routes not rate-limited~~ ✅ Fixed R3
- **SCONV-001**: ~~Skill conversion/import/pack routes not rate-limited~~ ✅ Fixed R3

### P2
- **SGEN-002**: ~~Skill UI file read failures bubble as 500~~ ✅ Fixed R3
- **SGEN-003**: ~~`/generate` accepts non-object JSON bodies~~ ✅ Fixed R3

---

## TOTAL: 1 P0 + 12 P1 + 8 P2
- P0: 1/1 Fixed (route shadowing)
- P1: 12/12 Fixed — all resolved
  - R1: input validation (auth.refresh, security.revoke, realtime bodies, workflow mutation)
  - R2: URL encoding, route shadowing
  - R3: rate limiting (provider, workflow-gen, skill-gen, skill-converter), memory olderThan validation, fleet limit validation + 404
- P2: 7/8 Fixed (API-HTTP-001 skipped — too invasive)
  - R2: URL encoding
  - R3: SGEN-002 (file read try/catch), SGEN-003 (non-object body rejection), PAG-005 (limit caps), SCOPE-006 (realtime scopes), SES-VAL-007 (mode enum), API-ERR-001 (error details)
