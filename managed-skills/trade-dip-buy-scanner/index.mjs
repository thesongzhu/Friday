#!/usr/bin/env node

/**
 * 低吸机会扫描器 (Dip-Buy Opportunity Scanner)
 *
 * Implements dip-buy scanning based on sentiment extremes, sector rotation, and leader divergence.
 *
 * Three dip-buy entry strategies:
 * 1. 情绪极值低吸 - When sentiment (通达信880005) < 500 = ice point, buy leader dips
 * 2. 板块轮动低吸 - Strong sector shows divergence/pullback, dip-buy the sector leader
 * 3. 龙头分歧低吸 - Confirmed leader shows intraday divergence but holds key support
 */

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

// Read input from stdin (Friday runtime pipes JSON via stdin to run.sh)
const _chunks = [];
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => _chunks.push(chunk));
await new Promise((resolve) => process.stdin.on('end', resolve));
const input = JSON.parse(_chunks.join('') || '{}');

const universe = input.universe || 'leaders';
const sector = input.sector || null;
const maxDrawdownPct = input.maxDrawdownPct ?? 10;
const marketData = input.marketData || null;
const sentimentPhase = input.sentimentPhase || null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple moving average over the last `period` closes. */
function sma(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/** Compute drawdown from recent high. */
function drawdownFromHigh(closes) {
  if (!closes.length) return 0;
  const high = Math.max(...closes);
  const current = closes[closes.length - 1];
  return ((high - current) / high) * 100;
}

/** Check if volume is contracting on the pullback (last 3 bars vs prior 5 bars avg). */
function isVolumeContracting(volumes) {
  if (volumes.length < 8) return { contracting: false, ratio: null };
  const recentAvg = volumes.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const priorAvg = volumes.slice(-8, -3).reduce((a, b) => a + b, 0) / 5;
  const ratio = priorAvg > 0 ? recentAvg / priorAvg : 1;
  return { contracting: ratio < 0.7, ratio: Math.round(ratio * 100) / 100 };
}

/** Determine key support levels for a stock. */
function computeSupportLevels(closes) {
  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, 20);

  // Find the most recent breakout level (highest close before the current pullback)
  let breakoutLevel = null;
  if (closes.length >= 5) {
    const recentHigh = Math.max(...closes.slice(-20));
    const idx = closes.lastIndexOf(recentHigh);
    // Look for consolidation base before the breakout
    if (idx > 3) {
      breakoutLevel = Math.min(...closes.slice(Math.max(0, idx - 5), idx));
    }
  }

  return {
    ma5: ma5 ? Math.round(ma5 * 100) / 100 : null,
    ma10: ma10 ? Math.round(ma10 * 100) / 100 : null,
    ma20: ma20 ? Math.round(ma20 * 100) / 100 : null,
    breakoutLevel: breakoutLevel ? Math.round(breakoutLevel * 100) / 100 : null,
  };
}

// ---------------------------------------------------------------------------
// Sentiment phase mapping
// ---------------------------------------------------------------------------

const SENTIMENT_SCORE = {
  '冰点': 100,   // ice point = best time for dip-buy
  '回暖': 70,    // warming = decent
  '高潮': 20,    // climax = risky for dip-buy
  '退潮': 10,    // ebb/decline = avoid dip-buy
};

function sentimentScore(phase) {
  if (!phase) return 50; // neutral if unknown
  return SENTIMENT_SCORE[phase] ?? 50;
}

// ---------------------------------------------------------------------------
// Scoring engine
// ---------------------------------------------------------------------------

/**
 * Score a candidate 0-100 based on how many dip-buy criteria match.
 *
 * Criteria & weights:
 *  - Is confirmed leader / in strong sector?    (25 pts)
 *  - Pulled back to support level?              (25 pts)
 *  - Volume contracting on pullback?            (20 pts)
 *  - Sentiment cycle supportive?                (15 pts)
 *  - Drawdown within acceptable range?          (15 pts)
 */
function scoreCandidate(stock) {
  let score = 0;
  const reasons = [];

  // 1. Leader / sector strength
  if (stock.isLeader) {
    score += 25;
    reasons.push('确认龙头 (confirmed leader)');
  } else if (stock.sectorStrength === 'strong') {
    score += 15;
    reasons.push('强势板块成员 (strong sector member)');
  }

  // 2. Support level test
  const current = stock.closes[stock.closes.length - 1];
  const support = computeSupportLevels(stock.closes);
  const nearSupport =
    (support.ma5 && Math.abs(current - support.ma5) / current < 0.02) ||
    (support.ma10 && Math.abs(current - support.ma10) / current < 0.02) ||
    (support.breakoutLevel && Math.abs(current - support.breakoutLevel) / current < 0.02);

  if (nearSupport) {
    score += 25;
    reasons.push('回踩支撑位 (pullback to support)');
  }

  // 3. Volume contraction
  const volAnalysis = isVolumeContracting(stock.volumes);
  if (volAnalysis.contracting) {
    score += 20;
    reasons.push(`缩量回调 (volume contraction ratio: ${volAnalysis.ratio})`);
  }

  // 4. Sentiment
  const sentScore = sentimentScore(sentimentPhase);
  if (sentScore >= 70) {
    score += 15;
    reasons.push(`情绪周期支持 (sentiment: ${sentimentPhase || 'neutral'})`);
  } else if (sentScore >= 40) {
    score += 8;
    reasons.push(`情绪中性 (sentiment: ${sentimentPhase || 'neutral'})`);
  }

  // 5. Drawdown check
  const dd = drawdownFromHigh(stock.closes);
  if (dd > 0 && dd <= maxDrawdownPct) {
    score += 15;
    reasons.push(`回撤合理 ${dd.toFixed(1)}% (drawdown within ${maxDrawdownPct}%)`);
  } else if (dd > maxDrawdownPct) {
    reasons.push(`回撤过大 ${dd.toFixed(1)}% (exceeds max ${maxDrawdownPct}%)`);
  }

  return { score: Math.min(score, 100), reasons, drawdownPct: Math.round(dd * 10) / 10 };
}

// ---------------------------------------------------------------------------
// Strategy classification
// ---------------------------------------------------------------------------

function classifyStrategy(stock, phase) {
  if (phase === '冰点' || sentimentScore(phase) >= 80) {
    return '情绪极值低吸';
  }
  if (stock.sectorDivergence) {
    return '板块轮动低吸';
  }
  if (stock.isLeader && stock.intradayDivergence) {
    return '龙头分歧低吸';
  }
  return '综合低吸';
}

// ---------------------------------------------------------------------------
// Mock data generator (when no marketData provided)
// ---------------------------------------------------------------------------

function generateMockStocks() {
  return [
    {
      symbol: '000001',
      name: '示例龙头A',
      isLeader: true,
      sectorStrength: 'strong',
      sectorDivergence: false,
      intradayDivergence: true,
      closes: [10.5, 10.8, 11.2, 11.5, 12.0, 12.3, 12.1, 11.9, 11.7, 11.5, 11.3, 11.4, 11.2, 11.3, 11.5, 11.4, 11.3, 11.2, 11.1, 11.2],
      volumes: [50000, 60000, 80000, 90000, 120000, 110000, 70000, 65000, 55000, 50000, 45000, 40000, 38000, 35000, 32000, 30000, 28000, 25000, 22000, 20000],
    },
    {
      symbol: '600001',
      name: '示例板块龙B',
      isLeader: false,
      sectorStrength: 'strong',
      sectorDivergence: true,
      intradayDivergence: false,
      closes: [8.0, 8.2, 8.5, 8.8, 9.0, 9.2, 9.5, 9.3, 9.1, 8.9, 8.7, 8.8, 8.6, 8.7, 8.9, 8.8, 8.7, 8.6, 8.5, 8.6],
      volumes: [30000, 35000, 40000, 55000, 60000, 58000, 50000, 42000, 38000, 35000, 32000, 30000, 28000, 25000, 23000, 20000, 18000, 16000, 15000, 14000],
    },
    {
      symbol: '300001',
      name: '示例弱势股C',
      isLeader: false,
      sectorStrength: 'weak',
      sectorDivergence: false,
      intradayDivergence: false,
      closes: [15.0, 14.8, 14.5, 14.0, 13.5, 13.0, 12.5, 12.0, 11.5, 11.0, 10.5, 10.0, 9.8, 9.5, 9.2, 9.0, 8.8, 8.5, 8.3, 8.0],
      volumes: [40000, 45000, 50000, 55000, 60000, 65000, 70000, 75000, 80000, 85000, 90000, 95000, 100000, 95000, 90000, 85000, 80000, 75000, 70000, 65000],
    },
  ];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // Get stock list
  let stocks;
  if (marketData && Array.isArray(marketData.stocks)) {
    stocks = marketData.stocks;
  } else {
    stocks = generateMockStocks();
  }

  // Filter by universe
  if (universe === 'leaders') {
    stocks = stocks.filter((s) => s.isLeader || s.sectorStrength === 'strong');
  } else if (universe === 'sector' && sector) {
    stocks = stocks.filter((s) => (s.sector || '').includes(sector));
  }
  // 'watchlist' uses all stocks

  // Score and rank
  const results = stocks.map((stock) => {
    const { score, reasons, drawdownPct } = scoreCandidate(stock);
    const support = computeSupportLevels(stock.closes);
    const volAnalysis = isVolumeContracting(stock.volumes);
    const strategy = classifyStrategy(stock, sentimentPhase);

    return {
      symbol: stock.symbol,
      name: stock.name,
      score,
      strategy,
      drawdownPct,
      reasons,
      support,
      volume: {
        contracting: volAnalysis.contracting,
        ratio: volAnalysis.ratio,
      },
    };
  });

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  // Build output
  const candidates = results.map((r) => ({
    symbol: r.symbol,
    name: r.name,
    score: r.score,
    strategy: r.strategy,
    drawdownPct: r.drawdownPct,
    reasons: r.reasons,
  }));

  const supportLevels = {};
  const volumeConfirmation = {};
  for (const r of results) {
    supportLevels[r.symbol] = r.support;
    volumeConfirmation[r.symbol] = r.volume;
  }

  const output = {
    candidates,
    supportLevels,
    volumeConfirmation,
  };

  console.log(JSON.stringify(output, null, 2));
}

main();
