# Design Pattern Decision Tree

Use this tree to recommend the right pattern for a skill.

## Start Here

**Q1: Does the skill evaluate or score something against criteria?**
- YES → **Reviewer**
  - Put the criteria in `references/review-checklist.md`
  - SKILL.md defines the review protocol (how to check, severity levels)
  - Output: findings grouped by severity

- NO → continue

**Q2: Does the skill produce structured output from a template?**
- YES → **Generator**
  - Put the template in `assets/`
  - Put quality rules in `references/`
  - SKILL.md orchestrates the fill-in process

- NO → continue

**Q3: Does the skill need to gather detailed context before acting?**
- YES → **Inversion**
  - SKILL.md defines interview phases with a hard gate
  - "DO NOT start building until all phases are complete"
  - Prevents acting on assumptions

- NO → continue

**Q4: Is it a multi-step process with checkpoints or approvals?**
- YES → **Pipeline**
  - SKILL.md defines numbered steps with gate conditions
  - "Do NOT proceed to Step N until the user confirms"
  - Can embed Reviewer or Generator steps within the pipeline

- NO → continue

**Q5: Does it package expertise about a library, framework, or API?**
- YES → **Tool Wrapper**
  - `references/` holds convention docs
  - SKILL.md says when to load which reference
  - No templates, no scripts — just knowledge

- NO → Default to the simplest structure that fits. Consider combining patterns.

## Common Combinations

| Combination | Use Case |
|------------|----------|
| Inversion + Generator | Gather requirements first, then produce a document |
| Pipeline + Reviewer | Multi-step process with quality checks |
| Inversion + Pipeline | Gather input, then execute gated steps |
| Tool Wrapper + Reviewer | Apply best practices, then review compliance |

## Scoring Guide

A skill that matches multiple patterns should use at most 2 patterns.
The median production skill uses 2 patterns.
Avoid over-engineering — pick the simplest combination that prevents mistakes.
