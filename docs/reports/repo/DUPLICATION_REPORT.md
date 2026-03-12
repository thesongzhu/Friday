> Status: Historical report. This file is retained for audit and evidence; if it conflicts with current behavior, prefer [`docs/current-source-of-truth.md`](../../current-source-of-truth.md).

# Duplication Report

Date: 2026-03-04 (America/Los_Angeles)

## Method

Evidence commands:

```bash
cd .
# exact duplicates by hash
git ls-files '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs' '*.json' '*.md' '*.sh' '*.yml' '*.yaml' \
  | while read -r f; do shasum -a 256 "$f"; done > /tmp/friday_hashes.txt
awk '{print $1}' /tmp/friday_hashes.txt | sort | uniq -d
# reference checks
rg -n "e2e-date-skill-|managed-skills/e2e" src test scripts docs
rg -n "reports/enablement/artifacts/.*1772673|reports/enablement/artifacts/.*1772675" *.md docs -g'*.md'
```

## Findings

## D1 - Exact Duplicate Fixture Families (Cleaned)

- Type: `完全重复`
- A vs B:
  - `managed-skills/e2e-date-skill-1772093627008/run.sh`
  - `managed-skills/e2e-date-skill-1772096470710/run.sh`
  - `managed-skills/e2e-date-skill-1772099169649/run.sh`
  - ... (11 directories total with same `run.sh`, same `skill.ui.json`)
- Who uses it:
  - Hub default skill directories include `managed-skills` (`src/hub/friday-hub-bootstrap.ts:256`), so all duplicates are loaded/scanned at startup.
- Risk:
  - startup scan overhead
  - fixture drift and accidental behavior variance over time
  - repository noise hiding real changes
- Handling:
  - Removed all `managed-skills/e2e-date-skill-*` generated history fixtures.
  - Added ignore rule: `managed-skills/e2e-date-skill-*/` in `.gitignore`.

## D2 - Exact Duplicate Historical Enablement Artifacts (Cleaned)

- Type: `完全重复`
- A vs B:
  - `reports/enablement/artifacts/browser-screenshot-1772673583221.png`
  - `reports/enablement/artifacts/browser-screenshot-1772673905296.png`
  - and matching duplicate waves for desktop/discord artifacts with same scenario role.
- Who uses it:
  - `E2E_RESULTS.md` references only the newest `177267509*` artifact wave.
- Risk:
  - artifact sprawl in Git history
  - larger repo size without extra validation value
- Handling:
  - Removed two old timestamp waves and kept the latest evidence set.
  - Added ignore rule: `reports/enablement/artifacts/*` with `!reports/enablement/artifacts/.gitkeep`.

## D3 - Logic Duplication: Session History Hydration (Kept, documented)

- Type: `逻辑重复`
- A vs B:
  - Channel flow history hydrate + trim in `src/hub/friday-hub-bootstrap.ts:2104`
  - API runtime history hydrate in `src/api/runtime/friday-api-runtime.ts:1258`
  - Session tool history forwarding in `src/agent/tools/friday-agent-sessions-tool.ts:248`
- Who uses it:
  - Webchat/Discord inbound path
  - `/v1/sessions/run` and `/v1/agent/runs` API path
  - session tool delegation path
- Risk:
  - future policy changes (history window, dedupe key behavior) can drift across paths
- Handling:
  - No runtime change in this sweep (to avoid behavior churn).
  - Marked in `CLOSURE_FIXES.md` as next extraction candidate into shared helper.

## D4 - Structural Similarity Across Channel Adapters (Kept by design)

- Type: `结构相似`
- A vs B:
  - `src/channels/discord/friday-discord-channel.ts`
  - `src/channels/slack/friday-slack-channel.ts`
  - `src/channels/telegram/friday-telegram-channel.ts`
  - etc.
- Who uses it:
  - instantiated by channel loader in `src/hub/friday-hub-bootstrap.ts:1021-1049`
- Risk:
  - copy-paste divergence for start/stop/reconnect semantics
- Handling:
  - Retained because adapters wrap heterogeneous third-party APIs.
  - Naming/contract consistency controls moved to tests and route-level assertions.

## Summary

- Removed duplicated generated fixture families and historical artifacts.
- Retained intentional structural duplication where provider-specific behavior differs.
- Logged one logic-duplication candidate for safe refactor in follow-up.
