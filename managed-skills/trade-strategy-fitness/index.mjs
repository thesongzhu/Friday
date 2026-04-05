#!/usr/bin/env node

/**
 * 策略适配度分析 — Trade Strategy Fitness
 *
 * Analyzes which trading strategies work best for the specific user
 * and recommends focus areas. The learning loop closer.
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const JOURNAL_DATA_FILE = join(__dirname, "..", "trade-journal", "journal-data.json");

// ---------------------------------------------------------------------------
// Known strategy topics for knowledge gap detection
// ---------------------------------------------------------------------------

const STRATEGY_KNOWLEDGE_MAP = {
  打板: {
    topic: "涨停板打板技术",
    resources: ["涨停板战法", "封单量分析", "打板时机选择"],
  },
  低吸: {
    topic: "低吸买入策略",
    resources: ["支撑位判断", "缩量企稳信号", "低吸仓位管理"],
  },
  半路: {
    topic: "半路追涨策略",
    resources: ["分时放量突破", "半路介入位置选择", "半路仓位控制"],
  },
  追涨: {
    topic: "追涨策略",
    resources: ["强势股追涨逻辑", "追涨止损设置", "情绪与追涨纪律"],
  },
  做T: {
    topic: "日内做T策略",
    resources: ["分时图技术", "T+0操作手法", "做T成本计算"],
  },
  接力: {
    topic: "龙头接力策略",
    resources: ["龙头辨识", "接力时机判断", "高位接力风险控制"],
  },
  首板: {
    topic: "首板策略",
    resources: ["首板选股逻辑", "首板封单分析", "首板次日策略"],
  },
};

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

function getInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf-8').trim() || '{}');
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Load data
// ---------------------------------------------------------------------------

function loadJournalData(input) {
  if (input.journalData && input.journalData.entries) {
    return input.journalData;
  }

  if (existsSync(JOURNAL_DATA_FILE)) {
    try {
      return JSON.parse(readFileSync(JOURNAL_DATA_FILE, "utf-8"));
    } catch {
      // fall through
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Period filtering
// ---------------------------------------------------------------------------

function filterByPeriod(entries, period) {
  if (period === "all") return entries;

  const now = new Date();
  let cutoff;

  switch (period) {
    case "month":
      cutoff = new Date(now);
      cutoff.setMonth(cutoff.getMonth() - 1);
      break;
    case "quarter":
      cutoff = new Date(now);
      cutoff.setMonth(cutoff.getMonth() - 3);
      break;
    default:
      cutoff = new Date(now);
      cutoff.setMonth(cutoff.getMonth() - 3);
  }

  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return entries.filter((e) => e.date >= cutoffStr);
}

// ---------------------------------------------------------------------------
// Fitness computation
// ---------------------------------------------------------------------------

function computeStrategyScores(completedTrades) {
  const strategyMap = {};

  for (const trade of completedTrades) {
    const strat = trade.strategy || "未分类";
    if (!strategyMap[strat]) {
      strategyMap[strat] = [];
    }
    strategyMap[strat].push(trade);
  }

  return Object.entries(strategyMap).map(([strategy, trades]) => {
    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) => t.pnl <= 0);
    const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
    const totalPnl = grossProfit - grossLoss;

    const winRate = trades.length > 0 ? wins.length / trades.length : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 3 : 0;
    const avgReturn = trades.length > 0 ? totalPnl / trades.length : 0;

    // Consistency: standard deviation of returns (lower = more consistent)
    const returns = trades.map((t) => t.pnl || 0);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    // Normalize consistency: 1 = perfectly consistent, 0 = highly variable
    // Use coefficient of variation inverted
    const consistency = mean !== 0 ? Math.max(0, Math.min(1, 1 - stdDev / (Math.abs(mean) * 3))) : 0;

    // Normalize profitFactor for scoring (cap at 3)
    const normalizedPF = Math.min(profitFactor / 3, 1);

    // Fitness score = winRate * 0.4 + profitFactor * 0.3 + consistency * 0.3
    const fitnessScore = +(winRate * 0.4 + normalizedPF * 0.3 + consistency * 0.3).toFixed(4);

    return {
      strategy,
      winRate: +winRate.toFixed(4),
      avgReturn: +avgReturn.toFixed(2),
      totalPnl: +totalPnl.toFixed(2),
      profitFactor: +profitFactor.toFixed(2),
      consistency: +consistency.toFixed(4),
      sampleSize: trades.length,
      fitnessScore,
    };
  }).sort((a, b) => b.fitnessScore - a.fitnessScore);
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

function generateRecommendations(strategyScores) {
  const recommendations = [];

  for (let i = 0; i < strategyScores.length; i++) {
    const s = strategyScores[i];

    if (i === 0 && s.fitnessScore > 0.6) {
      recommendations.push({
        strategy: s.strategy,
        action: "maintain",
        priority: "high",
        message: `${s.strategy}: 继续保持，这是你的优势策略 (适配度: ${(s.fitnessScore * 100).toFixed(0)}%, 胜率: ${(s.winRate * 100).toFixed(0)}%)`,
      });
    } else if (s.fitnessScore > 0.6) {
      recommendations.push({
        strategy: s.strategy,
        action: "increase",
        priority: "medium",
        message: `${s.strategy}: 可以适当增加仓位 (适配度: ${(s.fitnessScore * 100).toFixed(0)}%, 胜率: ${(s.winRate * 100).toFixed(0)}%)`,
      });
    } else if (s.fitnessScore >= 0.3) {
      recommendations.push({
        strategy: s.strategy,
        action: "practice",
        priority: "low",
        message: `${s.strategy}: 需要更多练习，建议用小仓位 (适配度: ${(s.fitnessScore * 100).toFixed(0)}%, 胜率: ${(s.winRate * 100).toFixed(0)}%)`,
      });
    } else {
      recommendations.push({
        strategy: s.strategy,
        action: "reduce",
        priority: "high",
        message: `${s.strategy}: 建议暂时减少使用，回顾知识库中的相关教程 (适配度: ${(s.fitnessScore * 100).toFixed(0)}%, 胜率: ${(s.winRate * 100).toFixed(0)}%)`,
      });
    }
  }

  return recommendations;
}

// ---------------------------------------------------------------------------
// Profile update suggestions
// ---------------------------------------------------------------------------

function generateProfileSuggestions(strategyScores, userProfile) {
  const suggestions = [];

  // Suggest updating preferredStyles based on actual fitness
  const topStrategies = strategyScores
    .filter((s) => s.fitnessScore > 0.5 && s.sampleSize >= 5)
    .map((s) => s.strategy);

  const poorStrategies = strategyScores
    .filter((s) => s.fitnessScore < 0.3 && s.sampleSize >= 5)
    .map((s) => s.strategy);

  if (topStrategies.length > 0) {
    const currentPreferred = userProfile?.preferredStyles || [];
    const missingFromProfile = topStrategies.filter((s) => !currentPreferred.includes(s));

    if (missingFromProfile.length > 0) {
      suggestions.push({
        field: "preferredStyles",
        action: "add",
        values: missingFromProfile,
        reason: `实际表现显示 ${missingFromProfile.join(", ")} 是你的优势策略，建议加入偏好风格`,
      });
    }
  }

  if (poorStrategies.length > 0) {
    const currentPreferred = userProfile?.preferredStyles || [];
    const shouldRemove = poorStrategies.filter((s) => currentPreferred.includes(s));

    if (shouldRemove.length > 0) {
      suggestions.push({
        field: "preferredStyles",
        action: "remove",
        values: shouldRemove,
        reason: `${shouldRemove.join(", ")} 实际适配度较低，建议从偏好风格中移除`,
      });
    }
  }

  // Suggest risk level adjustment
  const overallWinRate =
    strategyScores.reduce((sum, s) => sum + s.winRate * s.sampleSize, 0) /
    strategyScores.reduce((sum, s) => sum + s.sampleSize, 0);

  if (overallWinRate > 0.65 && userProfile?.riskLevel === "conservative") {
    suggestions.push({
      field: "riskLevel",
      action: "update",
      currentValue: "conservative",
      suggestedValue: "moderate",
      reason: "你的整体胜率较高，可以考虑适当提升风险偏好",
    });
  } else if (overallWinRate < 0.35 && userProfile?.riskLevel !== "conservative") {
    suggestions.push({
      field: "riskLevel",
      action: "update",
      currentValue: userProfile?.riskLevel || "unknown",
      suggestedValue: "conservative",
      reason: "整体胜率偏低，建议降低风险偏好，用更保守的仓位",
    });
  }

  return suggestions;
}

// ---------------------------------------------------------------------------
// Knowledge gap detection
// ---------------------------------------------------------------------------

function identifyKnowledgeGaps(strategyScores) {
  const gaps = [];

  for (const s of strategyScores) {
    // Low fitness + low sample size = hasn't learned enough
    if (s.fitnessScore < 0.4 && s.sampleSize < 10 && s.sampleSize >= 2) {
      const knowledgeInfo = STRATEGY_KNOWLEDGE_MAP[s.strategy];

      gaps.push({
        strategy: s.strategy,
        fitnessScore: s.fitnessScore,
        sampleSize: s.sampleSize,
        diagnosis: "低适配度 + 低样本量，可能缺乏足够的策略知识",
        topic: knowledgeInfo ? knowledgeInfo.topic : `${s.strategy}策略学习`,
        suggestedResources: knowledgeInfo ? knowledgeInfo.resources : [`${s.strategy}基础教程`, `${s.strategy}实战案例`],
        message: `${s.strategy}: 适配度 ${(s.fitnessScore * 100).toFixed(0)}%，仅 ${s.sampleSize} 笔交易 — 建议先学习 ${knowledgeInfo ? knowledgeInfo.topic : s.strategy + "相关知识"} 再实战`,
      });
    }

    // Has samples but consistently poor = fundamental misunderstanding
    if (s.fitnessScore < 0.3 && s.sampleSize >= 10) {
      const knowledgeInfo = STRATEGY_KNOWLEDGE_MAP[s.strategy];

      gaps.push({
        strategy: s.strategy,
        fitnessScore: s.fitnessScore,
        sampleSize: s.sampleSize,
        diagnosis: "足够样本量但适配度极低，可能存在策略理解偏差",
        topic: knowledgeInfo ? knowledgeInfo.topic : `${s.strategy}策略深度学习`,
        suggestedResources: knowledgeInfo ? knowledgeInfo.resources : [`${s.strategy}高级教程`, `${s.strategy}常见错误分析`],
        message: `${s.strategy}: 已有 ${s.sampleSize} 笔交易但适配度仅 ${(s.fitnessScore * 100).toFixed(0)}% — 需要系统性回顾${knowledgeInfo ? knowledgeInfo.topic : s.strategy + "策略"}`,
      });
    }
  }

  return gaps;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const input = getInput();
  const journalData = loadJournalData(input);

  if (!journalData || !journalData.entries || journalData.entries.length === 0) {
    const output = {
      error: "no_data",
      message:
        "未找到交易数据。请先使用 trade-journal 技能记录交易，或通过 journalData 输入提供数据。",
    };
    console.log(JSON.stringify(output, null, 2));
    process.exit(0);
  }

  const period = input.period || "quarter";
  const userProfile = input.userProfile || {};

  // Filter entries by period
  const periodEntries = filterByPeriod(journalData.entries, period);

  // Get completed trades (exits with P&L)
  const completedTrades = periodEntries.filter((e) => e.type === "exit" && e.pnl !== undefined);

  if (completedTrades.length === 0) {
    const output = {
      error: "no_completed_trades",
      message: `在 ${period} 周期内没有已完成的交易记录。`,
      period,
    };
    console.log(JSON.stringify(output, null, 2));
    process.exit(0);
  }

  // Use performance data if provided, otherwise compute from journal
  const strategyScores = computeStrategyScores(completedTrades);
  const recommendations = generateRecommendations(strategyScores);
  const profileUpdateSuggestions = generateProfileSuggestions(strategyScores, userProfile);
  const knowledgeGaps = identifyKnowledgeGaps(strategyScores);

  const result = {
    period,
    totalAnalyzedTrades: completedTrades.length,
    strategyScores,
    recommendations,
    profileUpdateSuggestions,
    knowledgeGaps,
  };

  console.log(JSON.stringify(result, null, 2));
}

main();
