import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, PackagePlus, Power, PowerOff, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ActionButton, ConfirmDialog, EmptyState, FieldLabel, ShellCard, SkeletonCard, StatusPill } from "@/components/core/primitives";
import { healthApi } from "@/lib/api/health";
import { pluginsApi, type FridayPluginEntity, type FridayPluginLifecycleEvidence } from "@/lib/api/plugins";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";

function formatTimestamp(value?: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function pluginTone(status: FridayPluginEntity["status"]): "neutral" | "success" | "warning" | "danger" {
  switch (status) {
    case "running":
    case "enabled":
      return "success";
    case "configured":
    case "installed":
    case "disabled":
      return "warning";
    case "error":
      return "danger";
    default:
      return "neutral";
  }
}

function pluginRequiresLifecycleReview(plugin: FridayPluginEntity): boolean {
  if (plugin.source !== "local") {
    return false;
  }
  return !(plugin.promotionChannel === "active" && plugin.compatibilityStatus === "compatible");
}

function lifecycleTone(plugin: FridayPluginEntity): "neutral" | "success" | "warning" | "danger" {
  if (plugin.promotionChannel === "active" && plugin.compatibilityStatus === "compatible") {
    return "success";
  }
  if (plugin.promotionChannel === "canary" || plugin.promotionChannel === "shadow") {
    return "warning";
  }
  if (plugin.compatibilityStatus === "blocked" || plugin.status === "error") {
    return "danger";
  }
  return "neutral";
}

function PluginInventoryCard(props: {
  plugin: FridayPluginEntity;
  lifecycleEvidence?: FridayPluginLifecycleEvidence;
  onEnable: (plugin: FridayPluginEntity) => void;
  onDisable: (pluginId: string) => void;
  onUninstall: (pluginId: string) => void;
  busyPluginId: string | null;
}) {
  const { locale } = useAppLocale();
  const { plugin, lifecycleEvidence, busyPluginId } = props;
  const isBusy = busyPluginId === plugin.id;
  const permissionCount = plugin.manifest.permissions.grants.length;
  const requiredCapabilities = plugin.manifest.requiredCapabilities ?? [];
  const requiresLifecycleReview = pluginRequiresLifecycleReview(plugin);
  const lifecycleLabel = plugin.promotionChannel
    ? `${plugin.promotionChannel}${plugin.compatibilityStatus ? ` / ${plugin.compatibilityStatus}` : ""}`
    : localize(locale, "未审查", "not reviewed");

  return (
    <div className="rounded-[28px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-5 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-base font-semibold text-[color:var(--color-text-primary)]">{plugin.name}</p>
            <StatusPill tone={pluginTone(plugin.status)}>{plugin.status}</StatusPill>
            <StatusPill tone={plugin.signatureVerified ? "success" : "neutral"}>
              {plugin.signatureVerified ? localize(locale, "签名已验证", "signature verified") : localize(locale, "未验证签名", "unsigned or unverified")}
            </StatusPill>
            <StatusPill tone={lifecycleTone(plugin)}>
              {lifecycleLabel}
            </StatusPill>
          </div>
          <p className="mt-1 text-xs text-[color:var(--color-text-tertiary)]">{plugin.id}</p>
          <p className="mt-3 text-sm leading-6 text-[color:var(--color-text-secondary)]">{plugin.description}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {plugin.enabled ? (
            <ActionButton tone="secondary" disabled={isBusy} onClick={() => props.onDisable(plugin.id)}>
              <PowerOff className="mr-2 h-4 w-4" />
              {localize(locale, "停用", "Disable")}
            </ActionButton>
          ) : (
            <ActionButton tone="secondary" disabled={isBusy || plugin.status === "uninstalled"} onClick={() => props.onEnable(plugin)}>
              {requiresLifecycleReview ? (
                <ShieldCheck className="mr-2 h-4 w-4" />
              ) : (
                <Power className="mr-2 h-4 w-4" />
              )}
              {requiresLifecycleReview
                ? localize(locale, "审查并启用", "Review & Enable")
                : localize(locale, "启用", "Enable")}
            </ActionButton>
          )}
          <ActionButton tone="danger" disabled={isBusy} onClick={() => props.onUninstall(plugin.id)}>
            <Trash2 className="mr-2 h-4 w-4" />
            {localize(locale, "卸载", "Uninstall")}
          </ActionButton>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl bg-[color:var(--color-bg-subtle)] px-4 py-3">
          <p className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{localize(locale, "来源", "Source")}</p>
          <p className="mt-1 text-sm text-[color:var(--color-text-primary)]">{plugin.source}</p>
        </div>
        <div className="rounded-2xl bg-[color:var(--color-bg-subtle)] px-4 py-3">
          <p className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{localize(locale, "类型", "Kinds")}</p>
          <p className="mt-1 text-sm text-[color:var(--color-text-primary)]">{plugin.kinds.join(", ") || "—"}</p>
        </div>
        <div className="rounded-2xl bg-[color:var(--color-bg-subtle)] px-4 py-3">
          <p className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{localize(locale, "权限", "Permissions")}</p>
          <p className="mt-1 text-sm text-[color:var(--color-text-primary)]">{String(permissionCount)}</p>
        </div>
        <div className="rounded-2xl bg-[color:var(--color-bg-subtle)] px-4 py-3">
          <p className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{localize(locale, "更新时间", "Updated")}</p>
          <p className="mt-1 text-sm text-[color:var(--color-text-primary)]">{formatTimestamp(plugin.updatedAt)}</p>
        </div>
      </div>

      <div className="mt-4 space-y-2 text-xs text-[color:var(--color-text-secondary)]">
        <p><span className="font-medium text-[color:var(--color-text-primary)]">{localize(locale, "安装目录", "Install path")}:</span> {plugin.installPath}</p>
        <p><span className="font-medium text-[color:var(--color-text-primary)]">{localize(locale, "信任模式", "Trust mode")}:</span> {plugin.trustMode}</p>
        <p><span className="font-medium text-[color:var(--color-text-primary)]">{localize(locale, "生命周期", "Lifecycle")}:</span> {lifecycleLabel}</p>
        <p><span className="font-medium text-[color:var(--color-text-primary)]">{localize(locale, "必需宿主能力", "Required host capabilities")}:</span> {requiredCapabilities.join(", ") || localize(locale, "无", "none")}</p>
      </div>

      {plugin.lastErrorMessage ? (
        <div className="mt-4 rounded-2xl border border-[color:var(--color-border-danger)] bg-[color:var(--color-bg-danger-subtle)] px-4 py-3 text-sm text-[color:var(--color-text-danger)]">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">{localize(locale, "最后错误", "Latest error")}</p>
              <p className="mt-1 leading-6">{plugin.lastErrorMessage}</p>
            </div>
          </div>
        </div>
      ) : null}

      {lifecycleEvidence ? (
        <div className="mt-4 rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-3 text-xs text-[color:var(--color-text-secondary)]">
          <p className="font-medium text-[color:var(--color-text-primary)]">
            {localize(locale, "最近生命周期证据", "Latest lifecycle evidence")}
          </p>
          <p className="mt-1">
            {localize(locale, "阶段", "Stage")}: {lifecycleEvidence.stage ?? "—"}
            {" · "}
            {localize(locale, "Canary", "Canary")}: {lifecycleEvidence.canarySuccessCount ?? 0}/{lifecycleEvidence.canaryFailureCount ?? 0}
          </p>
          <p className="mt-1 break-all">
            {localize(locale, "父审批票据", "Parent approval ticket")}: {lifecycleEvidence.parentLifecycleTicketId ?? "—"}
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function PluginsPage() {
  const { locale } = useAppLocale();
  const queryClient = useQueryClient();
  const [installPluginId, setInstallPluginId] = useState("");
  const [installPath, setInstallPath] = useState("");
  const [installTrustOnInstall, setInstallTrustOnInstall] = useState(false);
  const [pendingUninstallId, setPendingUninstallId] = useState<string | null>(null);
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null);
  const [latestLifecycleEvidence, setLatestLifecycleEvidence] = useState<Record<string, FridayPluginLifecycleEvidence>>({});

  const healthQuery = useQuery({
    queryKey: ["health", "plugins-page"],
    queryFn: () => healthApi.getCapabilityHealth(),
    refetchInterval: 30_000,
  });
  const pluginsQuery = useQuery({
    queryKey: ["plugins", "inventory"],
    queryFn: () => pluginsApi.listPlugins(),
    refetchInterval: 15_000,
  });

  const health = healthQuery.data;
  const pluginRuntimeMode = health?.capabilities?.plugins?.runtimeMode ?? "stub";

  const plugins = pluginsQuery.data ?? [];
  const installedCount = plugins.length;
  const activeCount = useMemo(
    () => plugins.filter((plugin) => plugin.enabled || plugin.status === "running" || plugin.status === "enabled").length,
    [plugins],
  );

  const installLocalMutation = useMutation({
    mutationFn: async () => {
      setBusyPluginId(installPluginId.trim() || null);
      return pluginsApi.installLocal({
        pluginId: installPluginId.trim(),
        installPath: installPath.trim(),
        userApproved: installTrustOnInstall,
      });
    },
    onSuccess: (plugin) => {
      toast.success(locale === "zh" ? `已安装 ${plugin.name}` : `Installed ${plugin.name}`);
      setInstallPluginId("");
      setInstallPath("");
      setInstallTrustOnInstall(false);
      void queryClient.invalidateQueries({ queryKey: ["plugins"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "插件安装失败", "Plugin install failed"));
    },
    onSettled: () => {
      setBusyPluginId(null);
    },
  });

  const enableMutation = useMutation({
    mutationFn: async (plugin: FridayPluginEntity) => {
      setBusyPluginId(plugin.id);
      if (pluginRequiresLifecycleReview(plugin)) {
        return pluginsApi.reviewEnable(plugin.id);
      }
      return { plugin: await pluginsApi.enable(plugin.id) };
    },
    onSuccess: (result) => {
      const { plugin, evidence } = result;
      if (evidence) {
        setLatestLifecycleEvidence((current) => ({ ...current, [plugin.id]: evidence }));
      }
      const evidenceSuffix = evidence
        ? ` · ${evidence.stage ?? "lifecycle"} ${evidence.canarySuccessCount ?? 0}/${evidence.canaryFailureCount ?? 0}`
        : "";
      toast.success(locale === "zh" ? `已启用 ${plugin.name}${evidenceSuffix}` : `Enabled ${plugin.name}${evidenceSuffix}`);
      void queryClient.invalidateQueries({ queryKey: ["plugins"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "插件启用失败", "Plugin enable failed"));
    },
    onSettled: () => {
      setBusyPluginId(null);
    },
  });

  const disableMutation = useMutation({
    mutationFn: async (pluginId: string) => {
      setBusyPluginId(pluginId);
      return pluginsApi.disable(pluginId);
    },
    onSuccess: (plugin) => {
      toast.success(locale === "zh" ? `已停用 ${plugin.name}` : `Disabled ${plugin.name}`);
      void queryClient.invalidateQueries({ queryKey: ["plugins"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "插件停用失败", "Plugin disable failed"));
    },
    onSettled: () => {
      setBusyPluginId(null);
    },
  });

  const uninstallMutation = useMutation({
    mutationFn: async (pluginId: string) => {
      setBusyPluginId(pluginId);
      return pluginsApi.uninstall(pluginId);
    },
    onSuccess: () => {
      toast.success(localize(locale, "插件已卸载", "Plugin uninstalled"));
      setPendingUninstallId(null);
      void queryClient.invalidateQueries({ queryKey: ["plugins"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "插件卸载失败", "Plugin uninstall failed"));
    },
    onSettled: () => {
      setBusyPluginId(null);
    },
  });

  const canInstallLocal =
    installPluginId.trim().length > 0 &&
    installPath.trim().length > 0 &&
    pluginRuntimeMode === "full";

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-[color:var(--color-text-primary)]">
          {localize(locale, "插件", "Plugins")}
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">
          {localize(
            locale,
            "这里展示 Friday 真实运行中的插件库存、启停状态和本地安装入口。当前页只保留已经真实接线的本地能力。",
            "This page shows Friday's live plugin inventory, enablement state, and local install entry. Only locally wired plugin capabilities are shown here.",
          )}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <ShellCard>
          <p className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{localize(locale, "运行模式", "Runtime mode")}</p>
          <p className="mt-2 text-2xl font-semibold text-[color:var(--color-text-primary)]">{pluginRuntimeMode}</p>
          <p className="mt-2 text-xs leading-5 text-[color:var(--color-text-secondary)]">
            {pluginRuntimeMode === "full"
              ? localize(locale, "插件路由和库存已真实接线。", "Plugin routes and inventory are live.")
              : localize(locale, "当前机器处于 stub 模式，插件运行时并未真正打开。", "This machine is in stub mode; plugin runtime is not fully active.")}
          </p>
        </ShellCard>
        <ShellCard>
          <p className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{localize(locale, "已安装", "Installed")}</p>
          <p className="mt-2 text-2xl font-semibold text-[color:var(--color-text-primary)]">{String(installedCount)}</p>
          <p className="mt-2 text-xs leading-5 text-[color:var(--color-text-secondary)]">{localize(locale, "当前库存来自真实 /v1/plugins。", "Current inventory comes from live /v1/plugins.")}</p>
        </ShellCard>
        <ShellCard>
          <p className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{localize(locale, "已启用", "Active")}</p>
          <p className="mt-2 text-2xl font-semibold text-[color:var(--color-text-primary)]">{String(activeCount)}</p>
          <p className="mt-2 text-xs leading-5 text-[color:var(--color-text-secondary)]">{localize(locale, "包括 enabled 和 running 状态。", "Counts enabled and running plugins.")}</p>
        </ShellCard>
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <ShellCard eyebrow={localize(locale, "真实入口", "Real entry")} title={localize(locale, "本地安装插件", "Install a local plugin")}>
          <div className="grid gap-3 md:grid-cols-2">
            <FieldLabel
              label={localize(locale, "插件 ID", "Plugin ID")}
              hint={localize(locale, "必须与 friday.plugin.json 里的 id 完全一致。", "Must match the id inside friday.plugin.json.")}
            />
            <FieldLabel
              label={localize(locale, "安装目录", "Install directory")}
              hint={localize(locale, "传目录，不是文件；后端会读取其中的 friday.plugin.json。", "Pass a directory, not a file; the server reads friday.plugin.json from it.")}
            />
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <input
              className="agent-input"
              value={installPluginId}
              onChange={(event) => setInstallPluginId(event.target.value)}
              placeholder={localize(locale, "例如：friday.channel.discord", "Example: friday.channel.discord")}
            />
            <input
              className="agent-input"
              value={installPath}
              onChange={(event) => setInstallPath(event.target.value)}
              placeholder={localize(locale, "例如：/Users/name/plugins/my-plugin", "Example: /Users/name/plugins/my-plugin")}
            />
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm text-[color:var(--color-text-secondary)]">
            <input
              type="checkbox"
              checked={installTrustOnInstall}
              onChange={(event) => setInstallTrustOnInstall(event.target.checked)}
            />
            <span>{localize(locale, "如果插件走 trust-on-install，允许本次人工批准", "Allow manual approval when the plugin uses trust-on-install")}</span>
          </label>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <ActionButton disabled={!canInstallLocal || installLocalMutation.isPending} onClick={() => installLocalMutation.mutate()}>
              <PackagePlus className="mr-2 h-4 w-4" />
              {localize(locale, "安装本地插件", "Install local plugin")}
            </ActionButton>
            <p className="text-xs text-[color:var(--color-text-secondary)]">
              {localize(
                locale,
                "当前仍属于 operator-only 流程，但至少现在是 UI 里真实可走的一条路，不再只活在 API 和测试里。",
                "This is still an operator-only flow, but it is now a real UI path instead of living only in the API and tests.",
              )}
            </p>
          </div>
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "当前边界", "Current boundary")} title={localize(locale, "页面会如实告诉你什么还没做完", "This page explicitly shows what is still unfinished")}>
          <div className="space-y-3 text-sm leading-6 text-[color:var(--color-text-secondary)]">
            <div className="rounded-2xl bg-[color:var(--color-bg-subtle)] px-4 py-3">
              <p className="font-medium text-[color:var(--color-text-primary)]">{localize(locale, "已完成", "Done")}</p>
              <p>{localize(locale, "插件库存、启停、卸载和本地安装入口现在都有真实页面和真实 API 往返。", "Inventory, enable/disable, uninstall, and local install entry now have real UI and live API roundtrips.")}</p>
            </div>
            <div className="rounded-2xl bg-[color:var(--color-bg-subtle)] px-4 py-3">
              <p className="font-medium text-[color:var(--color-text-primary)]">{localize(locale, "未完成", "Not done yet")}</p>
              <p>{localize(locale, "还没有面向小白的插件安装向导。当前更像 operator console。", "There is still no beginner-friendly plugin install wizard. This is still closer to an operator console.")}</p>
            </div>
          </div>
        </ShellCard>
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <ShellCard eyebrow={localize(locale, "库存", "Inventory")} title={localize(locale, "已安装插件", "Installed plugins")} aside={<StatusPill tone="neutral">{String(installedCount)}</StatusPill>}>
          {pluginsQuery.isLoading ? (
            <div className="space-y-3">
              <SkeletonCard lines={3} />
              <SkeletonCard lines={3} />
            </div>
          ) : pluginsQuery.isError ? (
            <EmptyState
              title={localize(locale, "插件库存加载失败", "Failed to load plugin inventory")}
              description={localize(locale, "这说明 /v1/plugins 真实链路有问题，不是一个可忽略的空状态。", "This means the live /v1/plugins path is broken, not just empty.")}
            />
          ) : plugins.length === 0 ? (
            <EmptyState
              title={localize(locale, "当前没有已安装插件", "No installed plugins on this machine")}
              description={localize(locale, "真实 API 已经接线，但当前库存为空。空状态不再被误读成前端坏了。", "The live API is wired, but the current inventory is empty. This empty state is no longer misread as a broken frontend.")}
            />
          ) : (
            <div className="space-y-4">
              {plugins.map((plugin) => (
                <PluginInventoryCard
                  key={plugin.id}
                  plugin={plugin}
                  lifecycleEvidence={latestLifecycleEvidence[plugin.id]}
                  busyPluginId={busyPluginId}
                  onEnable={(pluginToEnable) => enableMutation.mutate(pluginToEnable)}
                  onDisable={(pluginId) => disableMutation.mutate(pluginId)}
                  onUninstall={(pluginId) => setPendingUninstallId(pluginId)}
                />
              ))}
            </div>
          )}
        </ShellCard>

      </div>

      <div className="mt-6 rounded-[28px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-5 py-4">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 text-[color:var(--color-accent)]" />
          <div className="text-sm leading-6 text-[color:var(--color-text-secondary)]">
            <p className="font-medium text-[color:var(--color-text-primary)]">{localize(locale, "发布真相说明", "Release truth note")}</p>
            <p className="mt-1">
              {localize(
                locale,
                "插件能力现在先只按两层看：1. 运行时是否真的开着；2. 当前机器上有没有真实库存和本地安装入口。未完成的外部分发入口已从当前用户面移除。",
                "Plugin capability is currently treated in two layers: 1. whether runtime is truly on, and 2. whether this machine has real inventory and a local install path. Unfinished external distribution surfaces have been removed from the current user UI.",
              )}
            </p>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={pendingUninstallId !== null}
        onCancel={() => setPendingUninstallId(null)}
        onConfirm={() => {
          if (pendingUninstallId) {
            uninstallMutation.mutate(pendingUninstallId);
          }
        }}
        title={localize(locale, "确认卸载插件", "Uninstall plugin")}
        description={localize(locale, "这会从当前机器移除插件库存记录。", "This removes the plugin from the current machine's inventory.")}
        confirmLabel={localize(locale, "卸载", "Uninstall")}
        cancelLabel={localize(locale, "取消", "Cancel")}
        tone="danger"
        loading={uninstallMutation.isPending}
      />
    </div>
  );
}
