#!/usr/bin/env node

/**
 * trade-evening-review — 收盘复盘工作流
 *
 * Generates a workflow execution plan for the Friday workflow runtime.
 * Runs after market close to compile the evening review report including
 * P&L, journal, hot-money activity, sentiment forecast, and watchlist.
 */

const now = new Date();
const dateStr = now.toLocaleDateString('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const dayOfWeek = now.toLocaleDateString('en-US', {
  timeZone: 'Asia/Shanghai',
  weekday: 'long',
});
const isFriday = dayOfWeek === 'Friday';

// ---------------------------------------------------------------------------
// Workflow DAG
// ---------------------------------------------------------------------------
const steps = [
  // ── Phase 1: parallel data fetching ───────────────────────────────────
  {
    id: 'market_eod',
    skillId: 'trade-market-realtime',
    inputs: { dataType: 'index' },
    dependsOn: [],
  },
  {
    id: 'hot_money',
    skillId: 'trade-hot-money-tracker',
    inputs: { date: dateStr },
    dependsOn: [],
  },
  {
    id: 'portfolio',
    skillId: 'trade-portfolio-tracker',
    inputs: { action: 'view' },
    dependsOn: [],
  },

  // ── Phase 2: journal + sentiment (need market + portfolio) ────────────
  {
    id: 'journal',
    skillId: 'trade-journal',
    inputs: {
      action: 'daily_summary',
      _inject: {
        portfolio: '$portfolio',
        marketData: '$market_eod.data',
      },
    },
    dependsOn: ['portfolio', 'market_eod'],
  },
  {
    id: 'sentiment',
    skillId: 'trade-sentiment-cycle',
    inputs: {
      _inject: {
        marketData: '$market_eod.data',
        hotMoney: '$hot_money.data',
      },
    },
    dependsOn: ['market_eod', 'hot_money'],
  },

  // ── Phase 3: tomorrow watchlist (needs sentiment) ─────────────────────
  {
    id: 'leader_scan',
    skillId: 'trade-leader-scanner',
    inputs: {
      _inject: {
        sentimentPhase: '$sentiment.phase',
      },
    },
    dependsOn: ['sentiment'],
  },
];

// ── Conditional: Friday weekly strategy fitness ─────────────────────────
if (isFriday) {
  steps.push({
    id: 'strategy_fitness',
    skillId: 'trade-strategy-fitness',
    inputs: {
      period: 'weekly',
      _inject: {
        portfolio: '$portfolio',
        journal: '$journal',
      },
    },
    dependsOn: ['portfolio', 'journal'],
  });
}

// ── Final: compile evening report ───────────────────────────────────────
const compileDeps = [
  'market_eod',
  'hot_money',
  'portfolio',
  'journal',
  'sentiment',
  'leader_scan',
];
if (isFriday) compileDeps.push('strategy_fitness');

steps.push({
  id: 'compile_report',
  skillId: '__internal_compile',
  inputs: {
    isFriday,
    _inject: {
      marketEod: '$market_eod.data',
      hotMoney: '$hot_money.data',
      portfolio: '$portfolio',
      journal: '$journal',
      sentiment: '$sentiment',
      watchlist: '$leader_scan.leaders',
      ...(isFriday ? { strategyFitness: '$strategy_fitness' } : {}),
    },
  },
  dependsOn: compileDeps,
});

const workflowPlan = {
  workflowId: 'trade-evening-review',
  name: '收盘复盘工作流',
  runDate: dateStr,
  isFriday,
  steps,
};

// ---------------------------------------------------------------------------
// Evening report template
// ---------------------------------------------------------------------------
function compileEveningReport(results) {
  const p = results.portfolio || {};
  const j = results.journal || {};
  const hm = results.hotMoney || {};
  const s = results.sentiment || {};
  const wl = results.watchlist || [];
  const sf = results.strategyFitness || null;

  const pnlSign = (p.todayPnl || 0) >= 0 ? '+' : '';

  const hotMoneyLines = (hm.highlights || [])
    .slice(0, 5)
    .map((h) => `  ${h.symbol} ${h.name ?? ''} — ${h.summary ?? ''}`)
    .join('\n');

  const watchlistLines = wl
    .slice(0, 8)
    .map((w, i) => `  ${i + 1}. ${w.name ?? w.symbol} — ${w.reason ?? ''}`)
    .join('\n');

  const lines = [
    '',
    '═══════════════════════════════════════',
    `📋 收盘复盘报告 | ${dateStr}`,
    '═══════════════════════════════════════',
    '',
    '【今日盈亏】',
    `  持仓总值: ${p.totalValue ?? '--'}`,
    `  今日盈亏: ${pnlSign}${p.todayPnl ?? '--'} (${pnlSign}${p.todayPnlPct ?? '--'}%)`,
    '',
    '【交易日志】',
    `  ${j.summary ?? '暂无交易记录'}`,
    '',
    '【龙虎榜亮点】',
    hotMoneyLines || '  暂无数据',
    '',
    '【明日情绪研判】',
    `  预判阶段: ${s.phase ?? '--'}`,
    `  关注方向: ${s.focusSectors?.join('、') ?? '--'}`,
    '',
    '【明日自选】',
    watchlistLines || '  暂无推荐',
  ];

  if (sf) {
    lines.push(
      '',
      '【本周策略适配度】',
      `  综合评分: ${sf.score ?? '--'}`,
      `  建议调整: ${sf.suggestion ?? '无'}`,
    );
  }

  lines.push('═══════════════════════════════════════', '');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const output = {
  ok: true,
  workflowPlan,
  compileTemplate: 'eveningReport',
  outputs: {
    eveningReport: {
      description: '收盘复盘报告（文本 + 结构化数据）',
      formatFn: 'compileEveningReport',
    },
    tomorrowWatchlist: { source: '$leader_scan.leaders' },
  },
};

console.log(JSON.stringify(output, null, 2));
