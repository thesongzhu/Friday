# Phase 11 - Remediation Roadmap

## 1. Resolved In This Follow-Up

1. Marketplace mechanism retired from active source/UI/scripts/tests.
2. Passwordless local login retired; local/test/Docker paths use `localPassphrase`.
3. Docker clean passphrase smoke passes on a unique port.
4. `npm audit --omit=dev --audit-level=moderate` passes via patched `axios` override.
5. Architecture-boundary check passes after removing security -> rules layer import.
6. Full `npm test` passes after setup browser token injection.

## 2. P1 Serious Risks Still Open

1. Make `npm run validate:real-world:smoke` pass with zero failed/blocked scenarios.
2. Configure safe live channel sandbox env and run Discord/channel E2E after rotating the pasted token.
3. Run external deployment smoke once staging URL/domain/callback provider config exists.
4. Keep release/package/install smokes serialized or isolate their output dirs.

## 3. Missing Closed-Loop Tests

1. Browser smoke: passphrase auth -> home -> chat -> session reload from API.
2. Workflow UI smoke: create/publish/run/approval path.
3. Live channel smoke: signed inbound -> agent response -> outbound provider message ID.
4. External webhook smoke for workflow/channel routes with invalid/valid/replay cases.

## 4. Architecture Cleanup

1. Split hub bootstrap feature modules with explicit lifecycle ownership.
2. Add lifecycle drain controls for background jobs and observability.
3. Add capability truth labels for real/stub/disabled/sandbox-only channels and plugins.
4. Add CI names that separate mock proof, local closed-loop proof, and live proof.

## 5. Nice-to-Have Cleanup

1. Remove duplicate local untracked files from the working directory.
2. Remove or document the duplicate pnpm lockfile if npm remains canonical.
3. Add dependency/SBOM tooling.
4. Add unused export/dead route detection after live smoke lanes stabilize.
5. Expand operator docs for staging/prod env vars, live channels, secret rotation, deployment smoke, and incident response.
