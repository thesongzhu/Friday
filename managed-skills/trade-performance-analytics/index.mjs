#!/usr/bin/env node

/**
 * 交易绩效分析 — Trade Performance Analytics
 *
 * Analyzes trading performance over time with strategy-specific breakdowns.
 * Reads data from trade-journal's journal-data.json or accepts inline data.
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const JOURNAL_DATA_FILE = join(__dirname, "..", "trade-journal", "journal-data.json");

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
// Load journal data
// ---------------------------------------------------------------------------

function loadJournalData(input) {
  // Prefer inline journalData
  if (input.journalData && input.journalData.entries) {
    return input.journalData;
  }

  // Try reading from trade-journal skill's data file
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
    case "week":
      cutoff = new Date(now);
      cutoff.setDate(cutoff.getDate() - 7);
      break;
    case "month":
      cutoff = new Date(now);
      cutoff.setMonth(cutoff.getMonth() - 1);
      break;
    case "quarter":
      cutoff = new Date(now);
      cutoff.setMonth(cutoff.getMonth() - 3);
      break;
    case "year":
      cutoff = new Date(now);
      cutoff.setFullYear(cutoff.getFullYear() - 1);
      break;
    default:
      cutoff = new Date(now);
      cutoff.setMonth(cutoff.getMonth() - 1);
  }

  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return entries.filter((e) => e.date >= cutoffStr);
}

// ---------------------------------------------------------------------------
// Core analytics
// ---------------------------------------------------------------------------

function computeSummary(completedTrades) {
  if (completedTrades.length === 0) {
    return {
      totalTrades: 0,
      winRate: 0,
      totalPnl: 0,
      avgGain: 0,
      avgLoss: 0,
      profitFactor: 0,
      maxDrawdown: 0,
    };
  }

  const wins = completedTrades.filter((t) => t.pnl > 0);
  const losses = completedTrades.filter((t) => t.pnl <= 0);

  const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));

  const totalPnl = grossProfit - grossLoss;
  const avgGain = wins.length > 0 ? +(grossProfit / wins.length).toFixed(2) : 0;
  const avgLoss = losses.length > 0 ? +(-grossLoss / losses.length).toFixed(2) : 0;
  const profitFactor = grossLoss > 0 ? +(grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? 999 : 0;

  return {
    totalTrades: completedTrades.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRate: +(wins.length / completedTrades.length).toFixed(4),
    totalPnl: +totalPnl.toFixed(2),
    grossProfit: +grossProfit.toFixed(2),
    grossLoss: +grossLoss.toFixed(2),
    avgGain,
    avgLoss,
    profitFactor,
  };
}

function computeByStrategy(completedTrades) {
  const strategyMap = {};

  for (const trade of completedTrades) {
    const strat = trade.strategy || "未分类";
    if (!strategyMap[strat]) {
      strategyMap[strat] = [];
    }
    strategyMap[strat].push(trade);
  }

  return Object.entries(strategyMap)
    .map(([strategy, trades]) => {
      const wins = trades.filter((t) => t.pnl > 0);
      const losses = trades.filter((t) => t.pnl <= 0);
      const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
      const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
      const totalPnl = grossProfit - grossLoss;

      return {
        strategy,
        totalTrades: trades.length,
        winRate: +(wins.length / trades.length).toFixed(4),
        winCount: wins.length,
        lossCount: losses.length,
        totalPnl: +totalPnl.toFixed(2),
        avgReturn: +(totalPnl / trades.length).toFixed(2),
        profitFactor: grossLoss > 0 ? +(grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? 999 : 0,
        avgGain: wins.length > 0 ? +(grossProfit / wins.length).toFixed(2) : 0,
        avgLoss: losses.length > 0 ? +(-grossLoss / losses.length).toFixed(2) : 0,
      };
    })
    .sort((a, b) => b.totalPnl - a.totalPnl);
}

function getTopTrades(completedTrades, count, direction) {
  const sorted = [...completedTrades].sort((a, b) =>
    direction === "best" ? b.pnl - a.pnl : a.pnl - b.pnl
  );

  return sorted.slice(0, count).map((t) => ({
    date: t.date,
    symbol: t.symbol,
    strategy: t.strategy,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    pnl: t.pnl,
    pnlPercent: t.pnlPercent,
    emotionalState: t.emotionalState,
    sentimentPhase: t.sentimentPhase,
  }));
}

function computeDrawdown(completedTrades) {
  if (completedTrades.length === 0) return [];

  // Sort by date
  const sorted = [...completedTrades].sort((a, b) => (a.date < b.date ? -1 : 1));

  let cumulativePnl = 0;
  let peak = 0;
  const history = [];

  for (const trade of sorted) {
    cumulativePnl += trade.pnl || 0;
    if (cumulativePnl > peak) peak = cumulativePnl;

    const drawdown = peak > 0 ? +((peak - cumulativePnl) / peak).toFixed(4) : 0;

    history.push({
      date: trade.date,
      cumulativePnl: +cumulativePnl.toFixed(2),
      peak: +peak.toFixed(2),
      drawdown,
      drawdownAmount: +(peak - cumulativePnl).toFixed(2),
    });
  }

  return history;
}

function generateSuggestions(summary, byStrategyData, completedTrades) {
  const suggestions = [];

  // Overall win rate
  if (summary.winRate < 0.4 && summary.totalTrades >= 10) {
    suggestions.push({
      type: "win_rate",
      severity: "warning",
      message: `总体胜率偏低 (${(summary.winRate * 100).toFixed(1)}%)，建议回顾选股和择时逻辑`,
    });
  }

  // Profit factor
  if (summary.profitFactor < 1 && summary.totalTrades >= 5) {
    suggestions.push({
      type: "profit_factor",
      severity: "critical",
      message: `盈亏比不达标 (${summary.profitFactor})，亏损总额大于盈利总额，需要改善止损策略`,
    });
  } else if (summary.profitFactor >= 2) {
    suggestions.push({
      type: "profit_factor",
      severity: "positive",
      message: `盈亏比优秀 (${summary.profitFactor})，保持当前交易纪律`,
    });
  }

  // Strategy comparison
  if (byStrategyData.length >= 2) {
    const best = byStrategyData[0];
    const worst = byStrategyData[byStrategyData.length - 1];

    if (best.winRate > 0.6 && best.totalTrades >= 5) {
      suggestions.push({
        type: "strategy_focus",
        severity: "positive",
        message: `你的 ${best.strategy} 胜率为 ${(best.winRate * 100).toFixed(0)}%` +
          (worst.winRate < 0.4 && worst.totalTrades >= 3
            ? ` vs ${worst.strategy} 仅 ${(worst.winRate * 100).toFixed(0)}% — 考虑更多使用 ${best.strategy}`
            : ` — 继续保持`),
      });
    }
  }

  // Average loss vs average gain
  if (summary.avgGain > 0 && summary.avgLoss < 0) {
    const ratio = summary.avgGain / Math.abs(summary.avgLoss);
    if (ratio < 1.5) {
      suggestions.push({
        type: "risk_reward",
        severity: "warning",
        message: `盈利笔均收益 (${summary.avgGain}) 与亏损笔均亏损 (${summary.avgLoss}) 比值偏低 (${ratio.toFixed(2)})，建议改善盈亏比`,
      });
    }
  }

  // Emotional patterns from trades
  const emotionGroups = {};
  for (const t of completedTrades) {
    if (t.emotionalState) {
      if (!emotionGroups[t.emotionalState]) emotionGroups[t.emotionalState] = { wins: 0, total: 0 };
      emotionGroups[t.emotionalState].total++;
      if (t.pnl > 0) emotionGroups[t.emotionalState].wins++;
    }
  }

  for (const [emotion, data] of Object.entries(emotionGroups)) {
    if (data.total >= 3) {
      const wr = data.wins / data.total;
      if (emotion === "fomo" && wr < 0.4) {
        suggestions.push({
          type: "emotional",
          severity: "warning",
          message: `FOMO交易胜率仅 ${(wr * 100).toFixed(0)}%，强烈建议减少冲动交易`,
        });
      }
      if (emotion === "calm" && wr > 0.6) {
        suggestions.push({
          type: "emotional",
          severity: "positive",
          message: `冷静状态下胜率达 ${(wr * 100).toFixed(0)}%，说明情绪管理是你的优势`,
        });
      }
    }
  }

  return suggestions;
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

  const period = input.period || "month";
  const includeByStrategy = input.byStrategy !== false;

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

  // Compute analytics
  const summary = computeSummary(completedTrades);
  const byStrategyData = includeByStrategy ? computeByStrategy(completedTrades) : [];
  const bestTrades = getTopTrades(completedTrades, 5, "best");
  const worstTrades = getTopTrades(completedTrades, 5, "worst");
  const drawdownHistory = computeDrawdown(completedTrades);
  const suggestions = generateSuggestions(summary, byStrategyData, completedTrades);

  // Max drawdown from history
  if (drawdownHistory.length > 0) {
    summary.maxDrawdown = Math.max(...drawdownHistory.map((d) => d.drawdown));
    summary.maxDrawdownAmount = Math.max(...drawdownHistory.map((d) => d.drawdownAmount));
  }

  const result = {
    period,
    summary,
    byStrategy: byStrategyData,
    bestTrades,
    worstTrades,
    drawdownHistory,
    suggestions,
  };

  console.log(JSON.stringify(result, null, 2));
}

main();
