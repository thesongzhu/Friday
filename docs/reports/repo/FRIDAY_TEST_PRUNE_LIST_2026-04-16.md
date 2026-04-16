# Friday Test Prune / Reclassify List (2026-04-16)

## Keep But Reclassify As Non-Proof

1. `npm test`
   - Keep for regression speed
   - Do not treat as ship proof

2. `test:e2e:browser-mock-hub`
   - Keep for UI regression
   - Explicitly mark as `browser-mock-hub`

3. Mock `web_search` suites under `test/e2e/mock/`
   - Keep only as contract tests
   - Do not use them to claim search freshness or live search correctness

4. Any suite depending on `createMockHubEnv`
   - Keep only for fast isolated coverage
   - Never mix into release truth summaries

## Current Repo-Only Mock Signals Already Confirmed

- `test/e2e/ui/_helpers/browser-env.ts: createMockHubEnv`
- `test/e2e/ui/_helpers/browser-env.ts: localStorage.setItem`

## Real-Proof Lanes To Prefer

1. Live runtime HTTP/MCP proof against a running Friday instance
2. Real provider proof with authenticated model/tool execution
3. Real external roundtrip proof for channels/protocols
4. Env-on proof for gated mechanisms such as heartbeat
