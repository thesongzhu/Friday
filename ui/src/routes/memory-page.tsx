import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, FileDown, Plus, Search, ShieldCheck, Tag, Trash2 } from "lucide-react";
import { SkeletonList } from "@/components/core/primitives";
import { toast } from "sonner";
import { ActionButton, ConfirmDialog, ShellCard, StatusPill } from "@/components/core/primitives";
import { memoryApi } from "@/lib/api/memory";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";
import type { FridayMemoryItem, FridayMemoryType } from "@/lib/api/types";

function formatTimestamp(value?: string): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function toneForNamespace(ns: string): "neutral" | "success" | "warning" {
  if (ns === "preference" || ns === "user") return "success";
  if (ns === "system" || ns === "agent") return "warning";
  return "neutral";
}

const MEMORY_TYPES: FridayMemoryType[] = ["fact", "preference", "procedure", "episode", "correction"];

function formatPercent(value?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

export function MemoryPage() {
  const queryClient = useQueryClient();
  const { locale } = useAppLocale();
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [searchMemoryType, setSearchMemoryType] = useState<"all" | FridayMemoryType>("all");
  const [boostByConfidence, setBoostByConfidence] = useState(false);

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["memory", "items"],
    queryFn: () => memoryApi.listItems({ limit: 200 }),
  });

  const { data: searchResults, isLoading: isSearching, isError: isSearchError } = useQuery({
    queryKey: ["memory", "search", activeSearch, searchMemoryType, boostByConfidence],
    queryFn: () => memoryApi.search({
      query: activeSearch,
      limit: 20,
      memoryType: searchMemoryType === "all" ? undefined : searchMemoryType,
      boostByConfidence,
    }),
    enabled: activeSearch.length > 0,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => memoryApi.deleteItem(id),
    onSuccess: async () => {
      toast.success(localize(locale, "记忆已删除", "Memory item deleted"));
      await queryClient.invalidateQueries({ queryKey: ["memory"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "删除记忆失败", "Failed to delete memory item"));
    },
  });

  const pruneMutation = useMutation({
    mutationFn: () => memoryApi.prune({ expiredOnly: true }),
    onSuccess: async (result) => {
      toast.success(localize(locale, `已清理 ${String(result.deletedCount)} 条过期记忆`, `Pruned ${String(result.deletedCount)} expired items`));
      await queryClient.invalidateQueries({ queryKey: ["memory"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "清理记忆失败", "Failed to prune memory"));
    },
  });

  const storeMutation = useMutation({
    mutationFn: (input: { namespace: string; content: string; key: string; tags: string[]; memoryType: FridayMemoryType; confidence: number }) =>
      memoryApi.store(input),
    onSuccess: async () => {
      toast.success(localize(locale, "记忆已保存", "Memory item stored"));
      setShowAddForm(false);
      await queryClient.invalidateQueries({ queryKey: ["memory"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "保存记忆失败", "Failed to store memory item"));
    },
  });

  const [showAddForm, setShowAddForm] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const handleSearch = () => {
    setActiveSearch(searchQuery.trim());
  };

  const displayItems: FridayMemoryItem[] = activeSearch.length > 0
    ? (searchResults ?? []).map((r) => r.item)
    : items;
  const searchResultById = new Map((searchResults ?? []).map((result) => [result.item.id, result]));

  return (
    <div data-ui-screen="desktop-memory-passport" className="space-y-4">
      <section data-ui-component="memory-passport-header" className="rounded-2xl border border-[color:var(--color-accent-soft)] bg-[color:var(--color-accent-muted)] p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[color:var(--color-text-tertiary)]">Memory Passport</p>
            <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">
              {localize(locale, "教 Friday 记住你需要的", "Teach Friday what you need")}
            </p>
            <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">
              {localize(
                locale,
                "主动告诉 Friday 需要记住的信息；no silent memory write，保存和召回都要经过可见边界。",
                "Tell Friday what to remember; no silent memory write, and stored memory / recall stay behind visible boundaries.",
              )}
            </p>
          </div>
          <ActionButton onClick={() => setShowAddForm(true)}>
            <Brain className="mr-2 h-4 w-4" aria-hidden="true" />
            {localize(locale, "添加记忆", "Add Memory")}
          </ActionButton>
        </div>
      </section>

      <section data-ui-component="memory-authority-boundaries" className="grid gap-3 lg:grid-cols-3">
        <div className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[color:var(--color-text-primary)]">
            <ShieldCheck className="h-4 w-4 text-[color:var(--color-accent)]" aria-hidden="true" />
            {localize(locale, "写入权限", "Write authority")}
          </div>
          <p className="text-xs leading-5 text-[color:var(--color-text-secondary)]">
            memory_review_no_silent_write_decide_candidate · no silent memory write · candidate_review_only.
          </p>
        </div>
        <div className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4">
          <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">{localize(locale, "召回边界", "Recall boundary")}</p>
          <p className="mt-2 text-xs leading-5 text-[color:var(--color-text-secondary)]">
            stored memory !== automatic recall PASS; runtime recall proof required before any task claims it used memory.
          </p>
        </div>
        <div className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4">
          <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">{localize(locale, "缺口状态", "Gap state")}</p>
          <p className="mt-2 text-xs leading-5 text-[color:var(--color-text-secondary)]">
            NO-GO for hidden learning, background writes, and unproven automatic recall.
          </p>
        </div>
      </section>

      <section data-ui-component="memory-candidate-review-boundary" className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">{localize(locale, "候选记忆审查", "Candidate memory review")}</p>
            <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">
              Candidate rows must stay candidate_review_only until the Memory Spine decision route records explicit approval or rejection.
            </p>
          </div>
          <StatusPill tone="warning">NO-GO</StatusPill>
        </div>
      </section>

      <ShellCard eyebrow={localize(locale, "记忆存储", "Memory Store")} title={localize(locale, "已记忆的知识", "Stored Knowledge")}>
        <div className="space-y-4">
          <p className="text-sm text-[color:var(--color-text-secondary)]">
            {localize(
              locale,
              "这里展示 Friday 已保存的记忆、类型、置信度和访问痕迹；自动召回仍受权限、排序和上下文边界约束。",
              "This shows saved memories, type, confidence, and access traces; automatic recall still follows permission, ranking, and context boundaries.",
            )}
          </p>

          <div data-ui-component="memory-passport-search" className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_180px_auto_auto]">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--color-text-faint)]" aria-hidden="true" />
              <input
                type="text"
                aria-label={localize(locale, "搜索记忆", "Search memories")}
                placeholder={localize(locale, "搜索记忆...", "Search memories...")}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSearch();
                }}
                className="agent-input py-2 pl-10 pr-4 text-sm"
              />
            </div>
            <select
              value={searchMemoryType}
              onChange={(e) => setSearchMemoryType(e.target.value as "all" | FridayMemoryType)}
              aria-label={localize(locale, "按记忆类型筛选", "Filter by memory type")}
              className="agent-select px-3 py-2 text-sm"
            >
              <option value="all">{localize(locale, "全部类型", "All types")}</option>
              {MEMORY_TYPES.map((type) => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
            <label className="inline-flex min-h-[40px] items-center gap-2 rounded-xl border border-[color:var(--color-border-soft)] px-3 text-sm text-[color:var(--color-text-secondary)]">
              <input
                type="checkbox"
                checked={boostByConfidence}
                onChange={(e) => setBoostByConfidence(e.target.checked)}
              />
              {localize(locale, "置信度排序", "Confidence boost")}
            </label>
            <ActionButton onClick={handleSearch} disabled={searchQuery.trim().length === 0}>
              {localize(locale, "搜索", "Search")}
            </ActionButton>
            {activeSearch.length > 0 && (
              <ActionButton
                tone="secondary"
                onClick={() => {
                  setSearchQuery("");
                  setActiveSearch("");
                }}
              >
                {localize(locale, "清除", "Clear")}
              </ActionButton>
            )}
          </div>

          {isSearchError && activeSearch.length > 0 && (
            <p className="text-sm status-error">{localize(locale, "搜索失败，请重试。", "Search failed. Please try again.")}</p>
          )}

          <div className="flex items-center justify-between">
            <p className="text-xs text-[color:var(--color-text-faint)]">
              {isSearching
                ? localize(locale, "搜索中...", "Searching...")
                : activeSearch
                  ? localize(locale, `"${activeSearch}" 的 ${String(displayItems.length)} 条结果`, `${String(displayItems.length)} results for "${activeSearch}"`)
                  : localize(locale, `共 ${String(displayItems.length)} 条记忆`, `${String(displayItems.length)} items total`)}
            </p>
            <div data-ui-component="memory-passport-store" className="flex gap-2">
              <ActionButton tone="secondary" onClick={() => setShowAddForm(!showAddForm)}>
                <Plus className="mr-1 h-3 w-3" aria-hidden="true" />
                {localize(locale, "添加记忆", "Add Memory")}
              </ActionButton>
              <ActionButton tone="secondary" onClick={() => pruneMutation.mutate()} disabled={pruneMutation.isPending}>
                {localize(locale, "清理过期", "Prune Expired")}
              </ActionButton>
            </div>
          </div>

          {showAddForm && (
            <AddMemoryForm
              locale={locale}
              onSubmit={(input) => storeMutation.mutate(input)}
              pending={storeMutation.isPending}
              onCancel={() => setShowAddForm(false)}
            />
          )}
        </div>
      </ShellCard>

      {isLoading ? (
        <ShellCard>
          <SkeletonList rows={4} />
        </ShellCard>
      ) : displayItems.length === 0 ? (
        <ShellCard>
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <Brain className="h-8 w-8 text-[color:var(--color-text-faint)]" aria-hidden="true" />
            <p className="text-sm text-[color:var(--color-text-secondary)]">
              {activeSearch
                ? localize(locale, "没有匹配的记忆。", "No memories match your search.")
                : localize(
                  locale,
                  "暂无记忆。经审核或已启用的学习流程保存后，新记忆会显示在这里。",
                  "No memories stored yet. New memories appear here after review or enabled learning flows save them.",
                )}
            </p>
          </div>
        </ShellCard>
      ) : (
        <div className="space-y-3">
          {displayItems.map((item) => (
            <ShellCard key={item.id}>
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill tone={toneForNamespace(item.namespace)}>{item.namespace}</StatusPill>
                      {item.memoryType ? <StatusPill>{item.memoryType}</StatusPill> : null}
                      {typeof item.confidence === "number" ? (
                        <StatusPill tone={item.confidence >= 0.75 ? "success" : item.confidence >= 0.45 ? "warning" : "neutral"}>
                          {localize(locale, `置信度 ${formatPercent(item.confidence)}`, `confidence ${formatPercent(item.confidence)}`)}
                        </StatusPill>
                      ) : null}
                      {item.source ? <StatusPill>{item.source}</StatusPill> : null}
                      {activeSearch ? (
                        <StatusPill tone="neutral">
                          {localize(locale, `匹配 ${formatPercent(searchResultById.get(item.id)?.score)}`, `match ${formatPercent(searchResultById.get(item.id)?.score)}`)}
                        </StatusPill>
                      ) : null}
                      {item.expiresAt ? (
                        <span className="text-xs text-[color:var(--color-text-faint)]">
                          {localize(locale, "过期于", "expires")} {formatTimestamp(item.expiresAt)}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-2 text-sm font-medium text-[color:var(--color-text-primary)]">{item.key}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDeleteConfirmId(item.id)}
                    disabled={deleteMutation.isPending}
                    aria-label={localize(locale, "删除此记忆", "Delete this memory")}
                    data-ui-component="memory-passport-delete-request"
                    className="shrink-0 rounded-xl p-2 text-[color:var(--color-text-faint)] transition-colors hover:bg-[color:var(--color-bg-contrast)] hover:text-[color:var(--color-text-primary)]"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>

                <p className="whitespace-pre-wrap text-sm text-[color:var(--color-text-secondary)]">{item.content}</p>

                {item.tags.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Tag className="h-3 w-3 text-[color:var(--color-text-faint)]" aria-hidden="true" />
                    {item.tags.map((tag) => (
                      <span key={tag} className="rounded-full bg-[color:var(--color-bg-subtle)] px-2 py-0.5 text-xs text-[color:var(--color-text-tertiary)]">
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}

                <p className="text-xs text-[color:var(--color-text-faint)]">
                  {localize(locale, "创建于", "Created")} {formatTimestamp(item.createdAt)}
                  {item.updatedAt !== item.createdAt ? ` · ${localize(locale, "更新于", "Updated")} ${formatTimestamp(item.updatedAt)}` : ""}
                  {typeof item.accessCount === "number" ? ` · ${localize(locale, "访问", "Accessed")} ${String(item.accessCount)}x` : ""}
                  {item.lastAccessedAt ? ` · ${localize(locale, "最后访问", "Last accessed")} ${formatTimestamp(item.lastAccessedAt)}` : ""}
                </p>
              </div>
            </ShellCard>
          ))}
        </div>
      )}
      <section data-ui-component="memory-passport-export-boundary" className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">{localize(locale, "导出与证明", "Export and proof")}</p>
            <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">
              Export is a review surface; stored memory !== automatic recall PASS, and runtime recall proof required before closing any memory-backed claim.
            </p>
          </div>
          <ActionButton tone="secondary" disabled>
            <FileDown className="mr-2 h-4 w-4" aria-hidden="true" />
            {localize(locale, "导出待证明", "Export pending proof")}
          </ActionButton>
        </div>
      </section>
      <ConfirmDialog
        open={deleteConfirmId !== null}
        title={localize(locale, "确认删除记忆", "Delete Memory")}
        description={localize(locale, "此操作不可撤销。", "This action cannot be undone.")}
        confirmLabel={localize(locale, "删除", "Delete")}
        cancelLabel={localize(locale, "取消", "Cancel")}
        tone="danger"
        loading={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteConfirmId) {
            deleteMutation.mutate(deleteConfirmId);
            setDeleteConfirmId(null);
          }
        }}
        onCancel={() => setDeleteConfirmId(null)}
      />
    </div>
  );
}

function AddMemoryForm(props: {
  locale: import("@/lib/i18n/localized-text").AppLocale;
  onSubmit: (input: { namespace: string; content: string; key: string; tags: string[]; memoryType: FridayMemoryType; confidence: number }) => void;
  pending: boolean;
  onCancel: () => void;
}) {
  const { locale } = props;
  const [namespace, setNamespace] = useState("user");
  const [key, setKey] = useState("");
  const [content, setContent] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [memoryType, setMemoryType] = useState<FridayMemoryType>("preference");
  const [confidence, setConfidence] = useState(1);

  const canSubmit = key.trim().length > 0 && content.trim().length > 0;

  return (
    <div className="space-y-3 rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
      <p className="text-xs uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">{localize(locale, "添加记忆项", "Add memory item")}</p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs text-[color:var(--color-text-tertiary)]">{localize(locale, "命名空间", "Namespace")}</label>
          <select
            value={namespace}
            onChange={(e) => setNamespace(e.target.value)}
            className="agent-select px-3 py-2 text-sm"
          >
            <option value="user">{localize(locale, "用户", "user")}</option>
            <option value="preference">{localize(locale, "偏好", "preference")}</option>
            <option value="system">{localize(locale, "系统", "system")}</option>
            <option value="agent">{localize(locale, "agent", "agent")}</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-[color:var(--color-text-tertiary)]">{localize(locale, "键名", "Key")}</label>
          <input
            type="text"
            placeholder={localize(locale, "例如: 常用语言", "e.g. favorite-language")}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="agent-input px-3 py-2 text-sm"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs text-[color:var(--color-text-tertiary)]">{localize(locale, "类型", "Type")}</label>
          <select
            value={memoryType}
            onChange={(e) => setMemoryType(e.target.value as FridayMemoryType)}
            className="agent-select px-3 py-2 text-sm"
          >
            {MEMORY_TYPES.map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-[color:var(--color-text-tertiary)]">
            {localize(locale, `置信度 ${formatPercent(confidence)}`, `Confidence ${formatPercent(confidence)}`)}
          </label>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={confidence}
            onChange={(e) => setConfidence(Number(e.target.value))}
            className="w-full"
          />
        </div>
      </div>
      <div>
        <label className="mb-1 block text-xs text-[color:var(--color-text-tertiary)]">{localize(locale, "内容", "Content")}</label>
        <textarea
          rows={3}
          placeholder={localize(locale, "需要记住的信息...", "The information to remember...")}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="agent-textarea resize-none px-3 py-2 text-sm"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-[color:var(--color-text-tertiary)]">{localize(locale, "标签（逗号分隔）", "Tags (comma-separated)")}</label>
        <input
          type="text"
          placeholder={localize(locale, "例如: 语言, 偏好", "e.g. lang, preference")}
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
          className="agent-input px-3 py-2 text-sm"
        />
      </div>
      <div className="flex gap-2">
        <ActionButton
          disabled={!canSubmit || props.pending}
          onClick={() =>
            props.onSubmit({
              namespace,
              key: key.trim(),
              content: content.trim(),
              tags: tagsInput
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
              memoryType,
              confidence,
            })
          }
        >
          {props.pending ? localize(locale, "保存中...", "Storing...") : localize(locale, "保存", "Store")}
        </ActionButton>
        <ActionButton tone="secondary" onClick={props.onCancel}>
          {localize(locale, "取消", "Cancel")}
        </ActionButton>
      </div>
    </div>
  );
}
