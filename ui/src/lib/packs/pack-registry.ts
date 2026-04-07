import {
  Activity,
  Briefcase,
  ChartColumnIncreasing,
  ClipboardList,
  Cpu,
  Hammer,
  PenTool,
  RefreshCcw,
  Rocket,
  ShoppingCart,
  TrendingUp,
  Users,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  requireBuiltInPackCatalogEntry,
  type BuiltInPackKind,
} from "../../../../src/packs/friday-built-in-pack-catalog";
import type { UserProfileType } from "@/hooks/use-user-profile";
import { FRIDAY_GOAL_CATEGORIES } from "@/lib/guided/goal-categories";
import { localizedText, type LocalizedText } from "@/lib/i18n/localized-text";

export type FridayPackKind = BuiltInPackKind;

export interface FridayPackLauncher {
  type: "wizard";
  wizardId: string;
}

export interface FridayPackCuratedSkill {
  skillId: string;
  title: LocalizedText;
  summary: LocalizedText;
  starterPrompt: LocalizedText;
}

export interface FridayPackEntryPrompt {
  id: string;
  label: LocalizedText;
  prompt: LocalizedText;
}

export interface FridayPackDeliverable {
  title: LocalizedText;
  detail: LocalizedText;
}

export interface FridayPackAssistantHandoff {
  title: LocalizedText;
  summary: LocalizedText;
  actionLabel: LocalizedText;
}

export interface FridayPackProductCopy {
  audience: LocalizedText;
  resultTitle: LocalizedText;
  resultSummary: LocalizedText;
  entryPrompts: FridayPackEntryPrompt[];
  deliverables: FridayPackDeliverable[];
  assistantHandoff: FridayPackAssistantHandoff | null;
}

export interface FridayPackDefinition {
  id: string;
  kind: FridayPackKind;
  builtIn: boolean;
  icon: LucideIcon;
  title: LocalizedText;
  summary: LocalizedText;
  defaultLauncher: FridayPackLauncher;
  backingTemplateIds: string[];
  supportsContinueLast: boolean;
  curatedSkills: FridayPackCuratedSkill[];
  productCopy: FridayPackProductCopy | null;
}

const INDUSTRY_PACKS: FridayPackDefinition[] = [
  {
    id: "industry-creator-media",
    kind: "industry",
    builtIn: true,
    icon: PenTool,
    title: localizedText("自媒体", "Creator Media"),
    summary: localizedText("把灵感、评论和内容节奏整理成可以持续执行的创作流。", "Turn topics, comments, and cadence into a repeatable content flow."),
    defaultLauncher: { type: "wizard", wizardId: requireBuiltInPackCatalogEntry("industry-creator-media").defaultWizardId },
    backingTemplateIds: ["content-social", "automate-work"],
    supportsContinueLast: true,
    curatedSkills: [
      {
        skillId: "weekly-content-calendar-creator",
        title: localizedText("周内容日历", "Weekly Content Calendar"),
        summary: localizedText("把选题、评论和笔记整理成一周内容节奏。", "Turn topic ideas, comments, and notes into a weekly publishing plan."),
        starterPrompt: localizedText(
          "帮我用 weekly-content-calendar-creator 这个技能，把这些选题、评论和笔记整理成下周的内容日历。",
          "Use the weekly-content-calendar-creator skill to turn these topics, comments, and notes into next week's content calendar.",
        ),
      },
    ],
    productCopy: {
      audience: localizedText("适合持续做内容、需要把灵感变成节奏的创作者。", "For creators who need to turn loose ideas into a repeatable publishing cadence."),
      resultTitle: localizedText("你会拿到一个可执行的内容作战板", "You will get a production-ready content plan"),
      resultSummary: localizedText("Friday 会把选题、评论和已有素材压成一套能直接开做的周节奏，而不是只给你一堆灵感。", "Friday turns topics, comments, and raw notes into a weekly content plan you can actually execute."),
      entryPrompts: [
        {
          id: "weekly-calendar",
          label: localizedText("做周内容日历", "Build a weekly calendar"),
          prompt: localizedText("帮我把这些选题、评论和笔记整理成下周的内容日历。", "Turn these topics, comments, and notes into next week's content calendar."),
        },
        {
          id: "repurpose-angles",
          label: localizedText("改成多平台版本", "Repurpose for channels"),
          prompt: localizedText("帮我把这条内容改成不同平台可直接用的版本，并给出每个平台的 hook。", "Repurpose this piece into channel-specific versions and give me a hook for each one."),
        },
        {
          id: "double-down",
          label: localizedText("判断继续做什么", "Decide what to double down on"),
          prompt: localizedText("根据这些内容表现和评论，告诉我下周最值得继续做的选题方向。", "Based on this content performance and comments, show me what themes are worth doubling down on next week."),
        },
      ],
      deliverables: [
        {
          title: localizedText("内容节奏板", "Cadence board"),
          detail: localizedText("一周内容安排、优先级和发布时间建议。", "A weekly publishing rhythm with priorities and suggested timing."),
        },
        {
          title: localizedText("平台差异版本", "Channel variants"),
          detail: localizedText("同一主题在不同平台的 opening、角度和长度建议。", "Platform-specific openings, angles, and content length guidance."),
        },
        {
          title: localizedText("下一个要追的主题簇", "Next topic cluster"),
          detail: localizedText("哪些评论和反馈值得继续延展成后续内容。", "Which comments and feedback deserve follow-up content."),
        },
      ],
      assistantHandoff: {
        title: localizedText("把结果交给助手继续整理", "Hand the plan back to Assistant"),
        summary: localizedText("Assistant 会帮你把内容节奏、风险和下一步动作整理成更清楚的执行版。", "Assistant turns the plan into a cleaner execution handoff with risks and next actions."),
        actionLabel: localizedText("去助手里继续整理", "Continue in Assistant"),
      },
    },
  },
  {
    id: "industry-cross-border-ecommerce",
    kind: "industry",
    builtIn: true,
    icon: ShoppingCart,
    title: localizedText("跨境电商", "Cross-border Ecommerce"),
    summary: localizedText("围绕店铺数据、运营动作和多平台节奏组织每天该做的事情。", "Organize store metrics, operations actions, and multi-platform routines."),
    defaultLauncher: { type: "wizard", wizardId: requireBuiltInPackCatalogEntry("industry-cross-border-ecommerce").defaultWizardId },
    backingTemplateIds: ["ecommerce", "automate-work"],
    supportsContinueLast: true,
    curatedSkills: [
      {
        skillId: "summarize-shop-performance",
        title: localizedText("店铺表现摘要", "Shop Performance Summary"),
        summary: localizedText("把广告、库存、退货和 listing 备注收成异常与动作清单。", "Turn ads, inventory, returns, and listing notes into issue clusters and actions."),
        starterPrompt: localizedText(
          "帮我用 summarize-shop-performance 这个技能，把这些店铺表现备注整理成异常和今日动作清单。",
          "Use the summarize-shop-performance skill to summarize these store performance notes into anomalies and today's action list.",
        ),
      },
    ],
    productCopy: {
      audience: localizedText("适合每天要盯广告、库存、售后和多平台节奏的跨境店铺运营。", "For operators who juggle ads, inventory, support, and multi-channel store operations every day."),
      resultTitle: localizedText("你会拿到今天该做什么的异常清单", "You will get today’s anomaly and action board"),
      resultSummary: localizedText("Friday 会把报表和运营备注压成风险分组、优先级和动作清单，而不是只给你读一遍数据。", "Friday compresses reports and notes into risk clusters, priorities, and actions instead of just restating metrics."),
      entryPrompts: [
        {
          id: "morning-check",
          label: localizedText("做晨检摘要", "Run a morning check"),
          prompt: localizedText("把今天的店铺数据整理成异常、优先级和动作清单。", "Turn today's store metrics into anomalies, priorities, and action items."),
        },
        {
          id: "risk-area",
          label: localizedText("找最危险的模块", "Find the riskiest area"),
          prompt: localizedText("帮我看广告、库存、退货和 listing 里现在哪块最危险。", "Show me which area across ads, inventory, returns, and listings is most at risk right now."),
        },
        {
          id: "ops-checklist",
          label: localizedText("做今日运营清单", "Build today’s checklist"),
          prompt: localizedText("根据这些店铺数据和运营备注，做一个今天必须处理的运营清单。", "Use these store metrics and operations notes to build today's must-do checklist."),
        },
      ],
      deliverables: [
        {
          title: localizedText("异常分组", "Issue clusters"),
          detail: localizedText("把广告、库存、订单、listing 和售后分成清楚的风险组。", "Clear clusters across ads, inventory, orders, listings, and support."),
        },
        {
          title: localizedText("今日动作清单", "Today’s action list"),
          detail: localizedText("先做什么、为什么先做、如果不做会怎样。", "What to do first, why it comes first, and what happens if it slips."),
        },
        {
          title: localizedText("店铺风险看板", "Store risk board"),
          detail: localizedText("哪些问题要今天处理，哪些适合进入一周节奏。", "Which issues need same-day action versus weekly follow-up."),
        },
      ],
      assistantHandoff: {
        title: localizedText("交给助手做复盘和跟进", "Hand off to Assistant for review"),
        summary: localizedText("Assistant 会把异常、风险和下一步协作动作收成一页可执行摘要。", "Assistant turns the anomaly board into a concise handoff for follow-up and coordination."),
        actionLabel: localizedText("交给助手跟进", "Continue with Assistant"),
      },
    },
  },
  {
    id: "industry-operations",
    kind: "industry",
    builtIn: true,
    icon: ClipboardList,
    title: localizedText("运营", "Operations"),
    summary: localizedText("把 KPI、异常和复盘材料收成清晰的行动清单。", "Turn KPI drift, anomalies, and review notes into clear next actions."),
    defaultLauncher: { type: "wizard", wizardId: requireBuiltInPackCatalogEntry("industry-operations").defaultWizardId },
    backingTemplateIds: ["automate-work", "understand-system"],
    supportsContinueLast: true,
    curatedSkills: [
      {
        skillId: "operations-brief-generator",
        title: localizedText("运营简报", "Operations Brief"),
        summary: localizedText("把每日指标整理成异常、根因提示和可发到飞书的简报。", "Turn daily metrics into anomalies, root-cause prompts, and a shareable ops brief."),
        starterPrompt: localizedText(
          "帮我用 operations-brief-generator 这个技能，把这些 daily metrics 变成运营简报和异常摘要。",
          "Use the operations-brief-generator skill to turn these daily metrics into an operations brief and anomaly summary.",
        ),
      },
    ],
    productCopy: {
      audience: localizedText("适合每天需要汇总 KPI、异常和跨团队推进事项的运营角色。", "For operators who need to summarize KPIs, anomalies, and cross-team actions every day."),
      resultTitle: localizedText("你会拿到一份可汇报、可推进的运营摘要", "You will get a shareable operations brief"),
      resultSummary: localizedText("Friday 会把指标、复盘和阻塞点收成可发群、可开会、可执行的版本。", "Friday turns metrics, reviews, and blockers into something you can share, review, and execute."),
      entryPrompts: [
        {
          id: "daily-brief",
          label: localizedText("做日报异常摘要", "Draft a daily brief"),
          prompt: localizedText("把这些 daily KPI 和异常整理成一份运营日报。", "Turn these daily KPIs and anomalies into an operations brief."),
        },
        {
          id: "weekly-review",
          label: localizedText("做周会复盘", "Build a weekly review"),
          prompt: localizedText("根据这些项目数据和复盘笔记，帮我做一份适合周会的复盘。", "Use these project metrics and review notes to build a weekly review summary."),
        },
        {
          id: "approval-blockers",
          label: localizedText("看卡在哪", "Find blockers"),
          prompt: localizedText("告诉我哪些事情卡在审批、依赖或协作上，以及下一步怎么推。", "Show me what is blocked by approvals, dependencies, or coordination, and what to do next."),
        },
      ],
      deliverables: [
        {
          title: localizedText("运营摘要", "Operations brief"),
          detail: localizedText("今天最重要的指标、异常和趋势。", "The most important metrics, anomalies, and trends for today."),
        },
        {
          title: localizedText("原因假设", "Likely causes"),
          detail: localizedText("把最可能的原因和证据线索排出来。", "Likely root-cause hints and the evidence behind them."),
        },
        {
          title: localizedText("推进动作", "Next moves"),
          detail: localizedText("谁需要跟进、该问谁、下一步开会还是补资料。", "Who needs follow-up, who to ask, and whether to review, escalate, or gather more data."),
        },
      ],
      assistantHandoff: {
        title: localizedText("让助手继续生成执行版", "Let Assistant turn it into an execution brief"),
        summary: localizedText("Assistant 会把这份摘要压成更适合发群、周会或老板汇报的版本。", "Assistant turns the brief into a clearer execution version for group chat, meetings, or leadership updates."),
        actionLabel: localizedText("去助手里继续打磨", "Refine in Assistant"),
      },
    },
  },
  {
    id: "industry-sales",
    kind: "industry",
    builtIn: true,
    icon: Briefcase,
    title: localizedText("销售", "Sales"),
    summary: localizedText("整理客户信息、下一步动作和沟通跟进，不让商机散掉。", "Keep customer context, follow-ups, and next steps from falling apart."),
    defaultLauncher: { type: "wizard", wizardId: requireBuiltInPackCatalogEntry("industry-sales").defaultWizardId },
    backingTemplateIds: ["team-management", "automate-work"],
    supportsContinueLast: true,
    curatedSkills: [
      {
        skillId: "convert-notes-to-brief",
        title: localizedText("销售跟进简报", "Sales Follow-up Brief"),
        summary: localizedText("把 CRM 或企微碎片笔记收成阶段判断、阻塞和下一条消息。", "Turn CRM or WeCom notes into stage, blockers, and the next follow-up message."),
        starterPrompt: localizedText(
          "帮我用 convert-notes-to-brief 这个技能，把这些客户笔记整理成跟进简报和下一步消息。",
          "Use the convert-notes-to-brief skill to turn these customer notes into a follow-up brief and next message.",
        ),
      },
    ],
    productCopy: {
      audience: localizedText("适合经常处理客户纪要、微信/企微聊天和下一步跟进的销售。", "For sales operators who constantly turn meeting notes and chat fragments into follow-up."),
      resultTitle: localizedText("你会拿到一份可跟进的销售简报", "You will get a sales follow-up brief"),
      resultSummary: localizedText("Friday 会把客户信息、阶段判断和下一步消息收成一页，而不是让你自己再拼一次。", "Friday packages customer context, deal stage, and the next message into a single follow-up brief."),
      entryPrompts: [
        {
          id: "meeting-followup",
          label: localizedText("把纪要变成跟进计划", "Turn notes into a follow-up plan"),
          prompt: localizedText("帮我把这次客户会议纪要整理成跟进计划和下一步动作。", "Turn this customer meeting note into a follow-up plan and next steps."),
        },
        {
          id: "deal-risk",
          label: localizedText("判断商机风险", "Judge deal risk"),
          prompt: localizedText("根据这些客户笔记和最近互动，判断这个商机现在最大的风险是什么。", "Use these customer notes and recent interactions to show the biggest deal risk right now."),
        },
        {
          id: "next-message",
          label: localizedText("写下一条消息", "Draft the next message"),
          prompt: localizedText("帮我写一条下一步客户跟进消息，并给出建议发送时机。", "Draft the next follow-up message and recommend when to send it."),
        },
      ],
      deliverables: [
        {
          title: localizedText("阶段判断", "Stage summary"),
          detail: localizedText("当前商机在哪个阶段，最需要推进什么。", "The current deal stage and what needs the most pressure now."),
        },
        {
          title: localizedText("风险清单", "Risk list"),
          detail: localizedText("丢单风险、卡点和需要补的信息。", "Deal risks, blockers, and missing information."),
        },
        {
          title: localizedText("下一步消息", "Next message"),
          detail: localizedText("一条可直接发送的跟进消息和建议时机。", "A ready-to-send follow-up message with suggested timing."),
        },
      ],
      assistantHandoff: {
        title: localizedText("交给助手整理后续推进", "Hand off to Assistant for follow-up"),
        summary: localizedText("Assistant 会把商机风险、时间点和下一步动作整理成更适合执行的版本。", "Assistant turns the brief into a cleaner execution handoff with risks, timing, and next actions."),
        actionLabel: localizedText("去助手里继续跟", "Continue in Assistant"),
      },
    },
  },
  {
    id: "industry-small-business-owner",
    kind: "industry",
    builtIn: true,
    icon: ChartColumnIncreasing,
    title: localizedText("小老板", "Small Business Owner"),
    summary: localizedText("把钱、人、销售和行政事项排出优先级，先抓最该抓的。", "Prioritize money, people, sales, and admin so the owner focuses on the right thing."),
    defaultLauncher: { type: "wizard", wizardId: requireBuiltInPackCatalogEntry("industry-small-business-owner").defaultWizardId },
    backingTemplateIds: ["team-management", "understand-system"],
    supportsContinueLast: true,
    curatedSkills: [
      {
        skillId: "convert-notes-to-dashboard",
        title: localizedText("老板日控板", "Owner Dashboard"),
        summary: localizedText("把零散经营事项收成钱、人、销售、行政四栏的可执行面板。", "Turn scattered operator notes into an owner dashboard with urgent actions and delegation."),
        starterPrompt: localizedText(
          "帮我用 convert-notes-to-dashboard 这个技能，把这些经营事项整理成一个老板日控板。",
          "Use the convert-notes-to-dashboard skill to turn these business notes into an owner dashboard.",
        ),
      },
    ],
    productCopy: {
      audience: localizedText("适合每天要同时盯钱、人、销售和行政的小团队老板。", "For small business owners juggling cash, people, sales, and admin every day."),
      resultTitle: localizedText("你会拿到一个老板日控板", "You will get an owner control board"),
      resultSummary: localizedText("Friday 会把零散经营事项收成优先级、 delegation 和今天不能拖的项目。", "Friday turns scattered operator issues into priorities, delegation, and a same-day owner control board."),
      entryPrompts: [
        {
          id: "owner-dashboard",
          label: localizedText("做老板面板", "Build an owner board"),
          prompt: localizedText("把这些经营事项整理成一个老板日控板，告诉我今天先抓什么。", "Turn these business issues into an owner dashboard and tell me what to focus on first today."),
        },
        {
          id: "delegate-vs-do",
          label: localizedText("区分谁来做", "Separate what to delegate"),
          prompt: localizedText("帮我区分哪些事情必须我自己做，哪些可以授权给团队。", "Separate what only I should handle from what I can delegate to the team."),
        },
        {
          id: "four-buckets",
          label: localizedText("按四栏排序", "Sort into four buckets"),
          prompt: localizedText("把招聘、财务、销售和行政事项分成优先级和处理顺序。", "Sort hiring, finance, sales, and admin issues into a clear priority order."),
        },
      ],
      deliverables: [
        {
          title: localizedText("老板四栏面板", "Four-column owner board"),
          detail: localizedText("钱、人、销售、行政四类问题的优先顺序。", "A four-bucket board across cash, people, sales, and admin."),
        },
        {
          title: localizedText("必须亲自抓的事", "Owner-only work"),
          detail: localizedText("哪些问题不能继续委派，必须老板本人决策。", "What cannot be delegated any further and needs the owner now."),
        },
        {
          title: localizedText("可授权动作", "Delegation brief"),
          detail: localizedText("哪些事情可以直接交给团队，并附带交代方式。", "What can be delegated immediately, with a cleaner handoff brief."),
        },
      ],
      assistantHandoff: {
        title: localizedText("把面板交给助手继续整理", "Hand the board to Assistant"),
        summary: localizedText("Assistant 会把老板面板压成更适合当天执行和团队分工的版本。", "Assistant turns the board into a cleaner execution and delegation handoff."),
        actionLabel: localizedText("去助手里整理执行版", "Turn it into an execution brief"),
      },
    },
  },
  {
    id: "industry-personal-investing",
    kind: "industry",
    builtIn: true,
    icon: TrendingUp,
    title: localizedText("个人投资", "Personal Investing"),
    summary: localizedText("聚合研究、观察和复盘，不碰自动交易。", "Organize research, watchlists, and reviews without automating trading."),
    defaultLauncher: { type: "wizard", wizardId: requireBuiltInPackCatalogEntry("industry-personal-investing").defaultWizardId },
    backingTemplateIds: ["invest-trade"],
    supportsContinueLast: true,
    curatedSkills: [
      {
        skillId: "chinese-investor-research-digest",
        title: localizedText("研究摘要", "Research Digest"),
        summary: localizedText("把市场笔记和观察池更新整理成中性的催化剂、风险和复盘问题。", "Turn market notes and watchlist updates into a neutral digest with catalysts, risks, and review questions."),
        starterPrompt: localizedText(
          "帮我用 chinese-investor-research-digest 这个技能，把这些市场笔记和观察池更新整理成中性研究摘要。",
          "Use the chinese-investor-research-digest skill to turn these market notes and watchlist updates into a neutral research digest.",
        ),
      },
    ],
    productCopy: {
      audience: localizedText("适合做研究、复盘和观察，但不希望自动交易的人。", "For people who want research, review, and watchlists without automated trading."),
      resultTitle: localizedText("你会拿到一份中性研究摘要", "You will get a neutral research digest"),
      resultSummary: localizedText("Friday 会把笔记、观察池和事件线索收成催化剂、风险和复盘问题，不碰交易执行。", "Friday turns notes, watchlists, and catalysts into a neutral digest with risks and review questions, without touching execution."),
      entryPrompts: [
        {
          id: "research-digest",
          label: localizedText("做研究摘要", "Build a research digest"),
          prompt: localizedText("把这些市场笔记和观察池更新整理成一份中性研究摘要。", "Turn these market notes and watchlist updates into a neutral research digest."),
        },
        {
          id: "catalyst-vs-risk",
          label: localizedText("拆分催化剂和风险", "Separate catalysts and risks"),
          prompt: localizedText("把这些事件线索拆成催化剂、风险和还需要验证的问题。", "Separate these event notes into catalysts, risks, and questions that still need validation."),
        },
        {
          id: "weekly-review",
          label: localizedText("做周复盘", "Build a weekly review"),
          prompt: localizedText("帮我把这周的观察和笔记整理成复盘清单和下周要继续盯的问题。", "Turn this week's watchlist notes into a review checklist and the questions to keep tracking next week."),
        },
      ],
      deliverables: [
        {
          title: localizedText("中性摘要", "Neutral digest"),
          detail: localizedText("不带仓位建议的研究要点和当前判断。", "A research digest without trade execution or position advice."),
        },
        {
          title: localizedText("催化剂与风险", "Catalysts and risks"),
          detail: localizedText("把利好、风险和待验证问题分开列清楚。", "A clean split between catalysts, risks, and open questions."),
        },
        {
          title: localizedText("复盘问题集", "Review checklist"),
          detail: localizedText("下周继续观察什么、哪些判断要复盘。", "What to keep watching next week and which assumptions to revisit."),
        },
      ],
      assistantHandoff: {
        title: localizedText("交给助手做复盘版", "Hand off to Assistant for review"),
        summary: localizedText("Assistant 会把摘要整理成更适合继续追踪和复盘的版本。", "Assistant turns the digest into a cleaner review handoff for continued tracking."),
        actionLabel: localizedText("去助手里继续复盘", "Continue in Assistant"),
      },
    },
  },
];

const TASK_ICON_FALLBACK: Record<string, LucideIcon> = {
  "build-new": Hammer,
  "fix-broken": Wrench,
  "ship-fast": Rocket,
  "understand-system": Activity,
  "automate-work": RefreshCcw,
  "content-social": PenTool,
  ecommerce: ShoppingCart,
  "team-management": Users,
  "ai-saas-build": Cpu,
  "invest-trade": TrendingUp,
};

const TASK_PACKS: FridayPackDefinition[] = FRIDAY_GOAL_CATEGORIES.map((category) => {
  const catalogEntry = requireBuiltInPackCatalogEntry(`task-${category.id}`);
  return {
    id: catalogEntry.packId,
    kind: catalogEntry.kind,
    builtIn: catalogEntry.builtIn,
    icon: TASK_ICON_FALLBACK[category.id] ?? category.icon,
    title: category.title,
    summary: category.subtitle,
    defaultLauncher: { type: "wizard" as const, wizardId: catalogEntry.defaultWizardId },
    backingTemplateIds: [catalogEntry.defaultWizardId],
    supportsContinueLast: true,
    curatedSkills: [],
    productCopy: null,
  };
});

export const FRIDAY_PACKS: FridayPackDefinition[] = [
  ...INDUSTRY_PACKS,
  ...TASK_PACKS,
];

const DEFAULT_WIDGET_ORDER = [
  "active_now",
  "pending_approvals",
  "scheduled_soon",
  "recent_results",
  "recommended_to_add",
] as const;

export type HomeWidgetId = (typeof DEFAULT_WIDGET_ORDER)[number];

export function getDefaultWidgetOrder(): HomeWidgetId[] {
  return [...DEFAULT_WIDGET_ORDER];
}

export function getDefaultVisibleWidgets(): HomeWidgetId[] {
  return ["active_now", "pending_approvals", "scheduled_soon"];
}

export function getPackById(packId: string): FridayPackDefinition | undefined {
  return FRIDAY_PACKS.find((pack) => pack.id === packId);
}

export function listPacksByKind(kind: FridayPackKind): FridayPackDefinition[] {
  return FRIDAY_PACKS.filter((pack) => pack.kind === kind);
}

export function getDefaultPinnedPackIds(profileType: UserProfileType): string[] {
  const defaultsByProfile: Record<UserProfileType, string[]> = {
    beginner: ["industry-creator-media", "task-content-social", "task-build-new"],
    creator: ["industry-creator-media", "task-content-social", "task-automate-work"],
    business: ["industry-cross-border-ecommerce", "task-ecommerce", "industry-small-business-owner"],
    developer: ["task-build-new", "task-fix-broken", "task-ship-fast"],
  };
  return defaultsByProfile[profileType];
}

export function sortPacksByStoredOrder(packIds: string[], order: string[]): string[] {
  const orderIndex = new Map(order.map((id, index) => [id, index] as const));
  return [...packIds].sort((left, right) => {
    const leftIndex = orderIndex.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = orderIndex.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}
