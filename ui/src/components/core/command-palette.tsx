import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Compass, History, Link as LinkIcon, MessageSquarePlus, Search, Settings2, type LucideIcon } from "lucide-react";
import { DeepLinkPreviewDialog } from "@/components/deeplink/deeplink-preview-dialog";
import { useRecentSessionsQuery } from "@/hooks/use-recent-sessions";
import { HIDE_MARKETPLACE_UI } from "@/lib/feature-flags";
import { localize, resolveLocalizedText, type AppLocale, type LocalizedText } from "@/lib/i18n/localized-text";
import {
  AGENT_OS_NAV_ADVANCED,
  AGENT_OS_NAV_PRIMARY,
  type AgentOsNavItem,
} from "@/lib/routes/agent-os-nav";
import { localizedText } from "@/lib/i18n/localized-text";

type CommandKind = "nav" | "action";

interface CommandItem {
  id: string;
  kind: CommandKind;
  label: LocalizedText;
  section: LocalizedText;
  path?: string;
  run?: (ctx: CommandContext) => void;
  icon?: LucideIcon;
  hint?: LocalizedText;
}

interface CommandContext {
  navigate: (path: string) => void;
  openDeepLinkImport: () => void;
  close: () => void;
}

const SECTION_NAV_PRIMARY = localizedText("主导航", "Primary");
const SECTION_NAV_ADVANCED = localizedText("高级", "Advanced");
const SECTION_ACTIONS = localizedText("全局操作", "Global actions");
const SECTION_RECENT = localizedText("最近会话", "Recent sessions");

function toNavCommand(item: AgentOsNavItem, section: LocalizedText): CommandItem {
  return {
    id: `nav:${item.path}`,
    kind: "nav",
    label: item.label,
    section,
    path: item.path,
    hint: localizedText(item.path, item.path),
  };
}

function buildNavCommands(): CommandItem[] {
  const primary = AGENT_OS_NAV_PRIMARY.map((item) => toNavCommand(item, SECTION_NAV_PRIMARY));
  const advanced = AGENT_OS_NAV_ADVANCED.map((item) => toNavCommand(item, SECTION_NAV_ADVANCED));
  const all: CommandItem[] = [...primary, ...advanced];
  // Settings lives in the rail but is often searched from Cmd+K too.
  all.push({
    id: "nav:/settings",
    kind: "nav",
    label: localizedText("设置", "Settings"),
    section: SECTION_NAV_ADVANCED,
    path: "/settings",
    hint: localizedText("/settings", "/settings"),
  });
  if (!HIDE_MARKETPLACE_UI) {
    all.push({
      id: "nav:/marketplace",
      kind: "nav",
      label: localizedText("资产市场", "Marketplace"),
      section: SECTION_NAV_ADVANCED,
      path: "/marketplace",
      hint: localizedText("/marketplace", "/marketplace"),
    });
  }
  return all;
}

function buildActionCommands(): CommandItem[] {
  return [
    {
      id: "action:new-chat",
      kind: "action",
      label: localizedText("新建聊天", "New chat"),
      section: SECTION_ACTIONS,
      icon: MessageSquarePlus,
      hint: localizedText("开始一轮新的对话", "Start a fresh conversation"),
      run: (ctx) => {
        ctx.navigate("/chat");
        ctx.close();
      },
    },
    {
      id: "action:import-deep-link",
      kind: "action",
      label: localizedText("从 friday:// 链接导入", "Import from friday:// link"),
      section: SECTION_ACTIONS,
      icon: LinkIcon,
      hint: localizedText("打开深链导入预览", "Open deep-link import preview"),
      run: (ctx) => {
        ctx.openDeepLinkImport();
      },
    },
    {
      id: "action:open-setup",
      kind: "action",
      label: localizedText("打开设置向导", "Open Setup"),
      section: SECTION_ACTIONS,
      icon: Settings2,
      hint: localizedText("重新运行本地设置流程", "Re-run local setup flow"),
      run: (ctx) => {
        ctx.navigate("/setup");
        ctx.close();
      },
    },
    {
      id: "action:session-search",
      kind: "action",
      label: localizedText("搜索会话", "Search sessions"),
      section: SECTION_ACTIONS,
      icon: Compass,
      hint: localizedText("跳转到会话浏览器", "Jump to the session browser"),
      run: (ctx) => {
        ctx.navigate("/sessions");
        ctx.close();
      },
    },
  ];
}

/**
 * Backward-compat export: legacy callers expect a flat list of nav targets.
 * The shell itself no longer reads this — it consumes AGENT_OS_NAV_* directly.
 */
export const AVAILABLE_COMMANDS: Array<{ id: string; path: string; label: string; labelZh: string }>
  = buildNavCommands()
    .filter((cmd) => cmd.kind === "nav" && cmd.path)
    .map((cmd) => ({
      id: cmd.id,
      path: cmd.path ?? "",
      label: cmd.label.en,
      labelZh: cmd.label.zh,
    }));

export function CommandPalette(props: { locale: AppLocale; onClose: () => void }) {
  const { locale, onClose } = props;
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showDeepLinkImport, setShowDeepLinkImport] = useState(false);

  const { data: recentSessions } = useRecentSessionsQuery(5);

  const recentSessionCommands = useMemo<CommandItem[]>(() => {
    if (!recentSessions) return [];
    return recentSessions.map((session) => ({
      id: `session:${session.key}`,
      kind: "action",
      label: localizedText(session.key, session.key),
      section: SECTION_RECENT,
      icon: History,
      hint: localizedText(session.channel, session.channel),
      run: (ctx) => {
        ctx.navigate("/sessions");
        ctx.close();
      },
    }));
  }, [recentSessions]);

  const allCommands = useMemo<CommandItem[]>(
    () => [...buildNavCommands(), ...buildActionCommands(), ...recentSessionCommands],
    [recentSessionCommands],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allCommands;
    return allCommands.filter((cmd) => {
      const haystacks = [
        cmd.label.en,
        cmd.label.zh,
        cmd.path ?? "",
        cmd.id,
        cmd.hint?.en ?? "",
        cmd.hint?.zh ?? "",
      ];
      return haystacks.some((value) => value.toLowerCase().includes(q));
    });
  }, [allCommands, query]);

  const context = useMemo<CommandContext>(() => ({
    navigate: (path: string) => navigate(path),
    openDeepLinkImport: () => setShowDeepLinkImport(true),
    close: onClose,
  }), [navigate, onClose]);

  const select = useCallback((item: CommandItem) => {
    if (item.kind === "action" && item.run) {
      item.run(context);
      return;
    }
    if (item.path) {
      navigate(item.path);
      onClose();
    }
  }, [context, navigate, onClose]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (showDeepLinkImport) return;
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" && filtered[selectedIndex]) {
        select(filtered[selectedIndex]);
        return;
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [filtered, selectedIndex, select, onClose, showDeepLinkImport]);

  const sections = useMemo(() => {
    const grouped = new Map<string, CommandItem[]>();
    for (const item of filtered) {
      const key = resolveLocalizedText(item.section, locale);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(item);
    }
    return Array.from(grouped.entries());
  }, [filtered, locale]);

  let flatIndex = 0;

  if (showDeepLinkImport) {
    return (
      <DeepLinkPreviewDialog
        onClose={() => setShowDeepLinkImport(false)}
        onApplied={() => {
          setShowDeepLinkImport(false);
          onClose();
        }}
      />
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={localize(locale, "命令面板", "Command palette")}
    >
      <div className="absolute inset-0 bg-black/20 backdrop-blur-[2px]" />
      <div
        className="relative w-full max-w-[560px] overflow-hidden rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-elevated)] shadow-[var(--shadow-card-strong)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-[color:var(--color-border-soft)] px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-[color:var(--color-text-faint)]" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={localize(locale, "搜索页面、操作…", "Search pages, actions…")}
            aria-label={localize(locale, "命令面板搜索", "Command palette search")}
            className="flex-1 bg-transparent text-sm text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-faint)] outline-none"
          />
          <kbd className="rounded-md border border-[color:var(--color-border-soft)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-text-faint)]">
            Esc
          </kbd>
        </div>

        <div className="max-h-[360px] overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <p className="px-3 py-4 text-center text-sm text-[color:var(--color-text-secondary)]">
              {localize(locale, "无匹配结果", "No results found")}
            </p>
          ) : (
            sections.map(([sectionLabel, items]) => (
              <div key={sectionLabel}>
                <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">
                  {sectionLabel}
                </p>
                {items.map((item) => {
                  const idx = flatIndex++;
                  const isSelected = idx === selectedIndex;
                  const Icon = item.icon;
                  const labelText = resolveLocalizedText(item.label, locale);
                  const hintText = item.hint ? resolveLocalizedText(item.hint, locale) : undefined;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => select(item)}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors ${
                        isSelected
                          ? "bg-[color:var(--color-accent-soft)] text-[color:var(--color-text-primary)]"
                          : "text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-subtle)]"
                      }`}
                    >
                      {Icon ? (
                        <Icon className="h-4 w-4 shrink-0 text-[color:var(--color-text-tertiary)]" />
                      ) : null}
                      <span className="flex-1">{labelText}</span>
                      {hintText ? (
                        <span className="text-xs text-[color:var(--color-text-faint)]">{hintText}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="border-t border-[color:var(--color-border-soft)] px-4 py-2 text-[10px] text-[color:var(--color-text-faint)]">
          <kbd className="rounded border border-[color:var(--color-border-soft)] px-1 py-0.5">↑↓</kbd>{" "}
          {localize(locale, "导航", "navigate")}{" "}
          <kbd className="rounded border border-[color:var(--color-border-soft)] px-1 py-0.5">↵</kbd>{" "}
          {localize(locale, "选择", "select")}{" "}
          <kbd className="rounded border border-[color:var(--color-border-soft)] px-1 py-0.5">esc</kbd>{" "}
          {localize(locale, "关闭", "close")}
        </div>
      </div>
    </div>
  );
}
