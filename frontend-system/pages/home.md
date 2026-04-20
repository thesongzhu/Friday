# Home

Target users:
- new operators
- daily managers
- anyone returning to understand current state fast

Page tasks:
- see what is running now
- resolve pending approvals
- review recent outcomes
- launch a relevant next action

Module order:
1. Today summary and run status strip
2. Pending approvals
3. Live work and blocked work
4. Recent results
5. Pinned packs
6. Recommended next step cards

Desktop layout:
- hero summary across top
- live work and approvals above the fold
- recent results and pinned packs in two-column modules

Mobile mapping:
- summary
- approvals
- live work
- recent results
- pinned packs
- next steps

Right-rail chat linkage:
- inject `homeSnapshot`, `pendingApprovals`, `recommendedActions`, `pinnedPacks`
- quick actions: start task, resume run, triage approvals

States:
- loading: summary skeleton plus placeholder cards
- empty: explain how to start a first task
- error: keep quick start visible even if summaries fail
- partial: show stale summaries with warning banner
- success: live state, approvals, and next actions all visible

Forbidden:
- no analytics-first layout
- no hidden approvals below historical content
- no duplicated "start task" hero and empty state
