# Branch Reconciliation 2026-04-04

Date: 2026-04-04

## Summary

This report records the `main` branch reconciliation and final branch cleanup performed across:

- `/path/to/friday`
- `/path/to/friday-publish-real-world`

Confirmed facts:

- `main` baseline before cleanup was `e51de41`.
- Final `main` after the reconciliation record landed was `3f4321f`.
- `main` was already passing:
  - `npm run lint`
  - `npm run build`
  - `npm run validate:real-world:catalog`
- The most recent full real-world smoke before this cleanup was `28 passed / 0 failed`.
- The dirty worktree at `/path/to/friday` was protected before any cleanup by exporting status, tracked diff, and untracked inventory into `docs/reports/repo/branch-reconciliation-2026-04-04/`.

Authoritative raw evidence for this reconciliation lives in:

- `docs/reports/repo/branch-reconciliation-2026-04-04/ref-heads.txt`
- `docs/reports/repo/branch-reconciliation-2026-04-04/branch-ahead-behind.json`
- `docs/reports/repo/branch-reconciliation-2026-04-04/local-branches-vv.txt`
- `docs/reports/repo/branch-reconciliation-2026-04-04/post-cleanup-local-branches-vv.txt`
- `docs/reports/repo/branch-reconciliation-2026-04-04/worktrees.txt`
- `docs/reports/repo/branch-reconciliation-2026-04-04/post-cleanup-worktrees.txt`
- `docs/reports/repo/branch-reconciliation-2026-04-04/stash-list.txt`

## Cleanup Completed

### Worktrees Removed

- Removed `/Users/dev/.claude-worktrees/Friday/laughing-hugle`
- Removed `/path/to/friday-nightly-fix`
- Removed `/Users/dev/.claude-worktrees/Friday/serene-chaum`
- Pruned the stale `claude/cranky-colden` worktree registration

### Local Branches Deleted

- `claude/cranky-colden` at `fddce67`
- `claude/review-friday-codebase-JQ9x5` at `b4f0fd8`
- `codex/fix-2026-03-30-nightly` at `94169f8`
- `codex/fix-file-tool-workspace-path` at `89ad6dc`
- `codex/fix-real-world-smoke-followups` at `faac6c9`
- `codex/efficiency-audit-fixes` at `3fc9983`
- `codex/gha-node24-upgrade` at `9f2ef5e`
- `codex/provider-backend-auth-matrix` at `2eef6f1`
- `codex/routing-decision-trace-maturation` at `05bbcbe`
- `codex/tier1-live-env-contracts` at `65c82de`
- `laughing-hugle` at `440807d`
- `codex/full-audit-2026-03-29` at `d8c18f9`
- `codex/friday-real-validation-2026-03-31` at `8030a92`
- `codex/protect-uncommitted-before-rebase-20260327` at `aafd891`
- `codex/self-evolution-snapshot-2026-04-01` at `34661d2`
- `serene-chaum` at `3f7e10e`
- `codex/branch-reconciliation-2026-04-04` at `01b9e8f`

### Remote Branches Deleted Or Pruned

- Deleted:
  - `claude/review-friday-codebase-JQ9x5`
  - `claude/review-friday-codebase-JQ9x5-v2`
  - `claude/test-session-xXyVO`
  - `claude/fix-lint-ci-JQ9x5`
  - `codex/branch-reconciliation-2026-04-04`
  - `codex/efficiency-audit-fixes`
  - `codex/fix-2026-03-30-nightly`
  - `codex/friday-real-validation-2026-03-31`
  - `codex/full-audit-2026-03-29`
  - `codex/gha-node24-upgrade`
  - `codex/provider-backend-auth-matrix`
  - `codex/routing-decision-trace-maturation`
  - `codex/tier1-live-env-contracts`
  - `laughing-hugle`
- Recreated and retained:
  - `claude/investigate-twitter-thread-4PNHG`
- Already absent on remote and pruned from local tracking during `git fetch --all --prune`:
  - `codex/fix-file-tool-workspace-path`
  - `codex/fix-real-world-smoke-followups`
  - `codex/fix-uix-user-profile-persistence`
  - `codex/real-world-validation-framework`

## Decision Ledger

### Deleted As Merged, Patch-Equivalent, Or Superseded

| Ref | Head SHA | `main..branch` | PR status | Disposition |
| --- | --- | ---: | --- | --- |
| `codex/real-world-validation-framework` | `3699d457e525` | `1` | PR #78 merged on 2026-04-04 | Patch-equivalent already on `main`; remote ref pruned |
| `codex/fix-uix-user-profile-persistence` | `3c94f260e162` | `1` | PR #79 merged on 2026-04-04 | Patch-equivalent already on `main`; remote ref pruned |
| `claude/fix-lint-ci-JQ9x5` | `cda052de72b1` | `2` | PR #57 merged on 2026-03-31 | Current `main` passes `lint` and `build`; branch treated as superseded and deleted |
| `codex/fix-real-world-smoke-followups` | `faac6c9b5591` | `0` | PR #80 merged on 2026-04-04 | Already merged; local deleted and remote absent |
| `codex/fix-file-tool-workspace-path` | `89ad6dc90311` | `0` | PR #81 merged on 2026-04-04 | Already merged; local deleted and remote absent |
| `codex/fix-2026-03-30-nightly` | `94169f87adbd` | `0` | No open PR | No unique patch content remained; worktree and refs deleted |
| `claude/review-friday-codebase-JQ9x5` | `b4f0fd839d24` | `0` | No open PR | No unique patch content remained; local and remote deleted |
| `claude/review-friday-codebase-JQ9x5-v2` | `b4f0fd839d24` | `0` | No open PR | No unique patch content remained; remote deleted |

### Archived Or Deleted After Explicit Review

| Ref | Head SHA | `main..branch` | `branch..main` | PR status | `git cherry` summary | Disposition |
| --- | --- | ---: | ---: | --- | --- | --- |
| `codex/efficiency-audit-fixes` | `3fc9983a1ff6` | `39` | `8` | PR #77 closed on 2026-04-04 | 39 unique patches remain in `branch-ahead-behind.json` | Branch deleted after its SHAs and split plan were preserved in this report |
| `origin/codex/full-audit-2026-03-29` | `d8c18f95e90d` | `1` | `77` | No PR found | `+ d8c18f9 fix: harden audit gates and release readiness workflows` | Archive ref deleted after SHA was preserved here |
| `origin/codex/friday-real-validation-2026-03-31` | `8030a92bd3dc` | `1` | `77` | No PR found | `+ 8030a92 Add Friday real validation evidence bundle for 2026-03-31` | Archive ref deleted after SHA was preserved here |
| `serene-chaum` | `3f7e10eaca61` | `1` | `114` | Remote gone | `+ 3f7e10e fix: comprehensive audit remediation — P0/P1/P2 fixes + code quality sweep` | Local branch and worktree deleted after diff snapshot was archived |

### Final Retained Branches

| Ref | Head SHA | `main..branch` | PR status | Disposition |
| --- | --- | ---: | --- | --- |
| `main` | `3f4321f4361e` | `0` | current default branch | Retained |
| `claude/investigate-twitter-thread-4PNHG` | `876368fe5472` | `0` | PR #82 merged on 2026-04-04 | Restored and retained by user request |

### Local-Only WIP Branches Removed After Archiving

| Ref | Head SHA | `main..branch` | `git cherry` summary | Disposition |
| --- | --- | ---: | --- | --- |
| `codex/protect-uncommitted-before-rebase-20260327` | `aafd891ac046` | `2` | one patch-equivalent commit plus one WIP commit | Archived by SHA in this report; local branch deleted |
| `codex/self-evolution-snapshot-2026-04-01` | `34661d247813` | `1` | one WIP snapshot commit | Archived by SHA in this report; local branch deleted |

## Dirty Worktree Protection

Before cleanup, the dirty worktree at `/path/to/friday` was snapshotted into:

- `docs/reports/repo/branch-reconciliation-2026-04-04/dirty-worktree-status.txt`
- `docs/reports/repo/branch-reconciliation-2026-04-04/dirty-worktree-diff.patch`
- `docs/reports/repo/branch-reconciliation-2026-04-04/dirty-worktree-diff-stat.txt`
- `docs/reports/repo/branch-reconciliation-2026-04-04/dirty-worktree-untracked.txt`
- `docs/reports/repo/branch-reconciliation-2026-04-04/stash-list.txt`

Confirmed facts from that snapshot:

- The dirty worktree sat on `codex/efficiency-audit-fixes`.
- Tracked changes were limited to 6 files with `16` insertions and `11` deletions:
  - `managed-skills/hello-converter-e2e/conversion.report.json`
  - `managed-skills/output-current-date-time/run.sh`
  - `managed-skills/output-current-date-time/skill.manifest.json`
  - `managed-skills/output-current-date-time/skill.ui.json`
  - `managed-skills/real-e2e-import-test/conversion.report.json`
  - `package.json`
- Untracked `docs/reports/ops/real-world-validation/**` entries are generated validation outputs, not missing product code on `main`.
- Untracked `scripts/validation/run-real-world-validation.mjs` and `validation/real-world/**` are already tracked on `main`; they appear untracked in the old dirty branch only because that branch predates PR #78.
- Untracked `managed-skills/output-current-datetime/**` does not exist on current `main`; it remains local-only material inside the dirty worktree snapshot.
- The dirty worktree was preserved again as `stash@{0}: On codex/efficiency-audit-fixes: pre-branch-cleanup-2026-04-04` before switching `/path/to/friday` back to `main`.

No tracked work from the dirty branch was discarded without a snapshot or stash handle.

## PR #77 Split Rule

`PR #77` was closed on 2026-04-04 as part of the branch cleanup. Its branch was then deleted.

The unique SHAs and extraction directions remain preserved here so any still-useful fix can be re-landed as a new minimal PR.

Allowed follow-up directions:

1. `runtime/contracts`
   - `575ceb9`
   - `a583d65`
   - `0222028`
   - `d57127b`
2. `polling/waste`
   - `2ecfd1e`
   - `b65057c`
   - `42be6a7`
   - `181b3e1`
   - `c07f2e6`
   - `13197c7`
   - `40859ac`
   - `31e7c2e`
3. `learning/self-healing queries`
   - `808b4c8` through `f0f4c6c`

Explicit exclusions:

- `3fc9983`
- `87e1290`
- `14ab9ae` unless `release:verify` is reproduced as failing on current `main`
- Any diff that deletes the already-merged `validation/real-world` framework or current source-of-truth docs

## Final State

After cleanup, the local branch set was reduced to:

- `main`
- `claude/investigate-twitter-thread-4PNHG`

After cleanup, the remaining remote branches were reduced to:

- `origin/main`
- `origin/claude/investigate-twitter-thread-4PNHG`

This leaves no unexplained local or remote branches outside the two explicitly retained refs.
