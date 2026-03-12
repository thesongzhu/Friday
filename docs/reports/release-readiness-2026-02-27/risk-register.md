> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Friday Risk Register

Generated: 2026-02-27 | Version: 0.3.1

## Open Risks

| ID | Risk | Severity | Owner | Status | Mitigation | Deadline |
|----|------|----------|-------|--------|------------|----------|
| R-001 | Cloud E2E lacks production target secrets | Medium | Release Manager | Accepted | Harness exists (`cloud-e2e.yml` dispatch + `ci.yml` `cloud-e2e-openai` job) but CI skips when `FRIDAY_CLOUD_E2E_BASE_URL` / provider keys are unconfigured; do not claim cloud production readiness until a live cloud target is wired | Post-GA |
| R-002 | `child_run_id` FK is application-enforced, not DB-level | Low | Core Team | Accepted | Deferred FK by design: row created with `childRunId: ""` (`friday-subagent-registry.ts:72`), back-filled after child run completes (`:137-142`). DB cannot enforce REFERENCES during the `''` window. Schema: `v037-fk-and-playbook-index.ts:26` (`DEFAULT ''`, no REFERENCES). `parent_run_id` has real REFERENCES (`:24`) | N/A |
| R-003 | 217 skipped tests (E2E env-gated, mix of LLM and non-LLM) | Low | Core Team | Accepted | 8200 passed / 217 skipped (8417 total). Skip sites include both LLM-gated suites (`FRIDAY_E2E_LIVE_*`, `E2E_OLLAMA`) and non-LLM CRUD suites gated behind `FRIDAY_E2E_CORE` (`friday-full-e2e.test.ts:7-9` "No real LLM calls"; `friday-real-scenarios-e2e.test.ts:101` NON-LLM scenarios). Weekly audit ratchet: max 21 skip-sites (`weekly-audit.yml:11`); adversarial suite enforces 0 skips | Ongoing |
| R-004 | Channel transport services not E2E-tested against live APIs | Low | Core Team | Accepted | 15 unit test files cover all 11 channel platforms under `test/unit/channels/`; 0 channel-specific files exist under `test/e2e/live/` (only 2 general journey suites: `friday-real-journeys.e2e.test.ts`, `friday-cloud-journeys.e2e.test.ts`). Real transport services wired in hub bootstrap but require external API credentials for live validation | Post-GA |
| R-005 | UI chunk size exceeds 500 kB | Low | UI Team | Accepted | Vite build warning only; does not affect functionality; code-splitting deferred | Post-GA |

## Closed Risks

| ID | Risk | Resolution | Closed Date |
|----|------|-----------|-------------|
| R-C01 | Dead route files (acceptance, execution, playbook, retry, rules) never registered | Deleted in b246a0e | 2026-02-27 |
| R-C02 | FK constraints not in schema (application-enforced only) | Added real REFERENCES for parent_run_id, workflow_id, draft_id in v037 | 2026-02-27 |
| R-C03 | Channel plugins default to stubs at runtime | Hub bootstrap now injects real service deps for 8 channels | 2026-02-27 |
| R-C04 | WebSocket returns 501 | RFC 6455 upgrade handler implemented | 2026-02-27 |
| R-C05 | Satellite revoke missing body validation | Added reason type validation | 2026-02-27 |
| R-C06 | No `closeout:final` script | Added to package.json | 2026-02-27 |
| R-C07 | No CODE_OF_CONDUCT.md | Created with Contributor Covenant | 2026-02-27 |
| R-C08 | No issue templates | Created bug_report.yml + feature_request.yml | 2026-02-27 |
| R-C09 | SECURITY.md lacks contact info | Added security email | 2026-02-27 |
| R-C10 | CI missing npm audit | Added dep-audit job to CI workflow | 2026-02-27 |

## Risk Acceptance Criteria

All open risks meet the following:
1. **Has owner** — assigned to a team or role
2. **Has deadline or status** — either a target date or explicit "Accepted" status
3. **Has mitigation strategy** — documented workaround or deferral rationale

No "ownerless, deadlineless, strategyless" risks remain.
