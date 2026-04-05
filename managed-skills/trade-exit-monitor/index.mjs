#!/usr/bin/env node

/**
 * 持仓退出监控 — Exit Monitor
 *
 * Monitors open positions and generates exit signals based on four
 * rule categories from the trading knowledge base:
 *
 *   1. 技术止损 (Technical Stop Loss)    — price/MA based, urgency HIGH
 *   2. 时间止损 (Time-Based Stop)        — holding period, urgency MEDIUM
 *   3. 情绪周期退出 (Sentiment Cycle Exit) — phase transition, urgency MEDIUM
 *   4. 龙头轮换退出 (Leader Rotation Exit) — leader change, urgency LOW
 *
 * Output: exitSignals (action required) + holdSignals (keep with rationale)
 */

import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

const input = (() => {
  const envInput = process.env.SKILL_INPUT;
  if (envInput) {
    try { return JSON.parse(envInput); } catch { /* fall through */ }
  }
  try {
    const data = readFileSync('/dev/stdin', 'utf8');
    if (data.trim()) return JSON.parse(data);
  } catch { /* fall through */ }
  return {};
})();

const urgencyMode = input.urgencyMode === true || input.urgencyMode === 'true';
const portfolio = input.portfolio || null;
const sentimentPhase = input.sentimentPhase || null;
const marketData = input.marketData || null;
const leaders = input.leaders || [];

// ---------------------------------------------------------------------------
// Validate input
// ---------------------------------------------------------------------------

const positions = portfolio?.positionBreakdown || portfolio?.positions || [];

if (positions.length === 0) {
  const guidance = {
    exitSignals: [],
    holdSignals: [],
    message: 'No positions to monitor. Provide portfolio data with positionBreakdown.',
    requiredInputFormat: {
      portfolio: {
        positionBreakdown: [
          {
            symbol: 'string — stock code',
            shares: 'number — shares held',
            avgPrice: 'number — average entry price',
            currentPrice: 'number — current market price',
            entryDate: 'string — YYYY-MM-DD',
            pnlPct: 'number — unrealized P&L %',
            holdingDays: 'number — days held',
            notes: 'string — optional'
          }
        ]
      },
      marketData: {
        prices: {
          'SYMBOL': {
            current: 'number',
            ma5: 'number — 5-day moving average',
            ma10: 'number — 10-day MA',
            ma20: 'number — 20-day MA',
            prevLow: 'number — previous session low'
          }
        }
      },
      leaders: '[ { code, name, tier, composite, ... } ]'
    }
  };
  console.log(JSON.stringify(guidance, null, 2));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Helper: days between dates
// ---------------------------------------------------------------------------

function daysBetween(dateStr1, dateStr2) {
  const d1 = new Date(dateStr1);
  const d2 = new Date(dateStr2 || new Date().toISOString().slice(0, 10));
  return Math.max(0, Math.round((d2 - d1) / (1000 * 60 * 60 * 24)));
}

// ---------------------------------------------------------------------------
// Rule 1: 技术止损 (Technical Stop Loss) — urgency HIGH
// ---------------------------------------------------------------------------

function checkTechnicalStop(pos, mktPrices) {
  const signals = [];
  const sym = pos.symbol;
  const entryPrice = pos.avgPrice;
  const currentPrice = pos.currentPrice;
  const pnlPct = entryPrice > 0
    ? ((currentPrice - entryPrice) / entryPrice) * 100
    : 0;

  // Fixed percentage stop: -5% from entry
  if (pnlPct <= -5) {
    signals.push({
      symbol: sym,
      urgency: 'high',
      reason: `技术止损: 亏损已达 ${Math.round(pnlPct * 100) / 100}%，超过 -5% 止损线`,
      suggestedAction: 'exit_now',
      referencedRule: 'technical_stop_fixed_pct',
      details: { entryPrice, currentPrice, pnlPct: Math.round(pnlPct * 100) / 100 }
    });
  }

  // Break below MA5 (if market data available)
  if (mktPrices) {
    const priceData = mktPrices[sym];
    if (priceData && priceData.ma5 && currentPrice < priceData.ma5) {
      signals.push({
        symbol: sym,
        urgency: 'high',
        reason: `技术止损: 股价 ${currentPrice} 跌破 MA5 (${priceData.ma5})`,
        suggestedAction: 'exit_now',
        referencedRule: 'technical_stop_ma5_break',
        details: { currentPrice, ma5: priceData.ma5 }
      });
    }

    // Break below previous day low
    if (priceData && priceData.prevLow && currentPrice < priceData.prevLow) {
      signals.push({
        symbol: sym,
        urgency: 'high',
        reason: `技术止损: 股价 ${currentPrice} 跌破前日低点 (${priceData.prevLow})`,
        suggestedAction: 'exit_now',
        referencedRule: 'technical_stop_prev_low_break',
        details: { currentPrice, prevLow: priceData.prevLow }
      });
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Rule 2: 时间止损 (Time-Based Stop) — urgency MEDIUM
// ---------------------------------------------------------------------------

function checkTimeStop(pos) {
  const signals = [];
  const sym = pos.symbol;
  const holdingDays = pos.holdingDays != null
    ? pos.holdingDays
    : daysBetween(pos.entryDate, new Date().toISOString().slice(0, 10));

  const entryPrice = pos.avgPrice;
  const currentPrice = pos.currentPrice;
  const pnlPct = entryPrice > 0
    ? ((currentPrice - entryPrice) / entryPrice) * 100
    : 0;
  const isProfitable = pnlPct > 0;

  // If not profitable by day 3, consider exit
  if (holdingDays >= 3 && !isProfitable) {
    signals.push({
      symbol: sym,
      urgency: 'medium',
      reason: `时间止损: 持仓 ${holdingDays} 天仍未盈利 (${Math.round(pnlPct * 100) / 100}%)，建议考虑退出`,
      suggestedAction: 'reduce_50pct',
      referencedRule: 'time_stop_day3_unprofitable',
      details: { holdingDays, pnlPct: Math.round(pnlPct * 100) / 100 }
    });
  }

  // If underwater for 5+ days, mandatory review
  if (holdingDays >= 5 && !isProfitable) {
    signals.push({
      symbol: sym,
      urgency: 'medium',
      reason: `时间止损: 持仓 ${holdingDays} 天且持续亏损 (${Math.round(pnlPct * 100) / 100}%)，强制复盘，建议清仓`,
      suggestedAction: 'exit_now',
      referencedRule: 'time_stop_day5_mandatory_review',
      details: { holdingDays, pnlPct: Math.round(pnlPct * 100) / 100 }
    });
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Rule 3: 情绪周期退出 (Sentiment Cycle Exit) — urgency MEDIUM
// ---------------------------------------------------------------------------

function checkSentimentExit(pos, phase) {
  if (!phase) return [];

  const signals = [];
  const sym = pos.symbol;

  // If phase transitions to 退潮 (decline), reduce all positions
  if (phase === 'decline') {
    signals.push({
      symbol: sym,
      urgency: 'medium',
      reason: `情绪周期退出: 当前处于退潮期，建议减仓所有持仓`,
      suggestedAction: 'reduce_50pct',
      referencedRule: 'sentiment_exit_decline_phase',
      details: { phase, note: '退潮期应逐步减仓，保留强势龙头小仓观察' }
    });
  }

  // If phase is ice, exit everything
  if (phase === 'ice') {
    signals.push({
      symbol: sym,
      urgency: 'medium',
      reason: `情绪周期退出: 当前处于冰点期，建议清仓观望`,
      suggestedAction: 'exit_now',
      referencedRule: 'sentiment_exit_ice_phase',
      details: { phase, note: '冰点期资金应保持空仓等待新周期' }
    });
  }

  // If phase is 分歧 (divergence), reduce non-leader positions
  if (phase === 'divergence') {
    // This will be refined in combination with leader check
    signals.push({
      symbol: sym,
      urgency: 'medium',
      reason: `情绪周期退出: 当前处于分歧期，非龙头股建议减仓`,
      suggestedAction: 'reduce_50pct',
      referencedRule: 'sentiment_exit_divergence_non_leader',
      details: { phase, note: '分歧期仅持有核心龙头，其余减仓' }
    });
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Rule 4: 龙头轮换退出 (Leader Rotation Exit) — urgency LOW
// ---------------------------------------------------------------------------

function checkLeaderRotation(pos, leaders) {
  if (!leaders || leaders.length === 0) return [];

  const signals = [];
  const sym = pos.symbol;

  // Check if this stock is in the current leader list
  const leaderEntry = leaders.find(l => l.code === sym || l.symbol === sym);
  const topLeader = leaders[0];

  if (leaderEntry) {
    // Stock is a leader, but check if it's fading
    if (leaderEntry.tier === '跟风股' || leaderEntry.tier === '观察') {
      signals.push({
        symbol: sym,
        urgency: 'low',
        reason: `龙头轮换退出: ${sym} 已从龙头降级为 ${leaderEntry.tier}，考虑退出`,
        suggestedAction: 'set_trailing_stop',
        referencedRule: 'leader_rotation_demotion',
        details: { currentTier: leaderEntry.tier, composite: leaderEntry.composite }
      });
    }
  } else {
    // Stock is not in leader list at all — might have been replaced
    if (pos.notes && pos.notes.includes('龙头') || pos.side === 'leader_follow') {
      signals.push({
        symbol: sym,
        urgency: 'low',
        reason: `龙头轮换退出: ${sym} 不在当前龙头名单中，新龙头可能是 ${topLeader?.name || 'unknown'}`,
        suggestedAction: 'reduce_50pct',
        referencedRule: 'leader_rotation_not_in_list',
        details: { newLeader: topLeader?.code, newLeaderName: topLeader?.name }
      });
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Deduplicate exit signals (keep highest urgency per symbol)
// ---------------------------------------------------------------------------

const URGENCY_RANK = { high: 3, medium: 2, low: 1 };

function deduplicateExitSignals(signals) {
  const bySymbolRule = {};
  for (const sig of signals) {
    const key = `${sig.symbol}:${sig.referencedRule}`;
    const existing = bySymbolRule[key];
    if (!existing || URGENCY_RANK[sig.urgency] > URGENCY_RANK[existing.urgency]) {
      bySymbolRule[key] = sig;
    }
  }
  return Object.values(bySymbolRule).sort((a, b) =>
    URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency]
  );
}

// ---------------------------------------------------------------------------
// Generate hold signals for positions with no exit triggers
// ---------------------------------------------------------------------------

function generateHoldSignals(positions, exitSymbols, phase, leaders) {
  return positions
    .filter(pos => !exitSymbols.has(pos.symbol))
    .map(pos => {
      const entryPrice = pos.avgPrice;
      const currentPrice = pos.currentPrice;
      const pnlPct = entryPrice > 0
        ? Math.round(((currentPrice - entryPrice) / entryPrice) * 10000) / 100
        : 0;
      const holdingDays = pos.holdingDays != null
        ? pos.holdingDays
        : daysBetween(pos.entryDate, new Date().toISOString().slice(0, 10));

      const leaderEntry = leaders.find(l => l.code === pos.symbol);
      const isLeader = leaderEntry && (leaderEntry.tier === '核心龙头' || leaderEntry.tier === '备选龙头');

      let rationale = '';
      if (isLeader) {
        rationale = `龙头股持仓 (${leaderEntry.tier})，趋势良好继续持有`;
      } else if (pnlPct > 5) {
        rationale = `盈利 ${pnlPct}%，设置移动止盈保护利润`;
      } else if (pnlPct > 0) {
        rationale = `小幅盈利 ${pnlPct}%，持有观察，注意止损位`;
      } else {
        rationale = `暂无触发退出条件，继续持有观察`;
      }

      return {
        symbol: pos.symbol,
        shares: pos.shares,
        pnlPct,
        holdingDays,
        isLeader,
        rationale,
        suggestedAction: pnlPct > 5 ? 'set_trailing_stop' : 'hold'
      };
    });
}

// ---------------------------------------------------------------------------
// Main execution
// ---------------------------------------------------------------------------

const mktPrices = marketData?.prices || null;
let allExitSignals = [];

for (const pos of positions) {
  // Rule 1: Technical stop (always check, urgency HIGH)
  allExitSignals.push(...checkTechnicalStop(pos, mktPrices));

  if (!urgencyMode) {
    // Rule 2: Time stop (urgency MEDIUM)
    allExitSignals.push(...checkTimeStop(pos));

    // Rule 3: Sentiment cycle exit (urgency MEDIUM)
    allExitSignals.push(...checkSentimentExit(pos, sentimentPhase));

    // Rule 4: Leader rotation exit (urgency LOW)
    allExitSignals.push(...checkLeaderRotation(pos, leaders));
  }
}

// In urgency mode, filter to HIGH only
if (urgencyMode) {
  allExitSignals = allExitSignals.filter(s => s.urgency === 'high');
}

// Deduplicate
const exitSignals = deduplicateExitSignals(allExitSignals);

// Symbols with exit signals
const exitSymbols = new Set(exitSignals.map(s => s.symbol));

// Hold signals for remaining positions
const holdSignals = generateHoldSignals(positions, exitSymbols, sentimentPhase, leaders);

// In divergence phase, refine: if stock IS a leader, downgrade the divergence exit signal
if (sentimentPhase === 'divergence') {
  for (const sig of exitSignals) {
    if (sig.referencedRule === 'sentiment_exit_divergence_non_leader') {
      const leaderEntry = leaders.find(l => l.code === sig.symbol);
      if (leaderEntry && (leaderEntry.tier === '核心龙头' || leaderEntry.tier === '备选龙头')) {
        sig.urgency = 'low';
        sig.suggestedAction = 'hold';
        sig.reason += ' (但该股为当前龙头，可继续持有)';
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const result = {
  exitSignals,
  holdSignals,
  meta: {
    positionsChecked: positions.length,
    exitSignalCount: exitSignals.length,
    holdSignalCount: holdSignals.length,
    urgencyMode,
    sentimentPhase: sentimentPhase || 'unknown',
    leaderCount: leaders.length,
    hasMarketData: mktPrices !== null,
    date: new Date().toISOString().slice(0, 10)
  }
};

console.log(JSON.stringify(result, null, 2));
