import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search } from "lucide-react";
import { HIDE_MARKETPLACE_UI } from "@/lib/feature-flags";
import { localize, type AppLocale } from "@/lib/i18n/localized-text";

interface CommandItem {
  id: string;
  label: string;
  labelZh: string;
  path: string;
  section: string;
  sectionZh: string;
}

export const COMMANDS: CommandItem[] = [
  { id: "home", label: "Home", labelZh: "首页", path: "/home", section: "Navigation", sectionZh: "导航" },
  { id: "chat", label: "Chat", labelZh: "聊天", path: "/chat", section: "Navigation", sectionZh: "导航" },
  { id: "packs", label: "Industry & Tasks", labelZh: "行业与任务", path: "/packs", section: "Navigation", sectionZh: "导航" },
  { id: "assistant", label: "Assistant", labelZh: "助手", path: "/assistant", section: "Navigation", sectionZh: "导航" },
  { id: "skills", label: "Skills", labelZh: "技能", path: "/skills", section: "Advanced", sectionZh: "高级" },
  { id: "workflows", label: "Workflows", labelZh: "工作流", path: "/workflows", section: "Advanced", sectionZh: "高级" },
  { id: "automations", label: "Automations", labelZh: "自动化", path: "/automations", section: "Advanced", sectionZh: "高级" },
  { id: "memory", label: "Memory", labelZh: "记忆", path: "/memory", section: "Advanced", sectionZh: "高级" },
  { id: "mcp", label: "MCP Servers", labelZh: "MCP 服务器", path: "/mcp", section: "Advanced", sectionZh: "高级" },
  { id: "usage", label: "Usage & Cost", labelZh: "用量与成本", path: "/usage", section: "Advanced", sectionZh: "高级" },
  { id: "sessions", label: "Sessions", labelZh: "会话", path: "/sessions", section: "Advanced", sectionZh: "高级" },
  { id: "observability", label: "Observability", labelZh: "可观测性", path: "/observability", section: "Advanced", sectionZh: "高级" },
  { id: "fleet", label: "Fleet", labelZh: "设备集群", path: "/fleet", section: "Advanced", sectionZh: "高级" },
  { id: "marketplace", label: "Marketplace", labelZh: "市场", path: "/marketplace", section: "Advanced", sectionZh: "高级" },
  { id: "settings", label: "Settings", labelZh: "设置", path: "/settings", section: "Advanced", sectionZh: "高级" },
  { id: "command-center", label: "Operator Console", labelZh: "操作控制台", path: "/command-center", section: "Tools", sectionZh: "工具" },
  { id: "skill-generator", label: "Skill Generator", labelZh: "技能生成器", path: "/skills/generator", section: "Tools", sectionZh: "工具" },
  { id: "workflow-builder", label: "Workflow Builder", labelZh: "工作流编辑器", path: "/workflows/builder", section: "Tools", sectionZh: "工具" },
];

export const AVAILABLE_COMMANDS = HIDE_MARKETPLACE_UI
  ? COMMANDS.filter((command) => command.path !== "/marketplace")
  : COMMANDS;

export function CommandPalette(props: { locale: AppLocale; onClose: () => void }) {
  const { locale, onClose } = props;
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const filtered = AVAILABLE_COMMANDS.filter((cmd) => {
    const q = query.toLowerCase();
    if (!q) return true;
    return cmd.label.toLowerCase().includes(q) || cmd.labelZh.includes(q) || cmd.path.includes(q);
  });

  const select = useCallback((item: CommandItem) => {
    navigate(item.path);
    onClose();
  }, [navigate, onClose]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIndex((i) => Math.max(i - 1, 0)); return; }
      if (e.key === "Enter" && filtered[selectedIndex]) { select(filtered[selectedIndex]); return; }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [filtered, selectedIndex, select, onClose]);

  // Group by section
  const sections = new Map<string, CommandItem[]>();
  for (const item of filtered) {
    const key = localize(locale, item.sectionZh, item.section);
    if (!sections.has(key)) sections.set(key, []);
    sections.get(key)!.push(item);
  }

  let flatIndex = 0;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-black/20 backdrop-blur-[2px]" />
      <div
        className="relative w-full max-w-[560px] overflow-hidden rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-elevated)] shadow-[var(--shadow-card-strong)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-[color:var(--color-border-soft)] px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-[color:var(--color-text-faint)]" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={localize(locale, "搜索页面、工具...", "Search pages, tools...")}
            aria-label={localize(locale, "命令面板搜索", "Command palette search")}
            className="flex-1 bg-transparent text-sm text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-faint)] outline-none"
          />
          <kbd className="rounded-md border border-[color:var(--color-border-soft)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-text-faint)]">Esc</kbd>
        </div>

        {/* Results */}
        <div className="max-h-[320px] overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <p className="px-3 py-4 text-center text-sm text-[color:var(--color-text-secondary)]">
              {localize(locale, "无匹配结果", "No results found")}
            </p>
          ) : (
            Array.from(sections.entries()).map(([sectionLabel, items]) => (
              <div key={sectionLabel}>
                <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">
                  {sectionLabel}
                </p>
                {items.map((item) => {
                  const idx = flatIndex++;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => select(item)}
                      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors ${
                        idx === selectedIndex
                          ? "bg-[color:var(--color-accent-soft)] text-[color:var(--color-text-primary)]"
                          : "text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-subtle)]"
                      }`}
                    >
                      <span className="flex-1">{localize(locale, item.labelZh, item.label)}</span>
                      <span className="text-xs text-[color:var(--color-text-faint)]">{item.path}</span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
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
