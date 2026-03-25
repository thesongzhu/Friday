# Stable Workspace Facts

- Friday loads workspace context fresh on each agent run from `AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md`, `memory/YYYY-MM-DD.md`, and exported memory items under `.friday/exports/memory/`.
- In this repository, `skills` are the main extensibility backbone.
- `skill.manifest.json` is the structured source of truth for a skill package. `SKILL.md` is lightweight human/model guidance.
- Repo-wide routing and behavior rules belong in `AGENTS.md`.
- Style and response defaults belong in `SOUL.md`.
- Maintainer preferences belong in `USER.md`.
- Durable project facts belong in `MEMORY.md`.
- Short-lived working notes belong in `memory/YYYY-MM-DD.md`.
- Repeated operational routines should graduate into automations or workflows instead of expanding prompt instructions.
- When product docs conflict with historical notes, prefer `docs/current-source-of-truth.md`.
