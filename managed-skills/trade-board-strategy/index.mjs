#!/usr/bin/env node

/**
 * 打板策略分析器 — Board Strategy Analyzer
 *
 * Analyzes limit-up board trading opportunities across four strategies:
 *   1. 首板 (First Board)          — first limit-up entry
 *   2. 一进二 (Second Board)       — 1-to-2 continuation
 *   3. 弱转强 (Weak to Strong)     — reversal from weakness
 *   4. 反包 (Reversal Wrap)        — recovery after failed board/shadow
 */

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

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

const strategyType = input.strategyType || 'all';
const marketData = input.marketData || null;
const sentimentPhase = input.sentimentPhase || null;

// ---------------------------------------------------------------------------
// If no market data, output required format
// ---------------------------------------------------------------------------

if (!marketData || !marketData.stocks || marketData.stocks.length === 0) {
  const guidance = {
    setups: [],
    ranking: [],
    warnings: [],
    message: 'No market data provided. Supply marketData with the following structure.',
    requiredDataFormat: {
      stocks: [
        {
          code: 'string — stock code',
          name: 'string — stock name',
          sector: 'string — sector/theme',
          consecutiveLimitUps: 'number — 连板数',
          limitUpTime: 'string — HH:mm:ss seal time',
          sealStrength: 'number — 封单量/成交量 ratio',
          marketCap: 'number — total market cap in 亿',
          floatCap: 'number — float cap in 亿',
          overheadResistance: 'number 0-1 — 套牢盘 pressure (0=no resistance)',
          relativePosition: 'string — low|mid|high relative to 52-week range',
          themeStrength: 'number 0-1 — sector/theme persistence strength',
          volume: 'number — trading volume',
          turnover: 'number — trading value in yuan',
          auctionData: {
            openPrice: 'number',
            prevClose: 'number',
            gapPercent: 'number — open gap %',
            auctionVolume: 'number — 竞价成交量',
            buyOrderRatio: 'number 0-1 — 买盘/总挂单',
            first10sVolume: 'number — 开盘10秒成交量',
            first10sVolumeRatio: 'number — first10sVolume / yesterday total volume'
          },
          yesterdayData: {
            status: 'string — limit_up|failed_board|upper_shadow|weak_close|strong_close',
            limitUpTime: 'string — HH:mm:ss if limit up',
            closePriceVsHigh: 'number — close/high ratio',
            totalVolume: 'number',
            hasNegativeNews: 'boolean'
          },
          mediaScore: 'number 0-1 — popularity/recognition'
        }
      ],
      trendingThemes: ['string — active themes'],
      date: 'string — YYYY-MM-DD'
    }
  };
  console.log(JSON.stringify(guidance, null, 2));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Strategy implementations
// ---------------------------------------------------------------------------

const stocks = marketData.stocks;

/**
 * 1. 首板 (First Board) Strategy
 *
 * Conditions:
 * - 题材有持续性 (theme has persistence)
 * - 盘子小 7-8亿 (small float cap)
 * - 前期套牢盘小 (low overhead resistance)
 * - 相对低位 (relatively low price position)
 * Entry: Limit-up confirmation with strong seal (封单量 > 成交量 * 30%)
 * Exit: Next day profit target or stop-loss
 */
function analyzeFirstBoard(stocks) {
  const setups = [];
  const warnings = [];

  for (const stock of stocks) {
    if (stock.consecutiveLimitUps !== 1) continue;

    const conditions = {
      themePersistence: (stock.themeStrength || 0) >= 0.5,
      smallCap: (stock.floatCap || 100) <= 10,
      lowResistance: (stock.overheadResistance || 0.5) <= 0.3,
      lowPosition: stock.relativePosition === 'low' || stock.relativePosition === 'mid',
      strongSeal: (stock.sealStrength || 0) >= 0.3
    };

    const metCount = Object.values(conditions).filter(Boolean).length;
    if (metCount < 3) continue;

    const confidence = metCount / Object.keys(conditions).length;

    const setup = {
      strategy: 'first_board',
      strategyName: '首板',
      code: stock.code,
      name: stock.name,
      sector: stock.sector,
      confidence: Math.round(confidence * 100) / 100,
      conditions,
      entry: {
        type: 'limit_up_confirmation',
        description: '涨停确认后排单买入',
        sealStrength: stock.sealStrength || 'unknown',
        requirement: '封单量 > 成交量 * 30%'
      },
      exit: {
        profitTarget: '次日冲高5-8%卖出',
        stopLoss: '次日低开3%或破均价线止损',
        holdPeriod: '1-2 trading days'
      },
      riskReward: conditions.strongSeal && conditions.lowResistance ? 'favorable' : 'moderate'
    };

    setups.push(setup);

    // Warnings
    const stockWarnings = [];
    if (!conditions.themePersistence) stockWarnings.push('题材持续性不足, 可能一日游');
    if (!conditions.smallCap) stockWarnings.push('盘子偏大, 封板资金需求高');
    if (!conditions.lowResistance) stockWarnings.push('前期套牢盘重, 上方压力大');
    if (!conditions.strongSeal) stockWarnings.push('封单量不足, 炸板风险');
    if (stockWarnings.length > 0) {
      warnings.push({ code: stock.code, name: stock.name, strategy: 'first_board', items: stockWarnings });
    }
  }

  return { setups, warnings };
}

/**
 * 2. 一进二 (1-to-2 Board / Second Board) Strategy
 *
 * Conditions:
 * - 竞价抢筹明显 (auction shows buying pressure)
 * - 买盘 >> 卖盘 (buy orders dominate)
 * - 板块持续性 (sector persistence)
 * Entry: 竞价后排单 or 开盘确认
 * Higher risk, higher reward than first board
 */
function analyzeSecondBoard(stocks) {
  const setups = [];
  const warnings = [];

  for (const stock of stocks) {
    if (stock.consecutiveLimitUps !== 1) continue;
    const auction = stock.auctionData;
    const yesterday = stock.yesterdayData;
    if (!auction || !yesterday) continue;
    if (yesterday.status !== 'limit_up' && yesterday.status !== 'strong_close') continue;

    const conditions = {
      auctionBuying: (auction.buyOrderRatio || 0) >= 0.6,
      gapUp: (auction.gapPercent || 0) >= 1.0,
      sectorPersistence: (stock.themeStrength || 0) >= 0.5,
      yesterdayStrongSeal: yesterday.status === 'limit_up',
      volumeConfirmation: (auction.auctionVolume || 0) > 0
    };

    const metCount = Object.values(conditions).filter(Boolean).length;
    if (metCount < 3) continue;

    const confidence = metCount / Object.keys(conditions).length;

    const setup = {
      strategy: 'second_board',
      strategyName: '一进二',
      code: stock.code,
      name: stock.name,
      sector: stock.sector,
      confidence: Math.round(confidence * 100) / 100,
      conditions,
      entry: {
        type: 'auction_or_open',
        description: '竞价高开抢筹明显则竞价排单; 否则开盘确认强度后买入',
        auctionGap: `${auction.gapPercent || 0}%`,
        buyRatio: auction.buyOrderRatio || 'unknown'
      },
      exit: {
        profitTarget: '二板涨停卖出或次日冲高卖出',
        stopLoss: '开盘后回落至昨日收盘价止损',
        holdPeriod: '1 trading day'
      },
      riskReward: confidence >= 0.8 ? 'favorable' : 'aggressive'
    };

    setups.push(setup);

    const stockWarnings = [];
    if (!conditions.auctionBuying) stockWarnings.push('竞价买盘不足, 资金接力意愿弱');
    if (!conditions.gapUp) stockWarnings.push('低开或平开, 市场分歧大');
    if (!conditions.sectorPersistence) stockWarnings.push('板块持续性差, 独立走强难度大');
    if (auction.gapPercent > 5) stockWarnings.push('高开过高, 追高风险大');
    stockWarnings.push('一进二成功率低于首板, 仓位需控制');
    warnings.push({ code: stock.code, name: stock.name, strategy: 'second_board', items: stockWarnings });
  }

  return { setups, warnings };
}

/**
 * 3. 弱转强 (Weak to Strong Reversal) Strategy
 *
 * Conditions:
 * - 昨日弱势 (yesterday weak: divergence/pullback)
 * - 今日竞价强 (today auction strong: gap up)
 * - 量能爆发 (volume explosion)
 * Entry: 开盘10秒量能判断, 强于预期则买入
 * Key metric: 开盘10秒成交量 vs 昨日总量比
 */
function analyzeWeakToStrong(stocks) {
  const setups = [];
  const warnings = [];

  for (const stock of stocks) {
    const auction = stock.auctionData;
    const yesterday = stock.yesterdayData;
    if (!auction || !yesterday) continue;

    // Yesterday must have been weak
    const wasWeak = ['failed_board', 'upper_shadow', 'weak_close'].includes(yesterday.status);
    if (!wasWeak) continue;

    const conditions = {
      yesterdayWeak: true,
      todayGapUp: (auction.gapPercent || 0) >= 1.5,
      volumeExplosion: (auction.first10sVolumeRatio || 0) >= 0.03,
      hasRecognition: (stock.mediaScore || 0) >= 0.4,
      noNegativeNews: !(yesterday.hasNegativeNews)
    };

    const metCount = Object.values(conditions).filter(Boolean).length;
    if (metCount < 3) continue;

    const confidence = metCount / Object.keys(conditions).length;

    const setup = {
      strategy: 'weak_to_strong',
      strategyName: '弱转强',
      code: stock.code,
      name: stock.name,
      sector: stock.sector,
      confidence: Math.round(confidence * 100) / 100,
      conditions,
      entry: {
        type: 'open_volume_confirmation',
        description: '开盘10秒量能判断: 成交量爆发且强于预期则买入',
        first10sVolumeRatio: auction.first10sVolumeRatio || 'unknown',
        threshold: '开盘10秒成交量 >= 昨日总量 3%',
        gapPercent: `${auction.gapPercent || 0}%`
      },
      exit: {
        profitTarget: '涨停或日内冲高5%以上卖出',
        stopLoss: '回落至开盘价下方2%止损',
        holdPeriod: '1 trading day'
      },
      riskReward: conditions.volumeExplosion && conditions.todayGapUp ? 'favorable' : 'moderate'
    };

    setups.push(setup);

    const stockWarnings = [];
    if (!conditions.todayGapUp) stockWarnings.push('高开幅度不足, 弱转强信号弱');
    if (!conditions.volumeExplosion) stockWarnings.push('开盘量能不足, 资金参与度存疑');
    if (!conditions.hasRecognition) stockWarnings.push('市场辨识度低, 跟风资金可能不足');
    if (yesterday.hasNegativeNews) stockWarnings.push('存在利空消息, 反转逻辑可能失效');
    if (stockWarnings.length > 0) {
      warnings.push({ code: stock.code, name: stock.name, strategy: 'weak_to_strong', items: stockWarnings });
    }
  }

  return { setups, warnings };
}

/**
 * 4. 反包 (Reversal Wrap) Strategy
 *
 * Conditions:
 * - 前日上影线或炸板 (previous day upper shadow or failed board)
 * - 人气好有辨识度 (good popularity/recognition)
 * - 无利空 (no negative news)
 * Entry: 高开优选, 回落不破关键支撑
 * Select: 人气好的, 筹码承接强的
 */
function analyzeReversalWrap(stocks) {
  const setups = [];
  const warnings = [];

  for (const stock of stocks) {
    const auction = stock.auctionData;
    const yesterday = stock.yesterdayData;
    if (!auction || !yesterday) continue;

    // Previous day had upper shadow or failed board
    const hadFailure = ['failed_board', 'upper_shadow'].includes(yesterday.status);
    if (!hadFailure) continue;

    const conditions = {
      previousFailure: true,
      goodPopularity: (stock.mediaScore || 0) >= 0.5,
      noNegativeNews: !(yesterday.hasNegativeNews),
      gapUp: (auction.gapPercent || 0) >= 0.5,
      strongAcceptance: (yesterday.closePriceVsHigh || 0) >= 0.92
    };

    const metCount = Object.values(conditions).filter(Boolean).length;
    if (metCount < 3) continue;

    const confidence = metCount / Object.keys(conditions).length;

    const setup = {
      strategy: 'reversal_wrap',
      strategyName: '反包',
      code: stock.code,
      name: stock.name,
      sector: stock.sector,
      confidence: Math.round(confidence * 100) / 100,
      conditions,
      entry: {
        type: 'gap_up_with_support',
        description: '高开优选, 回落不破关键支撑位买入',
        gapPercent: `${auction.gapPercent || 0}%`,
        keySupport: '昨日收盘价或均价线'
      },
      exit: {
        profitTarget: '反包涨停或冲高至前日高点附近卖出',
        stopLoss: '跌破昨日最低价止损',
        holdPeriod: '1-2 trading days'
      },
      riskReward: conditions.goodPopularity && conditions.strongAcceptance ? 'favorable' : 'moderate'
    };

    setups.push(setup);

    const stockWarnings = [];
    if (!conditions.goodPopularity) stockWarnings.push('人气不足, 反包资金可能不够');
    if (yesterday.hasNegativeNews) stockWarnings.push('存在利空消息, 反包难度大');
    if (!conditions.gapUp) stockWarnings.push('未高开, 反包意愿不明确');
    if (!conditions.strongAcceptance) stockWarnings.push('昨日筹码承接弱, 抛压可能较大');
    if (stockWarnings.length > 0) {
      warnings.push({ code: stock.code, name: stock.name, strategy: 'reversal_wrap', items: stockWarnings });
    }
  }

  return { setups, warnings };
}

// ---------------------------------------------------------------------------
// Run selected strategies
// ---------------------------------------------------------------------------

const allSetups = [];
const allWarnings = [];

const strategies = {
  first_board: analyzeFirstBoard,
  second_board: analyzeSecondBoard,
  weak_to_strong: analyzeWeakToStrong,
  reversal_wrap: analyzeReversalWrap
};

if (strategyType === 'all') {
  for (const [key, fn] of Object.entries(strategies)) {
    const result = fn(stocks);
    allSetups.push(...result.setups);
    allWarnings.push(...result.warnings);
  }
} else if (strategies[strategyType]) {
  const result = strategies[strategyType](stocks);
  allSetups.push(...result.setups);
  allWarnings.push(...result.warnings);
} else {
  console.error(`Unknown strategy type: ${strategyType}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Ranking — sort by confidence, then by risk/reward
// ---------------------------------------------------------------------------

const riskRewardOrder = { favorable: 3, moderate: 2, aggressive: 1 };

const ranking = [...allSetups].sort((a, b) => {
  // Primary: confidence descending
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  // Secondary: risk/reward quality
  return (riskRewardOrder[b.riskReward] || 0) - (riskRewardOrder[a.riskReward] || 0);
}).map((setup, idx) => ({
  rank: idx + 1,
  code: setup.code,
  name: setup.name,
  strategy: setup.strategyName,
  confidence: setup.confidence,
  riskReward: setup.riskReward,
  sector: setup.sector
}));

// ---------------------------------------------------------------------------
// Sentiment phase risk adjustments
// ---------------------------------------------------------------------------

if (sentimentPhase) {
  const phaseRiskMap = {
    initiation: { adjustment: 'neutral', note: '启动期 — 首板策略优先, 试探性仓位' },
    expansion: { adjustment: 'favorable', note: '扩散期 — 所有策略可用, 可适当加仓' },
    divergence: { adjustment: 'cautious', note: '分歧期 — 弱转强和反包机会多, 但需严格止损' },
    decline: { adjustment: 'defensive', note: '退潮期 — 大幅降低仓位, 仅做最强辨识度股' },
    ice: { adjustment: 'avoid', note: '冰点期 — 建议空仓观望, 不参与打板' }
  };
  const phaseInfo = phaseRiskMap[sentimentPhase];
  if (phaseInfo) {
    allWarnings.push({
      code: 'PHASE',
      name: 'Market Phase Warning',
      strategy: 'all',
      items: [phaseInfo.note, `Risk adjustment: ${phaseInfo.adjustment}`]
    });
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const result = {
  setups: allSetups,
  ranking,
  warnings: allWarnings,
  meta: {
    strategyType,
    date: marketData.date || new Date().toISOString().slice(0, 10),
    stocksAnalyzed: stocks.length,
    setupsFound: allSetups.length,
    sentimentPhase: sentimentPhase || 'unknown',
    strategiesRun: strategyType === 'all'
      ? Object.keys(strategies)
      : [strategyType]
  }
};

console.log(JSON.stringify(result, null, 2));
