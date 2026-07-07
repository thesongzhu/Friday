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
    label: localizedText("Studio", "Studio"),
    path: "/studio",
    description: localizedText("从 SEO、报告、PPT、小程序、引导和集成入口直接生成交付件。", "Generate deliverables from SEO, research, slides, mini apps, guided flows, and integrations."),
  },
  {
    label: localizedText("助手", "Assistant"),
    path: "/assistant",
    description: localizedText("集中查看审批、问题、恢复路径和最近运行证据。", "Focus on approvals, issues, recovery paths, and recent run evidence."),
  },
];

// Ordered by cognitive flow: create → manage → monitor → configure
export const AGENT_OS_NAV_ADVANCED: AgentOsNavItem[] = [
  // ── Channels ──
  {
    label: localizedText("渠道", "Channels"),
    path: "/channels",
    description: localizedText("监控和管理 Friday 在 Discord、Telegram、Slack 等平台上的对话。", "Monitor and manage Friday's conversations across Discord, Telegram, Slack, and more."),
  },
  // ── Create & Build ──
  {
    label: localizedText("行业与任务", "Industry & Tasks"),
    path: "/packs",
    description: localizedText("管理你自创和导入的任务定义，并把真实运行入口固定到首页。", "Manage custom and imported task definitions and pin live execution entry points back to home."),
  },
  {
    label: localizedText("能力包", "Skills"),
    path: "/skills",
    description: localizedText("查看、管理和生成 Friday 可调用的能力包。", "View, manage, and generate callable skill packs for Friday."),
  },
  {
    label: localizedText("插件", "Plugins"),
    path: "/plugins",
    description: localizedText("查看真实插件库存、启停状态和本地安装入口。", "Inspect live plugin inventory, enablement state, and local install entry."),
  },
  {
    label: localizedText("提供方", "Providers & auth"),
    path: "/providers",
    description: localizedText("查看提供方认证、能力 parity、队列和路由真值。", "Inspect provider auth, capability parity, queues, and routing truth."),
  },
  {
    label: localizedText("工作流", "Workflows"),
    path: "/workflows",
    description: localizedText("部署、编辑和监控自动化工作流。", "Deploy, edit, and monitor automation workflows."),
  },
  // ── Manage ──
  {
    label: localizedText("任务队列", "Task Queue"),
    path: "/automations",
    description: localizedText("管理定时任务、快速运行和队列状态。", "Scheduled work, quick runs, and queue control."),
  },
  {
    label: localizedText("记忆", "Memory"),
    path: "/memory",
    description: localizedText("Memory Passport：查看、搜索并管理 Friday 记住了什么；候选和召回证明保持边界态。", "Memory Passport: view, search, and manage stored memory; candidate and recall proof stay boundary-only."),
  },
  {
    label: localizedText("成长中心", "Reflex"),
    path: "/reflex",
    description: localizedText("审批 Friday 学到的候选、首次 onboarding 和跨渠道偏好。", "Review what Friday learned, first-run onboarding, and cross-channel preferences."),
  },
  {
    label: localizedText("MCP 服务", "MCP"),
    path: "/mcp",
    description: localizedText("查看已连接的 MCP 服务器和工具扩展状态。", "View connected MCP servers and tool extension status."),
  },
  // ── Monitor ──
  {
    label: localizedText("执行节点", "Fleet"),
    path: "/fleet",
    description: localizedText("查看执行节点、队列影响和恢复动作。", "Inspect execution nodes, queue impact, and recovery actions."),
  },
  {
    label: localizedText("云端 Worker", "Cloud Workers"),
    path: "/cloud-workers",
    description: localizedText("用户自有云 Worker 的设置目录、部署包、DNS 校验、体检和拆机回执。", "User-owned cloud worker setup catalog, deployment package, DNS validation, doctor, and teardown receipts."),
  },
  {
    label: localizedText("可观测性", "Observability"),
    path: "/observability",
    description: localizedText("查看运行事件、告警、审计和恢复证据。", "Review runtime events, alerts, audit trails, and recovery evidence."),
  },
  {
    label: localizedText("证据", "Evidence"),
    path: "/evidence",
    description: localizedText("搜索证据引用、检查回执车道和服务端脱敏原文。", "Search evidence refs, inspect receipt lanes, and review server-redacted raw refs."),
  },
  {
    label: localizedText("任务工作台", "Mission Workbench"),
    path: "/mission-workbench",
    description: localizedText("查看任务、工作项、证据引用和受限时间线。", "Inspect Missions, WorkItems, proof refs, and bounded timeline rows."),
  },
  {
    label: localizedText("操作控制台", "Operator Console"),
    path: "/command-center",
    description: localizedText("查看活跃运行、实时事件和操作级恢复入口。", "Inspect active runs, live events, and operator recovery entry points."),
  },
  {
    label: localizedText("用量与成本", "Usage"),
    path: "/usage",
    description: localizedText("查看请求量、估算成本和提供方健康度。", "Request volume, estimated costs, and provider health."),
  },
  {
    label: localizedText("会话", "Sessions"),
    path: "/sessions",
    description: localizedText("浏览和导出 Friday 的会话与对话历史。", "Browse and export Friday session and transcript history."),
  },
  {
    label: localizedText("安全设置", "Settings Security"),
    path: "/settings",
    description: localizedText("集中查看提供方认证、桌面权限、安全发现和 operator 门边界。", "Review provider auth, desktop permissions, security findings, and operator-gated boundaries."),
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
  if (pathname === "/studio") {
    return localizedText("Studio", "Studio");
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
  if (pathname.startsWith("/workflows")) {
    return localizedText("自动化", "Workflows");
  }
  if (pathname.startsWith("/plugins")) {
    return localizedText("插件", "Plugins");
  }
  if (pathname.startsWith("/providers")) {
    return localizedText("提供方", "Providers & auth");
  }
  if (pathname.startsWith("/skills")) {
    return localizedText("能力包", "Skills");
  }
  if (pathname.startsWith("/fleet")) {
    return localizedText("执行节点", "Fleet");
  }
  if (pathname.startsWith("/cloud-workers")) {
    return localizedText("云端 Worker", "Cloud Workers");
  }
  if (pathname.startsWith("/automations")) {
    return localizedText("任务队列", "Task Queue");
  }
  if (pathname.startsWith("/observability")) {
    return localizedText("可观测性", "Observability");
  }
  if (pathname.startsWith("/evidence")) {
    return localizedText("证据", "Evidence");
  }
  if (pathname.startsWith("/mission-workbench")) {
    return localizedText("任务工作台", "Mission Workbench");
  }
  if (pathname.startsWith("/channels")) {
    return localizedText("渠道", "Channels");
  }
  if (pathname.startsWith("/settings")) {
    return localizedText("安全设置", "Settings Security");
  }
  if (pathname.startsWith("/memory")) {
    return localizedText("记忆", "Memory");
  }
  if (pathname.startsWith("/reflex")) {
    return localizedText("成长中心", "Reflex");
  }
  if (pathname.startsWith("/sessions")) {
    return localizedText("会话", "Sessions");
  }
  if (pathname.startsWith("/mcp")) {
    return localizedText("MCP 服务", "MCP Servers");
  }
  if (pathname.startsWith("/usage")) {
    return localizedText("用量与成本", "Usage & Cost");
  }
  if (pathname.startsWith("/command-center")) {
    return localizedText("操作控制台", "Operator Console");
  }
  if (pathname.startsWith("/setup")) {
    return localizedText("设置向导", "Setup");
  }
  return localizedText("Friday 助手系统", "Friday Agent OS");
}
