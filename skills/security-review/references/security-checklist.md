# Security Review Checklist

## Authentication & Authorization

- [ ] Auth tokens validated on every protected route
- [ ] JWT secrets not hardcoded; rotation mechanism exists
- [ ] RBAC enforced at the API layer, not just UI
- [ ] Session expiry and refresh handled correctly

## Input Validation

- [ ] All user input sanitized before use
- [ ] SQL queries use parameterized statements (no string concatenation)
- [ ] File paths validated to prevent path traversal (../)
- [ ] URL inputs validated to prevent SSRF
- [ ] Command arguments escaped to prevent injection

## Data Protection

- [ ] Secrets stored in env vars or vault, never in source
- [ ] PII logged only at debug level (not in production logs)
- [ ] Sensitive fields excluded from API responses
- [ ] Encryption at rest for stored credentials
- [ ] TLS enforced for external connections

## Dependency & Supply Chain

- [ ] No known CVEs in direct dependencies
- [ ] Lock file (package-lock.json / yarn.lock) committed
- [ ] No wildcard or latest version ranges in production deps
- [ ] Third-party scripts loaded with integrity hashes where possible

## Infrastructure

- [ ] CORS policy restricts origins appropriately
- [ ] Rate limiting applied on public endpoints
- [ ] Error responses do not leak stack traces or internal paths
- [ ] CSP headers configured for frontend
- [ ] No debug/admin endpoints exposed in production
