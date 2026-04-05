#!/usr/bin/env node

/**
 * 竞价分析器 (Auction Analyzer)
 *
 * Analyzes the 9:15-9:25 opening auction for sentiment and opportunity identification.
 *
 * Key analysis rules:
 * 1. 竞价抢筹判断 - Auction buying pressure assessment
 *    - 买盘 >> 卖盘 = strong buying intent
 *    - Auction volume > 3% of yesterday's total = 爆量竞价
 *
 * 2. 开盘10秒量能法则 - Opening 10-second volume rule
 *    - > 15% of yesterday's volume = 极度抢筹
 *    - 5-15% = normal
 *    - < 5% = weak
 *
 * 3. 竞价高开判断 - Auction gap assessment
 *    - Gap up + heavy volume = strong signal
 *    - Gap up > 5% = risk (容易死)
 *    - Flat open = observe
 *    - Gap down = weak
 *
 * 4. 一进二竞价优选 - First-board-to-second selection
 *    - Among yesterday's first-board stocks, pick strongest auction buying pressure
 *    - Queue orders after 9:25
 */

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

const input = JSON.parse(process.env.SKILL_INPUT || '{}');

const symbols = input.symbols || null;
const auctionData = input.auctionData || null;

// ---------------------------------------------------------------------------
// Analysis helpers
// ---------------------------------------------------------------------------

/**
 * Evaluate auction buying pressure.
 * Returns: { strength: 'strong'|'normal'|'weak', buyRatio, volumeRatio }
 */
function evaluateAuctionPressure(stock) {
  const buyVolume = stock.auctionBuyVolume || 0;
  const sellVolume = stock.auctionSellVolume || 0;
  const auctionVolume = stock.auctionVolume || 0;
  const yesterdayVolume = stock.yesterdayVolume || 1;

  const buyRatio = sellVolume > 0 ? buyVolume / sellVolume : buyVolume > 0 ? 99 : 1;
  const volumeRatio = (auctionVolume / yesterdayVolume) * 100;

  let strength = 'normal';
  if (buyRatio >= 3 && volumeRatio >= 3) {
    strength = 'strong';
  } else if (buyRatio >= 2 || volumeRatio >= 3) {
    strength = 'normal';
  } else {
    strength = 'weak';
  }

  return {
    strength,
    buyRatio: Math.round(buyRatio * 100) / 100,
    volumeRatioPct: Math.round(volumeRatio * 100) / 100,
    isExplosiveVolume: volumeRatio >= 3,
  };
}

/**
 * Evaluate the opening 10-second volume intensity.
 * Returns: { intensity: 'extreme'|'normal'|'weak', pctOfYesterday }
 */
function evaluateOpen10sVolume(stock) {
  const open10sVolume = stock.open10sVolume || 0;
  const yesterdayVolume = stock.yesterdayVolume || 1;

  const pct = (open10sVolume / yesterdayVolume) * 100;

  let intensity;
  if (pct >= 15) {
    intensity = 'extreme';  // 极度抢筹
  } else if (pct >= 5) {
    intensity = 'normal';
  } else {
    intensity = 'weak';     // 弱势
  }

  return {
    intensity,
    pctOfYesterday: Math.round(pct * 100) / 100,
  };
}

/**
 * Evaluate gap direction and risk.
 * Returns: { direction, gapPct, riskLevel, signal }
 */
function evaluateGap(stock) {
  const auctionPrice = stock.auctionPrice || 0;
  const yesterdayClose = stock.yesterdayClose || 0;

  if (!auctionPrice || !yesterdayClose) {
    return { direction: 'unknown', gapPct: 0, riskLevel: 'unknown', signal: 'observe' };
  }

  const gapPct = ((auctionPrice - yesterdayClose) / yesterdayClose) * 100;
  const roundedGap = Math.round(gapPct * 100) / 100;

  let direction;
  let riskLevel;
  let signal;

  if (gapPct > 5) {
    direction = 'gap_up_large';
    riskLevel = 'high';        // 高开太多容易死
    signal = 'caution';
  } else if (gapPct > 1) {
    direction = 'gap_up';
    riskLevel = 'low';
    signal = 'strong';         // 高开 + 量 = 强势信号
  } else if (gapPct > -0.5) {
    direction = 'flat';
    riskLevel = 'medium';
    signal = 'observe';        // 平开 = 观察
  } else {
    direction = 'gap_down';
    riskLevel = 'high';
    signal = 'weak';           // 低开 = 弱势
  }

  return { direction, gapPct: roundedGap, riskLevel, signal };
}

/**
 * Compute overall auction strength score (0-100).
 */
function computeAuctionScore(pressure, volume10s, gap, stock) {
  let score = 0;

  // Pressure component (max 30)
  if (pressure.strength === 'strong') score += 30;
  else if (pressure.strength === 'normal') score += 15;
  else score += 5;

  // Explosive volume bonus (max 15)
  if (pressure.isExplosiveVolume) score += 15;

  // 10-second volume (max 25)
  if (volume10s.intensity === 'extreme') score += 25;
  else if (volume10s.intensity === 'normal') score += 12;
  else score += 3;

  // Gap assessment (max 20)
  if (gap.signal === 'strong') score += 20;
  else if (gap.signal === 'observe') score += 10;
  else if (gap.signal === 'caution') score += 5;
  else score += 0;

  // First-board-to-second bonus (max 10)
  if (stock.isFirstBoard) score += 10;

  return Math.min(score, 100);
}

/**
 * Generate recommendation based on score and analysis.
 */
function generateRecommendation(score, gap, pressure) {
  if (score >= 75 && gap.signal !== 'caution') {
    return 'strong_buy';    // 强烈关注 - queue order at 9:25
  }
  if (score >= 50) {
    return 'monitor';       // 关注观察
  }
  return 'avoid';           // 回避
}

// ---------------------------------------------------------------------------
// Mock data generator (when no auctionData provided)
// ---------------------------------------------------------------------------

function generateMockStocks() {
  return [
    {
      symbol: '000001',
      name: '示例强势竞价A',
      yesterdayClose: 10.0,
      auctionPrice: 10.35,
      auctionVolume: 50000,
      auctionBuyVolume: 40000,
      auctionSellVolume: 10000,
      yesterdayVolume: 1000000,
      open10sVolume: 180000,
      isFirstBoard: true,
    },
    {
      symbol: '600001',
      name: '示例正常竞价B',
      yesterdayClose: 8.0,
      auctionPrice: 8.12,
      auctionVolume: 20000,
      auctionBuyVolume: 12000,
      auctionSellVolume: 8000,
      yesterdayVolume: 800000,
      open10sVolume: 50000,
      isFirstBoard: false,
    },
    {
      symbol: '300001',
      name: '示例弱势竞价C',
      yesterdayClose: 15.0,
      auctionPrice: 14.60,
      auctionVolume: 8000,
      auctionBuyVolume: 3000,
      auctionSellVolume: 5000,
      yesterdayVolume: 500000,
      open10sVolume: 15000,
      isFirstBoard: false,
    },
    {
      symbol: '002001',
      name: '示例高开风险D',
      yesterdayClose: 20.0,
      auctionPrice: 21.50,
      auctionVolume: 60000,
      auctionBuyVolume: 45000,
      auctionSellVolume: 15000,
      yesterdayVolume: 900000,
      open10sVolume: 160000,
      isFirstBoard: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // Get stock data
  let stocks;
  if (auctionData && Array.isArray(auctionData.stocks)) {
    stocks = auctionData.stocks;
  } else {
    stocks = generateMockStocks();
  }

  // Filter by symbols if specified
  if (symbols && Array.isArray(symbols) && symbols.length > 0) {
    stocks = stocks.filter((s) => symbols.includes(s.symbol));
  }

  // Analyze each stock
  const auctionSignals = stocks.map((stock) => {
    const pressure = evaluateAuctionPressure(stock);
    const volume10s = evaluateOpen10sVolume(stock);
    const gap = evaluateGap(stock);
    const score = computeAuctionScore(pressure, volume10s, gap, stock);
    const recommendation = generateRecommendation(score, gap, pressure);

    return {
      symbol: stock.symbol,
      name: stock.name,
      score,
      recommendation,
      auctionPrice: stock.auctionPrice,
      yesterdayClose: stock.yesterdayClose,
      gap: {
        direction: gap.direction,
        pct: gap.gapPct,
        riskLevel: gap.riskLevel,
      },
      pressure: {
        strength: pressure.strength,
        buyRatio: pressure.buyRatio,
        volumeRatioPct: pressure.volumeRatioPct,
        isExplosiveVolume: pressure.isExplosiveVolume,
      },
      volume10s: {
        intensity: volume10s.intensity,
        pctOfYesterday: volume10s.pctOfYesterday,
      },
      isFirstBoard: stock.isFirstBoard || false,
    };
  });

  // Sort by score descending
  auctionSignals.sort((a, b) => b.score - a.score);

  // Determine overall market sentiment
  const avgScore = auctionSignals.length > 0
    ? auctionSignals.reduce((sum, s) => sum + s.score, 0) / auctionSignals.length
    : 0;

  let marketOpenSentiment;
  if (avgScore >= 70) {
    marketOpenSentiment = '强势开盘 (Strong Open)';
  } else if (avgScore >= 50) {
    marketOpenSentiment = '正常偏强 (Normal-Bullish)';
  } else if (avgScore >= 30) {
    marketOpenSentiment = '正常偏弱 (Normal-Bearish)';
  } else {
    marketOpenSentiment = '弱势开盘 (Weak Open)';
  }

  // Identify gap plays
  const gapPlays = auctionSignals
    .filter((s) => s.gap.direction === 'gap_up' || s.gap.direction === 'gap_up_large')
    .map((s) => ({
      symbol: s.symbol,
      name: s.name,
      gapPct: s.gap.pct,
      riskLevel: s.gap.riskLevel,
      auctionScore: s.score,
      recommendation: s.recommendation,
      riskNote: s.gap.direction === 'gap_up_large'
        ? '高开幅度过大,追高风险大 (Gap too large, high chase risk)'
        : '合理高开,关注量能确认 (Reasonable gap, confirm with volume)',
    }));

  const output = {
    auctionSignals,
    marketOpenSentiment,
    gapPlays,
  };

  console.log(JSON.stringify(output, null, 2));
}

main();
