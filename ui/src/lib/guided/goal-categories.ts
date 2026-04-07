import {
  Activity,
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
import type { UserProfileType } from "@/hooks/use-user-profile";
import type { LocalizedText } from "@/lib/i18n/localized-text";
import { localizedText } from "@/lib/i18n/localized-text";

export interface FridayGoalCategory {
  id: string;
  icon: LucideIcon;
  title: LocalizedText;
  subtitle: LocalizedText;
  outcome: LocalizedText;
  wizardId: string;
  profilePriority: Partial<Record<UserProfileType, number>>;
  recommended?: boolean;
}

export const FRIDAY_GOAL_CATEGORIES: FridayGoalCategory[] = [
  {
    id: "build-new",
    icon: Hammer,
    title: localizedText("做一个新东西", "Build Something New"),
    subtitle: localizedText(
      "从想法到实现，Friday 会一步步帮你规划并落地。",
      "From idea to implementation, Friday helps you plan and build step by step.",
    ),
    outcome: localizedText(
      "得到一个可执行的方案，并尽可能把想法真正做出来。",
      "Get a concrete plan and a working implementation of your idea.",
    ),
    wizardId: "build-new",
    profilePriority: { developer: 1, creator: 5, business: 6, beginner: 3 },
    recommended: true,
  },
  {
    id: "fix-broken",
    icon: Wrench,
    title: localizedText("修好出问题的地方", "Fix What Is Broken"),
    subtitle: localizedText(
      "Friday 会先诊断问题，再给出修复方案并执行验证。",
      "Friday diagnoses the problem, suggests fixes, and executes the repair.",
    ),
    outcome: localizedText(
      "明确根因，并在验证通过后完成修复。",
      "Get the root cause identified and the fix applied with verification.",
    ),
    wizardId: "fix-broken",
    profilePriority: { developer: 2, creator: 8, business: 7, beginner: 5 },
  },
  {
    id: "ship-fast",
    icon: Rocket,
    title: localizedText("发布并上线", "Ship And Release"),
    subtitle: localizedText(
      "把 QA 检查、发布说明和部署验证收在一条流程里。",
      "Keep QA checks, release docs, and deploy verification in one flow.",
    ),
    outcome: localizedText(
      "交付一个带文档、带验证证据的发布结果。",
      "Get a verified release with documentation and deploy evidence.",
    ),
    wizardId: "ship-fast",
    profilePriority: { developer: 3, creator: 9, business: 8, beginner: 7 },
  },
  {
    id: "understand-system",
    icon: Activity,
    title: localizedText("看懂我的系统现在怎么样", "Understand My System"),
    subtitle: localizedText(
      "做一次健康检查，整理可观测性快照，并说明到底发生了什么。",
      "Get a health check, observability snapshot, and a clear report of what is happening.",
    ),
    outcome: localizedText(
      "拿到一份结构化系统健康报告和下一步动作建议。",
      "Receive a structured system health report with actionable next steps.",
    ),
    wizardId: "understand-system",
    profilePriority: { developer: 4, creator: 10, business: 5, beginner: 8 },
  },
  {
    id: "automate-work",
    icon: RefreshCcw,
    title: localizedText("把重复工作自动化", "Automate Repetitive Work"),
    subtitle: localizedText(
      "把手工操作变成能按计划运行的自动流程。",
      "Turn manual operations into automated workflows that run on schedule.",
    ),
    outcome: localizedText(
      "部署一条能稳定接管重复任务的自动化流程。",
      "Deploy an automation that handles the task without manual intervention.",
    ),
    wizardId: "automate-work",
    profilePriority: { developer: 5, creator: 3, business: 3, beginner: 4 },
  },
  {
    id: "content-social",
    icon: PenTool,
    title: localizedText("做内容并运营社媒", "Create Content And Run Social Media"),
    subtitle: localizedText(
      "围绕小红书、抖音、X 等平台做内容生成、排期和分发。",
      "Create, schedule, and publish across platforms like Xiaohongshu, TikTok, and more.",
    ),
    outcome: localizedText(
      "产出可发布的内容，并整理成适合多平台执行的计划。",
      "Produce content, schedule it, and distribute it across your chosen platforms.",
    ),
    wizardId: "content-social",
    profilePriority: { developer: 9, creator: 1, business: 4, beginner: 2 },
    recommended: true,
  },
  {
    id: "ecommerce",
    icon: ShoppingCart,
    title: localizedText("跨境电商与多平台运营", "Ecommerce And Cross-border Trade"),
    subtitle: localizedText(
      "把选品、平台比较、数据监控和日常运营整合到一个入口里。",
      "Handle product selection, platform comparison, data monitoring, and full-process operations.",
    ),
    outcome: localizedText(
      "用清晰的数据判断和动作清单推进多平台店铺运营。",
      "Make clear data-driven decisions with coordinated operations across platforms.",
    ),
    wizardId: "ecommerce",
    profilePriority: { developer: 8, creator: 4, business: 1, beginner: 6 },
    recommended: true,
  },
  {
    id: "team-management",
    icon: Users,
    title: localizedText("带团队推进事情", "Manage A Team"),
    subtitle: localizedText(
      "整理任务分配、进度追踪和跨团队协作流程。",
      "Coordinate task assignment, progress tracking, and team collaboration workflows.",
    ),
    outcome: localizedText(
      "让任务归属、进度和交接都更清楚。",
      "Build a team workflow with clear ownership and visible progress.",
    ),
    wizardId: "team-management",
    profilePriority: { developer: 7, creator: 7, business: 2, beginner: 9 },
  },
  {
    id: "ai-saas-build",
    icon: Cpu,
    title: localizedText("做一个 AI 应用或 SaaS", "Build An AI App Or SaaS"),
    subtitle: localizedText(
      "从概念、架构、实现到部署，推进你的 AI 产品上线。",
      "Move from concept to launch with architecture, implementation, and deployment.",
    ),
    outcome: localizedText(
      "得到一个能给用户使用的 AI 应用或 SaaS。",
      "End up with a working AI application or SaaS ready for users.",
    ),
    wizardId: "ai-saas-build",
    profilePriority: { developer: 6, creator: 6, business: 9, beginner: 10 },
  },
  {
    id: "invest-trade",
    icon: TrendingUp,
    title: localizedText("做投资研究与交易准备", "Investment And Trading Automation"),
    subtitle: localizedText(
      "围绕研究、观察、策略准备和数据整理建立稳定流程。",
      "Organize research analysis, strategy preparation, and data-driven insights.",
    ),
    outcome: localizedText(
      "得到结构化研究和可复用的观察流程，不把交易执行黑箱化。",
      "Create structured research and reusable workflows for investment preparation.",
    ),
    wizardId: "invest-trade",
    profilePriority: { developer: 10, creator: 8, business: 10, beginner: 1 },
  },
];

export function getGoalCategoriesForProfile(
  profileType: UserProfileType,
  limit?: number,
): FridayGoalCategory[] {
  const sorted = [...FRIDAY_GOAL_CATEGORIES].sort((a, b) => {
    const aPriority = a.profilePriority[profileType] ?? 50;
    const bPriority = b.profilePriority[profileType] ?? 50;
    return aPriority - bPriority;
  });

  return limit ? sorted.slice(0, limit) : sorted;
}

export function getGoalCategoryById(id: string): FridayGoalCategory | undefined {
  return FRIDAY_GOAL_CATEGORIES.find((category) => category.id === id);
}
