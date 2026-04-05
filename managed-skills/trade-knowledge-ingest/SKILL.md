---
skillKey: trade-knowledge-ingest
name: 交易知识导入引擎
author: friday-trade
---

将交易知识库文件（PDF/DOCX/DOC/CSV）导入 Friday 记忆系统，按主题/系列/类型分块标签化，支持增量导入。

## 用法

导入 Trade Agent OG 知识库：
```
trade-knowledge-ingest --contentDir /path/to/trade-agent-og
```

支持的内容类型：
- 情绪周期、人气龙头、打板策略、低吸、板块轮动
- 竞价分析、游资追踪、龙虎榜、弱转强、反包
- 行业研究框架、价值投资理论
