---
skillKey: trade-live-session
name: Live Session Monitor
author: friday-trade
---

Intraday monitoring workflow. Runs every 15 minutes during trading hours (9:00-15:00 CST).

Checks exit conditions for held positions and scans for new high-confidence setups. Only generates alerts when there is actionable information.

```bash
node index.mjs
```
