# Friday vs OpenClaw Mixed Benchmark Round 1

Generated at: 2026-03-08T21:57:29.348Z
Repeats per system: 1
Friday base URL: http://127.0.0.1:4123

## Verdict Matrix

| Case | Family | Verdict | Notes |
| --- | --- | --- | --- |
| dialog-missing-info-backup | dialog | Gap | OpenClaw succeeded while Friday did not. |
| dialog-ambiguous-goal-noise | dialog | Gap | OpenClaw succeeded while Friday did not. |
| dialog-risk-boundary-reset | dialog | Friday stronger | Friday succeeded while OpenClaw did not. |
| dialog-expectation-boundary-autonomy | dialog | Gap | Neither system completed the case cleanly; manual review is required. |
| doing-summary-file | doing | Friday stronger | Friday succeeded while OpenClaw did not. |
| doing-group-json-report | doing | Equivalent | Both systems completed the case with similar automatic scores. |
| doing-rename-and-update-manifest | doing | Equivalent | Both systems completed the case with similar automatic scores. |
| doing-continue-with-blocker | doing | Equivalent | Both systems completed the case with similar automatic scores. |
| troubleshoot-low-risk-config-fix | troubleshoot | Equivalent | Both systems completed the case with similar automatic scores. |
| troubleshoot-high-risk-approval-boundary | troubleshoot | Gap | OpenClaw succeeded while Friday did not. |
| troubleshoot-fix-and-verify | troubleshoot | Equivalent | Both systems completed the case with similar automatic scores. |
| troubleshoot-repeated-failure-pause | troubleshoot | Boundary by design | Case is outside the intended direct parity boundary for this round. |

## Gap Ranking

- clarification_gap: 2
- boundary_explanation_gap: 1
- risk_boundary_gap: 1

## Key Totals

- Equivalent: 5
- Friday stronger: 2
- Weaker but acceptable: 0
- Gap: 4
- Boundary by design: 1
