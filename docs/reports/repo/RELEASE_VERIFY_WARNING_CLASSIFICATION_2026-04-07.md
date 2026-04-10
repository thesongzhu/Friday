# Friday Release Verify Warning Classification

Date: 2026-04-07

Workspace: `/path/to/friday-main-05bba7a`

Verification run:

- `npm run release:verify`
- Result: passed

## Summary

The release gate is green, but the stderr stream during `release:verify` is not empty.

Those warnings are not one bucket. They fall into four different classes:

1. expected test-environment security warnings
2. expected degraded-path warnings
3. expected negative-path / malformed-input warnings
4. low-signal runtime noise that should be cleaned up later

This classification exists to prevent future reviews from treating every warning as a product regression.

## Class 1: Expected Test-Environment Security Warnings

These warnings come from tests that intentionally boot Friday with insecure fixture settings.

Before this batch, the release stream frequently included warnings such as:

- `[friday][SECURITY] Token secret is shorter than recommended minimum (32 chars) — session tokens may be vulnerable to brute-force`
- `[friday][SECURITY] Auth rate limiter not configured — brute-force protection disabled`
- `[friday][SECURITY] Created default admin user (admin@friday.dev) with NO password — set a passphrase via the setup wizard for production use`

Where they come from:

- auth fixture tests that intentionally use short token secrets or omit a limiter
- setup-wizard and bootstrap tests that intentionally exercise the unsecured first-run path

Classification:

- not a product failure
- not a release blocker
- expected fixture noise when the harness intentionally boots Friday in an insecure mode

What changed in this batch:

- explicit test-warning suppression was added for:
  - missing SSRF guard warning in mock/browser environments
  - passwordless admin warning in tests that explicitly set `FRIDAY_SUPPRESS_TEST_ENV_SECURITY_WARNINGS=1`
  - auth fixture warnings for short token secrets and missing rate limiter when the default console warning sink is used

Observed result in the final 2026-04-07 release gate:

- the short token secret warning did not appear
- the missing rate limiter warning did not appear
- the passwordless default admin startup warning did not appear

What remains open:

- tests that intentionally pass a custom warning sink or assert warning behavior can still surface these warnings by design
- security rejection-path evidence, such as rejecting a passwordless login from a non-localhost IP, should remain visible and is not fixture noise

## Class 2: Expected Degraded-Path Warnings

These warnings are emitted because the tests intentionally exercise graceful degradation and unavailable-dependency paths.

Examples observed or confirmed in the current code path:

- `[friday][agent-runtime] LLM call failed, degrading gracefully: ...`
- `system companion unavailable; continuing in degraded mode`
- install-smoke health payload reporting `desktop_session_unavailable`
- `[friday][memory-service] embedding failed: No model routing configured...`

Classification:

- expected in resilience tests and degraded startup paths
- not a release blocker when the affected test is explicitly asserting degradation behavior

Why they stay visible:

- these warnings are often the evidence that the fallback path did execute
- hiding them globally would make degraded-mode regressions harder to detect

## Class 3: Expected Negative-Path / Malformed-Input Warnings

These warnings come from tests that intentionally trigger bad input, missing files, or invalid URLs.

Examples observed in the release run or the same validation batch:

- `Invalid URL` warnings in mock/plugin/public-run-url paths
- ENOENT-style negative-path warnings in file or memory sync tests
- invalid cursor / malformed request-path warnings in adversarial or boundary tests
- `[friday][http-server] operation failed: URI malformed`
- `[friday][safe-json] JSON parse failed: ...`
- `[friday][cli] entrypoint module URL is invalid: Invalid URL`

Classification:

- expected for negative-path coverage
- not a release blocker
- should not be grouped with runtime crashes

What changed in this batch:

- the noisy `web_fetch` URL rewrite helper warning was removed so malformed URLs no longer generate extra low-value stderr in addition to the real failing path

## Class 4: Still-Open Low-Signal Runtime Noise

These are warnings that are not currently blocking the release gate, but still deserve later cleanup because they are noisy or overly generic.

Examples:

- `[friday][agent-runtime] extract-image-paths: ...`
- `[friday][agent-runtime] preference-enrichment: ...`
- `[friday][SECURITY] WhatsApp appSecret not configured — webhook signature validation will be skipped`
- `[friday][workspace-context] parse-memory-export: ...`

Classification:

- non-blocking
- worth tightening later so logs better separate expected fallback behavior from genuine investigation targets

Recommended follow-up:

- either gate these behind more specific debug/test conditions
- or upgrade them into more structured warning categories with clearer intent
- specifically, the WhatsApp appSecret fixture warnings should be classified the same way auth/bootstrap fixture warnings now are, instead of continuing to look like production-grade security regressions in the release stream

## Current Policy Recommendation

Keep the following split:

- visible by default:
  - real security warnings in production-like startup
  - graceful degradation warnings when tests assert fallback behavior
  - runtime warnings that may indicate real operator interest
- suppress only in explicit test harness mode:
  - startup security warnings that are known fixture noise
  - SSRF-guard absence warnings in mock/browser-only environments

Do not:

- globally silence all warnings in tests
- classify all stderr as a release failure
- mix negative-path evidence with true product regressions

## Release Verdict

As of 2026-04-07:

- `release:verify` passed
- the fixture-only auth/bootstrap security warnings are now largely suppressed in explicit test harness mode
- the observed warning stream is now mostly degraded-path and negative-path test noise, plus a smaller set of low-signal runtime warnings
- the next warning-cleanup candidate is the repeated WhatsApp fixture security warning, not the degraded-path evidence
- no warning class observed in this run currently justifies reverting the retained productization changes
