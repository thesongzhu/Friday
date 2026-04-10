import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Plus, Search, Tag, Trash2 } from "lucide-react";
import { SkeletonList } from "@/components/core/primitives";
import { toast } from "sonner";
import { ActionButton, ConfirmDialog, ShellCard, StatusPill } from "@/components/core/primitives";
import { memoryApi } from "@/lib/api/memory";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";
import type { FridayMemoryItem } from "@/lib/api/types";

function formatTimestamp(value?: string): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function toneForNamespace(ns: string): "neutral" | "success" | "warning" {
  if (ns === "preference" || ns === "user") return "success";
  if (ns === "system" || ns === "agent") return "warning";
  return "neutral";
}

export function MemoryPage() {
  const queryClient = useQueryClient();
  const { locale } = useAppLocale();
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearch, setActiveSearch] = useState("");

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["memory", "items"],
    queryFn: () => memoryApi.listItems({ limit: 100 }),
  });

  const { data: searchResults } = useQuery({
    queryKey: ["memory", "search", activeSearch],
    queryFn: () => memoryApi.search({ query: activeSearch, limit: 20 }),
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
    mutationFn: (input: { namespace: string; content: string; key: string; tags: string[] }) =>
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

  return (
    <div className="space-y-4">
      {/* Teach Friday quick action */}
      <div className="rounded-2xl border border-[color:var(--color-accent-soft)] bg-[color:var(--color-accent-muted)] p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">
              {localize(locale, "教 Friday 记住你需要的", "Teach Friday what you need")}
            </p>
            <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">
              {localize(locale, "主动告诉 Friday 需要记住的信息，让它更了解你的工作方式。", "Tell Friday what to remember so it understands your workflow better.")}
            </p>
          </div>
          <ActionButton onClick={() => setShowAddForm(true)}>
            <Brain className="mr-2 h-4 w-4" aria-hidden="true" />
            {localize(locale, "添加记忆", "Add Memory")}
          </ActionButton>
        </div>
      </div>

      <ShellCard eyebrow={localize(locale, "记忆存储", "Memory Store")} title={localize(locale, "已记忆的知识", "Stored Knowledge")}>
        <div className="space-y-4">
          <p className="text-sm text-[color:var(--color-text-secondary)]">
            {localize(
              locale,
              "Friday 会跨会话记住事实、偏好和上下文。这里展示的项目存储在记忆系统中，用于个性化响应。",
              "Friday remembers facts, preferences, and context across sessions. Items shown here are stored in the memory subsystem and used to personalize responses.",
            )}
          </p>

          <div className="flex gap-2">
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

          <div className="flex items-center justify-between">
            <p className="text-xs text-[color:var(--color-text-faint)]">
              {activeSearch
                ? localize(locale, `"${activeSearch}" 的 ${String(displayItems.length)} 条结果`, `${String(displayItems.length)} results for "${activeSearch}"`)
                : localize(locale, `共 ${String(displayItems.length)} 条记忆`, `${String(displayItems.length)} items total`)}
            </p>
            <div className="flex gap-2">
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
                : localize(locale, "暂无记忆。Friday 会在你使用过程中自动学习。", "No memories stored yet. Friday will learn as you interact.")}
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
                      {item.source ? <StatusPill>{item.source}</StatusPill> : null}
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
                </p>
              </div>
            </ShellCard>
          ))}
        </div>
      )}
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
  onSubmit: (input: { namespace: string; content: string; key: string; tags: string[] }) => void;
  pending: boolean;
  onCancel: () => void;
}) {
  const { locale } = props;
  const [namespace, setNamespace] = useState("user");
  const [key, setKey] = useState("");
  const [content, setContent] = useState("");
  const [tagsInput, setTagsInput] = useState("");

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
