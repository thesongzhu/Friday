# Friday vs OpenClaw Mixed Benchmark Round 1

Generated at: 2026-03-09T01:24:44.925Z
Repeats per system: 3
Friday base URL: http://127.0.0.1:4123

## Verdict Matrix

| Case | Family | Verdict | Notes |
| --- | --- | --- | --- |
| dialog-missing-info-backup | dialog | Friday stronger | Friday completed the case with a stronger automatic score. |
| dialog-ambiguous-goal-noise | dialog | Equivalent | Both systems completed the case with similar automatic scores. |
| dialog-risk-boundary-reset | dialog | Gap | OpenClaw succeeded while Friday did not. |
| dialog-expectation-boundary-autonomy | dialog | Friday stronger | Friday succeeded while OpenClaw did not. |
| dialog-vague-goal-guided-plan | dialog | Friday stronger | Friday succeeded while OpenClaw did not. |
| dialog-overwhelmed-user-guided-options | dialog | Gap | Neither system completed the case cleanly; manual review is required. |
| dialog-concise-direction-style | dialog | Gap | OpenClaw succeeded while Friday did not. |
| dialog-warm-guided-structured-planning | dialog | Friday stronger | Friday succeeded while OpenClaw did not. |
| dialog-direct-low-fluff-recommendations | dialog | Gap | OpenClaw succeeded while Friday did not. |

## Gap Ranking

- clarification_gap: 2
- risk_boundary_gap: 1
- boundary_explanation_gap: 1

## Key Totals

- Equivalent: 1
- Friday stronger: 4
- Weaker but acceptable: 0
- Gap: 4
- Boundary by design: 0
