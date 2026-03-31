import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils/cn";

// ─── Action types parsed from agent responses ───

export type ChatActionType =
  | "open_workflow_builder"
  | "open_workflows"
  | "open_skills"
  | "open_fleet"
  | "open_observability"
  | "open_settings"
  | "open_page"
  | "approve"
  | "reject"
  | "install_skill"
  | "deploy_workflow";

export interface ChatAction {
  type: ChatActionType;
  label: string;
  description?: string;
  href?: string;
  data?: Record<string, unknown>;
}

interface ChatActionCardProps {
  actions: ChatAction[];
  onAction?: (action: ChatAction) => void;
}

const ROUTE_MAP: Partial<Record<ChatActionType, string>> = {
  open_workflow_builder: "/workflows/builder",
  open_workflows: "/workflows",
  open_skills: "/skills",
  open_fleet: "/fleet",
  open_observability: "/observability",
  open_settings: "/settings",
};

export function ChatActionCard({ actions, onAction }: ChatActionCardProps) {
  const navigate = useNavigate();

  if (actions.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 pl-11">
      {actions.map((action, i) => {
        const route = ROUTE_MAP[action.type] ?? (action.type === "open_page" ? action.href : undefined);
        return (
          <button
            key={`${action.type}-${String(i)}`}
            type="button"
            onClick={() => {
              if (route) {
                navigate(route);
              }
              onAction?.(action);
            }}
            className={cn(
              "rounded-xl border px-3 py-2 text-xs font-medium transition-colors",
              action.type === "approve"
                ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/20"
                : action.type === "reject"
                  ? "border-rose-400/30 bg-rose-400/10 text-rose-200 hover:bg-rose-400/20"
                  : "border-white/10 bg-white/[0.04] text-white/70 hover:border-emerald-400/30 hover:bg-emerald-400/10 hover:text-white",
            )}
          >
            {action.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Parse action hints from agent output text.
 * Agent can embed JSON action blocks like: <!--action:{"type":"open_skills","label":"Browse Skills"}-->
 */
export function parseActionsFromText(text: string): { cleanText: string; actions: ChatAction[] } {
  const actions: ChatAction[] = [];
  const cleanText = text.replace(
    /<!--action:(.*?)-->/g,
    (_, json: string) => {
      try {
        const parsed = JSON.parse(json) as ChatAction;
        if (parsed.type && parsed.label) {
          actions.push(parsed);
        }
      } catch {
        // Ignore malformed action hints
      }
      return "";
    },
  );

  return { cleanText: cleanText.trim(), actions };
}
