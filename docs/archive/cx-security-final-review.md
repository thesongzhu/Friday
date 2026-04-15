> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# CX Security Final Review (2026-02-18)

## VERDICT: INCOMPLETE — 4 remaining issues

### ✅ FIXED (6/10)
- **SEC-002**: Token secret auto-generation ✅
- **SEC-003**: Mandatory middleware ✅
- **SEC-004**: scrypt password hashing ✅
- **SEC-007**: CORS default [] ✅
- **SEC-008**: 5xx error masking ✅
- **SEC-010**: Limit caps ✅

### ⚠️ INCOMPLETE (4/10)

**SEC-001: Login bypass — 2 remaining paths**
1. Local login succeeds without passphrase when `password_hash` is null (line 171)
2. `{}` login still enabled in non-production when secret is not explicit (lines 199, 219)
→ Fix: Reject login when password_hash is null; tighten dev-mode fallback

**SEC-005: Token revocation — not persistent**
1. Access JTIs not stored on issuance (line 143)
2. Revocation is in-memory only (lost on restart)
3. DB revoke only updates pre-existing rows
→ Fix: Store JTIs on issue, or accept short TTL (15min) as sufficient mitigation

**SEC-006: PKCE — exchange still accepts caller verifier**
1. Exchange accepts caller-provided `codeVerifier` even if state unknown (line 193)
2. Pending states have no TTL cleanup (line 148)
→ Fix: Reject exchange when state not found in pending map; add TTL cleanup

**SEC-009: Security headers — missing HSTS**
1. `Strict-Transport-Security` not included
→ Fix: Add HSTS header (only when TLS detected or configurable)
