# Engineering Retro

Builds a lightweight retrospective from recent git history and local Friday evidence.

Design pattern: **Generator**

## Generation Protocol

1. Load the template from `assets/retro-template.md`.
2. Gather data: recent git commits, merged PRs, incidents, and any Friday session evidence.
3. Fill each template section:
   - **What We Shipped** — list of completed work with summaries.
   - **What Went Well** — positive patterns observed in the data.
   - **What Could Improve** — friction points with suggested actions.
   - **Key Metrics** — commit counts, PR throughput, incident counts with trends.
   - **Action Items** — concrete follow-ups with suggested owners.
4. Output the filled template as a markdown document.

## Constraints

- Base observations on evidence from git and Friday data, not speculation.
- Keep the retro concise — one page, scannable in 2 minutes.

Typical triggers:

- `run an engineering retro`
- `what did we ship`
- `summarize recent engineering work`
