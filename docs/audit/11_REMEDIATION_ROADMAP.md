# Phase 11 - Remediation Roadmap

## 1. Resolved In This Follow-Up

1. Marketplace mechanism retired from active source/UI/scripts/tests.
2. Passwordless local login retired; local/test/Docker paths use `localPassphrase`.
3. Docker clean passphrase smoke passes on a unique port.
4. `npm audit --omit=dev --audit-level=moderate` passes via patched `axios` override.
5. Architecture-boundary check passes after removing security -> rules layer import.
6. Full `npm test` passes after setup browser token injection.
7. Fresh and current-config real-world smoke now pass 27/27 with `localPassphrase` auth, DeepSeek primary, and OpenAI fallback.
8. Multi-turn memory, read-only file tool roundtrip, and current-config v056 checksum startup blockers are fixed.
9. Unrelated local duplicate/untracked files were quarantined outside the repo; repo-root migration check now passes.
10. Main branch protection now requires strict status checks and resolved conversations, and blocks force-push/delete. As of the 2026-05-19 Phase 18B readback, required approving reviews are `0` and `enforce_admins.enabled=false`; single-maintainer merges still require the repo-tracked PR-side gate record and same-SHA CI/RGG proof.
11. `staging-e2e` GitHub Environment exists with Cloud Live E2E secrets seeded.
12. A Fly staging deployment profile now exists in `fly.toml`.

## 2. P1 Serious Risks Still Open

1. Configure safe live channel sandbox env and run Discord/channel E2E after rotating the pasted token.
2. Create the Fly staging app, set deployment secrets, deploy, and run external deployment smoke once the staging URL/domain/callback provider config exists.
3. Add the Cloud Live E2E actor/ref guard after GitHub auth has `workflow` scope.
4. Keep release/package/install smokes serialized or isolate their output dirs.

## 3. Missing Closed-Loop Tests

1. Browser smoke: passphrase auth -> home -> chat -> session reload from API.
2. Workflow UI smoke: create/publish/run/approval path.
3. Live channel smoke: signed inbound -> agent response -> outbound provider message ID.
4. External webhook smoke for workflow/channel routes with invalid/valid/replay cases against the deployed staging URL.
5. Regression check for the validation/report helper shape so temporary orchestration cannot confuse artifact `result` with `status`.

## 4. Architecture Cleanup

1. Split hub bootstrap feature modules with explicit lifecycle ownership.
2. Add lifecycle drain controls for background jobs and observability.
3. Add capability truth labels for real/stub/disabled/sandbox-only channels and plugins.
4. Add CI names that separate mock proof, local closed-loop proof, and live proof.

## 5. Nice-to-Have Cleanup

1. Remove or document the duplicate pnpm lockfile if npm remains canonical.
2. Add dependency/SBOM tooling.
3. Add unused export/dead route detection after live smoke lanes stabilize.
4. Expand operator docs for live channels, secret rotation, deployment smoke, and incident response.
