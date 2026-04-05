#!/usr/bin/env node

/**
 * trade-live-session — 盘中监控工作流
 *
 * Lightweight monitoring workflow that runs every 15 minutes during
 * trading hours.  Outputs a workflow execution plan for the Friday
 * runtime; alerts are only surfaced when actionable.
 */

const now = new Date();
const timeStr = now.toLocaleTimeString('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
});
const dateStr = now.toLocaleDateString('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// Parse input from env (Friday passes FRIDAY_INPUT_JSON)
let inputs = {};
try {
  inputs = JSON.parse(process.env.FRIDAY_INPUT_JSON || '{}');
} catch (_) {
  // ignore
}
const urgencyOnly = inputs.urgencyOnly === true;

// ---------------------------------------------------------------------------
// Workflow DAG
// ---------------------------------------------------------------------------
const workflowPlan = {
  workflowId: 'trade-live-session',
  name: '盘中监控工作流',
  runDate: dateStr,
  runTime: timeStr,
  urgencyOnly,
  steps: [
    // ── Phase 1: parallel data fetching ─────────────────────────────────
    {
      id: 'market_quote',
      skillId: 'trade-market-realtime',
      inputs: {
        dataType: 'quote',
        symbols: { _source: 'watchlist+positions' },
      },
      dependsOn: [],
    },
    {
      id: 'exit_check',
      skillId: 'trade-exit-monitor',
      inputs: {
        urgencyMode: true,
        _inject: {
          marketData: '$market_quote.data',
        },
      },
      dependsOn: ['market_quote'],
    },
    {
      id: 'board_strategy',
      skillId: 'trade-board-strategy',
      inputs: { strategyType: 'all' },
      dependsOn: ['market_quote'],
    },

    // ── Phase 2: filter and alert ───────────────────────────────────────
    {
      id: 'filter_alerts',
      skillId: '__internal_filter',
      inputs: {
        urgencyOnly,
        _inject: {
          exitAlerts: '$exit_check.alerts',
          boardSetups: '$board_strategy.setups',
          marketData: '$market_quote.data',
        },
      },
      dependsOn: ['exit_check', 'board_strategy', 'market_quote'],
    },
  ],
};

// ---------------------------------------------------------------------------
// Alert filtering logic description
// ---------------------------------------------------------------------------
function describeAlertFilter() {
  return {
    rules: [
      'Include exit alerts where urgency === "HIGH"',
      'Include board setups where confidence >= 0.7',
      'If urgencyOnly=true, skip setups and only show HIGH exits',
      'If no alerts match, output empty alerts array (silent run)',
    ],
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const output = {
  ok: true,
  workflowPlan,
  filterLogic: describeAlertFilter(),
  outputs: {
    alerts: {
      description: '可执行告警（仅有内容时输出）',
      source: '$filter_alerts.alerts',
    },
    marketSnapshot: {
      description: '当前市场快照',
      source: '$market_quote.data',
    },
  },
  display: {
    onlyIfAlerts: true,
    format: 'notification',
    template: [
      `⏰ 盘中监控 | ${dateStr} ${timeStr}`,
      '',
      '{alerts.map(a => "  " + a.icon + " " + a.symbol + " " + a.message).join("\\n")}',
    ].join('\n'),
  },
};

console.log(JSON.stringify(output, null, 2));
