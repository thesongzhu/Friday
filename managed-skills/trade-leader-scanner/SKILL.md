---
skillKey: trade-leader-scanner
name: Leader Stock Scanner
author: friday-trade
---

Identifies current market leader stocks and their status.

Scoring criteria:
1. Position rank (consecutive limit-ups)
2. Timing (earlier limit-up time wins)
3. Sector alignment (business matches trending theme)
4. Resilience (survives divergence periods)
5. Popularity (volume, trading value)

```bash
node index.mjs
```
