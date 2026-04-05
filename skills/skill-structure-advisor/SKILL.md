# Skill Structure Advisor

Helps you choose the right design pattern and structure for a new skill.

Design patterns: **Inversion** + **Reviewer**

## Interview Protocol (Inversion)

### Phase 1 — What does the skill do?
Ask the user:
1. What is the skill's primary job? (e.g., "review code", "generate a report", "wrap a library")
2. Does it produce structured output, or evaluate/score something?

### Phase 2 — How does it interact?
Ask the user:
3. Does the skill need to gather information from the user before acting?
4. Is there a multi-step process with approval gates, or is it a single action?

### Phase 3 — What resources does it need?
Ask the user:
5. Does it reference external docs, checklists, or templates?

## Gate

**DO NOT recommend a pattern until all three phases are complete.**

## Pattern Selection (Reviewer)

Once all phases are answered, evaluate against the decision tree in `references/pattern-decision-tree.md`.

## Output

Produce:
1. **Recommended pattern(s)** — one or two from: tool-wrapper, generator, reviewer, inversion, pipeline.
2. **Suggested directory structure** — which files go in SKILL.md, references/, assets/, scripts/.
3. **SKILL.md skeleton** — a starter template following the recommended pattern.
4. **Rationale** — why this pattern fits and what alternatives were considered.

Typical triggers:

- `help me structure a new skill`
- `which design pattern should I use`
- `skill architecture advice`
