#!/usr/bin/env node

/**
 * trade-master-agent — 交易主控Agent
 *
 * Parses the user's natural-language query, determines intent, and
 * outputs a structured skill-call plan for the Friday runtime to
 * execute.  Supports the full suite of trade skills.
 */

// ---------------------------------------------------------------------------
// Intent → Skill mapping
// ---------------------------------------------------------------------------
const INTENT_MAP = [
  {
    id: 'market',
    keywords: ['行情', '市场', '指数', '大盘', 'market', 'index'],
    skillId: 'trade-market-realtime',
    defaultInputs: { dataType: 'index' },
    description: '获取实时市场行情',
  },
  {
    id: 'sentiment',
    keywords: ['情绪', '周期', '阶段', 'sentiment', 'cycle'],
    skillId: 'trade-sentiment-cycle',
    defaultInputs: {},
    description: '分析市场情绪周期',
  },
  {
    id: 'leader',
    keywords: ['龙头', '领涨', 'leader'],
    skillId: 'trade-leader-scanner',
    defaultInputs: {},
    description: '扫描龙头股',
  },
  {
    id: 'board',
    keywords: ['打板', '首板', '二板', '涨停', 'board', 'limit up'],
    skillId: 'trade-board-strategy',
    defaultInputs: { strategyType: 'all' },
    description: '打板策略分析',
  },
  {
    id: 'dip_buy',
    keywords: ['低吸', '回调', 'dip', 'pullback'],
    skillId: 'trade-dip-buy-scanner',
    defaultInputs: {},
    description: '低吸机会扫描',
  },
  {
    id: 'auction',
    keywords: ['竞价', '集合竞价', 'auction'],
    skillId: 'trade-auction-analyzer',
    defaultInputs: {},
    description: '集合竞价分析',
  },
  {
    id: 'portfolio',
    keywords: ['持仓', '仓位', 'portfolio', 'position'],
    skillId: 'trade-portfolio-tracker',
    defaultInputs: { action: 'view' },
    description: '查看持仓',
  },
  {
    id: 'signal',
    keywords: ['信号', '买什么', '推荐', 'signal', 'buy'],
    skillId: 'trade-signal-generator',
    defaultInputs: {},
    description: '生成交易信号',
  },
  {
    id: 'exit',
    keywords: ['卖出', '止损', '止盈', '退出', 'sell', 'exit', 'stop'],
    skillId: 'trade-exit-monitor',
    defaultInputs: {},
    description: '退出/止损监控',
  },
  {
    id: 'journal',
    keywords: ['日志', '记录', '交易记录', 'journal', 'log'],
    skillId: 'trade-journal',
    defaultInputs: { action: 'daily_summary' },
    description: '交易日志',
  },
  {
    id: 'performance',
    keywords: ['绩效', '表现', '收益', '回报', 'performance', 'return'],
    skillId: 'trade-performance-analytics',
    defaultInputs: {},
    description: '绩效分析',
  },
  {
    id: 'fitness',
    keywords: ['适配', '策略评估', '策略检查', 'fitness'],
    skillId: 'trade-strategy-fitness',
    defaultInputs: {},
    description: '策略适配度评估',
  },
  {
    id: 'knowledge',
    keywords: ['知识', '学习', '教程', '怎么', '什么是', 'learn', 'knowledge', 'tutorial'],
    skillId: '__memory_search',
    defaultInputs: { memoryStore: 'trade-kb' },
    description: '检索交易知识库',
  },
  {
    id: 'sector',
    keywords: ['板块', '行业', '题材', 'sector', 'theme'],
    skillId: 'trade-sector-flow',
    defaultInputs: { flowType: 'sector_rank' },
    description: '板块资金流向',
  },
  {
    id: 'hot_money',
    keywords: ['游资', '龙虎榜', '大单', 'hot money', 'dragon tiger'],
    skillId: 'trade-hot-money-tracker',
    defaultInputs: {},
    description: '游资/龙虎榜追踪',
  },
  {
    id: 'morning_prep',
    keywords: ['早盘', '盘前', 'morning'],
    skillId: 'trade-morning-prep',
    defaultInputs: {},
    description: '早盘准备工作流',
  },
  {
    id: 'evening_review',
    keywords: ['复盘', '收盘', '盘后', 'review', 'evening'],
    skillId: 'trade-evening-review',
    defaultInputs: {},
    description: '收盘复盘工作流',
  },
  {
    id: 'historical',
    keywords: ['历史', 'K线', '走势', 'historical', 'chart'],
    skillId: 'trade-market-historical',
    defaultInputs: {},
    description: '历史行情数据',
  },
];

// ---------------------------------------------------------------------------
// Parse input from stdin (Friday runtime pipes JSON via stdin)
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
let inputs = {};
try {
  inputs = JSON.parse(readFileSync(0, 'utf-8').trim() || '{}');
} catch (_) {
  // ignore
}

const query = inputs.query || '';
const context = inputs.context || {};

if (!query) {
  console.log(
    JSON.stringify({
      ok: false,
      error: 'missing_query',
      response: '请输入您的问题或指令。',
      skillsUsed: [],
      data: null,
    }),
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Intent detection — match keywords in query
// ---------------------------------------------------------------------------
function detectIntents(query) {
  const q = query.toLowerCase();
  const matched = [];

  for (const intent of INTENT_MAP) {
    for (const kw of intent.keywords) {
      if (q.includes(kw.toLowerCase())) {
        matched.push(intent);
        break;
      }
    }
  }

  // Default: if nothing matched, try market overview + signal
  if (matched.length === 0) {
    matched.push(
      INTENT_MAP.find((i) => i.id === 'market'),
      INTENT_MAP.find((i) => i.id === 'signal'),
    );
  }

  return matched;
}

// ---------------------------------------------------------------------------
// Extract symbols from query (e.g. stock codes like 000001, 600519)
// ---------------------------------------------------------------------------
function extractSymbols(query) {
  const matches = query.match(/\b[036]\d{5}\b/g);
  return matches ? [...new Set(matches)] : [];
}

// ---------------------------------------------------------------------------
// Build skill call plan
// ---------------------------------------------------------------------------
function buildPlan(intents, query) {
  const symbols = extractSymbols(query);
  const steps = [];
  const skillsUsed = [];

  for (const intent of intents) {
    const step = {
      id: intent.id,
      skillId: intent.skillId,
      inputs: { ...intent.defaultInputs },
      dependsOn: [],
    };

    // Inject symbols if the skill supports them
    if (symbols.length > 0 && ['market', 'auction'].includes(intent.id)) {
      step.inputs.symbols = symbols;
      step.inputs.dataType = 'quote';
    }

    // Some intents depend on others
    if (intent.id === 'signal' && intents.some((i) => i.id === 'sentiment')) {
      step.dependsOn.push('sentiment');
      step.inputs._inject = { sentimentPhase: '$sentiment.phase' };
    }
    if (intent.id === 'leader' && intents.some((i) => i.id === 'sentiment')) {
      step.dependsOn.push('sentiment');
      step.inputs._inject = { sentimentPhase: '$sentiment.phase' };
    }
    if (intent.id === 'exit' && intents.some((i) => i.id === 'portfolio')) {
      step.dependsOn.push('portfolio');
      step.inputs._inject = { positions: '$portfolio.positions' };
    }

    steps.push(step);
    skillsUsed.push(intent.skillId);
  }

  return { steps, skillsUsed };
}

// ---------------------------------------------------------------------------
// Generate response template
// ---------------------------------------------------------------------------
function generateResponseTemplate(intents) {
  const descriptions = intents.map((i) => i.description).join('、');
  return `正在为您执行: ${descriptions}。请稍候...`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const intents = detectIntents(query);
const { steps, skillsUsed } = buildPlan(intents, query);

const output = {
  ok: true,
  query,
  detectedIntents: intents.map((i) => i.id),
  response: generateResponseTemplate(intents),
  skillsUsed,
  data: null,
  workflowPlan: {
    workflowId: 'trade-master-agent',
    name: '交易主控Agent',
    query,
    context,
    steps,
  },
};

console.log(JSON.stringify(output, null, 2));
