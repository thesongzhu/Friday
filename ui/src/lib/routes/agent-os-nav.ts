export interface AgentOsNavItem {
  label: string;
  path: string;
  description: string;
}

/** Primary nav — always visible. */
export const AGENT_OS_NAV_PRIMARY: AgentOsNavItem[] = [
  {
    label: "Chat",
    path: "/chat",
    description: "Talk to Friday — ask anything or give it a task",
  },
  {
    label: "Home",
    path: "/home",
    description: "Goal-first starting point with guided flows",
  },
  {
    label: "Skills",
    path: "/skills",
    description: "Catalog, verification, trust, and lifecycle control",
  },
  {
    label: "Workflows",
    path: "/workflows",
    description: "Deploy, run, export, and inspect workflow state in depth",
  },
];

/** Advanced nav — collapsed by default for beginners. */
export const AGENT_OS_NAV_ADVANCED: AgentOsNavItem[] = [
  {
    label: "Assistant",
    path: "/assistant",
    description: "Full dashboard for goals, plans, actions, and issue recovery",
  },
  {
    label: "Fleet",
    path: "/fleet",
    description: "Satellites, placement, backlog, and distributed execution health",
  },
  {
    label: "Marketplace",
    path: "/marketplace",
    description: "Browse public assets, support creators, and post custom requests",
  },
  {
    label: "Task Queue",
    path: "/automations",
    description: "Scheduled work, quick runs, and queue control",
  },
  {
    label: "Observability",
    path: "/observability",
    description: "Trace, audit, alerts, and health for operator debugging",
  },
  {
    label: "Operator Console",
    path: "/command-center",
    description: "Raw live system console, remote sessions, and low-level operator controls",
  },
  {
    label: "Settings",
    path: "/settings",
    description: "System diagnostics, providers, and access surfaces",
  },
];

/** Full list for backward compat. */
export const AGENT_OS_NAV_ITEMS: AgentOsNavItem[] = [
  ...AGENT_OS_NAV_PRIMARY,
  ...AGENT_OS_NAV_ADVANCED,
];

export function resolvePageTitle(pathname: string): string {
  if (pathname === "/chat") {
    return "Chat";
  }
  if (pathname === "/" || pathname === "/home") {
    return "Home";
  }
  if (pathname.startsWith("/flow/")) {
    return "Guided Flow";
  }
  if (pathname.startsWith("/assistant")) {
    return "Assistant";
  }
  if (pathname.startsWith("/marketplace")) {
    return "Marketplace";
  }
  if (pathname.startsWith("/workflows")) {
    return "Workflows";
  }
  if (pathname.startsWith("/skills")) {
    return "Skills";
  }
  if (pathname.startsWith("/fleet")) {
    return "Fleet";
  }
  if (pathname.startsWith("/automations")) {
    return "Task Queue";
  }
  if (pathname.startsWith("/observability")) {
    return "Observability";
  }
  if (pathname.startsWith("/settings")) {
    return "Settings";
  }
  if (pathname.startsWith("/command-center") || pathname.startsWith("/sessions") || pathname.startsWith("/memory")) {
    return "Operator Console";
  }
  if (pathname.startsWith("/login")) {
    return "Access";
  }
  if (pathname.startsWith("/setup")) {
    return "Setup";
  }
  return "Friday Agent OS";
}
