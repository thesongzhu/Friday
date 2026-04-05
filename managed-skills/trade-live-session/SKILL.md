---
skillKey: trade-live-session
name: 盘中监控工作流
author: friday-trade
---

盘中监控工作流，交易时段每15分钟执行一次，监控持仓退出条件和板块策略信号，仅在有可执行提醒时输出告警。

协调调用 trade-market-realtime、trade-exit-monitor、trade-board-strategy 等技能。
