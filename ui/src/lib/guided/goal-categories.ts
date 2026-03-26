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

export interface FridayGoalCategory {
  id: string;
  icon: LucideIcon;
  title: string;
  subtitle: string;
  outcome: string;
  wizardId: string;
  profilePriority: Partial<Record<UserProfileType, number>>;
  recommended?: boolean;
}

export const FRIDAY_GOAL_CATEGORIES: FridayGoalCategory[] = [
  {
    id: "build-new",
    icon: Hammer,
    title: "Build something new",
    subtitle: "From idea to implementation. Friday helps you plan and build step by step.",
    outcome: "A concrete plan and working implementation of your idea.",
    wizardId: "build-new",
    profilePriority: { developer: 1, creator: 5, business: 6, beginner: 3 },
    recommended: true,
  },
  {
    id: "fix-broken",
    icon: Wrench,
    title: "Fix what's broken",
    subtitle: "Friday diagnoses the problem, suggests fixes, and executes the repair.",
    outcome: "Root cause identified and fix applied with verification.",
    wizardId: "fix-broken",
    profilePriority: { developer: 2, creator: 8, business: 7, beginner: 5 },
  },
  {
    id: "ship-fast",
    icon: Rocket,
    title: "Ship & release",
    subtitle: "QA checks, release docs, deploy verification — all in one flow.",
    outcome: "Verified release with documentation and deploy evidence.",
    wizardId: "ship-fast",
    profilePriority: { developer: 3, creator: 9, business: 8, beginner: 7 },
  },
  {
    id: "understand-system",
    icon: Activity,
    title: "Understand my system",
    subtitle: "Health check, observability snapshot, and clear report of what's happening.",
    outcome: "A structured system health report with actionable next steps.",
    wizardId: "understand-system",
    profilePriority: { developer: 4, creator: 10, business: 5, beginner: 8 },
  },
  {
    id: "automate-work",
    icon: RefreshCcw,
    title: "Automate repetitive work",
    subtitle: "Turn manual operations into automated workflows that run on schedule.",
    outcome: "A deployed automation that handles the task without manual intervention.",
    wizardId: "automate-work",
    profilePriority: { developer: 5, creator: 3, business: 3, beginner: 4 },
  },
  {
    id: "content-social",
    icon: PenTool,
    title: "Create content & run social media",
    subtitle: "Create, schedule, and publish across platforms like Xiaohongshu, TikTok, and more.",
    outcome: "Content created, scheduled, and distributed across your chosen platforms.",
    wizardId: "content-social",
    profilePriority: { developer: 9, creator: 1, business: 4, beginner: 2 },
    recommended: true,
  },
  {
    id: "ecommerce",
    icon: ShoppingCart,
    title: "E-commerce & cross-border trade",
    subtitle: "Product selection, platform comparison, data monitoring, and full process automation.",
    outcome: "Clear data-driven decisions with automated operations across platforms.",
    wizardId: "ecommerce",
    profilePriority: { developer: 8, creator: 4, business: 1, beginner: 6 },
    recommended: true,
  },
  {
    id: "team-management",
    icon: Users,
    title: "Manage a team",
    subtitle: "Task assignment, progress tracking, and team collaboration workflows.",
    outcome: "Organized team workflow with clear task ownership and progress visibility.",
    wizardId: "team-management",
    profilePriority: { developer: 7, creator: 7, business: 2, beginner: 9 },
  },
  {
    id: "ai-saas-build",
    icon: Cpu,
    title: "Build an AI app / SaaS",
    subtitle: "From concept to launch — architecture, implementation, and deployment of your AI product.",
    outcome: "A working AI application or SaaS ready for users.",
    wizardId: "ai-saas-build",
    profilePriority: { developer: 6, creator: 6, business: 9, beginner: 10 },
  },
  {
    id: "invest-trade",
    icon: TrendingUp,
    title: "Investment & trading automation",
    subtitle: "Research analysis, trading strategy automation, and data-driven insights.",
    outcome: "Automated research and trading workflows with structured data analysis.",
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
