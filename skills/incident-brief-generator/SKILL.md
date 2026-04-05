# Incident Brief Generator

Builds a concise incident handoff from symptoms, health evidence, and logs.

Design pattern: **Generator**

## Generation Protocol

1. Load the template from `assets/incident-brief-template.md`.
2. Collect available evidence: error logs, health checks, monitoring alerts, user reports.
3. Fill each template section:
   - **Current Situation** — one-paragraph summary of what is happening.
   - **Impact** — affected users, services, and revenue (use "unknown" if not available).
   - **Evidence** — source and finding for each data point.
   - **Likely Causes** — ranked hypotheses with confidence levels.
   - **Next Actions** — concrete steps with suggested owners.
4. Output the filled template as a markdown document.

## Constraints

- Use only evidence that is actually available — do not fabricate metrics.
- Keep the brief under 500 words for quick handoff reading.
- Severity must be assessed from impact data, not assumed.
