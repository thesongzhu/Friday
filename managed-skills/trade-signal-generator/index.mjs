#!/usr/bin/env node

/**
 * 交易信号生成器 — Trade Signal Generator
 *
 * The integrator skill that synthesizes outputs from all L2 analysis skills
 * into concrete, ranked entry/exit signals.
 *
 * Pipeline:
 *   1. Collect outputs from leader scanner, board strategy, dip buy, auction
 *   2. Filter by user's preferredStyles (only enabled strategies)
 *   3. Cross-validate (stocks in multiple strategies get higher confidence)
 *   4. Apply sentiment phase filter (no aggressive signals during 退潮)
 *   5. Calculate position sizing from user's capitalSize & maxPositionPct
 *   6. Deduplicate (same stock from different strategies merged)
 *   7. Add knowledgeBaseRefs for traceability
 *   8. Rank by confidence * risk_reward_ratio
 */

import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

const input = JSON.parse(readFileSync(0, 'utf-8').trim() || '{}');

const mode = input.mode || 'full_scan';
const symbol = input.symbol || null;
const sentimentPhase = input.sentimentPhase || null;
const leaders = input.leaders || [];
const boardSetups = input.boardSetups || [];
const dipBuyCandidates = input.dipBuyCandidates || [];
const auctionSignals = input.auctionSignals || [];
const portfolio = input.portfolio || null;
const userProfile = input.userProfile || {
  capitalSize: 1000000,
  maxPositionPct: 25,
  preferredStyles: ['leader_follow', 'board_strategy', 'dip_buy', 'auction'],
  riskTolerance: 'moderate' // conservative, moderate, aggressive
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STRATEGY_KEYS = {
  LEADER: 'leader_follow',
  BOARD: 'board_strategy',
  DIP_BUY: 'dip_buy',
  AUCTION: 'auction'
};

const PHASE_AGGRESSION = {
  initiation: 0.7,    // Moderate — new cycle, early movers
  expansion: 1.0,     // Full aggression — confirmed cycle
  divergence: 0.5,    // Reduced — only high-confidence
  decline: 0.2,       // Minimal — mostly avoid
  ice: 0.1            // Near-zero — capital preservation
};

const RISK_TOLERANCE_MULTIPLIER = {
  conservative: 0.6,
  moderate: 1.0,
  aggressive: 1.4
};

// ---------------------------------------------------------------------------
// Step 1: Extract raw signal candidates from each source
// ---------------------------------------------------------------------------

function extractLeaderSignals(leaders) {
  return leaders
    .filter(l => l.composite >= 0.5 || l.tier === '核心龙头' || l.tier === '备选龙头')
    .map(l => ({
      symbol: l.code,
      name: l.name,
      direction: 'long',
      strategy: STRATEGY_KEYS.LEADER,
      baseConfidence: l.composite || 0.7,
      entryZone: { note: 'Buy on dip or opening confirmation' },
      stopLoss: { pct: -5, note: 'Break below MA5 or previous day low' },
      targetPrice: { note: 'Hold until leader rotation signal' },
      reasoning: `龙头股评分 ${l.composite}, 连板 ${l.consecutiveLimitUps}, 级别 ${l.tier}`,
      knowledgeBaseRefs: ['leader-scoring-model', 'position-rule', 'timing-rule'],
      meta: { consecutiveLimitUps: l.consecutiveLimitUps, tier: l.tier, sector: l.sector }
    }));
}

function extractBoardSignals(setups) {
  return setups.map(s => ({
    symbol: s.code || s.symbol,
    name: s.name || s.symbol,
    direction: 'long',
    strategy: STRATEGY_KEYS.BOARD,
    baseConfidence: s.score || s.confidence || 0.6,
    entryZone: s.entryZone || { note: 'Limit-up board entry' },
    stopLoss: s.stopLoss || { pct: -5, note: 'Break of board pattern' },
    targetPrice: s.target || { note: 'Next resistance level' },
    reasoning: s.reasoning || `连板策略信号: ${s.pattern || 'board setup'}`,
    knowledgeBaseRefs: ['board-strategy-model', 'consecutive-board-rules'],
    meta: { pattern: s.pattern, boards: s.boards }
  }));
}

function extractDipBuySignals(candidates) {
  return candidates.map(c => ({
    symbol: c.code || c.symbol,
    name: c.name || c.symbol,
    direction: 'long',
    strategy: STRATEGY_KEYS.DIP_BUY,
    baseConfidence: c.score || c.confidence || 0.55,
    entryZone: c.entryZone || { note: 'Support level dip buy' },
    stopLoss: c.stopLoss || { pct: -3, note: 'Break below support' },
    targetPrice: c.target || { note: 'Bounce to MA20 or previous high' },
    reasoning: c.reasoning || `低吸信号: ${c.pattern || 'dip buy setup'}`,
    knowledgeBaseRefs: ['dip-buy-model', 'support-analysis'],
    meta: { dipPct: c.dipPct, supportLevel: c.supportLevel }
  }));
}

function extractAuctionSignals(signals) {
  return signals.map(a => ({
    symbol: a.code || a.symbol,
    name: a.name || a.symbol,
    direction: a.direction || 'long',
    strategy: STRATEGY_KEYS.AUCTION,
    baseConfidence: a.score || a.confidence || 0.5,
    entryZone: a.entryZone || { note: 'Auction-derived entry' },
    stopLoss: a.stopLoss || { pct: -4, note: 'Auction signal invalidation' },
    targetPrice: a.target || { note: 'Intraday momentum target' },
    reasoning: a.reasoning || `竞价信号: ${a.pattern || 'auction anomaly'}`,
    knowledgeBaseRefs: ['auction-analysis-model', 'pre-market-rules'],
    meta: { auctionVolume: a.auctionVolume, auctionPrice: a.auctionPrice }
  }));
}

// ---------------------------------------------------------------------------
// Step 2: Filter by user's preferred styles
// ---------------------------------------------------------------------------

function filterByPreferredStyles(allSignals, preferredStyles) {
  return allSignals.filter(s => preferredStyles.includes(s.strategy));
}

// ---------------------------------------------------------------------------
// Step 3: Cross-validate — stocks in multiple strategies get confidence boost
// ---------------------------------------------------------------------------

function crossValidate(signals) {
  const bySymbol = {};
  for (const sig of signals) {
    if (!bySymbol[sig.symbol]) {
      bySymbol[sig.symbol] = [];
    }
    bySymbol[sig.symbol].push(sig);
  }

  const crossValidated = [];
  for (const [sym, sigs] of Object.entries(bySymbol)) {
    if (sigs.length === 1) {
      crossValidated.push({ ...sigs[0], crossValidationBoost: 0, strategySources: [sigs[0].strategy] });
    } else {
      // Multiple strategies point to same stock — boost confidence
      const boost = Math.min(sigs.length * 0.1, 0.3); // up to +0.3
      const bestSig = sigs.reduce((best, s) => s.baseConfidence > best.baseConfidence ? s : best);
      const allStrategies = [...new Set(sigs.map(s => s.strategy))];
      const allRefs = [...new Set(sigs.flatMap(s => s.knowledgeBaseRefs))];
      const allReasons = sigs.map(s => s.reasoning);

      crossValidated.push({
        ...bestSig,
        crossValidationBoost: boost,
        strategySources: allStrategies,
        knowledgeBaseRefs: allRefs,
        reasoning: allReasons.join(' | '),
        meta: { ...bestSig.meta, additionalStrategies: allStrategies.length }
      });
    }
  }

  return crossValidated;
}

// ---------------------------------------------------------------------------
// Step 4: Apply sentiment phase filter
// ---------------------------------------------------------------------------

function applyPhaseFilter(signals, phase) {
  if (!phase) return { filtered: signals, warnings: [] };

  const aggression = PHASE_AGGRESSION[phase] ?? 0.5;
  const warnings = [];

  if (aggression <= 0.2) {
    warnings.push({
      level: 'high',
      message: `当前处于${phase === 'decline' ? '退潮期' : '冰点期'}，建议极度谨慎，减少新开仓`
    });
  }

  // Filter: only keep signals whose confidence * aggression >= threshold
  const threshold = 0.3;
  const filtered = signals
    .map(s => ({
      ...s,
      adjustedConfidence: Math.min(
        (s.baseConfidence + (s.crossValidationBoost || 0)) * aggression,
        1.0
      )
    }))
    .filter(s => s.adjustedConfidence >= threshold);

  if (phase === 'decline' || phase === 'ice') {
    warnings.push({
      level: 'medium',
      message: `${signals.length - filtered.length} signals filtered out due to ${phase} phase`
    });
  }

  return { filtered, warnings };
}

// ---------------------------------------------------------------------------
// Step 5: Calculate position sizing
// ---------------------------------------------------------------------------

function calculatePositionSizing(signals, userProfile, portfolio) {
  const capital = userProfile.capitalSize || 1000000;
  const maxPosPct = (userProfile.maxPositionPct || 25) / 100;
  const riskMult = RISK_TOLERANCE_MULTIPLIER[userProfile.riskTolerance] || 1.0;
  const maxPosValue = capital * maxPosPct * riskMult;

  // Check current exposure from portfolio
  const currentExposure = portfolio
    ? (portfolio.positionBreakdown || []).reduce((sum, p) => sum + (p.marketValue || 0), 0)
    : 0;
  const availableCapital = capital - currentExposure;
  const alreadyHeld = portfolio
    ? new Set((portfolio.positionBreakdown || []).map(p => p.symbol))
    : new Set();

  return signals.map(sig => {
    const isHeld = alreadyHeld.has(sig.symbol);
    const suggestedValue = Math.min(maxPosValue, availableCapital * 0.5); // Never more than 50% of remaining
    const confidenceAdjustedValue = suggestedValue * (sig.adjustedConfidence || sig.baseConfidence);

    return {
      ...sig,
      positionSizeSuggestion: {
        maxValue: Math.round(confidenceAdjustedValue),
        pctOfCapital: Math.round((confidenceAdjustedValue / capital) * 10000) / 100,
        note: isHeld ? 'Already holding — consider adding or skipping' : 'New position'
      },
      alreadyHeld: isHeld
    };
  });
}

// ---------------------------------------------------------------------------
// Step 6: Deduplicate (already handled in cross-validate)
// Step 7: knowledgeBaseRefs (already attached in extraction)
// Step 8: Rank by confidence * risk_reward_ratio
// ---------------------------------------------------------------------------

function estimateRiskReward(sig) {
  const stopPct = Math.abs(sig.stopLoss?.pct || -5);
  // Estimate target as 2x stop by default
  const targetPct = sig.targetPrice?.pct || stopPct * 2;
  return targetPct / stopPct;
}

function rankSignals(signals) {
  return signals
    .map(sig => {
      const confidence = sig.adjustedConfidence || sig.baseConfidence || 0.5;
      const rrr = estimateRiskReward(sig);
      const rankScore = Math.round(confidence * rrr * 1000) / 1000;

      return {
        ...sig,
        confidence: Math.round(confidence * 1000) / 1000,
        riskRewardRatio: Math.round(rrr * 100) / 100,
        rankScore
      };
    })
    .sort((a, b) => b.rankScore - a.rankScore);
}

// ---------------------------------------------------------------------------
// Filter by mode
// ---------------------------------------------------------------------------

function filterByMode(signals, mode, symbol) {
  if (mode === 'specific_stock' && symbol) {
    return signals.filter(s => s.symbol === symbol);
  }
  // watchlist_only would require a watchlist input — pass through for now
  return signals;
}

// ---------------------------------------------------------------------------
// Risk warnings
// ---------------------------------------------------------------------------

function generateRiskWarnings(signals, phase, portfolio) {
  const warnings = [];

  if (signals.length === 0) {
    warnings.push({
      level: 'info',
      message: 'No actionable signals found. Consider waiting for better setups.'
    });
  }

  if (signals.length > 5) {
    warnings.push({
      level: 'medium',
      message: `${signals.length} signals generated. Avoid over-trading — focus on top 3 highest-ranked.`
    });
  }

  // Check for concentration risk
  const sectors = {};
  for (const s of signals) {
    const sec = s.meta?.sector || 'unknown';
    sectors[sec] = (sectors[sec] || 0) + 1;
  }
  for (const [sec, count] of Object.entries(sectors)) {
    if (count >= 3) {
      warnings.push({
        level: 'medium',
        message: `${count} signals in ${sec} sector — concentration risk, consider diversifying.`
      });
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Main execution
// ---------------------------------------------------------------------------

// Check if any data was provided
const hasData = leaders.length > 0 || boardSetups.length > 0 ||
                dipBuyCandidates.length > 0 || auctionSignals.length > 0;

if (!hasData) {
  const guidance = {
    signals: [],
    marketContext: {
      sentimentPhase: sentimentPhase || 'unknown',
      note: 'No strategy outputs provided.'
    },
    riskWarnings: [{
      level: 'info',
      message: 'No input data. Provide outputs from leader scanner, board strategy, dip buy scanner, or auction analyzer.'
    }],
    requiredInputFormat: {
      leaders: '[ { code, name, composite, consecutiveLimitUps, tier, sector, ... } ]',
      boardSetups: '[ { code/symbol, name, score, pattern, entryZone, stopLoss, ... } ]',
      dipBuyCandidates: '[ { code/symbol, name, score, dipPct, supportLevel, entryZone, ... } ]',
      auctionSignals: '[ { code/symbol, name, score, auctionVolume, auctionPrice, direction, ... } ]',
      userProfile: '{ capitalSize: 1000000, maxPositionPct: 25, preferredStyles: [...], riskTolerance: "moderate" }'
    }
  };
  console.log(JSON.stringify(guidance, null, 2));
  process.exit(0);
}

// Pipeline
let allSignals = [
  ...extractLeaderSignals(leaders),
  ...extractBoardSignals(boardSetups),
  ...extractDipBuySignals(dipBuyCandidates),
  ...extractAuctionSignals(auctionSignals)
];

// Step 2: Filter by preferred styles
allSignals = filterByPreferredStyles(allSignals, userProfile.preferredStyles);

// Step 3: Cross-validate
allSignals = crossValidate(allSignals);

// Step 4: Sentiment phase filter
const { filtered: phaseFiltered, warnings: phaseWarnings } = applyPhaseFilter(allSignals, sentimentPhase);
allSignals = phaseFiltered;

// Step 5: Position sizing
allSignals = calculatePositionSizing(allSignals, userProfile, portfolio);

// Step 8: Rank
allSignals = rankSignals(allSignals);

// Filter by mode
allSignals = filterByMode(allSignals, mode, symbol);

// Risk warnings
const riskWarnings = [
  ...phaseWarnings,
  ...generateRiskWarnings(allSignals, sentimentPhase, portfolio)
];

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const result = {
  signals: allSignals,
  marketContext: {
    sentimentPhase: sentimentPhase || 'unknown',
    phaseAggression: PHASE_AGGRESSION[sentimentPhase] ?? 'N/A',
    totalCandidatesProcessed: leaders.length + boardSetups.length + dipBuyCandidates.length + auctionSignals.length,
    signalsGenerated: allSignals.length,
    mode,
    date: new Date().toISOString().slice(0, 10)
  },
  riskWarnings
};

console.log(JSON.stringify(result, null, 2));
