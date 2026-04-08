import type { LocalizedText } from "@/lib/i18n/localized-text";
import { localizedText } from "@/lib/i18n/localized-text";

export interface AgentOsNavItem {
  label: LocalizedText;
  path: string;
  description: LocalizedText;
}

export const AGENT_OS_NAV_PRIMARY: AgentOsNavItem[] = [
  {
    label: localizedText("首页", "Home"),
    path: "/home",
    description: localizedText("查看正在进行的事、待确认事项和你固定在首页的入口。", "See live work, pending approvals, and the packs pinned to your home."),
  },
  {
    label: localizedText("聊天", "Chat"),
    path: "/chat",
    description: localizedText("最快开始一个新任务，直接告诉 Friday 你要完成什么。", "Start a new task quickly by telling Friday what you want done."),
  },
  {
    label: localizedText("行业与任务", "Industry & Tasks"),
    path: "/packs",
    description: localizedText("浏览 Friday 自带的行业包和任务入口，并决定哪些加入首页。", "Browse built-in industry packs and task entries, then decide what appears on home."),
  },
  {
    label: localizedText("助手", "Assistant"),
    path: "/assistant",
    description: localizedText("集中查看审批、问题、恢复路径和最近运行证据。", "Focus on approvals, issues, recovery paths, and recent run evidence."),
  },
];

export const AGENT_OS_NAV_ADVANCED: AgentOsNavItem[] = [
  {
    label: localizedText("执行节点", "Fleet"),
    path: "/fleet",
    description: localizedText("查看卫星节点、任务放置、积压和分布式执行健康度。", "Satellites, placement, backlog, and distributed execution health."),
  },
  {
    label: localizedText("资产市场", "Marketplace"),
    path: "/marketplace",
    description: localizedText("浏览公开资产、支持创作者并发布定制需求。", "Browse public assets, support creators, and post custom requests."),
  },
  {
    label: localizedText("任务队列", "Task Queue"),
    path: "/automations",
    description: localizedText("管理定时任务、快速运行和队列状态。", "Scheduled work, quick runs, and queue control."),
  },
  {
    label: localizedText("记忆", "Memory"),
    path: "/memory",
    description: localizedText("查看、搜索并管理 Friday 记住了什么。", "View, search, and manage what Friday remembers about you."),
  },
  {
    label: localizedText("可观测性", "Observability"),
    path: "/observability",
    description: localizedText("查看 trace、审计、告警和系统健康。", "Trace, audit, alerts, and health for operator debugging."),
  },
  {
    label: localizedText("操作控制台", "Operator Console"),
    path: "/command-center",
    description: localizedText("进入实时系统控制台、远程会话和底层操作入口。", "Raw live system console, remote sessions, and low-level operator controls."),
  },
  {
    label: localizedText("设置", "Settings"),
    path: "/settings",
    description: localizedText("查看系统诊断、模型提供方和访问设置。", "System diagnostics, providers, and access surfaces."),
  },
];

/** Full list for backward compat. */
export const AGENT_OS_NAV_ITEMS: AgentOsNavItem[] = [
  ...AGENT_OS_NAV_PRIMARY,
  ...AGENT_OS_NAV_ADVANCED,
];

export function resolvePageTitle(pathname: string): LocalizedText {
  if (pathname === "/" || pathname === "/home") {
    return localizedText("首页", "Home");
  }
  if (pathname === "/chat") {
    return localizedText("聊天", "Chat");
  }
  if (pathname === "/packs") {
    return localizedText("行业与任务", "Industry & Tasks");
  }
  if (pathname.startsWith("/flow/")) {
    return localizedText("引导流程", "Guided Flow");
  }
  if (pathname.startsWith("/assistant")) {
    return localizedText("助手", "Assistant");
  }
  if (pathname.startsWith("/marketplace")) {
    return localizedText("资产市场", "Marketplace");
  }
  if (pathname.startsWith("/workflows")) {
    return localizedText("自动化", "Workflows");
  }
  if (pathname.startsWith("/skills")) {
    return localizedText("能力包", "Skills");
  }
  if (pathname.startsWith("/fleet")) {
    return localizedText("执行节点", "Fleet");
  }
  if (pathname.startsWith("/automations")) {
    return localizedText("任务队列", "Task Queue");
  }
  if (pathname.startsWith("/observability")) {
    return localizedText("可观测性", "Observability");
  }
  if (pathname.startsWith("/settings")) {
    return localizedText("设置", "Settings");
  }
  if (pathname.startsWith("/memory")) {
    return localizedText("记忆", "Memory");
  }
  if (pathname.startsWith("/command-center") || pathname.startsWith("/sessions")) {
    return localizedText("操作控制台", "Operator Console");
  }
  if (pathname.startsWith("/login")) {
    return localizedText("访问", "Access");
  }
  if (pathname.startsWith("/setup")) {
    return localizedText("设置向导", "Setup");
  }
  return localizedText("Friday 助手系统", "Friday Agent OS");
}
