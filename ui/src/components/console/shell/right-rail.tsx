import { useMemo, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { AssistantRightRailSlot } from "./right-rail-slots/assistant";
import { AutomationsRightRailSlot } from "./right-rail-slots/automations";
import { ChannelsRightRailSlot } from "./right-rail-slots/channels";
import { ChatCollapsedRightRailSlot } from "./right-rail-slots/chat-collapsed";
import { HomeRightRailSlot } from "./right-rail-slots/home";
import { PacksRightRailSlot } from "./right-rail-slots/packs";
import { SessionsRightRailSlot } from "./right-rail-slots/sessions";
import { SettingsProvidersRightRailSlot } from "./right-rail-slots/settings-providers";
import { UsageRightRailSlot } from "./right-rail-slots/usage";
import { WorkflowsRightRailSlot } from "./right-rail-slots/workflows";

type RightRailWidth = "full" | "compact" | "collapsed" | "none";

interface RightRailContract {
  width: RightRailWidth;
  render: () => ReactNode;
  ariaLabel: string;
}

/**
 * Route-to-slot map. Phase 1 hardcodes the nine surfaces promised by the brief
 * (home / chat-collapsed / assistant / packs / workflows / channels /
 * automations / sessions / usage / settings). Phase 2 migrates this table into
 * route `handle` fields so per-route modules own their inspector strategy.
 */
function resolveContract(pathname: string): RightRailContract {
  if (pathname === "/home") {
    return {
      width: "full",
      render: () => <HomeRightRailSlot />,
      ariaLabel: "Home shortcuts",
    };
  }
  if (pathname === "/chat") {
    return {
      width: "collapsed",
      render: () => <ChatCollapsedRightRailSlot />,
      ariaLabel: "Chat tool calls (collapsed)",
    };
  }
  if (pathname === "/assistant") {
    return {
      width: "full",
      render: () => <AssistantRightRailSlot />,
      ariaLabel: "Assistant approvals preview",
    };
  }
  if (pathname === "/packs" || pathname.startsWith("/packs/")) {
    return {
      width: "full",
      render: () => <PacksRightRailSlot />,
      ariaLabel: "Pack library shortcuts",
    };
  }
  if (pathname === "/workflows" || pathname.startsWith("/workflows/")) {
    return {
      width: "full",
      render: () => <WorkflowsRightRailSlot />,
      ariaLabel: "Workflow shortcuts",
    };
  }
  if (pathname === "/channels") {
    return {
      width: "full",
      render: () => <ChannelsRightRailSlot />,
      ariaLabel: "Channels status",
    };
  }
  if (pathname === "/automations" || pathname.startsWith("/automations/")) {
    return {
      width: "full",
      render: () => <AutomationsRightRailSlot />,
      ariaLabel: "Automation queue",
    };
  }
  if (pathname === "/sessions") {
    return {
      width: "full",
      render: () => <SessionsRightRailSlot />,
      ariaLabel: "Recent sessions",
    };
  }
  if (pathname === "/usage") {
    return {
      width: "full",
      render: () => <UsageRightRailSlot />,
      ariaLabel: "Usage summary",
    };
  }
  if (pathname === "/settings" || pathname.startsWith("/settings/")) {
    return {
      width: "compact",
      render: () => <SettingsProvidersRightRailSlot />,
      ariaLabel: "Settings provider health",
    };
  }
  return { width: "none", render: () => null, ariaLabel: "" };
}

function widthVar(width: RightRailWidth): string | undefined {
  switch (width) {
    case "full":
      return "var(--shell-right-rail-w-full)";
    case "compact":
      return "var(--shell-right-rail-w-compact)";
    case "collapsed":
      return "var(--shell-right-rail-w-collapsed)";
    default:
      return undefined;
  }
}

export function RightRail() {
  const location = useLocation();
  const contract = useMemo(() => resolveContract(location.pathname), [location.pathname]);
  const width = widthVar(contract.width);
  if (contract.width === "none" || !width) return null;

  return (
    <aside
      data-testid="app-shell-right-rail"
      aria-label={contract.ariaLabel}
      className="hidden shrink-0 overflow-y-auto border-l lg:block"
      style={{
        width,
        background: "var(--surface-1)",
        borderColor: "rgba(122, 106, 88, 0.18)",
        transition: "width var(--motion-swift)",
      }}
    >
      {contract.render()}
    </aside>
  );
}
