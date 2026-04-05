---
skillKey: trade-strategy-fitness
name: 策略适配度分析
author: friday-trade
---

Analyzes which trading strategies work best for the specific user and recommends focus areas.

The learning loop closer:
1. Computes fitness score per strategy: fitnessScore = winRate * 0.4 + profitFactor * 0.3 + consistency * 0.3
2. Ranks strategies by fitness
3. Generates actionable recommendations:
   - Top strategy: "继续保持，这是你的优势策略"
   - Good (fitness > 0.6): "可以适当增加仓位"
   - Mediocre (0.3-0.6): "需要更多练习，建议用小仓位"
   - Poor (< 0.3): "建议暂时减少使用，回顾知识库中的相关教程"
4. Suggests user profile updates based on actual fitness data
5. Identifies knowledge gaps: strategies with low fitness + low sample size indicate areas where the user should study more
