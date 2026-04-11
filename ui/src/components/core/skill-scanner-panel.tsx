import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { toast } from "sonner";
import { ActionButton, StatusPill } from "@/components/core/primitives";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";
import {
  scanMigrateApi,
  type CommunitySkillItem,
  type LocalSkillScanItem,
  type LocalSkillSourceTool,
} from "@/lib/api/scan-migrate";

// ─── Props ───

export interface SkillScannerPanelProps {
  open: boolean;
  onClose: () => void;
}

// ─── Source tool badge config ───

function sourceToolTone(tool: LocalSkillSourceTool): "neutral" | "success" | "warning" | "danger" {
  switch (tool) {
    case "claude-code": return "neutral";   // accent-like via neutral
    case "cursor": return "neutral";
    case "n8n": return "warning";
    case "codex": return "success";
    case "clawdbot": return "neutral";
    case "friday": return "success";
    default: return "neutral";
  }
}

function sourceToolLabel(tool: LocalSkillSourceTool): string {
  switch (tool) {
    case "claude-code": return "Claude Code";
    case "cursor": return "Cursor";
    case "n8n": return "n8n";
    case "codex": return "Codex";
    case "clawdbot": return "ClawdBot";
    case "friday": return "Friday";
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

  const [activeTab, setActiveTab] = useState<"local" | "community">("local");

  // ── Local scan state ──
  const [selectedLocalIds, setSelectedLocalIds] = useState<Set<string>>(new Set());
  const [scanItems, setScanItems] = useState<LocalSkillScanItem[]>([]);

  // ── Community state ──
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedCommunityIds, setSelectedCommunityIds] = useState<Set<string>>(new Set());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedQuery(searchQuery), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery]);

  // ── Queries / Mutations ──

  const scanMutation = useMutation({
    mutationFn: () => scanMigrateApi.scanLocal(),
    onSuccess: (data) => {
      setScanItems(data.items);
      setSelectedLocalIds(new Set());
    },
  });

  const communityQuery = useQuery({
    queryKey: ["skills", "community", debouncedQuery],
    queryFn: () => scanMigrateApi.getCommunitySkills(debouncedQuery || undefined),
    enabled: open && activeTab === "community",
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

  // ── Handlers ──

  function handleClose() {
    setSelectedLocalIds(new Set());
    setSelectedCommunityIds(new Set());
    setScanItems([]);
    setSearchQuery("");
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
    setSelectedLocalIds((prev) => {
      if (prev.size === scanItems.length) return new Set();
      return new Set(scanItems.map((i) => i.id));
    });
  }, [scanItems]);

  const toggleCommunityItem = useCallback((id: string) => {
    setSelectedCommunityIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  function handleImport() {
    if (activeTab === "local") {
      const items = scanItems
        .filter((i) => selectedLocalIds.has(i.id))
        .map((i) => ({ sourcePath: i.sourcePath, formatHint: i.converterHint }));
      if (items.length === 0) return;
      importMutation.mutate(items);
    } else {
      const communityItems = (communityQuery.data?.items ?? [])
        .filter((i) => selectedCommunityIds.has(i.id))
        .map((i) => ({ sourcePath: i.sourceUrl }));
      if (communityItems.length === 0) return;
      importMutation.mutate(communityItems);
    }
  }

  const selectedCount = activeTab === "local" ? selectedLocalIds.size : selectedCommunityIds.size;

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
          <div className="space-y-2">
            {/* Select all */}
            <label className="flex items-center gap-2 text-sm text-[color:var(--color-text-secondary)]">
              <input
                type="checkbox"
                checked={selectedLocalIds.size === scanItems.length}
                onChange={toggleAllLocal}
                className="h-4 w-4 rounded border-[color:var(--color-border-soft)] accent-[color:var(--color-accent)]"
              />
              {localize(locale, "全选", "Select All")}
            </label>

            {/* Item list */}
            <div className="space-y-1.5">
              {scanItems.map((item) => (
                <label
                  key={item.id}
                  className="flex cursor-pointer items-start gap-3 rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-3 transition hover:border-[color:var(--color-border-strong)]"
                >
                  <input
                    type="checkbox"
                    checked={selectedLocalIds.has(item.id)}
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
                      {item.description}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs text-[color:var(--color-text-tertiary)]">
                    {formatFileSize(item.sizeBytes)}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  function renderCommunityTab() {
    const items: CommunitySkillItem[] = communityQuery.data?.items ?? [];

    return (
      <div className="space-y-4">
        {/* Search input */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--color-text-tertiary)]" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={localize(locale, "搜索社区技能...", "Search community skills...")}
            className="w-full rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-base)] py-2.5 pl-9 pr-3 text-sm text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-tertiary)] focus:border-[color:var(--color-accent)] focus:outline-none"
          />
        </div>

        {communityQuery.isLoading && (
          <p className="text-sm text-[color:var(--color-text-tertiary)]">
            {localize(locale, "加载中...", "Loading...")}
          </p>
        )}

        {communityQuery.isError && (
          <p className="text-sm text-[color:var(--color-text-danger)]">
            {communityQuery.error instanceof Error
              ? communityQuery.error.message
              : localize(locale, "加载失败", "Failed to load")}
          </p>
        )}

        {communityQuery.isSuccess && items.length === 0 && (
          <p className="text-sm text-[color:var(--color-text-tertiary)]">
            {localize(locale, "未找到社区技能", "No community skills found")}
          </p>
        )}

        {items.length > 0 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {items.map((item) => (
              <label
                key={item.id}
                className="flex cursor-pointer items-start gap-3 rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-3 transition hover:border-[color:var(--color-border-strong)]"
              >
                <input
                  type="checkbox"
                  checked={selectedCommunityIds.has(item.id)}
                  onChange={() => toggleCommunityItem(item.id)}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-[color:var(--color-border-soft)] accent-[color:var(--color-accent)]"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-[color:var(--color-text-primary)]">
                    {locale === "zh" ? item.nameZh : item.nameEn}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-[color:var(--color-text-tertiary)]">
                    {locale === "zh" ? item.descriptionZh : item.descriptionEn}
                  </p>
                  {item.tags.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {item.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full bg-[color:var(--color-bg-subtle)] px-2 py-0.5 text-[10px] text-[color:var(--color-text-tertiary)]"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="mt-1 text-[10px] text-[color:var(--color-text-faint)]">
                    {item.author}
                  </p>
                </div>
              </label>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ─── Main render ───

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="relative mx-4 flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-[28px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] shadow-2xl">
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
            onClick={() => setActiveTab("community")}
            className={`px-4 py-2.5 text-sm font-medium transition ${
              activeTab === "community"
                ? "border-b-2 border-[color:var(--color-accent)] text-[color:var(--color-text-primary)]"
                : "text-[color:var(--color-text-tertiary)] hover:text-[color:var(--color-text-secondary)]"
            }`}
          >
            {localize(locale, "社区技能", "Community Skills")}
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {activeTab === "local" ? renderLocalTab() : renderCommunityTab()}

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

        {/* Bottom bar */}
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
              : localize(locale, "导入选中", "Import Selected")}
          </ActionButton>
        </div>
      </div>
    </div>
  );
}
