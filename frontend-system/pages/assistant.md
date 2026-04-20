# Assistant

Target users:
- users handling approvals, issues, blocked work, and recovery

Page tasks:
- approve or deny blocked actions
- understand why work stopped
- follow recovery guidance
- inspect evidence receipts

Module order:
1. Priority inbox summary
2. Approval stack
3. Issues and recovery queue
4. Evidence receipts
5. Recent resolved items

Desktop layout:
- queue and approvals as the main column
- evidence and context as secondary detail

Mobile mapping:
- approvals first
- issue cards second
- evidence in bottom sheet

Right-rail chat linkage:
- inject current approval item, risk level, evidence summary
- quick actions: explain this, retry safely, draft a response

States:
- loading: inbox skeleton
- empty: reassure that nothing needs action and offer next best tasks
- error: show cached pending items if possible
- partial: approvals visible even when evidence fetch lags
- success: clear priority ordering with evidence access

Forbidden:
- no generic notification center styling
- no approvals without rationale
- no recovery path that requires reading raw logs first
