#!/usr/bin/env node

/**
 * 龙头股扫描器 — Leader Stock Scanner
 *
 * Identifies current market leader stocks (人气龙头) by scoring candidates
 * on five criteria from the trading knowledge base:
 *   1. 身位规则 (Position Rule)      — consecutive limit-up count
 *   2. 时间规则 (Time Rule)          — earlier limit-up time wins
 *   3. 内核规则 (Core Logic Rule)    — business alignment with theme
 *   4. 抗揍度  (Resilience)          — survives divergence periods
 *   5. 人气度  (Popularity)          — volume, value, media attention
 */

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf-8').trim() || '{}');

const scope = input.scope || 'market_wide';
const sector = input.sector || null;
const marketData = input.marketData || null;
const sentimentPhase = input.sentimentPhase || null;

// ---------------------------------------------------------------------------
// If no market data provided, output guidance on what data is needed
// ---------------------------------------------------------------------------

if (!marketData || !marketData.stocks || marketData.stocks.length === 0) {
  const guidance = {
    leaders: [],
    leaderHistory: [],
    rotationSignal: 'unclear',
    message: 'No market data provided. To use this skill, supply marketData with the following structure.',
    requiredDataFormat: {
      stocks: [
        {
          code: 'string — stock code e.g. 000001',
          name: 'string — stock name e.g. 平安银行',
          sector: 'string — sector/theme e.g. AI, 机器人',
          consecutiveLimitUps: 'number — 连板数, e.g. 3 means 3板',
          limitUpTime: 'string — HH:mm:ss of limit-up seal, e.g. 09:35:22',
          themeAlignment: 'number 0-1 — how well the stock core business aligns with the trending theme',
          divergenceSurvivals: 'number — how many divergence sessions the stock survived without breaking',
          volume: 'number — trading volume in shares',
          turnover: 'number — trading value in yuan',
          mediaScore: 'number 0-1 — normalized media/social attention score',
          sealStrength: 'number — 封单量/成交量 ratio',
          history: 'array (optional) — past session snapshots [{date, consecutiveLimitUps, status}]'
        }
      ],
      trendingThemes: ['string — current hot themes/sectors'],
      date: 'string — trading date YYYY-MM-DD'
    }
  };
  console.log(JSON.stringify(guidance, null, 2));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Scoring weights
// ---------------------------------------------------------------------------

const WEIGHTS = {
  position: 0.30,    // 身位规则
  timing: 0.15,      // 时间规则
  coreLogic: 0.20,   // 内核规则
  resilience: 0.20,  // 抗揍度
  popularity: 0.15   // 人气度
};

// ---------------------------------------------------------------------------
// Scoring functions
// ---------------------------------------------------------------------------

/**
 * 1. 身位规则 (Position Rule)
 * Higher consecutive limit-ups = higher score.
 * 3板 > 2板 > 1板.  Score scales with board count, capped at 10.
 */
function scorePosition(stock, maxBoards) {
  if (maxBoards === 0) return 0;
  return Math.min(stock.consecutiveLimitUps / maxBoards, 1.0);
}

/**
 * 2. 时间规则 (Time Rule)
 * Among same-position stocks, earlier limit-up time wins.
 * Normalize against trading window 09:30 - 15:00 (330 minutes).
 */
function scoreTiming(stock) {
  if (!stock.limitUpTime) return 0.5;
  const parts = stock.limitUpTime.split(':').map(Number);
  const totalMin = (parts[0] - 9) * 60 + (parts[1] - 30) + (parts[2] || 0) / 60;
  const windowMin = 330; // 09:30 to 15:00
  const normalized = Math.max(0, Math.min(totalMin / windowMin, 1.0));
  // Earlier = better, so invert
  return 1.0 - normalized;
}

/**
 * 3. 内核规则 (Core Logic Rule)
 * Stock's business must align with the trending theme/sector.
 */
function scoreCoreLogic(stock) {
  if (typeof stock.themeAlignment === 'number') return stock.themeAlignment;
  return 0.5; // neutral if unknown
}

/**
 * 4. 抗揍度 (Resilience)
 * Stock survives divergence periods without breaking.
 * More divergence survivals = higher resilience.
 */
function scoreResilience(stock, maxSurvivals) {
  if (maxSurvivals === 0) return 0.5;
  return Math.min((stock.divergenceSurvivals || 0) / maxSurvivals, 1.0);
}

/**
 * 5. 人气度 (Popularity)
 * Based on volume, turnover, and media attention.
 */
function scorePopularity(stock, maxTurnover) {
  const mediaComponent = stock.mediaScore || 0;
  const turnoverComponent = maxTurnover > 0
    ? Math.min((stock.turnover || 0) / maxTurnover, 1.0)
    : 0;
  return mediaComponent * 0.4 + turnoverComponent * 0.6;
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

const stocks = marketData.stocks;

// Pre-compute maxima for normalization
const maxBoards = Math.max(...stocks.map(s => s.consecutiveLimitUps || 0), 1);
const maxSurvivals = Math.max(...stocks.map(s => s.divergenceSurvivals || 0), 1);
const maxTurnover = Math.max(...stocks.map(s => s.turnover || 0), 1);

// Filter by scope
let candidates = [...stocks];
if (scope === 'sector' && sector) {
  candidates = candidates.filter(s =>
    s.sector && s.sector.toLowerCase().includes(sector.toLowerCase())
  );
}

// Score each candidate
const scored = candidates.map(stock => {
  const scores = {
    position: scorePosition(stock, maxBoards),
    timing: scoreTiming(stock),
    coreLogic: scoreCoreLogic(stock),
    resilience: scoreResilience(stock, maxSurvivals),
    popularity: scorePopularity(stock, maxTurnover)
  };

  const composite =
    scores.position * WEIGHTS.position +
    scores.timing * WEIGHTS.timing +
    scores.coreLogic * WEIGHTS.coreLogic +
    scores.resilience * WEIGHTS.resilience +
    scores.popularity * WEIGHTS.popularity;

  return {
    code: stock.code,
    name: stock.name,
    sector: stock.sector,
    consecutiveLimitUps: stock.consecutiveLimitUps,
    limitUpTime: stock.limitUpTime,
    scores,
    composite: Math.round(composite * 1000) / 1000,
    tier: composite >= 0.8 ? '核心龙头' :
          composite >= 0.6 ? '备选龙头' :
          composite >= 0.4 ? '跟风股' : '观察'
  };
});

// Sort descending by composite score
scored.sort((a, b) => b.composite - a.composite);

// ---------------------------------------------------------------------------
// Leader history — extract from stock history fields
// ---------------------------------------------------------------------------

const leaderHistory = [];
const topLeaders = scored.slice(0, 5);

for (const leader of topLeaders) {
  const stockData = stocks.find(s => s.code === leader.code);
  if (stockData && stockData.history && stockData.history.length > 0) {
    leaderHistory.push({
      code: leader.code,
      name: leader.name,
      sessions: stockData.history.map(h => ({
        date: h.date,
        consecutiveLimitUps: h.consecutiveLimitUps,
        status: h.status || 'active'
      }))
    });
  }
}

// ---------------------------------------------------------------------------
// Rotation signal detection
// ---------------------------------------------------------------------------

function detectRotation(scored, leaderHistory) {
  if (scored.length < 2) return 'unclear';

  // If top leader has significantly more boards than #2, stable
  const top = scored[0];
  const second = scored[1];

  if (top.consecutiveLimitUps >= second.consecutiveLimitUps + 2) {
    return 'stable';
  }

  // If multiple stocks at same board level with close scores, rotation likely
  const topTierCount = scored.filter(s =>
    s.consecutiveLimitUps === top.consecutiveLimitUps
  ).length;

  if (topTierCount >= 3) return 'rotating';

  // Check if previous leaders are fading based on history
  const fadingLeaders = leaderHistory.filter(h => {
    const sessions = h.sessions;
    if (sessions.length < 2) return false;
    const latest = sessions[sessions.length - 1];
    const prev = sessions[sessions.length - 2];
    return latest.status === 'broken' || latest.consecutiveLimitUps < prev.consecutiveLimitUps;
  });

  if (fadingLeaders.length > 0) return 'rotating';

  return 'stable';
}

const rotationSignal = detectRotation(scored, leaderHistory);

// ---------------------------------------------------------------------------
// Sentiment phase adjustments
// ---------------------------------------------------------------------------

let phaseNote = null;
if (sentimentPhase) {
  const phaseGuidance = {
    initiation: '启动期 — Focus on first-movers in new themes. Leader is being established.',
    expansion: '扩散期 — Leader is clear and strong. Follow the leader, buy dips on leader.',
    divergence: '分歧期 — Test leader resilience. Only the true leader survives divergence.',
    decline: '退潮期 — Leaders breaking down. Avoid chasing. Wait for new cycle.',
    ice: '冰点期 — No clear leader. Capital preserving mode. Scout for next cycle seeds.'
  };
  phaseNote = phaseGuidance[sentimentPhase] || `Phase: ${sentimentPhase}`;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const result = {
  leaders: scored,
  leaderHistory,
  rotationSignal,
  meta: {
    scope,
    sector: sector || 'all',
    date: marketData.date || new Date().toISOString().slice(0, 10),
    candidateCount: candidates.length,
    trendingThemes: marketData.trendingThemes || [],
    sentimentPhase: sentimentPhase || 'unknown',
    phaseNote,
    weights: WEIGHTS
  }
};

console.log(JSON.stringify(result, null, 2));
