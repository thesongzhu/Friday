#!/usr/bin/env node

/**
 * 情绪周期分析器 — Trade Sentiment Cycle Analyzer
 *
 * Classifies the A-stock market into one of six sentiment phases based on
 * quantitative signals and outputs tactical trading implications.
 */

// ---------------------------------------------------------------------------
// Phase definitions
// ---------------------------------------------------------------------------

const PHASES = {
  冰点: {
    label: "冰点 (Ice Point)",
    tactical: "等待极值信号，不开仓或极轻仓试错",
    score: (m) => {
      const signals = [];
      let pts = 0;

      if (m.limitUpCount < 20) {
        pts += 2;
        signals.push(`涨停数极低 (${m.limitUpCount} < 20)`);
      }
      if (m.maxConsecutiveBoards <= 2) {
        pts += 2;
        signals.push(`连板高度极低 (${m.maxConsecutiveBoards} <= 2)`);
      }
      if (m.limitDownCount > m.limitUpCount) {
        pts += 2;
        signals.push(`跌停数 (${m.limitDownCount}) > 涨停数 (${m.limitUpCount})`);
      }
      if (m.profitEffect < -0.5) {
        pts += 1;
        signals.push(`亏钱效应明显 (profitEffect=${m.profitEffect})`);
      }

      return { pts, maxPts: 7, signals };
    },
  },

  修复: {
    label: "修复 (Repair)",
    tactical: "可尝试龙头低吸，轻仓试探",
    score: (m) => {
      const signals = [];
      let pts = 0;

      if (m.limitUpCount >= 20 && m.limitUpCount <= 40) {
        pts += 2;
        signals.push(`涨停数回暖 (${m.limitUpCount} 在 20-40)`);
      }
      if (m.maxConsecutiveBoards >= 2 && m.maxConsecutiveBoards <= 3) {
        pts += 2;
        signals.push(`连板高度修复 (${m.maxConsecutiveBoards} 在 2-3)`);
      }
      if (m.leadersStable) {
        pts += 2;
        signals.push("龙头开始企稳");
      }
      if (m.profitEffect >= -0.5 && m.profitEffect < 0) {
        pts += 1;
        signals.push(`亏钱效应减弱 (profitEffect=${m.profitEffect})`);
      }

      return { pts, maxPts: 7, signals };
    },
  },

  升温: {
    label: "升温 (Warming)",
    tactical: "主动出击，重点参与龙头和强势板块",
    score: (m) => {
      const signals = [];
      let pts = 0;

      if (m.limitUpCount > 40 && m.limitUpCount <= 80) {
        pts += 2;
        signals.push(`涨停数较多 (${m.limitUpCount} 在 40-80)`);
      }
      if (m.maxConsecutiveBoards >= 3 && m.maxConsecutiveBoards <= 5) {
        pts += 2;
        signals.push(`连板高度提升 (${m.maxConsecutiveBoards} 在 3-5)`);
      }
      if (m.sectorBreadth > 3) {
        pts += 1;
        signals.push(`板块开始扩散 (sectorBreadth=${m.sectorBreadth})`);
      }
      if (m.profitEffect >= 0 && m.profitEffect < 0.5) {
        pts += 1;
        signals.push(`赚钱效应扩散 (profitEffect=${m.profitEffect})`);
      }

      return { pts, maxPts: 6, signals };
    },
  },

  高潮: {
    label: "高潮 (Climax)",
    tactical: "享受利润但警惕见顶，适当锁定收益",
    score: (m) => {
      const signals = [];
      let pts = 0;

      if (m.limitUpCount > 80) {
        pts += 2;
        signals.push(`涨停数爆发 (${m.limitUpCount} > 80)`);
      }
      if (m.maxConsecutiveBoards >= 5) {
        pts += 2;
        signals.push(`连板高度极高 (${m.maxConsecutiveBoards} >= 5)`);
      }
      if (m.sectorBreadth >= 5) {
        pts += 1;
        signals.push(`多板块联动 (sectorBreadth=${m.sectorBreadth})`);
      }
      if (m.profitEffect >= 0.5) {
        pts += 2;
        signals.push(`赚钱效应极强 (profitEffect=${m.profitEffect})`);
      }

      return { pts, maxPts: 7, signals };
    },
  },

  分歧: {
    label: "分歧 (Divergence)",
    tactical: "减仓观望，只留最强龙头",
    score: (m) => {
      const signals = [];
      let pts = 0;

      if (m.limitUpCount >= 30 && m.limitUpCount <= 60) {
        pts += 1;
        signals.push(`涨停数从高位回落 (${m.limitUpCount})`);
      }
      if (m.highLevelDivergence) {
        pts += 2;
        signals.push("高位股开始分化");
      }
      if (m.leaderDivergence) {
        pts += 2;
        signals.push("龙头出现分歧但未死");
      }
      if (m.profitEffect >= -0.3 && m.profitEffect <= 0.3) {
        pts += 1;
        signals.push(`市场多空博弈 (profitEffect=${m.profitEffect})`);
      }

      return { pts, maxPts: 6, signals };
    },
  },

  退潮: {
    label: "退潮 (Ebb)",
    tactical: "空仓或极轻仓，等待下一个冰点",
    score: (m) => {
      const signals = [];
      let pts = 0;

      if (m.limitUpCount < 40 && m.limitUpCount >= 20) {
        pts += 1;
        signals.push(`涨停数持续下降 (${m.limitUpCount})`);
      }
      if (m.consecutiveBoardBreak) {
        pts += 2;
        signals.push("连板高度断裂");
      }
      if (m.highLevelSelloff) {
        pts += 2;
        signals.push("高位股集体调整");
      }
      if (m.profitEffect < -0.3) {
        pts += 2;
        signals.push(`赚钱效应转负 (profitEffect=${m.profitEffect})`);
      }

      return { pts, maxPts: 7, signals };
    },
  },
};

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

function getMarketData() {
  try {
    const parsed = JSON.parse(readFileSync(0, 'utf-8').trim() || '{}');
    // Accept either top-level or nested under .marketData
    return parsed.marketData || parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Analysis engine
// ---------------------------------------------------------------------------

function analyze(marketData) {
  // Provide sensible defaults for optional fields
  const m = {
    limitUpCount: 0,
    limitDownCount: 0,
    maxConsecutiveBoards: 0,
    sectorBreadth: 0,
    profitEffect: 0, // -1 (heavy loss) to +1 (heavy profit)
    leadersStable: false,
    highLevelDivergence: false,
    leaderDivergence: false,
    consecutiveBoardBreak: false,
    highLevelSelloff: false,
    ...marketData,
  };

  // Score every phase
  const results = Object.entries(PHASES).map(([phase, def]) => {
    const { pts, maxPts, signals } = def.score(m);
    const confidence = maxPts > 0 ? +(pts / maxPts).toFixed(3) : 0;
    return { phase, confidence, signals, tactical: def.tactical, label: def.label };
  });

  // Sort by confidence descending, then by defined order as tiebreaker
  results.sort((a, b) => b.confidence - a.confidence);

  const best = results[0];

  return {
    phase: best.phase,
    confidence: best.confidence,
    keySignals: best.signals,
    tacticalImplication: best.tactical,
    metrics: m,
    _allScores: results.map((r) => ({
      phase: r.phase,
      confidence: r.confidence,
      signals: r.signals,
    })),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const marketData = getMarketData();

  if (!marketData) {
    const output = {
      error: "no_market_data",
      message:
        "未提供市场数据。请提供以下字段的 JSON 对象作为输入：\n" +
        "  - limitUpCount (number): 涨停数\n" +
        "  - limitDownCount (number): 跌停数\n" +
        "  - maxConsecutiveBoards (number): 最高连板数\n" +
        "  - sectorBreadth (number): 活跃板块数量\n" +
        "  - profitEffect (number, -1 to 1): 赚钱效应指标\n" +
        "  - leadersStable (boolean): 龙头是否企稳\n" +
        "  - highLevelDivergence (boolean): 高位股是否分化\n" +
        "  - leaderDivergence (boolean): 龙头是否出现分歧\n" +
        "  - consecutiveBoardBreak (boolean): 连板高度是否断裂\n" +
        "  - highLevelSelloff (boolean): 高位股是否集体调整",
    };
    console.log(JSON.stringify(output, null, 2));
    process.exit(0);
  }

  const result = analyze(marketData);
  console.log(JSON.stringify(result, null, 2));
}

main();
