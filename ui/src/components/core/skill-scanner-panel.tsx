import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { toast } from "sonner";
import { ActionButton, StatusPill } from "@/components/core/primitives";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";
import {
  scanMigrateApi,
  type LocalSkillScanItem,
  type LocalSkillSourceTool,
} from "@/lib/api/scan-migrate";
import { skillsApi } from "@/lib/api/skills";

// ─── Props ───

export interface SkillScannerPanelProps {
  open: boolean;
  onClose: () => void;
}

// ─── Constants ───

const TOP_N = 20;

const SOURCE_FILTERS = [
  { key: "all", zh: "全部", en: "All" },
  { key: "claude-code", zh: "Claude Code", en: "Claude Code" },
  { key: "cursor", zh: "Cursor", en: "Cursor" },
  { key: "codex", zh: "Codex", en: "Codex" },
  { key: "openclaw", zh: "OpenClaw", en: "OpenClaw" },
  { key: "local-project", zh: "本地项目", en: "Local Project" },
  { key: "friday", zh: "Friday", en: "Friday" },
  { key: "n8n", zh: "n8n", en: "n8n" },
  { key: "unknown", zh: "本地文件", en: "Local File" },
] as const;

// ─── Source tool badge config ───

function sourceToolTone(tool: LocalSkillSourceTool): "neutral" | "success" | "warning" | "danger" {
  switch (tool) {
    case "claude-code": return "neutral";
    case "cursor": return "neutral";
    case "n8n": return "warning";
    case "codex": return "success";
    case "openclaw": return "neutral";
    case "friday": return "success";
    case "local-project": return "neutral";
    default: return "neutral";
  }
}

function sourceToolLabel(tool: LocalSkillSourceTool): string {
  switch (tool) {
    case "claude-code": return "Claude Code";
    case "cursor": return "Cursor";
    case "n8n": return "n8n";
    case "codex": return "Codex";
    case "openclaw": return "OpenClaw";
    case "friday": return "Friday";
    case "local-project": return "Local Project";
    case "unknown": return "Local File";
    default: return "Unknown";
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Component ───

export function SkillScannerPanel({ open, onClose }: SkillScannerPanelProps) {
  const { locale } = useAppLocale();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<"local" | "friday">("local");

  // ── Local scan state ──
  const [selectedLocalIds, setSelectedLocalIds] = useState<Set<string>>(new Set());
  const [scanItems, setScanItems] = useState<LocalSkillScanItem[]>([]);
  const [localSearch, setLocalSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [showAllLocal, setShowAllLocal] = useState(false);

  // ── Friday skills state ──
  const [fridaySearch, setFridaySearch] = useState("");

  // ── Queries / Mutations ──

  const scanMutation = useMutation({
    mutationFn: () => scanMigrateApi.scanLocal(),
    onSuccess: (data) => {
      setScanItems(data.items);
      setSelectedLocalIds(new Set());
      setShowAllLocal(false);
    },
  });

  const fridaySkillsQuery = useQuery({
    queryKey: ["skills", "friday-builtin"],
    queryFn: () => skillsApi.listSkills(),
    enabled: open && activeTab === "friday",
  });

  const importMutation = useMutation({
    mutationFn: (items: Array<{ sourcePath: string; formatHint?: string }>) =>
      scanMigrateApi.importBatch(items),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
      toast.success(
        localize(
          locale,
          `成功导入 ${data.importedCount} 项${data.failedCount > 0 ? `，${data.failedCount} 项失败` : ""}`,
          `Imported ${data.importedCount} item(s)${data.failedCount > 0 ? `, ${data.failedCount} failed` : ""}`,
        ),
      );
      if (data.failedCount === 0) {
        handleClose();
      }
    },
  });

  // ── Filtered + sorted local items ──

  const filteredLocalItems = useMemo(() => {
    let items = [...scanItems];

    // Sort by modification date, most recent first
    items.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

    // Apply source filter
    if (sourceFilter !== "all") {
      items = items.filter((i) => i.sourceTool === sourceFilter);
    }

    // Apply search
    if (localSearch.trim()) {
      const q = localSearch.trim().toLowerCase();
      items = items.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.description.toLowerCase().includes(q),
      );
    }

    return items;
  }, [scanItems, sourceFilter, localSearch]);

  const visibleLocalItems = useMemo(() => {
    if (showAllLocal) return filteredLocalItems;
    return filteredLocalItems.slice(0, TOP_N);
  }, [filteredLocalItems, showAllLocal]);

  const hasMoreLocal = filteredLocalItems.length > TOP_N && !showAllLocal;

  // ── Filtered Friday skills ──

  const filteredFridaySkills = useMemo(() => {
    const skills = fridaySkillsQuery.data ?? [];
    if (!fridaySearch.trim()) return skills;
    const q = fridaySearch.trim().toLowerCase();
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q),
    );
  }, [fridaySkillsQuery.data, fridaySearch]);

  // ── Handlers ──

  function handleClose() {
    setSelectedLocalIds(new Set());
    setScanItems([]);
    setLocalSearch("");
    setSourceFilter("all");
    setShowAllLocal(false);
    setFridaySearch("");
    scanMutation.reset();
    importMutation.reset();
    onClose();
  }

  const toggleLocalItem = useCallback((id: string) => {
    setSelectedLocalIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAllLocal = useCallback(() => {
    const selectableIds = scanItems.filter((item) => item.convertible).map((item) => item.id);
    setSelectedLocalIds((prev) => {
      if (prev.size === selectableIds.length && selectableIds.length > 0) return new Set();
      return new Set(selectableIds);
    });
  }, [scanItems]);

  function handleImport() {
    if (activeTab !== "local") return;
    const items = scanItems
      .filter((i) => selectedLocalIds.has(i.id) && i.convertible)
      .map((i) => ({ sourcePath: i.sourcePath, formatHint: i.converterHint }));
    if (items.length === 0) return;
    importMutation.mutate(items);
  }

  const selectedCount = activeTab === "local" ? selectedLocalIds.size : 0;

  // ── Import error details ──
  const importErrors = importMutation.data?.results.filter((r) => !r.success) ?? [];

  if (!open) return null;

  // ── Tab renderers ──

  function renderLocalTab() {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <ActionButton
            tone="secondary"
            onClick={() => scanMutation.mutate()}
            disabled={scanMutation.isPending}
          >
            {scanMutation.isPending
              ? localize(locale, "扫描中...", "Scanning...")
              : localize(locale, "扫描本地 AI 工具", "Scan Local AI Tools")}
          </ActionButton>
          {scanMutation.isError && (
            <span className="text-sm text-[color:var(--color-text-danger)]">
              {scanMutation.error instanceof Error
                ? scanMutation.error.message
                : localize(locale, "扫描失败", "Scan failed")}
            </span>
          )}
        </div>

        {scanMutation.isSuccess && scanItems.length === 0 && (
          <p className="text-sm text-[color:var(--color-text-tertiary)]">
            {localize(locale, "未发现本地 AI 工具配置", "No local AI tool configs found")}
          </p>
        )}

        {scanItems.length > 0 && (
          <div className="space-y-3">
            {/* Search input */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--color-text-tertiary)]" />
              <input
                type="text"
                value={localSearch}
                onChange={(e) => setLocalSearch(e.target.value)}
                placeholder={localize(locale, "搜索本地技能...", "Search local skills...")}
                className="w-full rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-base)] py-2.5 pl-9 pr-3 text-sm text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-tertiary)] focus:border-[color:var(--color-accent)] focus:outline-none"
              />
            </div>

            {/* Source filter pills */}
            <div className="flex flex-wrap gap-1.5">
              {SOURCE_FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => { setSourceFilter(f.key); setShowAllLocal(false); }}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                    sourceFilter === f.key
                      ? "bg-[color:var(--color-accent)] text-white"
                      : "bg-[color:var(--color-bg-subtle)] text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-hover)]"
                  }`}
                >
                  {localize(locale, f.zh, f.en)}
                </button>
              ))}
            </div>

            {/* Select all */}
            <label className="flex items-center gap-2 text-sm text-[color:var(--color-text-secondary)]">
              <input
                type="checkbox"
                checked={selectedLocalIds.size === scanItems.filter((item) => item.convertible).length && scanItems.some((item) => item.convertible)}
                onChange={toggleAllLocal}
                className="h-4 w-4 rounded border-[color:var(--color-border-soft)] accent-[color:var(--color-accent)]"
              />
              {localize(locale, "全选", "Select All")}
            </label>

            {/* Item list */}
            <div className="space-y-1.5">
              {visibleLocalItems.map((item) => (
                <label
                  key={item.id}
                  className={`flex items-start gap-3 rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-3 transition ${
                    item.convertible
                      ? "cursor-pointer hover:border-[color:var(--color-border-strong)]"
                      : "cursor-not-allowed opacity-65"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedLocalIds.has(item.id)}
                    disabled={!item.convertible}
                    onChange={() => toggleLocalItem(item.id)}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-[color:var(--color-border-soft)] accent-[color:var(--color-accent)]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-[color:var(--color-text-primary)]">
                        {item.name}
                      </span>
                      <StatusPill tone={sourceToolTone(item.sourceTool)}>
                        {sourceToolLabel(item.sourceTool)}
                      </StatusPill>
                    </div>
                    <p className="mt-0.5 line-clamp-1 text-xs text-[color:var(--color-text-tertiary)]">
                      {item.description || (item.convertible
                        ? localize(locale, "可导入到 Friday。", "Can be imported into Friday.")
                        : localize(locale, "这个条目已经在当前 Friday 工作区里，不需要再次导入。", "This entry already belongs to the current Friday workspace and does not need to be imported again."))}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs text-[color:var(--color-text-tertiary)]">
                    {formatFileSize(item.sizeBytes)}
                  </span>
                </label>
              ))}
            </div>

            {/* Show all link */}
            {hasMoreLocal && (
              <button
                type="button"
                onClick={() => setShowAllLocal(true)}
                className="text-sm font-medium text-[color:var(--color-accent)] hover:underline"
              >
                {localize(
                  locale,
                  `查看全部 (${filteredLocalItems.length})`,
                  `Show all (${filteredLocalItems.length})`,
                )}
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  function renderFridayTab() {
    const skills = filteredFridaySkills;

    return (
      <div className="space-y-4">
        {/* Search input */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--color-text-tertiary)]" />
          <input
            type="text"
            value={fridaySearch}
            onChange={(e) => setFridaySearch(e.target.value)}
            placeholder={localize(locale, "搜索 Friday 技能...", "Search Friday skills...")}
            className="w-full rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-base)] py-2.5 pl-9 pr-3 text-sm text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-tertiary)] focus:border-[color:var(--color-accent)] focus:outline-none"
          />
        </div>

        {fridaySkillsQuery.isLoading && (
          <p className="text-sm text-[color:var(--color-text-tertiary)]">
            {localize(locale, "加载中...", "Loading...")}
          </p>
        )}

        {fridaySkillsQuery.isError && (
          <p className="text-sm text-[color:var(--color-text-danger)]">
            {fridaySkillsQuery.error instanceof Error
              ? fridaySkillsQuery.error.message
              : localize(locale, "加载失败", "Failed to load")}
          </p>
        )}

        {fridaySkillsQuery.isSuccess && skills.length === 0 && (
          <p className="text-sm text-[color:var(--color-text-tertiary)]">
            {localize(locale, "未找到技能", "No skills found")}
          </p>
        )}

        {skills.length > 0 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {skills.map((skill) => (
              <div
                key={skill.skillId}
                className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-3"
              >
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-[color:var(--color-text-primary)]">
                    {skill.name}
                  </p>
                  <StatusPill tone="success">
                    {localize(locale, "已安装", "Installed")}
                  </StatusPill>
                </div>
                {skill.description && (
                  <p className="mt-0.5 line-clamp-2 text-xs text-[color:var(--color-text-tertiary)]">
                    {skill.description}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ─── Main render ───

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="relative mx-4 flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-[28px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] shadow-2xl sm:max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[color:var(--color-border-soft)] px-6 py-4">
          <h2 className="text-lg font-semibold text-[color:var(--color-text-primary)]">
            {localize(locale, "扫描与迁移", "Scan & Migrate")}
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg p-1 text-[color:var(--color-text-tertiary)] hover:bg-[color:var(--color-bg-hover)] hover:text-[color:var(--color-text-primary)]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 border-b border-[color:var(--color-border-soft)] px-6">
          <button
            type="button"
            onClick={() => setActiveTab("local")}
            className={`px-4 py-2.5 text-sm font-medium transition ${
              activeTab === "local"
                ? "border-b-2 border-[color:var(--color-accent)] text-[color:var(--color-text-primary)]"
                : "text-[color:var(--color-text-tertiary)] hover:text-[color:var(--color-text-secondary)]"
            }`}
          >
            {localize(locale, "本地扫描", "Local Scan")}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("friday")}
            className={`px-4 py-2.5 text-sm font-medium transition ${
              activeTab === "friday"
                ? "border-b-2 border-[color:var(--color-accent)] text-[color:var(--color-text-primary)]"
                : "text-[color:var(--color-text-tertiary)] hover:text-[color:var(--color-text-secondary)]"
            }`}
          >
            {localize(locale, "Friday 技能库", "Friday Skills")}
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {activeTab === "local" ? renderLocalTab() : renderFridayTab()}

          {/* Inline import errors */}
          {importErrors.length > 0 && (
            <div className="mt-4 space-y-1.5">
              {importErrors.map((err, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-[color:var(--color-border-danger)] bg-[color:var(--color-bg-danger-subtle)] px-3 py-2 text-xs text-[color:var(--color-text-danger)]"
                >
                  <span className="font-semibold">{err.sourcePath}</span>: {err.error ?? "Unknown error"}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Bottom bar - only show import button on local tab */}
        {activeTab === "local" && (
          <div className="flex items-center justify-between border-t border-[color:var(--color-border-soft)] px-6 py-4">
            <span className="text-sm text-[color:var(--color-text-tertiary)]">
              {localize(locale, `已选择 ${selectedCount} 项`, `${selectedCount} selected`)}
            </span>
            <ActionButton
              tone="primary"
              onClick={handleImport}
              disabled={selectedCount === 0 || importMutation.isPending}
            >
              {importMutation.isPending
                ? localize(locale, "导入中...", "Importing...")
                : localize(
                    locale,
                    `导入选中 (${selectedCount})`,
                    `Import Selected (${selectedCount})`,
                  )}
            </ActionButton>
          </div>
        )}
      </div>
    </div>
  );
}
