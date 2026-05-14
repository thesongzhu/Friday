import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Box, ExternalLink, Trash2, ToggleLeft, ToggleRight } from "lucide-react";
import { SkeletonList } from "@/components/core/primitives";
import { toast } from "sonner";
import { ActionButton, ConfirmDialog, ShellCard, StatusPill } from "@/components/core/primitives";
import { assetsApi } from "@/lib/api/assets";
import type { FridayAssetInventoryItem, FridayAssetInventoryCategory } from "@/lib/api/assets";
import { automationsApi } from "@/lib/api/automations";
import { apiClient } from "@/lib/api/client";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";
import { useNavigate } from "react-router-dom";

type PendingAction =
  | { type: "delete_fact"; factKey: string }
  | { type: "delete_automation"; automationId: string; name: string }
  | { type: "disable_automation"; automationId: string; name: string }
  | { type: "enable_automation"; automationId: string; name: string };

function statusTone(status: string): "neutral" | "success" | "warning" | "danger" {
  switch (status) {
    case "active":
    case "enabled":
    case "high_confidence":
      return "success";
    case "disabled":
    case "low_confidence":
      return "warning";
    case "error":
    case "unhealthy":
      return "danger";
    default:
      return "neutral";
  }
}

function kindLabel(kind: string, locale: ReturnType<typeof useAppLocale>["locale"]): string {
  const labels: Record<string, [string, string]> = {
    skill: ["技能", "Skill"],
    workflow: ["工作流", "Workflow"],
    provider_profile: ["供应商", "Provider"],
    plugin: ["插件", "Plugin"],
    mcp_server: ["MCP 服务器", "MCP Server"],
    channel_adapter: ["渠道", "Channel"],
    learned_fact: ["已学习", "Learned Fact"],
    automation: ["自动化", "Automation"],
  };
  const pair = labels[kind];
  return pair ? localize(locale, pair[0], pair[1]) : kind;
}

function categoryTitle(category: FridayAssetInventoryCategory, locale: ReturnType<typeof useAppLocale>["locale"]): string {
  switch (category) {
    case "runtime":
      return localize(locale, "运行时资产", "Runtime Assets");
    case "knowledge":
      return localize(locale, "已学习知识", "Learned Knowledge");
    case "automation":
      return localize(locale, "自动化", "Automations");
  }
}

function categoryDescription(category: FridayAssetInventoryCategory, locale: ReturnType<typeof useAppLocale>["locale"]): string {
  switch (category) {
    case "runtime":
      return localize(locale, "技能、工作流、供应商、插件、MCP 服务器和渠道适配器。", "Skills, workflows, providers, plugins, MCP servers, and channel adapters.");
    case "knowledge":
      return localize(locale, "Friday 跨会话学到的偏好和事实。", "Preferences and facts Friday has learned across sessions.");
    case "automation":
      return localize(locale, "可复用的自动化任务模板。", "Reusable automation task templates.");
  }
}

function formatDetail(key: string, value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

export function AssetsPage() {
  const queryClient = useQueryClient();
  const { locale } = useAppLocale();
  const navigate = useNavigate();
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["assets", "inventory"],
    queryFn: () => assetsApi.listInventory(),
  });

  const items = data?.items ?? [];
  const categories = data?.categories ?? [];

  const deleteFactMutation = useMutation({
    mutationFn: (factKey: string) =>
      apiClient.del<{ ok: boolean }>(`/v1/uix/learned-facts/${encodeURIComponent(factKey)}`),
    onSuccess: async () => {
      toast.success(localize(locale, "已删除学习事实", "Learned fact deleted"));
      await queryClient.invalidateQueries({ queryKey: ["assets"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "删除失败", "Failed to delete"));
    },
  });

  const deleteAutomationMutation = useMutation({
    mutationFn: (automationId: string) => automationsApi.remove(automationId),
    onSuccess: async () => {
      toast.success(localize(locale, "已删除自动化", "Automation deleted"));
      await queryClient.invalidateQueries({ queryKey: ["assets"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "删除失败", "Failed to delete"));
    },
  });

  const toggleAutomationMutation = useMutation({
    mutationFn: (input: { automationId: string; enabled: boolean }) =>
      automationsApi.update(input.automationId, { enabled: input.enabled }),
    onSuccess: async () => {
      toast.success(localize(locale, "自动化已更新", "Automation updated"));
      await queryClient.invalidateQueries({ queryKey: ["assets"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "更新失败", "Failed to update"));
    },
  });

  const isMutating = deleteFactMutation.isPending || deleteAutomationMutation.isPending || toggleAutomationMutation.isPending;

  function handleConfirm() {
    if (!pendingAction) return;
    switch (pendingAction.type) {
      case "delete_fact":
        deleteFactMutation.mutate(pendingAction.factKey);
        break;
      case "delete_automation":
        deleteAutomationMutation.mutate(pendingAction.automationId);
        break;
      case "disable_automation":
        toggleAutomationMutation.mutate({ automationId: pendingAction.automationId, enabled: false });
        break;
      case "enable_automation":
        toggleAutomationMutation.mutate({ automationId: pendingAction.automationId, enabled: true });
        break;
    }
    setPendingAction(null);
  }

  function confirmDialogTitle(): string {
    if (!pendingAction) return "";
    switch (pendingAction.type) {
      case "delete_fact":
        return localize(locale, "确认删除学习事实", "Delete Learned Fact");
      case "delete_automation":
        return localize(locale, "确认删除自动化", "Delete Automation");
      case "disable_automation":
        return localize(locale, "确认禁用自动化", "Disable Automation");
      case "enable_automation":
        return localize(locale, "确认启用自动化", "Enable Automation");
    }
  }

  function confirmDialogDescription(): string {
    if (!pendingAction) return "";
    switch (pendingAction.type) {
      case "delete_fact":
        return localize(locale, "此操作不可撤销。", "This action cannot be undone.");
      case "delete_automation":
        return localize(locale, "此操作不可撤销。", "This action cannot be undone.");
      case "disable_automation":
        return localize(locale, `确定要禁用自动化 "${pendingAction.name}" 吗？`, `Disable automation "${pendingAction.name}"?`);
      case "enable_automation":
        return localize(locale, `确定要启用自动化 "${pendingAction.name}" 吗？`, `Enable automation "${pendingAction.name}"?`);
    }
  }

  function confirmDialogTone(): "danger" | "primary" {
    if (!pendingAction) return "primary";
    return pendingAction.type === "delete_fact" || pendingAction.type === "delete_automation" ? "danger" : "primary";
  }

  function renderItem(item: FridayAssetInventoryItem) {
    const detailEntries = Object.entries(item.details).filter(([, v]) => v !== undefined && v !== null);

    return (
      <div key={`${item.category}-${item.id}`} className="space-y-2 rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-base)] p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone={statusTone(item.status)}>{item.status}</StatusPill>
              <StatusPill>{kindLabel(item.kind, locale)}</StatusPill>
            </div>
            <p className="mt-2 text-sm font-medium text-[color:var(--color-text-primary)]">{item.displayName}</p>
          </div>
          <div className="flex shrink-0 gap-1">
            {item.controls.viewUrl ? (
              <button
                type="button"
                onClick={() => navigate(item.controls.viewUrl!)}
                aria-label={localize(locale, "查看", "View")}
                className="rounded-xl p-2 text-[color:var(--color-text-faint)] transition-colors hover:bg-[color:var(--color-bg-contrast)] hover:text-[color:var(--color-text-primary)]"
              >
                <ExternalLink className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : null}
            {item.controls.canDisable && item.category === "automation" ? (
              <button
                type="button"
                onClick={() =>
                  setPendingAction(
                    item.status === "enabled"
                      ? { type: "disable_automation", automationId: item.id, name: item.displayName }
                      : { type: "enable_automation", automationId: item.id, name: item.displayName },
                  )
                }
                disabled={isMutating}
                aria-label={item.status === "enabled" ? localize(locale, "禁用", "Disable") : localize(locale, "启用", "Enable")}
                className="rounded-xl p-2 text-[color:var(--color-text-faint)] transition-colors hover:bg-[color:var(--color-bg-contrast)] hover:text-[color:var(--color-text-primary)]"
              >
                {item.status === "enabled" ? <ToggleRight className="h-4 w-4" aria-hidden="true" /> : <ToggleLeft className="h-4 w-4" aria-hidden="true" />}
              </button>
            ) : null}
            {item.controls.canDelete ? (
              <button
                type="button"
                onClick={() => {
                  if (item.category === "knowledge") {
                    setPendingAction({ type: "delete_fact", factKey: item.id });
                  } else if (item.category === "automation") {
                    setPendingAction({ type: "delete_automation", automationId: item.id, name: item.displayName });
                  }
                }}
                disabled={isMutating}
                aria-label={localize(locale, "删除", "Delete")}
                className="rounded-xl p-2 text-[color:var(--color-text-faint)] transition-colors hover:bg-[color:var(--color-bg-contrast)] hover:text-[color:var(--color-text-primary)]"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>

        {detailEntries.length > 0 ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[color:var(--color-text-faint)]">
            {detailEntries.map(([key, value]) => (
              <span key={key}>
                {key}: <span className="text-[color:var(--color-text-secondary)]">{formatDetail(key, value)}</span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  const categoryOrder: FridayAssetInventoryCategory[] = ["runtime", "knowledge", "automation"];

  return (
    <div className="space-y-4">
      <ShellCard
        eyebrow={localize(locale, "资产库", "Asset Inventory")}
        title={localize(locale, "统一资产库存", "Unified Asset Inventory")}
      >
        <p className="text-sm text-[color:var(--color-text-secondary)]">
          {localize(
            locale,
            "Friday 管理的所有运行时资产、学习知识和自动化任务。",
            "All runtime assets, learned knowledge, and automations managed by Friday.",
          )}
        </p>
      </ShellCard>

      {isLoading ? (
        <ShellCard>
          <SkeletonList rows={6} />
        </ShellCard>
      ) : (
        categoryOrder
          .filter((cat) => categories.includes(cat))
          .map((cat) => {
            const catItems = items.filter((i) => i.category === cat);
            return (
              <ShellCard key={cat} eyebrow={categoryTitle(cat, locale)} title={categoryTitle(cat, locale)}>
                <p className="mb-4 text-sm text-[color:var(--color-text-secondary)]">
                  {categoryDescription(cat, locale)}
                </p>
                {catItems.length === 0 ? (
                  <div className="flex flex-col items-center gap-3 py-6 text-center">
                    <Box className="h-8 w-8 text-[color:var(--color-text-faint)]" aria-hidden="true" />
                    <p className="text-sm text-[color:var(--color-text-secondary)]">
                      {localize(locale, "此分类暂无资产。", "No assets in this category.")}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {catItems.map(renderItem)}
                  </div>
                )}
              </ShellCard>
            );
          })
      )}

      <ConfirmDialog
        open={pendingAction !== null}
        title={confirmDialogTitle()}
        description={confirmDialogDescription()}
        confirmLabel={
          pendingAction?.type === "enable_automation"
            ? localize(locale, "启用", "Enable")
            : pendingAction?.type === "disable_automation"
              ? localize(locale, "禁用", "Disable")
              : localize(locale, "删除", "Delete")
        }
        cancelLabel={localize(locale, "取消", "Cancel")}
        tone={confirmDialogTone()}
        loading={isMutating}
        onConfirm={handleConfirm}
        onCancel={() => setPendingAction(null)}
      />
    </div>
  );
}
