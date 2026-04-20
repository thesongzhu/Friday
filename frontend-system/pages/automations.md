# Automations

Target users:
- users managing scheduled work and queue state

Page tasks:
- review schedules
- run work immediately
- inspect queue and recent executions
- pause, resume, or repair automation behavior

Module order:
1. Automation summary and quick run
2. Scheduled automations list
3. Queue and next-run timeline
4. Recent executions
5. Retry and evidence shortcuts

Desktop layout:
- overview cards on top
- schedule list left
- queue and execution detail right

Mobile mapping:
- overview
- schedule cards
- queue timeline
- execution detail sheet

Right-rail chat linkage:
- inject current automation, next run, failure reason, queue health
- quick actions: run now, pause, explain schedule

States:
- loading: schedule and queue skeletons
- empty: guide toward creating the first automation or running on demand
- error: preserve quick-run entry and cached schedules
- partial: schedules visible even if execution history is delayed
- success: schedules, queue, and execution health stay connected

Forbidden:
- no schedule table without immediate action controls
- no queue issue hidden behind observability-only navigation
