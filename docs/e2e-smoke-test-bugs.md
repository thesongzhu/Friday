# E2E Smoke Test Bug Report (2026-02-18)

## 22 pass, 8 fail

### CRITICAL

**BUG-001: No admin user seed on fresh database**
- Fresh install → POST /v1/auth/login {"local":true} → USER_NOT_FOUND
- Migration v001 creates users table but never inserts default admin
- Fix needed: seed admin user on first startup

**BUG-002: POST /v1/workflows returns 500**
- Body: {"slug":"test","name":"Test","graph":{"nodes":[],"edges":[]}}
- createVersion passes raw graph to validator expecting compiled format (schemaVersion, checksum, graph.graph.nodes)
- Also: createWorkflow + createVersion not in same transaction → orphan workflow rows

### MEDIUM

**BUG-003: Plugin/marketplace routes never registered**
- GET /v1/plugins → 404
- createFridayApiRuntime requires pluginService + pluginManifestLoader deps, hub bootstrap never passes them

### LOW

**BUG-004: DELETE /v1/workflows/:id succeeds for non-existent IDs**
- Returns 200 {"archived":true} instead of 404

**BUG-005: HEAD requests return 404**
- HTTP server doesn't map HEAD to GET handlers

### DX Issues

**DX-001: Provider create/get field shape inconsistent**
- POST expects flat fields, GET returns nested under config

**DX-002: Session key requires undocumented 3-segment format**
- "test-session" fails with SESSION_INVALID_KEY, needs "channel:accountId:chatId"

**DX-003: Memory store requires namespace field (undocumented)**

**DX-004: Usage endpoint requires from/to query params (no defaults)**
