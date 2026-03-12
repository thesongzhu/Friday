> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# CX Core Engine Audit (2026-02-18)

**VERDICT: FAIL — 1 P0 + 6 P1 + 1 P2**

## P0
- **CX-001**: Zero `batchSize` can infinite-loop memory extraction — `batchSize=0` accepted, loop hangs forever

## P1
- **CX-002**: Approval resolution committed before resume, resume errors swallowed — run stays paused with approval resolved
- **CX-003**: Expired approvals don't unblock paused runs — runs stay blocked indefinitely after timeout
- **CX-004**: No approver authorization check — any caller can approve/reject any approval
- **CX-005**: `when: "success"` edges compile as unconditional — success branches execute after failed predecessors
- **CX-006**: Transform-step payload compiled to wrong config shape — transform steps become no-op
- **CX-007**: `addMessage` auto-creation drops subagent lineage — fork sessions not linked

## P2
- **CX-008**: `ai-inference` path bypasses run tracking/cancellation
