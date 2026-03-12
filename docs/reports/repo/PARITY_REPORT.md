> Status: Historical report. This file is retained for audit and evidence; if it conflicts with current behavior, prefer [`docs/current-source-of-truth.md`](../../current-source-of-truth.md).

# Git Parity Report

Date: 2026-03-04 (America/Los_Angeles)

## Scope

Checked local repository parity against GitHub remote default branch, plus local workspace cleanliness.

## Evidence Commands

```bash
cd .
git fetch --all --prune --tags
git symbolic-ref refs/remotes/origin/HEAD
git rev-parse HEAD
git rev-parse origin/main
git rev-list --left-right --count HEAD...origin/main
git status --porcelain=v1
git status -sb
git stash list
git for-each-ref --format='%(refname:short)' refs/heads | sort
git for-each-ref --format='%(refname:short)' refs/remotes/origin | sed 's#^origin/##' | sort
```

## Results

1. Default branch auto-detected from `origin/HEAD`:
   - `refs/remotes/origin/main`
2. Local HEAD SHA:
   - `fd99a8f8850d20b1063bfc07df28f0bc4c9948b0`
3. Remote default SHA (`origin/main`):
   - `fd99a8f8850d20b1063bfc07df28f0bc4c9948b0`
4. Ahead/behind:
   - `0 0` (`git rev-list --left-right --count HEAD...origin/main`)
5. Working tree:
   - Clean at scan time (`git status --porcelain` empty)
6. Untracked files:
   - None at scan time
7. Stash entries:
   - 5 stashes present:
     - `stash@{0}: On main: codex-temp-branch-audit-and-reports-20260304`
     - `stash@{1}: On main: pre-converge-20260302-122209`
     - `stash@{2}: WIP on main: 1f6b7e5 ...`
     - `stash@{3}: On main: sync-main-20260301-234840`
     - `stash@{4}: WIP on codex/cx80-cx81-phase1-heartbeat-undocumented-api: 34bee41 ...`
8. Branch parity:
   - Local-only branches: none
   - Remote-only branches: `HEAD` (symbolic alias, not a real branch)

## Conclusion

Local and remote default branch were fully aligned at scan time (`main` parity OK), with no pending working-tree changes; only historical stashes exist.
