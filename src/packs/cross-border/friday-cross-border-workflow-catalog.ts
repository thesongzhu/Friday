import type { FridayAgentTaskProfileId } from "../../agent/runtime/friday-agent-task-profile.js";
import type {
  FridayCrossBorderLocalizedText,
  FridayCrossBorderWorkflowId,
  FridayCrossBorderWorkflowTemplateId,
} from "./friday-cross-border-pack.types.js";

export interface FridayCrossBorderWorkflowCatalogEntry {
  workflowId: FridayCrossBorderWorkflowId;
  templateId: FridayCrossBorderWorkflowTemplateId;
  cadence: "daily" | "weekly";
  titleZh: string;
  titleEn: string;
  templateName: string;
  templateDescription: string;
  primarySkillId: string;
  primaryInputKey: string;
  followupSkillId?: string;
  followupInputKey?: string;
  taskProfileId: FridayAgentTaskProfileId;
  tags: string[];
  defaultCadence: {
    cron: string;
    summary: FridayCrossBorderLocalizedText;
  };
  pauseConditions: FridayCrossBorderLocalizedText[];
  approvalBoundaries: FridayCrossBorderLocalizedText[];
}

function ruleText(zh: string, en: string): FridayCrossBorderLocalizedText {
  return { zh, en };
}

const FRIDAY_CROSS_BORDER_WORKFLOW_CATALOG: FridayCrossBorderWorkflowCatalogEntry[] = [
  {
    workflowId: "daily-store-health-check",
    templateId: "builtin-cross-border-daily-store-health-check",
    cadence: "daily",
    titleZh: "每日店铺晨检",
    titleEn: "Daily Store Health Check",
    templateName: "Cross-border Daily Store Health Check",
    templateDescription: "Review store health notes, cluster operational risks, and produce the daily action board for TikTok Shop or Amazon.",
    primarySkillId: "summarize-shop-performance",
    primaryInputKey: "performanceNotes",
    taskProfileId: "deterministic",
    tags: ["cross-border", "daily", "store-health"],
    defaultCadence: {
      cron: "0 9 * * *",
      summary: ruleText("每天 09:00 按用户本地时区执行。", "Runs daily at 09:00 in the user’s local timezone."),
    },
    pauseConditions: [
      ruleText("店铺暂时停运、没有订单窗口，且连续 14 天没有新的店铺健康输入时，建议暂停。", "Pause when the store is effectively idle and there has been no new store-health input for 14 days."),
      ruleText("如果经营重心临时切到清仓或关店，先暂停晨检，再改 operating profile。", "Pause when the operating focus has shifted to liquidation or shutdown and update the operating profile first."),
    ],
    approvalBoundaries: [
      ruleText("涉及退货退款政策、履约模式切换、客服 SLA 承诺调整时，必须人工确认。", "Require approval before changing return/refund policy, fulfillment mode, or customer-response promises."),
      ruleText("涉及大幅调整广告预算或暂停核心投放时，必须人工确认。", "Require approval before materially changing ad budgets or pausing core spend."),
    ],
  },
  {
    workflowId: "daily-category-top10-watch",
    templateId: "builtin-cross-border-daily-category-top10-watch",
    cadence: "daily",
    titleZh: "每日类目 Top 10 监控",
    titleEn: "Daily Category Top 10 Watch",
    templateName: "Cross-border Daily Category Top 10 Watch",
    templateDescription: "Track Top 10 category movement, seller shifts, pricing changes, and visible creative updates in the chosen L1/L2 category.",
    primarySkillId: "cross-border-top-category-watch",
    primaryInputKey: "categoryWatchNotes",
    taskProfileId: "deterministic",
    tags: ["cross-border", "daily", "category-watch"],
    defaultCadence: {
      cron: "0 11 * * *",
      summary: ruleText("每天 11:00 按用户本地时区执行。", "Runs daily at 11:00 in the user’s local timezone."),
    },
    pauseConditions: [
      ruleText("类目焦点已切换但 watch target 还没改完时，先暂停。", "Pause when the category focus has changed but the watch targets have not been updated yet."),
      ruleText("如果当前经营深度设为 lean，且连续 10 天没有任何类目或公开页面种子输入，建议暂停。", "Pause when monitoring depth is lean and there have been no category or public-page seeds for 10 days."),
    ],
    approvalBoundaries: [
      ruleText("把竞品卖点、图文结构直接改成自家素材前，必须人工确认并做合规判断。", "Require approval before turning competitor positioning or creative structure into your own listing changes."),
      ruleText("新增大量 watch target 或扩到新类目前，必须人工确认。", "Require approval before adding many new watch targets or expanding into a new category."),
    ],
  },
  {
    workflowId: "daily-price-gap-watch",
    templateId: "builtin-cross-border-daily-price-gap-watch",
    cadence: "daily",
    titleZh: "每日价格带差异监控",
    titleEn: "Daily Price Gap Watch",
    templateName: "Cross-border Daily Price Gap Watch",
    templateDescription: "Compare price band, coupon stacks, shipping promise, and bundle framing before deciding whether to match or hold.",
    primarySkillId: "cross-border-price-match-review",
    primaryInputKey: "priceSignals",
    taskProfileId: "deterministic",
    tags: ["cross-border", "daily", "pricing"],
    defaultCadence: {
      cron: "0 14 * * *",
      summary: ruleText("每天 14:00 按用户本地时区执行。", "Runs daily at 14:00 in the user’s local timezone."),
    },
    pauseConditions: [
      ruleText("没有直接竞品清单、没有价格带输入时，建议先暂停。", "Pause until you have a direct competitor set or at least one reliable price signal."),
      ruleText("如果当前价格策略被冻结，例如大促保护期或品牌控价期，建议暂停。", "Pause when pricing is intentionally frozen, such as during a major promo lock period or brand pricing hold."),
    ],
    approvalBoundaries: [
      ruleText("任何跟价、调券、运费补贴、组合包重构都必须人工确认。", "Require approval for any price match, coupon change, shipping subsidy, or bundle reframing."),
      ruleText("如果 listing 质量明显更弱，禁止自动跟价，必须人工确认后决定。", "Do not match price automatically when listing quality is weaker; require human review first."),
    ],
  },
  {
    workflowId: "daily-customer-service-sweep",
    templateId: "builtin-cross-border-daily-customer-service-sweep",
    cadence: "daily",
    titleZh: "每日客服售后清扫",
    titleEn: "Daily Customer Service Sweep",
    templateName: "Cross-border Daily Customer Service Sweep",
    templateDescription: "Cluster refunds, returns, complaints, and bad-review notes into a support brief with response strategy and escalation guidance.",
    primarySkillId: "cross-border-customer-service-brief",
    primaryInputKey: "serviceNotes",
    taskProfileId: "deterministic",
    tags: ["cross-border", "daily", "support"],
    defaultCadence: {
      cron: "0 18 * * *",
      summary: ruleText("每天 18:00 按用户本地时区执行。", "Runs daily at 18:00 in the user’s local timezone."),
    },
    pauseConditions: [
      ruleText("客服完全外包且连续 7 天没有新的客服/售后摘要输入时，建议暂停。", "Pause when support is fully outsourced and there has been no new support digest for 7 days."),
      ruleText("如果店铺当前没有客服量或售后压力，先暂停并按周复盘即可。", "Pause when support volume is negligible and a weekly review is sufficient."),
    ],
    approvalBoundaries: [
      ruleText("退款不退货、补偿、例外判责、升级到平台申诉前，必须人工确认。", "Require approval before refund-without-return, compensation, exception handling, or platform escalation."),
      ruleText("任何会影响店铺政策口径的回复模板变更，必须人工确认。", "Require approval before changing reply templates that alter policy positioning."),
    ],
  },
  {
    workflowId: "weekly-hot-product-review",
    templateId: "builtin-cross-border-weekly-hot-product-review",
    cadence: "weekly",
    titleZh: "每周爆发商品复盘",
    titleEn: "Weekly Hot Product Review",
    templateName: "Cross-border Weekly Hot Product Review",
    templateDescription: "Detect products that spiked recently, then screen whether they are worth following or should stay off the roadmap.",
    primarySkillId: "cross-border-spike-detector",
    primaryInputKey: "spikeSignals",
    followupSkillId: "cross-border-product-scout",
    followupInputKey: "marketSignals",
    taskProfileId: "review",
    tags: ["cross-border", "weekly", "product-scout"],
    defaultCadence: {
      cron: "0 10 * * 1",
      summary: ruleText("每周一 10:00 按用户本地时区执行。", "Runs every Monday at 10:00 in the user’s local timezone."),
    },
    pauseConditions: [
      ruleText("连续 10 天没有新的类目或公开页面种子输入时，建议暂停。", "Pause when there have been no new category or public-page seeds for 10 days."),
      ruleText("如果当前经营深度设为 lean，且选品不在本周重点，建议暂停。", "Pause when monitoring depth is lean and product scouting is not a priority this week."),
    ],
    approvalBoundaries: [
      ruleText("任何新增打样、备货、上新决策都必须人工确认。", "Require approval before sampling, procurement, or launch decisions."),
      ruleText("只能输出可跟进方向和人工复核清单，不能自动复制竞品素材或上架。", "This workflow may only produce follow-up directions and review checklists; it must not auto-copy competitor assets or auto-list products."),
    ],
  },
  {
    workflowId: "weekly-operating-profile-tune",
    templateId: "builtin-cross-border-weekly-operating-profile-tune",
    cadence: "weekly",
    titleZh: "每周经营系统调优",
    titleEn: "Weekly Operating Profile Tune",
    templateName: "Cross-border Weekly Operating Profile Tune",
    templateDescription: "Turn the week's operating signals into keep/change/stop guidance so the daily routine does not stay stale.",
    primarySkillId: "cross-border-weekly-growth-review",
    primaryInputKey: "weeklySignals",
    followupSkillId: "cross-border-listing-image-layout-audit",
    followupInputKey: "listingNotes",
    taskProfileId: "review",
    tags: ["cross-border", "weekly", "operating-profile"],
    defaultCadence: {
      cron: "0 17 * * 5",
      summary: ruleText("每周五 17:00 按用户本地时区执行。", "Runs every Friday at 17:00 in the user’s local timezone."),
    },
    pauseConditions: [
      ruleText("第一个 7 天调优窗口还没到之前，建议先暂停。", "Hold this workflow until the first 7-day tuning window is reached."),
      ruleText("最近 7 天没有足够的新经营信号时，建议暂停，避免用旧数据调流程。", "Pause when there are not enough fresh operating signals in the last 7 days; do not tune on stale data."),
    ],
    approvalBoundaries: [
      ruleText("停用核心 daily workflow、提高自动化强度、改变节奏前，必须人工确认。", "Require approval before disabling a core daily workflow, increasing automation scope, or materially changing cadence."),
      ruleText("任何会改变价格、售后或 listing 执行边界的调优建议，都必须人工确认。", "Require approval before adopting tuning suggestions that change pricing, support, or listing execution boundaries."),
    ],
  },
];

export function listFridayCrossBorderWorkflowCatalog(): FridayCrossBorderWorkflowCatalogEntry[] {
  return [...FRIDAY_CROSS_BORDER_WORKFLOW_CATALOG];
}

export function getFridayCrossBorderWorkflowCatalogEntry(
  workflowId: FridayCrossBorderWorkflowId,
): FridayCrossBorderWorkflowCatalogEntry {
  const entry = FRIDAY_CROSS_BORDER_WORKFLOW_CATALOG.find((item) => item.workflowId === workflowId);
  if (!entry) {
    throw new Error(`Unknown cross-border workflowId '${workflowId}'`);
  }
  return entry;
}

export function getFridayCrossBorderWorkflowCatalogEntryByTemplateId(
  templateId: FridayCrossBorderWorkflowTemplateId,
): FridayCrossBorderWorkflowCatalogEntry {
  const entry = FRIDAY_CROSS_BORDER_WORKFLOW_CATALOG.find((item) => item.templateId === templateId);
  if (!entry) {
    throw new Error(`Unknown cross-border workflow templateId '${templateId}'`);
  }
  return entry;
}

export function listFridayCrossBorderWorkflowTemplateIds(): FridayCrossBorderWorkflowTemplateId[] {
  return FRIDAY_CROSS_BORDER_WORKFLOW_CATALOG.map((item) => item.templateId);
}
