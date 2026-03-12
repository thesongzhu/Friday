# Friday Changelog

## 2026-03-07

### Changed

- Normalized all public runtime route `operationId` values to canonical
  lowercase dot-segment names without changing HTTP paths.
- Published the route contract migration note and rename map in
  `docs/route-contract-migration.md`.

### API and Schema

- `FRIDAY_ROUTE_OPERATION_ID_RENAMES` in
  `src/api/http/friday-http-route-contract.ts` is now the machine-readable
  contract migration source for tooling and SDK consumers.

### Release Notes

- Any SDK, codegen, snapshot, or documentation pipeline that keys off
  `operationId` must migrate using `docs/route-contract-migration.md`.

## 2026-02-24

### Added

- Scheduled agent automations with cron support (`schedule.type=cron`, `schedule.cron`, `schedule.timezone`).
- Scheduler linkage between agent automations and unified job scheduler (create/update/disable/delete/startup re-sync).
- Automation schedule controls in UI:
  - Automation create/edit modal
  - Automation detail page
  - Save-as-automation flow from live run panel
  - Agent task controls schedule defaults
- Trace and audit visibility in live run panel (usage, cost, artifacts, test summary, event timeline).

### Changed

- Agent chat workspace upgraded to conversation-first layout with:
  - command buttons
  - task controls
  - integrated run monitor
- Local setup/auth bootstrap hardened for no-signin local usage.
- Setup flow channel handling and status persistence reliability improved.

### API and Schema

- Agent automations API now accepts schedule payload on create/update:
  - `POST /v1/agent/automations`
  - `PATCH /v1/agent/automations/:automationId`
- Database migration:
  - `v030-agent-automation-schedule-link`
  - adds `schedule_cron_expr`, `schedule_tz` to `friday_agent_automations`.

### Tests

- Added and updated unit tests for:
  - automation service scheduler bridge behavior
  - automation repository schedule persistence
  - agent route schedule validation
  - migration v030 schema checks
