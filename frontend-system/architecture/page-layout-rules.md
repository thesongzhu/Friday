# Page Layout Rules

Global layout:
- left rail: fixed-width primary navigation
- center workspace: page-specific content
- right rail: shared chat control panel, default expanded on desktop

Center workspace rules:
- start with the user question for that page, not raw data
- place urgent actions and blocked work above analytics
- keep list-detail or dashboard structure consistent within each page family
- use drawers for edits or approvals that should keep page context visible

Content ordering rules:
- summary first
- live or blocked state second
- deep detail after the user can act
- settings pages group by control domain, not by backend service names

Allowed layout patterns:
- dashboard
- list-detail
- builder
- observability control room
- settings sections
- approval/recovery stack

Disallowed layout patterns:
- more than three competing hero zones
- action buttons duplicated in page header and module body without reason
- a primary page made only of tables with no summary or decision support
- pages that require the user to open chat to understand the current state
