# Memory

Target users:
- users inspecting, correcting, or pruning what Friday remembers

Page tasks:
- search memory
- inspect learned facts and session-derived memory
- delete, retain, or correct records
- understand memory impact on current behavior

Module order:
1. Search and filters
2. Learned facts summary
3. Memory results list
4. Record detail and provenance
5. Cleanup and retention actions

Desktop layout:
- search header
- result list and detail panel
- retention controls in contextual sidebar or footer region

Mobile mapping:
- search first
- result list second
- record detail in sheet

Right-rail chat linkage:
- inject selected memory record, provenance, affected sessions
- quick actions: forget this, explain usage, keep but de-prioritize

States:
- loading: search shell skeleton
- empty: teach what memory is and how it is learned
- error: keep search and retention controls available
- partial: results visible even if provenance is delayed
- success: record detail explains why it exists and what to do next

Forbidden:
- no raw database vocabulary
- no destructive cleanup hidden behind unclear wording
- no memory edits that do not surface in chat context
