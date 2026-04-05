---
skillKey: trade-evening-review
name: Evening Review Workflow
author: friday-trade
---

Post-market daily review workflow. Runs at 17:00 CST on trading days.

Aggregates end-of-day data, updates portfolio, auto-journals trades, analyzes sentiment for next day, generates tomorrow's watchlist, and runs weekly strategy fitness analysis on Fridays.

```bash
node index.mjs
```
