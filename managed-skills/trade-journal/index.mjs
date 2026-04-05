#!/usr/bin/env node

/**
 * 交易日志 — Trade Journal
 *
 * Records trade decisions, outcomes, and reasoning.
 * Persists data to journal-data.json in the skill directory.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, "journal-data.json");

// ---------------------------------------------------------------------------
// Data persistence
// ---------------------------------------------------------------------------

function loadData() {
  if (!existsSync(DATA_FILE)) {
    return { entries: [], version: 1 };
  }
  try {
    return JSON.parse(readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return { entries: [], version: 1 };
  }
}

function saveData(data) {
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

function getInput() {
  const raw =
    process.env.FRIDAY_INPUT ||
    process.env.SKILL_INPUT ||
    (process.argv[2] ? process.argv[2] : null);

  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Generate unique ID
// ---------------------------------------------------------------------------

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------------------------------------------------------------------------
// Pattern detection
// ---------------------------------------------------------------------------

function detectPatterns(entries) {
  const patterns = [];
  if (entries.length < 3) return patterns;

  // Completed trades (those with both entry and exit)
  const completed = entries.filter((e) => e.type === "exit" && e.pnl !== undefined);
  if (completed.length < 3) return patterns;

  // Pattern: FOMO trades lose money
  const fomoTrades = completed.filter((e) => e.emotionalState === "fomo");
  if (fomoTrades.length >= 2) {
    const fomoLosses = fomoTrades.filter((e) => e.pnl < 0).length;
    const fomoLossRate = fomoLosses / fomoTrades.length;
    if (fomoLossRate > 0.5) {
      patterns.push({
        type: "emotional",
        pattern: "FOMO交易亏损率高",
        detail: `FOMO交易亏损率: ${(fomoLossRate * 100).toFixed(0)}% (${fomoLosses}/${fomoTrades.length})`,
        severity: "warning",
      });
    }
  }

  // Pattern: calm trades win more
  const calmTrades = completed.filter((e) => e.emotionalState === "calm");
  if (calmTrades.length >= 2) {
    const calmWins = calmTrades.filter((e) => e.pnl > 0).length;
    const calmWinRate = calmWins / calmTrades.length;
    if (calmWinRate > 0.5) {
      patterns.push({
        type: "emotional",
        pattern: "冷静交易胜率更高",
        detail: `冷静交易胜率: ${(calmWinRate * 100).toFixed(0)}% (${calmWins}/${calmTrades.length})`,
        severity: "positive",
      });
    }
  }

  // Pattern: strategy X works in phase Y
  const strategyPhaseMap = {};
  for (const trade of completed) {
    if (trade.strategy && trade.sentimentPhase) {
      const key = `${trade.strategy}|${trade.sentimentPhase}`;
      if (!strategyPhaseMap[key]) strategyPhaseMap[key] = { wins: 0, total: 0 };
      strategyPhaseMap[key].total++;
      if (trade.pnl > 0) strategyPhaseMap[key].wins++;
    }
  }

  for (const [key, data] of Object.entries(strategyPhaseMap)) {
    if (data.total >= 3) {
      const [strategy, phase] = key.split("|");
      const winRate = data.wins / data.total;
      if (winRate >= 0.7) {
        patterns.push({
          type: "strategy_phase",
          pattern: `${strategy}在${phase}阶段表现优秀`,
          detail: `胜率: ${(winRate * 100).toFixed(0)}% (${data.wins}/${data.total})`,
          severity: "positive",
        });
      } else if (winRate <= 0.3) {
        patterns.push({
          type: "strategy_phase",
          pattern: `${strategy}在${phase}阶段表现不佳`,
          detail: `胜率: ${(winRate * 100).toFixed(0)}% (${data.wins}/${data.total})`,
          severity: "warning",
        });
      }
    }
  }

  // Pattern: emotional state distribution
  const emotionCounts = {};
  for (const trade of completed) {
    if (trade.emotionalState) {
      emotionCounts[trade.emotionalState] = (emotionCounts[trade.emotionalState] || 0) + 1;
    }
  }
  const totalWithEmotion = Object.values(emotionCounts).reduce((a, b) => a + b, 0);
  if (totalWithEmotion > 0) {
    for (const [emotion, count] of Object.entries(emotionCounts)) {
      const ratio = count / totalWithEmotion;
      if (ratio > 0.4 && (emotion === "fomo" || emotion === "greedy" || emotion === "anxious")) {
        patterns.push({
          type: "emotional_dominance",
          pattern: `交易中${emotion}情绪占比过高`,
          detail: `${emotion}占比: ${(ratio * 100).toFixed(0)}% (${count}/${totalWithEmotion})`,
          severity: "warning",
        });
      }
    }
  }

  return patterns;
}

// ---------------------------------------------------------------------------
// Compute running stats
// ---------------------------------------------------------------------------

function computeStats(entries) {
  const completed = entries.filter((e) => e.type === "exit" && e.pnl !== undefined);
  const totalTrades = completed.length;

  if (totalTrades === 0) {
    return {
      totalTrades: 0,
      totalEntries: entries.filter((e) => e.type === "entry").length,
      openPositions: entries.filter((e) => e.type === "entry" && !e.closedByExitId).length,
      winRate: 0,
      totalPnl: 0,
      avgPnl: 0,
    };
  }

  const wins = completed.filter((e) => e.pnl > 0);
  const losses = completed.filter((e) => e.pnl <= 0);
  const totalPnl = completed.reduce((sum, e) => sum + e.pnl, 0);

  return {
    totalTrades,
    totalEntries: entries.filter((e) => e.type === "entry").length,
    openPositions: entries.filter((e) => e.type === "entry" && !e.closedByExitId).length,
    winRate: +(wins.length / totalTrades).toFixed(4),
    winCount: wins.length,
    lossCount: losses.length,
    totalPnl: +totalPnl.toFixed(2),
    avgPnl: +(totalPnl / totalTrades).toFixed(2),
    avgWin: wins.length > 0 ? +(wins.reduce((s, e) => s + e.pnl, 0) / wins.length).toFixed(2) : 0,
    avgLoss: losses.length > 0 ? +(losses.reduce((s, e) => s + e.pnl, 0) / losses.length).toFixed(2) : 0,
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function recordEntry(input, data) {
  const entry = {
    id: generateId(),
    type: "entry",
    timestamp: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    symbol: input.symbol || null,
    strategy: input.strategy || null,
    entryPrice: input.entryPrice || null,
    shares: input.shares || null,
    sentimentPhase: input.sentimentPhase || null,
    emotionalState: input.emotionalState || null,
    notes: input.notes || null,
    closedByExitId: null,
  };

  data.entries.push(entry);
  saveData(data);

  const patterns = detectPatterns(data.entries);
  const stats = computeStats(data.entries);

  return { entry, patterns, stats };
}

function recordExit(input, data) {
  // Find the most recent open entry for this symbol
  let matchEntry = null;
  if (input.symbol) {
    for (let i = data.entries.length - 1; i >= 0; i--) {
      const e = data.entries[i];
      if (e.type === "entry" && e.symbol === input.symbol && !e.closedByExitId) {
        matchEntry = e;
        break;
      }
    }
  }

  // Calculate P&L if we have matching entry
  let pnl = null;
  let pnlPercent = null;
  if (matchEntry && matchEntry.entryPrice && input.exitPrice) {
    const shares = input.shares || matchEntry.shares || 0;
    pnl = +((input.exitPrice - matchEntry.entryPrice) * shares).toFixed(2);
    pnlPercent = +(((input.exitPrice - matchEntry.entryPrice) / matchEntry.entryPrice) * 100).toFixed(2);
  }

  const exitEntry = {
    id: generateId(),
    type: "exit",
    timestamp: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    symbol: input.symbol || null,
    strategy: input.strategy || (matchEntry ? matchEntry.strategy : null),
    exitPrice: input.exitPrice || null,
    shares: input.shares || (matchEntry ? matchEntry.shares : null),
    entryPrice: matchEntry ? matchEntry.entryPrice : null,
    pnl,
    pnlPercent,
    sentimentPhase: input.sentimentPhase || (matchEntry ? matchEntry.sentimentPhase : null),
    emotionalState: input.emotionalState || (matchEntry ? matchEntry.emotionalState : null),
    notes: input.notes || null,
    matchedEntryId: matchEntry ? matchEntry.id : null,
  };

  // Mark the entry as closed
  if (matchEntry) {
    matchEntry.closedByExitId = exitEntry.id;
  }

  data.entries.push(exitEntry);
  saveData(data);

  const patterns = detectPatterns(data.entries);
  const stats = computeStats(data.entries);

  return { entry: exitEntry, patterns, stats };
}

function dailySummary(input, data) {
  const today = input.date || new Date().toISOString().slice(0, 10);
  const todayEntries = data.entries.filter((e) => e.date === today);

  const entries = todayEntries.filter((e) => e.type === "entry");
  const exits = todayEntries.filter((e) => e.type === "exit");
  const completedExits = exits.filter((e) => e.pnl !== undefined);

  const totalPnl = completedExits.reduce((sum, e) => sum + (e.pnl || 0), 0);
  const wins = completedExits.filter((e) => e.pnl > 0).length;
  const losses = completedExits.filter((e) => e.pnl <= 0).length;

  // Emotional breakdown
  const emotionBreakdown = {};
  for (const e of todayEntries) {
    if (e.emotionalState) {
      emotionBreakdown[e.emotionalState] = (emotionBreakdown[e.emotionalState] || 0) + 1;
    }
  }

  // Strategy breakdown
  const strategyBreakdown = {};
  for (const e of completedExits) {
    const strat = e.strategy || "unknown";
    if (!strategyBreakdown[strat]) strategyBreakdown[strat] = { wins: 0, losses: 0, pnl: 0 };
    if (e.pnl > 0) strategyBreakdown[strat].wins++;
    else strategyBreakdown[strat].losses++;
    strategyBreakdown[strat].pnl += e.pnl || 0;
  }

  // Lessons
  const lessons = [];
  if (completedExits.length > 0) {
    const winRate = wins / completedExits.length;
    if (winRate < 0.4) lessons.push("今日胜率偏低，需要反思选股和择时");
    if (winRate > 0.7) lessons.push("今日表现优秀，记录成功经验");
  }

  const fomoCount = todayEntries.filter((e) => e.emotionalState === "fomo").length;
  if (fomoCount > 0) lessons.push(`今日有 ${fomoCount} 笔FOMO交易，需要加强纪律性`);

  const dominantEmotion = Object.entries(emotionBreakdown).sort((a, b) => b[1] - a[1])[0];
  if (dominantEmotion && (dominantEmotion[0] === "anxious" || dominantEmotion[0] === "fearful")) {
    lessons.push("今日情绪偏负面，可能影响了决策质量");
  }

  const summary = {
    date: today,
    totalEntries: entries.length,
    totalExits: exits.length,
    completedTrades: completedExits.length,
    wins,
    losses,
    winRate: completedExits.length > 0 ? +(wins / completedExits.length).toFixed(4) : 0,
    totalPnl: +totalPnl.toFixed(2),
    emotionBreakdown,
    strategyBreakdown,
    lessons,
    trades: todayEntries,
  };

  const patterns = detectPatterns(data.entries);
  const stats = computeStats(data.entries);

  return { entry: summary, patterns, stats };
}

function queryEntries(input, data) {
  const q = (input.query || "").toLowerCase();
  if (!q) {
    return {
      entry: { message: "请提供查询关键词", results: [] },
      patterns: [],
      stats: computeStats(data.entries),
    };
  }

  const results = data.entries.filter((e) => {
    // Match by date
    if (e.date && e.date.includes(q)) return true;
    // Match by symbol
    if (e.symbol && e.symbol.toLowerCase().includes(q)) return true;
    // Match by strategy
    if (e.strategy && e.strategy.toLowerCase().includes(q)) return true;
    // Match by notes
    if (e.notes && e.notes.toLowerCase().includes(q)) return true;
    // Match by sentiment phase
    if (e.sentimentPhase && e.sentimentPhase.toLowerCase().includes(q)) return true;
    // Match by emotional state
    if (e.emotionalState && e.emotionalState.toLowerCase().includes(q)) return true;
    return false;
  });

  const patterns = detectPatterns(results.length > 5 ? results : data.entries);
  const stats = computeStats(data.entries);

  return {
    entry: { query: q, resultCount: results.length, results },
    patterns,
    stats,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const input = getInput();

  if (!input || !input.action) {
    const output = {
      error: "no_action",
      message:
        "请提供操作类型。支持的操作:\n" +
        "  - record_entry: 记录开仓\n" +
        "  - record_exit: 记录平仓\n" +
        "  - daily_summary: 每日总结\n" +
        "  - query: 查询历史记录",
    };
    console.log(JSON.stringify(output, null, 2));
    process.exit(0);
  }

  const data = loadData();
  let result;

  switch (input.action) {
    case "record_entry":
      result = recordEntry(input, data);
      break;
    case "record_exit":
      result = recordExit(input, data);
      break;
    case "daily_summary":
      result = dailySummary(input, data);
      break;
    case "query":
      result = queryEntries(input, data);
      break;
    default:
      result = {
        error: "unknown_action",
        message: `未知操作: ${input.action}。支持: record_entry, record_exit, daily_summary, query`,
      };
  }

  console.log(JSON.stringify(result, null, 2));
}

main();
