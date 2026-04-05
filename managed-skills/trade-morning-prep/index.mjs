#!/usr/bin/env node

/**
 * trade-morning-prep — 早盘准备工作流
 *
 * Generates a workflow execution plan (DAG of skill calls) for the
 * Friday workflow runtime.  Each step declares its skillId, inputs,
 * and dependencies so the runtime can parallelise where possible.
 */

const today = new Date().toLocaleDateString('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// ---------------------------------------------------------------------------
// Workflow DAG — each step is { id, skillId, inputs, dependsOn[] }
// ---------------------------------------------------------------------------
const workflowPlan = {
  workflowId: 'trade-morning-prep',
  name: '早盘准备工作流',
  runDate: today,
  steps: [
    // ── Phase 1: parallel data fetching ─────────────────────────────────
    {
      id: 'market_index',
      skillId: 'trade-market-realtime',
      inputs: { dataType: 'index' },
      dependsOn: [],
    },
    {
      id: 'limit_up_pool',
      skillId: 'trade-market-realtime',
      inputs: { dataType: 'limit_up_pool' },
      dependsOn: [],
    },
    {
      id: 'sector_rank',
      skillId: 'trade-sector-flow',
      inputs: { flowType: 'sector_rank' },
      dependsOn: [],
    },

    // ── Phase 2: sentiment needs market data ────────────────────────────
    {
      id: 'sentiment',
      skillId: 'trade-sentiment-cycle',
      inputs: {
        _inject: {
          marketData: '$market_index.data',
          limitUpPool: '$limit_up_pool.data',
          sectorRank: '$sector_rank.data',
        },
      },
      dependsOn: ['market_index', 'limit_up_pool', 'sector_rank'],
    },

    // ── Phase 3: leader scan + portfolio check (parallel) ───────────────
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
    {
      id: 'portfolio',
      skillId: 'trade-portfolio-tracker',
      inputs: { action: 'view' },
      dependsOn: ['sentiment'],
    },

    // ── Phase 4: exit monitor (needs portfolio) ─────────────────────────
    {
      id: 'exit_monitor',
      skillId: 'trade-exit-monitor',
      inputs: {
        _inject: {
          positions: '$portfolio.positions',
          marketData: '$market_index.data',
        },
      },
      dependsOn: ['portfolio', 'market_index'],
    },

    // ── Phase 5: signal generation (needs everything) ───────────────────
    {
      id: 'signal_gen',
      skillId: 'trade-signal-generator',
      inputs: {
        _inject: {
          sentimentPhase: '$sentiment.phase',
          leaders: '$leader_scan.leaders',
          sectorRank: '$sector_rank.data',
          marketData: '$market_index.data',
        },
      },
      dependsOn: ['sentiment', 'leader_scan', 'sector_rank', 'market_index'],
    },

    // ── Phase 6: compile morning brief ──────────────────────────────────
    {
      id: 'compile_brief',
      skillId: '__internal_compile',
      inputs: {
        _inject: {
          marketIndex: '$market_index.data',
          sentiment: '$sentiment',
          leaders: '$leader_scan.leaders',
          exitAlerts: '$exit_monitor.alerts',
          signals: '$signal_gen.signals',
          sectors: '$sector_rank.data',
        },
      },
      dependsOn: [
        'market_index',
        'sentiment',
        'leader_scan',
        'exit_monitor',
        'signal_gen',
        'sector_rank',
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Compile — the final step produces the morning brief text
// ---------------------------------------------------------------------------
function compileMorningBrief(results) {
  const m = results.marketIndex || {};
  const s = results.sentiment || {};
  const leaders = results.leaders || [];
  const alerts = results.exitAlerts || [];
  const signals = results.signals || [];
  const sectors = results.sectors || [];

  const indexLine = (name, d) =>
    `  ${name}: ${d?.price ?? '--'} (${d?.changePct != null ? (d.changePct > 0 ? '+' : '') + d.changePct + '%' : '--'})`;

  const leaderLines = leaders
    .slice(0, 8)
    .map((l, i) => `  ${i + 1}. ${l.name ?? l.symbol} — 综合评分 ${l.score ?? '--'}`)
    .join('\n');

  const alertLines =
    alerts.length > 0
      ? alerts
          .map(
            (a) =>
              `  ⚠ ${a.symbol} ${a.name ?? ''} — ${a.reason ?? a.type}`,
          )
          .join('\n')
      : '  无持仓预警';

  const signalLines = signals
    .slice(0, 5)
    .map(
      (s, i) =>
        `  ${i + 1}. ${s.symbol} ${s.name ?? ''} | 入场 ${s.entry ?? '--'} | 止损 ${s.stop ?? '--'} | 目标 ${s.target ?? '--'}`,
    )
    .join('\n');

  const sectorLines = sectors
    .slice(0, 5)
    .map(
      (sec, i) =>
        `  ${i + 1}. ${sec.name ?? sec.sector} — 净流入 ${sec.netInflow ?? '--'}亿`,
    )
    .join('\n');

  return [
    '',
    '═══════════════════════════════════════',
    `📊 早盘准备报告 | ${today}`,
    '═══════════════════════════════════════',
    '',
    '【市场概览】',
    indexLine('上证', m.sh),
    indexLine('深证', m.sz),
    indexLine('创业板', m.cy),
    '',
    '【情绪周期】',
    `  当前阶段: ${s.phase ?? '--'}`,
    `  置信度: ${s.confidence ?? '--'}%`,
    `  战术建议: ${s.implication ?? '--'}`,
    '',
    '【龙头股】',
    leaderLines || '  暂无数据',
    '',
    '【持仓预警】',
    alertLines,
    '',
    '【今日信号】',
    signalLines || '  暂无信号',
    '',
    '【板块热度】',
    sectorLines || '  暂无数据',
    '═══════════════════════════════════════',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const output = {
  ok: true,
  workflowPlan,
  // The compile function template — serialised so the runtime knows
  // how to build the final brief after executing all steps.
  compileTemplate: 'morningBrief',
  outputs: {
    morningBrief: {
      description: '早盘准备报告（文本 + 结构化数据）',
      formatFn: 'compileMorningBrief',
    },
    signals: { source: '$signal_gen.signals' },
    exitAlerts: { source: '$exit_monitor.alerts' },
  },
};

console.log(JSON.stringify(output, null, 2));
