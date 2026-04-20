# Observability

Target users:
- operators, builders, and trust owners diagnosing failures or unhealthy runtime

Page tasks:
- inspect traces, audits, health, retries, incidents, and diagnosis
- understand what failed and what to do next
- verify whether self-improvement insights are actionable

Module order:
1. Health overview
2. Active incidents and blocked systems
3. Trace and audit entry points
4. Retry center
5. Learning, diagnosis, and auto-fix insights

Desktop layout:
- health and incidents above the fold
- trace, audit, retry, and diagnosis grouped below in clear zones

Mobile mapping:
- health
- incidents
- retry actions
- diagnosis and audit drill-in

Right-rail chat linkage:
- inject current incident, failing check, retry suggestions, evidence summary
- quick actions: explain incident, retry safely, open diagnosis

States:
- loading: health cards and incident placeholders
- empty: show healthy baseline and where to inspect history
- error: preserve last-known health with warning
- partial: health live, trace delayed
- success: operator can move from alert to evidence to action in one page

Forbidden:
- no wall of charts without recovery guidance
- no incident that requires another page just to see impact
- no diagnosis without evidence references
