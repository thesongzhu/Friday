> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# CX R3 Review of P1 Tests — Issues to Fix

## File 1: `test/e2e/plugins/friday-plugin-marketplace-lifecycle.test.ts` — FAIL

### Issue A: [high] Signature verification bypassed in happy path
- Line 125: `verifyEd25519: opts.verifyEd25519 ?? (() => true)` — happy path always passes crypto
- Line 93: Signature fixture is placeholder base64, not a real signature
- **Fix**: For the `download_and_install_marketplace_plugin` test, use a real Ed25519 key pair. Generate a key pair in the test setup, sign the payload, and pass the real `verifyEd25519` that actually verifies. This way if signature logic regresses, the test catches it.

### Issue B: [medium] Placeholder signature value
- Line 93 in `makeMarketplaceManifest`: `value: "dGVzdC1zaWduYXR1cmUtdmFsdWU="` is just base64 of "test-signature-value"
- **Fix**: Generate a real Ed25519 keypair, sign the manifest payload with it, set the real signature in the manifest, and verify with real crypto in the happy-path test.

## File 2: `test/e2e/workflows/friday-workflow-timeout-chain.test.ts` — FAIL

### Issue C: [high] Tautological assertions
- Line 209: `expect(swept).toBeGreaterThanOrEqual(0)` — always passes even if sweep is broken
- Line 242: `expect(result.leasesReaped).toBeGreaterThanOrEqual(0)` — same problem
- **Fix**: The `sweep_timed_out_nodes_marks_failed` test should either:
  1. Ensure nodes reach "running" status before advancing time (wait for status transition), then assert `swept >= 1`, OR
  2. If the race is unavoidable, restructure: directly insert a node_attempt row with status="running" and a past startedAt, then call sweep and assert `swept >= 1`.

### Issue D: [medium] No terminal state assertion after node sweep
- Line 183 region: After sweeping timed-out nodes, doesn't check that the node/run ended up in failed state
- **Fix**: After sweep, query the node attempt and run status. Assert node is "failed" with timeout error code.

### Issue E: [medium] Race-prone setTimeout(50)
- Lines 167, 195: Fixed `setTimeout(50)` hopes execution started
- **Fix**: Instead of fixed sleep, poll for the expected state (e.g., wait until at least one node_attempt exists in DB with status "running") with a short poll interval and a timeout. Or seed the DB state directly.

### Issue F: [high] `timeout_job_reaps_expired_leases` — tautological
- Line 242: `expect(result.leasesReaped).toBeGreaterThanOrEqual(0)` always passes
- **Fix**: Either ensure leases are actually created (verify via direct DB query that lease rows exist before reaping), then assert `leasesReaped >= 1`. Or if leases depend on timing, insert lease rows directly into DB, then run reap.

## File 3: `test/e2e/cli/friday-cli-start-runtime.test.ts` — FAIL

### Issue G: [high] Status assertion too weak
- Line 147: `expect(res.status).toBeGreaterThanOrEqual(200); expect(res.status).toBeLessThan(600)` — accepts 404, 500, anything
- **Fix**: Assert `expect(res.status).toBe(200)` if `/v1/health` exists, or find a known route that returns 200 and assert exactly that status code.

### Issue H: [high] Doesn't test CLI run loop
- Despite file name, tests `createFridayApiRuntime` + `createFridayHttpServer` directly, not `runFridayCliLoop`
- **Fix**: Add a test that imports `runFridayCliLoop` and exercises it. Since it calls `process.exit`, either:
  1. Mock `process.exit` to prevent it from killing the test runner
  2. Or rename the test file to accurately reflect what it tests (friday-api-http-boot.test.ts) and add a comment explaining why CLI loop isn't tested here. Then add a separate unit test for `runFridayCliLoop` with mocked process.exit.

### Issue I: [medium] state_dir test is misplaced
- Line 201: Tests SQLite file creation, not CLI behavior
- **Fix**: Move to a more appropriate test file (e.g., `test/unit/state/` or `test/integration/state/`), or keep here but add a real CLI-relevant test.

## File 4: `test/e2e/skills/friday-skill-lifecycle.test.ts` — WARN

### Issue J: [low] Temp dirs never cleaned
- Lines 198, 227: `makeTempDir()` creates dirs, only DB is closed in afterAll
- **Fix**: Track temp dirs and clean them up in afterAll/afterEach with `fs.rmSync(dir, { recursive: true, force: true })`.

### Issue K: [low] Discovery assertion is loose
- Line 261: `expect(skills.length).toBeGreaterThanOrEqual(1)` — could hide extra unexpected skills
- **Fix**: Assert exact count: `expect(skills).toHaveLength(1)`.

## File 5: `test/e2e/plugins/friday-plugin-local-lifecycle.test.ts` — WARN

### Issue L: [medium] readFileAsBuffer is stubbed to constant
- Line 113: `readFileAsBuffer: () => Buffer.from("test-file-content")` — never reads actual files
- **Fix**: The stub is acceptable for service-layer E2E (we're testing the service, not filesystem), but add a comment explaining this is intentional, and add one negative test: corrupt/empty manifest should fail install.

### Issue M: [low] Loader import fully stubbed
- Line 99: importModule always succeeds
- **Fix**: Add one test where importModule throws (simulates corrupt plugin JS), verify the load fails gracefully.

## File 6: `test/e2e/api/friday-api-skills-routes.test.ts` — WARN
## File 7: `test/e2e/api/friday-api-plugins-routes.test.ts` — WARN

### Issue N: [medium] Entire files skipped
- All tests are `it.skip` — zero executable coverage
- **Fix**: Leave as-is for now. These require wiring optional deps (converterService, skillGenerator, pluginMarketplace) into the test helper. Add a TODO comment with the specific deps needed. This is a known gap, not a regression risk.

---

## Priority Order for CC
1. **File 2** (workflow timeout) — most issues, all high/medium, tautological assertions are the biggest gap
2. **File 1** (marketplace) — real crypto verification is important for security tests
3. **File 3** (CLI start) — weak assertions + naming mismatch
4. **File 4** (skill lifecycle) — quick cleanup
5. **File 5** (plugin local) — add negative tests
6. **Files 6-7** (skipped routes) — leave as-is, just improve TODO comments
