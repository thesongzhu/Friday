---
skillKey: trade-journal
name: 交易日志
author: friday-trade
---

Records trade decisions, outcomes, and reasoning. Builds the user's personal trading journal.

Supports four actions:
- record_entry: Log a new trade entry with full context (symbol, strategy, sentiment phase, emotional state, reasoning)
- record_exit: Log trade exit with price, automatically calculate P&L
- daily_summary: Generate end-of-day summary with all trades, lessons learned, and emotional patterns
- query: Search past journal entries by date, symbol, strategy, or keyword

The skill auto-detects behavioral patterns such as "FOMO trades lose money", "calm trades win more", and "strategy X works better in phase Y". All data is persisted to a local JSON file (journal-data.json).
