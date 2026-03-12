# Friday Dialog Persona Next-Round Gap Plan

## Goal

Close the four remaining dialog benchmark gaps after the communication persona
rerun, without weakening Friday's supervised safety model.

## Gap Ranking

### Priority 1 — `risk_boundary_gap`

Affected case:

- `dialog-risk-boundary-reset`

Why this is first:

- It is the only remaining dialog gap that is primarily a safety and policy
  boundary problem rather than a style issue.
- If Friday continues to speak too optimistically in risky reset scenarios, it
  will keep feeling unreliable or reckless.

Required fix direction:

- tighten risky-reset language and action classification in assistant guidance
- require explicit stop/approval framing for destructive reset patterns
- prefer a blocked-by-policy outcome over optimistic continuation

Success condition:

- Friday clearly stops and requests approval instead of sounding like it can
  proceed safely on its own

Fix class:

- runtime/policy/guidance

### Priority 2 — `clarification_gap` for overwhelmed users

Affected case:

- `dialog-overwhelmed-user-guided-options`

Why this is second:

- This case is the clearest example of Friday still feeling "dumb" to users who
  do not know what they want.

Required fix direction:

- improve ambiguity compression for overwhelmed users
- ask the smallest decisive question set
- default more aggressively when the risk is low
- present 2-3 structured options instead of broad open-ended follow-ups

Success condition:

- Friday helps the user converge quickly instead of asking broad, draining
  follow-up questions

Fix class:

- assistant guidance / persona policy

### Priority 3 — `clarification_gap` for concise users

Affected case:

- `dialog-concise-direction-style`

Why this is third:

- Friday is already stronger in warm and structured guidance; now the remaining
  style gap is on the "just tell me what to do" side.

Required fix direction:

- add a harder concise-response bias when persona prefers directness
- reduce scaffolding and explanatory padding
- collapse multi-paragraph guidance into short action-forward responses

Success condition:

- Friday gives a short, confident recommendation with only the minimum
  clarification needed

Fix class:

- persona rendering / assistant response policy

### Priority 4 — `boundary_explanation_gap` for low-fluff recommendations

Affected case:

- `dialog-direct-low-fluff-recommendations`

Why this is fourth:

- This is still important, but it is narrower than the other gaps and should
  improve once concise-mode rendering is stricter.

Required fix direction:

- make direct low-fluff explanations more operational
- avoid hedging language when the safe recommendation is obvious
- keep boundary wording crisp and short

Success condition:

- Friday gives a direct recommendation that still respects the boundary, but
  without sounding generic or evasive

Fix class:

- persona rendering / explanation policy

## Proposed Next Work Order

1. Fix `dialog-risk-boundary-reset`
2. Fix `dialog-overwhelmed-user-guided-options`
3. Fix `dialog-concise-direction-style`
4. Fix `dialog-direct-low-fluff-recommendations`
5. Re-run the same 3-repeat dialog benchmark before widening the benchmark set

## Boundary Reminder

None of these fixes should weaken Friday's current safety model.

The target is:

- more expert-like, more guided, less rigid communication

Not:

- softer approval boundaries
- hidden assumptions
- reckless autonomous execution
